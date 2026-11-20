import type { StateWrite } from "requestscript";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { OperatorClient, TreeOutcome } from "../../client/operatorClient.js";
import { Frame, StateCoordinator, StateTransaction } from "../../contract/pending.js";
import { ContractStateRepository } from "../../contract/state.js";
import type { NodeDatabase } from "../../db/database.js";
import { DIALECTS, openTestDatabase } from "../helpers.js";

const RUN = "5f0a1c2e-7d3b-4f6a-9c8e-1b2d3e4f5a6b";
const JOB = ["com.example", "Job"] as const;
const scope = (key: string) => ({ kind: "string" as const, key });
const write = (name: string, value: unknown, key: string, version?: number): StateWrite =>
    ({ name, scope: scope(key), value: value as StateWrite["value"], type: '"int32"', ...(version === undefined ? {} : { version }) });

/** An operator that answers each run's outcome from `outcomes`, `pending` until set. */
function fakeOperator() {
    const outcomes = new Map<string, TreeOutcome | 404>();
    const client = {
        runOutcome: vi.fn(async ({ runId }: { runId: string }) => {
            const outcome = outcomes.get(runId) ?? "pending";
            return outcome === 404 ? { ok: false as const, status: 404, error: "Run was never authorized" } : { ok: true as const, outcome };
        }),
    };
    return { client: client as unknown as OperatorClient, outcomes };
}

