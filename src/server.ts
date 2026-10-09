import "dotenv/config";
import type { FastifyInstance } from "fastify";
import type { Resource } from "requestscript";
import routes from "./routes.js";
import { createService } from "./service.js";
import { StartupService } from "./startup.js";
import { openDatabase } from "./db/db.js";
import type { ChainAccess, ProtocolSigner } from "./protocol/types.js";
import { ExecutionStore } from "./payment/store.js";
import { EvidenceStore } from "./evidence/encryption.js";
import { RelayDiscovery } from "./relay/discovery.js";
import { RelayService, type RelayOptions } from "./relay/service.js";
import { PaymentRuntime } from "./payment/runtime.js";
import {
    reconcileManifest,
    type MonetizationConfig,
} from "./payment/manifests.js";
export interface StellariumNodeOptions {
    port?: number;
    host?: string;
    startingPeer?: string;
    baseUrl?: string;
    databasePath?: string;
    payments?: {
        chain: ChainAccess;
        executionSigner?: ProtocolSigner;
        evidenceKeys: { publicKey: string; privateKey: string };
    };
    relay?: RelayOptions;
}
export class StellariumNode {
    private resources: Resource[] = [];
    private providers = new Map<string, MonetizationConfig>();
    async register(
        resource: Resource,
        monetization?: MonetizationConfig,
    ): Promise<void> {
        const key = `${resource.path}.${resource.name}`;
        if (this.resources.some((r) => `${r.path}.${r.name}` === key))
            throw new Error("Duplicate Resource");
        this.resources.push(resource);
        if (monetization) this.providers.set(key, monetization);
    }
    async start(
        fastify: FastifyInstance,
        options: StellariumNodeOptions = {},
    ): Promise<void> {
        const db = await openDatabase(options.databasePath);
        const timers: ReturnType<typeof setInterval>[] = [];
        let cleanupRelay: RelayService | undefined;
        let closed = false;
        const closeDatabase = async () => {
            if (!closed) {
                closed = true;
                await db.close();
            }
        };
        try {
            if (
                options.startingPeer &&
                (!process.env.SIGNING_PUBLIC_KEY ||
                    !process.env.SIGNING_PRIVATE_KEY)
            )
                throw new Error("Peer signing keys are required for bootstrap");
            const baseUrl =
                options.baseUrl ??
                process.env.BASE_URL ??
                `http://127.0.0.1:${options.port ?? 3000}`;
            if ((this.providers.size || options.relay) && !options.payments)
                throw new Error("Payment configuration is required");
            const store = new ExecutionStore(db);
            await store.recover();
            const relays = options.payments
                ? new RelayDiscovery(db, options.payments.chain)
                : undefined;
            const evidence = options.payments
                ? new EvidenceStore(
                      db,
                      options.payments.evidenceKeys.publicKey,
                      options.payments.evidenceKeys.privateKey,
                  )
                : undefined;
            const payment = options.payments
                ? new PaymentRuntime({
                      chain: options.payments.chain,
                      executionSigner: options.payments.executionSigner,
                      providers: this.providers,
                      providerEndpoint: baseUrl,
                      store,
                      evidence: evidence!,
                      relays: relays!,
                  })
                : undefined;
            for (const resource of this.resources) {
                const config = this.providers.get(
                    `${resource.path}.${resource.name}`,
                );
                if (config)
                    resource.metadata.monetization = await reconcileManifest(
                        resource,
                        config,
                        options.payments!.chain,
                        evidence!.publicKey,
                    );
            }
            const relay = options.relay
                ? new RelayService(
                      db,
                      options.payments!.chain,
                      options.relay,
                      relays!,
                  )
                : undefined;
            if (relay) await relay.advertise();
            cleanupRelay = relay;
            const service = createService(
                this.resources,
                db,
                baseUrl,
                payment,
                relays,
                relay,
            );
            fastify.register(routes, { prefix: "/v1", service });
            const timer = setInterval(() => {
                void store.flush().catch((error) => fastify.log.error(error));
            }, 5000);
            timer.unref();
            timers.push(timer);
            const advertiseTimer = relay
                ? setInterval(() => {
                      void relay
                          .advertise()
                          .catch((error) => fastify.log.error(error));
                  }, 60_000)
                : undefined;
            advertiseTimer?.unref();
            if (advertiseTimer) timers.push(advertiseTimer);
            fastify.addHook("onClose", async () => {
                for (const handle of timers) clearInterval(handle);
                relay?.stop();
                await closeDatabase();
            });
            relay?.start((error) => fastify.log.error(error));
            await fastify.listen({
                port: options.port ?? 3000,
                host: options.host ?? "127.0.0.1",
            });
            if (
                process.env.SIGNING_PUBLIC_KEY &&
                process.env.SIGNING_PRIVATE_KEY
            ) {
                const startup = new StartupService(
                    fastify.log,
                    service,
                    options.startingPeer ?? baseUrl,
                    baseUrl,
                    process.env.SIGNING_PUBLIC_KEY!,
                    process.env.SIGNING_PRIVATE_KEY!,
                );
                if (options.startingPeer) await startup.seedFromPeer();
                let refreshing = false;
                const discoveryTimer = setInterval(() => {
                    if (refreshing) return;
                    refreshing = true;
                    void startup
                        .synchronize()
                        .catch((error) => fastify.log.error(error))
                        .finally(() => {
                            refreshing = false;
                        });
                }, 60_000);
                discoveryTimer.unref();
                timers.push(discoveryTimer);
            }
        } catch (error) {
            for (const handle of timers) clearInterval(handle);
            cleanupRelay?.stop();
            if (fastify.server.listening) await fastify.close();
            else await closeDatabase();
            throw error;
        }
    }
}
