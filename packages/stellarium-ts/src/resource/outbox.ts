import type { FixedPaymentVoucher, InferenceVoucher, OperatorClient, PaymentSubmission, SettleResult } from "../client/operatorClient.js";
import type { NodeDatabase } from "../db/database.js";

/** How long a sent settlement is left alone before the worker may send it again. */
export const OUTBOX_LEASE_MS = 60_000;
/** The first wait before resending a settlement the operator couldn't take. It doubles, up to the maximum. */
export const OUTBOX_RETRY_INITIAL_MS = 1_000;
export const OUTBOX_RETRY_MAX_MS = 5 * 60_000;
/**
 * A settlement still undelivered after this long is given up. The operator expires a run or voucher whose node
 * never settled it long before, so by then it would refuse it anyway.
 */
export const OUTBOX_MAX_AGE_MS = 24 * 60 * 60_000;
export const DEFAULT_OUTBOX_WORKER_INTERVAL_MS = 5_000;

type Settlement =
    | { path: '/runs/capture', body: { runId: string, tokens: number, failed?: boolean } }
    | { path: '/runs/release', body: { runId: string } }
    | { path: '/payments/capture', body: PaymentSubmission }
    | { path: '/payments/release', body: { voucher: FixedPaymentVoucher | InferenceVoucher } }
    | { path: '/runs/receipts', body: { runId: string, receipts: unknown[], signature: string } };

interface OutboxRow {
    id: number;
    key: string;
    path: Settlement['path'];
    body: string;
    attempts: number;
    next_attempt_at: string;
    created_at: string;
}

/**
 * Captures and releases this node owes the operator (docs/money.md, Settlement). Each is written to the
 * database before the call that owes it answers, sent at once, and resent with backoff until the operator
 * accepts it or refuses it for good, so neither a crash nor an operator outage loses one. Every settlement is
 * idempotent on the operator, so sending one twice is safe.
 */
export class SettlementOutbox {
    private closed = false;

    constructor(
        private readonly db: NodeDatabase,
        private readonly operatorClient: OperatorClient,
        private readonly log: (error: unknown, message: string) => void = (error, message) => console.error(message, error),
    ) {}

    /** Captures a run with the tokens it executed. A `failed` run's money changes are dropped. */
    captureRun(runId: string, tokens: number, failed = false): Promise<void> {
        return this.enqueue(`run:${runId}`, { path: '/runs/capture', body: failed ? { runId, tokens, failed } : { runId, tokens } });
    }

    /** Releases a run without charging it. */
    releaseRun(runId: string): Promise<void> {
        return this.enqueue(`run:${runId}`, { path: '/runs/release', body: { runId } });
    }

    /** Captures a voucher. */
    capturePayment(payment: PaymentSubmission): Promise<void> {
        return this.enqueue(`payment:${payment.voucher.requestId}:${payment.voucher.invocationId}`, { path: '/payments/capture', body: payment });
    }

    /** Releases a voucher without charging it. */
    releasePayment(voucher: FixedPaymentVoucher | InferenceVoucher): Promise<void> {
        return this.enqueue(`payment:${voucher.requestId}:${voucher.invocationId}`, { path: '/payments/release', body: { voucher } });
    }

    /** Sends receipts of a tree's contract runs, which the operator replays. Each set is sent once. */
    submitReceipts(runId: string, receipts: unknown[], signature: string): Promise<void> {
        return this.enqueue(`receipts:${runId}:${signature}`, { path: '/runs/receipts', body: { runId, receipts, signature } });
    }

    /**
     * Keeps the settlement, then sends it after returning. A run or voucher is settled once: a second
     * settlement for the same one is ignored.
     */
    private async enqueue(key: string, settlement: Settlement): Promise<void> {
        const now = Date.now();
        // Leased from the start, so the worker leaves it to the first attempt.
        const inserted = await this.db.run(
            'INSERT INTO settlement_outbox (key, path, body, attempts, next_attempt_at, created_at) VALUES (?, ?, ?, 0, ?, ?) ON CONFLICT (key) DO NOTHING',
            [key, settlement.path, JSON.stringify(settlement.body), new Date(now + OUTBOX_LEASE_MS).toISOString(), new Date(now).toISOString()],
        );
        if (inserted.changes === 0) {
            return;
        }
        setTimeout(() => {
            void this.attempt(key, settlement, 0, now);
        }, 0);
    }

