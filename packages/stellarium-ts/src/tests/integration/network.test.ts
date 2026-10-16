import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { verifyData } from "../../crypto/utils.js";
import { type PaymentVoucher, paymentVoucherPayload } from "../../resource/invoker.js";
import { StellariumNode, type StellariumNodeOptions } from "../../server.js";
import { COST, generateBase64KeyPair, RECIPIENT, temperatureSource, weatherResource } from "../helpers.js";

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

    async function startNode(node: StellariumNode, options: StellariumNodeOptions & { port: number }) {
        const fastify = Fastify();
        servers.push(fastify);
        await node.start(fastify, { host: "127.0.0.1", baseUrl: `http://127.0.0.1:${options.port}`, ...options });
        return fastify;
    }

    async function startCaller(options: Partial<StellariumNodeOptions> = {}) {
        const port = await freePort();
        const fastify = await startNode(new StellariumNode(), {
            port,
            startingPeer: providerUrl,
            ...callerKeys,
            apiKey: "caller-key",
            databasePath: path.join(dir, "caller.db"),
            ...options,
        });
        return { fastify, url: `http://127.0.0.1:${port}` };
    }

    const run = (url: string) => fetch(`${url}/v1/run`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer caller-key" },
        body: JSON.stringify({ source: temperatureSource }),
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
        const provider = new StellariumNode();
        await provider.register(weatherResource(providerUrl));
        await startNode(provider, { port: providerPort, ...generateBase64KeyPair(), operatorUrl, databasePath: ":memory:" });
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
            functions: expect.arrayContaining([expect.objectContaining({ name: "temperature", paymentManifest: { costLamports: COST, recipientAddress: RECIPIENT } })]),
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

    test("the caller refuses a call that costs more than its limit", async () => {
        const caller = await startCaller({ costLimitLamports: COST - 1 });

        const result = await run(caller.url);

        expect(result.returnValue.value).toBeNull();
        expect(result.returnValue.error.message).toContain("exceeds the cost limit");
        expect(settlements).toEqual([]);
    });
});
