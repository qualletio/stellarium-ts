import 'dotenv/config';
import { FastifyInstance } from 'fastify';
import { DEFAULT_DATABASE_PATH, isPostgresUrl, openDatabase } from './db/db.js';
import { assertSchemaName } from './db/postgres.js';
import type { Capability, Grant } from './grant/grant.js';
import type { GrantKey } from './grant/repository.js';
import type { ApproveGrant, GrantOptions } from './grant/service.js';
import { DEFAULT_MAX_CONTRACT_SOURCE_BYTES } from './contract/service.js';
import { validateInferenceFunction } from './resource/inference.js';
import { StellariumResource } from './resource/repository.js';
import routes, { RateLimitConfig } from './routes.js';
import { createService, type NodeConfig, type Service } from './service.js';
import { announceResources, StartupService } from './startup.js';
import { OperatorClient } from './client/operatorClient.js';

export const DEFAULT_COST_LIMIT_MICRO_USD = 10_000;
export const DEFAULT_GRANT_REFRESH_INTERVAL_MS = 1000 * 60 * 5;
/** How often a node with an operator asks it again for its organization and price, which may change on the dashboard. */
export const DEFAULT_SESSION_REFRESH_INTERVAL_MS = 1000 * 60 * 5;

export interface StellariumNodeOptions {
    port?: number;
    host?: string;
    startingPeer?: string;
    /** Per-IP rate limit for `POST /v1/run/resource`. Defaults to 100 requests per minute. */
    rateLimit?: RateLimitConfig;
    /** URL peers use to reach this node. Defaults to `BASE_URL`. */
    baseUrl?: string;
    /** Defaults to `SIGNING_PUBLIC_KEY`. */
    publicKey?: string;
    /** Defaults to `SIGNING_PRIVATE_KEY`. */
    privateKey?: string;
    /** Bearer token for `POST /v1/run` and the admin routes. Defaults to `API_KEY`. */
    apiKey?: string;
    /** Defaults to `OPERATOR_URL`. */
    operatorUrl?: string;
    /**
     * One-time token from the dashboard that enrolls this node in an organization. Defaults to
     * `ENROLLMENT_TOKEN`. Only needed on a node's first start; an enrolled node ignores it.
     */
    enrollmentToken?: string;
    /** Most this node pays for one remote call. Defaults to `COST_LIMIT_MICRO_USD`, then 10,000 ($0.01). */
    costLimitMicroUsd?: number;
    /**
     * Most this node signs for in one remote inference call (the voucher's `maxAmount`).
     * Defaults to `INFERENCE_COST_LIMIT_MICRO_USD`, then to the resolved `costLimitMicroUsd`.
     */
    inferenceCostLimitMicroUsd?: number;
    /**
     * Most one call to a contract on another node may cost: what its voucher lets the provider hold for the
     * contract's tokens and its paid calls. Defaults to `CONTRACT_COST_LIMIT_MICRO_USD`, then to the resolved
     * `costLimitMicroUsd`.
     */
    contractCostLimitMicroUsd?: number;
    /** What another organization pays to deploy a contract to this node. Defaults to `CONTRACT_DEPLOY_FEE_MICRO_USD`, then 0. */
    contractDeployFeeMicroUsd?: number;
    /** Largest contract source this node accepts, in bytes. Defaults to `MAX_CONTRACT_SOURCE_BYTES`, then 64 KiB. */
    maxContractSourceBytes?: number;
    /** SQLite file. Defaults to `DATABASE_PATH`, then `./requestscript.db`; use ':memory:' for tests. */
    databasePath?: string;
    /**
     * A `postgres://` or `postgresql://` URL. Defaults to `DATABASE_URL`. When set, the node keeps its data in
     * Postgres instead of a SQLite file, so `databasePath` must not be set too.
     */
    databaseUrl?: string;
    /**
     * Postgres schema for the node's tables, created if missing, so several nodes can share a database.
     * Defaults to `DATABASE_SCHEMA`, then to the connection's search path.
     */
    databaseSchema?: string;
    /**
     * Grant chains addressed to this node, stored at start. Each is root first. A stored renewal
     * of the same grant is kept, and an expired chain is skipped with a warning.
     */
    grants?: Grant[][];
    /** How often held grants past half their lifetime are renewed. Defaults to 5 minutes. */
    grantRefreshIntervalMs?: number;
    /** How often to ask the operator again for this node's organization and price. Defaults to five minutes. */
    sessionRefreshIntervalMs?: number;
    /**
     * Decides callers' requests for grants on this node's resources (`POST /v1/grants/request`).
     * Without it, callers can only get grants from `issueGrant`.
     */
    approveGrant?: ApproveGrant;
}

