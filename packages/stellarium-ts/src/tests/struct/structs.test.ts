import { generateKeyPairSync } from "node:crypto";
import Fastify, { type FastifyInstance } from "fastify";
import { createLocalJWKSet, exportJWK, SignJWT } from "jose";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { signData } from "../../crypto/utils.js";
import type { NodeDatabase } from "../../db/database.js";
import { type EventAnnouncement, eventAnnouncementPayload } from "../../event/types.js";
import type { StellariumResource } from "../../resource/repository.js";
import routes from "../../routes.js";
import { resolveConfig } from "../../server.js";
import { createService, type NodeConfig, type Service } from "../../service.js";
import { defineStruct } from "../../struct/define.js";
import { type AnnouncedStruct, MAX_STRUCT_FIELDS, MAX_STRUCT_SOURCE_BYTES, type StructAnnouncement, structAnnouncementPayload } from "../../struct/types.js";
import { DIALECTS, generateBase64KeyPair, ORGANIZATION, openTestDatabase, testConfig } from "../helpers.js";

const ADDRESS = "struct com.example.Address@1(street: string, zip: int32)";
const CUSTOMER = "struct com.example.Customer@2(name: string, addresses: []com.example.Address@1)";
const OTHER_ORGANIZATION = "org_other";

/** A free host function that takes and returns an address, and records what it was called with. */
function geoResource(calls: unknown[]): StellariumResource {
    return {
        id: 2,
        baseUrl: "http://127.0.0.1:3002",
        metadata: {},
        path: "com.example",
        name: "Geo",
        functions: [{
            name: "normalize",
            parameters: [{ name: "at", type: "com.example.Address@1" }, { name: "note", type: "string" }],
            returnType: "com.example.Address@1",
            exec: async (args) => {
                calls.push(args);
                const at = args.find(arg => arg.name === "at")?.value as { street: string };
                return { street: at.street.toUpperCase(), zip: 1 };
            },
        }],
    };
}

