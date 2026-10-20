import { bigint, index, integer, pgTable, timestamp, unique, varchar } from "drizzle-orm/pg-core";

/**
 * - pending: claimed and signed, not yet known to be broadcast.
 * - unconfirmed: broadcast or confirmation was uncertain; reconciliation checks the chain.
 * - confirmed: the withdrawal landed.
 * - failed: the withdrawal landed with an error. Its receipts are owed again.
 * - expired: the transaction's blockhash expired without it landing. Its receipts are owed again.
 */
export const SETTLEMENT_STATUSES = ['pending', 'unconfirmed', 'confirmed', 'failed', 'expired'] as const;
export type SettlementStatus = typeof SETTLEMENT_STATUSES[number];

/** Statuses whose outcome isn't known yet: the withdrawal may still land. */
export const IN_FLIGHT_SETTLEMENT_STATUSES: readonly SettlementStatus[] = ['pending', 'unconfirmed'];

/** One on-chain withdrawal paying a recipient the sum of a payer's accrued receipts. */
export const settlementsTable = pgTable("settlements", {
  id: integer().primaryKey().generatedAlwaysAsIdentity(),
  // The payer node's SPKI public key, as on its vouchers.
  publicKey: varchar({ length: 255 }).notNull(),
  recipientAddress: varchar({ length: 255 }).notNull(),
  // Micro-USDC.
  amount: bigint({ mode: 'number' }).notNull(),
  transactionSignature: varchar({ length: 255 }).notNull().unique(),
  // Block height after which the transaction can no longer land. Null for rows from before it was recorded.
  lastValidBlockHeight: bigint({ mode: 'number' }),
  status: varchar({ length: 16, enum: SETTLEMENT_STATUSES }).notNull().default('pending'),
  // Drizzle supplies these in UTC. now() would use the session's time zone, which drizzle reads back as UTC.
  createdAt: timestamp().notNull().defaultNow().$defaultFn(() => new Date()),
  updatedAt: timestamp().notNull().defaultNow().$defaultFn(() => new Date()),
});

/**
 * One accepted voucher. A receipt without a settlement is accrued: owed to its recipient but not yet paid.
 * A failed or expired settlement releases its receipts, so they are paid by a later one.
 */
export const receiptsTable = pgTable("receipts", {
  id: integer().primaryKey().generatedAlwaysAsIdentity(),
  requestId: varchar({ length: 255 }).notNull(),
  invocationId: varchar({ length: 255 }).notNull(),
  // Micro-USDC. Integer would overflow above ~2,147 USDC.
  amount: bigint({ mode: 'number' }).notNull(),
  recipientAddress: varchar({ length: 255 }).notNull(),
  voucherSignature: varchar({ length: 255 }).notNull(),
  expiresAt: timestamp().notNull(),
  publicKey: varchar({ length: 255 }).notNull(),
  invocationHash: varchar({ length: 255 }).notNull(),
  settlementId: integer().references(() => settlementsTable.id),
  createdAt: timestamp().notNull().defaultNow().$defaultFn(() => new Date()),
  updatedAt: timestamp().notNull().defaultNow().$defaultFn(() => new Date()),
}, (table) => [
  // A voucher is accepted at most once, even when two submissions race past the duplicate check.
  unique("receipts_requestId_invocationId_unique").on(table.requestId, table.invocationId),
  index("receipts_publicKey_index").on(table.publicKey),
  index("receipts_settlementId_index").on(table.settlementId),
]);
