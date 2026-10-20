import { isFreshExpiry, safeVerifyData } from "../crypto/utils.js";
import { Resource, ResourceFunction, ResourceFunctionParameter } from "requestscript";
import { Database } from "sqlite";
import type { StoredPeer } from "../peer/repository.js";

export interface StellariumResourceFunctionPaymentManifest {
    id?: number;
    costMicroUsdc: number;
    recipientAddress: string;
}

export interface StellariumResourceFunctionParameter extends ResourceFunctionParameter {
    description?: string;
}

export interface StellariumResourceFunction extends ResourceFunction {
    id?: number;
    description?: string;
    parameters: StellariumResourceFunctionParameter[];
    paymentManifest?: StellariumResourceFunctionPaymentManifest;
    /** Callers need a grant from the hosting node. Announced to peers so callers can tell. */
    restricted?: boolean;
}

export interface StellariumResource extends Resource {
    id: number;
    baseUrl: string;
    /** A URL where callers can learn more about the resource. */
    website?: string;
    description?: string;
    functions: StellariumResourceFunction[];
}

/**
 * The object a node signs to broadcast its resources. Key order is part of the signed bytes.
 * Functions' `exec` implementations are dropped by JSON serialization on both ends.
 */
export function resourceAnnouncementPayload(resources: StellariumResource[], expiry: string) {
    return { resources, expiry };
}

export type SaveAllResult = { ok: true, rejected: string[] } | { ok: false };

interface ResourceRow {
    id: number;
    peer_id: number | null;
    path: string;
    name: string;
    base_url: string;
    website: string | null;
    description: string | null;
}

/** Peers' resources aren't validated on receipt, so a description that isn't a string is stored as absent. */
function optionalText(value: unknown): string | null {
    return typeof value === 'string' ? value : null;
}

/** Only http(s) URLs are kept, since clients may render a resource's website as a link. */
function optionalWebsite(value: unknown): string | null {
    if (typeof value !== 'string' || !URL.canParse(value)) {
        return null;
    }
    const { protocol } = new URL(value);
    return protocol === 'http:' || protocol === 'https:' ? value : null;
}

const resourceKey = (resource: { path: string, name: string }) => `${resource.path}.${resource.name}`;

export class ResourceRepository {
    // The connection is shared, so transactions are serialized to keep them from nesting.
    private writes: Promise<unknown> = Promise.resolve();

    constructor(private readonly db: Database, private resources: StellariumResource[] = [], private readonly baseUrl: string = '') {}

    private serialize<T>(work: () => Promise<T>): Promise<T> {
        const run = this.writes.then(work, work);
        this.writes = run.catch(() => undefined);
        return run;
    }

    private transaction<T>(work: () => Promise<T>): Promise<T> {
        return this.serialize(async () => {
            await this.db.exec('BEGIN IMMEDIATE');
            try {
                const result = await work();
                await this.db.exec('COMMIT');
                return result;
            } catch (error) {
                await this.db.exec('ROLLBACK');
                throw error;
            }
        });
    }

    private isInternal(resource: { path: string, name: string }): boolean {
        return this.resources.some(r => r.path === resource.path && r.name === resource.name);
    }

    /**
     * Saves a resource learned from the starting peer, if it isn't known yet. Resources hosted
     * by this node and resources already known are left alone, so startup can run on every boot.
     */
    async learn(resource: StellariumResource): Promise<void> {
        if (this.isInternal(resource) || resource.baseUrl === this.baseUrl) {
            return;
        }
        await this.transaction(async () => {
            const existing = await this.db.get('SELECT id FROM resource WHERE path = ? AND name = ?', [resource.path, resource.name]);
            if (!existing) {
                await this.insert(resource, null);
            }
        });
    }

