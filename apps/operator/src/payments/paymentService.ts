import { and, eq, lt } from "drizzle-orm";
import type { Database, Transaction } from "../db/database.js";
import { receiptsTable, runsTable } from "../db/schema.js";
import { verifySignature } from "../crypto.js";
import { OperationError } from "../errors.js";
import { inferenceAmount, isInferenceSubmission } from "../inference.js";
import { accounts, adjustOrganization, lockOrganizations, postLedgerTransaction } from "../ledger.js";
import type { OrganizationService } from "../organizations.js";
import { isInferenceVoucher, type PaymentSubmission, type Voucher, voucherPayload } from "./types.js";

export type Receipt = typeof receiptsTable.$inferSelect;
type Run = typeof runsTable.$inferSelect;

export interface PaymentPolicy {
    /** The platform's share of each captured payment, in basis points. */
    platformFeeBps: number;
}

export const DEFAULT_PLATFORM_FEE_BPS = 2000;

/** A hold outlives its voucher's expiry by this long before it is released, so a slow capture still lands. */
export const HOLD_GRACE_MS = 1000 * 60 * 10;

export const TOP_UP_URL = 'https://platform.stellarium.sh';

export type AuthorizeResult = { status: 'held', heldMicroUsd: number };
export type CaptureResult = { status: 'captured', amountMicroUsd: number } | { status: 'released' };

// Postgres unique_violation. Drizzle wraps the pg error in DrizzleQueryError.cause.
function isUniqueViolation(error: unknown): boolean {
    const pgError = error as { code?: unknown; cause?: { code?: unknown } } | undefined;
    return pgError?.code === '23505' || pgError?.cause?.code === '23505';
}

/**
 * Moves money for paid calls. A provider authorizes a voucher before running the call, which holds its
 * amount on the payer organization's balance, then captures it (charging the payer and crediting the
 * recipient's payable balance, less the platform fee) or releases it. Every step is idempotent per voucher.
 */
export class PaymentService {
    constructor(private readonly db: Database, private readonly organizations: OrganizationService, private readonly policy: PaymentPolicy) {}

    /** The platform's share of `amount`, rounded down. */
    fee(amount: number): number {
        return Number(BigInt(amount) * BigInt(this.policy.platformFeeBps) / 10_000n);
    }

    private verifyVoucher(voucher: Voucher): void {
        if (!verifySignature(voucherPayload(voucher), voucher.publicKey, voucher.signature, 'voucher')) {
            throw new OperationError(401, 'Invalid voucher signature');
        }
    }

    /** Throws unless `providerPublicKey` is an active node of the voucher's recipient organization. */
    private async requireProvider(providerPublicKey: string, recipientOrganizationId: string): Promise<void> {
        const node = await this.organizations.getNode(providerPublicKey);
        if (!node || node.revokedAt || node.organizationId !== recipientOrganizationId) {
            throw new OperationError(403, `This node can't collect payments for organization ${recipientOrganizationId}`);
        }
    }

