import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { OperatorClient, SettleResult } from "../../client/operatorClient.js";
import type { NodeDatabase } from "../../db/database.js";
import { OUTBOX_LEASE_MS, OUTBOX_MAX_AGE_MS, SettlementOutbox } from "../../resource/outbox.js";
import { DIALECTS, openTestDatabase } from "../helpers.js";

const RUN = "0b6c1f7e-2a4d-4e8f-9a1b-3c5d7e9f1a2b";
const accepted: SettleResult = { ok: true };
const transient: SettleResult = { ok: false, status: 503, error: "Payment operator is unavailable", retryable: true };
const final: SettleResult = { ok: false, status: 409, error: "Run's hold was already released", retryable: false };

/** An operator that answers each settlement with the next of `answers`, then accepts. */
function fakeOperator(...answers: (SettleResult | Error)[]) {
    const next = async () => {
        const answer = answers.shift() ?? accepted;
        if (answer instanceof Error) throw answer;
        return answer;
    };
    const client = { captureRun: vi.fn(next), releaseRun: vi.fn(next), capture: vi.fn(next), release: vi.fn(next) };
    return client as typeof client & OperatorClient;
}

describe.each(DIALECTS)("SettlementOutbox (%s)", (dialect) => {
    let db: NodeDatabase;
    const log = vi.fn();

    beforeEach(async () => {
        db = await openTestDatabase(dialect);
        log.mockReset();
    });

    afterEach(async () => {
        await db.close();
    });

    const rows = () => db.all<{ key: string, attempts: number, next_attempt_at: string }[]>("SELECT key, attempts, next_attempt_at FROM settlement_outbox ORDER BY id");
    const later = (ms: number) => new Date(Date.now() + ms);

    test("keeps a settlement before returning, sends it at once, and forgets it once the operator takes it", async () => {
        const operator = fakeOperator();
        const outbox = new SettlementOutbox(db, operator, log);
        await outbox.captureRun(RUN, 7, true);
        expect((await rows()).map(row => row.key)).toEqual([`run:${RUN}`]);
        await vi.waitFor(async () => expect(await rows()).toEqual([]));
        expect(operator.captureRun).toHaveBeenCalledWith({ runId: RUN, tokens: 7, failed: true });
    });

    test("settles a run or voucher once", async () => {
        const operator = fakeOperator();
        const outbox = new SettlementOutbox(db, operator, log);
        await outbox.captureRun(RUN, 1);
        await outbox.releaseRun(RUN);
        await vi.waitFor(async () => expect(await rows()).toEqual([]));
        expect(operator.captureRun).toHaveBeenCalledOnce();
        expect(operator.releaseRun).not.toHaveBeenCalled();
    });

    test("resends what the operator couldn't take, with backoff, until it does", async () => {
        const operator = fakeOperator(transient, new Error("fetch failed"));
        const outbox = new SettlementOutbox(db, operator, log);
        await outbox.releaseRun(RUN);
        await vi.waitFor(async () => expect(await rows()).toMatchObject([{ attempts: 1 }]));
        // Not due yet.
        expect(await outbox.deliverDue()).toBe(0);
        expect(operator.releaseRun).toHaveBeenCalledTimes(1);

        expect(await outbox.deliverDue(later(OUTBOX_LEASE_MS))).toBe(0);
        expect(await rows()).toMatchObject([{ attempts: 2 }]);
        expect(await outbox.deliverDue(later(OUTBOX_LEASE_MS * 2))).toBe(1);
        expect(await rows()).toEqual([]);
        expect(operator.releaseRun).toHaveBeenCalledTimes(3);
    });

    test("forgets a settlement the operator refuses for good, and logs it", async () => {
        const outbox = new SettlementOutbox(db, fakeOperator(final), log);
        await outbox.captureRun(RUN, 1);
        await vi.waitFor(async () => expect(await rows()).toEqual([]));
        expect(log).toHaveBeenCalledWith(final.ok === false && final.error, expect.stringContaining("refused /runs/capture"));
    });

    test("sends what was kept before a restart, and gives up on what's too old", async () => {
        // The node stopped before its first attempt: the row is still leased, and due once the lease ends.
        await db.run(
            "INSERT INTO settlement_outbox (key, path, body, attempts, next_attempt_at, created_at) VALUES (?, ?, ?, 0, ?, ?)",
            [`run:${RUN}`, "/runs/capture", JSON.stringify({ runId: RUN, tokens: 3 }), new Date().toISOString(), new Date().toISOString()],
        );
        await db.run(
            "INSERT INTO settlement_outbox (key, path, body, attempts, next_attempt_at, created_at) VALUES (?, ?, ?, 9, ?, ?)",
            ["run:old", "/runs/release", JSON.stringify({ runId: "old" }), new Date().toISOString(), new Date(Date.now() - OUTBOX_MAX_AGE_MS - 1).toISOString()],
        );
        const operator = fakeOperator(accepted, transient);
        const restarted = new SettlementOutbox(db, operator, log);
        expect(await restarted.deliverDue(later(1))).toBe(2);
        expect(operator.captureRun).toHaveBeenCalledWith({ runId: RUN, tokens: 3 });
        expect(log).toHaveBeenCalledWith(expect.anything(), expect.stringContaining("Gave up on /runs/release for run:old"));
        expect(await rows()).toEqual([]);
    });

    test("captures and releases vouchers by their request and invocation", async () => {
        const operator = fakeOperator();
        const outbox = new SettlementOutbox(db, operator, log);
        const voucher = { requestId: "r", invocationId: "i" } as Parameters<SettlementOutbox["releasePayment"]>[0];
        await outbox.capturePayment({ voucher } as Parameters<SettlementOutbox["capturePayment"]>[0]);
        await outbox.releasePayment(voucher);
        await vi.waitFor(async () => expect(await rows()).toEqual([]));
        expect(operator.capture).toHaveBeenCalledWith({ voucher });
        expect(operator.release).not.toHaveBeenCalled();
    });
});
