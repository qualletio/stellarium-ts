import { describe, expect, test, vi } from "vitest";
import type { NodeDatabase as Database } from "../../db/database.js";
import type { MoneyReadRequest, MoneyStageRequest, OperatorClient } from "../../client/operatorClient.js";
import { signData } from "../../crypto/utils.js";
import { ACCOUNT_RESOURCE, AccountService, type AccountSession, MoneyRun, RANDOM_RESOURCE } from "../../money/account.js";
import { PeerRepository } from "../../peer/repository.js";
import { CombinationResourceInvoker } from "../../resource/invoker.js";
import { resourceAnnouncementPayload, ResourceRepository, type StellariumResource } from "../../resource/repository.js";
import { StellariumNode } from "../../server.js";
import { DIALECTS, generateBase64KeyPair, openTestDatabase } from "../helpers.js";

const RUN = "8f6f3f8e-56a1-4c4e-9f4b-2b8c5f0d9a11";

/** An operator that records what it is asked, and answers every stage with `result` and every read with `response`. */
function fakeOperator(answers: { result?: number | boolean | null, response?: unknown, refuse?: string } = {}) {
    const staged: MoneyStageRequest[] = [];
    const read: MoneyReadRequest[] = [];
    const opened: string[] = [];
    const refusal = { ok: false as const, status: 422, error: answers.refuse ?? "" };
    const client = {
        stageMoney: vi.fn(async (request: MoneyStageRequest) => {
            staged.push(request);
            return answers.refuse ? refusal : { ok: true as const, result: answers.result ?? null };
        }),
        readMoney: vi.fn(async (request: MoneyReadRequest) => {
            read.push(request);
            return answers.refuse ? refusal : { ok: true as const, read: { response: answers.response ?? 0, signedAt: "now", signature: "sig", publicKey: "key" } };
        }),
        openRun: vi.fn(async ({ runId }: { runId: string }) => {
            opened.push(runId);
            return { ok: true as const };
        }),
    };
    return { client: client as unknown as OperatorClient, staged, read, opened };
}

const session = (run = new MoneyRun(RUN)): AccountSession => ({ run, contract: { name: "com.example.Job", version: "1" } });
const call = (name: string, value: unknown) => ({ name, value });

