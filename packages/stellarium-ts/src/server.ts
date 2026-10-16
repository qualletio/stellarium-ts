import 'dotenv/config';
import { FastifyInstance } from 'fastify';
import { DEFAULT_DATABASE_PATH, openDatabase } from './db/db.js';
import { StellariumResource } from './resource/repository.js';
import routes, { RateLimitConfig } from './routes.js';
import { createService, type NodeConfig } from './service.js';
import { StartupService } from './startup.js';

export const DEFAULT_COST_LIMIT_LAMPORTS = 10_000;

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
    /** Bearer token for `POST /v1/run`. Defaults to `API_KEY`. */
    apiKey?: string;
    /** Defaults to `OPERATOR_URL`. */
    operatorUrl?: string;
    /** Most this node pays for one remote call. Defaults to `COST_LIMIT_LAMPORTS`, then 10,000. */
    costLimitLamports?: number;
    /** SQLite file. Defaults to `./requestscript.db`; use ':memory:' for tests. */
    databasePath?: string;
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
    const costLimit = options.costLimitLamports ?? (process.env.COST_LIMIT_LAMPORTS ? Number(process.env.COST_LIMIT_LAMPORTS) : DEFAULT_COST_LIMIT_LAMPORTS);
    if (!Number.isSafeInteger(costLimit) || costLimit < 0) {
        throw new Error('costLimitLamports must be a nonnegative integer');
    }
    return {
        baseUrl: required('BASE_URL', options.baseUrl ?? process.env.BASE_URL),
        publicKey: required('SIGNING_PUBLIC_KEY', options.publicKey ?? process.env.SIGNING_PUBLIC_KEY),
        privateKey: required('SIGNING_PRIVATE_KEY', options.privateKey ?? process.env.SIGNING_PRIVATE_KEY),
        apiKey: options.apiKey ?? process.env.API_KEY,
        // Only a node hosting paid functions settles payments.
        operatorUrl: hostsPaidFunctions(resources)
            ? required('OPERATOR_URL', options.operatorUrl ?? process.env.OPERATOR_URL)
            : options.operatorUrl ?? process.env.OPERATOR_URL,
        costLimitLamports: costLimit,
    };
}

export class StellariumNode {
    private resources: StellariumResource[] = [];

    async register(resource: StellariumResource): Promise<void> {
        this.resources.push(resource);
    }

    /**
     * Listens, then bootstraps from `startingPeer` if one is given.
     * Rejects if the server can't listen or bootstrapping fails.
     */
    async start(fastify: FastifyInstance, options: StellariumNodeOptions): Promise<void> {
        const config = resolveConfig(options, this.resources);
        const db = await openDatabase(options.databasePath ?? DEFAULT_DATABASE_PATH);
        fastify.addHook('onClose', async () => db.close());

        const service = createService(db, this.resources, config);

        await fastify.register(routes, { prefix: '/v1', service, rateLimit: options.rateLimit });

        const address = await fastify.listen({ port: options.port ?? 3000, host: options.host ?? '0.0.0.0' });
        fastify.log.info(`server listening on ${address}`);

        if (options.startingPeer) {
            const startupService = new StartupService(fastify.log, service, options.startingPeer, config.baseUrl, config.publicKey, config.privateKey);
            await startupService.seedFromPeer();
        }
    }
}
