export type DatabaseDialect = 'sqlite' | 'postgres';

export interface RunResult {
    /** Rows the statement inserted, updated or deleted. */
    changes: number;
}

/**
 * The node's database, SQLite or Postgres. SQL uses `?` placeholders on both, and sticks to what both
 * accept: `ON CONFLICT` instead of `INSERT OR IGNORE`, and `RETURNING id` instead of the last insert id.
 */
export interface NodeDatabase {
    readonly dialect: DatabaseDialect;
    get<T = any>(sql: string, params?: unknown[]): Promise<T | undefined>;
    all<T = any[]>(sql: string, params?: unknown[]): Promise<T>;
    run(sql: string, params?: unknown[]): Promise<RunResult>;
    /** Runs one or more statements without parameters. */
    exec(sql: string): Promise<void>;
    /**
     * Runs `work` in a transaction, committing if it resolves and rolling back if it throws. Transactions
     * are serialized, so `work` must not start another one, and must query through `tx` only: on a database
     * with one connection, such as PGlite, a query through the database waits for the transaction to end.
     */
    transaction<T>(work: (tx: NodeDatabase) => Promise<T>): Promise<T>;
    close(): Promise<void>;
}