    /** Sends the settlements that are due. Returns how many were delivered or given up. */
    async deliverDue(now: Date = new Date()): Promise<number> {
        const due = await this.db.all<OutboxRow[]>(
            'SELECT * FROM settlement_outbox WHERE next_attempt_at <= ? ORDER BY id LIMIT 100',
            [now.toISOString()],
        );
        let settled = 0;
        for (const row of due) {
            if (this.closed) break;
            // Claimed by moving its next attempt, so two workers never send it at once.
            const claimed = await this.db.run(
                'UPDATE settlement_outbox SET next_attempt_at = ? WHERE id = ? AND next_attempt_at = ?',
                [new Date(now.getTime() + OUTBOX_LEASE_MS).toISOString(), row.id, row.next_attempt_at],
            );
            if (claimed.changes === 0) continue;
            const settlement = { path: row.path, body: JSON.parse(row.body) } as Settlement;
            if (await this.attempt(row.key, settlement, row.attempts, Date.parse(row.created_at))) settled++;
        }
        return settled;
    }

    /** Resends due settlements every `intervalMs`, one pass at a time. */
    startWorker(intervalMs: number = DEFAULT_OUTBOX_WORKER_INTERVAL_MS): { stop: () => void } {
        let running = false;
        const timer = setInterval(async () => {
            if (running || this.closed) return;
            running = true;
            try {
                await this.deliverDue();
            } catch (error) {
                this.log(error, 'Failed to deliver settlements to the operator');
            } finally {
                running = false;
            }
        }, intervalMs);
        timer.unref();
        // Settlements left from before a restart go first.
        void this.deliverDue().catch(error => this.log(error, 'Failed to deliver settlements to the operator'));
        return {
            stop: () => {
                this.closed = true;
                clearInterval(timer);
            },
        };
    }

    /** Sends one settlement. True once it's done with: accepted, refused for good, or too old. */
    private async attempt(key: string, settlement: Settlement, attempts: number, createdAt: number): Promise<boolean> {
        let result: SettleResult | undefined;
        let failure: unknown;
        try {
            result = await this.send(settlement);
        } catch (error) {
            failure = error;
        }
        try {
            // A mocked client may answer nothing, which counts as accepted.
            const accepted = failure === undefined && result?.ok !== false;
            const retryable = failure !== undefined || (result?.ok === false && result.retryable);
            if (accepted || !retryable) {
                if (!accepted && result?.ok === false) {
                    // The operator won't change its mind: a run already settled or expired, or a voucher it never held.
                    this.log(result.error, `Operator refused ${settlement.path} for ${key}`);
                }
                await this.db.run('DELETE FROM settlement_outbox WHERE key = ?', [key]);
                return true;
            }
            if (Date.now() - createdAt > OUTBOX_MAX_AGE_MS) {
                this.log(failure ?? (result?.ok === false ? result.error : undefined), `Gave up on ${settlement.path} for ${key} after ${attempts + 1} attempts`);
                await this.db.run('DELETE FROM settlement_outbox WHERE key = ?', [key]);
                return true;
            }
            const delay = Math.min(OUTBOX_RETRY_INITIAL_MS * 2 ** attempts, OUTBOX_RETRY_MAX_MS);
            await this.db.run('UPDATE settlement_outbox SET attempts = ?, next_attempt_at = ? WHERE key = ?', [attempts + 1, new Date(Date.now() + delay).toISOString(), key]);
            return false;
        } catch (error) {
            // Most likely the database closed under it. The row stays, and the next start sends it.
            if (!this.closed) this.log(error, `Failed to record the delivery of ${settlement.path} for ${key}`);
            return false;
        }
    }

    private send(settlement: Settlement): Promise<SettleResult> {
        switch (settlement.path) {
            case '/runs/capture': return this.operatorClient.captureRun(settlement.body);
            case '/runs/release': return this.operatorClient.releaseRun(settlement.body);
            case '/payments/capture': return this.operatorClient.capture(settlement.body);
            case '/payments/release': return this.operatorClient.release(settlement.body.voucher);
            case '/runs/receipts': return this.operatorClient.submitReceipts(settlement.body);
        }
    }
}
