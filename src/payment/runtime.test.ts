import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Database } from "sqlite";
import type { Resource } from "requestscript";
import { openDatabase } from "../db/db.js";
import {
    createPrivateKeySigner,
    typedHash,
    hashName,
    resourceId,
} from "../protocol/typed-data.js";
import { hashRequest, wireJson } from "../protocol/canonical.js";
import type {
    ChainAccess,
    Domain,
    Hex,
    ManifestRevision,
    RequestBudget,
    Signed,
    MonetizationManifest,
} from "../protocol/types.js";
import {
    createEvidenceKeys,
    EvidenceStore,
    decryptEvidence,
} from "../evidence/encryption.js";
import { encryptForArbitrator } from "../sdk/evidence.js";
import { ExecutionStore } from "./store.js";
import { reconcileManifest, type MonetizationConfig } from "./manifests.js";
import { RelayDiscovery } from "../relay/discovery.js";
import { RelayService } from "../relay/service.js";
import { PaymentRuntime } from "./runtime.js";
import { CombinationResourceInvoker } from "../resource/invoker.js";
import {
    validateClaim,
    nowSeconds,
    TransactionNotBroadcastError,
} from "./validation.js";
const signer = (digit: string) =>
    createPrivateKeySigner(`0x${digit.repeat(64)}`);
const caller = signer("1"),
    provider = signer("2"),
    authority = signer("3"),
    relay = signer("4");
