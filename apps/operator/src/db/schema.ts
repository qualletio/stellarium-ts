import { type AnyPgColumn, bigint, boolean, index, integer, json, jsonb, pgTable, text, timestamp, unique, uuid, varchar } from "drizzle-orm/pg-core";

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
  // Banned for fraud (docs/money.md, Fraud), with two staff members' approval. A banned organization can't run,
  // pay, be paid out or change anything, except appeal once.
  bannedAt: timestamp(),
  banReason: varchar({ length: 2048 }),
  // When staff verified the identity of whoever pays for it, which attaching more than PAYER_KYC_THRESHOLD_MICRO_USD
  // a month to contracts needs (docs/money.md, Card fraud).
  identityVerifiedAt: timestamp(),
  // Matched a sanctions list: it can neither pay nor be paid until staff clear it.
  sanctionsBlockedAt: timestamp(),
  // When a sanctions screener last checked it, if one is configured.
  sanctionsScreenedAt: timestamp(),
  // Closed by staff, the operator's version of deleting it: its contract funding was refunded first.
  closedAt: timestamp(),
  // Where the operator posts the organization's notifications, signed with its key, besides emailing its owners.
  webhookUrl: varchar({ length: 1024 }),
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
  // Money (docs/money.md). All three default to 0, so a node moves no money until the operator's staff raise them.
  // The most the node's API-key runs may attach to contract calls, per run and per calendar month (UTC).
  maxApiKeyRunValueMicroUsd: bigint({ mode: 'number' }).notNull().default(0),
  monthlyApiKeyValueCapMicroUsd: bigint({ mode: 'number' }).notNull().default(0),
  // The most the contracts the node hosts may hold together. Bounds what a fraudulent host could take.
  maxContractBalanceMicroUsd: bigint({ mode: 'number' }).notNull().default(0),
  // When `{baseUrl}/v1/self` last answered with this node's key. Listing requires it.
  verifiedAt: timestamp(),
  createdAt: timestamp().notNull().defaultNow().$defaultFn(() => new Date()),
  // A revoked node can neither pay nor be paid.
  revokedAt: timestamp(),
  // Suspended while its verification failed or is under review, or its organization is banned. Unlike revoking,
  // suspending can be undone. A suspended node's requests are refused.
  suspendedAt: timestamp(),
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
  // Most one run may attach to contract calls, apart from what it costs. 0, the default, attaches nothing.
  // Attached money counts toward the monthly cap.
  maxRunValueMicroUsd: bigint({ mode: 'number' }).notNull().default(0),
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
export const RUN_KINDS = ['script', 'contract', 'event', 'free'] as const;
/** How a captured run ended. A failed contract run is charged for its tokens, but its money changes are dropped. */
export const RUN_OUTCOMES = ['succeeded', 'failed'] as const;
/**
 * What happened to the money changes staged in a root run's tree (docs/money.md, Settlement).
 * - pending: the root succeeded, but a run in its tree that staged changes hasn't settled yet.
 * - verifying: every run settled, and the operator replays the tree's contract runs before its money moves.
 * - applied: every change from a run that succeeded, along with all its ancestors, was applied.
 * - dropped: nothing was applied.
 */
export const TREE_OUTCOMES = ['pending', 'verifying', 'applied', 'dropped'] as const;
export type TreeOutcome = typeof TREE_OUTCOMES[number];
/**
 * Whether the operator has verified an applied tree that paid anyone (docs/money.md, When the operator
 * verifies). What its payments credited isn't paid out until it's `verified`; a `failed` tree's credits stay
 * held for review.
 */
export const TREE_VERIFICATIONS = ['pending', 'verified', 'failed', 'review'] as const;
export type TreeVerification = typeof TREE_VERIFICATIONS[number];
export type ReceiptStatus = typeof RECEIPT_STATUSES[number];

/**
 * One script run by an API client on another organization's node, or one call to a contract on a node,
 * from its authorization to its capture or release. Its hold covers the script's tokens and the paid calls
 * the script makes: a voucher naming the run moves part of the hold to its own receipt.
 */
