import type { StateWrite } from "requestscript";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { ContractStateRepository, scopeFromKey, scopeKey } from "../../contract/state.js";
import type { NodeDatabase } from "../../db/database.js";
import { DIALECTS, openTestDatabase } from "../helpers.js";

const INT32 = '{"kind":"int32"}';
const write = (name: string, value: unknown, overrides: Partial<StateWrite> = {}): StateWrite =>
    ({ name, scope: null, value: value as StateWrite['value'], type: INT32, ...overrides });

describe.each(DIALECTS)("ContractStateRepository (%s)", (dialect) => {
    let db: NodeDatabase;
    let state: ContractStateRepository;

    beforeEach(async () => {
        db = await openTestDatabase(dialect);
        state = new ContractStateRepository(db);
    });

    afterEach(async () => {
        await db.close();
    });

    test("stores a new variable, then updates it from the version it was read at", async () => {
        expect(await state.commit("com.example", "Counter", [write("count", 1)], 1000)).toEqual({ ok: true });
        const stored = await state.get("com.example", "Counter", "count", null);
        expect(stored).toEqual({ value: 1, type: INT32, version: 1 });

        expect(await state.commit("com.example", "Counter", [write("count", 2, { version: stored!.version })], 1000)).toEqual({ ok: true });
        expect(await state.get("com.example", "Counter", "count", null)).toMatchObject({ value: 2, version: 2 });
    });

    test("refuses to save over a copy that changed, and saves nothing of that call", async () => {
        await state.commit("com.example", "Counter", [write("count", 1)], 1000);

        // Read at version 1, but another call saved in between.
        await state.commit("com.example", "Counter", [write("count", 2, { version: 1 })], 1000);
        expect(await state.commit("com.example", "Counter", [write("total", 9), write("count", 3, { version: 1 })], 1000)).toEqual({ ok: false, reason: "conflict" });
        // A second first save is a conflict too.
        expect(await state.commit("com.example", "Counter", [write("count", 7)], 1000)).toEqual({ ok: false, reason: "conflict" });

        expect(await state.get("com.example", "Counter", "count", null)).toMatchObject({ value: 2 });
        expect(await state.get("com.example", "Counter", "total", null)).toBeUndefined();
    });

    test("keeps one copy per scope, and scopes keep their kind", async () => {
        const scopes = [null, { kind: "string" as const, key: "3" }, { kind: "integer" as const, key: "3" }];
        await state.commit("com.example", "Tally", scopes.map((scope, index) => write("n", index, { scope })), 1000);

        expect(await Promise.all(scopes.map(scope => state.get("com.example", "Tally", "n", scope).then(stored => stored?.value)))).toEqual([0, 1, 2]);
        expect(scopes.map(scope => scopeFromKey(scopeKey(scope)))).toEqual(scopes);
        expect((await state.list("com.example", "Tally")).map(row => row.scope)).toEqual([null, { kind: "integer", key: "3" }, { kind: "string", key: "3" }]);
    });

    test("refuses a save that grows a scope past the cap, counting every variable in it", async () => {
        const scope = { kind: "string" as const, key: "org_a" };
        // Each value is 12 bytes of JSON: ten letters and their quotes.
        await state.commit("com.example", "Notes", [write("a", "x".repeat(10), { scope })], 20);

        expect(await state.commit("com.example", "Notes", [write("b", "y".repeat(10), { scope })], 20))
            .toEqual({ ok: false, reason: "too_large", scope, bytes: 24 });
        expect(await state.get("com.example", "Notes", "b", scope)).toBeUndefined();
        // Another scope has its own allowance.
        expect(await state.commit("com.example", "Notes", [write("b", "y".repeat(10), { scope: { kind: "string", key: "org_b" } })], 20)).toEqual({ ok: true });
    });

    test("deletes a contract's state, and only that contract's", async () => {
        await state.commit("com.example", "A", [write("n", 1)], 1000);
        await state.commit("com.example", "B", [write("n", 1)], 1000);

        await state.deleteContract("com.example", "A");

        expect(await state.list("com.example", "A")).toEqual([]);
        expect(await state.list("com.example", "B")).toHaveLength(1);
    });
});
