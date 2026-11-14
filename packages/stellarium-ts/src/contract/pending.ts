import type { StateScope, StateWrite, StoredState } from "requestscript";
import type { OperatorClient } from "../client/operatorClient.js";
import type { RunReceipt } from "./receipt.js";
import { type CommitRefusal, type ContractStateRepository, type ContractStateWrite, scopeKey } from "./state.js";

/** The first wait between asking the operator whether a chain's money settled. It doubles, up to the maximum. */
export const PENDING_POLL_INITIAL_MS = 250;
export const PENDING_POLL_MAX_MS = 10_000;

/**
 * One contract run in a chain, so a run that fails drops the writes of the runs it called, as the operator
 * drops their money (docs/money.md, Settlement).
 */
export class Frame {
    constructor(readonly parent?: Frame) {}

    /** Whether this frame is `ancestor` or runs inside it. */
    within(ancestor: Frame): boolean {
        for (let frame: Frame | undefined = this; frame; frame = frame.parent) {
            if (frame === ancestor) return true;
        }
        return false;
    }
}

/**
 * A chain of contract calls on this node, from its outermost contract. Once it moves money, its runs'
 * state writes wait in it, holding their scopes, until the chain ends, and then until the operator applies
 * or drops the chain's money.
 */
export class StateTransaction {
    /** Set once a run in the chain stages a money change, or a payable contract runs in it. */
    money = false;
    readonly writes: (ContractStateWrite & { frame: Frame })[] = [];
    /** The receipts of the chain's runs that succeeded, for the operator to replay once it moved money. */
    readonly receipts: { receipt: RunReceipt, frame: Frame }[] = [];
}

/** Thrown by a state read that waited too long for a scope another chain holds. */
export class StateBusy extends Error {}

type Owner = StateTransaction | string;

interface Hold {
    owner: Owner;
    released: Promise<void>;
    release: () => void;
}

const holdKey = (path: string, name: string, scope: StateScope) => JSON.stringify([path, name, scopeKey(scope)]);

/** The version a stored copy has once `write` is saved over it. */
const versionAfter = (write: StateWrite) => Number(write.version ?? 0) + 1;

/**
 * Coordinates contract state with money (docs/money.md, Settlement): holds the scopes a money chain wrote,
 * keeps its writes until the operator settles its money, and saves or discards them then.
 */
export class StateCoordinator {
    private readonly holds = new Map<string, Hold>();
    private readonly timers = new Set<NodeJS.Timeout>();
    private closed = false;

    constructor(
        private readonly state: ContractStateRepository,
        private readonly operatorClient: OperatorClient,
        private readonly maxBytes: () => number,
        private readonly log: (error: unknown, message: string) => void,
        private readonly pollInitialMs = PENDING_POLL_INITIAL_MS,
    ) {}

    /** The chain's own latest write of a variable, which its later runs read instead of the stored copy. */
    buffered(tx: StateTransaction, path: string, name: string, variable: string, scope: StateScope): StoredState | undefined {
        const key = scopeKey(scope);
        for (let i = tx.writes.length - 1; i >= 0; i--) {
            const { path: p, name: n, write } = tx.writes[i]!;
            if (p === path && n === name && write.name === variable && scopeKey(write.scope) === key) {
                return { value: write.value, type: write.type, version: versionAfter(write) };
            }
        }
        return undefined;
    }

    /** Whether a chain other than `tx` holds the scope. */
    heldByOther(tx: StateTransaction | undefined, path: string, name: string, scope: StateScope): boolean {
        const hold = this.holds.get(holdKey(path, name, scope));
        return hold !== undefined && hold.owner !== tx;
    }

