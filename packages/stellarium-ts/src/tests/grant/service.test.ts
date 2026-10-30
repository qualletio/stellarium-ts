import type { NodeDatabase as Database } from "../../db/database.js";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { type Capability, type Grant, type GrantRenewalRequest, type GrantRequest, grantHash, grantRequestPayload, signGrant } from "../../grant/grant.js";
import { signData } from "../../crypto/utils.js";
import { GrantRepository } from "../../grant/repository.js";
import { PeerRepository } from "../../peer/repository.js";
import { type ApproveGrant, GrantService, HELD_GRANT_RETENTION_MS, type InvocationTarget } from "../../grant/service.js";
import { DIALECTS, generateBase64KeyPair, openTestDatabase } from "../helpers.js";

const HOUR = 3_600_000;
const weather: Capability = { resourcePath: "com.example", resourceName: "Weather" };
const target: InvocationTarget = { resourcePath: "com.example", resourceName: "Weather", functionName: "temperature", parameters: [{ name: "city", value: "Oslo" }] };

describe.each(DIALECTS)("GrantService (%s)", (dialect) => {
    const databases: Database[] = [];
    const nodes = new Map<string, GrantService>();

    async function node(baseUrl: string, approveGrant?: ApproveGrant) {
        const db = await openTestDatabase(dialect);
        databases.push(db);
        const keys = generateBase64KeyPair();
        const service = new GrantService(new GrantRepository(db), { baseUrl, ...keys }, approveGrant);
        nodes.set(baseUrl, service);
        return { service, db, ...keys };
    }

    beforeEach(() => {
        // Grant requests and renewals reach the issuing node's service directly.
        vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
            const body = JSON.parse(init.body as string);
            const requesting = url.endsWith("/v1/grants/request");
            const issuer = nodes.get(url.replace(/\/v1\/grants\/(renew|request)$/, ""));
            const grants = requesting ? await issuer?.handleRequest(body as GrantRequest) : await issuer?.renew(body as GrantRenewalRequest);
            return grants ? new Response(JSON.stringify({ grants }), { status: 200 }) : new Response(null, { status: 403 });
        }));
    });

    afterEach(async () => {
        vi.useRealTimers();
        vi.unstubAllGlobals();
        nodes.clear();
        await Promise.all(databases.splice(0).map(db => db.close()));
    });

    test("a provider's grant lets its holder make a covered call", async () => {
        const provider = await node("http://provider");
        const caller = await node("http://caller");

        await caller.service.add(await provider.service.issue(caller.publicKey, [weather], { lifetimeMs: HOUR }));
        const chain = await caller.service.chainFor("http://provider", target);
        expect(chain).toHaveLength(1);

        const authorization = caller.service.authorize(chain!, target);
        expect(await provider.service.verifyInvocation(authorization, target)).toBe(true);
    });

    test("refuses a reused nonce, another call, another signer and a revoked grant", async () => {
        const provider = await node("http://provider");
        const caller = await node("http://caller");
        const [grant] = await provider.service.issue(caller.publicKey, [weather], { lifetimeMs: HOUR });

        const authorization = caller.service.authorize([grant], target);
        expect(await provider.service.verifyInvocation(authorization, target)).toBe(true);
        expect(await provider.service.verifyInvocation(authorization, target)).toBe(false);

        const otherCall = { ...target, parameters: [{ name: "city", value: "Paris" }] };
        expect(await provider.service.verifyInvocation(caller.service.authorize([grant], target), otherCall)).toBe(false);

        const thief = await node("http://thief");
        expect(await provider.service.verifyInvocation(thief.service.authorize([grant], target), target)).toBe(false);

        await provider.service.revoke(grant.id);
        expect(await provider.service.verifyInvocation(caller.service.authorize([grant], target), target)).toBe(false);
    });

    test("refuses a chain rooted at another node and a call outside the grant", async () => {
        const provider = await node("http://provider");
        const impostor = await node("http://impostor");
        const caller = await node("http://caller");

        const forged = await impostor.service.issue(caller.publicKey, [weather], { lifetimeMs: HOUR });
        expect(await provider.service.verifyInvocation(caller.service.authorize(forged, target), target)).toBe(false);

        const narrow = await provider.service.issue(caller.publicKey, [{ ...weather, functionName: "humidity" }], { lifetimeMs: HOUR });
        expect(await provider.service.verifyInvocation(caller.service.authorize(narrow, target), target)).toBe(false);
    });

    test("add refuses a chain addressed to another node or with a bad signature", async () => {
        const provider = await node("http://provider");
        const caller = await node("http://caller");
        const other = await node("http://other");

        await expect(caller.service.add(await provider.service.issue(other.publicKey, [weather], { lifetimeMs: HOUR }))).rejects.toThrow("not addressed");
        const [grant] = await provider.service.issue(caller.publicKey, [weather], { lifetimeMs: HOUR });
        await expect(caller.service.add([{ ...grant, capabilities: [{ resourcePath: "*" }] }])).rejects.toThrow("Invalid grant chain");
    });

    test("delegates a narrower grant that the provider accepts", async () => {
        const provider = await node("http://provider");
        const gateway = await node("http://gateway");
        const user = await node("http://user");

        const [root] = await provider.service.issue(gateway.publicKey, [{ resourcePath: "com.*" }], { lifetimeMs: HOUR });
        await gateway.service.add([root]);

        await expect(gateway.service.delegate(root.id, user.publicKey, [{ resourcePath: "org.*" }], { lifetimeMs: HOUR })).rejects.toThrow("narrow");

        const chain = await gateway.service.delegate(root.id, user.publicKey, [weather], { lifetimeMs: 2 * HOUR });
        expect(chain).toHaveLength(2);
        // Capped at the parent's expiry.
        expect(chain[1].expiresAt).toBe(root.expiresAt);
        await user.service.add(chain);

        const held = await user.service.chainFor("http://provider", target);
        expect(await provider.service.verifyInvocation(user.service.authorize(held!, target), target)).toBe(true);

        // Revoking the root at the provider cuts off everything delegated from it.
        await provider.service.revoke(root.id);
        expect(await provider.service.verifyInvocation(user.service.authorize(held!, target), target)).toBe(false);
    });

    test("renewal keeps the grant id, and is refused once revoked or past renewableUntil", async () => {
        vi.useFakeTimers({ toFake: ["Date"] });
        const provider = await node("http://provider");
        const caller = await node("http://caller");
        const [grant] = await provider.service.issue(caller.publicKey, [weather], { lifetimeMs: HOUR, renewableUntil: new Date(Date.now() + 3 * HOUR).toISOString() });
        await caller.service.add([grant]);

        vi.setSystemTime(Date.now() + 0.4 * HOUR);
        expect(await caller.service.refreshDue()).toEqual({ renewed: [], failed: [], removed: [] });

        vi.setSystemTime(Date.now() + 0.2 * HOUR);
        expect(await caller.service.refreshDue()).toEqual({ renewed: [grant.id], failed: [], removed: [] });
        const [renewed] = (await caller.service.chainFor("http://provider", target))!;
        expect(renewed.id).toBe(grant.id);
        expect(Date.parse(renewed.expiresAt)).toBeGreaterThan(Date.parse(grant.expiresAt));

        vi.setSystemTime(Date.now() + 3 * HOUR);
        const { failed } = await caller.service.refreshDue();
        expect(failed).toEqual([{ id: grant.id, error: expect.stringContaining("refused") }]);

        const [revocable] = await provider.service.issue(caller.publicKey, [weather], { lifetimeMs: HOUR });
        await caller.service.add([revocable]);
        await provider.service.revoke(revocable.id);
        vi.setSystemTime(Date.now() + 0.6 * HOUR);
        expect((await caller.service.refreshDue()).failed.map(f => f.id)).toContain(revocable.id);
    });

    test("deletes a chain that is still refused long after it expired", async () => {
        vi.useFakeTimers({ toFake: ["Date"] });
        const provider = await node("http://provider");
        const caller = await node("http://caller");
        const [grant] = await provider.service.issue(caller.publicKey, [weather], { lifetimeMs: HOUR });
        await caller.service.add([grant]);
        await provider.service.revoke(grant.id);

        vi.setSystemTime(Date.now() + 2 * HOUR);
        expect((await caller.service.refreshDue()).removed).toEqual([]);

        vi.setSystemTime(Date.now() + HELD_GRANT_RETENTION_MS);
        expect(await caller.service.refreshDue()).toEqual({ renewed: [], failed: [], removed: [grant.id] });
        expect(await caller.service.refreshDue()).toEqual({ renewed: [], failed: [], removed: [] });
    });

    test("an expired chain is renewed when it is needed", async () => {
        vi.useFakeTimers({ toFake: ["Date"] });
        const provider = await node("http://provider");
        const caller = await node("http://caller");
        await caller.service.add(await provider.service.issue(caller.publicKey, [weather], { lifetimeMs: HOUR }));

        vi.setSystemTime(Date.now() + 2 * HOUR);
        const chain = await caller.service.chainFor("http://provider", target);

        expect(chain).toHaveLength(1);
        expect(Date.parse(chain![0].expiresAt)).toBeGreaterThan(Date.now());
        expect(fetch).toHaveBeenCalledOnce();
    });

    test("a delegated grant is renewed against the delegator's current parent", async () => {
        vi.useFakeTimers({ toFake: ["Date"] });
        const provider = await node("http://provider");
        const gateway = await node("http://gateway");
        const user = await node("http://user");

        const [root] = await provider.service.issue(gateway.publicKey, [weather], { lifetimeMs: HOUR });
        await gateway.service.add([root]);
        await user.service.add(await gateway.service.delegate(root.id, user.publicKey, [weather], { lifetimeMs: HOUR }));

        vi.setSystemTime(Date.now() + 0.6 * HOUR);
        expect((await gateway.service.refreshDue()).renewed).toEqual([root.id]);
        expect((await user.service.refreshDue()).failed).toEqual([]);

        const chain = (await user.service.chainFor("http://provider", target))!;
        const freshRoot = (await gateway.service.chainFor("http://provider", target))![0];
        expect(chain[0]).toEqual(freshRoot);
        expect(await provider.service.verifyInvocation(user.service.authorize(chain, target), target)).toBe(true);
    });

    test("accepts an authorization from a caller whose clock runs a little ahead", async () => {
        vi.useFakeTimers({ toFake: ["Date"] });
        const provider = await node("http://provider");
        const caller = await node("http://caller");
        const [grant] = await provider.service.issue(caller.publicKey, [weather], { lifetimeMs: HOUR });

        vi.setSystemTime(Date.now() + 10_000);
        const authorization = caller.service.authorize([grant], target);
        vi.setSystemTime(Date.now() - 10_000);

        expect(await provider.service.verifyInvocation(authorization, target)).toBe(true);
    });

    test("remembers accepted nonces across a restart", async () => {
        const provider = await node("http://provider");
        const caller = await node("http://caller");
        const [grant] = await provider.service.issue(caller.publicKey, [weather], { lifetimeMs: HOUR });
        const authorization = caller.service.authorize([grant], target);
        expect(await provider.service.verifyInvocation(authorization, target)).toBe(true);

        const restarted = new GrantService(new GrantRepository(databases[0]), { baseUrl: "http://provider", publicKey: provider.publicKey, privateKey: provider.privateKey });
        expect(await restarted.verifyInvocation(authorization, target)).toBe(false);
    });

    test("keeps chains from different issuers that reuse a grant id", async () => {
        const provider = await node("http://provider");
        const other = await node("http://other");
        const caller = await node("http://caller");
        const [grant] = await provider.service.issue(caller.publicKey, [weather], { lifetimeMs: HOUR });
        const colliding = { ...grant, issuer: other.publicKey, issuerBaseUrl: "http://other" };
        const forged = signGrant(colliding, other.privateKey);

        await caller.service.add([grant]);
        await caller.service.add([forged]);

        expect(await caller.service.chainFor("http://provider", target)).toEqual([grant]);
        expect(await caller.service.chainFor("http://other", target)).toEqual([forged]);
        await expect(caller.service.delegate(grant.id, "key", [weather], { lifetimeMs: HOUR })).rejects.toThrow("name the issuer");
        expect(await caller.service.delegate({ issuer: provider.publicKey, id: grant.id }, "key", [weather], { lifetimeMs: HOUR })).toHaveLength(2);
    });

    test("tries at most one renewal when every matching chain has expired", async () => {
        vi.useFakeTimers({ toFake: ["Date"] });
        const provider = await node("http://provider");
        const caller = await node("http://caller");
        for (let i = 0; i < 3; i++) {
            const [grant] = await provider.service.issue(caller.publicKey, [weather], { lifetimeMs: HOUR });
            await caller.service.add([grant]);
            await provider.service.revoke(grant.id);
        }

        vi.setSystemTime(Date.now() + 2 * HOUR);
        expect(await caller.service.chainFor("http://provider", target)).toBeUndefined();
        expect(fetch).toHaveBeenCalledOnce();
    });

    test("a revocation names the grant's issuer, so another issuer's grant with the same id is unaffected", async () => {
        const provider = await node("http://provider");
        const gateway = await node("http://gateway");
        const user = await node("http://user");
        const [root] = await provider.service.issue(gateway.publicKey, [weather], { lifetimeMs: HOUR });
        await gateway.service.add([root]);
        const chain = await gateway.service.delegate(root.id, user.publicKey, [weather], { lifetimeMs: HOUR });

        // Revoking the root's id under the gateway's key, as when the gateway reuses that id for its own grant, must not hit the root.
        await provider.service.revoke({ issuer: gateway.publicKey, id: root.id });
        expect(await provider.service.verifyInvocation(user.service.authorize(chain, target), target)).toBe(true);

        await provider.service.revoke({ issuer: gateway.publicKey, id: chain[1].id });
        expect(await provider.service.verifyInvocation(user.service.authorize(chain, target), target)).toBe(false);
    });

    test("copies expire by renewableUntil, and a past renewableUntil is refused", async () => {
        vi.useFakeTimers({ toFake: ["Date"] });
        const provider = await node("http://provider");
        const caller = await node("http://caller");
        const renewableUntil = new Date(Date.now() + 1.5 * HOUR).toISOString();
        const [grant] = await provider.service.issue(caller.publicKey, [weather], { lifetimeMs: 2 * HOUR, renewableUntil });
        expect(grant.expiresAt).toBe(renewableUntil);

        const [short] = await provider.service.issue(caller.publicKey, [weather], { lifetimeMs: HOUR, renewableUntil });
        await caller.service.add([short]);
        vi.setSystemTime(Date.now() + 0.9 * HOUR);
        expect((await caller.service.refreshDue()).renewed).toEqual([short.id]);
        const [renewed] = (await caller.service.chainFor("http://provider", target))!;
        expect(renewed.expiresAt).toBe(renewableUntil);

        await expect(provider.service.issue("key", [weather], { lifetimeMs: HOUR, renewableUntil: new Date(Date.now() - 1).toISOString() })).rejects.toThrow("renewableUntil");
    });

    test("seed keeps a stored renewal and skips an expired chain", async () => {
        vi.useFakeTimers({ toFake: ["Date"] });
        const provider = await node("http://provider");
        const caller = await node("http://caller");
        const configured = await provider.service.issue(caller.publicKey, [weather], { lifetimeMs: HOUR });
        expect(await caller.service.seed(configured)).toBe(true);

        vi.setSystemTime(Date.now() + 0.6 * HOUR);
        await caller.service.refreshDue();
        const renewed = (await caller.service.chainFor("http://provider", target))!;
        expect(renewed[0].expiresAt).not.toBe(configured[0].expiresAt);

        // A restart passes the configured chain again, after it has expired but while the renewal hasn't.
        vi.setSystemTime(Date.now() + 0.5 * HOUR);
        expect(await caller.service.seed(configured)).toBe(true);
        expect(await caller.service.chainFor("http://provider", target)).toEqual(renewed);

        const fresh = await node("http://fresh");
        expect(await fresh.service.seed(configured)).toBe(false);
        expect(await fresh.service.chainFor("http://provider", target)).toBeUndefined();
        await expect(fresh.service.seed([{ ...configured[0], expiresAt: new Date(Date.now() + HOUR).toISOString() }])).rejects.toThrow("Invalid grant chain");
    });

    test("refuses a renewal that swaps in a different chain ending in the same id", async () => {
        const provider = await node("http://provider");
        const gateway = await node("http://gateway");
        const middle = await node("http://middle");
        const user = await node("http://user");
        const [root] = await provider.service.issue(gateway.publicKey, [weather], { lifetimeMs: HOUR });
        await gateway.service.add([root]);
        const chain = await gateway.service.delegate(root.id, user.publicKey, [weather], { lifetimeMs: HOUR });
        await user.service.add(chain);

        const [, toMiddle] = await gateway.service.delegate(root.id, middle.publicKey, [weather], { lifetimeMs: HOUR });
        const swapped: Grant = signGrant({ ...chain[1], issuer: middle.publicKey, issuerBaseUrl: "http://middle", parent: grantHash(toMiddle) }, middle.privateKey);
        vi.mocked(fetch).mockResolvedValueOnce(new Response(JSON.stringify({ grants: [root, toMiddle, swapped] }), { status: 200 }));

        vi.useFakeTimers({ toFake: ["Date"] });
        vi.setSystemTime(Date.now() + 0.6 * HOUR);
        const { failed } = await user.service.refreshDue();
        expect(failed).toEqual([{ id: chain[1].id, error: expect.stringContaining("invalid chain") }]);
        expect(await user.db.get("SELECT COUNT(*) AS count FROM held_grant")).toEqual({ count: 1 });
    });

    test("prefers a chain rooted at the provider's known key", async () => {
        const provider = await node("http://provider");
        const impostor = await node("http://impostor");
        const caller = await node("http://caller");
        const genuine = await provider.service.issue(caller.publicKey, [weather], { lifetimeMs: HOUR });
        // Rooted at the provider's URL, but signed by another key, and expiring later.
        const stale = signGrant({ ...genuine[0], id: "stale", issuer: impostor.publicKey, expiresAt: new Date(Date.now() + 2 * HOUR).toISOString() }, impostor.privateKey);
        await caller.service.add(genuine);
        await caller.service.add([stale]);
        expect(await caller.service.chainFor("http://provider", target)).toEqual([stale]);

        await new PeerRepository(caller.db).create({ baseUrl: "http://provider", name: "provider", publicKey: provider.publicKey });
        expect(await caller.service.chainFor("http://provider", target)).toEqual(genuine);
    });

    test("issue and delegate check their options", async () => {
        const provider = await node("http://provider");
        await expect(provider.service.issue("key", [weather], { lifetimeMs: 0 })).rejects.toThrow("lifetimeMs");
        await expect(provider.service.issue("key", [weather], { lifetimeMs: 31 * 24 * HOUR })).rejects.toThrow("lifetimeMs");
        await expect(provider.service.issue("key", [weather], { lifetimeMs: HOUR, renewableUntil: "soon" })).rejects.toThrow("renewableUntil");
        await expect(provider.service.delegate("missing", "key", [weather], { lifetimeMs: HOUR })).rejects.toThrow("No held grant missing");
        await expect(provider.service.issue("key", [], { lifetimeMs: HOUR })).rejects.toThrow("capabilities");
        await expect(provider.service.issue("key", [{ resourcePath: "" }], { lifetimeMs: HOUR })).rejects.toThrow("capabilities");
    });

    describe("grant requests", () => {
        const signedRequest = (keys: { publicKey: string, privateKey: string }, overrides: Partial<Omit<GrantRequest, "signature">> = {}): GrantRequest => {
            const unsigned = { publicKey: keys.publicKey, capabilities: [weather], details: null, nonce: crypto.randomUUID(), expiresAt: new Date(Date.now() + 60_000).toISOString(), ...overrides };
            return { ...unsigned, signature: signData(grantRequestPayload(unsigned), keys.privateKey) };
        };

        test("an approved request yields a grant the provider accepts", async () => {
            const approveGrant = vi.fn<ApproveGrant>(({ details }) => details?.invite === "letmein" ? { lifetimeMs: HOUR } : undefined);
            const provider = await node("http://provider", approveGrant);
            const caller = await node("http://caller");

            const chain = await caller.service.request("http://provider", [weather], { invite: "letmein" });

            expect(approveGrant).toHaveBeenCalledExactlyOnceWith({ publicKey: caller.publicKey, capabilities: [weather], details: { invite: "letmein" } });
            expect(chain).toEqual([expect.objectContaining({ audience: caller.publicKey, issuer: provider.publicKey, capabilities: [weather] })]);
            const held = await caller.service.chainFor("http://provider", target);
            expect(await provider.service.verifyInvocation(caller.service.authorize(held!, target), target)).toBe(true);
        });

        test("a refused request throws on the caller and stores nothing", async () => {
            await node("http://provider", () => undefined);
            const caller = await node("http://caller");

            await expect(caller.service.request("http://provider", [weather])).rejects.toThrow("refused");
            expect(await caller.service.chainFor("http://provider", target)).toBeUndefined();
        });

        test("the hook can grant narrower capabilities than requested", async () => {
            const narrow = { ...weather, functionName: "humidity" };
            const provider = await node("http://provider", () => ({ lifetimeMs: HOUR, capabilities: [narrow] }));
            const caller = await node("http://caller");

            const [grant] = await caller.service.request("http://provider", [weather]);

            expect(grant.capabilities).toEqual([narrow]);
            expect(await provider.service.verifyInvocation(caller.service.authorize([grant], target), target)).toBe(false);
        });

        test("without a hook every request is refused", async () => {
            const provider = await node("http://provider");
            const caller = await node("http://caller");

            expect(provider.service.acceptsRequests).toBe(false);
            expect(await provider.service.handleRequest(signedRequest(caller))).toBeUndefined();
        });

        test("the hook only sees signed, fresh, well-formed requests, each once", async () => {
            const approveGrant = vi.fn<ApproveGrant>(() => ({ lifetimeMs: HOUR }));
            const provider = await node("http://provider", approveGrant);
            const caller = await node("http://caller");

            expect(await provider.service.handleRequest({ ...signedRequest(caller), signature: "forged" })).toBeUndefined();
            expect(await provider.service.handleRequest({ ...signedRequest(caller), publicKey: generateBase64KeyPair().publicKey })).toBeUndefined();
            expect(await provider.service.handleRequest(signedRequest(caller, { expiresAt: new Date(Date.now() - 1).toISOString() }))).toBeUndefined();
            expect(await provider.service.handleRequest(signedRequest(caller, { expiresAt: new Date(Date.now() + HOUR).toISOString() }))).toBeUndefined();
            expect(await provider.service.handleRequest(signedRequest(caller, { capabilities: [{ resourcePath: 3 }] as unknown as Capability[] }))).toBeUndefined();
            expect(await provider.service.handleRequest(signedRequest(caller, { details: ["list"] as unknown as Record<string, unknown> }))).toBeUndefined();
            expect(approveGrant).not.toHaveBeenCalled();

            const request = signedRequest(caller);
            expect(await provider.service.handleRequest(request)).toHaveLength(1);
            expect(await provider.service.handleRequest(request)).toBeUndefined();
            expect(approveGrant).toHaveBeenCalledOnce();
        });

        test("a request without details is signed and checked as null details", async () => {
            const approveGrant = vi.fn<ApproveGrant>(() => ({ lifetimeMs: HOUR }));
            const provider = await node("http://provider", approveGrant);
            const caller = await node("http://caller");
            const { details: _, ...withoutDetails } = signedRequest(caller);

            expect(await provider.service.handleRequest(withoutDetails)).toHaveLength(1);
            expect(approveGrant).toHaveBeenCalledWith(expect.objectContaining({ details: null }));
        });

        test("a hook returning invalid options or capabilities is an error, not a grant", async () => {
            const caller = await node("http://caller");
            const badLifetime = await node("http://bad-lifetime", () => ({ lifetimeMs: -1 }));
            const badCapabilities = await node("http://bad-capabilities", () => ({ lifetimeMs: HOUR, capabilities: [] }));

            await expect(badLifetime.service.handleRequest(signedRequest(caller))).rejects.toThrow("lifetimeMs");
            await expect(badCapabilities.service.handleRequest(signedRequest(caller))).rejects.toThrow("invalid approval");
        });
    });

    describe("blocking callers", () => {
        test("refuses a blocked caller's calls, renewals and requests until unblocked", async () => {
            const provider = await node("http://provider", () => ({ lifetimeMs: HOUR }));
            const caller = await node("http://caller");
            await caller.service.add(await provider.service.issue(caller.publicKey, [weather], { lifetimeMs: HOUR }));
            const chain = (await caller.service.chainFor("http://provider", target))!;

            await provider.service.block(caller.publicKey, "abuse");

            expect(await provider.service.isBlocked(caller.publicKey)).toBe(true);
            expect(await provider.service.verifyInvocation(caller.service.authorize(chain, target), target)).toBe(false);
            vi.useFakeTimers({ toFake: ["Date"] });
            vi.setSystemTime(Date.now() + 0.6 * HOUR);
            expect((await caller.service.refreshDue()).failed).toHaveLength(1);
            await expect(caller.service.request("http://provider", [weather])).rejects.toThrow("refused");

            expect(await provider.service.unblock(caller.publicKey)).toBe(true);
            expect(await provider.service.unblock(caller.publicKey)).toBe(false);
            expect((await caller.service.refreshDue()).renewed).toHaveLength(1);
            const renewed = (await caller.service.chainFor("http://provider", target))!;
            expect(await provider.service.verifyInvocation(caller.service.authorize(renewed, target), target)).toBe(true);
        });

        test("blocking a delegator cuts off the grants it handed on", async () => {
            const provider = await node("http://provider");
            const gateway = await node("http://gateway");
            const user = await node("http://user");
            const [root] = await provider.service.issue(gateway.publicKey, [weather], { lifetimeMs: HOUR });
            await gateway.service.add([root]);
            const chain = await gateway.service.delegate(root.id, user.publicKey, [weather], { lifetimeMs: HOUR });

            await provider.service.block(gateway.publicKey);

            expect(await provider.service.verifyInvocation(user.service.authorize(chain, target), target)).toBe(false);
        });

        test("lists blocked callers in order and keeps the first block time", async () => {
            vi.useFakeTimers({ toFake: ["Date"] });
            const provider = await node("http://provider");
            const [first, second] = [generateBase64KeyPair().publicKey, generateBase64KeyPair().publicKey];

            await provider.service.block(first, "spam");
            vi.setSystemTime(Date.now() + 1000);
            await provider.service.block(second);
            const [{ blockedAt }] = await provider.service.getBlocked(0, 1);
            await provider.service.block(first, "still spam");

            expect(await provider.service.getBlocked(0, 10)).toEqual([
                { publicKey: first, reason: "still spam", blockedAt },
                { publicKey: second, reason: null, blockedAt: expect.any(String) },
            ]);
            expect(await provider.service.getBlocked(1, 10)).toHaveLength(1);
        });

        test("refuses to block something that is not a public key", async () => {
            const provider = await node("http://provider");
            await expect(provider.service.block("not-a-key")).rejects.toThrow("Invalid public key");
        });
    });

    test("a renewal request must be signed by the grant's audience", async () => {
        const provider = await node("http://provider");
        const caller = await node("http://caller");
        const [grant] = await provider.service.issue(caller.publicKey, [weather], { lifetimeMs: HOUR });
        const request = { grantId: grant.id, publicKey: caller.publicKey, nonce: "n", expiresAt: new Date(Date.now() + 60_000).toISOString(), signature: "bad" };

        expect(await provider.service.renew(request)).toBeUndefined();
    });
});
