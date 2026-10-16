import { bigint, integer, pgTable, timestamp, unique, varchar } from "drizzle-orm/pg-core";

/**
 * - pending: claimed and signed, not yet known to be broadcast.
 * - unconfirmed: broadcast or confirmation was uncertain; reconciliation checks the chain.
 * - confirmed: the withdrawal landed.
 * - failed: the withdrawal landed with an error. The voucher may be settled again.
 * - expired: the transaction's blockhash expired without it landing. The voucher may be settled again.
 */
export const RECEIPT_STATUSES = ['pending', 'unconfirmed', 'confirmed', 'failed', 'expired'] as const;
export type ReceiptStatus = typeof RECEIPT_STATUSES[number];

/** Statuses after which no payment happened, so the voucher can be retried. */
export const RETRYABLE_RECEIPT_STATUSES: readonly ReceiptStatus[] = ['failed', 'expired'];

export const receiptsTable = pgTable("receipts", {
  id: integer().primaryKey().generatedAlwaysAsIdentity(),
  requestId: varchar({ length: 255 }).notNull(),
  invocationId: varchar({ length: 255 }).notNull(),
  // Lamports. Integer would overflow above ~2.1 SOL.
  amount: bigint({ mode: 'number' }).notNull(),
  recipientAddress: varchar({ length: 255 }).notNull(),
  voucherSignature: varchar({ length: 255 }).notNull(),
  transactionSignature: varchar({ length: 255 }).notNull(),
  expiresAt: timestamp().notNull(),
  publicKey: varchar({ length: 255 }).notNull(),
  invocationHash: varchar({ length: 255 }).notNull(),
  // Rows from before status tracking are unconfirmed until reconciliation checks their signature.
  status: varchar({ length: 16, enum: RECEIPT_STATUSES }).notNull().default('unconfirmed'),
  // Block height after which the transaction can no longer land. Null for rows from before it was recorded.
  lastValidBlockHeight: bigint({ mode: 'number' }),
  updatedAt: timestamp().notNull().defaultNow(),
}, (table) => [
  // A voucher settles at most once, even when two submissions race past the duplicate check.
  unique("receipts_requestId_invocationId_unique").on(table.requestId, table.invocationId),
]);
