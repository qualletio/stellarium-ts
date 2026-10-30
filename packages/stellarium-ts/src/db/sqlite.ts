import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import sqlite3 from 'sqlite3';
import { open, type Database } from 'sqlite';
import type { NodeDatabase, RunResult } from './database.js';

/** A SQLite file, or ':memory:'. */
export class SqliteDatabase implements NodeDatabase {
    readonly dialect = 'sqlite';
    // The connection is shared, so transactions are serialized to keep them from nesting.
    private writes: Promise<unknown> = Promise.resolve();

    private constructor(private readonly db: Database) {}

    static async open(filename: string): Promise<SqliteDatabase> {
        if (filename !== ':memory:') {
            mkdirSync(dirname(filename), { recursive: true });
        }
        return new SqliteDatabase(await open({ filename, driver: sqlite3.Database }));
    }

    get<T>(sql: string, params: unknown[] = []): Promise<T | undefined> {
        return this.db.get<T>(sql, params);
    }

    all<T>(sql: string, params: unknown[] = []): Promise<T> {
        return this.db.all<T>(sql, params);
    }

    async run(sql: string, params: unknown[] = []): Promise<RunResult> {
        const result = await this.db.run(sql, params);
        return { changes: result.changes ?? 0 };
    }

    exec(sql: string): Promise<void> {
        return this.db.exec(sql);
    }

    transaction<T>(work: (tx: NodeDatabase) => Promise<T>): Promise<T> {
        const run = async () => {
            await this.db.exec('BEGIN IMMEDIATE');
            try {
                const result = await work(this);
                await this.db.exec('COMMIT');
                return result;
            } catch (error) {
                await this.db.exec('ROLLBACK');
                throw error;
            }
        };
        const result = this.writes.then(run, run);
        this.writes = result.catch(() => undefined);
        return result;
    }

    close(): Promise<void> {
        return this.db.close();
    }
}
