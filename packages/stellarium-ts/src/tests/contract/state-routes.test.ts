import { generateKeyPairSync } from "node:crypto";
import Fastify, { type FastifyInstance } from "fastify";
import { createLocalJWKSet, exportJWK, SignJWT } from "jose";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { NodeDatabase } from "../../db/database.js";
import { CombinationResourceInvoker } from "../../resource/invoker.js";
import type { StellariumResource } from "../../resource/repository.js";
import routes from "../../routes.js";
import { createService, type NodeConfig, type Service } from "../../service.js";
import { DIALECTS, generateBase64KeyPair, ORGANIZATION, openTestDatabase, testConfig, weatherResource } from "../helpers.js";

const COUNTER = "contract com.example.Counter: int32 {\n  var state count: int32 = 0\n  count = count + 1\n  return count\n}";
const callCounter = "request R {\n  const counter: com.example.Counter\n  return counter.run().value\n}";

/** A free function that waits until the test lets it finish, to hold a call open. */
function gateResource(gate: { open: Promise<void> }): StellariumResource {
    return {
        id: 3,
        baseUrl: "http://127.0.0.1:3002",
        metadata: {},
        path: "com.example",
        name: "Gate",
        functions: [{ name: "wait", parameters: [], returnType: "int32", exec: async () => { await gate.open; return 1; } }],
    };
}

