import { and, eq, gte, inArray, isNull, lt, or, sql } from "drizzle-orm";
import type { Database } from "./db/database.js";
import { IN_FLIGHT_SETTLEMENT_STATUSES, receiptsTable, type SettlementStatus, settlementsTable } from "./db/schema.js";

export type Receipt = typeof receiptsTable.$inferSelect;
export type NewReceipt = Omit<typeof receiptsTable.$inferInsert, 'id' | 'settlementId' | 'createdAt' | 'updatedAt'>;
export type Settlement = typeof settlementsTable.$inferSelect;
export type NewSettlement = Omit<typeof settlementsTable.$inferInsert, 'id' | 'status' | 'createdAt' | 'updatedAt'>;

export type AccrueResult = 'accrued' | 'duplicate' | 'insufficient';

/** The accrued receipts one payer owes one recipient. */
export interface AccruedGroup {
    publicKey: string;
    recipientAddress: string;
    amount: bigint;
    receiptIds: number[];
}

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
     * Records a voucher as an accrued receipt if the payer's escrow can cover it on top of everything
     * it already owes. `balanceMicroUsdc` is the escrow's on-chain balance, read after `confirmedSince`:
     * settlements confirmed since then may not be reflected in it, so they still count as owed.
     * Holds a per-payer lock, so concurrent vouchers from one payer can't overspend its escrow together.
     */
    async accrue(receipt: NewReceipt, balanceMicroUsdc: bigint, confirmedSince: Date): Promise<AccrueResult> {
        try {
            return await this.db.transaction(async (tx) => {
                await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${receipt.publicKey}, 0))`);

                const [existing] = await tx.select({ id: receiptsTable.id }).from(receiptsTable)
                    .where(and(eq(receiptsTable.requestId, receipt.requestId), eq(receiptsTable.invocationId, receipt.invocationId)))
                    .limit(1);
                if (existing) return 'duplicate';

                const [owed] = await tx.select({ total: sql<string>`coalesce(sum(${receiptsTable.amount}), 0)` })
                    .from(receiptsTable)
                    .leftJoin(settlementsTable, eq(settlementsTable.id, receiptsTable.settlementId))
                    .where(and(
                        eq(receiptsTable.publicKey, receipt.publicKey),
                        or(
                            isNull(receiptsTable.settlementId),
                            inArray(settlementsTable.status, [...IN_FLIGHT_SETTLEMENT_STATUSES]),
                            and(eq(settlementsTable.status, 'confirmed'), gte(settlementsTable.updatedAt, confirmedSince)),
                        ),
                    ));
                if (BigInt(owed!.total) + BigInt(receipt.amount) > balanceMicroUsdc) return 'insufficient';

                await tx.insert(receiptsTable).values(receipt);
                return 'accrued';
            });
        } catch (error) {
            // Another payer key submitted the same (requestId, invocationId) concurrently.
            if (isUniqueViolation(error)) return 'duplicate';
            throw error;
        }
    }

    /** Accrued receipts, grouped by payer and recipient. */
    async findAccruedGroups(): Promise<AccruedGroup[]> {
        const groups = await this.db.select({
            publicKey: receiptsTable.publicKey,
            recipientAddress: receiptsTable.recipientAddress,
            amount: sql<string>`sum(${receiptsTable.amount})`,
            receiptIds: sql<number[]>`array_agg(${receiptsTable.id} order by ${receiptsTable.id})`,
        })
            .from(receiptsTable)
            .where(isNull(receiptsTable.settlementId))
            .groupBy(receiptsTable.publicKey, receiptsTable.recipientAddress);
        return groups.map(group => ({ ...group, amount: BigInt(group.amount) }));
    }

    /**
     * Creates a `pending` settlement and attaches the receipts to it. Returns false, changing nothing,
     * when any of them is no longer accrued, so a receipt is never in two settlements.
     */
    async claimSettlement(settlement: NewSettlement, receiptIds: number[]): Promise<boolean> {
        return this.db.transaction(async (tx) => {
            const [created] = await tx.insert(settlementsTable).values({ ...settlement, status: 'pending' }).returning({ id: settlementsTable.id });
            const attached = await tx.update(receiptsTable)
                .set({ settlementId: created!.id, updatedAt: new Date() })
                .where(and(inArray(receiptsTable.id, receiptIds), isNull(receiptsTable.settlementId)))
                .returning({ id: receiptsTable.id });
            if (attached.length !== receiptIds.length) {
                tx.rollback();
            }
            return true;
        }).catch((error: unknown) => {
            if ((error as Error)?.name === 'TransactionRollbackError') return false;
            throw error;
        });
    }

    /** A failed or expired settlement paid nothing, so its receipts become accrued again. */
    async setSettlementStatus(transactionSignature: string, status: SettlementStatus): Promise<void> {
        await this.db.transaction(async (tx) => {
            const updated = await tx.update(settlementsTable)
                .set({ status, updatedAt: new Date() })
                .where(eq(settlementsTable.transactionSignature, transactionSignature))
                .returning({ id: settlementsTable.id });
            if (status === 'failed' || status === 'expired') {
                for (const { id } of updated) {
                    await tx.update(receiptsTable)
                        .set({ settlementId: null, updatedAt: new Date() })
                        .where(eq(receiptsTable.settlementId, id));
                }
            }
        });
    }

    /** Settlements whose outcome isn't known yet and that haven't changed since `before`. */
    async findUnsettled(before: Date): Promise<Settlement[]> {
        return this.db.select().from(settlementsTable).where(and(
            inArray(settlementsTable.status, [...IN_FLIGHT_SETTLEMENT_STATUSES]),
            lt(settlementsTable.updatedAt, before),
        ));
    }
}
