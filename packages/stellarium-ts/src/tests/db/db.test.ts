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

        expect(await db.get("PRAGMA user_version")).toEqual({ user_version: 1 });
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
});
