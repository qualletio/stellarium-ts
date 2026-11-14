import type { StateScope, StateWrite, StoredState } from "requestscript";
import type { NodeDatabase } from "../db/database.js";

export const DEFAULT_MAX_CONTRACT_STATE_BYTES = 64 * 1024;

/** How a scope is stored: '' for the shared copy, and a prefix keeping the scope's kind, so 3 and "3" differ. */
export function scopeKey(scope: StateScope): string {
    if (scope === null) {
        return '';
    }
    return `${scope.kind === 'string' ? 's' : 'i'}:${scope.key}`;
}

export function scopeFromKey(key: string): StateScope {
    if (key === '') {
        return null;
    }
    return { kind: key.startsWith('s:') ? 'string' : 'integer', key: key.slice(2) };
}

export interface ContractStateRow {
    variable: string;
    scope: StateScope;
    value: unknown;
    updatedAt: string;
}

interface StateRow {
    var_name: string;
    scope_key: string;
    value: string;
    type: string;
    version: number;
    updated_at: string;
}

/** A write to one contract's state. */
export interface ContractStateWrite {
    path: string;
    name: string;
    write: StateWrite;
}

/** Why `commit` saved nothing. */
export type CommitRefusal = { reason: 'conflict' } | { reason: 'too_large', scope: StateScope, bytes: number };

class CommitRefused extends Error {
    constructor(readonly refusal: CommitRefusal) {
        super(refusal.reason);
    }
}

/**
 * The state variables of contracts, one row per variable and scope. A row's version counts its writes, so a
 * call that read an older copy can't save over a newer one.
 */
export class ContractStateRepository {
    constructor(private readonly db: NodeDatabase) {}

    async get(path: string, name: string, variable: string, scope: StateScope): Promise<StoredState | undefined> {
        const row = await this.db.get<StateRow>(
            'SELECT value, type, version FROM contract_state WHERE path = ? AND name = ? AND var_name = ? AND scope_key = ?',
            [path, name, variable, scopeKey(scope)],
        );
        return row && { value: JSON.parse(row.value), type: row.type, version: row.version };
    }

    /**
     * Saves every write of one call, or none. A write carrying the version its call read saves only over that
     * version, and one without a version only where nothing is stored, so a copy changed during the call is a
     * conflict. Each scope written to must stay within `maxBytes`, its variables' encoded values together.
     */
    async commit(path: string, name: string, writes: StateWrite[], maxBytes: number): Promise<{ ok: true } | ({ ok: false } & CommitRefusal)> {
        return this.commitAll(writes.map(write => ({ path, name, write })), maxBytes);
    }

    /** `commit` for writes to several contracts, saved in order, all or none. */
    async commitAll(writes: ContractStateWrite[], maxBytes: number): Promise<{ ok: true } | ({ ok: false } & CommitRefusal)> {
        try {
            await this.db.transaction(async (tx) => {
                const now = new Date().toISOString();
                for (const { path, name, write } of writes) {
                    const key = scopeKey(write.scope);
                    const value = JSON.stringify(write.value);
                    const result = write.version === undefined
                        ? await tx.run(
                            'INSERT INTO contract_state (path, name, var_name, scope_key, value, type, version, updated_at) VALUES (?, ?, ?, ?, ?, ?, 1, ?) ON CONFLICT DO NOTHING',
                            [path, name, write.name, key, value, write.type, now],
                        )
                        : await tx.run(
                            'UPDATE contract_state SET value = ?, type = ?, version = version + 1, updated_at = ? WHERE path = ? AND name = ? AND var_name = ? AND scope_key = ? AND version = ?',
                            [value, write.type, now, path, name, write.name, key, write.version],
                        );
                    if (result.changes === 0) {
                        throw new CommitRefused({ reason: 'conflict' });
                    }
                }
                const scopes = new Map(writes.map(({ path, name, write }) => [JSON.stringify([path, name, scopeKey(write.scope)]), { path, name, key: scopeKey(write.scope) }]));
                for (const { path, name, key } of scopes.values()) {
                    const rows = await tx.all<{ value: string }[]>('SELECT value FROM contract_state WHERE path = ? AND name = ? AND scope_key = ?', [path, name, key]);
                    const bytes = rows.reduce((sum, row) => sum + Buffer.byteLength(row.value), 0);
                    if (bytes > maxBytes) {
                        throw new CommitRefused({ reason: 'too_large', scope: scopeFromKey(key), bytes });
                    }
                }
            });
        } catch (error) {
            if (error instanceof CommitRefused) {
                return { ok: false, ...error.refusal };
            }
            throw error;
        }
        return { ok: true };
    }

