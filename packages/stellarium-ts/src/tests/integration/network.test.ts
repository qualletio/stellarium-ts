import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { verifyData } from "../../crypto/utils.js";
import { type PaymentVoucher, paymentVoucherPayload } from "../../resource/invoker.js";
import { StellariumNode, type StellariumNodeOptions } from "../../server.js";
import type { StellariumResource } from "../../resource/repository.js";
import { COST, generateBase64KeyPair, RECIPIENT, temperatureSource, weatherResource } from "../helpers.js";

/** A free function only callers with a grant from the provider may run. */
function vaultResource(baseUrl: string): StellariumResource {
    return {
        id: 2,
        baseUrl,
        metadata: {},
        path: "com.example",
        name: "Vault",
        functions: [{ name: "open", parameters: [{ name: "city", type: "string" }], returnType: "int32", exec: async () => 7, restricted: true }],
    };
}

const vaultSource = 'request OpenVault {\n  const vault: com.example.Vault\n\n  return vault.open(city: "Oslo")\n}';
const vault = { resourcePath: "com.example", resourceName: "Vault" };
const HOUR = 3_600_000;

function freePort(): Promise<number> {
    return new Promise((resolve, reject) => {
        const server = createServer();
        server.once("error", reject);
        server.listen(0, "127.0.0.1", () => {
            const { port } = server.address() as { port: number };
            server.close(() => resolve(port));
        });
    });
}

/**
 * A provider node hosting the paid weather resource, a caller node that bootstraps from it,
 * and a fake operator that records settlements. Everything runs in-process over real HTTP.
 */