describe.each(DIALECTS)("structs (%s)", (dialect) => {
    const operatorKeys = generateKeyPairSync("ed25519");
    const peer = generateBase64KeyPair();
    const peerUrl = "http://127.0.0.1:3999";

    let db: NodeDatabase;
    let config: NodeConfig;
    let service: Service;
    let fastify: FastifyInstance;
    let calls: unknown[];

    const membership = (publicKey: string, organizationId: string) => new SignJWT({ org: organizationId, use: "membership" })
        .setProtectedHeader({ alg: "EdDSA" })
        .setIssuer("stellarium")
        .setSubject(publicKey)
        .setAudience("stellarium:membership")
        .setExpirationTime("1h")
        .sign(operatorKeys.privateKey);

    const runToken = (organizationId: string) => new SignJWT({ org: organizationId })
        .setProtectedHeader({ alg: "EdDSA" })
        .setIssuer("stellarium")
        .setSubject("cli_test")
        .setAudience(config.publicKey)
        .setIssuedAt()
        .setExpirationTime("15m")
        .sign(operatorKeys.privateKey);

    beforeEach(async () => {
        db = await openTestDatabase(dialect);
        config = testConfig();
        config.membershipToken = await membership(config.publicKey, ORGANIZATION);
        calls = [];
        const jwk = await exportJWK(operatorKeys.publicKey);
        service = createService(db, [geoResource(calls)], config, { runTokenKeys: createLocalJWKSet({ keys: [{ ...jwk, alg: "EdDSA" }] }) });
        vi.spyOn(service.operatorClient, "authorizeRun").mockResolvedValue({ ok: true, heldMicroUsd: 50_000, maxTokens: 100 });
        vi.spyOn(service.operatorClient, "captureRun").mockResolvedValue(undefined);
        fastify = Fastify();
        await fastify.register(routes, { prefix: "/v1", service });
        await fastify.ready();
        await service.peerRepository.create({ baseUrl: peerUrl, name: peerUrl, publicKey: peer.publicKey });
    });

    afterEach(async () => {
        await fastify.close();
        await db.close();
        vi.restoreAllMocks();
    });

    const post = (url: string, payload: object, token = "secret") => fastify.inject({ method: "POST", url, headers: { authorization: `Bearer ${token}` }, payload });
    const declare = (source: string, token = "secret") => post("/v1/structs", { source }, token);
    const run = (body: string) => post("/v1/run", { source: `request R {\n${body}\n}` });

    /** The peer's signed announcement of its organization's structs. */
    async function peerAnnouncement(structs: AnnouncedStruct[], organizationId: string | null = OTHER_ORGANIZATION): Promise<StructAnnouncement> {
        const unsigned = {
            membershipToken: organizationId === null ? null : await membership(peer.publicKey, organizationId),
            structs,
            expiry: new Date(Date.now() + 60_000).toISOString(),
        };
        return { publicKey: peer.publicKey, ...unsigned, signature: signData(structAnnouncementPayload(unsigned), peer.privateKey) };
    }
    const announce = (announcement: StructAnnouncement) => fastify.inject({ method: "PUT", url: "/v1/all-structs", payload: announcement });
    const peerStruct = (overrides: Partial<AnnouncedStruct> = {}): AnnouncedStruct => ({
        path: "com.peer", name: "Point", version: "1", fields: [{ name: "x", type: "int32" }], ownerOrganizationId: OTHER_ORGANIZATION, description: null, ...overrides,
    });

    describe("declaring", () => {
        test("declares a struct owned by the node's organization, and looks it up", async () => {
            const response = await declare(ADDRESS);
            expect(response.statusCode).toBe(201);
            expect(response.json()).toEqual({
                path: "com.example", name: "Address", version: "1", ownerOrganizationId: ORGANIZATION,
                fields: [{ name: "street", type: "string" }, { name: "zip", type: "int32" }],
            });
            expect((await declare(CUSTOMER)).statusCode).toBe(201);

            const listed = (await fastify.inject({ method: "GET", url: "/v1/structs" })).json();
            expect(listed.structs.map((struct: { name: string }) => struct.name)).toEqual(["Address", "Customer"]);
            expect(listed.nextOffset).toBeNull();
            expect((await fastify.inject({ method: "GET", url: "/v1/structs/com.example.Customer@2" })).json())
                .toMatchObject({ fields: [{ name: "name", type: "string" }, { name: "addresses", type: "[]com.example.Address@1" }], baseUrl: config.baseUrl });
            expect((await fastify.inject({ method: "GET", url: "/v1/structs/com.example.Customer@1" })).statusCode).toBe(404);
        });

        test("looks up the latest version without one", async () => {
            await declare(ADDRESS);
            await declare("struct com.example.Address@1.10(street: string)");
            await declare("struct com.example.Address@1.9(street: string)");
            expect((await fastify.inject({ method: "GET", url: "/v1/structs/com.example.Address" })).json().version).toBe("1.10");
        });

        test("accepts the same version again only with the same fields", async () => {
            expect((await declare(ADDRESS)).statusCode).toBe(201);
            expect((await declare(ADDRESS)).statusCode).toBe(200);
            const changed = await declare("struct com.example.Address@1(street: string)");
            expect(changed.statusCode).toBe(409);
            expect(changed.json().error).toContain("immutable");
        });

        test.each([
            ["no version", "struct com.example.Address(street: string)", 400, "must declare its version"],
            ["no path", "struct Address@1(street: string)", 400, "path"],
            ["an unversioned field", "struct com.example.A@1(b: com.example.B)", 400, "must name its version"],
            ["a contract", "contract com.example.C: int32 {\n return 1\n}", 400, "struct declaration"],
            ["an unknown struct", "struct com.example.A@1(b: com.example.B@1)", 400, "com.example.B@1, which this node doesn't know"],
            ["too many fields", `struct com.example.Wide@1(${Array.from({ length: MAX_STRUCT_FIELDS + 1 }, (_, i) => `f${i}: int32`).join(", ")})`, 400, `at most ${MAX_STRUCT_FIELDS} fields`],
            ["too much source", `struct com.example.Big@1(x: int32) ${"/".repeat(MAX_STRUCT_SOURCE_BYTES)}`, 413, "at most"],
        ])("refuses %s", async (_, source, status, error) => {
            const response = await declare(source);
            expect(response.statusCode).toBe(status);
            expect(response.json().error).toContain(error);
        });

        test("refuses another organization's client, and a node without an organization", async () => {
            expect((await declare(ADDRESS, await runToken(OTHER_ORGANIZATION))).statusCode).toBe(403);
            expect((await declare(ADDRESS, await runToken(ORGANIZATION))).statusCode).toBe(201);
            config.organizationId = undefined;
            expect((await declare("struct com.example.Orphan@1(x: int32)")).statusCode).toBe(503);
        });

        test("refuses a path another organization owns", async () => {
            await announce(await peerAnnouncement([peerStruct()]));
            const response = await declare("struct com.peer.Point@2(x: int32)");
            expect(response.statusCode).toBe(409);
            expect(response.json().error).toContain("another organization's");
        });

        test("refuses a struct that would contain itself through a learned one", async () => {
            // The peer's struct names one this node doesn't know yet; declaring it here to name the peer's closes a loop.
            await announce(await peerAnnouncement([peerStruct({ name: "Wrapper", fields: [{ name: "inner", type: "com.example.Inner@1" }] })]));
            const response = await declare("struct com.example.Inner@1(outer: com.peer.Wrapper@1)");
            expect(response.statusCode).toBe(400);
            expect(response.json().error).toContain("com.example.Inner@1 -> com.peer.Wrapper@1 -> com.example.Inner@1");
        });

        test("refuses structs nested more than 8 deep", async () => {
            expect((await declare("struct com.example.S0@1(x: int32)")).statusCode).toBe(201);
            for (let i = 1; i < 8; i++) {
                expect((await declare(`struct com.example.S${i}@1(next: com.example.S${i - 1}@1)`)).statusCode).toBe(201);
            }
            const response = await declare("struct com.example.S8@1(next: []com.example.S7@1)");
            expect(response.statusCode).toBe(400);
            expect(response.json().error).toContain("nests 9 structs deep");
        });
    });

    describe("using", () => {
        beforeEach(async () => {
            await declare(ADDRESS);
            await declare(CUSTOMER);
        });

        test("a run checks values against structs", async () => {
            const response = await run('var a: com.example.Address@1 = { street: "Main", extra: true }\nreturn a');
            expect(response.statusCode).toBe(200);
            expect(response.json().returnValue).toEqual({ street: "Main", extra: true, zip: null });

            const bad = await run('var c: com.example.Customer@2 = { addresses: [{ zip: "x" }] }');
            expect(bad.statusCode).toBe(422);
            expect(bad.json().details).toContain("for field 'zip' of com.example.Address@1");
        });

        test("a run that names an unknown struct fails before it runs", async () => {
            const response = await run("var a: com.example.Missing@1 = null");
            expect(response.statusCode).toBe(422);
            expect(response.json().details).toContain("Unknown struct 'com.example.Missing@1'");
        });

        test("deploys and calls a contract with struct types", async () => {
            const ship = "contract com.example.Ship(customer: com.example.Customer@2): com.example.Address@1 {\n  return customer.addresses[0]\n}";
            expect((await post("/v1/contracts", { source: ship })).statusCode).toBe(201);

            const response = await run('const ship: com.example.Ship\nreturn ship.run(customer: { name: "Ana", addresses: [{ street: "Main", zip: 7 }] })');
            expect(response.statusCode).toBe(200);
            expect(response.json().returnValue).toEqual({ value: { street: "Main", zip: 7 }, error: null });
        });

        test("refuses a contract or event type that names an unknown struct", async () => {
            const contract = await post("/v1/contracts", { source: "contract com.example.Bad(a: com.example.Missing@1): int32 {\n  return 1\n}" });
            expect(contract.statusCode).toBe(400);
            expect(contract.json().error).toContain("com.example.Missing@1, which this node doesn't know");

            const event = await post("/v1/events", { source: "event com.example.Moved(to: com.example.Missing@1)" });
            expect(event.statusCode).toBe(400);
            expect((await post("/v1/events", { source: "event com.example.Moved(to: com.example.Address@1)" })).statusCode).toBe(201);
        });

        test("emits events with struct fields", async () => {
            await post("/v1/events", { source: "event com.example.Moved(to: com.example.Address@1)" });
            const response = await run('emit com.example.Moved(to: { zip: "x" })');
            expect(response.statusCode).toBe(422);
            expect(response.json().details).toContain("for field 'zip' of com.example.Address@1");
        });

        test("checks a host function's struct parameters and return value", async () => {
            const response = await run('const geo: com.example.Geo\nreturn geo.normalize(at: { street: "main" }, note: "n")');
            expect(response.json().returnValue).toEqual({ value: { street: "MAIN", zip: 1 }, error: null });
        });

        test("refuses a peer's call with a struct parameter that doesn't fit, before running the function", async () => {
            const call = (at: unknown) => fastify.inject({
                method: "POST",
                url: "/v1/run/resource",
                payload: { resourcePath: "com.example", resourceName: "Geo", functionName: "normalize", parameters: [{ name: "at", value: at }, { name: "note", value: 5 }] },
            });
            const bad = await call({ street: "main", zip: "x" });
            expect(bad.statusCode).toBe(400);
            expect(bad.json().details).toContain("for parameter 'at'.zip");
            expect(calls).toEqual([]);

            // Other parameters are passed as they come, as before.
            const good = await call({ street: "main" });
            expect(good.statusCode).toBe(200);
            expect(good.json()).toEqual({ value: { street: "MAIN", zip: 1 }, error: null });
            expect(calls).toEqual([[{ name: "at", value: { street: "main" } }, { name: "note", value: 5 }]]);
        });
    });

    describe("announcing", () => {
        test("announces the structs the node declared, signed with its membership token", async () => {
            await declare(ADDRESS);
            await announce(await peerAnnouncement([peerStruct()]));

            const announcement = (await fastify.inject({ method: "GET", url: "/v1/structs/announcement" })).json() as StructAnnouncement;
            expect(announcement.structs).toEqual([{ path: "com.example", name: "Address", version: "1", fields: [{ name: "street", type: "string" }, { name: "zip", type: "int32" }], ownerOrganizationId: ORGANIZATION, description: null }]);
            expect(announcement.membershipToken).toBe(config.membershipToken);

            // Another node of a different organization learns it from the announcement.
            const otherDb = await openTestDatabase(dialect);
            try {
                const jwk = await exportJWK(operatorKeys.publicKey);
                const other = createService(otherDb, [], testConfig({ organizationId: OTHER_ORGANIZATION }), { runTokenKeys: createLocalJWKSet({ keys: [{ ...jwk, alg: "EdDSA" }] }) });
                expect(await other.structService.applyAnnouncement(announcement, config.baseUrl)).toEqual({ ok: true, rejected: [] });
                expect(await other.structService.repository.get("com.example", "Address", "1")).toMatchObject({ ownerOrganizationId: ORGANIZATION, baseUrl: config.baseUrl });
            } finally {
                await otherDb.close();
            }
        });

        test("doesn't announce without a membership token", async () => {
            await declare(ADDRESS);
            config.membershipToken = undefined;
            expect((await service.structService.announcement()).structs).toEqual([]);
        });

        test("learns a peer's structs, only as its own organization's", async () => {
            const response = await announce(await peerAnnouncement([peerStruct(), peerStruct({ name: "Claimed", ownerOrganizationId: ORGANIZATION })]));
            expect(response.json()).toEqual({ success: true, rejected: ["com.peer.Claimed@1"] });
            expect(await service.structService.repository.get("com.peer", "Point", "1")).toMatchObject({ baseUrl: peerUrl, ownerOrganizationId: OTHER_ORGANIZATION });
            expect((await run("var p: com.peer.Point@1 = { x: 1 }\nreturn p")).json().returnValue).toEqual({ x: 1 });
        });

        test("learns nothing without a membership token", async () => {
            const response = await announce(await peerAnnouncement([peerStruct()], null));
            expect(response.json().rejected).toEqual(["com.peer.Point@1"]);
        });

        test("keeps a version's fields, and its structs when the peer stops announcing them", async () => {
            await announce(await peerAnnouncement([peerStruct()]));
            const changed = await announce(await peerAnnouncement([peerStruct({ fields: [{ name: "y", type: "string" }] })]));
            expect(changed.json().rejected).toEqual(["com.peer.Point@1"]);
            await announce(await peerAnnouncement([]));
            expect((await service.structService.repository.get("com.peer", "Point", "1"))?.fields).toEqual([{ name: "x", type: "int32" }]);
        });

        test("refuses a path this node's organization owns, and a bad signature", async () => {
            await declare(ADDRESS);
            expect((await announce(await peerAnnouncement([peerStruct({ path: "com.example", name: "Address", version: "2" })]))).json().rejected)
                .toEqual(["com.example.Address@2"]);

            const forged = { ...await peerAnnouncement([peerStruct()]), structs: [peerStruct({ name: "Forged" })] };
            expect((await announce(forged)).statusCode).toBe(400);
        });

        test("learns an event type whose fields name a struct only once it knows the struct", async () => {
            const moved = { path: "com.peer", name: "Moved", version: "1", fields: [{ name: "to", type: "com.peer.Point@1" }], restricted: false, ownerOrganizationId: OTHER_ORGANIZATION, description: null };
            const eventAnnouncement = async (): Promise<EventAnnouncement> => {
                const unsigned = { membershipToken: await membership(peer.publicKey, OTHER_ORGANIZATION), eventTypes: [moved], subscriptions: [], expiry: new Date(Date.now() + 60_000).toISOString() };
                return { publicKey: peer.publicKey, ...unsigned, signature: signData(eventAnnouncementPayload(unsigned), peer.privateKey) };
            };
            const announceEvents = async () => (await fastify.inject({ method: "PUT", url: "/v1/all-events", payload: await eventAnnouncement() })).json();

            expect((await announceEvents()).rejected).toEqual(["com.peer.Moved@1"]);
            await announce(await peerAnnouncement([peerStruct()]));
            expect((await announceEvents()).rejected).toEqual([]);
            expect(await service.eventService.repository.resolveType("com.peer", "Moved", "1")).toBeDefined();
        });
    });

    describe("host structs", () => {
        test("declares them in any order, and refuses a conflict", async () => {
            const address = defineStruct("com.example.Address", 1, { street: "string" });
            const customer = defineStruct("com.example.Customer", 2, { addresses: `[]${address.type}` });
            await service.structService.declareHost([customer, address]);
            expect(await service.structService.repository.get("com.example", "Customer", "2")).toMatchObject({ ownerOrganizationId: ORGANIZATION });
            // Declaring them again, as every start does, changes nothing.
            await service.structService.declareHost([address, customer]);

            await expect(service.structService.declareHost([defineStruct("com.example.Address", 1, { street: "int32" })])).rejects.toThrow("immutable");
            await expect(service.structService.declareHost([defineStruct("com.example.Lost", 1, { x: "com.example.Nowhere@1" })])).rejects.toThrow("doesn't know");
        });
    });
});