    /** The encoded values stored in one scope of a contract, by variable. */
    async scopeValues(path: string, name: string, scope: StateScope): Promise<Map<string, string>> {
        const rows = await this.db.all<{ var_name: string, value: string }[]>('SELECT var_name, value FROM contract_state WHERE path = ? AND name = ? AND scope_key = ?', [path, name, scopeKey(scope)]);
        return new Map(rows.map(row => [row.var_name, row.value]));
    }

    /** Keeps a chain's writes until the operator settles the money run `runId` (docs/money.md, Settlement). */
    async savePending(runId: string, writes: ContractStateWrite[]): Promise<void> {
        await this.db.transaction(async (tx) => {
            const now = new Date().toISOString();
            for (const [seq, { path, name, write }] of writes.entries()) {
                await tx.run(
                    'INSERT INTO contract_pending_state (run_id, seq, path, name, var_name, scope_key, value, type, version, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
                    [runId, seq, path, name, write.name, scopeKey(write.scope), JSON.stringify(write.value), write.type, write.version === undefined ? null : Number(write.version), now],
                );
            }
        });
    }

    /** Every chain's pending writes, by the money run they wait for, in order. */
    async pending(): Promise<Map<string, ContractStateWrite[]>> {
        const rows = await this.db.all<{ run_id: string, path: string, name: string, var_name: string, scope_key: string, value: string, type: string, version: number | string | null }[]>(
            'SELECT run_id, path, name, var_name, scope_key, value, type, version FROM contract_pending_state ORDER BY run_id, seq',
        );
        const byRun = new Map<string, ContractStateWrite[]>();
        for (const row of rows) {
            const writes = byRun.get(row.run_id) ?? [];
            writes.push({
                path: row.path,
                name: row.name,
                write: { name: row.var_name, scope: scopeFromKey(row.scope_key), value: JSON.parse(row.value), type: row.type, ...(row.version === null ? {} : { version: Number(row.version) }) },
            });
            byRun.set(row.run_id, writes);
        }
        return byRun;
    }

    /** Saves a chain's pending writes, all or none, and forgets them either way. */
    async settlePending(runId: string, writes: ContractStateWrite[] | undefined, maxBytes: number): Promise<{ ok: true } | ({ ok: false } & CommitRefusal)> {
        const result = writes ? await this.commitAll(writes, maxBytes) : { ok: true as const };
        await this.db.run('DELETE FROM contract_pending_state WHERE run_id = ?', [runId]);
        return result;
    }

    /** Every variable and scope of a contract, with values as stored, ordered by variable then scope. */
    async list(path: string, name: string): Promise<ContractStateRow[]> {
        const rows = await this.db.all<StateRow[]>('SELECT var_name, scope_key, value, updated_at FROM contract_state WHERE path = ? AND name = ? ORDER BY var_name, scope_key', [path, name]);
        return rows.map(row => ({ variable: row.var_name, scope: scopeFromKey(row.scope_key), value: JSON.parse(row.value), updatedAt: row.updated_at }));
    }

    async deleteContract(path: string, name: string): Promise<void> {
        await this.db.run('DELETE FROM contract_state WHERE path = ? AND name = ?', [path, name]);
    }
}
