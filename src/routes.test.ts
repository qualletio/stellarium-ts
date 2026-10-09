import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import type { Resource } from "requestscript";
import { openDatabase } from "./db/db.js";
import { createService } from "./service.js";
import routes from "./routes.js";
import { proveRunAccess, verifyRunAccess } from "./protocol/access.js";
import { createPrivateKeySigner } from "./protocol/typed-data.js";
import { hashRequest, wireJson } from "./protocol/canonical.js";
import type { Domain, RunRequest } from "./protocol/types.js";
const apps: FastifyInstance[] = [];
afterEach(async () => {
    for (const app of apps.splice(0)) await app.close();
});
async function app() {
    const database = await openDatabase(":memory:");
    const fastify = Fastify();
    apps.push(fastify);
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
    fastify.register(routes, {
        prefix: "/v1",
        service: createService([resource], database, "https://node.example"),
    });
    fastify.addHook("onClose", async () => {
        await database.close();
    });
    return { fastify, exec };
}
describe("JSON run API", () => {
    it("runs a top-level JSON request", async () => {
        const { fastify, exec } = await app();
        const response = await fastify.inject({
            method: "POST",
            url: "/v1/run",
            payload: {
                version: 1,
                kind: "request",
                source: 'request X { const weather: example.Weather return weather.forecast(city: "Oslo") }',
            },
        });
        expect(response.statusCode).toBe(200);
        expect(response.json()).toEqual({ returnValue: 12, executions: [] });
        expect(exec).toHaveBeenCalledOnce();
    });
    it("rejects raw strings and invalid declarations", async () => {
        const { fastify } = await app();
        expect(
            (
                await fastify.inject({
                    method: "POST",
                    url: "/v1/run",
                    payload: JSON.stringify("request X { return 1 }"),
                    headers: { "content-type": "application/json" },
                })
            ).statusCode,
        ).toBe(400);
        expect(
            (
                await fastify.inject({
                    method: "POST",
                    url: "/v1/run",
                    payload: {
                        version: 1,
                        kind: "request",
                        source: "contract X {}",
                    },
                })
            ).statusCode,
        ).toBe(400);
    });
    it("rejects forwarded calls with a substituted resource ID", async () => {
        const { fastify, exec } = await app();
        const response = await fastify.inject({
            method: "POST",
            url: "/v1/run",
            payload: {
                version: 1,
                kind: "invocation",
                resourceId: `0x${"0".repeat(64)}`,
                resourceKey: "example.Weather",
                functionName: "forecast",
                parameters: [{ name: "city", value: "Oslo" }],
            },
        });
        expect(response.statusCode).toBe(400);
        expect(exec).not.toHaveBeenCalled();
    });
    it("requires payment configuration for paid bodies", async () => {
        const { fastify } = await app();
        const signer = createPrivateKeySigner(`0x${"1".repeat(64)}`);
        const domain: Domain = {
            name: "Stellarium",
            version: "1",
            chainId: 84532,
            verifyingContract: "0x0000000000000000000000000000000000000001",
        };
        const now = BigInt(Math.floor(Date.now() / 1000));
        const authorization = await signer.sign(
            "RequestAuthorization",
            domain,
            {
                protocolVersion: 1,
                requestId: `0x${"a".repeat(64)}`,
                caller: signer.address,
                budgetUsdc: 1n,
                requestHash: hashRequest("request X { return 1 }"),
                executionAuthority: signer.address,
                issuedAt: now,
                expiresAt: now + 300n,
                nonce: 0n,
            },
        );
        const response = await fastify.inject({
            method: "POST",
            url: "/v1/run",
            payload: JSON.parse(
                wireJson({
                    version: 1,
                    kind: "request",
                    source: "request X { return 1 }",
                    payment: { authorization },
                }),
            ),
        });
        expect(response.statusCode).toBe(503);
    });
    it("binds access proofs to the endpoint and exact request payload", async () => {
        const signer = createPrivateKeySigner(`0x${"1".repeat(64)}`);
        const domain: Domain = {
            name: "Stellarium",
            version: "1",
            chainId: 84532,
            verifyingContract: "0x0000000000000000000000000000000000000001",
        };
        const body = await proveRunAccess(
            { version: 1, kind: "request", source: "request X { return 1 }" },
            signer,
            domain,
            "https://node.example",
        );
        await expect(
            verifyRunAccess(
                body,
                signer.address,
                domain,
                "https://node.example",
            ),
        ).resolves.toMatch(/^0x/);
        await expect(
            verifyRunAccess(
                body,
                signer.address,
                domain,
                "https://other.example",
            ),
        ).rejects.toThrow("access proof");
        await expect(
            verifyRunAccess(
                { ...body, source: "request X { return 2 }" } as RunRequest,
                signer.address,
                domain,
                "https://node.example",
            ),
        ).rejects.toThrow("access proof");
    });
});