export const runsTable = pgTable("runs", {
  id: integer().primaryKey().generatedAlwaysAsIdentity(),
  // Chosen by the node, so a retried authorization finds the same run.
  runId: uuid().notNull().unique(),
  // 'script' for a request script an API client ran, 'contract' for a call to a contract on the node, 'event'
  // for an event contract the node ran with an event, under an event mandate, and 'free' for a run a node
  // opened for itself, holding nothing, so a free run can move money (docs/money.md, Settlement).
  kind: varchar({ length: 16, enum: RUN_KINDS }).notNull().default('script'),
  // The API client that ran the script, or whose event mandate pays for an event contract. Null for a contract
  // call, which a node authorizes with a voucher.
  clientId: varchar({ length: 64 }).references(() => apiClientsTable.id),
  // A contract call made by another run: its hold came out of that run's hold, and what's left goes back.
  parentRunId: integer().references((): AnyPgColumn => runsTable.id),
  // The run at the top of its tree, whose capture applies the tree's money changes. Null for a root run.
  rootRunId: integer().references((): AnyPgColumn => runsTable.id),
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
  // Set when the node captures the run, including a capture that charged nothing. Null for a released run.
  outcome: varchar({ length: 16, enum: RUN_OUTCOMES }),
  // Root runs only: what happened to the tree's money changes, null until the root settles.
  treeOutcome: varchar({ length: 16, enum: TREE_OUTCOMES }),
  // A pending tree's changes from runs that still haven't settled are dropped after this.
  treeDeadlineAt: timestamp(),
  // Root runs only: the tree's time, which payable contracts read as `now` (docs/money.md, Time and randomness).
  // Stamped when the root is authorized, or for a free run, the time its node started the script.
  stampedAt: timestamp(),
  // Root runs only: set to 'pending' when a tree that paid anyone is applied.
  verification: varchar({ length: 16, enum: TREE_VERIFICATIONS }),
  verifiedAt: timestamp(),
  expiresAt: timestamp().notNull(),
  capturedAt: timestamp(),
  releasedAt: timestamp(),
  createdAt: timestamp().notNull().defaultNow().$defaultFn(() => new Date()),
  updatedAt: timestamp().notNull().defaultNow().$defaultFn(() => new Date()),
}, (table) => [
  index("runs_rootRunId_index").on(table.rootRunId),
  index("runs_treeOutcome_index").on(table.treeOutcome),
  index("runs_verification_index").on(table.verification),
  index("runs_clientId_createdAt_index").on(table.clientId, table.createdAt),
  index("runs_payerOrganizationId_index").on(table.payerOrganizationId),
  index("runs_recipientOrganizationId_index").on(table.recipientOrganizationId),
  index("runs_status_expiresAt_index").on(table.status, table.expiresAt),
]);

/**
 * An organization's standing permission for a node to run one of its event contracts, billed like the runs
 * of the API client that deployed it. The node creates it when the client deploys the event contract, with
 * the client's run token, and each event the contract consumes is held and charged as a run under it. The
 * organization stops it by revoking the mandate or the API client.
 */