describe("AccountService", () => {
    test("stages pay, tryPay and refund on the contract's run, counting call indexes", async () => {
        const operator = fakeOperator({ result: 4_000 });
        const account = new AccountService(operator.client);
        const s = session();
        expect(await account.invoke(s, "pay", [call("to", "org_b"), call("amount", 1_000), call("from", "org_a"), call("key", "job")])).toEqual({ value: 4_000, error: null });
        expect(await account.invoke(s, "refund", [call("to", "org_a"), call("amount", "2000"), call("key", null)])).toEqual({ value: 4_000, error: null });
        expect(operator.staged).toEqual([
            { runId: RUN, callIndex: 0, contract: s.contract, function: "pay", parameters: { to: "org_b", amount: 1_000, from: "org_a", key: "job" } },
            { runId: RUN, callIndex: 1, contract: s.contract, function: "refund", parameters: { to: "org_a", amount: 2_000, key: null } },
        ]);

        const tried = fakeOperator({ result: false });
        expect(await new AccountService(tried.client).invoke(session(), "tryPay", [call("to", "org_b"), call("amount", 1), call("from", "org_a"), call("key", null)]))
            .toEqual({ value: false, error: null });
        expect(tried.staged[0]).toMatchObject({ function: "pay", parameters: { try: true } });
        expect(s.failure).toBeUndefined();
    });

    test("reads through the operator, with call indexes shared with staging", async () => {
        const operator = fakeOperator({ response: 7 });
        const account = new AccountService(operator.client);
        const s = session();
        await account.invoke(s, "balance", []);
        await account.invoke(s, "fundingOf", [call("org", "org_a"), call("key", null)]);
        await account.invoke(s, "canReceive", [call("org", "org_b")]);
        expect(operator.read.map(request => [request.callIndex, request.function, request.parameters])).toEqual([
            [0, "balance", {}], [1, "fundingOf", { org: "org_a", key: null }], [2, "canReceive", { org: "org_b" }],
        ]);
    });

    test("refuses bad amounts itself, and a failed call marks the session failed", async () => {
        const operator = fakeOperator();
        const account = new AccountService(operator.client);
        for (const amount of [0, -5, 1.5, "1e3", Number.MAX_SAFE_INTEGER + 2, "abc"]) {
            const s = session();
            const result = await account.invoke(s, "pay", [call("to", "org_b"), call("amount", amount), call("from", "org_a"), call("key", null)]);
            expect(result.error?.message).toContain("whole micro-USD");
            expect(s.failure).toBe(result.error?.message);
        }
        expect(operator.staged).toEqual([]);

        const refused = fakeOperator({ refuse: "org_b isn't one of the funding's payees" });
        const s = session();
        await new AccountService(refused.client).invoke(s, "pay", [call("to", "org_b"), call("amount", 1), call("from", "org_a"), call("key", null)]);
        await new AccountService(refused.client).invoke(s, "balance", []);
        // The first failure is the one reported.
        expect(s.failure).toContain("isn't one of the funding's payees");
    });

    test("a request script has no balance, and earmark needs attached money", async () => {
        const account = new AccountService(fakeOperator().client);
        expect((await account.invoke(undefined, "balance", [])).error?.message).toContain("only a contract has a balance");
        const s = session();
        expect((await account.invoke(s, "earmark", [call("key", "job")])).error?.message).toContain("nothing was attached");
        const attached = { ...session(), attachmentId: "a3b1c1f2-1111-4222-8333-444455556666" };
        const operator = fakeOperator();
        await new AccountService(operator.client).invoke(attached, "earmark", [call("key", "job")]);
        expect(operator.staged[0]).toMatchObject({ function: "earmark", parameters: { attachmentId: attached.attachmentId, key: "job" } });
    });
});

describe("MoneyRun", () => {
    test("opens a run once, when it is first needed, and shares its call indexes", async () => {
        const operator = fakeOperator({ response: 1 });
        const run = new MoneyRun(undefined, (runId) => operator.client.openRun({ runId }));
        const account = new AccountService(operator.client);
        expect(run.opened).toBeUndefined();
        await Promise.all([account.invoke(session(run), "balance", []), account.invoke(session(run), "balance", [])]);
        expect(operator.opened).toHaveLength(1);
        expect(run.opened).toBe(operator.opened[0]);
        expect(operator.read.map(request => [request.runId, request.callIndex]).sort()).toEqual([[run.opened, 0], [run.opened, 1]]);
    });

    test("without an operator run, calls fail", async () => {
        const s = session(new MoneyRun());
        expect((await new AccountService(fakeOperator().client).invoke(s, "balance", [])).error?.message).toContain("without an operator run");
    });
});