const address = (digit: string) => `0x${digit.repeat(40)}` as const;
const domain: Domain = {
    name: "Stellarium",
    version: "1",
    chainId: 84532,
    verifyingContract: address("1"),
};
class Chain implements ChainAccess {
    domain = domain;
    registryDomain = { ...domain, verifyingContract: address("2") };
    relayDomain = { ...domain, verifyingContract: address("3") };
    usdc = address("4");
    budgets = new Map<Hex, RequestBudget>();
    revisions = new Map<string, ManifestRevision>();
    current = new Map<Hex, bigint>();
    published = 0;
    submitted: unknown[] = [];
    async getChainReference() {
        return { blockNumber: 123n, blockHash: hashName("block") };
    }
    async getArbitrationPanel() {
        return undefined;
    }
    async getBudget(id: Hex) {
        return this.budgets.get(id);
    }
    async getRevision(id: Hex, number?: bigint) {
        return this.revisions.get(`${id}:${number ?? this.current.get(id)}`);
    }
    async publishManifest(manifest: Signed<MonetizationManifest>) {
        const m = manifest.message;
        const old = await this.getRevision(m.resourceId);
        if (old) old.retiredAt = nowSeconds();
        this.revisions.set(`${m.resourceId}:${m.manifestRevision}`, {
            manifest,
            activatedAt: nowSeconds(),
            retiredAt: 0n,
        });
        this.current.set(m.resourceId, m.manifestRevision);
        this.published++;
    }
    async isEligibleRelay() {
        return true;
    }
    async relayScore() {
        return 1n;
    }
    async submitClaims(claims: unknown[]) {
        this.submitted = claims;
        return `0x${"a".repeat(64)}` as Hex;
    }
    async getClaimState() {
        return "pending" as const;
    }
    async transactionStatus() {
        return "confirmed" as const;
    }
}
let db: Database;
beforeEach(async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-09T12:00:00Z"));
    db = await openDatabase(":memory:");
});
afterEach(async () => {
    await db?.close();
    vi.useRealTimers();
});
async function fixture() {
    const chain = new Chain();
    const store = new ExecutionStore(db);
    const keys = createEvidenceKeys();
    const evidence = new EvidenceStore(db, keys.publicKey, keys.privateKey);
    const relays = new RelayDiscovery(db, chain);
    const config: MonetizationConfig = {
        identitySigner: provider,
        receiptSigner: provider,
        paymentRecipient: provider.address,
        grossPriceUsdc: 1_000_000n,
    };
    const exec = vi.fn(async () => 12);
    const resource: Resource = {
        path: "example",
        name: "Weather",
        metadata: {},
        functions: [
            {
                name: "forecast",
                parameters: [{ name: "city", type: "string" }],
                returnType: "int32",
                exec,
            },
        ],
    };
    resource.metadata.monetization = await reconcileManifest(
        resource,
        config,
        chain,
        keys.publicKey,
    );
    const ad = await relay.sign("RelayAdvertisement", chain.relayDomain, {
        protocolVersion: 1,
        relay: relay.address,
        endpoint: "https://relay.example",
        receiptVersion: 1,
        relayFeeUsdc: 100_000n,
        available: true,
        issuedAt: nowSeconds(),
        expiresAt: nowSeconds() + 600n,
        nonce: 0n,
    });
    await relays.save(ad);
    const runtime = new PaymentRuntime({
        chain,
        executionSigner: authority,
        providers: new Map([["example.Weather", config]]),
        providerEndpoint: "https://provider.example",
        store,
        evidence,
        relays,
    });
    const source =
        'request X { const weather: example.Weather return weather.forecast(city: "Oslo") }';
    const auth = await caller.sign("RequestAuthorization", domain, {
        protocolVersion: 1,
        requestId: `0x${"b".repeat(64)}`,
        caller: caller.address,
        budgetUsdc: 10_000_000n,
        requestHash: hashRequest(source),
        executionAuthority: authority.address,
        issuedAt: nowSeconds(),
        expiresAt: nowSeconds() + 3600n,
        nonce: 0n,
    });
    chain.budgets.set(auth.message.requestId, {
        caller: caller.address,
        authorizationHash: typedHash("RequestAuthorization", auth),
        remainingUsdc: 10_000_000n,
        expiresAt: auth.message.expiresAt,
        open: true,
    });
    return {
        chain,
        store,
        keys,
        evidence,
        relays,
        config,
        exec,
        resource,
        runtime,
        source,
        auth,
    };
}
describe("payment execution and persistence", () => {
    it("preserves quotes across unchanged startup, including when only timestamps change", async () => {
        const f = await fixture();
        const first = f.resource.metadata.monetization;
        vi.setSystemTime(new Date(Date.now() + 30 * 24 * 3600_000));
        expect(
            await reconcileManifest(
                f.resource,
                f.config,
                f.chain,
                f.keys.publicKey,
            ),
        ).toEqual(first);
        expect(f.chain.published).toBe(1);
    });
    it("replaces only the changed Resource manifest", async () => {
        const f = await fixture();
        const old = f.resource.metadata
            .monetization as Signed<MonetizationManifest>;
        vi.setSystemTime(new Date(Date.now() + 1000));
        const updated = await reconcileManifest(
            f.resource,
            { ...f.config, grossPriceUsdc: 2_000_000n },
            f.chain,
            f.keys.publicKey,
        );
        expect(updated.message.manifestRevision).toBe(2n);
        expect(updated.message.functions[0].quoteId).not.toBe(
            old.message.functions[0].quoteId,
        );
        expect(
            (await f.chain.getRevision(old.message.resourceId, 1n))?.retiredAt,
        ).toBe(nowSeconds());
    });
    it("allows repeated purchases using one quote and rejects duplicate execution on redelivery", async () => {
        const f = await fixture();
        const session = await f.runtime.session(f.auth, f.source);
        const invoker = new CombinationResourceInvoker(f.runtime, session);
        await invoker.invoke(f.resource, "forecast", [
            { name: "city", value: "Oslo" },
        ]);
        await invoker.invoke(f.resource, "forecast", [
            { name: "city", value: "Oslo" },
        ]);
        expect(session.executions).toHaveLength(2);
        expect(session.executions[0].claim.receipt.message.quoteId).toBe(
            session.executions[1].claim.receipt.message.quoteId,
        );
        const claim = session.executions[0].claim;
        const result = await f.runtime.execute(
            {
                version: 1,
                kind: "invocation",
                resourceId: claim.grant.message.resourceId,
                resourceKey: "example.Weather",
                functionName: "forecast",
                parameters: [{ name: "city", value: "Oslo" }],
                payment: { authorization: f.auth, grant: claim.grant },
            },
            f.resource,
            async () => {
                throw new Error("must not execute");
            },
        );
        expect(result.returnValue).toBe(12);
        expect(f.exec).toHaveBeenCalledTimes(2);
        expect(session.remainingEstimate).toBe(8_000_000n);
    });
    it("does not produce a receipt for an invalid function result", async () => {
        const f = await fixture();
        f.resource.functions[0].exec = async () => "wrong type";
        const session = await f.runtime.session(f.auth, f.source);
        await expect(
            new CombinationResourceInvoker(f.runtime, session).invoke(
                f.resource,
                "forecast",
                [{ name: "city", value: "Oslo" }],
            ),
        ).rejects.toThrow("declared type");
        expect(await db.get("SELECT COUNT(*) AS n FROM outbox")).toEqual({
            n: 0,
        });
        expect(session.executions).toEqual([]);
    });
    it("rejects modified parameters before executing", async () => {
        const f = await fixture();
        const session = await f.runtime.session(f.auth, f.source);
        const grant = await f.runtime.issueGrant(
            session,
            f.resource,
            "forecast",
            [{ name: "city", value: "Oslo" }],
        );
        await expect(
            f.runtime.execute(
                {
                    version: 1,
                    kind: "invocation",
                    resourceId: grant!.message.resourceId,
                    resourceKey: "example.Weather",
                    functionName: "forecast",
                    parameters: [{ name: "city", value: "Berlin" }],
                    payment: { authorization: f.auth, grant: grant! },
                },
                f.resource,
                async () => 12,
            ),
        ).rejects.toThrow("differs");
        expect(f.exec).not.toHaveBeenCalled();
    });
    it("preserves historical receipt keys after manifest rotation", async () => {
        const f = await fixture();
        const session = await f.runtime.session(f.auth, f.source);
        await new CombinationResourceInvoker(f.runtime, session).invoke(
            f.resource,
            "forecast",
            [{ name: "city", value: "Oslo" }],
        );
        vi.setSystemTime(new Date(Date.now() + 1000));
        await reconcileManifest(
            f.resource,
            { ...f.config, receiptSigner: authority },
            f.chain,
            f.keys.publicKey,
        );
        await expect(
            validateClaim(f.chain, session.executions[0].claim),
        ).resolves.toBeUndefined();
    });
    it("marks interrupted invocations indeterminate on recovery", async () => {
        const f = await fixture();
        const id = `0x${"c".repeat(64)}` as Hex;
        await f.store.begin(id);
        await f.store.recover();
        expect((await f.store.get(id))?.status).toBe("indeterminate");
        expect(await f.store.begin(id)).toBe(false);
    });
    it("persists encrypted evidence and uses a format interoperable with browser cryptography", async () => {
        const keys = createEvidenceKeys();
        const envelope = await encryptForArbitrator(
            { secret: "result" },
            keys.publicKey,
        );
        expect(decryptEvidence(envelope, keys.privateKey)).toEqual({
            secret: "result",
        });
        const f = await fixture();
        const session = await f.runtime.session(f.auth, f.source);
        await new CombinationResourceInvoker(f.runtime, session).invoke(
            f.resource,
            "forecast",
            [{ name: "city", value: "Oslo" }],
        );
        const stored = await f.evidence.get(session.executions[0].evidenceId);
        expect(JSON.stringify(stored)).not.toContain("Oslo");
        expect(decryptEvidence(stored!, f.keys.privateKey)).toHaveProperty(
            "returnValue",
            12,
        );
    });
    it("retries a known preflight failure without rebroadcasting an ambiguous submission", async () => {
        const f = await fixture();
        const session = await f.runtime.session(f.auth, f.source);
        await new CombinationResourceInvoker(f.runtime, session).invoke(
            f.resource,
            "forecast",
            [{ name: "city", value: "Oslo" }],
        );
        const relayService = new RelayService(
            db,
            f.chain,
            {
                signer: relay,
                endpoint: "https://relay.example",
                relayFeeUsdc: 100_000n,
            },
            f.relays,
        );
        await relayService.accept(session.executions[0].claim);
        const submit = vi
            .spyOn(f.chain, "submitClaims")
            .mockRejectedValueOnce(
                new TransactionNotBroadcastError("oracle stale"),
            );
        await relayService.tick();
        expect((await db.get("SELECT state FROM relay_queue")).state).toBe(
            "queued",
        );
        submit.mockRejectedValueOnce(new Error("connection lost after send"));
        await relayService.tick();
        expect((await db.get("SELECT state FROM relay_queue")).state).toBe(
            "submitting",
        );
        await relayService.tick();
        expect(submit).toHaveBeenCalledTimes(2);
    });
    it("queues claims durably, deduplicates delivery, and follows transaction confirmation", async () => {
        const f = await fixture();
        const session = await f.runtime.session(f.auth, f.source);
        await new CombinationResourceInvoker(f.runtime, session).invoke(
            f.resource,
            "forecast",
            [{ name: "city", value: "Oslo" }],
        );
        const service = new RelayService(
            db,
            f.chain,
            {
                signer: relay,
                endpoint: "https://relay.example",
                relayFeeUsdc: 100_000n,
            },
            f.relays,
        );
        const claim = session.executions[0].claim;
        await service.accept(claim);
        await service.accept(claim);
        expect(await db.get("SELECT COUNT(*) AS n FROM relay_queue")).toEqual({
            n: 1,
        });
        await service.tick();
        await service.tick();
        expect((await db.get("SELECT state FROM relay_queue")).state).toBe(
            "confirmed",
        );
    });
});