describe.each(DIALECTS)("contract state (%s)", (dialect) => {
    const operatorKeys = generateKeyPairSync("ed25519");
    const peer = generateBase64KeyPair();
    const peerInvoker = new CombinationResourceInvoker(undefined as never, 100_000, peer.publicKey, peer.privateKey);

    let db: NodeDatabase;
    let config: NodeConfig;
    let service: Service;
    let fastify: FastifyInstance;
    let authorizeContractRun: ReturnType<typeof vi.spyOn>;
    let letGateOpen: () => void;

    beforeEach(async () => {
        db = await openTestDatabase(dialect);
        config = testConfig({ priceMicroUsdPerMillionTokens: 0 });
        const gate = { open: new Promise<void>(resolve => { letGateOpen = resolve; }) };
        const jwk = await exportJWK(operatorKeys.publicKey);
        service = createService(db, [weatherResource(), gateResource(gate)], config, { runTokenKeys: createLocalJWKSet({ keys: [{ ...jwk, alg: "EdDSA" }] }) });
        const client = service.operatorClient;
        vi.spyOn(client, "authorizeRun").mockResolvedValue({ ok: true, heldMicroUsd: 50_000, maxTokens: 0 });
        vi.spyOn(client, "captureRun").mockResolvedValue(undefined);
        vi.spyOn(client, "releaseRun").mockResolvedValue(undefined);
        vi.spyOn(client, "authorize").mockResolvedValue({ ok: true });
        vi.spyOn(client, "capture").mockResolvedValue(undefined);
        authorizeContractRun = vi.spyOn(client, "authorizeContractRun").mockResolvedValue({ ok: true, free: false, payerOrganizationId: "org_peer" });
        fastify = Fastify();
        await fastify.register(routes, { prefix: "/v1", service });
        await fastify.ready();
    });

    afterEach(async () => {
        letGateOpen();
        await fastify.close();
        await db.close();
        vi.restoreAllMocks();
    });

    const runToken = (organizationId: string) => new SignJWT({ org: organizationId })
        .setProtectedHeader({ alg: "EdDSA" })
        .setIssuer("stellarium")
        .setSubject("cli_test")
        .setAudience(config.publicKey)
        .setIssuedAt()
        .setExpirationTime("15m")
        .sign(operatorKeys.privateKey);

    const deploy = async (source: string, token = "secret") => {
        const response = await fastify.inject({ method: "POST", url: "/v1/contracts", headers: { authorization: `Bearer ${token}` }, payload: { source } });
        expect(response.statusCode).toBe(201);
    };

    const run = async (source: string, token = "secret") =>
        (await fastify.inject({ method: "POST", url: "/v1/run", headers: { authorization: `Bearer ${token}` }, payload: { source } })).json();

    const readState = (ref: string, token = "secret") =>
        fastify.inject({ method: "GET", url: `/v1/contracts/${ref}/state`, headers: { authorization: `Bearer ${token}` } });

    /** A call from another node, which the operator says `org_peer` pays for unless the spy says otherwise. */
    const callFromPeer = async (resourceName: string, parameters: { name: string, value: unknown }[] = []) => {
        const paymentVoucher = peerInvoker.createContractVoucher(ORGANIZATION, 0, 50_000, "com.example", resourceName, "run", parameters);
        return (await fastify.inject({
            method: "POST", url: "/v1/run/resource",
            payload: { resourcePath: "com.example", resourceName, functionName: "run", parameters, paymentVoucher },
        })).json();
    };

    test("keeps counting across calls and new versions", async () => {
        await deploy(COUNTER);

        expect((await run(callCounter)).returnValue).toBe(1);
        expect((await run(callCounter)).returnValue).toBe(2);
        // A new version can widen the type.
        await deploy("contract com.example.Counter@2: int64 {\n  var state count: int64 = 0\n  count = count + 10\n  return count\n}");
        expect((await run(callCounter)).returnValue).toBe(12);
    });

    test("caller tells a remote caller's organization and node apart from this node's", async () => {
        await deploy("contract com.example.Who: object {\n  return caller\n}");

        expect(await callFromPeer("Who")).toEqual({ value: { org: "org_peer", node: peer.publicKey }, error: null });
        expect((await run("request R {\n  const who: com.example.Who\n  return who.run().value\n}")).returnValue).toEqual({ org: ORGANIZATION, node: config.publicKey });
        expect((await run("request R {\n  const who: com.example.Who\n  return who.run().value\n}", await runToken("org_client"))).returnValue)
            .toEqual({ org: "org_client", node: config.publicKey });
    });

    test("state(caller.org) keeps one copy per paying organization", async () => {
        await deploy("contract com.example.Visits: int32 {\n  var state(caller.org) visits: int32 = 0\n  visits = visits + 1\n  return visits\n}");

        expect((await callFromPeer("Visits")).value).toBe(1);
        expect((await callFromPeer("Visits")).value).toBe(2);
        authorizeContractRun.mockResolvedValue({ ok: true, free: false, payerOrganizationId: "org_other" });
        expect((await callFromPeer("Visits")).value).toBe(1);
        expect((await run("request R {\n  const visits: com.example.Visits\n  return visits.run().value\n}", await runToken("org_client"))).returnValue).toBe(1);

        const variables = (await readState("com.example.Visits")).json().variables;
        expect(variables.map((v: { scope: { key: string }, value: number }) => [v.scope.key, v.value])).toEqual([["org_client", 1], ["org_other", 1], ["org_peer", 2]]);
    });

    test("a call that fails saves nothing", async () => {
        await deploy("contract com.example.Fragile(d: int32): int32 {\n  var state count: int32 = 0\n  count = count + 1\n  return 1 / d\n}");

        const result = await callFromPeer("Fragile", [{ name: "d", value: 0 }]);

        expect(result.error.message).toContain("Fragile@1 failed");
        expect((await readState("com.example.Fragile")).json()).toEqual({ variables: [] });
    });

    test("concurrent calls to a shared counter all count", async () => {
        await deploy(COUNTER);

        const results = await Promise.all(Array.from({ length: 8 }, () => run(callCounter)));

        expect(results.map(result => result.returnValue).sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    });

    test("a call that re-enters its own contract saves first, and the outer call fails rather than lose it", async () => {
        await deploy("contract com.example.Again(again: boolean): int32 {\n  var state count: int32 = 0\n  const self: com.example.Again\n  if (again) {\n    const inner = self.run(again: false)\n  }\n  count = count + 1\n  return count\n}");

        const result = (await run("request R {\n  const again: com.example.Again\n  return again.run(again: true)\n}")).returnValue;

        expect(result.error.message).toContain("its state changed during the call");
        expect((await readState("com.example.Again")).json().variables).toMatchObject([{ name: "count", value: 1 }]);
    });

    test("a call waiting too long for the contract fails, and the earlier call still saves", async () => {
        await deploy("contract com.example.Slow: int32 {\n  var state count: int32 = 0\n  const gate: com.example.Gate\n  gate.wait()\n  count = count + 1\n  return count\n}");
        service.contractService.lockTimeoutMs = 50;
        const callSlow = "request R {\n  const slow: com.example.Slow\n  return slow.run()\n}";

        const first = run(callSlow);
        await new Promise(resolve => setTimeout(resolve, 20));
        const second = (await run(callSlow)).returnValue;
        letGateOpen();

        expect(second.error.message).toContain("it is busy");
        expect((await first).returnValue).toEqual({ value: 1, error: null });
    });

    test("a call that would grow its state past the cap fails and saves nothing", async () => {
        config.maxContractStateBytes = 16;
        await deploy("contract com.example.Notes(text: string): string {\n  var state note: string = \"\"\n  note = text\n  return note\n}");

        expect((await callFromPeer("Notes", [{ name: "text", value: "short" }])).value).toBe("short");
        const result = await callFromPeer("Notes", [{ name: "text", value: "a note much longer than the cap" }]);

        expect(result.error.message).toContain("more than this node's 16");
        expect((await readState("com.example.Notes")).json().variables).toMatchObject([{ value: "short" }]);
    });

    test("only the owner and the node's admin can read state", async () => {
        await deploy(COUNTER, await runToken("org_owner"));
        await run(callCounter);

        expect((await readState("com.example.Counter", await runToken("org_owner"))).json())
            .toEqual({ variables: [{ name: "count", scope: null, value: 1, updatedAt: expect.any(String) }] });
        expect((await readState("com.example.Counter")).statusCode).toBe(200);
        expect((await readState("com.example.Counter", await runToken("org_other"))).statusCode).toBe(403);
        expect((await readState("com.example.Counter@1")).statusCode).toBe(400);
        expect((await readState("com.example.Missing")).statusCode).toBe(404);
    });

    test("deleting a version keeps state, and deleting the contract deletes it", async () => {
        await deploy(COUNTER);
        await deploy(COUNTER.replace("Counter:", "Counter@2:"));
        await run(callCounter);
        const remove = (ref: string) => fastify.inject({ method: "DELETE", url: `/v1/contracts/${ref}`, headers: { authorization: "Bearer secret" } });

        await remove("com.example.Counter@2");
        expect(await service.contractStateRepository.list("com.example", "Counter")).toHaveLength(1);
        await remove("com.example.Counter");
        expect(await service.contractStateRepository.list("com.example", "Counter")).toEqual([]);
    });
});
