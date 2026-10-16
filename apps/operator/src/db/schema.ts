import { integer, pgTable, timestamp, unique, varchar } from "drizzle-orm/pg-core";

export const receiptsTable = pgTable("receipts", {
  id: integer().primaryKey().generatedAlwaysAsIdentity(),
  requestId: varchar({ length: 255 }).notNull(),
  invocationId: varchar({ length: 255 }).notNull(),
  amount: integer().notNull(),
  recipientAddress: varchar({ length: 255 }).notNull(),
  voucherSignature: varchar({ length: 255 }).notNull(),
  transactionSignature: varchar({ length: 255 }).notNull(),
  expiresAt: timestamp().notNull(),
  publicKey: varchar({ length: 255 }).notNull(),
  invocationHash: varchar({ length: 255 }).notNull(),
}, (table) => [
  // A voucher settles at most once, even when two submissions race past the duplicate check.
  unique("receipts_requestId_invocationId_unique").on(table.requestId, table.invocationId),
]);