describe.each(DIALECTS)("StateCoordinator (%s)", (dialect) => {
    let db: NodeDatabase;
    let state: ContractStateRepository;
    let operator: ReturnType<typeof fakeOperator>;
    let coordinator: StateCoordinator;
    const log = vi.fn();

    beforeEach(async () => {
        db = await openTestDatabase(dialect);
        state = new ContractStateRepository(db);
        operator = fakeOperator();
        coordinator = new StateCoordinator(state, operator.client, () => 1_000, log, 5);
        log.mockReset();
    });

    afterEach(async () => {
        coordinator.close();
        await db.close();
    });

    const stored = async (key: string) => (await state.get(...JOB, "count", scope(key)))?.value;

    test("a money chain's writes wait for the operator to apply its money, holding their scopes", async () => {
        await state.commit(...JOB, [write("count", 1, "job-1")], 1_000);
        const tx = new StateTransaction();
        expect(await coordinator.buffer(tx, new Frame(), ...JOB, [write("count", 2, "job-1", 1)])).toEqual({ ok: true });
        // The chain reads its own write; nobody else can save over it.
        expect(coordinator.buffered(tx, ...JOB, "count", scope("job-1"))).toEqual({ value: 2, type: '"int32"', version: 2 });
        expect(coordinator.heldByOther(undefined, ...JOB, scope("job-1"))).toBe(true);
        expect(coordinator.heldByOther(undefined, ...JOB, scope("job-2"))).toBe(false);
        expect(await coordinator.commitNow(...JOB, [write("count", 9, "job-1", 1)])).toMatchObject({ ok: false, reason: "conflict" });

        await coordinator.end(tx, RUN);
        expect(await stored("job-1")).toBe(1);
        expect((await state.pending()).get(RUN)).toHaveLength(1);
        await new Promise(resolve => setTimeout(resolve, 30));
        expect(operator.client.runOutcome).toHaveBeenCalledWith({ runId: RUN });
        expect(await stored("job-1")).toBe(1);

        operator.outcomes.set(RUN, "applied");
        await vi.waitFor(async () => expect(await stored("job-1")).toBe(2));
        expect(coordinator.heldByOther(undefined, ...JOB, scope("job-1"))).toBe(false);
        expect((await state.pending()).size).toBe(0);
    });

    test("writes whose money was dropped are discarded, as are those of a run the operator never heard of", async () => {
        for (const [runId, outcome] of [[RUN, "dropped"], ["6f0a1c2e-7d3b-4f6a-9c8e-1b2d3e4f5a6b", 404]] as const) {
            const tx = new StateTransaction();
            await coordinator.buffer(tx, new Frame(), ...JOB, [write("count", 1, runId)]);
            await coordinator.end(tx, runId);
            operator.outcomes.set(runId, outcome);
            await vi.waitFor(async () => expect((await state.pending()).has(runId)).toBe(false));
            expect(await stored(runId)).toBeUndefined();
            expect(coordinator.heldByOther(undefined, ...JOB, scope(runId))).toBe(false);
        }
    });

    test("a failed run drops its own writes and those of the runs it called, and their holds", async () => {
        const tx = new StateTransaction();
        const outer = new Frame();
        const failing = new Frame(outer);
        await coordinator.buffer(tx, outer, ...JOB, [write("count", 1, "kept")]);
        await coordinator.buffer(tx, new Frame(failing), ...JOB, [write("count", 1, "dropped")]);
        coordinator.drop(tx, failing);
        expect(tx.writes.map(entry => entry.write.scope)).toEqual([scope("kept")]);
        expect(coordinator.heldByOther(undefined, ...JOB, scope("dropped"))).toBe(false);
        expect(coordinator.heldByOther(undefined, ...JOB, scope("kept"))).toBe(true);
        // Without a money run, the chain saves at its end.
        await coordinator.end(tx, undefined);
        expect(await stored("kept")).toBe(1);
        expect(await stored("dropped")).toBeUndefined();
    });

    test("refuses stale writes, scopes other chains hold, and scopes past the size limit", async () => {
        await state.commit(...JOB, [write("count", 1, "a")], 1_000);
        const first = new StateTransaction();
        expect(await coordinator.buffer(first, new Frame(), ...JOB, [write("count", 2, "a")])).toMatchObject({ ok: false, reason: "conflict" });
        expect(await coordinator.buffer(first, new Frame(), ...JOB, [write("count", 2, "a", 1)])).toEqual({ ok: true });
        // The chain's second write must build on its first.
        expect(await coordinator.buffer(first, new Frame(), ...JOB, [write("count", 3, "a", 1)])).toMatchObject({ ok: false, reason: "conflict" });
        expect(await coordinator.buffer(first, new Frame(), ...JOB, [write("count", 3, "a", 2)])).toEqual({ ok: true });
        expect(await coordinator.buffer(new StateTransaction(), new Frame(), ...JOB, [write("count", 9, "a", 1)])).toMatchObject({ ok: false, reason: "conflict" });
        expect(await coordinator.buffer(new StateTransaction(), new Frame(), ...JOB, [write("count", "x".repeat(2_000), "big")])).toMatchObject({ ok: false, reason: "too_large" });
        coordinator.drop(first, new Frame());
    });

    test("a reader waits for a held scope, and gives up after its timeout", async () => {
        const tx = new StateTransaction();
        await coordinator.buffer(tx, new Frame(), ...JOB, [write("count", 1, "a")]);
        expect(await coordinator.waitFor(undefined, ...JOB, scope("a"), 20)).toBe(false);
        const waiting = coordinator.waitFor(undefined, ...JOB, scope("a"), 5_000);
        await coordinator.end(tx, undefined);
        expect(await waiting).toBe(true);
    });

    test("pending writes survive a restart, holding their scopes until the operator answers", async () => {
        const tx = new StateTransaction();
        await coordinator.buffer(tx, new Frame(), ...JOB, [write("count", 5, "a")]);
        await coordinator.end(tx, RUN);
        coordinator.close();

        const restarted = new StateCoordinator(state, operator.client, () => 1_000, log, 5);
        try {
            expect(await restarted.resume()).toBe(1);
            expect(restarted.heldByOther(undefined, ...JOB, scope("a"))).toBe(true);
            operator.outcomes.set(RUN, "applied");
            await vi.waitFor(async () => expect(await stored("a")).toBe(5));
            expect(restarted.heldByOther(undefined, ...JOB, scope("a"))).toBe(false);
        } finally {
            restarted.close();
        }
    });
});
