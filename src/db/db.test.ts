import { it, expect } from "vitest";
import { openDatabase, createTables } from "./db.js";
import { ExecutionStore } from "../payment/store.js";
import type { Hex } from "../protocol/types.js";
it("rolls back completion if its durable delivery cannot be created", async () => {
    const db = await openDatabase(":memory:");
    try {
        const store = new ExecutionStore(db);
        const id = `0x${"1".repeat(64)}` as Hex;
        await store.begin(id);
        await expect(
            store.complete(
                id,
                { returnValue: 12, executions: [] },
                false,
                "https://relay.example",
            ),
        ).rejects.toThrow();
        expect((await store.get(id))?.status).toBe("running");
        expect((await db.get("SELECT COUNT(*) AS n FROM outbox")).n).toBe(0);
    } finally {
        await db.close();
    }
});
it("copies complete legacy discovery records and preserves original tables", async () => {
    const db = await openDatabase(":memory:");
    try {
        await db.exec(`CREATE TABLE resource(id INTEGER,peer_id INTEGER,path TEXT,name TEXT,base_url TEXT,created_at TEXT,updated_at TEXT);
        CREATE TABLE resource_function(id INTEGER,resource_id INTEGER,name TEXT,return_type TEXT);
        CREATE TABLE resource_function_parameter(id INTEGER,resource_function_id INTEGER,name TEXT,parameter_type TEXT);
        INSERT INTO peer(base_url,name,public_key,created_at,updated_at) VALUES('https://peer.example','peer','key','now','now');
        INSERT INTO resource VALUES(1,1,'example','Weather','https://peer.example','now','now');
        INSERT INTO resource_function VALUES(1,1,'forecast','int32');
        INSERT INTO resource_function_parameter VALUES(1,1,'city','string');`);
        await createTables(db);
        await createTables(db);
        const row = await db.get("SELECT * FROM resources");
        expect(JSON.parse(row.functions_json)).toEqual([
            {
                name: "forecast",
                returnType: "int32",
                parameters: [{ name: "city", type: "string" }],
            },
        ]);
        expect(row.owner_key).toBe("key");
        expect((await db.get("SELECT COUNT(*) AS n FROM resource")).n).toBe(1);
    } finally {
        await db.close();
    }
});