describe("defineStruct", () => {
    test("defines a struct and its type string", () => {
        const address = defineStruct("com.example.Address", "1.2", { street: "string", zip: "int32" });
        expect(address).toEqual({ path: "com.example", name: "Address", version: "1.2", fields: [{ name: "street", type: "string" }, { name: "zip", type: "int32" }], type: "com.example.Address@1.2" });
        expect(defineStruct("com.example.Customer", 1, { home: address.type }).fields).toEqual([{ name: "home", type: "com.example.Address@1.2" }]);
    });

    test.each([
        ["a name without a path", () => defineStruct("Address", 1, { x: "int32" }), "give it a path"],
        ["a bad version", () => defineStruct("a.B", "v1", { x: "int32" }), "Invalid version"],
        ["an unversioned struct field", () => defineStruct("a.B", 1, { c: "a.C" }), "names its version"],
        ["a bad field name", () => defineStruct("a.B", 1, { "not a name": "int32" }), "Invalid field name"],
        ["itself", () => defineStruct("a.B", 1, { next: "[]a.B@1" }), "can't contain itself"],
        ["no fields", () => defineStruct("a.B", 1, {}), "must declare its fields"],
    ])("refuses %s", (_, define, message) => {
        expect(define).toThrow(message);
    });

    test("a resource type that names a struct without a version stops the node from starting", () => {
        const resource: StellariumResource = { id: 1, baseUrl: "http://127.0.0.1:3002", metadata: {}, path: "a", name: "R", functions: [{ name: "f", parameters: [], returnType: "com.example.Address", exec: async () => null }] };
        expect(() => resolveConfig({ ...testConfig(), operatorUrl: undefined }, [resource])).toThrow("Invalid type 'com.example.Address' for the return type of a.R.f");
    });
});
