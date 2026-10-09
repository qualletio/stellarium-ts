import sqlite3 from "sqlite3";
import { open, type Database } from "sqlite";
export async function openDatabase(
    filename = "./requestscript.db",
): Promise<Database> {
    const db = await open({ filename, driver: sqlite3.Database });
    await db.exec(
        "PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;",
    );
    await createTables(db);
    return db;
}
export async function createTables(db: Database): Promise<void> {
    await db.exec(`
    CREATE TABLE IF NOT EXISTS peer (
      id INTEGER PRIMARY KEY AUTOINCREMENT, base_url TEXT NOT NULL UNIQUE,
      public_key TEXT NOT NULL UNIQUE, name TEXT NOT NULL,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS resources (
      id INTEGER PRIMARY KEY AUTOINCREMENT, path TEXT NOT NULL, name TEXT NOT NULL,
      base_url TEXT NOT NULL, owner_key TEXT, functions_json TEXT NOT NULL,
      monetization_json TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      UNIQUE(path, name)
    );
    CREATE TABLE IF NOT EXISTS access_nonce (id TEXT PRIMARY KEY, expires_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS invocation (
      id TEXT PRIMARY KEY, status TEXT NOT NULL CHECK(status IN ('running','completed','failed','indeterminate')),
      result_json TEXT, relay_endpoint TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS request_execution (
      id TEXT PRIMARY KEY, status TEXT NOT NULL, result_json TEXT, updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS relay_advertisement (
      relay TEXT PRIMARY KEY, advertisement_json TEXT NOT NULL, issued_at INTEGER NOT NULL,
      nonce TEXT NOT NULL, expires_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS relay_queue (
      id TEXT PRIMARY KEY, claim_json TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'queued',
      transaction_hash TEXT, batch_id TEXT, attempts INTEGER NOT NULL DEFAULT 0,
      last_error TEXT, received_at INTEGER NOT NULL, deadline INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS evidence (
      id TEXT PRIMARY KEY, encrypted_json TEXT NOT NULL, created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS outbox (
      id TEXT PRIMARY KEY, endpoint TEXT NOT NULL, claim_json TEXT NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0, delivered INTEGER NOT NULL DEFAULT 0
    );
  `);
    const columns = await db.all("PRAGMA table_info(invocation)");
    if (!columns.some((column) => column.name === "relay_endpoint"))
        await db.exec("ALTER TABLE invocation ADD COLUMN relay_endpoint TEXT");
    // SQLite runs the trigger in the completion statement's transaction: a receipt
    // can never become visible without its durable relay delivery record.
    await db.exec(`CREATE TRIGGER IF NOT EXISTS invocation_delivery AFTER UPDATE ON invocation
    WHEN NEW.status='completed' AND NEW.relay_endpoint IS NOT NULL
    BEGIN
      INSERT INTO outbox(id,endpoint,claim_json)
      VALUES(json_extract(NEW.result_json,'$.executions[0].claim.receipt.message.receiptId'),NEW.relay_endpoint,json_extract(NEW.result_json,'$.executions[0].claim'))
      ON CONFLICT(id) DO UPDATE SET claim_json=excluded.claim_json,delivered=0;
    END;`);
    // Preserve legacy discovery records; the old tables are retained for recovery.
    const tables = new Set(
        (await db.all("SELECT name FROM sqlite_master WHERE type='table'")).map(
            (row) => row.name,
        ),
    );
    if (
        tables.has("resource") &&
        tables.has("resource_function") &&
        tables.has("resource_function_parameter")
    ) {
        const rows = await db.all(
            "SELECT resource.*,peer.public_key AS owner_key FROM resource LEFT JOIN peer ON peer.id=resource.peer_id",
        );
        for (const row of rows) {
            const functions = await db.all(
                "SELECT * FROM resource_function WHERE resource_id=? ORDER BY id",
                row.id,
            );
            const descriptions = [];
            for (const fn of functions)
                descriptions.push({
                    name: fn.name,
                    returnType: fn.return_type,
                    parameters: await db.all(
                        "SELECT name,parameter_type AS type FROM resource_function_parameter WHERE resource_function_id=? ORDER BY id",
                        fn.id,
                    ),
                });
            await db.run(
                "INSERT OR IGNORE INTO resources(path,name,base_url,owner_key,functions_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?)",
                row.path,
                row.name,
                row.base_url,
                row.owner_key,
                JSON.stringify(descriptions),
                row.created_at,
                row.updated_at,
            );
        }
    }
    await db.exec("PRAGMA user_version=1");
}