    /**
     * Saves the resources a peer broadcast, after checking the peer signed them.
     * A peer may only publish resources served from its own base URL, and may not replace a
     * resource owned by another peer or hosted by this node. Those are returned in `rejected`.
     * Accepted resources are replaced as a whole, so added or removed functions,
     * parameters and payment manifests all take effect.
     */
    async saveAll(resources: StellariumResource[], peer: StoredPeer, signature: string, expiry: string): Promise<SaveAllResult> {
        if (!Array.isArray(resources) || !isFreshExpiry(expiry) || !safeVerifyData(resourceAnnouncementPayload(resources, expiry), peer.publicKey, signature)) {
            return { ok: false };
        }

        const rejected: string[] = [];
        await this.transaction(async () => {
            for (const resource of resources) {
                if (resource.baseUrl !== peer.baseUrl || this.isInternal(resource)) {
                    rejected.push(resourceKey(resource));
                    continue;
                }

                const existing = await this.db.get<ResourceRow>('SELECT * FROM resource WHERE path = ? AND name = ?', [resource.path, resource.name]);
                if (!existing) {
                    await this.insert(resource, peer.id);
                    continue;
                }

                // Unowned rows came from the starting peer; the peer they point at may claim them.
                const ownedByPeer = existing.peer_id === null ? existing.base_url === peer.baseUrl : existing.peer_id === peer.id;
                if (!ownedByPeer) {
                    rejected.push(resourceKey(resource));
                    continue;
                }

                await this.deleteFunctions(existing.id);
                await this.db.run(
                    'UPDATE resource SET base_url = ?, website = ?, description = ?, peer_id = ?, updated_at = ? WHERE id = ?',
                    [resource.baseUrl, optionalWebsite(resource.website), optionalText(resource.description), peer.id, new Date().toISOString(), existing.id]
                );
                await this.insertFunctions(existing.id, resource.functions);
            }
        });

        return { ok: true, rejected };
    }

    private async insert(resource: StellariumResource, peerId: number | null): Promise<void> {
        const createdAt = new Date().toISOString();
        const result = await this.db.run(
            'INSERT INTO resource (path, name, base_url, website, description, peer_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
            [resource.path, resource.name, resource.baseUrl, optionalWebsite(resource.website), optionalText(resource.description), peerId, createdAt, createdAt]
        );

        if (!result.changes || result.lastID === undefined) {
            throw new Error('Failed to create resource');
        }

        await this.insertFunctions(result.lastID, resource.functions);
    }

    private async insertFunctions(resourceId: number, functions: StellariumResourceFunction[]): Promise<void> {
        const createdAt = new Date().toISOString();
        for (const fn of functions) {
            const functionResult = await this.db.run(
                'INSERT INTO resource_function (resource_id, name, return_type, description, restricted, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
                [resourceId, fn.name, fn.returnType, optionalText(fn.description), fn.restricted === true ? 1 : 0, createdAt, createdAt]
            );

            const functionId = functionResult.lastID;

            for (const parameter of fn.parameters) {
                await this.db.run(
                    'INSERT INTO resource_function_parameter (resource_function_id, name, parameter_type, description, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
                    [functionId, parameter.name, parameter.type, optionalText(parameter.description), createdAt, createdAt]
                );
            }

            if (fn.paymentManifest) {
                await this.db.run(
                    'INSERT INTO resource_function_payment_manifest (resource_function_id, cost_micro_usdc, recipient_address, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
                    [functionId, fn.paymentManifest.costMicroUsdc, fn.paymentManifest.recipientAddress, createdAt, createdAt]
                );
            }
        }
    }

    private async deleteFunctions(resourceId: number): Promise<void> {
        const functionIds = 'SELECT id FROM resource_function WHERE resource_id = ?';
        await this.db.run(`DELETE FROM resource_function_payment_manifest WHERE resource_function_id IN (${functionIds})`, [resourceId]);
        await this.db.run(`DELETE FROM resource_function_parameter WHERE resource_function_id IN (${functionIds})`, [resourceId]);
        await this.db.run('DELETE FROM resource_function WHERE resource_id = ?', [resourceId]);
    }

    async getInternalResource(path: string, name: string): Promise<StellariumResource | undefined> {
        return this.resources.find(r => r.path === path && r.name === name);
    }