    /**
     * Holds the voucher's amount, or an inference voucher's `maxAmount`, on the payer organization's balance.
     * A voucher naming a run is a call from a script run instead: the run's payer pays, and the amount moves
     * from the run's hold to the receipt, so the run's hold caps what its calls cost.
     */
    async authorize(providerPublicKey: string, voucher: Voucher): Promise<AuthorizeResult> {
        this.verifyVoucher(voucher);
        const expiresAt = new Date(Date.parse(voucher.expiresAt));
        if (!Number.isFinite(expiresAt.getTime()) || expiresAt.getTime() <= Date.now()) {
            throw new OperationError(401, 'Voucher has expired');
        }
        await this.requireProvider(providerPublicKey, voucher.recipientOrganizationId);

        const signer = await this.organizations.getNode(voucher.publicKey);
        if (!signer) {
            throw new OperationError(402, `Payer node is not enrolled in an organization. Enroll it at ${TOP_UP_URL}`);
        }
        if (signer.revokedAt) {
            throw new OperationError(403, 'Payer node has been revoked');
        }
        let run: Run | undefined;
        if (voucher.runId !== undefined) {
            [run] = await this.db.select().from(runsTable).where(eq(runsTable.runId, voucher.runId)).limit(1);
            if (!run) {
                throw new OperationError(404, 'Voucher\'s run was never authorized');
            }
            if (run.nodePublicKey !== voucher.publicKey) {
                throw new OperationError(403, 'Only the node running a run can spend its hold');
            }
        }
        const payerOrganizationId = run ? run.payerOrganizationId : signer.organizationId;
        if (payerOrganizationId === voucher.recipientOrganizationId) {
            throw new OperationError(422, 'An organization can\'t pay itself');
        }
        const hold = isInferenceVoucher(voucher) ? voucher.maxAmount : voucher.amount;

        try {
            return await this.db.transaction(async (tx) => {
                const organizations = await lockOrganizations(tx, [payerOrganizationId, voucher.recipientOrganizationId]);
                const payerOrganization = organizations.get(payerOrganizationId)!;
                const recipient = organizations.get(voucher.recipientOrganizationId);
                if (!recipient?.payoutsEnabled) {
                    throw new OperationError(422, `Organization ${voucher.recipientOrganizationId} can't receive payouts yet`);
                }
                if (payerOrganization.frozenAt) {
                    throw new OperationError(403, 'Payer organization is frozen');
                }

                const existing = await this.find(tx, voucher);
                if (existing) {
                    // A retried authorization of the same voucher gets the same hold.
                    if (existing.voucherSignature === voucher.signature && existing.status === 'held') {
                        return { status: 'held' as const, heldMicroUsd: existing.heldMicroUsd };
                    }
                    throw new OperationError(409, 'Voucher has already been used');
                }

                if (run) {
                    const [locked] = await tx.select().from(runsTable).where(eq(runsTable.id, run.id)).for('update');
                    if (locked!.status !== 'held') {
                        throw new OperationError(409, 'Voucher\'s run has already been settled');
                    }
                    // The token budget stays held for the script itself.
                    if (locked!.heldMicroUsd - locked!.tokenBudgetMicroUsd < hold) {
                        throw new OperationError(402, 'The run\'s remaining budget can\'t cover this call');
                    }
                    await tx.update(runsTable).set({ heldMicroUsd: locked!.heldMicroUsd - hold, updatedAt: new Date() }).where(eq(runsTable.id, run.id));
                } else if (payerOrganization.balanceMicroUsd - payerOrganization.heldMicroUsd < hold) {
                    throw new OperationError(402, `Insufficient balance: top up at ${TOP_UP_URL}`);
                }

                await tx.insert(receiptsTable).values({
                    requestId: voucher.requestId,
                    invocationId: voucher.invocationId,
                    payerOrganizationId,
                    payerPublicKey: voucher.publicKey,
                    recipientOrganizationId: voucher.recipientOrganizationId,
                    providerPublicKey,
                    heldMicroUsd: hold,
                    voucherSignature: voucher.signature,
                    invocationHash: voucher.invocationHash,
                    expiresAt,
                    runId: run?.id,
                });
                // A run's call is already held as part of the run's hold.
                if (!run) await adjustOrganization(tx, payerOrganizationId, { held: hold });
                return { status: 'held' as const, heldMicroUsd: hold };
            });
        } catch (error) {
            // Another payer key used the same (requestId, invocationId).
            if (isUniqueViolation(error)) throw new OperationError(409, 'Voucher has already been used');
            throw error;
        }
    }

