import type { DatabaseDialect, NodeDatabase } from './database.js';
import { nodePostgresDriver, PostgresDatabase } from './postgres.js';
import { SqliteDatabase } from './sqlite.js';

export const DEFAULT_DATABASE_PATH = './requestscript.db';

/**
 * Bumped whenever the schema changes in a way `CREATE TABLE IF NOT EXISTS` can't apply.
 * Version 1 dropped `UNIQUE (base_url)` from `resource` and added uniqueness to the function tables.
 * Version 2 added `resource_function.restricted`.
 * Version 3 added `resource.website` and the `description` columns of the resource tables.
 * Version 4 renamed `resource_function_payment_manifest.cost_lamports` to `cost_micro_usdc` (payments moved to USDC).
 * Version 5 added `resource_function.kind` and per-token inference pricing, which made `cost_micro_usdc` nullable.
 * Version 6 moved payments to Stripe: `*_micro_usdc` columns became `*_micro_usd`, and `recipient_address`
 * became `recipient_organization_id`.
 * Version 7 added contract functions: `resource_function.kind` 'contract', priced per million tokens in
 * `resource_function_payment_manifest.price_micro_usd_per_million_tokens`.
 */
const SCHEMA_VERSION = 7;

export interface OpenDatabaseOptions {
    /** Postgres only: the schema the node's tables live in, created if missing. Lets nodes share a database. */
    schema?: string;
}

export function isPostgresUrl(location: string): boolean {
    return location.startsWith('postgres://') || location.startsWith('postgresql://');
}

/**
 * Opens the node database and brings its schema up to date. `location` is a `postgres://` or
 * `postgresql://` URL, or a SQLite file. Pass ':memory:' for tests.
 */
export async function openDatabase(location: string = DEFAULT_DATABASE_PATH, options: OpenDatabaseOptions = {}): Promise<NodeDatabase> {
    const db = isPostgresUrl(location)
        ? await PostgresDatabase.open(nodePostgresDriver(location, options.schema), options.schema)
        : await SqliteDatabase.open(location);
    try {
        await createTables(db);
    } catch (error) {
        await db.close();
        throw error;
    }
    return db;
}

/** Column types that differ between the dialects. */
function columnTypes(dialect: DatabaseDialect) {
    return dialect === 'sqlite'
        ? { id: 'INTEGER PRIMARY KEY AUTOINCREMENT', bigint: 'INTEGER' }
        : { id: 'BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY', bigint: 'BIGINT' };
}

/** SQLite keeps the version in `PRAGMA user_version`; Postgres, which has no equivalent, in a one-row table. */
async function getSchemaVersion(db: NodeDatabase): Promise<number> {
    if (db.dialect === 'sqlite') {
        return (await db.get<{ user_version: number }>('PRAGMA user_version'))?.user_version ?? 0;
    }
    await db.exec('CREATE TABLE IF NOT EXISTS stellarium_schema (version INTEGER NOT NULL)');
    return (await db.get<{ version: number }>('SELECT version FROM stellarium_schema'))?.version ?? 0;
}

async function setSchemaVersion(db: NodeDatabase, version: number): Promise<void> {
    if (db.dialect === 'sqlite') {
        await db.exec(`PRAGMA user_version = ${version}`);
        return;
    }
    await db.exec(`DELETE FROM stellarium_schema; INSERT INTO stellarium_schema (version) VALUES (${version})`);
}

