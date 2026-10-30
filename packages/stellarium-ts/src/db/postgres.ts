import pg from 'pg';
import type { NodeDatabase, RunResult } from './database.js';

/** What `PostgresDatabase` needs from a Postgres client: node-postgres in production, PGlite in tests. */
export interface PostgresDriver {
    query(text: string, params: unknown[]): Promise<{ rows: any[], rowCount: number }>;
    /** Runs one or more statements without parameters. */
    exec(text: string): Promise<void>;
    /** Runs `work` on one connection inside BEGIN and COMMIT, or ROLLBACK if it throws. */
    transaction<T>(work: (driver: PostgresDriver) => Promise<T>): Promise<T>;
    close(): Promise<void>;
}

const INT8_OID = 20;

/** Schema names are interpolated into SQL, so only plain identifiers are accepted. */
export function assertSchemaName(schema: string): void {
    if (!/^[a-z_][a-z0-9_]*$/.test(schema)) {
        throw new Error(`Invalid database schema '${schema}': use lowercase letters, digits and underscores`);
    }
}

/** Rewrites `?` placeholders to `$1`, `$2`, ..., leaving quoted strings and identifiers alone. */
export function numberPlaceholders(sql: string): string {
    let index = 0;
    let quote: string | undefined;
    let result = '';
    for (const char of sql) {
        if (quote) {
            if (char === quote) {
                quote = undefined;
            }
            result += char;
        } else if (char === "'" || char === '"') {
            quote = char;
            result += char;
        } else if (char === '?') {
            result += `$${++index}`;
        } else {
            result += char;
        }
    }
    return result;
}

/** A node-postgres pool. 64-bit integers come back as numbers, like SQLite's. */
export function nodePostgresDriver(url: string, schema?: string): PostgresDriver {
    const pool = new pg.Pool({
        connectionString: url,
        // Every connection resolves unqualified names in the node's schema.
        options: schema ? `-c search_path=${schema}` : undefined,
        types: { getTypeParser: ((oid: number, format?: string) => oid === INT8_OID ? Number : pg.types.getTypeParser(oid, format as 'text')) as typeof pg.types.getTypeParser },
    });
    const onClient = (client: pg.PoolClient): PostgresDriver => ({
        query: async (text, params) => {
            const result = await client.query(text, params);
            return { rows: result.rows, rowCount: result.rowCount ?? 0 };
        },
        exec: async (text) => {
            await client.query(text);
        },
        transaction: () => {
            throw new Error('Transactions cannot be nested');
        },
        close: async () => {},
    });
    return {
        query: async (text, params) => {
            const result = await pool.query(text, params);
            return { rows: result.rows, rowCount: result.rowCount ?? 0 };
        },
        exec: async (text) => {
            await pool.query(text);
        },
        transaction: async (work) => {
            const client = await pool.connect();
            try {
                await client.query('BEGIN');
                try {
                    const result = await work(onClient(client));
                    await client.query('COMMIT');
                    return result;
                } catch (error) {
                    await client.query('ROLLBACK');
                    throw error;
                }
            } finally {
                client.release();
            }
        },
        close: () => pool.end(),
    };
}

export class PostgresDatabase implements NodeDatabase {
    readonly dialect = 'postgres';

    /** `inTransaction` is set on the handle a transaction's work receives. */
    constructor(private readonly driver: PostgresDriver, private readonly inTransaction = false) {}

    /** Creates `schema` if it doesn't exist. The driver must already resolve names in it. */
    static async open(driver: PostgresDriver, schema?: string): Promise<PostgresDatabase> {
        if (schema) {
            assertSchemaName(schema);
            await driver.exec(`CREATE SCHEMA IF NOT EXISTS ${schema}`);
        }
        return new PostgresDatabase(driver);
    }

    async get<T>(sql: string, params: unknown[] = []): Promise<T | undefined> {
        const { rows } = await this.driver.query(numberPlaceholders(sql), params);
        return rows[0];
    }

    async all<T>(sql: string, params: unknown[] = []): Promise<T> {
        const { rows } = await this.driver.query(numberPlaceholders(sql), params);
        return rows as T;
    }

    async run(sql: string, params: unknown[] = []): Promise<RunResult> {
        const { rowCount } = await this.driver.query(numberPlaceholders(sql), params);
        return { changes: rowCount };
    }

    exec(sql: string): Promise<void> {
        return this.driver.exec(sql);
    }

    /**
     * Transactions take one advisory lock for the node's schema, so they run one at a time as they do on
     * SQLite. Their check-then-insert writes rely on that.
     */
    transaction<T>(work: (tx: NodeDatabase) => Promise<T>): Promise<T> {
        if (this.inTransaction) {
            throw new Error('Transactions cannot be nested');
        }
        return this.driver.transaction(async (driver) => {
            await driver.query('SELECT pg_advisory_xact_lock(hashtext(current_schema()))', []);
            return work(new PostgresDatabase(driver, true));
        });
    }

    close(): Promise<void> {
        return this.driver.close();
    }
}
