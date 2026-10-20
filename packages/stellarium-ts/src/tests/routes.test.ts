import Fastify, { type FastifyInstance } from "fastify";
import type { Database } from "sqlite";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { signData } from "../crypto/utils.js";
import { openDatabase } from "../db/db.js";
import { type Grant, grantRenewalPayload, grantRequestPayload } from "../grant/grant.js";
import { GrantRepository } from "../grant/repository.js";
import { GrantService } from "../grant/service.js";
import { type Peer, peerAnnouncementPayload } from "../peer/repository.js";
import { CombinationResourceInvoker, type InferencePaymentVoucher, inferenceVoucherPayload, type PaymentVoucher, paymentVoucherPayload } from "../resource/invoker.js";
import { resourceAnnouncementPayload, type StellariumResource } from "../resource/repository.js";
import routes from "../routes.js";
import { createService, type NodeConfig, type Service } from "../service.js";
import { COST, generateBase64KeyPair, INFERENCE_RATES, modelResource, RECIPIENT, temperatureSource, testConfig, weatherResource } from "./helpers.js";

const parameters = [{ name: "city", value: "Oslo" }];
const inMinutes = (minutes: number) => new Date(Date.now() + minutes * 60_000).toISOString();

describe("routes", () => {
    const weather = weatherResource();
    const caller = generateBase64KeyPair();
    // Signs vouchers as a remote caller would. Its local branch never touches the repository.
    const callerInvoker = new CombinationResourceInvoker(undefined as never, 100_000, caller.publicKey, caller.privateKey);

    let db: Database;
    let config: NodeConfig;
    let service: Service;
    let fastify: FastifyInstance;
    let settlePayment: ReturnType<typeof vi.spyOn>;

    beforeEach(async () => {
        db = await openDatabase(":memory:");
        config = testConfig();
        service = createService(db, [weather], config);
        settlePayment = vi.spyOn(service.operatorClient, "settlePayment").mockResolvedValue(undefined);

        fastify = Fastify();
        await fastify.register(routes, { prefix: "/v1", service });
        await fastify.ready();
    });

    afterEach(async () => {
        await fastify.close();
        await db.close();
        vi.restoreAllMocks();
    });

    // Settlement is scheduled with setTimeout(0) after the response is sent.
    const flushSettlement = () => new Promise((resolve) => setTimeout(resolve, 10));

    describe("POST /v1/run/resource", () => {
        function voucherFor(functionName = "temperature", overrides: Partial<Omit<PaymentVoucher, "signature">> = {}): PaymentVoucher {
            const voucher = callerInvoker.createPaymentVoucher(RECIPIENT, COST, weather.path, weather.name, functionName, parameters);
            if (Object.keys(overrides).length === 0) {
                return voucher;
            }
            // Re-sign so the only defect is the overridden field.
            const resigned = { ...voucher, ...overrides };
            return { ...resigned, signature: signData(paymentVoucherPayload(resigned), caller.privateKey) };
        }

        function runResource(body: Record<string, unknown>) {
            return fastify.inject({
                method: "POST",
                url: "/v1/run/resource",
                payload: { resourcePath: weather.path, resourceName: weather.name, functionName: "temperature", parameters, ...body },
            });
        }

        test("runs a paid function with a valid voucher and settles it", async () => {
            const paymentVoucher = voucherFor();
            const response = await runResource({ paymentVoucher });

            expect(response.statusCode).toBe(200);
            expect(response.json()).toEqual({ value: 12, error: null });
            await flushSettlement();
            expect(settlePayment).toHaveBeenCalledExactlyOnceWith({ voucher: paymentVoucher });
        });

        test("refuses a voucher from a blocked caller, even for an unrestricted function", async () => {
            await service.grantService.block(caller.publicKey);

            const response = await runResource({ paymentVoucher: voucherFor() });

            expect(response.statusCode).toBe(403);
            expect(response.json()).toEqual({ error: "Caller is blocked" });
            await flushSettlement();
            expect(settlePayment).not.toHaveBeenCalled();
        });

        test("accepts a voucher that pays more than the cost", async () => {
            const response = await runResource({ paymentVoucher: voucherFor("temperature", { amount: COST + 1 }) });

            expect(response.statusCode).toBe(200);
        });

        test("rejects a paid function without a voucher", async () => {
            const response = await runResource({});

            expect(response.statusCode).toBe(402);
            await flushSettlement();
            expect(settlePayment).not.toHaveBeenCalled();
        });

        test.each([
            ["pays less than the cost", { amount: COST - 1 }],
            ["pays a different recipient", { recipientAddress: "11111111111111111111111111111111" }],
            ["has expired", { expiresAt: new Date(Date.now() - 1000).toISOString() }],
            ["has an unparseable expiry", { expiresAt: "not-a-date" }],
        ])("rejects a voucher that %s", async (_, overrides) => {
            const response = await runResource({ paymentVoucher: voucherFor("temperature", overrides) });

            expect(response.statusCode).toBe(400);
            expect(response.json()).toEqual({ error: "Invalid payment voucher" });
            await flushSettlement();
            expect(settlePayment).not.toHaveBeenCalled();
        });

        test("rejects a voucher whose parameters were tampered with", async () => {
            const response = await runResource({ paymentVoucher: voucherFor(), parameters: [{ name: "city", value: "Bergen" }] });

            expect(response.statusCode).toBe(400);
        });

        test("rejects a voucher issued for a different function", async () => {
            const paymentVoucher = callerInvoker.createPaymentVoucher(RECIPIENT, COST, weather.path, weather.name, "humidity", parameters);
            const response = await runResource({ paymentVoucher });

            expect(response.statusCode).toBe(400);
        });

        test("rejects a voucher with a forged signature", async () => {
            const paymentVoucher = { ...voucherFor(), amount: COST * 2 };
            const response = await runResource({ paymentVoucher });

            expect(response.statusCode).toBe(400);
        });

        test("rejects a voucher with a malformed public key", async () => {
            const response = await runResource({ paymentVoucher: { ...voucherFor(), publicKey: "not-a-key" } });

            expect(response.statusCode).toBe(400);
        });

        test("rejects a voucher with missing fields", async () => {
            const { signature: _, ...unsigned } = voucherFor();
            const response = await runResource({ paymentVoucher: unsigned });

            expect(response.statusCode).toBe(400);
        });

        test("runs a free function and ignores any voucher sent with it", async () => {
            const response = await runResource({ functionName: "humidity", paymentVoucher: voucherFor("humidity") });

            expect(response.statusCode).toBe(200);
            expect(response.json()).toEqual({ value: 80, error: null });
            await flushSettlement();
            expect(settlePayment).not.toHaveBeenCalled();
        });

        test("rejects an unknown function without settling the voucher", async () => {
            const response = await runResource({ functionName: "missing", paymentVoucher: voucherFor("missing") });

            expect(response.statusCode).toBe(400);
            expect(response.json()).toEqual({ error: "Function not found" });
            await flushSettlement();
            expect(settlePayment).not.toHaveBeenCalled();
        });

        test("does not settle when the invoke returns an error", async () => {
            vi.spyOn(service.resourceInvoker, "invoke").mockResolvedValueOnce({ value: null, error: { message: "boom" } });
            const response = await runResource({ paymentVoucher: voucherFor() });

            expect(response.statusCode).toBe(200);
            await flushSettlement();
            expect(settlePayment).not.toHaveBeenCalled();
        });

        test("rejects an unknown resource", async () => {
            const response = await runResource({ resourceName: "Missing" });

            expect(response.statusCode).toBe(400);
            expect(response.json()).toEqual({ error: "Resource not found" });
        });

        test("rejects a body without the call fields", async () => {
            const response = await fastify.inject({ method: "POST", url: "/v1/run/resource", payload: {} });

            expect(response.statusCode).toBe(400);
        });
    });

    describe("POST /v1/run", () => {
        function run(authorization?: string, payload: unknown = { source: temperatureSource }) {
            return fastify.inject({
                method: "POST",
                url: "/v1/run",
                headers: authorization === undefined ? {} : { authorization },
                payload: payload as Record<string, unknown>,
            });
        }

        test("runs the request with the configured API key", async () => {
            const response = await run("Bearer secret");

            expect(response.statusCode).toBe(200);
            // RequestScript resource calls evaluate to the invoker's { value, error } result.
            expect(response.json()).toEqual({ returnValue: { value: 12, error: null } });
        });

        test("requires an Authorization header", async () => {
            const response = await run();

            expect(response.statusCode).toBe(401);
            expect(response.json()).toEqual({ error: "Authorization header is required" });
        });

        test.each([
            ["the wrong key", "Bearer wrong"],
            ["a key that is a prefix of the real one", "Bearer secre"],
            ["no token", "Bearer"],
        ])("rejects %s", async (_, authorization) => {
            const response = await run(authorization);

            expect(response.statusCode).toBe(401);
            expect(response.json()).toEqual({ error: "Invalid API Key" });
        });

        test.each([
            ["unset", undefined],
            ["empty", ""],
        ])("rejects every request when the API key is %s", async (_, apiKey) => {
            config.apiKey = apiKey;

            for (const authorization of ["Bearer", "Bearer ", "Bearer undefined"]) {
                const response = await run(authorization);
                expect(response.statusCode).toBe(401);
            }
        });

        test("authenticates before validating the body", async () => {
            expect((await run("Bearer wrong", {})).statusCode).toBe(401);
            expect((await run("Bearer secret", {})).statusCode).toBe(400);
        });

        test("rejects a script that doesn't parse with 400", async () => {
            const response = await run("Bearer secret", { source: "not a script" });

            expect(response.statusCode).toBe(400);
            expect(response.json()).toMatchObject({ error: "Invalid script" });
        });
    });

    describe("GET /v1/self", () => {
        test("describes this node from its config", async () => {
            const response = await fastify.inject({ method: "GET", url: "/v1/self" });

            expect(response.json()).toEqual({ baseUrl: config.baseUrl, publicKey: config.publicKey, name: config.baseUrl });
        });
    });

    describe("PUT /v1/peers", () => {
        const keys = generateBase64KeyPair();
        const peer: Peer = { baseUrl: "http://peer.example", name: "http://peer.example", publicKey: keys.publicKey };

        function announce(announced: Peer, privateKey = keys.privateKey, expiry = inMinutes(10), payload = peerAnnouncementPayload(announced, expiry)) {
            return fastify.inject({
                method: "PUT",
                url: "/v1/peers",
                payload: { ...announced, expiry, signature: signData(payload, privateKey) },
            });
        }

        const peers = async () => (await fastify.inject({ method: "GET", url: "/v1/peers" })).json().peers;

        test("saves a peer with a valid announcement", async () => {
            const response = await announce(peer);

            expect(response.statusCode).toBe(200);
            expect(await peers()).toEqual([peer]);
        });

        test("lets a known peer change its base URL", async () => {
            await announce(peer);
            const moved = { ...peer, baseUrl: "http://moved.example", name: "http://moved.example" };
            const response = await announce(moved);

            expect(response.statusCode).toBe(200);
            expect(await peers()).toEqual([moved]);
        });

        test("rejects an announcement signed by a different key", async () => {
            const response = await announce(peer, generateBase64KeyPair().privateKey);

            expect(response.statusCode).toBe(400);
            expect(await peers()).toEqual([]);
        });

        test("rejects an announcement whose signature doesn't cover the public key", async () => {
            const expiry = inMinutes(10);
            const response = await announce(peer, keys.privateKey, expiry, { baseUrl: peer.baseUrl, name: peer.name, expiry } as never);

            expect(response.statusCode).toBe(400);
        });

        test.each([
            ["expired", inMinutes(-1)],
            ["valid too far into the future", inMinutes(24 * 60)],
            ["unparseable", "soon"],
        ])("rejects an announcement whose expiry is %s", async (_, expiry) => {
            const response = await announce(peer, keys.privateKey, expiry);

            expect(response.statusCode).toBe(400);
        });

        test("rejects another key claiming a known peer's base URL", async () => {
            await announce(peer);
            const impostor = generateBase64KeyPair();
            const response = await announce({ ...peer, publicKey: impostor.publicKey }, impostor.privateKey);

            expect(response.statusCode).toBe(409);
            expect(await peers()).toEqual([peer]);
        });

        test("rejects an announcement with missing fields", async () => {
            const response = await fastify.inject({ method: "PUT", url: "/v1/peers", payload: { baseUrl: peer.baseUrl } });

            expect(response.statusCode).toBe(400);
        });
    });

    describe("PUT /v1/all-resources", () => {
        const keys = generateBase64KeyPair();
        const peer: Peer = { baseUrl: "http://peer.example", name: "http://peer.example", publicKey: keys.publicKey };

        const forecast = (baseUrl = peer.baseUrl, name = "Forecast"): StellariumResource => ({
            id: 7,
            baseUrl,
            metadata: {},
            path: "com.peer",
            name,
            functions: [{
                name: "tomorrow",
                parameters: [{ name: "city", type: "string" }],
                returnType: "string",
                exec: async () => "sunny",
                paymentManifest: { costMicroUsdc: 500, recipientAddress: RECIPIENT },
            }],
        });

        function broadcast(resources: StellariumResource[], privateKey = keys.privateKey, publicKey = keys.publicKey) {
            const expiry = inMinutes(10);
            // Serialize as the sender does, so the receiver sees the same JSON the signature covers.
            const sent = JSON.parse(JSON.stringify(resources));
            return fastify.inject({
                method: "PUT",
                url: "/v1/all-resources",
                payload: { publicKey, resources: sent, expiry, signature: signData(resourceAnnouncementPayload(sent, expiry), privateKey) },
            });
        }

        beforeEach(async () => {
            const expiry = inMinutes(10);
            await service.peerRepository.announce(peer, signData(peerAnnouncementPayload(peer, expiry), keys.privateKey), expiry);
        });

        test("saves a known peer's resources, including payment manifests", async () => {
            const response = await broadcast([forecast()]);

            expect(response.statusCode).toBe(200);
            expect(response.json()).toEqual({ success: true, rejected: [] });
            const resources = (await fastify.inject({ method: "GET", url: "/v1/resources" })).json().resources;
            expect(resources.find((r: StellariumResource) => r.name === "Forecast")).toMatchObject({
                baseUrl: peer.baseUrl,
                functions: [{ name: "tomorrow", paymentManifest: { costMicroUsdc: 500, recipientAddress: RECIPIENT } }],
            });
        });

        test("rejects a broadcast from an unknown peer", async () => {
            const stranger = generateBase64KeyPair();
            const response = await broadcast([forecast()], stranger.privateKey, stranger.publicKey);

            expect(response.statusCode).toBe(400);
            expect(response.json()).toEqual({ error: "Peer not found" });
        });

        test("rejects a broadcast not signed by the peer", async () => {
            const response = await broadcast([forecast()], generateBase64KeyPair().privateKey);

            expect(response.statusCode).toBe(400);
            expect(response.json()).toEqual({ error: "Invalid signature" });
        });

        test("rejects resources served from another base URL or hosted by this node", async () => {
            const response = await broadcast([forecast("http://elsewhere.example"), { ...weatherResource(peer.baseUrl) }]);

            expect(response.json()).toEqual({ success: true, rejected: ["com.peer.Forecast", "com.example.Weather"] });
            expect(await service.resourceRepository.getResourceFunction("com.peer", "Forecast", "tomorrow")).toBeUndefined();
        });
    });

    describe("pagination", () => {
        const get = (url: string) => fastify.inject({ method: "GET", url });

        beforeEach(async () => {
            for (let i = 0; i < 5; i++) {
                const baseUrl = `http://peer${i}.example`;
                await service.peerRepository.create({ baseUrl, name: baseUrl, publicKey: `key-${i}` });
                await service.resourceRepository.learn({ id: 0, baseUrl, metadata: {}, path: "com.peer", name: `Learned${i}`, functions: [] });
            }
        });

        test("GET /v1/peers returns pages in insertion order", async () => {
            const first = (await get("/v1/peers?limit=2")).json();
            const last = (await get("/v1/peers?offset=4&limit=2")).json();

            expect(first.peers.map((p: Peer) => p.publicKey)).toEqual(["key-0", "key-1"]);
            expect(first.nextOffset).toBe(2);
            expect(last.peers.map((p: Peer) => p.publicKey)).toEqual(["key-4"]);
            expect(last.nextOffset).toBeNull();
        });

        test("GET /v1/resources lists hosted resources, then learned ones", async () => {
            const first = (await get("/v1/resources?limit=2")).json();
            const second = (await get(`/v1/resources?offset=${first.nextOffset}&limit=10`)).json();

            expect(first.resources.map((r: StellariumResource) => r.name)).toEqual(["Weather", "Learned0"]);
            expect(second.resources.map((r: StellariumResource) => r.name)).toEqual(["Learned1", "Learned2", "Learned3", "Learned4"]);
            expect(second.nextOffset).toBeNull();
        });

        test("a page ending exactly at the last item has no next page", async () => {
            expect((await get("/v1/peers?offset=3&limit=2")).json().nextOffset).toBeNull();
        });

        test("defaults to the first page", async () => {
            expect((await get("/v1/peers")).json()).toMatchObject({ nextOffset: null, peers: expect.any(Array) });
        });

        test.each([
            ["a limit above the maximum", "limit=501"],
            ["a zero limit", "limit=0"],
            ["a negative offset", "offset=-1"],
            ["a non-numeric offset", "offset=abc"],
        ])("rejects %s", async (_, query) => {
            expect((await get(`/v1/peers?${query}`)).statusCode).toBe(400);
            expect((await get(`/v1/resources?${query}`)).statusCode).toBe(400);
        });
    });
});

