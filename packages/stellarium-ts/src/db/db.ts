import sqlite3 from 'sqlite3';
import { open, type Database } from 'sqlite';

export const DEFAULT_DATABASE_PATH = './requestscript.db';

/**
 * Bumped whenever the schema changes in a way `CREATE TABLE IF NOT EXISTS` can't apply.
 * Version 1 dropped `UNIQUE (base_url)` from `resource` and added uniqueness to the function tables.
 * Version 2 added `resource_function.restricted`.
 */
const SCHEMA_VERSION = 2;

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
            restricted INTEGER NOT NULL DEFAULT 0,
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

        -- Grants this node signed, kept so their audience can renew them.
        -- A delegated grant's parent_grant_issuer and parent_grant_id name the held grant it narrows.
        CREATE TABLE IF NOT EXISTS issued_grant (
            id TEXT PRIMARY KEY,
            audience TEXT NOT NULL,
            capabilities TEXT NOT NULL,
            parent_grant_issuer TEXT,
            parent_grant_id TEXT,
            lifetime_ms INTEGER NOT NULL,
            renewable_until TEXT,
            created_at TEXT NOT NULL
        );

        -- Chains whose leaf grant names this node as its audience, keyed by the leaf's issuer and id.
        -- Issuers choose their own ids, so an id alone doesn't identify a grant.
        CREATE TABLE IF NOT EXISTS held_grant (
            issuer TEXT NOT NULL,
            id TEXT NOT NULL,
            root_issuer_base_url TEXT NOT NULL,
            chain TEXT NOT NULL,
            issued_at TEXT NOT NULL,
            expires_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,

            PRIMARY KEY (issuer, id)
        );
        CREATE INDEX IF NOT EXISTS held_grant_root ON held_grant (root_issuer_base_url, expires_at);

        -- Keyed like held grants, so revoking one issuer's grant leaves another's with the same id alone.
        CREATE TABLE IF NOT EXISTS revoked_grant (
            issuer TEXT NOT NULL,
            grant_id TEXT NOT NULL,
            revoked_at TEXT NOT NULL,

            PRIMARY KEY (issuer, grant_id)
        );

        -- publicKey:nonce of accepted authorizations and grant requests, until they expire.
        CREATE TABLE IF NOT EXISTS seen_nonce (
            key TEXT PRIMARY KEY,
            expires_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS seen_nonce_expires_at ON seen_nonce (expires_at);

        -- Keys an admin blocked from calling this node or getting grants from it.
        CREATE TABLE IF NOT EXISTS blocked_caller (
            public_key TEXT PRIMARY KEY,
            reason TEXT,
            blocked_at TEXT NOT NULL
        );
    `);

    await db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
}