describe("Random", () => {
    test("requests stage on the contract's run, and values are read, sharing call indexes with Account", async () => {
        const operator = fakeOperator({ response: { value: "drawn", signature: "sig" } });
        const account = new AccountService(operator.client);
        const s = { ...session(), ledger: [] };
        expect(await account.invokeRandom(s, "requestValue", [call("key", "draw-1")])).toEqual({ value: null, error: null });
        expect(await account.invokeRandom(s, "value", [call("key", "draw-0")])).toEqual({ value: "drawn", error: null });
        expect(operator.staged).toEqual([{ runId: RUN, callIndex: 0, contract: s.contract, function: "random_request", parameters: { key: "draw-1" } }]);
        expect(operator.read).toEqual([{ runId: RUN, callIndex: 1, contract: s.contract, function: "random", parameters: { key: "draw-0" } }]);
        expect(s.ledger).toEqual([{ runId: RUN, callIndex: 0 }, { runId: RUN, callIndex: 1 }]);
        expect(s.run.staged).toBe(true);
    });

    test("fails outside a contract, without a key, and when the value isn't drawn yet", async () => {
        const account = new AccountService(fakeOperator().client);
        expect((await account.invokeRandom(undefined, "requestValue", [call("key", "k")])).error?.message).toContain("only a contract");
        const s = session();
        expect((await account.invokeRandom(s, "value", [call("key", "")])).error?.message).toContain("a key");
        expect(s.failure).toContain("a key");
        const refused = new AccountService(fakeOperator({ refuse: "No random value under k has been drawn yet" }).client);
        expect((await refused.invokeRandom(session(), "value", [call("key", "k")])).error?.message).toContain("drawn yet");
    });

    test("resolves to the built-in, and can't be registered or impersonated", async () => {
        await expect(new StellariumNode().register({ ...RANDOM_RESOURCE, id: 1, baseUrl: "", functions: [] } as StellariumResource)).rejects.toThrow("reserved");
        const repository = new ResourceRepository(undefined as unknown as Database, [], "http://self.example");
        expect(await repository.getResource("sh.stellarium.random.Random")).toBe(RANDOM_RESOURCE);
        const keys = generateBase64KeyPair();
        const invoker = new CombinationResourceInvoker(new ResourceRepository(undefined as unknown as Database), 0, keys.publicKey, keys.privateKey);
        expect((await invoker.invoke(RANDOM_RESOURCE, "value", [call("key", "k")])).error?.message).toContain("no operator");
        expect((await invoker.invoke({ ...RANDOM_RESOURCE, metadata: { baseUrl: "http://evil.example" } }, "value", [])).error?.message).toContain("reserved");
    });
});

describe("sh.stellarium.money is reserved", () => {
    test("a node can't register a resource under it", async () => {
        await expect(new StellariumNode().register({ ...ACCOUNT_RESOURCE, id: 1, baseUrl: "", functions: [] } as StellariumResource)).rejects.toThrow("reserved");
    });

    test("an invoker without an operator fails Account calls, and refuses impostors", async () => {
        const keys = generateBase64KeyPair();
        const invoker = new CombinationResourceInvoker(new ResourceRepository(undefined as unknown as Database), 0, keys.publicKey, keys.privateKey);
        expect((await invoker.invoke(ACCOUNT_RESOURCE, "balance", [])).error?.message).toContain("no operator");
        const impostor = { ...ACCOUNT_RESOURCE, metadata: { baseUrl: "http://evil.example" } };
        expect((await invoker.invoke(impostor, "pay", [])).error?.message).toContain("reserved");
    });

    describe.each(DIALECTS)("resources (%s)", (dialect) => {
        test("resolve to the built-in, and are never learned from peers", async () => {
            const db = await openTestDatabase(dialect);
            try {
                const repository = new ResourceRepository(db, [], "http://self.example");
                expect(await repository.getResource("sh.stellarium.money.Account")).toBe(ACCOUNT_RESOURCE);
                expect(await repository.getResource("sh.stellarium.money.Account", "1")).toBeUndefined();

                const keys = generateBase64KeyPair();
                const baseUrl = "http://peer.example";
                const forged: StellariumResource = { id: 0, baseUrl, metadata: {}, path: "sh.stellarium.money", name: "Vault", functions: [] };
                await repository.learn(forged);
                const peers = new PeerRepository(db);
                await peers.create({ baseUrl, name: "peer", publicKey: keys.publicKey });
                const peer = (await peers.getPeerByPublicKey(keys.publicKey))!;
                const expiry = new Date(Date.now() + 60_000).toISOString();
                const result = await repository.saveAll([forged], peer, signData(resourceAnnouncementPayload([forged], expiry), keys.privateKey), expiry);
                expect(result).toEqual({ ok: true, rejected: ["sh.stellarium.money.Vault"] });
                expect(await repository.isLearned("sh.stellarium.money", "Vault")).toBe(false);
                // One learned before the rule is never resolved.
                await db.run("INSERT INTO resource (path, name, base_url, created_at, updated_at) VALUES (?, ?, ?, ?, ?)", ["sh.stellarium.money", "Vault", baseUrl, "x", "x"]);
                expect(await repository.getResource("sh.stellarium.money.Vault")).toBeUndefined();
            } finally {
                await db.close();
            }
        });
    });
});
