import { isFreshExpiry, safeVerifyData } from "../crypto/utils.js";
import { Resource, ResourceFunction, ResourceFunctionCallParameter, ResourceFunctionParameter } from "requestscript";
import type { NodeDatabase } from "../db/database.js";
import type { ContractRepository, StoredContract } from "../contract/repository.js";
import type { StoredPeer } from "../peer/repository.js";
import { isInferenceManifest } from "./inference.js";

/**
 * A flat price per call. `recipientOrganizationId` is filled in by the hosting node when it advertises
 * the function, from the organization it is enrolled in; resource authors leave it out.
 */
export interface StellariumFixedPaymentManifest {
    id?: number;
    costMicroUsd: number;
    recipientOrganizationId?: string;
}

/** Per-token pricing for an inference function. Either rate may be 0. */
export interface StellariumInferencePaymentManifest {
    id?: number;
    inputCostMicroUsdPerMillionTokens: number;
    outputCostMicroUsdPerMillionTokens: number;
    recipientOrganizationId?: string;
}

/**
 * A contract's price: the hosting node's listed price per million tokens the contract executes. A call is
 * paid with a contract voucher, which also pays for the paid calls the contract makes.
 */
export interface StellariumContractPaymentManifest {
    id?: number;
    priceMicroUsdPerMillionTokens: number;
    recipientOrganizationId?: string;
}

export type StellariumResourceFunctionPaymentManifest = StellariumFixedPaymentManifest | StellariumInferencePaymentManifest | StellariumContractPaymentManifest;

/**
 * Fixed functions return one value. Inference functions run AI inference and are priced per token.
 * Contract functions run a contract deployed to the node, and are priced per token it executes.
 */
export type StellariumResourceFunctionKind = 'fixed' | 'inference' | 'contract';

/** The one function a contract's resource has. It runs the contract's latest version. */
export const CONTRACT_FUNCTION = 'run';

export function isContractManifest(manifest: StellariumResourceFunctionPaymentManifest | undefined): manifest is StellariumContractPaymentManifest {
    return typeof manifest === 'object' && manifest !== null && 'priceMicroUsdPerMillionTokens' in manifest;
}

export function isContractFunction(fn: Pick<StellariumResourceFunction, 'kind'>): boolean {
    return fn.kind === 'contract';
}

/** The resource a contract is served as. Its function always has a manifest, so every call needs a voucher. */
export function contractResource(contract: StoredContract, baseUrl: string, priceMicroUsdPerMillionTokens: number, recipientOrganizationId?: string): StellariumResource {
    return {
        id: 0,
        baseUrl,
        metadata: {},
        path: contract.path,
        name: contract.name,
        description: contract.description ?? undefined,
        functions: [{
            name: CONTRACT_FUNCTION,
            kind: 'contract',
            parameters: contract.parameters,
            returnType: contract.returnType,
            exec: async () => {
                throw new Error('Contracts are run by the resource invoker');
            },
            paymentManifest: { priceMicroUsdPerMillionTokens, recipientOrganizationId },
        }],
    };
}

/** Where a `ResourceRepository` finds this node's contracts, and what it charges for them. */
export interface ContractSource {
    repository: ContractRepository;
    /** This node's listed price per million tokens. */
    price: () => number;
    /** This node's organization, which is paid for contract calls. It may be learned after the node starts. */
    organizationId: () => string | undefined;
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
    /** Absent means 'fixed'. An inference function takes a `maxTokens: int32` parameter and its `exec` returns `{ value, usage }`. */
    kind?: StellariumResourceFunctionKind;
    /**
     * Input tokens a call will use, for pricing its voucher before inference runs. Required on paid inference
     * functions. It runs only on the hosting node and, like `exec`, is never announced.
     */
    estimateInputTokens?: (args: ResourceFunctionCallParameter[]) => Promise<number>;
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
    /**
     * `organizationId` is the operator organization this node is enrolled in, which is paid for its functions.
     * The contracts deployed to the node are its resources too, after the registered ones.
     */
    constructor(
        private readonly db: NodeDatabase,
        private resources: StellariumResource[] = [],
        private readonly baseUrl: string = '',
        private readonly organizationId?: string,
        private readonly contracts?: ContractSource,
    ) {}

    /** A resource registered on this node. */
    isRegistered(resource: { path: string, name: string }): boolean {
        return this.resources.some(r => r.path === resource.path && r.name === resource.name);
    }

    /** A resource this node hosts: registered, or a contract deployed to it. */
    private async isInternal(resource: { path: string, name: string }): Promise<boolean> {
        return this.isRegistered(resource) || await this.contracts?.repository.owner(resource.path, resource.name) !== undefined;
    }