function required(name: string, value: string | undefined): string {
    if (!value) {
        throw new Error(`${name} is required: pass it to StellariumNode.start or set it in the environment`);
    }
    return value;
}

function hostsPaidFunctions(resources: StellariumResource[]): boolean {
    return resources.some(resource => resource.functions.some(fn => fn.paymentManifest));
}

export function resolveConfig(options: StellariumNodeOptions, resources: StellariumResource[] = []): NodeConfig {
    const costLimit = options.costLimitMicroUsd ?? (process.env.COST_LIMIT_MICRO_USD ? Number(process.env.COST_LIMIT_MICRO_USD) : DEFAULT_COST_LIMIT_MICRO_USD);
    if (!Number.isSafeInteger(costLimit) || costLimit < 0) {
        throw new Error('costLimitMicroUsd must be a nonnegative integer');
    }
    const inferenceCostLimit = options.inferenceCostLimitMicroUsd ?? (process.env.INFERENCE_COST_LIMIT_MICRO_USD ? Number(process.env.INFERENCE_COST_LIMIT_MICRO_USD) : costLimit);
    if (!Number.isSafeInteger(inferenceCostLimit) || inferenceCostLimit < 0) {
        throw new Error('inferenceCostLimitMicroUsd must be a nonnegative integer');
    }
    for (const resource of resources) {
        resource.functions.forEach(validateInferenceFunction);
    }
    const contractCostLimit = nonnegativeInteger('contractCostLimitMicroUsd', options.contractCostLimitMicroUsd, process.env.CONTRACT_COST_LIMIT_MICRO_USD) ?? costLimit;
    const contractDeployFee = nonnegativeInteger('contractDeployFeeMicroUsd', options.contractDeployFeeMicroUsd, process.env.CONTRACT_DEPLOY_FEE_MICRO_USD) ?? 0;
    const maxContractSourceBytes = nonnegativeInteger('maxContractSourceBytes', options.maxContractSourceBytes, process.env.MAX_CONTRACT_SOURCE_BYTES) ?? DEFAULT_MAX_CONTRACT_SOURCE_BYTES;
    return {
        baseUrl: required('BASE_URL', options.baseUrl ?? process.env.BASE_URL),
        publicKey: required('SIGNING_PUBLIC_KEY', options.publicKey ?? process.env.SIGNING_PUBLIC_KEY),
        privateKey: required('SIGNING_PRIVATE_KEY', options.privateKey ?? process.env.SIGNING_PRIVATE_KEY),
        apiKey: options.apiKey ?? process.env.API_KEY,
        // Only a node hosting paid functions settles payments.
        operatorUrl: hostsPaidFunctions(resources)
            ? required('OPERATOR_URL', options.operatorUrl ?? process.env.OPERATOR_URL)
            : options.operatorUrl ?? process.env.OPERATOR_URL,
        costLimitMicroUsd: costLimit,
        inferenceCostLimitMicroUsd: inferenceCostLimit,
        contractCostLimitMicroUsd: contractCostLimit,
        contractDeployFeeMicroUsd: contractDeployFee,
        maxContractSourceBytes,
        ...resolveDatabase(options),
    };
}

/** An option, else its environment variable, which must be a nonnegative integer. Undefined when neither is set. */
function nonnegativeInteger(name: string, option: number | undefined, env: string | undefined): number | undefined {
    const value = option ?? (env ? Number(env) : undefined);
    if (value !== undefined && (!Number.isSafeInteger(value) || value < 0)) {
        throw new Error(`${name} must be a nonnegative integer`);
    }
    return value;
}

