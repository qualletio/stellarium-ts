import { isFreshExpiry, safeVerifyData } from "../crypto/utils.js";
import { Resource, ResourceFunction, ResourceFunctionCallParameter, ResourceFunctionParameter } from "requestscript";
import type { NodeDatabase } from "../db/database.js";
import type { ContractRepository, StoredContract } from "../contract/repository.js";
import type { StoredPeer } from "../peer/repository.js";
import { isInferenceManifest } from "./inference.js";
import { ACCOUNT_RESOURCE, isMoneyPath, RANDOM_RESOURCE } from "../money/account.js";

/** How long a node waits for a peer to describe a contract version a script pinned. */
const CONTRACT_VERSION_FETCH_TIMEOUT_MS = 10_000;

/** At most this many peers' contract versions are cached. Versions never change, so a cached one stays right. */
const MAX_CACHED_CONTRACT_VERSIONS = 1_000;

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

/** The one function a contract's resource has. It runs the version the resource names. */
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
        version: contract.version,
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
    /**
     * Set on a contract: the version this resource describes, its latest when announced. A contract must bind
     * another contract by its version, `path.Name@version`. Other resources have no versions.
     */
    version?: string;
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
    version: string | null;
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

/** A peer's announced contract version is kept only when it looks like one. */
function optionalVersion(value: unknown): string | null {
    return typeof value === 'string' && /^\d+(\.\d+)*$/.test(value) && value.length <= 64 ? value : null;
}

const resourceKey = (resource: { path: string, name: string }) => `${resource.path}.${resource.name}`;

/** `resource` bound by the version a script named, which calls to it then run. See `pinnedVersion`. */
function pin<T extends Resource>(resource: T, version: string): T {
    return { ...resource, version, metadata: { ...resource.metadata, pinnedVersion: version } };
}

/** What a peer's `GET /v1/contracts/:ref` answers about a contract version, after checking its shape. */
interface ContractVersionDeclaration {
    parameters: StellariumResourceFunctionParameter[];
    returnType: string;
}