    /**
     * Charges a held voucher: a fixed voucher's amount, or an inference voucher's reported usage at its
     * rates, capped at the hold. A charge of nothing releases the hold instead.
     */
    async capture(providerPublicKey: string, submission: PaymentSubmission): Promise<CaptureResult> {
        const { voucher } = submission;
        this.verifyVoucher(voucher);
        if (isInferenceSubmission(submission) && submission.usage.outputTokens > submission.voucher.maxTokens) {
            throw new OperationError(400, 'Reported output tokens exceed the voucher\'s maxTokens');
        }
        await this.requireProvider(providerPublicKey, voucher.recipientOrganizationId);

        return this.db.transaction(async (tx) => {
            const receipt = await this.lockReceipt(tx, voucher);
            if (receipt.status === 'captured') {
                return { status: 'captured' as const, amountMicroUsd: receipt.amountMicroUsd! };
            }
            if (receipt.status === 'released') {
                throw new OperationError(409, 'Voucher\'s hold was already released');
            }

            const charge = Math.min(isInferenceSubmission(submission) ? inferenceAmount(submission) : submission.voucher.amount, receipt.heldMicroUsd);
            if (charge <= 0) {
                await this.releaseHeld(tx, receipt);
                return { status: 'released' as const };
            }
            const fee = this.fee(charge);

            await postLedgerTransaction(tx, 'capture', [
                { account: accounts.balance(receipt.payerOrganizationId), amountMicroUsd: -charge },
                { account: accounts.payable(receipt.recipientOrganizationId), amountMicroUsd: charge - fee },
                { account: accounts.revenue, amountMicroUsd: fee },
            ], { receiptId: receipt.id });
            await adjustOrganization(tx, receipt.payerOrganizationId, { balance: -charge, held: -receipt.heldMicroUsd });
            await adjustOrganization(tx, receipt.recipientOrganizationId, { payable: charge - fee });
            await tx.update(receiptsTable).set({
                status: 'captured',
                amountMicroUsd: charge,
                feeMicroUsd: fee,
                inputTokens: isInferenceSubmission(submission) ? submission.usage.inputTokens : null,
                outputTokens: isInferenceSubmission(submission) ? submission.usage.outputTokens : null,
                capturedAt: new Date(),
                updatedAt: new Date(),
            }).where(eq(receiptsTable.id, receipt.id));
            return { status: 'captured' as const, amountMicroUsd: charge };
        });
    }

    /** Releases a held voucher without charging it. */
    async release(providerPublicKey: string, voucher: Voucher): Promise<{ status: 'released' }> {
        this.verifyVoucher(voucher);
        await this.requireProvider(providerPublicKey, voucher.recipientOrganizationId);

        return this.db.transaction(async (tx) => {
            const receipt = await this.lockReceipt(tx, voucher);
            if (receipt.status === 'captured') {
                throw new OperationError(409, 'Voucher was already captured');
            }
            if (receipt.status === 'held') {
                await this.releaseHeld(tx, receipt);
            }
            return { status: 'released' as const };
        });
    }

    /** Releases holds whose voucher expired more than `HOLD_GRACE_MS` before `now`. Returns how many. */
    async releaseExpiredHolds(now: Date = new Date()): Promise<number> {
        const expired = await this.db.select().from(receiptsTable).where(and(
            eq(receiptsTable.status, 'held'),
            lt(receiptsTable.expiresAt, new Date(now.getTime() - HOLD_GRACE_MS)),
        ));
        let released = 0;
        for (const candidate of expired) {
            await this.db.transaction(async (tx) => {
                await lockOrganizations(tx, [candidate.payerOrganizationId, candidate.recipientOrganizationId]);
                const [receipt] = await tx.select().from(receiptsTable).where(eq(receiptsTable.id, candidate.id)).for('update');
                // Captured or released since the scan.
                if (receipt?.status !== 'held') return;
                await this.releaseHeld(tx, receipt);
                released++;
            });
        }
        return released;
    }

    private async find(tx: Transaction, voucher: Voucher): Promise<Receipt | undefined> {
        const [receipt] = await tx.select().from(receiptsTable)
            .where(and(eq(receiptsTable.requestId, voucher.requestId), eq(receiptsTable.invocationId, voucher.invocationId)))
            .limit(1);
        return receipt;
    }

    /**
     * The voucher's receipt, with its organizations and then its own row locked: the same order
     * `authorize` locks in, so the two can't deadlock. Throws unless it is this voucher's receipt.
     */
    private async lockReceipt(tx: Transaction, voucher: Voucher): Promise<Receipt> {
        const found = await this.find(tx, voucher);
        if (!found) {
            throw new OperationError(404, 'Voucher was never authorized');
        }
        await lockOrganizations(tx, [found.payerOrganizationId, found.recipientOrganizationId]);
        const [receipt] = await tx.select().from(receiptsTable).where(eq(receiptsTable.id, found.id)).for('update');
        if (receipt!.voucherSignature !== voucher.signature) {
            throw new OperationError(409, 'Voucher doesn\'t match the authorized one');
        }
        return receipt!;
    }

    /** Call with the receipt's organizations and row locked. */
    private async releaseHeld(tx: Transaction, receipt: Receipt): Promise<void> {
        await adjustOrganization(tx, receipt.payerOrganizationId, { held: -receipt.heldMicroUsd });
        await tx.update(receiptsTable)
            .set({ status: 'released', releasedAt: new Date(), updatedAt: new Date() })
            .where(eq(receiptsTable.id, receipt.id));
    }
}
