import { PGlite } from "@electric-sql/pglite";
import { describe, expect, test, vi } from "vitest";
import { createTables } from "../../db/db.js";
import { numberPlaceholders, PostgresDatabase } from "../../db/postgres.js";
import { pgliteDriver } from "../helpers.js";

describe("numberPlaceholders", () => {
    test("numbers placeholders outside quotes", () => {
        expect(numberPlaceholders("SELECT * FROM t WHERE a = ? AND b = '?' AND \"c?\" = ?")).toBe("SELECT * FROM t WHERE a = $1 AND b = '?' AND \"c?\" = $2");
    });
});

describe("PostgresDatabase", () => {
    test("creates its tables in the node's schema, and can be reopened", async () => {
        const pg = new PGlite({ parsers: { 20: Number } });
        // node-postgres sets the search path per connection; PGlite has the one.
        await pg.exec("SET search_path TO node_a");
        const db = await PostgresDatabase.open(pgliteDriver(pg), "node_a");
        await createTables(db);
        await db.run("INSERT INTO peer (base_url, public_key, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)", ["http://p", "key", "p", "now", "now"]);

        await createTables(db);
        expect(await db.all("SELECT public_key FROM peer")).toEqual([{ public_key: "key" }]);
        expect(await db.all("SELECT version FROM stellarium_schema")).toEqual([{ version: 7 }]);
        const tables = await db.all<{ table_name: string }[]>("SELECT table_name FROM information_schema.tables WHERE table_schema = 'node_a' ORDER BY table_name");
        expect(tables.map(table => table.table_name)).toContain("resource_function_payment_manifest");
        await db.close();
    });

    test("refuses a schema name that isn't a plain identifier", async () => {
        const exec = vi.fn();
        const driver = { query: vi.fn(), exec, transaction: vi.fn(), close: vi.fn() };
        await expect(PostgresDatabase.open(driver, "a; DROP TABLE peer")).rejects.toThrow(/Invalid database schema/);
        expect(exec).not.toHaveBeenCalled();
    });

    test("rolls a failed transaction back", async () => {
        const pg = new PGlite({ parsers: { 20: Number } });
        const db = await PostgresDatabase.open(pgliteDriver(pg));
        await createTables(db);
        await expect(db.transaction(async (tx) => {
            await tx.run("INSERT INTO blocked_caller (public_key, reason, blocked_at) VALUES (?, ?, ?)", ["key", null, "now"]);
            throw new Error("failed");
        })).rejects.toThrow("failed");
        expect(await db.all("SELECT * FROM blocked_caller")).toEqual([]);
        await db.close();
    });
});
