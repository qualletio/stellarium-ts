import { integer, pgTable, timestamp, varchar } from "drizzle-orm/pg-core";

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
});