    /** A resource learned from a peer. */
    async isLearned(path: string, name: string): Promise<boolean> {
        return await this.db.get('SELECT id FROM resource WHERE path = ? AND name = ?', [path, name]) !== undefined;
    }

    private async contractResources(): Promise<StellariumResource[]> {
        if (!this.contracts) {
            return [];
        }
        const { repository, price, organizationId } = this.contracts;
        return (await repository.allLatest()).map(contract => contractResource(contract, this.baseUrl, price(), organizationId()));
    }

    private async contractResource(path: string, name: string): Promise<StellariumResource | undefined> {
        const contract = await this.contracts?.repository.latest(path, name);
        return contract && contractResource(contract, this.baseUrl, this.contracts!.price(), this.contracts!.organizationId());
    }

    /**
     * Saves a resource learned from the starting peer, if it isn't known yet. Resources hosted
     * by this node and resources already known are left alone, so startup can run on every boot.
     */
    async learn(resource: StellariumResource): Promise<void> {
        if (await this.isInternal(resource) || resource.baseUrl === this.baseUrl) {
            return;
        }
        await this.db.transaction(async (tx) => {
            const existing = await tx.get('SELECT id FROM resource WHERE path = ? AND name = ?', [resource.path, resource.name]);
            if (!existing) {
                await this.insert(tx, resource, null);
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
        // Checked before the transaction, whose work may use only its own connection.
        const internal = await Promise.all(resources.map(resource => this.isInternal(resource)));
        await this.db.transaction(async (tx) => {
            for (const [index, resource] of resources.entries()) {
                if (resource.baseUrl !== peer.baseUrl || internal[index]) {
                    rejected.push(resourceKey(resource));
                    continue;
                }

                const existing = await tx.get<ResourceRow>('SELECT * FROM resource WHERE path = ? AND name = ?', [resource.path, resource.name]);
                if (!existing) {
                    await this.insert(tx, resource, peer.id);
                    continue;
                }

                // Unowned rows came from the starting peer; the peer they point at may claim them.
                const ownedByPeer = existing.peer_id === null ? existing.base_url === peer.baseUrl : existing.peer_id === peer.id;
                if (!ownedByPeer) {
                    rejected.push(resourceKey(resource));
                    continue;
                }

                await this.deleteFunctions(tx, existing.id);
                await tx.run(
                    'UPDATE resource SET base_url = ?, website = ?, description = ?, peer_id = ?, updated_at = ? WHERE id = ?',
                    [resource.baseUrl, optionalWebsite(resource.website), optionalText(resource.description), peer.id, new Date().toISOString(), existing.id]
                );
                await this.insertFunctions(tx, existing.id, resource.functions);
            }
        });

        return { ok: true, rejected };
    }

    private async insert(tx: NodeDatabase, resource: StellariumResource, peerId: number | null): Promise<void> {
        const createdAt = new Date().toISOString();
        const row = await tx.get<{ id: number }>(
            'INSERT INTO resource (path, name, base_url, website, description, peer_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING id',
            [resource.path, resource.name, resource.baseUrl, optionalWebsite(resource.website), optionalText(resource.description), peerId, createdAt, createdAt]
        );

        if (!row) {
            throw new Error('Failed to create resource');
        }

        await this.insertFunctions(tx, row.id, resource.functions);
    }

    private async insertFunctions(tx: NodeDatabase, resourceId: number, functions: StellariumResourceFunction[]): Promise<void> {
        const createdAt = new Date().toISOString();
        for (const fn of functions) {
            const functionRow = await tx.get<{ id: number }>(
                'INSERT INTO resource_function (resource_id, name, return_type, description, restricted, kind, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING id',
                [resourceId, fn.name, fn.returnType, optionalText(fn.description), fn.restricted === true ? 1 : 0, fn.kind === 'inference' || fn.kind === 'contract' ? fn.kind : 'fixed', createdAt, createdAt]
            );

            const functionId = functionRow!.id;

            for (const parameter of fn.parameters) {
                await tx.run(
                    'INSERT INTO resource_function_parameter (resource_function_id, name, parameter_type, description, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
                    [functionId, parameter.name, parameter.type, optionalText(parameter.description), createdAt, createdAt]
                );
            }

            const manifest = fn.paymentManifest;
            if (manifest) {
                const inference = isInferenceManifest(manifest) ? manifest : undefined;
                const contract = isContractManifest(manifest) ? manifest : undefined;
                await tx.run(
                    'INSERT INTO resource_function_payment_manifest (resource_function_id, cost_micro_usd, input_cost_micro_usd_per_million_tokens, output_cost_micro_usd_per_million_tokens, price_micro_usd_per_million_tokens, recipient_organization_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
                    [
                        functionId,
                        inference || contract ? null : (manifest as StellariumFixedPaymentManifest).costMicroUsd,
                        inference ? inference.inputCostMicroUsdPerMillionTokens : null,
                        inference ? inference.outputCostMicroUsdPerMillionTokens : null,
                        contract ? contract.priceMicroUsdPerMillionTokens : null,
                        manifest.recipientOrganizationId ?? null,
                        createdAt,
                        createdAt,
                    ]
                );
            }
        }
    }

    private async deleteFunctions(tx: NodeDatabase, resourceId: number): Promise<void> {
        const functionIds = 'SELECT id FROM resource_function WHERE resource_id = ?';
        await tx.run(`DELETE FROM resource_function_payment_manifest WHERE resource_function_id IN (${functionIds})`, [resourceId]);
        await tx.run(`DELETE FROM resource_function_parameter WHERE resource_function_id IN (${functionIds})`, [resourceId]);
        await tx.run('DELETE FROM resource_function WHERE resource_id = ?', [resourceId]);
    }

    async getInternalResource(path: string, name: string): Promise<StellariumResource | undefined> {
        return this.resources.find(r => r.path === path && r.name === name) ?? await this.contractResource(path, name);
    }

    async getResource(key: string): Promise<Resource | undefined> {
        const resource = this.resources.find(r => resourceKey(r) === key);
        if (resource) {
            return resource;
        }

        // Split the key with format path.path.path.*.Name
        const pathName = key.split('.');
        const name = pathName.pop()!;
        const path = pathName.join('.');

        const contract = await this.contractResource(path, name);
        if (contract) {
            return contract;
        }

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

    /**
     * This node's resources, with its base URL and its organization as the recipient of every paid function:
     * the registered ones, then its contracts by path and name.
     */
    async getInternalResources(): Promise<StellariumResource[]> {
        const registered = this.resources.map(r => ({
            ...r,
            baseUrl: this.baseUrl,
            functions: r.functions.map((fn: StellariumResourceFunction) => fn.paymentManifest
                ? { ...fn, paymentManifest: { ...fn.paymentManifest, recipientOrganizationId: this.organizationId } }
                : fn),
        }));
        return [...registered, ...await this.contractResources()];
    }

    /** Learned resources in insertion order. A negative `limit` means no limit. */
    async getExternalResources(offset = 0, limit = -1): Promise<StellariumResource[]> {
        const results = await this.db.all<ResourceRow[]>(
            'SELECT * FROM resource ORDER BY id LIMIT ? OFFSET ?',
            // Postgres refuses a negative limit, and SQLite needs one before an offset.
            [limit < 0 ? Number.MAX_SAFE_INTEGER : limit, offset],
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
            kind: fn.kind === 'inference' || fn.kind === 'contract' ? fn.kind : undefined,
        };
    }

    async getResourceFunctions(resourceId: number): Promise<StellariumResourceFunction[]> {
        const rows = await this.db.all('SELECT * FROM resource_function WHERE resource_id = ? ORDER BY name', [resourceId]);
        return Promise.all(rows.map(async (f) => ({
            id: f.id as number,
            name: f.name as string,
            returnType: f.return_type as string,
            description: (f.description as string | null) ?? undefined,
            parameters: await this.getResourceParameters(f.id),
            exec: async () => undefined,
            paymentManifest: await this.getResourceFunctionPaymentManifest(f.id),
            restricted: f.restricted === 1 || undefined,
            kind: f.kind === 'inference' || f.kind === 'contract' ? f.kind as StellariumResourceFunctionKind : undefined,
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
        if (result.price_micro_usd_per_million_tokens !== null) {
            return {
                id: result.id,
                priceMicroUsdPerMillionTokens: result.price_micro_usd_per_million_tokens as number,
                recipientOrganizationId: result.recipient_organization_id ?? undefined,
            };
        }
        if (result.cost_micro_usd === null) {
            return {
                id: result.id,
                inputCostMicroUsdPerMillionTokens: result.input_cost_micro_usd_per_million_tokens as number,
                outputCostMicroUsdPerMillionTokens: result.output_cost_micro_usd_per_million_tokens as number,
                recipientOrganizationId: result.recipient_organization_id ?? undefined,
            };
        }
        return {
            id: result.id,
            costMicroUsd: result.cost_micro_usd as number,
            recipientOrganizationId: result.recipient_organization_id ?? undefined,
        };
    }

    /**
     * One page of every resource this node knows: the ones it hosts first, then learned ones.
     * Both are in a fixed order, so offsets stay stable as resources are learned.
     */
    async getResources(offset: number, limit: number): Promise<StellariumResource[]> {
        const all = await this.getInternalResources();
        const internal = all.slice(offset, offset + limit);
        const remaining = limit - internal.length;
        if (remaining <= 0) {
            return internal;
        }
        const externalOffset = Math.max(0, offset - all.length);
        return [...internal, ...await this.getExternalResources(externalOffset, remaining)];
    }
}
