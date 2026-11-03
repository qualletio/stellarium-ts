import { generateKeyPairSync } from "node:crypto";
import { createServer } from "node:net";
import Fastify, { type FastifyInstance } from "fastify";
import { exportJWK, SignJWT } from "jose";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { StellariumNode, type StellariumNodeOptions } from "../../server.js";
import type { Service } from "../../service.js";
import { generateBase64KeyPair } from "../helpers.js";

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

const PROVIDER_ORGANIZATION = "org_provider";
const CALLER_ORGANIZATION = "org_caller";
const GREETED = "event com.example.Greeted(who: string)";
const ON_GREETED = "contract com.example.OnGreeted consumes com.example.Greeted {\n  var state count: int32 = 0\n  var state last: string = \"\"\n  count = count + 1\n  last = \"${who} from ${caller.org}\"\n}";

/**
 * Two real nodes in two organizations and a fake operator that issues their sessions with membership tokens
 * and publishes its keys. The provider declares an event type and emits it; the caller's event contract
 * consumes it.
 */
describe("events between two nodes", { timeout: 20_000 }, () => {
    const servers: FastifyInstance[] = [];
    const operatorKeys = generateKeyPairSync("ed25519");
    const providerKeys = generateBase64KeyPair();
    const callerKeys = generateBase64KeyPair();
    const organizations = new Map([[providerKeys.publicKey, PROVIDER_ORGANIZATION], [callerKeys.publicKey, CALLER_ORGANIZATION]]);
    let providerUrl: string;
    let callerUrl: string;
    let provider: StellariumNode;

    async function startNode(node: StellariumNode, port: number, options: StellariumNodeOptions) {
        const fastify = Fastify();
        servers.push(fastify);
        await node.start(fastify, { host: "127.0.0.1", port, baseUrl: `http://127.0.0.1:${port}`, databasePath: ":memory:", eventWorkerIntervalMs: 50, ...options });
    }

    const admin = (url: string, method: string, path: string, body?: object, key = "admin") => fetch(`${url}/v1${path}`, {
        method,
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
        body: body && JSON.stringify(body),
    });

    const callerState = async () => {
        const response = await admin(callerUrl, "GET", "/contracts/com.example.OnGreeted/state", undefined, "caller-admin");
        const { variables } = await response.json() as { variables: { name: string, value: unknown }[] };
        return Object.fromEntries(variables.map(variable => [variable.name, variable.value]));
    };

    beforeEach(async () => {
        const operator = Fastify();
        servers.push(operator);
        const jwk = { ...await exportJWK(operatorKeys.publicKey), alg: "EdDSA", kid: "test" };
        operator.get("/v1/.well-known/jwks.json", async () => ({ keys: [jwk] }));
        operator.post("/v1/nodes/session", async (request, reply) => {
            const header = String(request.headers.authorization);
            if (!header.startsWith("Stellarium ")) {
                return reply.status(401).send({ error: "Unsigned request" });
            }
            const { publicKey } = JSON.parse(Buffer.from(header.slice("Stellarium ".length), "base64url").toString()) as { publicKey: string };
            const organizationId = organizations.get(publicKey)!;
            const membershipToken = await new SignJWT({ org: organizationId, use: "membership" })
                .setProtectedHeader({ alg: "EdDSA", kid: "test" })
                .setIssuer("stellarium")
                .setSubject(publicKey)
                .setAudience("stellarium:membership")
                .setIssuedAt()
                .setExpirationTime("1h")
                .sign(operatorKeys.privateKey);
            return { organizationId, priceMicroUsdPerMillionTokens: 0, membershipToken };
        });
        const operatorUrl = `${await operator.listen({ port: 0, host: "127.0.0.1" })}/v1`;

        const providerPort = await freePort();
        providerUrl = `http://127.0.0.1:${providerPort}`;
        provider = new StellariumNode();
        // An enrollment token makes the node wait for its session, and so for its membership token, before it serves.
        await startNode(provider, providerPort, { ...providerKeys, operatorUrl, apiKey: "admin", enrollmentToken: "enroll" });

        const callerPort = await freePort();
        callerUrl = `http://127.0.0.1:${callerPort}`;
        await startNode(new StellariumNode(), callerPort, { ...callerKeys, operatorUrl, apiKey: "caller-admin", enrollmentToken: "enroll", startingPeer: providerUrl });
    });

    afterEach(async () => {
        await Promise.all(servers.splice(0).map(server => server.close()));
    });

    const providerService = () => (provider as unknown as { service: Service }).service;

    test("an event the provider emits runs the caller's event contract once", async () => {
        expect((await admin(providerUrl, "POST", "/events", { source: GREETED })).status).toBe(201);
        // The provider announces its event types when one is declared.
        await vi.waitFor(async () => expect((await (await fetch(`${callerUrl}/v1/events`)).json() as { eventTypes: unknown[] }).eventTypes)
            .toEqual([expect.objectContaining({ name: "Greeted", baseUrl: providerUrl, ownerOrganizationId: PROVIDER_ORGANIZATION })]));

        expect((await admin(callerUrl, "POST", "/contracts", { source: ON_GREETED }, "caller-admin")).status).toBe(201);
        // The caller announces its event contracts, so the provider knows to deliver to it.
        await vi.waitFor(async () => expect(await providerService().eventService.repository.subscribersOf("com.example", "Greeted", "1")).toHaveLength(1));

        const run = await admin(providerUrl, "POST", "/run", { source: 'request R {\n  emit com.example.Greeted(who: "Ada")\n  return 1\n}' });
        expect(run.status).toBe(200);

        await vi.waitFor(async () => expect(await callerState()).toEqual({ count: 1, last: `Ada from ${PROVIDER_ORGANIZATION}` }));
        const [delivery] = (await (await admin(providerUrl, "GET", "/admin/events/outbox")).json() as { deliveries: { status: string, target: string }[] }).deliveries;
        expect(delivery).toMatchObject({ status: "delivered", target: callerUrl });
    });

    test("the caller can't consume a restricted event type of the provider's organization", async () => {
        expect((await admin(providerUrl, "POST", "/events", { source: `restricted ${GREETED}` })).status).toBe(201);
        await vi.waitFor(async () => expect((await (await fetch(`${callerUrl}/v1/events`)).json() as { eventTypes: unknown[] }).eventTypes).toHaveLength(1));

        const response = await admin(callerUrl, "POST", "/contracts", { source: ON_GREETED }, "caller-admin");
        expect(response.status).toBe(403);
        expect((await response.json() as { error: string }).error).toContain("restricted");
    });
});
