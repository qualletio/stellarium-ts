import { bigint, boolean, index, integer, pgTable, timestamp, unique, uuid, varchar } from "drizzle-orm/pg-core";

// Amounts are micro-USD (1 USD = 1,000,000). Integer columns would overflow above ~$2,147.
// Drizzle supplies timestamps in UTC. now() would use the session's time zone, which drizzle reads back as UTC.

/**
 * Who pays and who gets paid. An organization's nodes draw on its prepaid balance and are paid into its payable balance.
 * The three balances are a cache of the ledger, updated in the same transaction as its entries.
 */
export const organizationsTable = pgTable("organizations", {
  // `org_` plus random characters. Vouchers name the recipient by this id.
  id: varchar({ length: 64 }).primaryKey(),
  // Null for organizations created outside the dashboard, such as the local development seed.
  clerkOrgId: varchar({ length: 255 }).unique(),
  name: varchar({ length: 255 }).notNull(),
  stripeCustomerId: varchar({ length: 255 }).unique(),
  stripeAccountId: varchar({ length: 255 }).unique(),
  // Whether its Connect account can be paid out. Payments to an organization that can't be paid out are refused.
  payoutsEnabled: boolean().notNull().default(false),
  // Prepaid funds, including amounts held for calls in progress. May go negative after a dispute.
  balanceMicroUsd: bigint({ mode: 'number' }).notNull().default(0),
  // The part of the balance held by authorized, not yet captured or released, receipts.
  heldMicroUsd: bigint({ mode: 'number' }).notNull().default(0),
  // Owed to the organization for calls to its functions, not yet paid out.
  payableMicroUsd: bigint({ mode: 'number' }).notNull().default(0),
  // A frozen organization's nodes can't pay.
  frozenAt: timestamp(),
  createdAt: timestamp().notNull().defaultNow().$defaultFn(() => new Date()),
  updatedAt: timestamp().notNull().defaultNow().$defaultFn(() => new Date()),
});

/** A node key enrolled in an organization. A key belongs to at most one organization, ever. */
export const nodesTable = pgTable("nodes", {
  // The node's SPKI public key, as on its vouchers and signed requests.
  publicKey: varchar({ length: 255 }).primaryKey(),
  organizationId: varchar({ length: 64 }).notNull().references(() => organizationsTable.id),
  label: varchar({ length: 255 }),
  createdAt: timestamp().notNull().defaultNow().$defaultFn(() => new Date()),
  // A revoked node can neither pay nor be paid.
  revokedAt: timestamp(),
}, (table) => [
  index("nodes_organizationId_index").on(table.organizationId),
]);

/** One-time tokens that enroll a node in an organization. Only their SHA-256 hash is stored. */
export const enrollmentTokensTable = pgTable("enrollment_tokens", {
  tokenHash: varchar({ length: 64 }).primaryKey(),
  organizationId: varchar({ length: 64 }).notNull().references(() => organizationsTable.id),
  label: varchar({ length: 255 }),
  // The Clerk user who created it. Null for tokens created outside the dashboard.
  createdBy: varchar({ length: 255 }),
  expiresAt: timestamp().notNull(),
  usedAt: timestamp(),
  createdAt: timestamp().notNull().defaultNow().$defaultFn(() => new Date()),
});

/**
 * - held: authorized; the hold counts against the payer's available balance.
 * - captured: charged to the payer and owed to the recipient.
 * - released: the call failed, cost nothing, or the hold expired. Nothing was charged.
 */
export const RECEIPT_STATUSES = ['held', 'captured', 'released'] as const;
export type ReceiptStatus = typeof RECEIPT_STATUSES[number];

/** One voucher, from its authorization to its capture or release. */
export const receiptsTable = pgTable("receipts", {
  id: integer().primaryKey().generatedAlwaysAsIdentity(),
  requestId: varchar({ length: 255 }).notNull(),
  invocationId: varchar({ length: 255 }).notNull(),
  payerOrganizationId: varchar({ length: 64 }).notNull().references(() => organizationsTable.id),
  // The voucher's signer.
  payerPublicKey: varchar({ length: 255 }).notNull(),
  recipientOrganizationId: varchar({ length: 64 }).notNull().references(() => organizationsTable.id),
  // The node that authorized it. Any node of the recipient organization may capture or release it.
  providerPublicKey: varchar({ length: 255 }).notNull(),
  status: varchar({ length: 16, enum: RECEIPT_STATUSES }).notNull().default('held'),
  // The voucher's amount, or an inference voucher's maxAmount.
  heldMicroUsd: bigint({ mode: 'number' }).notNull(),
  // What was charged. Null until captured.
  amountMicroUsd: bigint({ mode: 'number' }),
  // The platform's share of `amountMicroUsd`; the recipient is owed the rest.
  feeMicroUsd: bigint({ mode: 'number' }),
  voucherSignature: varchar({ length: 255 }).notNull(),
  invocationHash: varchar({ length: 255 }).notNull(),
  expiresAt: timestamp().notNull(),
  // Inference vouchers only: the usage the provider reported. Null for fixed vouchers.
  inputTokens: bigint({ mode: 'number' }),
  outputTokens: bigint({ mode: 'number' }),
  capturedAt: timestamp(),
  releasedAt: timestamp(),
  createdAt: timestamp().notNull().defaultNow().$defaultFn(() => new Date()),
  updatedAt: timestamp().notNull().defaultNow().$defaultFn(() => new Date()),
}, (table) => [
  // A voucher is held at most once, even when two authorizations race.
  unique("receipts_requestId_invocationId_unique").on(table.requestId, table.invocationId),
  index("receipts_payerOrganizationId_index").on(table.payerOrganizationId),
  index("receipts_recipientOrganizationId_index").on(table.recipientOrganizationId),
  index("receipts_status_expiresAt_index").on(table.status, table.expiresAt),
]);

/**
 * Append-only double-entry ledger. The entries of one `transactionId` sum to zero. Accounts are
 * `org:<id>:balance`, `org:<id>:payable`, or a `platform:` account (see ledger.ts).
 */
export const ledgerEntriesTable = pgTable("ledger_entries", {
  id: integer().primaryKey().generatedAlwaysAsIdentity(),
  transactionId: uuid().notNull(),
  account: varchar({ length: 128 }).notNull(),
  // Signed: positive adds to the account.
  amountMicroUsd: bigint({ mode: 'number' }).notNull(),
  kind: varchar({ length: 32 }).notNull(),
  receiptId: integer().references(() => receiptsTable.id),
  createdAt: timestamp().notNull().defaultNow().$defaultFn(() => new Date()),
}, (table) => [
  index("ledger_entries_account_index").on(table.account),
  index("ledger_entries_transactionId_index").on(table.transactionId),
]);
