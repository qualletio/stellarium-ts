import { and, eq, inArray, lt } from "drizzle-orm";
import type { Database } from "./db/database.js";
import { RETRYABLE_RECEIPT_STATUSES, receiptsTable, type ReceiptStatus } from "./db/schema.js";

export type Receipt = typeof receiptsTable.$inferSelect;
export type NewReceipt = Omit<typeof receiptsTable.$inferInsert, 'id' | 'status' | 'updatedAt'>;

// Postgres unique_violation. Drizzle wraps the pg error in DrizzleQueryError.cause.
function isUniqueViolation(error: unknown): boolean {
    const pgError = error as { code?: unknown; cause?: { code?: unknown } } | undefined;
    return pgError?.code === '23505' || pgError?.cause?.code === '23505';
}

export class ReceiptRepository {
    constructor(private readonly db: Database) {}

    async getByRequestIdAndInvocationId(requestId: string, invocationId: string): Promise<Receipt | undefined> {
        const receipt = await this.db.select().from(receiptsTable).where(and(eq(receiptsTable.requestId, requestId), eq(receiptsTable.invocationId, invocationId))).limit(1);
        return receipt[0];
    }

    /**
     * Atomically claims a voucher for settlement as a `pending` receipt. A voucher whose earlier
     * settlement failed or expired may be claimed again by the same signer. Returns false when the
     * voucher is already claimed, so at most one withdrawal is ever in flight or completed per voucher.
     */
    async claim(receipt: NewReceipt): Promise<boolean> {
        try {
            await this.db.insert(receiptsTable).values({ ...receipt, status: 'pending' });
            return true;
        } catch (error) {
            if (!isUniqueViolation(error)) throw error;
        }

        const reclaimed = await this.db.update(receiptsTable)
            .set({ ...receipt, status: 'pending', updatedAt: new Date() })
            .where(and(
                eq(receiptsTable.requestId, receipt.requestId),
                eq(receiptsTable.invocationId, receipt.invocationId),
                eq(receiptsTable.publicKey, receipt.publicKey),
                inArray(receiptsTable.status, [...RETRYABLE_RECEIPT_STATUSES]),
            ))
            .returning({ id: receiptsTable.id });
        return reclaimed.length > 0;
    }

    async setStatus(transactionSignature: string, status: ReceiptStatus): Promise<void> {
        await this.db.update(receiptsTable)
            .set({ status, updatedAt: new Date() })
            .where(eq(receiptsTable.transactionSignature, transactionSignature));
    }

    /** Receipts whose outcome isn't known yet and that haven't changed since `before`. */
    async findUnsettled(before: Date): Promise<Receipt[]> {
        return this.db.select().from(receiptsTable).where(and(
            inArray(receiptsTable.status, ['pending', 'unconfirmed']),
            lt(receiptsTable.updatedAt, before),
        ));
    }
}