    /** Waits up to `timeoutMs` for another chain's hold on the scope to end. False if it didn't. */
    async waitFor(tx: StateTransaction | undefined, path: string, name: string, scope: StateScope, timeoutMs: number): Promise<boolean> {
        const deadline = Date.now() + timeoutMs;
        while (this.heldByOther(tx, path, name, scope)) {
            const left = deadline - Date.now();
            if (left <= 0) return false;
            let timer: NodeJS.Timeout | undefined;
            await Promise.race([
                this.holds.get(holdKey(path, name, scope))!.released,
                new Promise<void>(resolve => { timer = setTimeout(resolve, left); }),
            ]);
            clearTimeout(timer);
        }
        return true;
    }

    /** Holds every scope the writes touch for `owner`. Refuses, holding nothing new, if another chain holds one. */
    private take(owner: Owner, keys: string[]): string[] | undefined {
        if (keys.some(key => { const hold = this.holds.get(key); return hold !== undefined && hold.owner !== owner; })) {
            return undefined;
        }
        const taken: string[] = [];
        for (const key of new Set(keys)) {
            if (this.holds.has(key)) continue;
            let release!: () => void;
            const released = new Promise<void>(resolve => { release = resolve; });
            this.holds.set(key, { owner, released, release });
            taken.push(key);
        }
        return taken;
    }

    private releaseKeys(keys: Iterable<string>): void {
        for (const key of keys) {
            this.holds.get(key)?.release();
            this.holds.delete(key);
        }
    }

    private releaseOwner(owner: Owner): void {
        this.releaseKeys([...this.holds].filter(([, hold]) => hold.owner === owner).map(([key]) => key));
    }

    /**
     * Saves a run's writes now, for a chain that moves no money. Refused as a conflict while another chain
     * holds a scope it writes, whose writes would otherwise be saved over.
     */
    async commitNow(path: string, name: string, writes: StateWrite[]): Promise<{ ok: true } | ({ ok: false } & CommitRefusal)> {
        // A chain of its own for the moment it saves, so no money chain buffers over the copy it's replacing.
        const owner = new StateTransaction();
        const taken = this.take(owner, writes.map(write => holdKey(path, name, write.scope)));
        if (!taken) return { ok: false, reason: 'conflict' };
        try {
            return await this.state.commit(path, name, writes, this.maxBytes());
        } finally {
            this.releaseKeys(taken);
        }
    }

    /**
     * Keeps a run's writes in its money chain, holding their scopes. Refuses a write over a copy that changed
     * since the run read it, in the chain or stored, a scope another chain holds, and a scope that would grow
     * past the size limit.
     */
    async buffer(tx: StateTransaction, frame: Frame, path: string, name: string, writes: StateWrite[]): Promise<{ ok: true } | ({ ok: false } & CommitRefusal)> {
        const taken = this.take(tx, writes.map(write => holdKey(path, name, write.scope)));
        if (!taken) return { ok: false, reason: 'conflict' };
        const refuse = (refusal: CommitRefusal) => {
            this.releaseKeys(taken);
            return { ok: false as const, ...refusal };
        };
        for (const write of writes) {
            const current = this.buffered(tx, path, name, write.name, write.scope)?.version
                ?? (await this.state.get(path, name, write.name, write.scope))?.version;
            const expected = write.version === undefined ? undefined : Number(write.version);
            if ((current === undefined ? undefined : Number(current)) !== expected) {
                return refuse({ reason: 'conflict' });
            }
        }
        const maxBytes = this.maxBytes();
        for (const scope of new Map(writes.map(write => [scopeKey(write.scope), write.scope])).values()) {
            const values = await this.state.scopeValues(path, name, scope);
            for (const entry of [...tx.writes.map(({ path: p, name: n, write }) => ({ p, n, write })), ...writes.map(write => ({ p: path, n: name, write }))]) {
                if (entry.p === path && entry.n === name && scopeKey(entry.write.scope) === scopeKey(scope)) {
                    values.set(entry.write.name, JSON.stringify(entry.write.value));
                }
            }
            const bytes = [...values.values()].reduce((sum, value) => sum + Buffer.byteLength(value), 0);
            if (bytes > maxBytes) return refuse({ reason: 'too_large', scope, bytes });
        }
        tx.writes.push(...writes.map(write => ({ path, name, write, frame })));
        return { ok: true };
    }