export const eventMandatesTable = pgTable("event_mandates", {
  // `mnd_` plus random characters.
  id: varchar({ length: 64 }).primaryKey(),
  organizationId: varchar({ length: 64 }).notNull().references(() => organizationsTable.id),
  clientId: varchar({ length: 64 }).notNull().references(() => apiClientsTable.id),
  nodePublicKey: varchar({ length: 255 }).notNull().references(() => nodesTable.publicKey),
  // The event contract, as path.Name.
  consumer: varchar({ length: 512 }).notNull(),
  createdAt: timestamp().notNull().defaultNow().$defaultFn(() => new Date()),
  revokedAt: timestamp(),
}, (table) => [
  unique("event_mandates_clientId_consumer_unique").on(table.clientId, table.consumer),
  index("event_mandates_organizationId_index").on(table.organizationId),
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

export const COMPOSER_ROLES = ['user', 'assistant'] as const;

/** A dashboard user's Composer chat, in one organization. Only that user can read it. */
export const composerConversationsTable = pgTable("composer_conversations", {
  id: uuid().primaryKey().$defaultFn(() => crypto.randomUUID()),
  organizationId: varchar({ length: 64 }).notNull().references(() => organizationsTable.id),
  // The Better Auth user who owns it.
  userId: text().notNull(),
  title: varchar({ length: 255 }).notNull(),
  createdAt: timestamp().notNull().defaultNow().$defaultFn(() => new Date()),
  updatedAt: timestamp().notNull().defaultNow().$defaultFn(() => new Date()),
}, (table) => [
  index("composer_conversations_userId_organizationId_updatedAt_index").on(table.userId, table.organizationId, table.updatedAt),
]);

/**
 * One message of a Composer conversation, as the Claude Messages API takes it. Append-only: an assistant
 * message's thinking blocks are only valid in the history that produced them.
 */
export const composerMessagesTable = pgTable("composer_messages", {
  id: integer().primaryKey().generatedAlwaysAsIdentity(),
  conversationId: uuid().notNull().references(() => composerConversationsTable.id, { onDelete: 'cascade' }),
  role: varchar({ length: 16, enum: COMPOSER_ROLES }).notNull(),
  // The message's content blocks.
  content: jsonb().notNull(),
  createdAt: timestamp().notNull().defaultNow().$defaultFn(() => new Date()),
}, (table) => [
  index("composer_messages_conversationId_index").on(table.conversationId),
]);

/**
 * One Composer turn's charge, from its hold to its capture or release. The organization pays the platform
 * for the Claude tokens the turn used, at the operator's Composer rates, at most the hold.
 */
export const composerChargesTable = pgTable("composer_charges", {
  id: uuid().primaryKey().$defaultFn(() => crypto.randomUUID()),
  organizationId: varchar({ length: 64 }).notNull().references(() => organizationsTable.id),
  userId: text().notNull(),
  // Null once its conversation is deleted. The charge stays, since the ledger references it.
  conversationId: uuid().references(() => composerConversationsTable.id, { onDelete: 'set null' }),
  status: varchar({ length: 16, enum: RECEIPT_STATUSES }).notNull().default('held'),
  holdMicroUsd: bigint({ mode: 'number' }).notNull(),
  // The usage the dashboard reported, and what it was charged. Null until captured.
  inputTokens: bigint({ mode: 'number' }),
  cacheWriteTokens: bigint({ mode: 'number' }),
  cacheReadTokens: bigint({ mode: 'number' }),
  outputTokens: bigint({ mode: 'number' }),
  amountMicroUsd: bigint({ mode: 'number' }),
  expiresAt: timestamp().notNull(),
  capturedAt: timestamp(),
  releasedAt: timestamp(),
  createdAt: timestamp().notNull().defaultNow().$defaultFn(() => new Date()),
}, (table) => [
  index("composer_charges_organizationId_index").on(table.organizationId),
  index("composer_charges_status_expiresAt_index").on(table.status, table.expiresAt),
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
  composerChargeId: uuid().references(() => composerChargesTable.id),
  contractId: integer().references((): AnyPgColumn => contractVersionsTable.id),
  // The Stripe object behind the entry, such as a refund's charge or a dispute.
  stripeObjectId: varchar({ length: 255 }),
  createdAt: timestamp().notNull().defaultNow().$defaultFn(() => new Date()),
}, (table) => [
  index("ledger_entries_account_index").on(table.account),
  index("ledger_entries_transactionId_index").on(table.transactionId),
]);

/**
 * A contract version a node registered with the operator, and its account (docs/money.md, Contract accounts).
 * Its balance is the sum of its active funding, cached here in the same transaction as its ledger entries.
 */
export const contractVersionsTable = pgTable("contract_versions", {
  id: integer().primaryKey().generatedAlwaysAsIdentity(),
  // The node hosting it. Only this node stages changes on its account.
  nodePublicKey: varchar({ length: 255 }).notNull().references(() => nodesTable.publicKey),
  // path.Name
  name: varchar({ length: 512 }).notNull(),
  version: varchar({ length: 64 }).notNull(),
  // Only a payable contract accepts money attached to a call.
  payable: boolean().notNull(),
  // Published to buyers, so it must never contain secrets.
  source: text().notNull(),
  sourceHash: varchar({ length: 64 }).notNull(),
  // The organization whose API client deployed it, or the node's for a deploy with the node's API key.
  ownerOrganizationId: varchar({ length: 64 }).notNull().references(() => organizationsTable.id),
  requestscriptVersion: varchar({ length: 64 }).notNull(),
  // Every contract version it binds: [{ nodePublicKey, name, version }].
  dependencies: jsonb().notNull().$type<ContractDependency[]>(),
  balanceMicroUsd: bigint({ mode: 'number' }).notNull().default(0),
  // Set by its owner's refund-all. The version then refuses incoming money.
  refundAllAt: timestamp(),
  // What buyers should know, from its verified runs: it calls its host's own resources (`hostResources`), providers
  // that don't sign their answers (`unsignedProviders`), or read state the operator hadn't verified (`unverifiedHistory`).
  flags: jsonb().notNull().$type<ContractFlag[]>().default([]),
  createdAt: timestamp().notNull().defaultNow().$defaultFn(() => new Date()),
}, (table) => [
  unique("contract_versions_node_name_version_unique").on(table.nodePublicKey, table.name, table.version),
  index("contract_versions_ownerOrganizationId_index").on(table.ownerOrganizationId),
]);

export const CONTRACT_FLAGS = ['hostResources', 'unsignedProviders', 'unverifiedHistory'] as const;
export type ContractFlag = typeof CONTRACT_FLAGS[number];

export interface ContractDependency {
  nodePublicKey: string;
  name: string;
  version: string;
}

/**
 * - staged: attached by a run whose tree hasn't been applied. Only that tree can see or spend it.
 * - active: part of the contract's balance.
 * - dropped: its tree was dropped. Never part of a balance.
 */
export const FUNDING_STATUSES = ['staged', 'active', 'dropped'] as const;

/**
 * One payment into a contract, and what is left of it (docs/money.md, Funding). Every outflow spends one
 * funder's funding under one key, oldest first.
 */
export const contractFundingTable = pgTable("contract_funding", {
  id: integer().primaryKey().generatedAlwaysAsIdentity(),
  contractId: integer().notNull().references(() => contractVersionsTable.id),
  // The organization whose money it is, through however many contracts it passed.
  funderOrganizationId: varchar({ length: 64 }).notNull().references(() => organizationsTable.id),
  // Set by the contract's earmark. Null for funding that was never earmarked.
  key: varchar({ length: 255 }),
  // The organizations it may be paid to.
  payees: jsonb().notNull().$type<string[]>(),
  status: varchar({ length: 16, enum: FUNDING_STATUSES }).notNull(),
  // The run tree that staged it, while staged.
  rootRunId: integer().references(() => runsTable.id),
  // Chosen by the attaching node, so the receiving contract's earmark can name it. Money a contract sends can
  // come from several of its funding rows, and creates one here for each.
  attachmentId: uuid(),
  // What is left. Outflows subtract from it when their tree is applied.
  amountMicroUsd: bigint({ mode: 'number' }).notNull(),
  // The part of it staged outflows will spend.
  lockedMicroUsd: bigint({ mode: 'number' }).notNull().default(0),
  // The path: the funding it was spent from when a contract sent it, where a refund returns it. Null when an
  // organization sent it, and a refund returns it to that organization's prepaid balance.
  sourceFundingId: integer().references((): AnyPgColumn => contractFundingTable.id),
  // When it first entered a contract. Passing it on never resets this, and the time limit counts from it.
  fundedAt: timestamp().notNull(),
  // The oldest card charge it may have come from.
  chargedAt: timestamp(),
  createdAt: timestamp().notNull().defaultNow().$defaultFn(() => new Date()),
}, (table) => [
  index("contract_funding_contractId_funder_key_index").on(table.contractId, table.funderOrganizationId, table.key),
  index("contract_funding_status_fundedAt_index").on(table.status, table.fundedAt),
  index("contract_funding_rootRunId_index").on(table.rootRunId),
  index("contract_funding_attachmentId_index").on(table.attachmentId),
]);

export const MONEY_FUNCTIONS = ['attach', 'earmark', 'pay', 'refund', 'random_request'] as const;
export type MoneyFunction = typeof MONEY_FUNCTIONS[number];
/** staged: waiting for its tree. applied or dropped: its tree's outcome, or its run's failure. */
export const MONEY_CHANGE_STATUSES = ['staged', 'applied', 'dropped'] as const;

/** Spending `amountMicroUsd` of one funding row. */
export interface FundingAllocation {
  fundingId: number;
  amountMicroUsd: number;
}

/** One money change a run staged: an `Account` call or money attached to a call (docs/money.md, Settlement). */
export const moneyChangesTable = pgTable("money_changes", {
  id: integer().primaryKey().generatedAlwaysAsIdentity(),
  runId: integer().notNull().references(() => runsTable.id),
  rootRunId: integer().notNull().references(() => runsTable.id),
  // The call's position in its run. A change is staged at most once per run and call index.
  callIndex: integer().notNull(),
  function: varchar({ length: 16, enum: MONEY_FUNCTIONS }).notNull(),
  // The request as the node sent it, so a retry with different parameters is refused.
  parameters: jsonb().notNull(),
  // What the call returned, for a retry.
  result: jsonb(),
  status: varchar({ length: 16, enum: MONEY_CHANGE_STATUSES }).notNull().default('staged'),
  // The contract whose account it spends, or for money a request script attaches, null.
  contractId: integer().references(() => contractVersionsTable.id),
  // Money a request script attached comes from this organization's balance, held until the tree settles.
  payerOrganizationId: varchar({ length: 64 }).references(() => organizationsTable.id),
  // The organization paid or refunded, for pay and refund.
  recipientOrganizationId: varchar({ length: 64 }).references(() => organizationsTable.id),
  amountMicroUsd: bigint({ mode: 'number' }).notNull().default(0),
  // The funding it spends.
  allocations: jsonb().notNull().$type<FundingAllocation[]>().default([]),
  // The funding it creates, for attach.
  fundingIds: jsonb().notNull().$type<number[]>().default([]),
  // For a pay, the platform's fee, set when applied. The payee was credited the amount less it.
  feeMicroUsd: bigint({ mode: 'number' }),
  createdAt: timestamp().notNull().defaultNow().$defaultFn(() => new Date()),
  settledAt: timestamp(),
}, (table) => [
  unique("money_changes_runId_callIndex_unique").on(table.runId, table.callIndex),
  index("money_changes_rootRunId_index").on(table.rootRunId),
  index("money_changes_recipient_function_index").on(table.recipientOrganizationId, table.function),
]);

export const MONEY_LOG_KINDS = ['inflow', 'pay', 'refund', 'outflow', 'expiry_refund', 'refund_all', 'fraud_reversal', 'closed', 'dispute_recovery'] as const;
export type MoneyLogKind = typeof MONEY_LOG_KINDS[number];

/** Append-only: every movement of a contract version's money, and the run or operator action behind it. */
export const contractMoneyLogTable = pgTable("contract_money_log", {
  id: integer().primaryKey().generatedAlwaysAsIdentity(),
  contractId: integer().notNull().references(() => contractVersionsTable.id),
  kind: varchar({ length: 16, enum: MONEY_LOG_KINDS }).notNull(),
  amountMicroUsd: bigint({ mode: 'number' }).notNull(),
  // Whose funding moved.
  funderOrganizationId: varchar({ length: 64 }).notNull(),
  // The organization paid or refunded, or that sent the money.
  counterpartyOrganizationId: varchar({ length: 64 }),
  // The other contract, for money sent to or received from one, or refunded to it.
  counterpartyContractId: integer(),
  runId: integer().references(() => runsTable.id),
  createdAt: timestamp().notNull().defaultNow().$defaultFn(() => new Date()),
}, (table) => [
  index("contract_money_log_contractId_index").on(table.contractId),
]);

/**
 * A contract run's receipt: what its host says it read, called and produced, for the operator to replay
 * (docs/money.md, Transcripts). Kept as evidence whatever the replay finds.
 */
export const runReceiptsTable = pgTable("run_receipts", {
  id: integer().primaryKey().generatedAlwaysAsIdentity(),
  rootRunId: integer().notNull().references(() => runsTable.id),
  nodePublicKey: varchar({ length: 255 }).notNull(),
  // The node's signature over the whole submission, which this receipt is entry `position` of.
  signature: varchar({ length: 255 }).notNull(),
  position: integer().notNull(),
  // json, not jsonb, so key order survives: it's part of what the replay compares.
  receipt: json().notNull(),
  createdAt: timestamp().notNull().defaultNow().$defaultFn(() => new Date()),
}, (table) => [
  unique("run_receipts_signature_position_unique").on(table.signature, table.position),
  index("run_receipts_rootRunId_index").on(table.rootRunId),
]);

/**
 * The operator's record of a contract's state variable, as of the last verified run that wrote it: a receipt's
 * reads must agree, so a host can't rewind or fork a contract's state (docs/money.md, State hash chains).
 */
export const contractStateChainTable = pgTable("contract_state_chain", {
  nodePublicKey: varchar({ length: 255 }).notNull(),
  // path.Name: state belongs to a contract, across its versions.
  name: varchar({ length: 512 }).notNull(),
  variable: varchar({ length: 255 }).notNull(),
  scopeKey: varchar({ length: 1024 }).notNull(),
  version: bigint({ mode: 'number' }).notNull(),
  valueHash: varchar({ length: 64 }).notNull(),
  updatedAt: timestamp().notNull().defaultNow().$defaultFn(() => new Date()),
}, (table) => [
  unique("contract_state_chain_key_unique").on(table.nodePublicKey, table.name, table.variable, table.scopeKey),
]);

export const REVIEW_STATUSES = ['open', 'host_fault', 'runtime_fault'] as const;

/** A tree whose replay came out differently without proving anything, for staff to decide (docs/money.md, When replay disagrees). */
export const verificationReviewsTable = pgTable("verification_reviews", {
  id: integer().primaryKey().generatedAlwaysAsIdentity(),
  rootRunId: integer().notNull().references(() => runsTable.id),
  nodePublicKey: varchar({ length: 255 }).notNull(),
  reason: varchar({ length: 4096 }).notNull(),
  status: varchar({ length: 16, enum: REVIEW_STATUSES }).notNull().default('open'),
  decidedBy: varchar({ length: 255 }),
  decidedAt: timestamp(),
  createdAt: timestamp().notNull().defaultNow().$defaultFn(() => new Date()),
}, (table) => [
  index("verification_reviews_status_index").on(table.status),
]);

/** A tree found fraudulent, by proof or by a review that found its host at fault, and what was reversed. */
export const fraudCasesTable = pgTable("fraud_cases", {
  id: integer().primaryKey().generatedAlwaysAsIdentity(),
  rootRunId: integer().notNull().references(() => runsTable.id),
  organizationId: varchar({ length: 64 }).notNull().references(() => organizationsTable.id),
  nodePublicKey: varchar({ length: 255 }).notNull(),
  // 'proof' or 'review'.
  kind: varchar({ length: 16 }).notNull(),
  reason: varchar({ length: 4096 }).notNull(),
  reversedMicroUsd: bigint({ mode: 'number' }).notNull().default(0),
  // Of it, what came from the fraudulent organization's own payable and prepaid balances, when the payee's held
  // credit didn't cover it.
  recoveredMicroUsd: bigint({ mode: 'number' }).notNull().default(0),
  // What the platform's revenue covered beyond that: a debt the fraudulent organization owes Stellarium, which it
  // pursues outside the platform.
  shortfallMicroUsd: bigint({ mode: 'number' }).notNull().default(0),
  createdAt: timestamp().notNull().defaultNow().$defaultFn(() => new Date()),
}, (table) => [
  index("fraud_cases_organizationId_index").on(table.organizationId),
]);

export const APPEAL_STATUSES = ['open', 'upheld', 'overturned'] as const;

/** A banned organization's one appeal (docs/money.md, Appeals). */
export const banAppealsTable = pgTable("ban_appeals", {
  id: integer().primaryKey().generatedAlwaysAsIdentity(),
  organizationId: varchar({ length: 64 }).notNull().references(() => organizationsTable.id),
  // The ban it appeals, by its time, so a later ban can be appealed again.
  bannedAt: timestamp().notNull(),
  statement: varchar({ length: 8192 }).notNull(),
  status: varchar({ length: 16, enum: APPEAL_STATUSES }).notNull().default('open'),
  createdBy: varchar({ length: 255 }),
  decidedAt: timestamp(),
  createdAt: timestamp().notNull().defaultNow().$defaultFn(() => new Date()),
}, (table) => [
  unique("ban_appeals_organizationId_bannedAt_unique").on(table.organizationId, table.bannedAt),
]);

/**
 * A dashboard account paused by its organization's ban (docs/money.md, Appeals): an owner or admin of the banned
 * organization, who can't create new organizations until the ban is lifted. It keeps its role elsewhere.
 */
export const pausedUsersTable = pgTable("paused_users", {
  id: integer().primaryKey().generatedAlwaysAsIdentity(),
  userId: text().notNull().references(() => authUsersTable.id, { onDelete: 'cascade' }),
  organizationId: varchar({ length: 64 }).notNull().references(() => organizationsTable.id),
  pausedAt: timestamp().notNull().defaultNow().$defaultFn(() => new Date()),
  liftedAt: timestamp(),
}, (table) => [
  index("paused_users_userId_index").on(table.userId),
]);

export const STAFF_ACTION_KINDS = ['ban', 'lift_ban', 'uphold_appeal', 'overturn_appeal', 'set_node_limits', 'decide_review', 'verify_identity', 'block_sanctions', 'clear_sanctions', 'close_organization', 'clear_payment_flag', 'acknowledge_alert'] as const;
export type StaffActionKind = typeof STAFF_ACTION_KINDS[number];
export const STAFF_ACTION_STATUSES = ['proposed', 'executed', 'rejected'] as const;

/**
 * A staff action. Bans, upheld appeals, raising a node's contract balance limit and finding a host at fault
 * need a second staff member's approval before they're executed (docs/money.md, Trust).
 */
export const staffActionsTable = pgTable("staff_actions", {
  id: integer().primaryKey().generatedAlwaysAsIdentity(),
  kind: varchar({ length: 32, enum: STAFF_ACTION_KINDS }).notNull(),
  organizationId: varchar({ length: 64 }).references(() => organizationsTable.id),
  payload: jsonb().notNull(),
  reason: varchar({ length: 4096 }).notNull(),
  status: varchar({ length: 16, enum: STAFF_ACTION_STATUSES }).notNull().default('proposed'),
  proposedBy: varchar({ length: 255 }).notNull(),
  approvedBy: varchar({ length: 255 }),
  decidedAt: timestamp(),
  createdAt: timestamp().notNull().defaultNow().$defaultFn(() => new Date()),
}, (table) => [
  index("staff_actions_status_index").on(table.status),
]);

/** Append-only: every staff action and every automatic one that affects an organization, and who did it. */
export const auditLogTable = pgTable("audit_log", {
  id: integer().primaryKey().generatedAlwaysAsIdentity(),
  // A staff member's name, or 'operator' for what the operator did on its own.
  actor: varchar({ length: 255 }).notNull(),
  action: varchar({ length: 64 }).notNull(),
  organizationId: varchar({ length: 64 }),
  details: jsonb().notNull(),
  createdAt: timestamp().notNull().defaultNow().$defaultFn(() => new Date()),
}, (table) => [
  index("audit_log_organizationId_index").on(table.organizationId),
]);

export const FLAG_STATUSES = ['open', 'cleared'] as const;

/**
 * A payment from a contract where the funder and the payee look like the same people: they share a dashboard user,
 * or their owners an email domain (docs/money.md, Card fraud). Payouts to the payee wait until staff clear it.
 */
export const paymentFlagsTable = pgTable("payment_flags", {
  id: integer().primaryKey().generatedAlwaysAsIdentity(),
  payeeOrganizationId: varchar({ length: 64 }).notNull().references(() => organizationsTable.id),
  funderOrganizationId: varchar({ length: 64 }).notNull().references(() => organizationsTable.id),
  rootRunId: integer().notNull().references(() => runsTable.id),
  reason: varchar({ length: 1024 }).notNull(),
  status: varchar({ length: 16, enum: FLAG_STATUSES }).notNull().default('open'),
  clearedBy: varchar({ length: 255 }),
  createdAt: timestamp().notNull().defaultNow().$defaultFn(() => new Date()),
}, (table) => [
  index("payment_flags_payee_status_index").on(table.payeeOrganizationId, table.status),
]);

export const ALERT_KINDS = ['self_payment', 'outflow_jump', 'release_rate'] as const;

/** Something unusual about a node's contracts, for staff (docs/money.md, Trust). One per kind and node at a time. */
export const alertsTable = pgTable("alerts", {
  id: integer().primaryKey().generatedAlwaysAsIdentity(),
  kind: varchar({ length: 32, enum: ALERT_KINDS }).notNull(),
  nodePublicKey: varchar({ length: 255 }).notNull(),
  organizationId: varchar({ length: 64 }),
  details: jsonb().notNull(),
  acknowledgedBy: varchar({ length: 255 }),
  acknowledgedAt: timestamp(),
  createdAt: timestamp().notNull().defaultNow().$defaultFn(() => new Date()),
}, (table) => [
  index("alerts_open_index").on(table.kind, table.nodePublicKey, table.acknowledgedAt),
]);

/**
 * What the operator tells an organization when a safety net moves its funding, or something else needs it: emailed
 * to its owners and posted to its webhook. Kept until the webhook takes it.
 */
export const notificationsTable = pgTable("notifications", {
  id: integer().primaryKey().generatedAlwaysAsIdentity(),
  organizationId: varchar({ length: 64 }).notNull().references(() => organizationsTable.id),
  kind: varchar({ length: 64 }).notNull(),
  details: jsonb().notNull(),
  webhookAttempts: integer().notNull().default(0),
  webhookDeliveredAt: timestamp(),
  nextAttemptAt: timestamp(),
  createdAt: timestamp().notNull().defaultNow().$defaultFn(() => new Date()),
}, (table) => [
  index("notifications_organizationId_index").on(table.organizationId),
  index("notifications_nextAttemptAt_index").on(table.nextAttemptAt),
]);

export const RANDOM_STATUSES = ['staged', 'requested', 'dropped'] as const;

/**
 * A contract's request for a random value under a key (docs/money.md, Time and randomness). Staged in its run's
 * tree, it becomes `requested` when the tree applies, and only then does the operator draw the value, so nobody
 * can retry a run until they like it.
 */
export const randomRequestsTable = pgTable("random_requests", {
  id: integer().primaryKey().generatedAlwaysAsIdentity(),
  contractId: integer().notNull().references(() => contractVersionsTable.id),
  key: varchar({ length: 255 }).notNull(),
  rootRunId: integer().notNull().references(() => runsTable.id),
  status: varchar({ length: 16, enum: RANDOM_STATUSES }).notNull().default('staged'),
  // 32 random bytes, base64url, drawn once the request is applied.
  value: varchar({ length: 64 }),
  signature: varchar({ length: 255 }),
  drawnAt: timestamp(),
  createdAt: timestamp().notNull().defaultNow().$defaultFn(() => new Date()),
}, (table) => [
  index("random_requests_contract_key_index").on(table.contractId, table.key),
  index("random_requests_rootRunId_index").on(table.rootRunId),
]);

/**
 * A signed hash of every contract account's balance and funding, the money log and the state hash chains, so
 * anyone holding entries can check the operator never rewrote what it published (docs/money.md, Trust).
 */
export const checkpointsTable = pgTable("checkpoints", {
  id: integer().primaryKey().generatedAlwaysAsIdentity(),
  hash: varchar({ length: 64 }).notNull(),
  summary: jsonb().notNull(),
  signature: varchar({ length: 255 }).notNull(),
  publicKey: varchar({ length: 255 }).notNull(),
  createdAt: timestamp().notNull().defaultNow().$defaultFn(() => new Date()),
});

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