describe("restricted functions", () => {
    const caller = generateBase64KeyPair();
    const callerInvoker = new CombinationResourceInvoker(undefined as never, 100_000, caller.publicKey, caller.privateKey);
    const restricted: StellariumResource = {
        id: 1,
        baseUrl: "http://127.0.0.1:3002",
        metadata: {},
        path: "com.example",
        name: "Vault",
        functions: [
            { name: "open", parameters: [{ name: "city", type: "string" }], returnType: "int32", exec: async () => 7, restricted: true },
            { name: "premium", parameters: [{ name: "city", type: "string" }], returnType: "int32", exec: async () => 9, restricted: true, paymentManifest: { costMicroUsdc: COST, recipientAddress: RECIPIENT } },
        ],
    };
    const call = (functionName: string) => ({ resourcePath: "com.example", resourceName: "Vault", functionName, parameters });

    let db: Database;
    let service: Service;
    let callerGrants: GrantService;
    let callerDb: Database;
    let fastify: FastifyInstance;
    let grant: Grant[];

    beforeEach(async () => {
        db = await openDatabase(":memory:");
        service = createService(db, [restricted], testConfig());
        vi.spyOn(service.operatorClient, "settlePayment").mockResolvedValue(undefined);
        callerDb = await openDatabase(":memory:");
        callerGrants = new GrantService(new GrantRepository(callerDb), { baseUrl: "http://caller", ...caller });
        grant = await service.grantService.issue(caller.publicKey, [{ resourcePath: "com.example", resourceName: "Vault" }], { lifetimeMs: 3_600_000 });

        fastify = Fastify();
        await fastify.register(routes, { prefix: "/v1", service });
        await fastify.ready();
    });

    afterEach(async () => {
        await fastify.close();
        await db.close();
        await callerDb.close();
        vi.restoreAllMocks();
    });

    const runResource = (body: Record<string, unknown>) => fastify.inject({ method: "POST", url: "/v1/run/resource", payload: body });

    test("is announced as restricted", async () => {
        const response = await fastify.inject({ method: "GET", url: "/v1/resources" });

        expect(response.json().resources[0].functions).toEqual([
            expect.objectContaining({ name: "open", restricted: true }),
            expect.objectContaining({ name: "premium", restricted: true }),
        ]);
    });

    test("requires an authorization, with no grant endpoint when the node takes no requests", async () => {
        const response = await runResource(call("open"));

        expect(response.statusCode).toBe(403);
        expect(response.json()).toEqual({ error: "Authorization is required" });
    });

    test("refuses grant requests when the node has no approval hook", async () => {
        const response = await fastify.inject({ method: "POST", url: "/v1/grants/request", payload: { publicKey: caller.publicKey, capabilities: [{ resourcePath: "*" }], nonce: "n", expiresAt: inMinutes(1), signature: "s" } });

        expect(response.statusCode).toBe(403);
        expect(response.json()).toEqual({ error: "This node does not issue grants on request" });
    });

    describe("with an approval hook", () => {
        const vaultCapability = { resourcePath: "com.example", resourceName: "Vault" };

        beforeEach(async () => {
            await fastify.close();
            await db.close();
            db = await openDatabase(":memory:");
            service = createService(db, [restricted], testConfig(), {
                approveGrant: ({ details }) => details?.invite === "letmein" ? { lifetimeMs: 3_600_000 } : undefined,
            });
            fastify = Fastify();
            await fastify.register(routes, { prefix: "/v1", service });
            await fastify.ready();
        });

        function grantRequest(details: Record<string, unknown> | null) {
            const unsigned = { publicKey: caller.publicKey, capabilities: [vaultCapability], details, nonce: crypto.randomUUID(), expiresAt: inMinutes(1) };
            return { ...unsigned, signature: signData(grantRequestPayload(unsigned), caller.privateKey) };
        }

        test("points a caller without a usable grant at the request route", async () => {
            const missing = await runResource(call("open"));
            expect(missing.json()).toEqual({ error: "Authorization is required", grantEndpoint: "http://127.0.0.1:3002/v1/grants/request" });

            const invalid = await runResource({ ...call("open"), authorization: { grants: [] } });
            expect(invalid.json()).toEqual({ error: "Invalid authorization", grantEndpoint: "http://127.0.0.1:3002/v1/grants/request" });
        });

        test("issues an approved grant that then authorizes calls", async () => {
            const response = await fastify.inject({ method: "POST", url: "/v1/grants/request", payload: grantRequest({ invite: "letmein" }) });

            expect(response.statusCode).toBe(200);
            const { grants } = response.json() as { grants: Grant[] };
            expect(grants).toEqual([expect.objectContaining({ audience: caller.publicKey, capabilities: [vaultCapability] })]);

            const run = await runResource({ ...call("open"), authorization: callerGrants.authorize(grants, call("open")) });
            expect(run.json()).toEqual({ value: 7, error: null });
        });

        test("refuses a request the hook declines", async () => {
            const response = await fastify.inject({ method: "POST", url: "/v1/grants/request", payload: grantRequest({ invite: "wrong" }) });

            expect(response.statusCode).toBe(403);
            expect(response.json()).toEqual({ error: "Grant request refused" });
        });

        test("answers 500 when the approval hook returns an invalid approval", async () => {
            await fastify.close();
            await db.close();
            db = await openDatabase(":memory:");
            service = createService(db, [restricted], testConfig(), { approveGrant: () => ({ lifetimeMs: -1 }) });
            fastify = Fastify();
            await fastify.register(routes, { prefix: "/v1", service });
            await fastify.ready();

            const response = await fastify.inject({ method: "POST", url: "/v1/grants/request", payload: grantRequest(null) });
            expect(response.statusCode).toBe(500);
            expect(response.json()).toEqual({ error: "Internal server error" });
        });

        test("rejects a request with missing fields or no capabilities", async () => {
            const { capabilities: _, ...withoutCapabilities } = grantRequest(null);
            expect((await fastify.inject({ method: "POST", url: "/v1/grants/request", payload: withoutCapabilities })).statusCode).toBe(400);
            expect((await fastify.inject({ method: "POST", url: "/v1/grants/request", payload: { ...grantRequest(null), capabilities: [] } })).statusCode).toBe(400);
        });
    });

    test("runs with a valid authorization and refuses it a second time", async () => {
        const body = { ...call("open"), authorization: callerGrants.authorize(grant, call("open")) };

        const first = await runResource(body);
        expect(first.statusCode).toBe(200);
        expect(first.json()).toEqual({ value: 7, error: null });

        const replay = await runResource(body);
        expect(replay.statusCode).toBe(403);
        expect(replay.json()).toEqual({ error: "Invalid authorization" });
    });

    test("refuses an authorization signed for another call", async () => {
        const response = await runResource({ ...call("open"), parameters: [{ name: "city", value: "Paris" }], authorization: callerGrants.authorize(grant, call("open")) });

        expect(response.statusCode).toBe(403);
    });

    test("refuses duplicate or undeclared parameters before checking the grant", async () => {
        const constrained = await service.grantService.issue(caller.publicKey, [{ resourcePath: "com.example", resourceName: "Vault", constraints: { city: "Oslo" } }], { lifetimeMs: 3_600_000 });
        for (const extra of [[{ name: "city", value: "Oslo" }, { name: "city", value: "Paris" }], [{ name: "other", value: 1 }, { name: "city", value: "Oslo" }]]) {
            const smuggled = { ...call("open"), parameters: extra };
            const response = await runResource({ ...smuggled, authorization: callerGrants.authorize(constrained, smuggled) });
            expect(response.statusCode).toBe(400);
        }
    });

    test("refuses a malformed authorization", async () => {
        const response = await runResource({ ...call("open"), authorization: { grants: "none" } });

        expect(response.statusCode).toBe(403);
    });

    test("checks the authorization before the voucher, and needs both for a paid function", async () => {
        const paymentVoucher = callerInvoker.createPaymentVoucher(RECIPIENT, COST, "com.example", "Vault", "premium", parameters);
        const unauthorized = await runResource({ ...call("premium"), paymentVoucher });
        expect(unauthorized.statusCode).toBe(403);
        await new Promise((resolve) => setTimeout(resolve, 10));
        expect(service.operatorClient.settlePayment).not.toHaveBeenCalled();

        const unpaid = await runResource({ ...call("premium"), authorization: callerGrants.authorize(grant, call("premium")) });
        expect(unpaid.statusCode).toBe(402);

        const paid = await runResource({ ...call("premium"), paymentVoucher, authorization: callerGrants.authorize(grant, call("premium")) });
        expect(paid.statusCode).toBe(200);
        expect(paid.json()).toEqual({ value: 9, error: null });
    });

    describe("admin routes", () => {
        const admin = (method: "GET" | "PUT" | "DELETE", url: string, payload?: Record<string, unknown>, token = "secret") =>
            fastify.inject({ method, url, payload, headers: { authorization: `Bearer ${token}` } });

        test.each([
            ["PUT", "/v1/admin/revoked-grants/some-id"],
            ["GET", "/v1/admin/blocked-callers"],
            ["PUT", `/v1/admin/blocked-callers/${caller.publicKey}`],
            ["DELETE", `/v1/admin/blocked-callers/${caller.publicKey}`],
        ] as const)("%s %s requires the API key", async (method, url) => {
            expect((await fastify.inject({ method, url })).statusCode).toBe(401);
            expect((await admin(method, url, undefined, "wrong")).statusCode).toBe(401);
        });

        test("revoking a grant refuses calls made with it", async () => {
            const response = await admin("PUT", `/v1/admin/revoked-grants/${grant[0].id}`);
            expect(response.json()).toEqual({ success: true });

            const run = await runResource({ ...call("open"), authorization: callerGrants.authorize(grant, call("open")) });
            expect(run.statusCode).toBe(403);
        });

        test("?issuer= revokes another issuer's grant, leaving this node's grant with the same id alone", async () => {
            expect((await admin("PUT", `/v1/admin/revoked-grants/${grant[0].id}?issuer=${caller.publicKey}`)).json()).toEqual({ success: true });
            expect((await runResource({ ...call("open"), authorization: callerGrants.authorize(grant, call("open")) })).statusCode).toBe(200);
        });

        test("blocking a caller refuses its calls until it is unblocked", async () => {
            expect((await admin("PUT", `/v1/admin/blocked-callers/${caller.publicKey}`, { reason: "abuse" })).json()).toEqual({ success: true });
            expect((await runResource({ ...call("open"), authorization: callerGrants.authorize(grant, call("open")) })).statusCode).toBe(403);

            const listed = await admin("GET", "/v1/admin/blocked-callers");
            expect(listed.json()).toEqual({ callers: [{ publicKey: caller.publicKey, reason: "abuse", blockedAt: expect.any(String) }], nextOffset: null });

            expect((await admin("DELETE", `/v1/admin/blocked-callers/${caller.publicKey}`)).json()).toEqual({ success: true });
            expect((await admin("DELETE", `/v1/admin/blocked-callers/${caller.publicKey}`)).statusCode).toBe(404);
            expect((await runResource({ ...call("open"), authorization: callerGrants.authorize(grant, call("open")) })).statusCode).toBe(200);
        });

        test("blocks without a body, and refuses a bad key or reason", async () => {
            expect((await admin("PUT", `/v1/admin/blocked-callers/${caller.publicKey}`)).statusCode).toBe(200);
            expect((await admin("PUT", "/v1/admin/blocked-callers/not-a-key")).json()).toEqual({ error: "Invalid public key" });
            expect((await admin("PUT", `/v1/admin/blocked-callers/${caller.publicKey}`, { reason: 5 })).json()).toEqual({ error: "reason must be a string" });
        });
    });

    describe("POST /v1/grants/renew", () => {
        function renewalRequest(grantId: string, keys = caller) {
            const unsigned = { grantId, publicKey: keys.publicKey, nonce: crypto.randomUUID(), expiresAt: inMinutes(1) };
            return { ...unsigned, signature: signData(grantRenewalPayload(unsigned), keys.privateKey) };
        }

        test("returns a fresh copy of the grant to its audience", async () => {
            const response = await fastify.inject({ method: "POST", url: "/v1/grants/renew", payload: renewalRequest(grant[0].id) });

            expect(response.statusCode).toBe(200);
            const { grants } = response.json() as { grants: Grant[] };
            expect(grants).toHaveLength(1);
            expect(grants[0]).toMatchObject({ id: grant[0].id, audience: caller.publicKey, capabilities: grant[0].capabilities });
        });

        test("refuses another key, an unknown grant and a revoked grant", async () => {
            const renew = (payload: unknown) => fastify.inject({ method: "POST", url: "/v1/grants/renew", payload: payload as Record<string, unknown> });

            expect((await renew(renewalRequest(grant[0].id, generateBase64KeyPair()))).statusCode).toBe(403);
            expect((await renew(renewalRequest("unknown"))).statusCode).toBe(403);
            await service.grantService.revoke(grant[0].id);
            expect((await renew(renewalRequest(grant[0].id))).statusCode).toBe(403);
        });

        test("rejects a body with missing fields", async () => {
            const response = await fastify.inject({ method: "POST", url: "/v1/grants/renew", payload: { grantId: grant[0].id } });

            expect(response.statusCode).toBe(400);
        });
    });
});

