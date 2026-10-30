import { generateKeyPairSync } from "node:crypto";
import Fastify, { type FastifyInstance } from "fastify";
import { createLocalJWKSet, exportJWK, SignJWT } from "jose";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { NodeDatabase } from "../../db/database.js";
import { CombinationResourceInvoker, type ContractPaymentVoucher, MAX_CONTRACT_DEPTH } from "../../resource/invoker.js";
import type { StellariumResource } from "../../resource/repository.js";
import routes from "../../routes.js";
import { createService, type NodeConfig, type Service } from "../../service.js";
import { DIALECTS, generateBase64KeyPair, ORGANIZATION, openTestDatabase, testConfig, weatherResource } from "../helpers.js";

/** 1 micro-USD a token. */
const PRICE = 1_000_000;
const FEE = 5_000;
const SUM = "contract com.example.Sum(a: int32, b: int32): int32 {\n  return a + b\n}";
const sumParameters = [{ name: "a", value: 2 }, { name: "b", value: 3 }];

describe.each(DIALECTS)("contracts (%s)", (dialect) => {
    const operatorKeys = generateKeyPairSync("ed25519");
    const caller = generateBase64KeyPair();
    // Signs vouchers as another node would.
    const callerInvoker = new CombinationResourceInvoker(undefined as never, 100_000, caller.publicKey, caller.privateKey);

    let db: NodeDatabase;
    let config: NodeConfig;
    let service: Service;
    let fastify: FastifyInstance;
    let spies: Record<"authorizeRun" | "captureRun" | "releaseRun" | "authorize" | "capture" | "release" | "authorizeContractRun", ReturnType<typeof vi.spyOn>>;

    beforeEach(async () => {
        db = await openTestDatabase(dialect);
        config = testConfig({ priceMicroUsdPerMillionTokens: PRICE, contractDeployFeeMicroUsd: FEE });
        const jwk = await exportJWK(operatorKeys.publicKey);
        service = createService(db, [weatherResource()], config, { runTokenKeys: createLocalJWKSet({ keys: [{ ...jwk, alg: "EdDSA" }] }) });
        const client = service.operatorClient;
        spies = {
            authorizeRun: vi.spyOn(client, "authorizeRun").mockResolvedValue({ ok: true, heldMicroUsd: 50_000, maxTokens: 0 }),
            captureRun: vi.spyOn(client, "captureRun").mockResolvedValue(undefined),
            releaseRun: vi.spyOn(client, "releaseRun").mockResolvedValue(undefined),
            authorize: vi.spyOn(client, "authorize").mockResolvedValue({ ok: true }),
            capture: vi.spyOn(client, "capture").mockResolvedValue(undefined),
            release: vi.spyOn(client, "release").mockResolvedValue(undefined),
            authorizeContractRun: vi.spyOn(client, "authorizeContractRun").mockResolvedValue({ ok: true, free: false }),
        };
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

    /** A token the operator would issue to `organizationId`'s client on this node. */
    const runToken = (organizationId: string) => new SignJWT({ org: organizationId })
        .setProtectedHeader({ alg: "EdDSA" })
        .setIssuer("stellarium")
        .setSubject("cli_test")
        .setAudience(config.publicKey)
        .setIssuedAt()
        .setExpirationTime("15m")
        .sign(operatorKeys.privateKey);

    const deploy = (source: string, token = "secret", description?: string) => fastify.inject({
        method: "POST", url: "/v1/contracts", headers: { authorization: `Bearer ${token}` }, payload: { source, description },
    });

    const run = (source: string, token = "secret") => fastify.inject({
        method: "POST", url: "/v1/run", headers: { authorization: `Bearer ${token}` }, payload: { source },
    });

    const callFromPeer = (paymentVoucher?: ContractPaymentVoucher, contractDepth?: number, parameters = sumParameters) => fastify.inject({
        method: "POST",
        url: "/v1/run/resource",
        payload: { resourcePath: "com.example", resourceName: "Sum", functionName: "run", parameters, paymentVoucher, contractDepth },
    });

    const sumVoucher = (price = PRICE, parameters = sumParameters) =>
        callerInvoker.createContractVoucher(ORGANIZATION, price, 50_000, "com.example", "Sum", "run", parameters);

    describe("POST /v1/contracts", () => {
        test("deploys a contract as a resource with one function, run, at the node's price", async () => {
            const response = await deploy(SUM, "secret", "Adds two numbers");

            expect(response.statusCode).toBe(201);
            expect(response.json()).toEqual({ path: "com.example", name: "Sum", version: "1", feeMicroUsd: 0 });
            const resources = (await fastify.inject({ method: "GET", url: "/v1/resources" })).json().resources as StellariumResource[];
            expect(resources.map(r => r.name)).toEqual(["Weather", "Sum"]);
            expect(resources[1]).toMatchObject({
                path: "com.example",
                description: "Adds two numbers",
                functions: [{
                    name: "run",
                    kind: "contract",
                    returnType: "int32",
                    parameters: [{ name: "a", type: "int32" }, { name: "b", type: "int32" }],
                    paymentManifest: { priceMicroUsdPerMillionTokens: PRICE, recipientOrganizationId: ORGANIZATION },
                }],
            });
            const contracts = (await fastify.inject({ method: "GET", url: "/v1/contracts" })).json();
            expect(contracts).toMatchObject({ contracts: [{ path: "com.example", name: "Sum", version: "1", source: SUM, ownerOrganizationId: null }], nextOffset: null });
            expect(spies.authorizeRun).not.toHaveBeenCalled();
        });

        test.each([
            ["a request script", "request R {\n  return 1\n}", 400, "not a request"],
            ["a contract without a return type", "contract com.example.Sum(a: int32) {\n  return a\n}", 400, "return type"],
            ["a contract without a path", "contract Sum(a: int32): int32 {\n  return a\n}", 400, "path"],
            ["a script that doesn't parse", "contract com.example.Sum(: int32 {", 400, "Invalid contract"],
            ["a registered resource's name", "contract com.example.Weather: int32 {\n  return 1\n}", 409, "already a resource"],
        ])("refuses %s", async (_, source, status, error) => {
            const response = await deploy(source);

            expect(response.statusCode).toBe(status);
            expect(response.json().error).toContain(error);
        });

        test("refuses an existing version, and a source over the size limit", async () => {
            await deploy(SUM);
            expect((await deploy(SUM)).statusCode).toBe(409);

            config.maxContractSourceBytes = 10;
            expect((await deploy(SUM.replace("Sum", "Other"))).statusCode).toBe(413);
        });

        test("requires the API key or a run token", async () => {
            expect((await fastify.inject({ method: "POST", url: "/v1/contracts", payload: { source: SUM } })).statusCode).toBe(401);
            expect((await deploy(SUM, "wrong")).statusCode).toBe(401);
        });

        test("charges another organization the deploy fee from its run, and makes it the owner", async () => {
            const response = await deploy(SUM, await runToken("org_caller"));

            expect(response.statusCode).toBe(201);
            expect(response.json()).toMatchObject({ feeMicroUsd: FEE });
            const [{ runId, source }] = spies.authorizeRun.mock.calls[0]!;
            expect(source).toBe(SUM);
            const [voucher] = spies.authorize.mock.calls[0]!;
            expect(voucher).toMatchObject({ amount: FEE, recipientOrganizationId: ORGANIZATION, runId });
            await flushSettlement();
            expect(spies.capture).toHaveBeenCalledWith({ voucher });
            expect(spies.captureRun).toHaveBeenCalledWith({ runId, tokens: 0 });
            expect((await service.contractRepository.latest("com.example", "Sum"))?.ownerOrganizationId).toBe("org_caller");
        });

        test("doesn't charge for a deploy it refuses", async () => {
            await deploy(SUM);

            expect((await deploy(SUM, await runToken("org_caller"))).statusCode).toBe(409);
            expect(spies.authorizeRun).not.toHaveBeenCalled();
        });

        test("answers the operator's refusal of the deploy fee, and saves nothing", async () => {
            spies.authorizeRun.mockResolvedValue({ ok: false, status: 402, error: "Insufficient balance" });

            const response = await deploy(SUM, await runToken("org_caller"));

            expect(response.statusCode).toBe(402);
            expect(await service.contractRepository.latest("com.example", "Sum")).toBeUndefined();
        });

        test("is free for the node's own organization", async () => {
            const response = await deploy(SUM, await runToken(ORGANIZATION));

            expect(response.json()).toMatchObject({ feeMicroUsd: 0 });
            expect(spies.authorizeRun).not.toHaveBeenCalled();
        });

        test("only the owner adds versions", async () => {
            await deploy(SUM, await runToken("org_caller"));
            const next = SUM.replace("Sum(", "Sum@2(");

            expect((await deploy(next, await runToken("org_other"))).statusCode).toBe(409);
            expect((await deploy(next, await runToken("org_caller"))).statusCode).toBe(201);
            expect((await service.contractRepository.latest("com.example", "Sum"))?.version).toBe("2");
        });
    });

    describe("DELETE /v1/contracts/:ref", () => {
        const remove = (ref: string, token = "secret") => fastify.inject({ method: "DELETE", url: `/v1/contracts/${ref}`, headers: { authorization: `Bearer ${token}` } });

        test("lets the owner or the admin delete, and no one else", async () => {
            await deploy(SUM, await runToken("org_caller"));
            await deploy(SUM.replace("Sum(", "Sum@2("), await runToken("org_caller"));

            expect((await remove("com.example.Sum@2", await runToken("org_other"))).statusCode).toBe(403);
            expect((await remove("com.example.Sum@2", await runToken("org_caller"))).statusCode).toBe(200);
            expect((await service.contractRepository.latest("com.example", "Sum"))?.version).toBe("1");
            expect((await remove("com.example.Sum")).statusCode).toBe(200);
            expect((await remove("com.example.Sum")).statusCode).toBe(404);
            const resources = (await fastify.inject({ method: "GET", url: "/v1/resources" })).json().resources as StellariumResource[];
            expect(resources.map(r => r.name)).toEqual(["Weather"]);
        });

        test("refuses a reference that isn't path.Name", async () => {
            expect((await remove("Sum")).statusCode).toBe(400);
        });
    });

    describe("calling a contract on this node", () => {
        test("from an API-key run is free, and the contract sees no jwt", async () => {
            await deploy("contract com.example.Who: string {\n  if (jwt == null) {\n    return \"admin\"\n  }\n  return jwt.org\n}");
            await deploy(SUM);

            const response = await run("request R {\n  const sum: com.example.Sum\n  const who: com.example.Who\n  return { sum: sum.run(a: 1, b: 2).value, who: who.run().value }\n}");

            expect(response.json()).toMatchObject({ returnValue: { sum: 3, who: "admin" } });
            expect(spies.authorizeContractRun).not.toHaveBeenCalled();
        });

        test("from a billed run is held from the run, and the contract sees the run's jwt", async () => {
            await deploy("contract com.example.Who: string {\n  return jwt.org\n}");

            const response = await run("request R {\n  const who: com.example.Who\n  return who.run().value\n}", await runToken("org_caller"));

            expect(response.json()).toMatchObject({ returnValue: "org_caller" });
            const [outer] = spies.authorizeRun.mock.calls[0]!;
            const [{ voucher }] = spies.authorizeContractRun.mock.calls[0]!;
            expect(voucher).toMatchObject({ kind: "contract", runId: outer.runId, recipientOrganizationId: ORGANIZATION, priceMicroUsdPerMillionTokens: PRICE });
            await flushSettlement();
            expect(spies.captureRun).toHaveBeenCalledWith({ runId: voucher.invocationId, tokens: expect.any(Number) });
            expect(spies.captureRun).toHaveBeenCalledWith({ runId: outer.runId, tokens: expect.any(Number) });
        });

        test(`stops contracts calling each other ${MAX_CONTRACT_DEPTH} deep`, async () => {
            await deploy("contract com.example.Loop(n: int32): int32 {\n  const loop: com.example.Loop\n  const next = loop.run(n: n + 1)\n  if (next.error != null) {\n    return n\n  }\n  return next.value\n}");

            const response = await run("request R {\n  const loop: com.example.Loop\n  return loop.run(n: 1).value\n}");

            expect(response.json()).toMatchObject({ returnValue: MAX_CONTRACT_DEPTH });
        });
    });

    describe("calling a contract from another node", () => {
        beforeEach(async () => {
            await deploy(SUM);
        });

        test("authorizes a run with the voucher, runs the contract, and captures its tokens", async () => {
            const voucher = sumVoucher();

            const response = await callFromPeer(voucher);

            expect(response.statusCode).toBe(200);
            expect(response.json()).toEqual({ value: 5, error: null });
            expect(spies.authorizeContractRun).toHaveBeenCalledWith({ voucher, source: SUM });
            await flushSettlement();
            expect(spies.captureRun).toHaveBeenCalledWith({ runId: voucher.invocationId, tokens: 4 });
        });

        test("captures a contract that fails, which reports the failure as the call's error", async () => {
            await deploy("contract com.example.Div(a: int32): int32 {\n  return 1 / a\n}");
            const parameters = [{ name: "a", value: 0 }];
            const voucher = callerInvoker.createContractVoucher(ORGANIZATION, PRICE, 50_000, "com.example", "Div", "run", parameters);

            const response = await fastify.inject({
                method: "POST", url: "/v1/run/resource",
                payload: { resourcePath: "com.example", resourceName: "Div", functionName: "run", parameters, paymentVoucher: voucher },
            });

            expect(response.json()).toMatchObject({ value: null, error: { message: expect.stringContaining("com.example.Div@1 failed") } });
            await flushSettlement();
            expect(spies.captureRun).toHaveBeenCalledWith({ runId: voucher.invocationId, tokens: expect.any(Number) });
        });

        test("runs unbilled when the operator says the caller is this node's organization", async () => {
            spies.authorizeContractRun.mockResolvedValue({ ok: true, free: true });

            expect((await callFromPeer(sumVoucher())).json()).toEqual({ value: 5, error: null });
            await flushSettlement();
            expect(spies.captureRun).not.toHaveBeenCalled();
        });

        test("answers the operator's refusal without running the contract", async () => {
            spies.authorizeContractRun.mockResolvedValue({ ok: false, status: 402, error: "Insufficient balance" });

            const response = await callFromPeer(sumVoucher());

            expect(response.statusCode).toBe(402);
            expect(response.json()).toEqual({ error: "Insufficient balance" });
        });

        test.each([
            ["no voucher", () => undefined, 402],
            ["a voucher below this node's price", () => sumVoucher(PRICE - 1), 400],
            ["a voucher for other parameters", () => sumVoucher(PRICE, [{ name: "a", value: 1 }, { name: "b", value: 1 }]), 400],
            ["a tampered voucher", () => ({ ...sumVoucher(), maxAmount: 1 }), 400],
        ])("refuses %s", async (_, voucher, status) => {
            expect((await callFromPeer(voucher())).statusCode).toBe(status);
            expect(spies.authorizeContractRun).not.toHaveBeenCalled();
        });

        test(`refuses a call more than ${MAX_CONTRACT_DEPTH} contracts deep`, async () => {
            expect((await callFromPeer(sumVoucher(), MAX_CONTRACT_DEPTH + 1)).statusCode).toBe(400);
        });

        test("refuses a contract voucher for a function that isn't a contract", async () => {
            const parameters = [{ name: "city", value: "Oslo" }];
            const paymentVoucher = callerInvoker.createContractVoucher(ORGANIZATION, PRICE, 50_000, "com.example", "Weather", "temperature", parameters);

            const response = await fastify.inject({
                method: "POST", url: "/v1/run/resource",
                payload: { resourcePath: "com.example", resourceName: "Weather", functionName: "temperature", parameters, paymentVoucher },
            });

            expect(response.statusCode).toBe(400);
        });
    });
});