function resolveDatabase(options: StellariumNodeOptions): Pick<NodeConfig, 'databasePath' | 'databaseUrl' | 'databaseSchema'> {
    // Empty variables, as a compose file or .env may leave them, count as unset.
    const databaseUrl = options.databaseUrl ?? (process.env.DATABASE_URL || undefined);
    const databasePath = options.databasePath ?? (process.env.DATABASE_PATH || undefined);
    const databaseSchema = options.databaseSchema ?? (process.env.DATABASE_SCHEMA || undefined);
    if (databaseSchema !== undefined) {
        if (databaseUrl === undefined) {
            throw new Error('databaseSchema (DATABASE_SCHEMA) needs a Postgres databaseUrl (DATABASE_URL)');
        }
        assertSchemaName(databaseSchema);
    }
    if (databaseUrl === undefined) {
        return { databasePath: databasePath ?? DEFAULT_DATABASE_PATH };
    }
    if (!isPostgresUrl(databaseUrl)) {
        throw new Error('databaseUrl (DATABASE_URL) must be a postgres:// or postgresql:// URL');
    }
    if (databasePath !== undefined) {
        throw new Error('Set either databaseUrl (DATABASE_URL) for Postgres or databasePath (DATABASE_PATH) for SQLite, not both');
    }
    return { databaseUrl, databaseSchema };
}

export class StellariumNode {
    private resources: StellariumResource[] = [];
    private service?: Service;

    async register(resource: StellariumResource): Promise<void> {
        this.resources.push(resource);
    }

    /**
     * Listens, then bootstraps from `startingPeer` if one is given.
     * Rejects if the server can't listen or bootstrapping fails.
     */
    async start(fastify: FastifyInstance, options: StellariumNodeOptions): Promise<void> {
        const config = resolveConfig(options, this.resources);
        const enrollmentToken = options.enrollmentToken ?? process.env.ENROLLMENT_TOKEN;
        // Paid functions are paid to the node's organization, so a provider must be enrolled before it serves them.
        // A node that only calls paid functions enrolls the same way, so its vouchers draw on its organization's balance.
        // Any other node with an operator still reports its URL, for listing, and learns its organization, so its
        // own organization's run tokens run free.
        const session = () => new OperatorClient(config.operatorUrl, config.publicKey, config.privateKey).session(enrollmentToken, config.baseUrl);
        if (hostsPaidFunctions(this.resources) || enrollmentToken) {
            try {
                ({ organizationId: config.organizationId, priceMicroUsdPerMillionTokens: config.priceMicroUsdPerMillionTokens } = await session());
            } catch (error) {
                const hint = enrollmentToken ? '' : '. Create an enrollment token for it at https://platform.stellarium.sh and set ENROLLMENT_TOKEN';
                throw new Error(`${error instanceof Error ? error.message : String(error)}${hint}`, { cause: error });
            }
        } else if (config.operatorUrl) {
            // Serving doesn't depend on it, so it doesn't hold up the start. Until it answers, run tokens from
            // this node's own organization are refused as if billed.
            session().then(({ organizationId, priceMicroUsdPerMillionTokens }) => {
                config.organizationId = organizationId;
                config.priceMicroUsdPerMillionTokens = priceMicroUsdPerMillionTokens;
            }, (error) => {
                fastify.log.warn(`No session with the operator, so this node can't be listed: ${error instanceof Error ? error.message : String(error)}`);
            });
        }
        const db = await openDatabase(config.databaseUrl ?? config.databasePath, { schema: config.databaseSchema });
        fastify.addHook('onClose', async () => db.close());

        const service = createService(db, this.resources, config, { approveGrant: options.approveGrant });
        // A configured chain may be older than its stored renewal, or long expired; neither should stop the node.
        for (const chain of options.grants ?? []) {
            if (!await service.grantService.seed(chain)) {
                fastify.log.warn(`Skipped expired grant ${chain[chain.length - 1]?.id} from the start options`);
            }
        }
        this.service = service;

        // Each run is scheduled after the previous one finishes, so slow renewals never overlap.
        const refreshIntervalMs = options.grantRefreshIntervalMs ?? DEFAULT_GRANT_REFRESH_INTERVAL_MS;
        let refresher: NodeJS.Timeout | undefined;
        let closed = false;
        const scheduleRefresh = () => {
            refresher = setTimeout(async () => {
                try {
                    const { failed, removed } = await service.grantService.refreshDue();
                    for (const { id, error } of failed) {
                        fastify.log.warn(`Failed to renew grant ${id}: ${error}`);
                    }
                    for (const id of removed) {
                        fastify.log.info(`Removed long-expired grant ${id}: its issuer refused renewal`);
                    }
                } catch (error) {
                    fastify.log.error(error, 'Failed to renew grants');
                }
                if (!closed) {
                    scheduleRefresh();
                }
            }, refreshIntervalMs);
            refresher.unref();
        };
        scheduleRefresh();

        // Contracts are advertised at the node's price, which its organization may change at any time.
        let sessionRefresher: NodeJS.Timeout | undefined;
        const scheduleSessionRefresh = () => {
            sessionRefresher = setTimeout(async () => {
                try {
                    const { organizationId, priceMicroUsdPerMillionTokens } = await session();
                    const changed = organizationId !== config.organizationId || priceMicroUsdPerMillionTokens !== config.priceMicroUsdPerMillionTokens;
                    config.organizationId = organizationId;
                    config.priceMicroUsdPerMillionTokens = priceMicroUsdPerMillionTokens;
                    if (changed && (await service.contractRepository.allLatest()).length > 0) {
                        service.contractService.announce?.();
                    }
                } catch (error) {
                    fastify.log.warn(`Failed to refresh this node's session with the operator: ${error instanceof Error ? error.message : String(error)}`);
                }
                if (!closed) {
                    scheduleSessionRefresh();
                }
            }, options.sessionRefreshIntervalMs ?? DEFAULT_SESSION_REFRESH_INTERVAL_MS);
            sessionRefresher.unref();
        };
        if (config.operatorUrl) {
            scheduleSessionRefresh();
        }

        fastify.addHook('onClose', async () => {
            closed = true;
            clearTimeout(refresher);
            clearTimeout(sessionRefresher);
        });

        await fastify.register(routes, { prefix: '/v1', service, rateLimit: options.rateLimit });
        // Peers learn of a contract as soon as it is deployed, and forget it when it is deleted.
        service.contractService.announce = () => {
            announceResources(fastify.log, service).catch(error => fastify.log.error(error, 'Failed to announce resources'));
        };

        const address = await fastify.listen({ port: options.port ?? 3000, host: options.host ?? '0.0.0.0' });
        fastify.log.info(`server listening on ${address}`);

        if (options.startingPeer) {
            const startupService = new StartupService(fastify.log, service, options.startingPeer, config.baseUrl, config.publicKey, config.privateKey);
            await startupService.seedFromPeer();
        }
    }

