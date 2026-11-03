import { generateKeyPairSync, randomUUID } from "node:crypto";
import Fastify, { type FastifyInstance } from "fastify";
import { createLocalJWKSet, exportJWK, SignJWT } from "jose";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { signData } from "../../crypto/utils.js";
import type { NodeDatabase } from "../../db/database.js";
import { type EventAnnouncement, eventAnnouncementPayload, type EventEnvelope, eventEnvelopePayload, EVENT_MAX_AGE_MS, MAX_EVENT_DEPTH } from "../../event/types.js";
import type { StellariumResource } from "../../resource/repository.js";
import routes from "../../routes.js";
import { createService, type NodeConfig, type Service } from "../../service.js";
import { DIALECTS, generateBase64KeyPair, ORGANIZATION, openTestDatabase, testConfig, weatherResource } from "../helpers.js";

const GREETED = "event com.example.Greeted(who: string, times: int32)";
const RESTRICTED = "restricted event com.example.Audit(entry: string)";
/** Counts the events it consumes, and keeps what it last saw. */
const COUNTER = [
    "contract com.example.CountGreetings consumes com.example.Greeted {",
    "  var state count: int32 = 0",
    "  var state last: object = {}",
    "  count = count + 1",
    "  last = { who: who, times: times, id: event.id, org: caller.org, node: caller.node }",
    "}",
].join("\n");
const GREET = 'request R {\n  emit com.example.Greeted(who: "Ada", times: 2)\n  return 1\n}';
const OTHER_ORGANIZATION = "org_other";