describe("paid HTTP and SDK integration", () => {
    it("preserves a paid invocation grant when forwarding and reuses its saved result", async () => {
        const { default: Fastify } = await import("fastify");
        const { default: routes } = await import("../routes.js");
        const { createService } = await import("../service.js");
        const { runSchema } = await import("../protocol/schema.js");
        const f = await fixture();
        const provider = Fastify();
        provider.register(routes, {
            prefix: "/v1",
            service: createService(
                [f.resource],
                db,
                "https://node.example",
                f.runtime,
                f.relays,
            ),
        });
        const sent: unknown[] = [];
        const fetcher: typeof fetch = async (_url, options) => {
            sent.push(JSON.parse(options!.body as string));
            const response = await provider.inject({
                method: "POST",
                url: "/v1/run",
                payload: options!.body as string,
                headers: { "content-type": "application/json" },
            });
            return new Response(response.body, { status: response.statusCode });
        };
        const remote = {
            ...f.resource,
            metadata: {
                ...f.resource.metadata,
                baseUrl: "https://node.example",
            },
        };
        const session = await f.runtime.session(f.auth, f.source);
        const invoker = new CombinationResourceInvoker(
            f.runtime,
            session,
            fetcher,
        );
        expect(
            await invoker.invoke(remote, "forecast", [
                { name: "city", value: "Oslo" },
            ]),
        ).toBe(12);
        const body = runSchema.parse(sent[0]);
        if (body.kind !== "invocation")
            throw new Error("wrong forwarded envelope");
        expect(session.executions[0].claim.receipt.message.invocationId).toBe(
            typedHash("InvocationGrant", body.payment!.grant),
        );
        const retry = await invoker.dispatch(body, remote);
        expect(retry.returnValue).toBe(12);
        expect(f.exec).toHaveBeenCalledOnce();
        expect(sent).toHaveLength(2);
        await provider.close();
    });

    it("executes once, requires fresh access proofs for retries, and delivers caller acceptance", async () => {
        const { default: Fastify } = await import("fastify");
        const { default: routes } = await import("../routes.js");
        const { createService } = await import("../service.js");
        const { proveRunAccess } = await import("../protocol/access.js");
        const { StellariumClient } = await import("../sdk/client.js");
        const f = await fixture();
        const app = Fastify();
        app.register(routes, {
            prefix: "/v1",
            service: createService(
                [f.resource],
                db,
                "https://node.example",
                f.runtime,
                f.relays,
            ),
        });
        const body = await proveRunAccess(
            {
                version: 1,
                kind: "request",
                source: f.source,
                payment: { authorization: f.auth },
            },
            caller,
            domain,
            "https://node.example",
        );
        const first = await app.inject({
            method: "POST",
            url: "/v1/run",
            payload: JSON.parse(wireJson(body)),
        });
        expect(first.statusCode).toBe(200);
        expect(first.json().executions).toHaveLength(1);
        expect(
            first.json().executions[0].dispatchAcknowledgement.message
                .chainBlockNumber,
        ).toBe("123");
        const archive = await f.evidence.get(first.json().evidenceId);
        expect(decryptEvidence(archive!, f.keys.privateKey)).toMatchObject({
            source: f.source,
            trace: [{ resourceId: resourceId("example.Weather") }],
        });
        const reused = await app.inject({
            method: "POST",
            url: "/v1/run",
            payload: JSON.parse(wireJson(body)),
        });
        expect(reused.statusCode).toBe(409);
        const fetcher: typeof fetch = async (input, options) => {
            const path = new URL(String(input)).pathname;
            const response = await app.inject({
                method: "POST",
                url: path,
                payload: options!.body as string,
                headers: { "content-type": "application/json" },
            });
            return new Response(response.body, {
                status: response.statusCode,
                headers: { "content-type": "application/json" },
            });
        };
        const client = new StellariumClient(
            f.chain as unknown as import("./chain.js").ViemChainAccess,
            caller,
            fetcher,
        );
        const result = await client.run(
            "https://node.example",
            f.source,
            f.auth,
        );
        expect(result.returnValue).toBe(12);
        expect(f.exec).toHaveBeenCalledOnce();
        const queued = JSON.parse(
            (await db.get("SELECT claim_json FROM outbox")).claim_json,
        );
        expect(queued.acceptance.signature).toMatch(/^0x/);
        const offlineAcceptance: typeof fetch = async (input, options) =>
            String(input).endsWith("/payments/acceptances")
                ? new Response("unavailable", { status: 503 })
                : fetcher(input, options);
        const fallbackClient = new StellariumClient(
            f.chain as unknown as import("./chain.js").ViemChainAccess,
            caller,
            offlineAcceptance,
        );
        const fallback = await fallbackClient.run(
            "https://node.example",
            f.source,
            f.auth,
        );
        expect(fallback.returnValue).toBe(12);
        expect(fallback.executions[0].acceptanceDeliveryError).toBe(
            "Acceptance delivery failed",
        );
        expect(f.exec).toHaveBeenCalledOnce();
        await app.close();
    });
});