    /** Issues a root grant for this node's resources. Hand the returned chain to the audience. */
    async issueGrant(audience: string, capabilities: Capability[], options: GrantOptions): Promise<Grant[]> {
        return this.started().grantService.issue(audience, capabilities, options);
    }

    /**
     * Narrows a grant this node holds for another audience. Hand the returned chain to the audience.
     * Name the held grant by its id, or by its issuer and id when two issuers used the same id.
     */
    async delegateGrant(heldGrant: string | GrantKey, audience: string, capabilities: Capability[], options: GrantOptions): Promise<Grant[]> {
        return this.started().grantService.delegate(heldGrant, audience, capabilities, options);
    }

    /** Asks another node for a grant on its resources, and stores it. Throws if refused. */
    async requestGrant(providerBaseUrl: string, capabilities: Capability[], details?: Record<string, unknown>): Promise<Grant[]> {
        return this.started().grantService.request(providerBaseUrl, capabilities, details);
    }

    /** Stores a grant chain addressed to this node. */
    async addGrant(chain: Grant[]): Promise<void> {
        return this.started().grantService.add(chain);
    }

    /**
     * Refuses the grant, and every grant delegated from it, in calls to this node, and stops its renewal.
     * Name a grant this node issued by its id, and any other grant by its issuer and id.
     */
    async revokeGrant(grant: string | GrantKey): Promise<void> {
        return this.started().grantService.revoke(grant);
    }

    /** Refuses this caller key in restricted calls, renewals, grant requests and paid calls. */
    async blockCaller(publicKey: string, reason?: string): Promise<void> {
        return this.started().grantService.block(publicKey, reason);
    }

    /** False when the key wasn't blocked. */
    async unblockCaller(publicKey: string): Promise<boolean> {
        return this.started().grantService.unblock(publicKey);
    }

    private started(): Service {
        if (!this.service) {
            throw new Error('StellariumNode.start must be called first');
        }
        return this.service;
    }
}
