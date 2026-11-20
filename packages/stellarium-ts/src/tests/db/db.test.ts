import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { open } from "sqlite";
import sqlite3 from "sqlite3";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { openDatabase } from "../../db/db.js";

describe("openDatabase", () => {
    let dir: string;
    beforeEach(async () => {
        dir = await mkdtemp(path.join(tmpdir(), "stellarium-db-"));
    });
    afterEach(async () => {
        await rm(dir, { recursive: true, force: true });
    });

    test("can be reopened without errors", async () => {
        const filename = path.join(dir, "node.db");
        await (await openDatabase(filename)).close();
        const db = await openDatabase(filename);

        expect(await db.get("PRAGMA user_version")).toEqual({ user_version: 9 });
        await db.close();
    });

    test("rebuilds resource tables from the old schema and keeps peers", async () => {
        const filename = path.join(dir, "old.db");
        const old = await open({ filename, driver: sqlite3.Database });
        await old.exec(`
            CREATE TABLE peer (id INTEGER PRIMARY KEY AUTOINCREMENT, base_url TEXT NOT NULL, public_key TEXT NOT NULL, name TEXT NOT NULL,
                created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE (public_key), UNIQUE (base_url), UNIQUE (name));
            CREATE TABLE resource (id INTEGER PRIMARY KEY AUTOINCREMENT, peer_id INTEGER, path TEXT NOT NULL, name TEXT NOT NULL,
                base_url TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE (path, name), UNIQUE (base_url));
            INSERT INTO peer (base_url, public_key, name, created_at, updated_at) VALUES ('http://p', 'key', 'p', 'now', 'now');
            INSERT INTO resource (path, name, base_url, created_at, updated_at) VALUES ('com.p', 'A', 'http://p', 'now', 'now');
        `);
        await old.close();

        const db = await openDatabase(filename);
        expect(await db.all("SELECT public_key FROM peer")).toEqual([{ public_key: "key" }]);
        expect(await db.all("SELECT * FROM resource")).toEqual([]);

        // Two resources on one base URL failed under the old UNIQUE (base_url).
        await db.exec(`
            INSERT INTO resource (path, name, base_url, created_at, updated_at) VALUES ('com.p', 'A', 'http://p', 'now', 'now');
            INSERT INTO resource (path, name, base_url, created_at, updated_at) VALUES ('com.p', 'B', 'http://p', 'now', 'now');
        `);
        await db.close();
    });

    test("adds the restricted column to a version 1 database and keeps held grants on later opens", async () => {
        const filename = path.join(dir, "v1.db");
        const old = await open({ filename, driver: sqlite3.Database });
        await old.exec(`
            CREATE TABLE resource_function (id INTEGER PRIMARY KEY AUTOINCREMENT, resource_id INTEGER NOT NULL, name TEXT NOT NULL,
                return_type TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE (resource_id, name));
            PRAGMA user_version = 1;
        `);
        await old.close();

        const db = await openDatabase(filename);
        const columns = await db.all<{ name: string }[]>("PRAGMA table_info(resource_function)");
        expect(columns.map(column => column.name)).toContain("restricted");
        await db.run("INSERT INTO held_grant (issuer, id, root_issuer_base_url, chain, issued_at, expires_at, updated_at) VALUES ('k', 'g', 'http://p', '[]', 'now', 'now', 'now')");
        await db.close();

        // Grants are not a cache of anything a peer resends, so a reopen must not drop them.
        const reopened = await openDatabase(filename);
        expect(await reopened.all("SELECT id FROM held_grant")).toEqual([{ id: "g" }]);
        await reopened.close();
    });

    test("drops a version 8 database's RequestScript 1 contracts and their state, keeping peers, then keeps contracts on later opens", async () => {
        const filename = path.join(dir, "v8.db");
        const old = await open({ filename, driver: sqlite3.Database });
        await old.exec(`
            CREATE TABLE contract (path TEXT NOT NULL, name TEXT NOT NULL, version TEXT NOT NULL, source TEXT NOT NULL, parameters TEXT NOT NULL,
                return_type TEXT NOT NULL, owner_organization_id TEXT, description TEXT, created_at TEXT NOT NULL, PRIMARY KEY (path, name, version));
            INSERT INTO contract VALUES ('com.p', 'Old', '1', 'contract com.p.Old(a: int32): int32 { return a }', '[]', 'int32', NULL, NULL, 'now');
            CREATE TABLE contract_state (path TEXT NOT NULL, name TEXT NOT NULL, var_name TEXT NOT NULL, scope_key TEXT NOT NULL, value TEXT NOT NULL,
                type TEXT NOT NULL, version INTEGER NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY (path, name, var_name, scope_key));
            INSERT INTO contract_state VALUES ('com.p', 'Old', 'n', '', '1', '{"kind":"int32"}', 1, 'now');
            CREATE TABLE peer (id INTEGER, base_url TEXT NOT NULL, public_key TEXT NOT NULL, key TEXT PRIMARY KEY, expires_at INTEGER NOT NULL);
            INSERT INTO peer (base_url, public_key, key, expires_at) VALUES ('http://p', 'pk', 'k', 0);
            PRAGMA user_version = 8;
        `);
        await old.close();

        const db = await openDatabase(filename);
        expect(await db.all("SELECT * FROM contract")).toEqual([]);
        expect(await db.all("SELECT * FROM contract_state")).toEqual([]);
        expect(await db.all("SELECT public_key FROM peer")).toEqual([{ public_key: "pk" }]);
        const columns = await db.all<{ name: string }[]>("PRAGMA table_info(contract)");
        expect(columns.map(column => column.name)).toContain("functions");
        await db.run("INSERT INTO contract (path, name, version, source, functions, created_at) VALUES ('com.p', 'New', '1', 's', '[]', 'now')");
        await db.close();

        const reopened = await openDatabase(filename);
        expect(await reopened.all("SELECT name FROM contract")).toEqual([{ name: "New" }]);
        await reopened.close();
    });

    test("rebuilds a version 4 manifest table into the micro-USD, organization-recipient schema", async () => {
        const filename = path.join(dir, "v4.db");
        const old = await open({ filename, driver: sqlite3.Database });
        await old.exec(`
            CREATE TABLE resource_function_payment_manifest (id INTEGER PRIMARY KEY AUTOINCREMENT, resource_function_id INTEGER NOT NULL,
                cost_micro_usdc INTEGER NOT NULL, recipient_address TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
                UNIQUE (resource_function_id));
            PRAGMA user_version = 4;
        `);
        await old.close();

        const db = await openDatabase(filename);
        const functionColumns = await db.all<{ name: string }[]>("PRAGMA table_info(resource_function)");
        expect(functionColumns.map(column => column.name)).toContain("kind");
        await db.run(`INSERT INTO resource_function_payment_manifest (resource_function_id, input_cost_micro_usd_per_million_tokens,
            output_cost_micro_usd_per_million_tokens, recipient_organization_id, created_at, updated_at) VALUES (1, 3, 15, 'r', 'now', 'now')`);
        await db.close();
    });
});
