import Fastify, { type FastifyInstance } from "fastify";
import type { Database } from "sqlite";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { signData } from "../crypto/utils.js";
import { openDatabase } from "../db/db.js";
import { type Peer, peerAnnouncementPayload } from "../peer/repository.js";
import { CombinationResourceInvoker, type PaymentVoucher, paymentVoucherPayload } from "../resource/invoker.js";
import { resourceAnnouncementPayload, type StellariumResource } from "../resource/repository.js";
import routes from "../routes.js";
import { createService, type NodeConfig, type Service } from "../service.js";
import { COST, generateBase64KeyPair, RECIPIENT, temperatureSource, testConfig, weatherResource } from "./helpers.js";

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
                paymentManifest: { costLamports: 500, recipientAddress: RECIPIENT },
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
                functions: [{ name: "tomorrow", paymentManifest: { costLamports: 500, recipientAddress: RECIPIENT } }],
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
