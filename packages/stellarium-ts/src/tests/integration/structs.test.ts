import { generateKeyPairSync } from "node:crypto";
import { createServer } from "node:net";
import Fastify, { type FastifyInstance } from "fastify";
import { exportJWK, SignJWT } from "jose";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { StellariumResource } from "../../resource/repository.js";
import { StellariumNode, type StellariumNodeOptions } from "../../server.js";
import { defineStruct } from "../../struct/define.js";
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

/**
 * Two real nodes in two organizations and a fake operator that issues their sessions with membership tokens.
 * The provider defines a struct in TypeScript and returns it from a function; the caller learns the struct
 * when it joins, and uses it as a type.
 */
describe("structs between two nodes", { timeout: 20_000 }, () => {
    const servers: FastifyInstance[] = [];
    const operatorKeys = generateKeyPairSync("ed25519");
    const providerKeys = generateBase64KeyPair();
    const callerKeys = generateBase64KeyPair();
    const organizations = new Map([[providerKeys.publicKey, PROVIDER_ORGANIZATION], [callerKeys.publicKey, CALLER_ORGANIZATION]]);
    let providerUrl: string;
    let callerUrl: string;

    const Forecast = defineStruct("com.example.Forecast", 1, { city: "string", highs: "[]decimal" });

    function weather(baseUrl: string, returned: unknown): StellariumResource {
        return {
            id: 1,
            baseUrl,
            metadata: {},
            path: "com.example",
            name: "Weather",
            functions: [{
                name: "forecast",
                parameters: [{ name: "city", type: "string" }],
                returnType: Forecast.type,
                exec: async (args) => returned ?? { city: args[0]!.value, highs: [21.5, 23], source: "model" },
            }],
        };
    }

    async function startNode(node: StellariumNode, port: number, options: StellariumNodeOptions) {
        const fastify = Fastify();
        servers.push(fastify);
        await node.start(fastify, { host: "127.0.0.1", port, baseUrl: `http://127.0.0.1:${port}`, databasePath: ":memory:", ...options });
    }

    const admin = (url: string, method: string, path: string, body?: object, key = "admin") => fetch(`${url}/v1${path}`, {
        method,
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
        body: body && JSON.stringify(body),
    });
    const callerRun = async (body: string) => {
        const response = await admin(callerUrl, "POST", "/run", { source: `request R {\n${body}\n}` }, "caller-admin");
        return { status: response.status, body: await response.json() as { returnValue?: unknown, details?: string } };
    };

    async function startNetwork(returned?: unknown) {
        const operator = Fastify();
        servers.push(operator);
        const jwk = { ...await exportJWK(operatorKeys.publicKey), alg: "EdDSA", kid: "test" };
        operator.get("/v1/.well-known/jwks.json", async () => ({ keys: [jwk] }));
        operator.post("/v1/nodes/session", async (request) => {
            const header = String(request.headers.authorization);
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
        const provider = new StellariumNode();
        await provider.registerStruct(Forecast);
        await provider.register(weather(providerUrl, returned));
        // The struct makes the provider wait for its session, so it is declared as its organization's before it serves.
        await startNode(provider, providerPort, { ...providerKeys, operatorUrl, apiKey: "admin" });

        const callerPort = await freePort();
        callerUrl = `http://127.0.0.1:${callerPort}`;
        await startNode(new StellariumNode(), callerPort, { ...callerKeys, operatorUrl, apiKey: "caller-admin", enrollmentToken: "enroll", startingPeer: providerUrl });
    }

    afterEach(async () => {
        await Promise.all(servers.splice(0).map(server => server.close()));
    });

    describe("with a provider that returns forecasts", () => {
        beforeEach(() => startNetwork());

        test("the caller learns the provider's struct when it joins, and checks the provider's return value against it", async () => {
            const known = await (await fetch(`${callerUrl}/v1/structs/com.example.Forecast@1`)).json();
            expect(known).toMatchObject({ ownerOrganizationId: PROVIDER_ORGANIZATION, baseUrl: providerUrl, fields: Forecast.fields });

            const { status, body } = await callerRun('const weather: com.example.Weather\nreturn weather.forecast(city: "Oslo")');
            expect(status).toBe(200);
            expect(body.returnValue).toEqual({ value: { city: "Oslo", highs: [21.5, 23], source: "model" }, error: null });
        });

        test("the caller's contracts use the provider's struct, and can't declare its path", async () => {
            const contract = "contract com.caller.Warmest(forecast: com.example.Forecast@1): decimal {\n  return forecast.highs[1]\n}";
            expect((await admin(callerUrl, "POST", "/contracts", { source: contract }, "caller-admin")).status).toBe(201);
            // The caller announces its contract, struct-typed parameter and all, and the provider learns it.
            await vi.waitFor(async () => {
                const { resources } = await (await fetch(`${providerUrl}/v1/resources`)).json() as { resources: { name: string, functions: { parameters: { type: string }[] }[] }[] };
                expect(resources.find(resource => resource.name === "Warmest")?.functions[0]?.parameters).toEqual([expect.objectContaining({ type: Forecast.type })]);
            });
            const { body } = await callerRun("const warmest: com.caller.Warmest\nreturn warmest.run(forecast: { city: \"Oslo\", highs: [1, 30] })");
            expect(body.returnValue).toEqual({ value: 30, error: null });

            const taken = await admin(callerUrl, "POST", "/structs", { source: "struct com.example.Forecast@2(city: string)" }, "caller-admin");
            expect(taken.status).toBe(409);
        });

        test("a struct the provider declares later reaches the caller", async () => {
            expect((await admin(providerUrl, "POST", "/structs", { source: "struct com.example.Alert@1(level: int32, forecast: com.example.Forecast@1)" })).status).toBe(201);
            await vi.waitFor(async () => expect((await fetch(`${callerUrl}/v1/structs/com.example.Alert@1`)).status).toBe(200));
            const { body } = await callerRun("var a: com.example.Alert@1 = { level: \"high\" }");
            expect(body.details).toContain("for field 'level' of com.example.Alert@1");
        });
    });

    test("a return value that doesn't fit the struct fails the caller's call", async () => {
        await startNetwork({ city: "Oslo", highs: "warm" });
        const { status, body } = await callerRun('const weather: com.example.Weather\nreturn weather.forecast(city: "Oslo")');
        expect(status).toBe(422);
        expect(body.details).toContain("returned from 'forecast'");
    });
});
