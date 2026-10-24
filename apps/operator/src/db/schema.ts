import { bigint, boolean, index, integer, pgTable, text, timestamp, unique, uuid, varchar } from "drizzle-orm/pg-core";

// Amounts are micro-USD (1 USD = 1,000,000). Integer columns would overflow above ~$2,147.
// Drizzle supplies timestamps in UTC. now() would use the session's time zone, which drizzle reads back as UTC.

/**
 * Who pays and who gets paid. An organization's nodes draw on its prepaid balance and are paid into its payable balance.
 * The three balances are a cache of the ledger, updated in the same transaction as its entries.
 */
export const organizationsTable = pgTable("organizations", {
  // `org_` plus random characters. Vouchers name the recipient by this id.
  id: varchar({ length: 64 }).primaryKey(),
  // The dashboard organization it belongs to. Null for organizations created outside the dashboard, such as the local development seed.
  authOrganizationId: text().unique().references(() => authOrganizationsTable.id),
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

/**
 * A node key enrolled in an organization. A key belongs to at most one organization, ever.
 * A listed node accepts runs from other organizations' API clients, at its token price.
 */
export const nodesTable = pgTable("nodes", {
  // The node's SPKI public key, as on its vouchers and signed requests.
  publicKey: varchar({ length: 255 }).primaryKey(),
  organizationId: varchar({ length: 64 }).notNull().references(() => organizationsTable.id),
  label: varchar({ length: 255 }),
  // The URL the node reports in its session. Changing it unlists the node until it is verified again.
  baseUrl: varchar({ length: 1024 }),
  // Listing details, set from the dashboard.
  name: varchar({ length: 255 }),
  description: varchar({ length: 2048 }),
  // Charged per million script tokens a run executes. 0 is free.
  priceMicroUsdPerMillionTokens: bigint({ mode: 'number' }).notNull().default(0),
  listed: boolean().notNull().default(false),
  // When `{baseUrl}/v1/self` last answered with this node's key. Listing requires it.
  verifiedAt: timestamp(),
  createdAt: timestamp().notNull().defaultNow().$defaultFn(() => new Date()),
  // A revoked node can neither pay nor be paid.
  revokedAt: timestamp(),
}, (table) => [
  index("nodes_organizationId_index").on(table.organizationId),
]);

/**
 * Credentials an organization exchanges for JWTs that run scripts on one node, paid from its balance.
 * Only the secret's SHA-256 hash is stored.
 */
export const apiClientsTable = pgTable("api_clients", {
  // `cli_` plus random characters: the OAuth client_id.
  id: varchar({ length: 64 }).primaryKey(),
  secretHash: varchar({ length: 64 }).notNull(),
  // The organization that pays for its runs.
  organizationId: varchar({ length: 64 }).notNull().references(() => organizationsTable.id),
  nodePublicKey: varchar({ length: 255 }).notNull().references(() => nodesTable.publicKey),
  label: varchar({ length: 255 }),
  // Most one run may cost, script tokens and the paid calls it makes together. Also the run's hold.
  maxRunCostMicroUsd: bigint({ mode: 'number' }).notNull(),
  // Most its runs may cost in a calendar month (UTC). Null for no cap.
  monthlyCapMicroUsd: bigint({ mode: 'number' }),
  // The dashboard user who created it.
  createdBy: varchar({ length: 255 }),
  createdAt: timestamp().notNull().defaultNow().$defaultFn(() => new Date()),
  revokedAt: timestamp(),
}, (table) => [
  index("api_clients_organizationId_index").on(table.organizationId),
]);

/** One-time tokens that enroll a node in an organization. Only their SHA-256 hash is stored. */
export const enrollmentTokensTable = pgTable("enrollment_tokens", {
  tokenHash: varchar({ length: 64 }).primaryKey(),
  organizationId: varchar({ length: 64 }).notNull().references(() => organizationsTable.id),
  label: varchar({ length: 255 }),
  // The dashboard user who created it. Null for tokens created outside the dashboard.
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

/**
 * One script run by an API client on another organization's node, from its authorization to its capture
 * or release. Its hold covers the script's tokens and the paid calls the script makes: a voucher naming
 * the run moves part of the hold to its own receipt.
 */
export const runsTable = pgTable("runs", {
  id: integer().primaryKey().generatedAlwaysAsIdentity(),
  // Chosen by the node, so a retried authorization finds the same run.
  runId: uuid().notNull().unique(),
  clientId: varchar({ length: 64 }).notNull().references(() => apiClientsTable.id),
  payerOrganizationId: varchar({ length: 64 }).notNull().references(() => organizationsTable.id),
  recipientOrganizationId: varchar({ length: 64 }).notNull().references(() => organizationsTable.id),
  nodePublicKey: varchar({ length: 255 }).notNull(),
  status: varchar({ length: 16, enum: RECEIPT_STATUSES }).notNull().default('held'),
  // The node's price when the run was authorized.
  priceMicroUsdPerMillionTokens: bigint({ mode: 'number' }).notNull(),
  // The most tokens the script can execute, computed by the operator from its source.
  maxTokens: bigint({ mode: 'number' }).notNull(),
  // The hold placed at authorization.
  holdMicroUsd: bigint({ mode: 'number' }).notNull(),
  // The part of the hold the run still holds itself: the hold less what moved to its calls' receipts. 0 once settled.
  heldMicroUsd: bigint({ mode: 'number' }).notNull(),
  // Kept back from the calls' share for the script's tokens at most `maxTokens`.
  tokenBudgetMicroUsd: bigint({ mode: 'number' }).notNull(),
  // The tokens the node reported, and what they were charged. Null until captured.
  tokens: bigint({ mode: 'number' }),
  amountMicroUsd: bigint({ mode: 'number' }),
  feeMicroUsd: bigint({ mode: 'number' }),
  expiresAt: timestamp().notNull(),
  capturedAt: timestamp(),
  releasedAt: timestamp(),
  createdAt: timestamp().notNull().defaultNow().$defaultFn(() => new Date()),
  updatedAt: timestamp().notNull().defaultNow().$defaultFn(() => new Date()),
}, (table) => [
  index("runs_clientId_createdAt_index").on(table.clientId, table.createdAt),
  index("runs_payerOrganizationId_index").on(table.payerOrganizationId),
  index("runs_recipientOrganizationId_index").on(table.recipientOrganizationId),
  index("runs_status_expiresAt_index").on(table.status, table.expiresAt),
]);

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
  // The run whose hold paid for it, for a call made by a script run. The run's payer pays.
  runId: integer().references(() => runsTable.id),
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
  index("receipts_runId_index").on(table.runId),
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
  runId: integer().references(() => runsTable.id),
  topUpId: integer().references(() => topUpsTable.id),
  payoutId: integer().references(() => payoutsTable.id),
  // The Stripe object behind the entry, such as a refund's charge or a dispute.
  stripeObjectId: varchar({ length: 255 }),
  createdAt: timestamp().notNull().defaultNow().$defaultFn(() => new Date()),
}, (table) => [
  index("ledger_entries_account_index").on(table.account),
  index("ledger_entries_transactionId_index").on(table.transactionId),
]);

/**
 * - pending: a Checkout Session was created; nothing has been paid.
 * - succeeded: paid and credited to the organization's balance.
 */
export const TOP_UP_STATUSES = ['pending', 'succeeded'] as const;
export type TopUpStatus = typeof TOP_UP_STATUSES[number];

/** One card payment that adds to an organization's balance, through Stripe Checkout. */
export const topUpsTable = pgTable("top_ups", {
  id: integer().primaryKey().generatedAlwaysAsIdentity(),
  organizationId: varchar({ length: 64 }).notNull().references(() => organizationsTable.id),
  amountMicroUsd: bigint({ mode: 'number' }).notNull(),
  status: varchar({ length: 16, enum: TOP_UP_STATUSES }).notNull().default('pending'),
  checkoutSessionId: varchar({ length: 255 }).unique(),
  paymentIntentId: varchar({ length: 255 }).unique(),
  // Debited from the balance by refunds and open or lost disputes. Stripe reports cumulative amounts, so these record what was applied.
  refundedMicroUsd: bigint({ mode: 'number' }).notNull().default(0),
  disputedMicroUsd: bigint({ mode: 'number' }).notNull().default(0),
  // The dashboard user who started it.
  createdBy: varchar({ length: 255 }),
  createdAt: timestamp().notNull().defaultNow().$defaultFn(() => new Date()),
  updatedAt: timestamp().notNull().defaultNow().$defaultFn(() => new Date()),
}, (table) => [
  index("top_ups_organizationId_index").on(table.organizationId),
]);

/**
 * - pending: claimed and debited from the payable balance; the transfer may not exist yet.
 * - paid: the transfer to the organization's Connect account was created.
 * - failed: Stripe refused the transfer. The amount was credited back to the payable balance.
 * - reversed: the whole transfer was reversed (see `reversedCents` for partial reversals).
 */
export const PAYOUT_STATUSES = ['pending', 'paid', 'failed', 'reversed'] as const;
export type PayoutStatus = typeof PAYOUT_STATUSES[number];

/** One Stripe transfer of an organization's payable balance to its Connect account. */
export const payoutsTable = pgTable("payouts", {
  id: integer().primaryKey().generatedAlwaysAsIdentity(),
  organizationId: varchar({ length: 64 }).notNull().references(() => organizationsTable.id),
  // Whole cents; the sub-cent remainder stays payable.
  amountCents: bigint({ mode: 'number' }).notNull(),
  status: varchar({ length: 16, enum: PAYOUT_STATUSES }).notNull().default('pending'),
  stripeTransferId: varchar({ length: 255 }).unique(),
  // How much of the transfer Stripe has reversed. Reversed amounts are credited back to the payable balance.
  reversedCents: bigint({ mode: 'number' }).notNull().default(0),
  failureReason: varchar({ length: 1024 }),
  createdAt: timestamp().notNull().defaultNow().$defaultFn(() => new Date()),
  updatedAt: timestamp().notNull().defaultNow().$defaultFn(() => new Date()),
}, (table) => [
  index("payouts_organizationId_index").on(table.organizationId),
  index("payouts_status_index").on(table.status),
]);

/** Stripe webhook events already handled, so a redelivery is ignored. */
export const stripeEventsTable = pgTable("stripe_events", {
  id: varchar({ length: 255 }).primaryKey(),
  type: varchar({ length: 255 }).notNull(),
  processedAt: timestamp().notNull().defaultNow().$defaultFn(() => new Date()),
});

// Dashboard sign-in, organizations and roles, managed by Better Auth (src/auth/betterAuth.ts). Field names are
// Better Auth's. Its ids are random strings it generates.

export const authUsersTable = pgTable("auth_users", {
  id: text().primaryKey(),
  name: text().notNull(),
  email: text().notNull().unique(),
  emailVerified: boolean().notNull().default(false),
  image: text(),
  createdAt: timestamp().notNull().defaultNow(),
  updatedAt: timestamp().notNull().defaultNow(),
});

export const authSessionsTable = pgTable("auth_sessions", {
  id: text().primaryKey(),
  token: text().notNull().unique(),
  userId: text().notNull().references(() => authUsersTable.id, { onDelete: 'cascade' }),
  expiresAt: timestamp().notNull(),
  ipAddress: text(),
  userAgent: text(),
  // The organization the dashboard acts on.
  activeOrganizationId: text(),
  createdAt: timestamp().notNull().defaultNow(),
  updatedAt: timestamp().notNull().defaultNow(),
}, (table) => [
  index("auth_sessions_userId_index").on(table.userId),
]);

/** A user's sign-in methods: `credential` (a password hash) or an OAuth provider. */
export const authAccountsTable = pgTable("auth_accounts", {
  id: text().primaryKey(),
  accountId: text().notNull(),
  providerId: text().notNull(),
  userId: text().notNull().references(() => authUsersTable.id, { onDelete: 'cascade' }),
  accessToken: text(),
  refreshToken: text(),
  idToken: text(),
  accessTokenExpiresAt: timestamp(),
  refreshTokenExpiresAt: timestamp(),
  scope: text(),
  password: text(),
  createdAt: timestamp().notNull().defaultNow(),
  updatedAt: timestamp().notNull().defaultNow(),
}, (table) => [
  index("auth_accounts_userId_index").on(table.userId),
]);

/** Email verification and password reset tokens. */
export const authVerificationsTable = pgTable("auth_verifications", {
  id: text().primaryKey(),
  identifier: text().notNull(),
  value: text().notNull(),
  expiresAt: timestamp().notNull(),
  createdAt: timestamp().notNull().defaultNow(),
  updatedAt: timestamp().notNull().defaultNow(),
}, (table) => [
  index("auth_verifications_identifier_index").on(table.identifier),
]);

/** A dashboard organization. Its balances, nodes and payouts are on the `organizations` row that references it. */
export const authOrganizationsTable = pgTable("auth_organizations", {
  id: text().primaryKey(),
  name: text().notNull(),
  slug: text().notNull().unique(),
  logo: text(),
  metadata: text(),
  createdAt: timestamp().notNull(),
});

/** `owner` (the creator), `admin` or `member`. Owners and admins move money and manage nodes; members read. */
export const authMembersTable = pgTable("auth_members", {
  id: text().primaryKey(),
  organizationId: text().notNull().references(() => authOrganizationsTable.id, { onDelete: 'cascade' }),
  userId: text().notNull().references(() => authUsersTable.id, { onDelete: 'cascade' }),
  role: text().notNull().default('member'),
  createdAt: timestamp().notNull(),
}, (table) => [
  index("auth_members_organizationId_index").on(table.organizationId),
  index("auth_members_userId_index").on(table.userId),
]);

export const authInvitationsTable = pgTable("auth_invitations", {
  id: text().primaryKey(),
  organizationId: text().notNull().references(() => authOrganizationsTable.id, { onDelete: 'cascade' }),
  email: text().notNull(),
  role: text(),
  status: text().notNull().default('pending'),
  expiresAt: timestamp().notNull(),
  inviterId: text().notNull().references(() => authUsersTable.id, { onDelete: 'cascade' }),
  createdAt: timestamp().notNull().defaultNow(),
}, (table) => [
  index("auth_invitations_organizationId_index").on(table.organizationId),
  index("auth_invitations_email_index").on(table.email),
]);