describe("inference functions", () => {
    const weather = weatherResource();
    const model = modelResource();
    const caller = generateBase64KeyPair();
    const callerInvoker = new CombinationResourceInvoker(undefined as never, 100_000, caller.publicKey, caller.privateKey);
    // "Hello world!" is 3 input tokens by the fixture's estimator. 3 at $3/M plus 1,000 at $15/M, rounded up.
    const parameters = [{ name: "prompt", value: "Hello world!" }, { name: "maxTokens", value: 1000 }];
    const MAX_AMOUNT = 15_009;
    const manifest = { ...INFERENCE_RATES, recipientAddress: RECIPIENT };

    let db: Database;
    let service: Service;
    let fastify: FastifyInstance;
    let settlePayment: ReturnType<typeof vi.spyOn>;

    beforeEach(async () => {
        db = await openDatabase(":memory:");
        service = createService(db, [weather, model], testConfig());
        settlePayment = vi.spyOn(service.operatorClient, "settlePayment").mockResolvedValue(undefined);
        fastify = Fastify();
        await fastify.register(routes, { prefix: "/v1", service });
        await fastify.ready();
    });

    afterEach(async () => {
        await fastify.close();
        await db.close();
        vi.restoreAllMocks();
    });

    const flushSettlement = () => new Promise((resolve) => setTimeout(resolve, 10));

    function voucherFor(functionName = "complete", overrides: Partial<Omit<InferencePaymentVoucher, "signature">> = {}): InferencePaymentVoucher {
        const voucher = callerInvoker.createInferenceVoucher(manifest, MAX_AMOUNT, 1000, model.path, model.name, functionName, parameters);
        const resigned = { ...voucher, ...overrides };
        return { ...resigned, signature: signData(inferenceVoucherPayload(resigned), caller.privateKey) };
    }

    function call(url: string, body: Record<string, unknown> = {}) {
        return fastify.inject({
            method: "POST",
            url,
            payload: { resourcePath: model.path, resourceName: model.name, functionName: "complete", parameters, ...body },
        });
    }

    describe("POST /v1/run/resource/estimate", () => {
        test("returns the estimator's input tokens and the maxAmount they imply", async () => {
            const response = await call("/v1/run/resource/estimate");

            expect(response.statusCode).toBe(200);
            expect(response.json()).toEqual({ inputTokens: 3, maxAmount: MAX_AMOUNT });
        });

        test.each([
            ["a free inference function", { functionName: "draft" }],
            ["a fixed function", { resourceName: weather.name, functionName: "temperature", parameters: [{ name: "city", value: "Oslo" }] }],
        ])("refuses %s", async (_, body) => {
            const response = await call("/v1/run/resource/estimate", body);

            expect(response.statusCode).toBe(400);
            expect(response.json()).toEqual({ error: "Function is not a paid inference function" });
        });

        test("refuses a call without a positive maxTokens", async () => {
            const response = await call("/v1/run/resource/estimate", { parameters: [{ name: "prompt", value: "Hi" }, { name: "maxTokens", value: 0 }] });

            expect(response.statusCode).toBe(400);
        });

        test("requires authorization for a restricted function, before running the estimator", async () => {
            const estimator = vi.spyOn(model.functions[1]!, "estimateInputTokens");

            const response = await call("/v1/run/resource/estimate", { functionName: "completePrivate" });

            expect(response.statusCode).toBe(403);
            expect(estimator).not.toHaveBeenCalled();
        });

        test("answers 500 when the estimator throws", async () => {
            vi.spyOn(model.functions[0]!, "estimateInputTokens").mockRejectedValue(new Error("token counter is down"));

            const response = await call("/v1/run/resource/estimate");

            expect(response.statusCode).toBe(500);
        });
    });

    describe("POST /v1/run/resource", () => {
        test("runs with a voucher covering the estimate and settles the reported usage", async () => {
            const paymentVoucher = voucherFor();
            const response = await call("/v1/run/resource", { paymentVoucher });

            expect(response.statusCode).toBe(200);
            expect(response.json()).toEqual({ value: "echo: Hello world!", error: null, usage: { inputTokens: 3, outputTokens: 1000 } });
            await flushSettlement();
            expect(settlePayment).toHaveBeenCalledExactlyOnceWith({ voucher: paymentVoucher, usage: { inputTokens: 3, outputTokens: 1000 } });
        });

        test("refuses a voucher below the estimator's requirement without running inference", async () => {
            const exec = vi.spyOn(model.functions[0]!, "exec");

            const response = await call("/v1/run/resource", { paymentVoucher: voucherFor("complete", { maxAmount: MAX_AMOUNT - 1 }) });

            expect(response.statusCode).toBe(402);
            expect(response.json()).toMatchObject({ requiredMaxAmount: MAX_AMOUNT });
            expect(exec).not.toHaveBeenCalled();
            await flushSettlement();
            expect(settlePayment).not.toHaveBeenCalled();
        });

        test.each([
            ["a different input rate", { inputCostMicroUsdcPerMillionTokens: 1 }],
            ["a different output rate", { outputCostMicroUsdcPerMillionTokens: 1 }],
            ["a maxTokens other than the call's", { maxTokens: 999 }],
            ["a different recipient", { recipientAddress: "11111111111111111111111111111111" }],
        ])("rejects a voucher with %s", async (_, overrides) => {
            const response = await call("/v1/run/resource", { paymentVoucher: voucherFor("complete", overrides) });

            expect(response.statusCode).toBe(400);
            expect(response.json()).toEqual({ error: "Invalid payment voucher" });
        });

        test("rejects a fixed voucher for an inference function, and an inference voucher for a fixed function", async () => {
            const fixed = callerInvoker.createPaymentVoucher(RECIPIENT, MAX_AMOUNT, model.path, model.name, "complete", parameters);
            expect((await call("/v1/run/resource", { paymentVoucher: fixed })).statusCode).toBe(400);

            const weatherParameters = [{ name: "city", value: "Oslo" }];
            const inference = callerInvoker.createInferenceVoucher(manifest, MAX_AMOUNT, 1000, weather.path, weather.name, "temperature", weatherParameters);
            const response = await call("/v1/run/resource", { resourceName: weather.name, functionName: "temperature", parameters: weatherParameters, paymentVoucher: inference });
            expect(response.statusCode).toBe(400);
        });

        test("caps reported output at maxTokens", async () => {
            vi.spyOn(model.functions[0]!, "exec").mockResolvedValue({ value: "long", usage: { inputTokens: 3, outputTokens: 5000 } });
            const paymentVoucher = voucherFor();

            const response = await call("/v1/run/resource", { paymentVoucher });

            expect(response.json().usage).toEqual({ inputTokens: 3, outputTokens: 1000 });
            await flushSettlement();
            expect(settlePayment).toHaveBeenCalledExactlyOnceWith({ voucher: paymentVoucher, usage: { inputTokens: 3, outputTokens: 1000 } });
        });

        test("does not settle a call that charges nothing", async () => {
            vi.spyOn(model.functions[0]!, "exec").mockResolvedValue({ value: "", usage: { inputTokens: 0, outputTokens: 0 } });

            const response = await call("/v1/run/resource", { paymentVoucher: voucherFor() });

            expect(response.statusCode).toBe(200);
            await flushSettlement();
            expect(settlePayment).not.toHaveBeenCalled();
        });

        test("does not settle when the function doesn't report usage", async () => {
            vi.spyOn(model.functions[0]!, "exec").mockResolvedValue("no usage");

            const response = await call("/v1/run/resource", { paymentVoucher: voucherFor() });

            expect(response.json().error.message).toContain("must return { value, usage");
            await flushSettlement();
            expect(settlePayment).not.toHaveBeenCalled();
        });
    });

    test("GET /v1/resources announces the kind and per-token pricing", async () => {
        const response = await fastify.inject({ method: "GET", url: "/v1/resources" });

        const functions = response.json().resources.find((resource: { name: string }) => resource.name === "Model").functions;
        expect(functions[0]).toMatchObject({ name: "complete", kind: "inference", paymentManifest: manifest });
        expect(functions[2]).toMatchObject({ name: "draft", kind: "inference" });
        expect(functions[2].paymentManifest).toBeUndefined();
        const temperature = response.json().resources.find((resource: { name: string }) => resource.name === "Weather").functions[0];
        expect(temperature.kind).toBeUndefined();
    });
});