function contractVersionDeclaration(body: unknown, version: string): ContractVersionDeclaration | undefined {
    const { version: answered, parameters, returnType } = (body ?? {}) as Record<string, unknown>;
    const validParameters = Array.isArray(parameters)
        && parameters.every(parameter => typeof parameter?.name === 'string' && typeof parameter?.type === 'string');
    if (answered !== version || !validParameters || typeof returnType !== 'string') {
        return undefined;
    }
    return { parameters: parameters.map(({ name, type }) => ({ name, type })), returnType };
}

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

    /** Contract versions learned from peers, by base URL and `path.Name@version`. */
    private readonly remoteVersions = new Map<string, ContractVersionDeclaration>();

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
        return (await repository.allLatestCallable()).map(contract => contractResource(contract, this.baseUrl, price(), organizationId()));
    }

    /** A contract on this node as a resource: `version`, or its latest. Event contracts are none. */
    private async contractResource(path: string, name: string, version?: string): Promise<StellariumResource | undefined> {
        const contract = version === undefined
            ? await this.contracts?.repository.latestCallable(path, name)
            : await this.contracts?.repository.callable(path, name, version);
        return contract && contractResource(contract, this.baseUrl, this.contracts!.price(), this.contracts!.organizationId());
    }

    /**
     * Asks the peer at `baseUrl` for a version of one of its contracts that it no longer announces, since it
     * announces only the latest. Undefined when the peer doesn't have it or can't be reached.
     */
    private async remoteContractVersion(baseUrl: string, path: string, name: string, version: string): Promise<ContractVersionDeclaration | undefined> {
        const key = `${baseUrl} ${path}.${name}@${version}`;
        const cached = this.remoteVersions.get(key);
        if (cached) {
            return cached;
        }
        let declaration: ContractVersionDeclaration | undefined;
        try {
            const response = await fetch(`${baseUrl}/v1/contracts/${encodeURIComponent(`${path}.${name}@${version}`)}`, {
                signal: AbortSignal.timeout(CONTRACT_VERSION_FETCH_TIMEOUT_MS),
            });
            declaration = response.ok ? contractVersionDeclaration(await response.json(), version) : undefined;
        } catch {
            return undefined;
        }
        if (declaration) {
            if (this.remoteVersions.size >= MAX_CACHED_CONTRACT_VERSIONS) {
                this.remoteVersions.delete(this.remoteVersions.keys().next().value!);
            }
            this.remoteVersions.set(key, declaration);
        }
        return declaration;
    }

    /**
     * Saves a resource learned from the starting peer, if it isn't known yet. Resources hosted
     * by this node and resources already known are left alone, so startup can run on every boot.
     */
    async learn(resource: StellariumResource): Promise<void> {
        if (isMoneyPath(resource.path) || await this.isInternal(resource) || resource.baseUrl === this.baseUrl) {
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
                // sh.stellarium.money is built into every node, so no peer may publish under it.
                if (resource.baseUrl !== peer.baseUrl || internal[index] || isMoneyPath(String(resource.path))) {
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
                    'UPDATE resource SET base_url = ?, version = ?, website = ?, description = ?, peer_id = ?, updated_at = ? WHERE id = ?',
                    [resource.baseUrl, optionalVersion(resource.version), optionalWebsite(resource.website), optionalText(resource.description), peer.id, new Date().toISOString(), existing.id]
                );
                await this.insertFunctions(tx, existing.id, resource.functions);
            }
        });

        return { ok: true, rejected };
    }

    private async insert(tx: NodeDatabase, resource: StellariumResource, peerId: number | null): Promise<void> {
        const createdAt = new Date().toISOString();
        const row = await tx.get<{ id: number }>(
            'INSERT INTO resource (path, name, base_url, version, website, description, peer_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id',
            [resource.path, resource.name, resource.baseUrl, optionalVersion(resource.version), optionalWebsite(resource.website), optionalText(resource.description), peerId, createdAt, createdAt]
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

    /**
     * A resource this node hosts: a registered one, or a contract at `version` or its latest. A registered
     * resource has no versions, so it is never found by one.
     */
    async getInternalResource(path: string, name: string, version?: string): Promise<StellariumResource | undefined> {
        const registered = this.resources.find(r => r.path === path && r.name === name);
        if (registered) {
            return version === undefined ? registered : undefined;
        }
        return this.contractResource(path, name, version);
    }

    /**
     * The resource a script binds as `key`, `path.Name`. With `version`, the script pinned that version of a
     * contract, which calls to the resource then run (see `pinnedVersion`). A resource without versions is
     * returned without one, and the interpreter refuses the binding.
     */
    async getResource(key: string, version?: string): Promise<Resource | undefined> {
        if (key === resourceKey(ACCOUNT_RESOURCE)) {
            return version === undefined ? ACCOUNT_RESOURCE : undefined;
        }
        if (key === resourceKey(RANDOM_RESOURCE)) {
            return version === undefined ? RANDOM_RESOURCE : undefined;
        }
        const resource = this.resources.find(r => resourceKey(r) === key);
        if (resource) {
            return resource;
        }

        // Split the key with format path.path.path.*.Name
        const pathName = key.split('.');
        const name = pathName.pop()!;
        const path = pathName.join('.');

        // Built into stellarium-ts: anything else under the path, even if learned before the rule, is an impostor.
        if (isMoneyPath(path)) {
            return undefined;
        }

        const contract = await this.contractResource(path, name, version);
        if (contract) {
            return version === undefined ? contract : pin(contract, version);
        }
        // A contract this node hosts is never also a learned resource, so a version it doesn't have is unknown.
        if (version !== undefined && await this.contracts?.repository.owner(path, name) !== undefined) {
            return undefined;
        }

        const result = await this.db.get<ResourceRow>(
            'SELECT * FROM resource WHERE path = ? AND name = ?',
            [path, name]
        );

        if (!result) {
            return undefined;
        }

        const learned: Resource = {
            path: result.path,
            name: result.name,
            ...(result.version === null ? {} : { version: result.version }),
            // The CombinationResourceInvoker forwards calls on these functions to `metadata.baseUrl`.
            functions: await this.getResourceFunctions(result.id),
            metadata: {
                baseUrl: result.base_url,
            }
        };
        if (version === undefined || result.version === null) {
            return learned;
        }
        if (version === result.version) {
            return pin(learned, version);
        }
        // An older version: its node runs it, and says what it takes. Its price is the node's, as for the latest.
        const declaration = await this.remoteContractVersion(result.base_url, path, name, version);
        if (!declaration) {
            return undefined;
        }
        return pin({
            ...learned,
            functions: learned.functions.map(fn => fn.name === CONTRACT_FUNCTION && isContractFunction(fn as StellariumResourceFunction)
                ? { ...fn, parameters: declaration.parameters, returnType: declaration.returnType }
                : fn),
        }, version);
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
            version: r.version ?? undefined,
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