describe.each(DIALECTS)("events (%s)", (dialect) => {
    const operatorKeys = generateKeyPairSync("ed25519");
    const peer = generateBase64KeyPair();
    const peerUrl = "http://127.0.0.1:3999";

    let db: NodeDatabase;
    let config: NodeConfig;
    let service: Service;
    let fastify: FastifyInstance;
    let spies: Record<"createEventMandate" | "authorizeEventRun" | "authorizeRun" | "captureRun" | "releaseRun", ReturnType<typeof vi.spyOn>>;

    /** A membership token the operator would issue to the node with `publicKey`. */
    const membership = (publicKey: string, organizationId: string, options: { audience?: string, use?: string, issuedAt?: number, expiresIn?: string | number } = {}) =>
        new SignJWT({ org: organizationId, use: options.use ?? "membership" })
            .setProtectedHeader({ alg: "EdDSA" })
            .setIssuer("stellarium")
            .setSubject(publicKey)
            .setAudience(options.audience ?? "stellarium:membership")
            .setIssuedAt(options.issuedAt)
            .setExpirationTime(options.expiresIn ?? "1h")
            .sign(operatorKeys.privateKey);

    /** A run token the operator would issue to `organizationId`'s client on this node. */
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
        config = testConfig({ priceMicroUsdPerMillionTokens: 1_000_000 });
        config.membershipToken = await membership(config.publicKey, ORGANIZATION);
        const jwk = await exportJWK(operatorKeys.publicKey);
        service = createService(db, [weatherResource()], config, { runTokenKeys: createLocalJWKSet({ keys: [{ ...jwk, alg: "EdDSA" }] }) });
        const client = service.operatorClient;
        spies = {
            createEventMandate: vi.spyOn(client, "createEventMandate").mockResolvedValue({ ok: true, mandateId: "mnd_test" }),
            authorizeEventRun: vi.spyOn(client, "authorizeEventRun").mockResolvedValue({ ok: true, heldMicroUsd: 50_000, maxTokens: 100 }),
            authorizeRun: vi.spyOn(client, "authorizeRun").mockResolvedValue({ ok: true, heldMicroUsd: 50_000, maxTokens: 100 }),
            captureRun: vi.spyOn(client, "captureRun").mockResolvedValue(undefined),
            releaseRun: vi.spyOn(client, "releaseRun").mockResolvedValue(undefined),
        };
        fastify = Fastify();
        await fastify.register(routes, { prefix: "/v1", service });
        await fastify.ready();
        await service.peerRepository.create({ baseUrl: peerUrl, name: peerUrl, publicKey: peer.publicKey });
    });

    afterEach(async () => {
        await fastify.close();
        await db.close();
        vi.restoreAllMocks();
        vi.unstubAllGlobals();
    });

    // Settlement is scheduled with setTimeout(0).
    const flushSettlement = () => new Promise((resolve) => setTimeout(resolve, 10));

    const post = (url: string, payload: object, token = "secret") => fastify.inject({ method: "POST", url, headers: { authorization: `Bearer ${token}` }, payload });
    const declare = (source: string, token = "secret") => post("/v1/events", { source }, token);
    const deploy = (source: string, token = "secret") => post("/v1/contracts", { source }, token);
    const run = (source: string, token = "secret") => post("/v1/run", { source }, token);
    const state = async (ref = "com.example.CountGreetings") => {
        const variables = (await fastify.inject({ method: "GET", url: `/v1/contracts/${ref}/state`, headers: { authorization: "Bearer secret" } })).json().variables as { name: string, value: unknown }[];
        return Object.fromEntries(variables.map(variable => [variable.name, variable.value]));
    };
    const inbox = async () => (await fastify.inject({ method: "GET", url: "/v1/admin/events/inbox", headers: { authorization: "Bearer secret" } })).json().events;
    const outbox = async () => (await fastify.inject({ method: "GET", url: "/v1/admin/events/outbox", headers: { authorization: "Bearer secret" } })).json().deliveries;

    /** An event the peer publishes, as it would deliver it. */
    async function peerEvent(overrides: Partial<EventEnvelope> = {}, keys = peer, organizationId = OTHER_ORGANIZATION): Promise<EventEnvelope> {
        const unsigned = {
            id: randomUUID(),
            type: "com.example.Pinged",
            version: "1",
            ownerOrganizationId: organizationId,
            data: { note: "hi" },
            publishedAt: new Date().toISOString(),
            depth: 1,
            lineage: { types: [], contracts: [] },
            publisherPublicKey: keys.publicKey,
            membershipToken: await membership(keys.publicKey, organizationId),
            ...overrides,
        };
        return { ...unsigned, signature: signData(eventEnvelopePayload(unsigned), keys.privateKey) };
    }

    /** The peer's signed announcement of the event types and event contracts it has. */
    async function peerAnnouncement(contents: Partial<Pick<EventAnnouncement, "eventTypes" | "subscriptions" | "membershipToken">>): Promise<EventAnnouncement> {
        const unsigned = {
            membershipToken: contents.membershipToken === undefined ? await membership(peer.publicKey, OTHER_ORGANIZATION) : contents.membershipToken,
            eventTypes: contents.eventTypes ?? [],
            subscriptions: contents.subscriptions ?? [],
            expiry: new Date(Date.now() + 60_000).toISOString(),
        };
        return { publicKey: peer.publicKey, ...unsigned, signature: signData(eventAnnouncementPayload(unsigned), peer.privateKey) };
    }

    const announce = async (announcement: EventAnnouncement) => fastify.inject({ method: "PUT", url: "/v1/all-events", payload: announcement });

    const pinged = { path: "com.example", name: "Pinged", version: "1", fields: [{ name: "note", type: "string" }], restricted: false, ownerOrganizationId: OTHER_ORGANIZATION, description: null };

    describe("event types", () => {
        test("declares an event type owned by the node's organization, and lists it", async () => {
            const response = await declare(GREETED);

            expect(response.statusCode).toBe(201);
            expect(response.json()).toEqual({
                path: "com.example", name: "Greeted", version: "1", restricted: false, ownerOrganizationId: ORGANIZATION,
                fields: [{ name: "who", type: "string" }, { name: "times", type: "int32" }],
            });
            const listed = (await fastify.inject({ method: "GET", url: "/v1/events" })).json();
            expect(listed).toMatchObject({ eventTypes: [{ path: "com.example", name: "Greeted", version: "1", baseUrl: config.baseUrl, ownerOrganizationId: ORGANIZATION }], nextOffset: null });
        });

        test.each([
            ["a contract", "contract com.example.Sum: int32 {\n  return 1\n}", 400, "event declaration"],
            ["an event without a path", "event Greeted(who: string)", 400, "path"],
            ["a declaration that doesn't parse", "event com.example.Greeted(who: string) { }", 400, "no body"],
        ])("refuses %s", async (_, source, status, error) => {
            const response = await declare(source);
            expect(response.statusCode).toBe(status);
            expect(response.json().error).toContain(error);
        });

        test("refuses an existing version, another organization's client, and a node without an organization", async () => {
            await declare(GREETED);
            expect((await declare(GREETED)).statusCode).toBe(409);
            expect((await declare(GREETED.replace("Greeted", "Greeted@2"))).statusCode).toBe(201);

            expect((await declare("event com.example.Other(x: string)", await runToken(OTHER_ORGANIZATION))).statusCode).toBe(403);
            expect((await declare("event com.example.Mine(x: string)", await runToken(ORGANIZATION))).statusCode).toBe(201);

            config.organizationId = undefined;
            expect((await declare("event com.example.Orphan(x: string)")).statusCode).toBe(503);
        });

        test("refuses a type another node declared", async () => {
            await announce(await peerAnnouncement({ eventTypes: [pinged] }));

            const response = await declare("event com.example.Pinged@2(note: string)");
            expect(response.statusCode).toBe(409);
            expect(response.json().error).toContain("another node's");
        });

        test("deletes a version, or every version", async () => {
            await declare(GREETED);
            await declare(GREETED.replace("Greeted", "Greeted@2"));

            expect((await fastify.inject({ method: "DELETE", url: "/v1/events/com.example.Greeted@1", headers: { authorization: "Bearer secret" } })).statusCode).toBe(200);
            expect((await fastify.inject({ method: "GET", url: "/v1/events" })).json().eventTypes.map((type: { version: string }) => type.version)).toEqual(["2"]);
            expect((await fastify.inject({ method: "DELETE", url: "/v1/events/com.example.Greeted", headers: { authorization: "Bearer secret" } })).statusCode).toBe(200);
            expect((await fastify.inject({ method: "DELETE", url: "/v1/events/com.example.Greeted", headers: { authorization: "Bearer secret" } })).statusCode).toBe(404);
        });
    });

    describe("emitting and consuming on one node", () => {
        beforeEach(async () => {
            await declare(GREETED);
        });

        test("runs the node's event contract with each event a run emits", async () => {
            expect((await deploy(COUNTER)).statusCode).toBe(201);

            const response = await run(GREET);
            expect(response.statusCode).toBe(200);
            expect(response.json().returnValue).toBe(1);
            expect(await service.eventService.processInbox()).toBe(1);

            const { count, last } = await state();
            expect(count).toBe(1);
            expect(last).toMatchObject({ who: "Ada", times: 2, org: ORGANIZATION, node: config.publicKey, id: expect.any(String) });
            expect(await inbox()).toEqual([expect.objectContaining({ type: "com.example.Greeted", target: "com.example.CountGreetings", status: "done", attempts: 1 })]);
            // Free: the node's own organization deployed it.
            expect(spies.authorizeEventRun).not.toHaveBeenCalled();
        });

        test("keeps event contracts out of the node's resources", async () => {
            await deploy(COUNTER);

            const resources = (await fastify.inject({ method: "GET", url: "/v1/resources" })).json().resources as StellariumResource[];
            expect(resources.map(resource => resource.name)).toEqual(["Weather"]);
            const call = await run('request R {\n  const counter: com.example.CountGreetings\n  return counter.run()\n}');
            expect(call.statusCode).toBe(422);
        });

        test("publishes from a contract only if it succeeds", async () => {
            await deploy(COUNTER);
            await deploy('contract com.example.Greet(who: string, fail: boolean): string {\n  emit com.example.Greeted(who: who, times: 1)\n  if (fail) {\n    var x: int32 = "no"\n  }\n  return who\n}');

            const call = (fail: boolean) => run(`request R {\n  const greet: com.example.Greet\n  return greet.run(who: "Bo", fail: ${fail})\n}`);
            expect((await call(true)).json().returnValue.error.message).toContain("failed");
            expect((await call(false)).json().returnValue).toEqual({ value: "Bo", error: null });

            await service.eventService.processInbox();
            const { count, last } = await state();
            expect(count).toBe(1);
            expect(last).toMatchObject({ who: "Bo", times: 1 });
        });

        test("refuses to emit for anyone but the node's own organization", async () => {
            const other = await run(GREET, await runToken(OTHER_ORGANIZATION));
            expect(other.statusCode).toBe(422);
            expect(other.json().details).toContain(`Only ${ORGANIZATION}'s scripts`);

            const deployed = await deploy('contract com.example.Greet: int32 {\n  emit com.example.Greeted(who: "x", times: 1)\n  return 1\n}', await runToken(OTHER_ORGANIZATION));
            expect(deployed.statusCode).toBe(403);
        });

        test("refuses to emit without a membership token, an unknown type, or too many events", async () => {
            const unknown = await run('request R {\n  emit com.example.Missing(x: 1)\n}');
            expect(unknown.json().details).toContain("Unknown event 'com.example.Missing'");

            config.maxEventsPerRun = 1;
            const many = await run('request R {\n  emit com.example.Greeted(who: "a", times: 1)\n  emit com.example.Greeted(who: "b", times: 2)\n}');
            expect(many.json().details).toContain("at most 1 events");

            config.maxEventDataBytes = 10;
            const big = await run(GREET);
            expect(big.statusCode).toBe(422);
            expect(big.json().details).toContain("bytes of data");

            config.membershipToken = undefined;
            config.maxEventDataBytes = undefined;
            const unproven = await run(GREET);
            expect(unproven.json().details).toContain("no session with the operator");
        });

        test("bills another organization's event contract under the mandate its client grants", async () => {
            const deployed = await deploy(COUNTER, await runToken(OTHER_ORGANIZATION));
            expect(deployed.statusCode).toBe(201);
            expect(spies.createEventMandate).toHaveBeenCalledWith({ token: expect.any(String), consumer: "com.example.CountGreetings" });

            await run(GREET);
            await service.eventService.processInbox();
            await flushSettlement();

            expect(spies.authorizeEventRun).toHaveBeenCalledWith({ mandateId: "mnd_test", runId: expect.any(String), source: COUNTER });
            const [{ runId }] = spies.authorizeEventRun.mock.calls[0] as [{ runId: string }];
            expect(spies.captureRun).toHaveBeenCalledWith({ runId, tokens: expect.any(Number) });
            expect((await state()).count).toBe(1);
        });

        test("retries an event contract whose run the operator refuses for its balance, and gives up on a revoked mandate", async () => {
            await deploy(COUNTER, await runToken(OTHER_ORGANIZATION));
            spies.authorizeEventRun.mockResolvedValueOnce({ ok: false, status: 402, error: "Insufficient balance" });
            await run(GREET);

            await service.eventService.processInbox();
            expect(await inbox()).toEqual([expect.objectContaining({ status: "pending", attempts: 1, lastError: "Insufficient balance" })]);
            await service.eventService.processInbox(Date.now() + 60_000);
            expect(await inbox()).toEqual([expect.objectContaining({ status: "done" })]);

            spies.authorizeEventRun.mockResolvedValueOnce({ ok: false, status: 403, error: "The event mandate has been revoked" });
            await run(GREET);
            await service.eventService.processInbox();
            expect((await inbox())[0]).toMatchObject({ status: "failed", lastError: "The event mandate has been revoked" });
        });

        test("refuses a mandate the operator refuses", async () => {
            spies.createEventMandate.mockResolvedValueOnce({ ok: false, status: 403, error: "Node is not listed" });
            const response = await deploy(COUNTER, await runToken(OTHER_ORGANIZATION));
            expect(response.statusCode).toBe(403);
            expect((await fastify.inject({ method: "GET", url: "/v1/contracts" })).json().contracts).toEqual([]);
        });

        test.each([
            ["an unknown event type", "contract com.example.On consumes com.example.Missing {\n  return\n}", 400, "doesn't know"],
            ["its own event", "contract com.example.On consumes com.example.Greeted {\n  emit com.example.Greeted(who: who, times: times)\n}", 400, "the event it consumes"],
        ])("refuses an event contract consuming %s", async (_, source, status, error) => {
            const response = await deploy(source);
            expect(response.statusCode).toBe(status);
            expect(response.json().error).toContain(error);
        });

        test("keeps a contract an event contract, or not, across versions", async () => {
            await deploy(COUNTER);
            expect((await deploy("contract com.example.CountGreetings@2: int32 {\n  return 1\n}")).statusCode).toBe(409);
            await deploy("contract com.example.Sum: int32 {\n  return 1\n}");
            expect((await deploy("contract com.example.Sum@2 consumes com.example.Greeted {\n  return\n}")).statusCode).toBe(409);
        });

        test("delivers a restricted event only to its owner's event contracts", async () => {
            await declare(RESTRICTED);
            const consumer = "contract com.example.OnAudit consumes com.example.Audit {\n  var state seen: int32 = 0\n  seen = seen + 1\n}";

            expect((await deploy(consumer, await runToken(OTHER_ORGANIZATION))).statusCode).toBe(403);
            expect((await deploy(consumer)).statusCode).toBe(201);
            await run('request R {\n  emit com.example.Audit(entry: "x")\n}');
            await service.eventService.processInbox();
            expect((await state("com.example.OnAudit")).seen).toBe(1);
        });

        test("stops a chain from emitting an event type already in it", async () => {
            await declare("event com.example.Answered(who: string)");
            await deploy("contract com.example.Answer consumes com.example.Greeted {\n  emit com.example.Answered(who: who)\n}");
            await deploy("contract com.example.Echo consumes com.example.Answered {\n  emit com.example.Greeted(who: who, times: 1)\n}");
            await deploy(COUNTER);

            await run(GREET);
            // Greeted runs Answer and CountGreetings, Answered runs Echo, whose Greeted is refused.
            await service.eventService.processInbox();
            await service.eventService.processInbox();

            expect((await state()).count).toBe(1);
            const echo = (await inbox()).find((item: { target: string }) => item.target === "com.example.Echo");
            expect(echo).toMatchObject({ status: "pending", lastError: expect.stringContaining("earlier in this chain of events") });
        });

        test("stops a chain from calling a contract already in it", async () => {
            await deploy('contract com.example.Greet: int32 {\n  emit com.example.Greeted(who: "x", times: 1)\n  return 1\n}');
            await deploy("contract com.example.CallBack consumes com.example.Greeted {\n  const greet: com.example.Greet\n  var result = greet.run()\n  var state error: string = \"\"\n  error = result.error.message\n}");

            await run('request R {\n  const greet: com.example.Greet\n  return greet.run()\n}');
            await service.eventService.processInbox();

            expect((await state("com.example.CallBack")).error).toContain("earlier in this chain of events");
        });

        test("stops a chain past the most events deep", async () => {
            const event = await peerEvent({ type: "com.example.Greeted", ownerOrganizationId: ORGANIZATION, data: { who: "x", times: 1 }, depth: MAX_EVENT_DEPTH }, { publicKey: config.publicKey, privateKey: config.privateKey }, ORGANIZATION);
            await declare("event com.example.Answered(who: string)");
            await deploy("contract com.example.Answer consumes com.example.Greeted {\n  emit com.example.Answered(who: who)\n}");

            expect((await fastify.inject({ method: "POST", url: "/v1/events/deliver", payload: event })).statusCode).toBe(202);
            await service.eventService.processInbox();

            expect((await inbox())[0]).toMatchObject({ status: "pending", lastError: expect.stringContaining(`at most ${MAX_EVENT_DEPTH} deep`) });
        });
    });

    describe("between nodes", () => {
        const onPing = "contract com.example.OnPing consumes com.example.Pinged {\n  var state last: string = \"\"\n  last = note\n  var state count: int32 = 0\n  count = count + 1\n}";

        test("learns a peer's event types and event contracts from its signed announcement", async () => {
            const response = await announce(await peerAnnouncement({
                eventTypes: [pinged, { ...pinged, name: "Forged", ownerOrganizationId: ORGANIZATION }],
                subscriptions: [{ eventPath: "com.example", eventName: "Greeted", eventVersion: "1", consumer: "com.example.Listen", ownerOrganizationId: OTHER_ORGANIZATION }],
            }));

            expect(response.statusCode).toBe(200);
            // The peer's token says it belongs to org_other, so it can't announce org_provider's types.
            expect(response.json()).toEqual({ success: true, rejected: ["com.example.Forged@1"] });
            expect((await fastify.inject({ method: "GET", url: "/v1/events" })).json().eventTypes).toEqual([expect.objectContaining({ name: "Pinged", baseUrl: peerUrl, ownerOrganizationId: OTHER_ORGANIZATION })]);
        });

        test("learns no event types without a membership token, and refuses a bad signature or an unknown peer", async () => {
            expect((await announce(await peerAnnouncement({ eventTypes: [pinged], membershipToken: null }))).json().rejected).toEqual(["com.example.Pinged@1"]);
            expect((await announce({ ...await peerAnnouncement({ eventTypes: [pinged] }), expiry: new Date(Date.now() + 1000).toISOString() })).statusCode).toBe(400);
            expect((await announce({ ...await peerAnnouncement({}), publicKey: generateBase64KeyPair().publicKey })).statusCode).toBe(400);
        });

        test("runs its event contract once per event a peer delivers", async () => {
            await announce(await peerAnnouncement({ eventTypes: [pinged] }));
            expect((await deploy(onPing)).statusCode).toBe(201);
            const event = await peerEvent();

            const deliver = () => fastify.inject({ method: "POST", url: "/v1/events/deliver", payload: event });
            expect((await deliver()).json()).toEqual({ accepted: 1 });
            expect((await deliver()).statusCode).toBe(202);
            await service.eventService.processInbox();

            expect(await state("com.example.OnPing")).toMatchObject({ count: 1, last: "hi" });
        });

        test.each([
            ["a tampered event", async () => ({ ...await peerEvent(), data: { note: "changed" } }), 401],
            ["a publisher outside the owner organization", async () => peerEvent({ membershipToken: await membership(peer.publicKey, "org_elsewhere") }), 403],
            ["another node's membership token", async () => peerEvent({ membershipToken: await membership(generateBase64KeyPair().publicKey, OTHER_ORGANIZATION) }), 403],
            ["a run token as the membership token", async () => peerEvent({ membershipToken: await membership(peer.publicKey, OTHER_ORGANIZATION, { audience: "someone" }) }), 403],
            ["an event older than a day", async () => peerEvent({ publishedAt: new Date(Date.now() - EVENT_MAX_AGE_MS - 1000).toISOString() }), 400],
            ["an event too deep", async () => peerEvent({ depth: MAX_EVENT_DEPTH + 1 }), 400],
            ["an unknown event type", async () => peerEvent({ type: "com.example.Unknown" }), 409],
        ])("refuses %s", async (_, makeEvent, status) => {
            await announce(await peerAnnouncement({ eventTypes: [pinged] }));
            const response = await fastify.inject({ method: "POST", url: "/v1/events/deliver", payload: await makeEvent() });
            expect(response.statusCode).toBe(status);
        });

        test("checks the membership token at the time the event was published", async () => {
            await announce(await peerAnnouncement({ eventTypes: [pinged] }));
            const publishedAt = Date.now() - 2 * 60 * 60 * 1000;
            const old = await peerEvent({
                publishedAt: new Date(publishedAt).toISOString(),
                membershipToken: await membership(peer.publicKey, OTHER_ORGANIZATION, { issuedAt: Math.floor(publishedAt / 1000) - 60, expiresIn: Math.floor(publishedAt / 1000) + 3600 }),
            });
            const response = await fastify.inject({ method: "POST", url: "/v1/events/deliver", payload: old });
            expect(response.statusCode).toBe(202);
        });

        test("delivers its events to the peers subscribed to them, and retries a peer that fails", async () => {
            await declare(GREETED);
            await announce(await peerAnnouncement({
                subscriptions: [
                    { eventPath: "com.example", eventName: "Greeted", eventVersion: "1", consumer: "com.example.Listen", ownerOrganizationId: OTHER_ORGANIZATION },
                    { eventPath: "com.example", eventName: "Greeted", eventVersion: "1", consumer: "com.example.AlsoListen", ownerOrganizationId: OTHER_ORGANIZATION },
                ],
            }));
            const sent: EventEnvelope[] = [];
            const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
                sent.push(JSON.parse(String(init.body)));
                return sent.length === 1 ? new Response(JSON.stringify({ error: "down" }), { status: 503 }) : new Response(JSON.stringify({ accepted: 2 }), { status: 202 });
            });
            vi.stubGlobal("fetch", fetchMock);

            await run(GREET);
            expect(await service.eventService.dispatchDue()).toBe(1);
            expect(await outbox()).toEqual([expect.objectContaining({ target: peerUrl, status: "pending", attempts: 1, lastError: "503: down" })]);

            expect(await service.eventService.dispatchDue(Date.now() + 60_000)).toBe(1);
            expect(await outbox()).toEqual([expect.objectContaining({ status: "delivered" })]);
            // One delivery per node, however many of its contracts consume the event.
            expect(fetchMock).toHaveBeenCalledTimes(2);
            expect(fetchMock.mock.calls[0]![0]).toBe(`${peerUrl}/v1/events/deliver`);
            expect(sent[0]).toEqual(sent[1]);
            expect(sent[0]).toMatchObject({ type: "com.example.Greeted", version: "1", ownerOrganizationId: ORGANIZATION, data: { who: "Ada", times: 2 }, depth: 1, lineage: { types: [], contracts: [] }, publisherPublicKey: config.publicKey });
        });

        test("doesn't deliver a restricted event to another organization's event contracts, and gives up on a refusal", async () => {
            await declare(RESTRICTED);
            await declare(GREETED);
            await announce(await peerAnnouncement({
                subscriptions: [
                    { eventPath: "com.example", eventName: "Audit", eventVersion: "1", consumer: "com.example.Spy", ownerOrganizationId: OTHER_ORGANIZATION },
                    { eventPath: "com.example", eventName: "Greeted", eventVersion: "1", consumer: "com.example.Listen", ownerOrganizationId: OTHER_ORGANIZATION },
                ],
            }));
            vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: "Invalid event signature" }), { status: 401 })));

            await run('request R {\n  emit com.example.Audit(entry: "secret")\n  emit com.example.Greeted(who: "a", times: 1)\n}');
            await service.eventService.dispatchDue();

            expect(await outbox()).toEqual([expect.objectContaining({ type: "com.example.Greeted", status: "failed", attempts: 1 })]);
        });

        test("announces its event types and event contracts, signed, with its membership token", async () => {
            await declare(GREETED);
            await deploy(COUNTER);

            const announcement = (await fastify.inject({ method: "GET", url: "/v1/events/announcement" })).json() as EventAnnouncement;
            expect(announcement).toMatchObject({
                publicKey: config.publicKey,
                membershipToken: config.membershipToken,
                eventTypes: [{ path: "com.example", name: "Greeted", version: "1", ownerOrganizationId: ORGANIZATION }],
                subscriptions: [{ eventPath: "com.example", eventName: "Greeted", eventVersion: "1", consumer: "com.example.CountGreetings", ownerOrganizationId: ORGANIZATION }],
            });

            // Another node with the same operator learns them.
            const otherDb = await openTestDatabase(dialect);
            try {
                const jwk = await exportJWK(operatorKeys.publicKey);
                const other = createService(otherDb, [], testConfig({ baseUrl: "http://127.0.0.1:3998" }), { runTokenKeys: createLocalJWKSet({ keys: [{ ...jwk, alg: "EdDSA" }] }) });
                expect(await other.eventService.applyAnnouncement(announcement, config.baseUrl)).toEqual({ ok: true, rejected: [] });
                expect(await other.eventService.repository.resolveType("com.example", "Greeted")).toMatchObject({ ownerOrganizationId: ORGANIZATION, baseUrl: config.baseUrl });
                expect(await other.eventService.repository.subscribersOf("com.example", "Greeted", "1")).toEqual([expect.objectContaining({ baseUrl: config.baseUrl, consumer: "com.example.CountGreetings" })]);
            } finally {
                await otherDb.close();
            }
        });
    });

    test("reclaims work a stopped worker left claimed, and forgets settled work after a while", async () => {
        await declare(GREETED);
        await deploy(COUNTER);
        await run(GREET);
        const repository = service.eventService.repository;
        expect(await repository.claimInbox(Date.now(), 10)).toHaveLength(1);
        expect(await repository.claimInbox(Date.now(), 10)).toHaveLength(0);

        await repository.maintain(Date.now() + 1000, 0);
        expect(await service.eventService.processInbox()).toBe(1);
        expect(await inbox()).toHaveLength(1);

        await repository.maintain(0, Date.now() + 1000);
        expect(await inbox()).toEqual([]);
    });
});