export async function createTables(db: NodeDatabase) {
    const version = await getSchemaVersion(db);
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

    const t = columnTypes(db.dialect);
    await db.exec(`
        CREATE TABLE IF NOT EXISTS peer (
            id ${t.id},
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
            id ${t.id},
            peer_id ${t.bigint},
            path TEXT NOT NULL,
            name TEXT NOT NULL,
            base_url TEXT NOT NULL,
            website TEXT,
            description TEXT,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,

            FOREIGN KEY (peer_id) REFERENCES peer(id),

            UNIQUE (path, name)
        );

        CREATE TABLE IF NOT EXISTS resource_function (
            id ${t.id},
            resource_id ${t.bigint} NOT NULL,
            name TEXT NOT NULL,
            return_type TEXT NOT NULL,
            description TEXT,
            restricted INTEGER NOT NULL DEFAULT 0,
            kind TEXT NOT NULL DEFAULT 'fixed',
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,

            FOREIGN KEY (resource_id) REFERENCES resource(id),

            UNIQUE (resource_id, name)
        );

        CREATE TABLE IF NOT EXISTS resource_function_parameter (
            id ${t.id},
            resource_function_id ${t.bigint} NOT NULL,
            name TEXT NOT NULL,
            parameter_type TEXT NOT NULL,
            description TEXT,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,

            FOREIGN KEY (resource_function_id) REFERENCES resource_function(id),

            UNIQUE (resource_function_id, name)
        );

        CREATE TABLE IF NOT EXISTS resource_function_payment_manifest (
            id ${t.id},
            resource_function_id ${t.bigint} NOT NULL,
            -- Null for inference and contract functions, which are priced per million tokens instead.
            cost_micro_usd ${t.bigint},
            input_cost_micro_usd_per_million_tokens ${t.bigint},
            output_cost_micro_usd_per_million_tokens ${t.bigint},
            -- Set for contract functions, which are charged for the tokens they execute.
            price_micro_usd_per_million_tokens ${t.bigint},
            -- The hosting node's organization. Null only if a peer advertised the manifest without one.
            recipient_organization_id TEXT,
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
            lifetime_ms ${t.bigint} NOT NULL,
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
            expires_at ${t.bigint} NOT NULL
        );
        CREATE INDEX IF NOT EXISTS seen_nonce_expires_at ON seen_nonce (expires_at);

        -- Contracts deployed to this node. Versions are immutable. The latest version of each is one of the
        -- node's resources, with a single function, run. An owner of null is the node's admin.
        CREATE TABLE IF NOT EXISTS contract (
            path TEXT NOT NULL,
            name TEXT NOT NULL,
            version TEXT NOT NULL,
            source TEXT NOT NULL,
            -- JSON: [{ name, type }]
            parameters TEXT NOT NULL,
            return_type TEXT NOT NULL,
            owner_organization_id TEXT,
            description TEXT,
            created_at TEXT NOT NULL,

            PRIMARY KEY (path, name, version)
        );

        -- The state variables of the contracts deployed to this node, kept across versions. scope_key is ''
        -- for a variable's shared copy, and 's:<string>' or 'i:<integer>' for a scoped one. value is the
        -- variable's encoded JSON, and version counts its writes, so a call can't save over a newer copy.
        CREATE TABLE IF NOT EXISTS contract_state (
            path TEXT NOT NULL,
            name TEXT NOT NULL,
            var_name TEXT NOT NULL,
            scope_key TEXT NOT NULL,
            value TEXT NOT NULL,
            type TEXT NOT NULL,
            version ${t.bigint} NOT NULL,
            updated_at TEXT NOT NULL,

            PRIMARY KEY (path, name, var_name, scope_key)
        );

        -- Keys an admin blocked from calling this node or getting grants from it.
        CREATE TABLE IF NOT EXISTS blocked_caller (
            public_key TEXT PRIMARY KEY,
            reason TEXT,
            blocked_at TEXT NOT NULL
        );

        -- Event types this node declared (local = 1), and those it learned from the nodes that declared them.
        -- fields is JSON: [{ name, type }]. Versions are immutable, and every version of a type has one owner.
        CREATE TABLE IF NOT EXISTS event_type (
            path TEXT NOT NULL,
            name TEXT NOT NULL,
            version TEXT NOT NULL,
            fields TEXT NOT NULL,
            restricted INTEGER NOT NULL,
            owner_organization_id TEXT NOT NULL,
            base_url TEXT NOT NULL,
            local INTEGER NOT NULL,
            source TEXT,
            description TEXT,
            created_at TEXT NOT NULL,

            PRIMARY KEY (path, name, version)
        );

        -- Structs this node declared (local = 1), and those it learned from nodes of their owner. fields is JSON:
        -- [{ name, type }]. A struct's path belongs to one organization, and a version never changes or goes away.
        CREATE TABLE IF NOT EXISTS struct_type (
            path TEXT NOT NULL,
            name TEXT NOT NULL,
            version TEXT NOT NULL,
            fields TEXT NOT NULL,
            owner_organization_id TEXT NOT NULL,
            base_url TEXT NOT NULL,
            local INTEGER NOT NULL,
            source TEXT,
            description TEXT,
            created_at TEXT NOT NULL,

            PRIMARY KEY (path, name, version)
        );

        -- This node's event contracts: which contract consumes which event type, at the version it was deployed
        -- against. An event contract isn't one of the node's resources: it runs only with events. mandate_id is
        -- the operator's event mandate that bills another organization for its runs, null when they are free.
        CREATE TABLE IF NOT EXISTS event_consumer (
            path TEXT NOT NULL,
            name TEXT NOT NULL,
            event_path TEXT NOT NULL,
            event_name TEXT NOT NULL,
            event_version TEXT NOT NULL,
            owner_organization_id TEXT,
            mandate_id TEXT,

            PRIMARY KEY (path, name)
        );

        -- Peers' event contracts, from their announcements, so this node knows where to deliver its events.
        CREATE TABLE IF NOT EXISTS event_subscription (
            base_url TEXT NOT NULL,
            event_path TEXT NOT NULL,
            event_name TEXT NOT NULL,
            event_version TEXT NOT NULL,
            consumer TEXT NOT NULL,
            owner_organization_id TEXT,

            PRIMARY KEY (base_url, event_path, event_name, event_version, consumer)
        );

        -- Events this node published, one row per node subscribed to them, until delivered or given up on.
        -- status is 'pending', 'sending', 'delivered' or 'failed'. next_attempt_at is in epoch milliseconds.
        CREATE TABLE IF NOT EXISTS event_outbox (
            id ${t.id},
            event_id TEXT NOT NULL,
            target_base_url TEXT NOT NULL,
            envelope TEXT NOT NULL,
            status TEXT NOT NULL,
            attempts INTEGER NOT NULL,
            next_attempt_at ${t.bigint} NOT NULL,
            last_error TEXT,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,

            UNIQUE (event_id, target_base_url)
        );
        CREATE INDEX IF NOT EXISTS event_outbox_status_next_attempt_at ON event_outbox (status, next_attempt_at);

        -- Events delivered to this node, one row per event contract that consumes them. The key makes a
        -- redelivered event a no-op. status is 'pending', 'running', 'done' or 'failed'.
        CREATE TABLE IF NOT EXISTS event_inbox (
            event_id TEXT NOT NULL,
            consumer_path TEXT NOT NULL,
            consumer_name TEXT NOT NULL,
            envelope TEXT NOT NULL,
            status TEXT NOT NULL,
            attempts INTEGER NOT NULL,
            next_attempt_at ${t.bigint} NOT NULL,
            last_error TEXT,
            received_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,

            PRIMARY KEY (event_id, consumer_path, consumer_name)
        );
        CREATE INDEX IF NOT EXISTS event_inbox_status_next_attempt_at ON event_inbox (status, next_attempt_at);
    `);

    await setSchemaVersion(db, SCHEMA_VERSION);
}