    /** Drops the writes of a run that failed, and of the runs it called, and the holds only they needed. */
    drop(tx: StateTransaction, frame: Frame): void {
        const receipts = tx.receipts.filter(entry => !entry.frame.within(frame));
        tx.receipts.splice(0, tx.receipts.length, ...receipts);
        const kept = tx.writes.filter(entry => !entry.frame.within(frame));
        if (kept.length === tx.writes.length) return;
        tx.writes.splice(0, tx.writes.length, ...kept);
        const needed = new Set(kept.map(({ path, name, write }) => holdKey(path, name, write.scope)));
        this.releaseKeys([...this.holds].filter(([key, hold]) => hold.owner === tx && !needed.has(key)).map(([key]) => key));
    }

    /**
     * Ends a chain, from its outermost contract. Its writes, if any, wait for the operator to settle the money
     * run `runId`: they're kept in the database, holding their scopes, and saved once the run's tree is applied,
     * or discarded once it's dropped. Without a run there's no money to wait for, and they're saved now.
     */
    async end(tx: StateTransaction, runId: string | undefined): Promise<void> {
        const writes = tx.writes.map(({ path, name, write }) => ({ path, name, write }));
        if (writes.length === 0) {
            this.releaseOwner(tx);
            return;
        }
        if (runId === undefined) {
            try {
                const saved = await this.state.commitAll(writes, this.maxBytes());
                if (!saved.ok) this.log(saved.reason, 'Failed to save the state of a contract chain');
            } finally {
                this.releaseOwner(tx);
            }
            return;
        }
        try {
            await this.state.savePending(runId, writes);
        } catch (error) {
            this.releaseOwner(tx);
            throw error;
        }
        // The holds now belong to the pending writes, until the operator answers.
        for (const hold of this.holds.values()) {
            if (hold.owner === tx) hold.owner = runId;
        }
        this.poll(runId, this.pollInitialMs);
    }

    /** Holds the scopes of every chain still waiting from before a restart, and asks about them again. */
    async resume(): Promise<number> {
        const pending = await this.state.pending();
        for (const [runId, writes] of pending) {
            this.take(runId, writes.map(({ path, name, write }) => holdKey(path, name, write.scope)));
            this.poll(runId, 0);
        }
        return pending.size;
    }

    /** Stops asking the operator. Pending writes stay in the database for the next start. */
    close(): void {
        this.closed = true;
        for (const timer of this.timers) clearTimeout(timer);
        this.timers.clear();
    }

    private poll(runId: string, delayMs: number): void {
        if (this.closed) return;
        const timer = setTimeout(async () => {
            this.timers.delete(timer);
            if (this.closed) return;
            try {
                const answer = await this.operatorClient.runOutcome({ runId });
                // An operator that doesn't know the run, or won't say, never will: nothing it decided moved money.
                const outcome = answer.ok ? answer.outcome : answer.status === 404 || answer.status === 403 ? 'dropped' : 'pending';
                if (outcome === 'pending') {
                    this.poll(runId, Math.min(Math.max(delayMs * 2, this.pollInitialMs), PENDING_POLL_MAX_MS));
                    return;
                }
                if (this.closed) return;
                const writes = outcome === 'applied' ? (await this.state.pending()).get(runId) ?? [] : undefined;
                const saved = await this.state.settlePending(runId, writes, this.maxBytes());
                if (!saved.ok) {
                    this.log(saved.reason, `Failed to save the state of contract run ${runId} after its money was applied`);
                }
                this.releaseOwner(runId);
            } catch (error) {
                this.log(error, `Failed to settle the state of contract run ${runId}`);
                this.poll(runId, PENDING_POLL_MAX_MS);
            }
        }, delayMs);
        timer.unref();
        this.timers.add(timer);
    }
}