describe("two-node network", () => {
    const servers: FastifyInstance[] = [];
    const settlements: PaymentVoucher[] = [];
    const callerKeys = generateBase64KeyPair();
    let dir: string;
    let operatorUrl: string;
    let providerUrl: string;
    let provider: StellariumNode;

    async function startNode(node: StellariumNode, options: StellariumNodeOptions & { port: number }) {
        const fastify = Fastify();
        servers.push(fastify);
        await node.start(fastify, { host: "127.0.0.1", baseUrl: `http://127.0.0.1:${options.port}`, ...options });
        return fastify;
    }

    async function startCaller(options: Partial<StellariumNodeOptions> = {}) {
        const port = await freePort();
        const node = new StellariumNode();
        const fastify = await startNode(node, {
            port,
            startingPeer: providerUrl,
            ...callerKeys,
            apiKey: "caller-key",
            databasePath: path.join(dir, "caller.db"),
            ...options,
        });
        return { node, fastify, url: `http://127.0.0.1:${port}` };
    }

    const run = (url: string, source = temperatureSource) => fetch(`${url}/v1/run`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer caller-key" },
        body: JSON.stringify({ source }),
    }).then(response => response.json() as Promise<any>);

    const getJson = (url: string) => fetch(url).then(response => response.json() as Promise<any>);

    beforeEach(async () => {
        dir = await mkdtemp(path.join(tmpdir(), "stellarium-network-"));
        settlements.length = 0;

        const operator = Fastify();
        servers.push(operator);
        operator.post("/v1/payment", async (request) => {
            settlements.push((request.body as { voucher: PaymentVoucher }).voucher);
            return { status: "confirmed" };
        });
        operatorUrl = `${await operator.listen({ port: 0, host: "127.0.0.1" })}/v1`;

        const providerPort = await freePort();
        providerUrl = `http://127.0.0.1:${providerPort}`;
        provider = new StellariumNode();
        await provider.register(weatherResource(providerUrl));
        await provider.register(vaultResource(providerUrl));
        await startNode(provider, {
            port: providerPort,
            ...generateBase64KeyPair(),
            operatorUrl,
            databasePath: ":memory:",
            apiKey: "provider-admin",
            approveGrant: ({ details }) => details?.invite === "letmein" ? { lifetimeMs: HOUR } : undefined,
        });
    });

    afterEach(async () => {
        await Promise.all(servers.splice(0).map(server => server.close()));
        await rm(dir, { recursive: true, force: true });
    });

    test("the caller discovers the provider, pays for a call and the provider settles it", async () => {
        const caller = await startCaller();

        // The provider learned about the caller from its signed announcement.
        const providerPeers = await getJson(`${providerUrl}/v1/peers`);
        expect(providerPeers.peers).toEqual([{ baseUrl: caller.url, name: caller.url, publicKey: callerKeys.publicKey }]);

        const callerResources = await getJson(`${caller.url}/v1/resources`);
        expect(callerResources.resources).toContainEqual(expect.objectContaining({
            name: "Weather",
            baseUrl: providerUrl,
            functions: expect.arrayContaining([expect.objectContaining({ name: "temperature", paymentManifest: { costMicroUsdc: COST, recipientAddress: RECIPIENT } })]),
        }));

        expect(await run(caller.url)).toEqual({ returnValue: { value: 12, error: null } });

        await vi.waitFor(() => expect(settlements).toHaveLength(1));
        const [voucher] = settlements;
        expect(voucher).toMatchObject({ amount: COST, recipientAddress: RECIPIENT, publicKey: callerKeys.publicKey });
        expect(verifyData(paymentVoucherPayload(voucher), voucher.publicKey, voucher.signature)).toBe(true);
    });

    test("the caller restarts on the same database without failing", async () => {
        const first = await startCaller();
        await first.fastify.close();

        const second = await startCaller();

        expect(await run(second.url)).toEqual({ returnValue: { value: 12, error: null } });
    });

    describe("restricted functions", () => {
        test("the caller needs a grant from the provider, then calls with it", async () => {
            const caller = await startCaller();

            const refused = await run(caller.url, vaultSource);
            expect(refused.returnValue.error.message).toContain(`requires a grant from ${providerUrl}`);

            await caller.node.addGrant(await provider.issueGrant(callerKeys.publicKey, [vault], { lifetimeMs: HOUR }));

            expect(await run(caller.url, vaultSource)).toEqual({ returnValue: { value: 7, error: null } });
        });

        test("the caller asks the provider for a grant, then calls with it", async () => {
            const caller = await startCaller();

            await expect(caller.node.requestGrant(providerUrl, [vault], { invite: "wrong" })).rejects.toThrow("Grant request refused");
            await caller.node.requestGrant(providerUrl, [vault], { invite: "letmein" });

            expect(await run(caller.url, vaultSource)).toEqual({ returnValue: { value: 7, error: null } });
        });

        test("the provider's admin blocks a caller over HTTP, then unblocks it", async () => {
            const caller = await startCaller();
            await caller.node.requestGrant(providerUrl, [vault], { invite: "letmein" });
            const adminRequest = (method: string) => fetch(`${providerUrl}/v1/admin/blocked-callers/${callerKeys.publicKey}`, {
                method,
                // Fastify refuses a JSON content type with an empty body, so the DELETE sends neither.
                headers: method === "PUT" ? { "Content-Type": "application/json", Authorization: "Bearer provider-admin" } : { Authorization: "Bearer provider-admin" },
                body: method === "PUT" ? JSON.stringify({ reason: "abuse" }) : undefined,
            });

            expect((await adminRequest("PUT")).status).toBe(200);
            const refused = await run(caller.url, vaultSource);
            expect(refused.returnValue.error.message).toContain("Invalid authorization");
            await expect(caller.node.requestGrant(providerUrl, [vault], { invite: "letmein" })).rejects.toThrow("refused");

            expect((await adminRequest("DELETE")).status).toBe(200);
            expect(await run(caller.url, vaultSource)).toEqual({ returnValue: { value: 7, error: null } });
        });

        test("grants passed at start are loaded, and revocation at the provider cuts them off", async () => {
            const chain = await provider.issueGrant(callerKeys.publicKey, [vault], { lifetimeMs: HOUR });
            const caller = await startCaller({ grants: [chain] });
            expect(await run(caller.url, vaultSource)).toEqual({ returnValue: { value: 7, error: null } });

            await provider.revokeGrant(chain[0].id);

            const refused = await run(caller.url, vaultSource);
            expect(refused.returnValue.error.message).toContain("Invalid authorization");
        });

        test("a third node calls through a grant the caller delegated to it", async () => {
            const caller = await startCaller();
            const [root] = await provider.issueGrant(callerKeys.publicKey, [{ resourcePath: "com.example.*" }], { lifetimeMs: HOUR });
            await caller.node.addGrant([root]);

            const userKeys = generateBase64KeyPair();
            const user = await startCaller({ ...userKeys, databasePath: path.join(dir, "user.db") });
            await user.node.addGrant(await caller.node.delegateGrant(root.id, userKeys.publicKey, [vault], { lifetimeMs: HOUR }));

            expect(await run(user.url, vaultSource)).toEqual({ returnValue: { value: 7, error: null } });
        });

        test("the refresher renews a grant past half its lifetime", async () => {
            const fetchSpy = vi.spyOn(globalThis, "fetch");
            const chain = await provider.issueGrant(callerKeys.publicKey, [vault], { lifetimeMs: 400 });
            const caller = await startCaller({ grants: [chain], grantRefreshIntervalMs: 50 });

            await vi.waitFor(() => expect(fetchSpy.mock.calls.some(([url]) => String(url) === `${providerUrl}/v1/grants/renew`)).toBe(true), { timeout: 2000 });
            fetchSpy.mockRestore();

            // Well past the first copy's expiry, the renewed one still works.
            await new Promise((resolve) => setTimeout(resolve, 500));
            expect(await run(caller.url, vaultSource)).toEqual({ returnValue: { value: 7, error: null } });
        });
    });

    test("the caller refuses a call that costs more than its limit", async () => {
        const caller = await startCaller({ costLimitMicroUsdc: COST - 1 });

        const result = await run(caller.url);

        expect(result.returnValue.value).toBeNull();
        expect(result.returnValue.error.message).toContain("exceeds the cost limit");
        expect(settlements).toEqual([]);
    });
});
