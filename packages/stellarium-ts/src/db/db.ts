import sqlite3 from 'sqlite3';
import { open, type Database } from 'sqlite';

export const DEFAULT_DATABASE_PATH = './requestscript.db';

/**
 * Bumped whenever the schema changes in a way `CREATE TABLE IF NOT EXISTS` can't apply.
 * Version 1 dropped `UNIQUE (base_url)` from `resource` and added uniqueness to the function tables.
 */
const SCHEMA_VERSION = 1;

/** Opens (or creates) the node database and brings its schema up to date. Pass ':memory:' for tests. */
export async function openDatabase(filename: string = DEFAULT_DATABASE_PATH): Promise<Database> {
    const db = await open({ filename, driver: sqlite3.Database });
    await createTables(db);
    return db;
}

export async function createTables(db: Database) {
    const { user_version: version } = await db.get<{ user_version: number }>('PRAGMA user_version') ?? { user_version: 0 };
    if (version < SCHEMA_VERSION) {
        // Resource rows are a cache of what peers advertise, and are relearned on the next broadcast.
        // SQLite can't drop a constraint in place, so rebuild them. Peers are kept.
        await db.exec(`
            DROP TABLE IF EXISTS resource_function_payment_manifest;
            DROP TABLE IF EXISTS resource_function_parameter;
            DROP TABLE IF EXISTS resource_function;
            DROP TABLE IF EXISTS resource;
        `);
    }

    await db.exec(`
        CREATE TABLE IF NOT EXISTS peer (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            base_url TEXT NOT NULL,
            public_key TEXT NOT NULL,
            name TEXT NOT NULL,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,

            UNIQUE (public_key),
            UNIQUE (base_url),
            UNIQUE (name)
        );

        CREATE TABLE IF NOT EXISTS resource (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            peer_id INTEGER,
            path TEXT NOT NULL,
            name TEXT NOT NULL,
            base_url TEXT NOT NULL,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,

            FOREIGN KEY (peer_id) REFERENCES peer(id),

            UNIQUE (path, name)
        );

        CREATE TABLE IF NOT EXISTS resource_function (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            resource_id INTEGER NOT NULL,
            name TEXT NOT NULL,
            return_type TEXT NOT NULL,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,

            FOREIGN KEY (resource_id) REFERENCES resource(id),

            UNIQUE (resource_id, name)
        );

        CREATE TABLE IF NOT EXISTS resource_function_parameter (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            resource_function_id INTEGER NOT NULL,
            name TEXT NOT NULL,
            parameter_type TEXT NOT NULL,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,

            FOREIGN KEY (resource_function_id) REFERENCES resource_function(id),

            UNIQUE (resource_function_id, name)
        );

        CREATE TABLE IF NOT EXISTS resource_function_payment_manifest (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            resource_function_id INTEGER NOT NULL,
            cost_lamports INTEGER NOT NULL,
            recipient_address TEXT NOT NULL,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,

            FOREIGN KEY (resource_function_id) REFERENCES resource_function(id),

            UNIQUE (resource_function_id)
        );
    `);

    await db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
}