    async getResource(key: string): Promise<Resource | undefined> {
        const resource = this.resources.find(r => resourceKey(r) === key);
        if (resource) {
            return resource;
        }

        // Split the key with format path.path.path.*.Name
        const pathName = key.split('.');
        const name = pathName.pop();
        const path = pathName.join('.');

        const result = await this.db.get<ResourceRow>(
            'SELECT * FROM resource WHERE path = ? AND name = ?',
            [path, name]
        );

        if (!result) {
            return undefined;
        }

        return {
            path: result.path,
            name: result.name,
            // The CombinationResourceInvoker forwards calls on these functions to `metadata.baseUrl`.
            functions: await this.getResourceFunctions(result.id),
            metadata: {
                baseUrl: result.base_url,
            }
        }
    }

    async getInternalResources(): Promise<StellariumResource[]> {
        return this.resources.map(r => ({ ...r, baseUrl: this.baseUrl }));
    }

    /** Learned resources in insertion order. A negative `limit` means no limit. */
    async getExternalResources(offset = 0, limit = -1): Promise<StellariumResource[]> {
        const results = await this.db.all<ResourceRow[]>(
            'SELECT * FROM resource ORDER BY id LIMIT ? OFFSET ?',
            [limit, offset],
        );

        return Promise.all(results.map(async (r) => ({
            id: r.id,
            path: r.path,
            name: r.name,
            baseUrl: r.base_url,
            website: r.website ?? undefined,
            description: r.description ?? undefined,
            metadata: { baseUrl: r.base_url },
            functions: await this.getResourceFunctions(r.id),
        })));
    }

    async getResourceFunction(resourcePath: string, resourceName: string, functionName: string): Promise<StellariumResourceFunction | undefined> {
        const resource = await this.db.get('SELECT * FROM resource WHERE path = ? AND name = ?', [resourcePath, resourceName]);
        if (!resource) {
            return undefined;
        }

        const fn = await this.db.get('SELECT * FROM resource_function WHERE resource_id = ? AND name = ?', [resource.id, functionName]);
        if (!fn) {
            return undefined;
        }

        return {
            id: fn.id,
            name: fn.name,
            returnType: fn.return_type,
            description: fn.description ?? undefined,
            parameters: await this.getResourceParameters(fn.id),
            exec: async () => undefined,
            paymentManifest: await this.getResourceFunctionPaymentManifest(fn.id),
            restricted: fn.restricted === 1 || undefined,
        };
    }

    async getResourceFunctions(resourceId: number): Promise<StellariumResourceFunction[]> {
        const rows = await this.db.all('SELECT * FROM resource_function WHERE resource_id = ?', [resourceId]);
        return Promise.all(rows.map(async (f) => ({
            id: f.id as number,
            name: f.name as string,
            returnType: f.return_type as string,
            description: (f.description as string | null) ?? undefined,
            parameters: await this.getResourceParameters(f.id),
            exec: async () => undefined,
            paymentManifest: await this.getResourceFunctionPaymentManifest(f.id),
            restricted: f.restricted === 1 || undefined,
        })));
    }

    async getResourceParameters(resourceFunctionId: number): Promise<StellariumResourceFunctionParameter[]> {
        return (await this.db.all('SELECT * FROM resource_function_parameter WHERE resource_function_id = ? ORDER BY id', [resourceFunctionId])).map(p => ({
            name: p.name,
            type: p.parameter_type,
            description: p.description ?? undefined,
        }));
    }

    async getResourceFunctionPaymentManifest(resourceFunctionId: number): Promise<StellariumResourceFunctionPaymentManifest | undefined> {
        const result = await this.db.get('SELECT * FROM resource_function_payment_manifest WHERE resource_function_id = ?', [resourceFunctionId]);
        if (!result) {
            return undefined;
        }
        return {
            id: result.id,
            costMicroUsdc: result.cost_micro_usdc as number,
            recipientAddress: result.recipient_address as string,
        };
    }

    /**
     * One page of every resource this node knows: the ones it hosts first, then learned ones.
     * Both are in a fixed order, so offsets stay stable as resources are learned.
     */
    async getResources(offset: number, limit: number): Promise<StellariumResource[]> {
        const internal = (await this.getInternalResources()).slice(offset, offset + limit);
        const remaining = limit - internal.length;
        if (remaining <= 0) {
            return internal;
        }
        const externalOffset = Math.max(0, offset - this.resources.length);
        return [...internal, ...await this.getExternalResources(externalOffset, remaining)];
    }
}
