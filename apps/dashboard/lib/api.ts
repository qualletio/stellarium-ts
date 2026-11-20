import 'server-only';
import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { cache } from 'react';

// Wire types match the operator's dashboard routes (apps/operator/src/routes/dashboard.ts). Amounts are micro-USD.

export interface Organization {
  id: string;
  name: string;
  role?: string;
  /** Owners and admins buy credits, set up payouts and manage nodes. */
  admin: boolean;
  balanceMicroUsd: number;
  heldMicroUsd: number;
  availableMicroUsd: number;
  payableMicroUsd: number;
  payoutsEnabled: boolean;
  payoutOnboardingStarted: boolean;
  frozen: boolean;
  /** Card top-ups older than `days` that are still unspent, when there is enough of it to warn about. */
  idleBalance: { amountMicroUsd: number; days: number } | null;
  /** Banned for fraud: the organization can read and appeal, but change nothing. */
  banned: boolean;
  /** Contract payments to the organization that payouts hold until the operator verifies the runs that made them. */
  heldForVerificationMicroUsd: number;
  /** Closed by the platform: it can read, but its nodes and clients are refused. */
  closed: boolean;
  /** Blocked by sanctions screening: it can't receive contract money or payouts until staff clear it. */
  sanctionsBlocked: boolean;
  /** Staff verified who is behind it, which lifts the attach limits on its funding. */
  identityVerified: boolean;
  /** Where the operator posts the organization's notifications, signed with its key. */
  webhookUrl: string | null;
}

/** Something the operator told the organization: emailed to its owners, and posted to its webhook. */
export interface Notification {
  id: number;
  kind: string;
  details: Record<string, unknown>;
  webhookAttempts: number;
  webhookDeliveredAt: string | null;
  createdAt: string;
}

export interface Receipt {
  id: number;
  requestId: string;
  payerOrganizationId: string;
  payerPublicKey: string;
  recipientOrganizationId: string;
  providerPublicKey: string;
  status: 'held' | 'captured' | 'released';
  heldMicroUsd: number;
  amountMicroUsd: number | null;
  feeMicroUsd: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  createdAt: string;
  capturedAt: string | null;
}

export interface TopUp {
  id: number;
  amountMicroUsd: number;
  status: 'pending' | 'succeeded';
  refundedMicroUsd: number;
  disputedMicroUsd: number;
  createdAt: string;
}

export interface Payout {
  id: number;
  amountCents: number;
  status: 'pending' | 'paid' | 'failed' | 'reversed';
  reversedCents: number;
  failureReason: string | null;
  createdAt: string;
}

export interface Node {
  publicKey: string;
  label: string | null;
  /** The URL the node reported to the operator. Listing needs it. */
  baseUrl: string | null;
  name: string | null;
  description: string | null;
  priceMicroUsdPerMillionTokens: number;
  listed: boolean;
  /** When the node's `/v1/self` last answered with its key. */
  verifiedAt: string | null;
  createdAt: string;
  revokedAt: string | null;
}

/** A node any organization's API clients can run scripts on. */
export interface Listing {
  publicKey: string;
  name: string | null;
  description: string | null;
  baseUrl: string | null;
  priceMicroUsdPerMillionTokens: number;
  organizationId: string;
  organizationName: string;
  verifiedAt: string | null;
}

/** Credentials that run scripts on one node, paid from the organization's balance. The secret is never returned after creation. */
export interface ApiClient {
  id: string;
  organizationId: string;
  nodePublicKey: string;
  label: string | null;
  maxRunCostMicroUsd: number;
  monthlyCapMicroUsd: number | null;
  /** Most one run may attach to contract calls. 0 attaches nothing. */
  maxRunValueMicroUsd: number;
  createdBy: string | null;
  createdAt: string;
  revokedAt: string | null;
  /** What its runs have cost or still hold this calendar month (UTC). */
  monthToDateMicroUsd: number;
}

/**
 * One script an API client ran on another organization's node, one call to a contract on a node, or one event an
 * event contract consumed under its mandate. Its paid calls are receipts.
 */
export interface Run {
  id: number;
  runId: string;
  kind: 'script' | 'contract' | 'event';
  /** Null for a contract call, which a node authorizes with a voucher instead of a run token. */
  clientId: string | null;
  /** For a contract call made by another run: that run's id. */
  parentRunId: number | null;
  payerOrganizationId: string;
  recipientOrganizationId: string;
  nodePublicKey: string;
  status: 'held' | 'captured' | 'released';
  priceMicroUsdPerMillionTokens: number;
  maxTokens: number;
  holdMicroUsd: number;
  tokens: number | null;
  amountMicroUsd: number | null;
  feeMicroUsd: number | null;
  createdAt: string;
  capturedAt: string | null;
}

export interface User {
  id: string;
  name: string;
  email: string;
  image?: string | null;
}

export interface Session {
  user: User;
  session: { activeOrganizationId?: string | null };
}

export interface OrganizationListItem {
  id: string;
  name: string;
  slug: string;
}

export interface Member {
  id: string;
  role: string;
  createdAt: string;
  user: { id: string; name: string; email: string };
}

export interface Invitation {
  id: string;
  email: string;
  role: string | null;
  status: 'pending' | 'accepted' | 'rejected' | 'canceled';
  expiresAt: string;
}

export interface FullOrganization extends OrganizationListItem {
  members: Member[];
  invitations: Invitation[];
}

export const PAGE_SIZE = 25;

export const OPERATOR_URL = (process.env.OPERATOR_URL ?? 'http://127.0.0.1:3001/v1').replace(/\/+$/, '');

/** The browser's cookies, which carry the Better Auth session the operator checks. */
async function cookieHeader(): Promise<Record<string, string>> {
  const cookie = (await headers()).get('cookie');
  return cookie ? { cookie } : {};
}

/** Reads a Better Auth endpoint on the operator as the signed-in user. Null when it answers no content. */
async function authGet<T>(path: string): Promise<T | null> {
  const response = await fetch(`${OPERATOR_URL}/auth${path}`, { cache: 'no-store', headers: await cookieHeader() });
  if (response.status === 401) return null;
  if (!response.ok) throw new OperatorError(`GET /auth${path} returned ${response.status}`, response.status);
  return response.json() as Promise<T | null>;
}

/** The signed-in user and their session, or null. Fetched once per render. */
export const getSession = cache(() => authGet<Session>('/get-session'));

export const listOrganizations = cache(async () => (await authGet<OrganizationListItem[]>('/organization/list')) ?? []);

/** The active organization with its members and invitations. */
export const getFullOrganization = () => authGet<FullOrganization>('/organization/get-full-organization');

export class OperatorError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = 'OperatorError';
  }
}

/**
 * Calls the operator as the signed-in user, acting on their active organization. Balances change constantly, so nothing is cached.
 * `extraHeaders` carries the dashboard server's secret, for the calls that need it.
 */
async function request<T>(method: 'GET' | 'POST' | 'PATCH' | 'DELETE', path: string, body?: unknown, extraHeaders: Record<string, string> = {}): Promise<T> {
  const response = await fetch(`${OPERATOR_URL}${path}`, {
    method,
    cache: 'no-store',
    headers: { ...(await cookieHeader()), ...extraHeaders, ...(body !== undefined && { 'Content-Type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  // The session ended between the layout's check and this call.
  if (response.status === 401) redirect('/sign-in');
  if (!response.ok) {
    const detail = await response.json().then((json: { error?: unknown }) => json?.error, () => undefined);
    throw new OperatorError(typeof detail === 'string' ? detail : `${method} ${path} returned ${response.status}`, response.status);
  }
  return response.json() as Promise<T>;
}

const page = (before?: number) => `limit=${PAGE_SIZE}${before ? `&before=${before}` : ''}`;

export const getOrganization = () => request<Organization>('GET', '/org');

export const listReceipts = (as: 'payer' | 'provider', before?: number) =>
  request<{ receipts: Receipt[] }>('GET', `/org/receipts?as=${as}&${page(before)}`).then((r) => r.receipts);

export const listTopUps = (before?: number) => request<{ topUps: TopUp[] }>('GET', `/org/top-ups?${page(before)}`).then((r) => r.topUps);

export const listPayouts = (before?: number) => request<{ payouts: Payout[] }>('GET', `/org/payouts?${page(before)}`).then((r) => r.payouts);

export const listNodes = () => request<{ nodes: Node[] }>('GET', '/org/nodes').then((r) => r.nodes);

export const createTopUp = (amountCents: number) => request<{ topUpId: number; url: string }>('POST', '/org/top-ups', { amountCents });

export const billingPortal = () => request<{ url: string }>('POST', '/org/billing-portal');

export const connectOnboarding = () => request<{ url: string }>('POST', '/org/connect/onboarding');

export const connectDashboard = () => request<{ url: string }>('POST', '/org/connect/dashboard');

export const createEnrollmentToken = (label?: string) =>
  request<{ token: string; expiresAt: string }>('POST', '/org/enrollment-tokens', label ? { label } : {});

export const listNotifications = () => request<{ notifications: Notification[] }>('GET', '/org/notifications').then((r) => r.notifications);

export const setWebhook = (url: string | null) => request<{ webhookUrl: string | null }>('PATCH', '/org/webhook', { url });

export const revokeNode = (publicKey: string) => request<{ revoked: boolean }>('DELETE', `/org/nodes/${encodeURIComponent(publicKey)}`);

export interface ListingUpdate {
  name?: string;
  description?: string | null;
  priceMicroUsdPerMillionTokens?: number;
  listed?: boolean;
}

export const updateListing = (publicKey: string, update: ListingUpdate) =>
  request<{ node: Node }>('PATCH', `/org/nodes/${encodeURIComponent(publicKey)}`, update).then((r) => r.node);

export const listListings = () => request<{ listings: Listing[] }>('GET', '/listings').then((r) => r.listings);

export const listClients = () => request<{ clients: ApiClient[] }>('GET', '/org/clients').then((r) => r.clients);

export interface NewApiClient {
  nodePublicKey: string;
  label?: string;
  maxRunCostMicroUsd?: number;
  monthlyCapMicroUsd?: number | null;
}

export const createClient = (client: NewApiClient) => request<{ client: Omit<ApiClient, 'monthToDateMicroUsd'>; clientSecret: string }>('POST', '/org/clients', client);

/** Omitted fields keep their value. A null monthly cap removes it. */
export interface ApiClientLimits {
  maxRunCostMicroUsd?: number;
  monthlyCapMicroUsd?: number | null;
  maxRunValueMicroUsd?: number;
}

export const updateClientLimits = (id: string, limits: ApiClientLimits) =>
  request<{ client: Omit<ApiClient, 'monthToDateMicroUsd'> }>('PATCH', `/org/clients/${encodeURIComponent(id)}`, limits).then((r) => r.client);

export const revokeClient = (id: string) => request<{ revoked: boolean }>('DELETE', `/org/clients/${encodeURIComponent(id)}`);

/**
 * A node's permission to run one of the organization's event contracts with each event it consumes, billed like
 * runs of the API client that deployed it.
 */
export interface EventMandate {
  id: string;
  organizationId: string;
  clientId: string;
  nodePublicKey: string;
  /** The event contract, as path.Name. */
  consumer: string;
  createdAt: string;
  revokedAt: string | null;
}

export const listEventMandates = () => request<{ mandates: EventMandate[] }>('GET', '/org/event-mandates').then((r) => r.mandates);

export const revokeEventMandate = (id: string) => request<{ revoked: boolean }>('DELETE', `/org/event-mandates/${encodeURIComponent(id)}`);

/** A contract version the organization owns, registered with the operator (docs/money.md, Contract accounts). */
export interface OwnedContract {
  id: number;
  nodePublicKey: string;
  /** path.Name */
  name: string;
  version: string;
  payable: boolean;
  sourceHash: string;
  ownerOrganizationId: string;
  requestscriptVersion: string;
  dependencies: { nodePublicKey: string; name: string; version: string }[];
  balanceMicroUsd: number;
  /** Set by refund-all: the version refuses money from then on. */
  refundAllAt: string | null;
  createdAt: string;
}

export type MoneyLogKind = 'inflow' | 'pay' | 'refund' | 'outflow' | 'expiry_refund' | 'refund_all' | 'fraud_reversal' | 'closed';

export interface MoneyLogEntry {
  id: number;
  contractId: number;
  kind: MoneyLogKind;
  amountMicroUsd: number;
  funderOrganizationId: string;
  counterpartyOrganizationId: string | null;
  counterpartyContractId: number | null;
  runId: number | null;
  createdAt: string;
}

/** A contract version as the operator publishes it to anyone, before they fund it. Funders aren't named. */
export interface PublicContract {
  nodePublicKey: string;
  name: string;
  version: string;
  payable: boolean;
  source: string;
  sourceHash: string;
  ownerOrganizationId: string;
  hostOrganizationId: string;
  requestscriptVersion: string;
  dependencies: { nodePublicKey: string; name: string; version: string }[];
  balanceMicroUsd: number;
  refundAllAt: string | null;
  /** What buyers should know from its verified runs. */
  flags: ('hostResources' | 'unsignedProviders' | 'unverifiedHistory')[];
  log: { kind: MoneyLogKind; amountMicroUsd: number; createdAt: string }[];
}

export const listContracts = () => request<{ contracts: OwnedContract[] }>('GET', '/org/contracts').then((r) => r.contracts);

export const getContractLog = (id: number) => request<{ entries: MoneyLogEntry[] }>('GET', `/org/contracts/${id}/log`).then((r) => r.entries);

export const refundAll = (id: number) => request<{ refundedMicroUsd: number }>('POST', `/org/contracts/${id}/refund-all`);

/** Any contract version, as the operator publishes it. Undefined when it isn't registered. */
export async function getPublicContract(nodePublicKey: string, ref: string): Promise<PublicContract | undefined> {
  try {
    return await request<PublicContract>('GET', `/contracts/${encodeURIComponent(nodePublicKey)}/${encodeURIComponent(ref)}`);
  } catch (error) {
    if (error instanceof OperatorError && (error.status === 404 || error.status === 400)) return undefined;
    throw error;
  }
}

export interface AuditEntry {
  id: number;
  /** A staff member's name, or `operator` for what the operator did on its own. */
  actor: string;
  action: string;
  organizationId: string | null;
  details: Record<string, unknown>;
  createdAt: string;
}

export const listAudit = () => request<{ entries: AuditEntry[] }>('GET', '/org/audit').then((r) => r.entries);

export interface FraudCase {
  id: number;
  nodePublicKey: string;
  kind: 'proof' | 'review';
  reason: string;
  reversedMicroUsd: number;
  createdAt: string;
}

export interface BanAppeal {
  id: number;
  statement: string;
  status: 'open' | 'upheld' | 'overturned';
  createdAt: string;
  decidedAt: string | null;
}

export type BanStatus =
  | { banned: false }
  | { banned: true; bannedAt: string; reason: string | null; appeal: BanAppeal | null; fraudCases: FraudCase[] };

export const getBanStatus = () => request<BanStatus>('GET', '/org/ban');

export const appealBan = (statement: string) => request<{ appeal: BanAppeal }>('POST', '/org/appeal', { statement });

export const listRuns = (as: 'payer' | 'provider', before?: number) =>
  request<{ runs: Run[] }>('GET', `/org/runs?as=${as}&${page(before)}`).then((r) => r.runs);

/** A short-lived run token for one of the organization's API clients, for running or deploying a script. Admins only. */
export const issueRunToken = (clientId: string) =>
  request<{ access_token: string; expires_in: number; nodeBaseUrl: string | null }>('POST', `/org/clients/${encodeURIComponent(clientId)}/token`);

export interface ComposerConversation {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
}

/** A message as the Claude Messages API takes it. */
export interface ComposerMessage {
  role: 'user' | 'assistant';
  content: unknown[];
}

export const listComposerConversations = () =>
  request<{ conversations: ComposerConversation[] }>('GET', '/org/composer/conversations').then((r) => r.conversations);

export const getComposerConversation = (id: string) =>
  request<{ conversation: ComposerConversation; messages: ComposerMessage[] }>('GET', `/org/composer/conversations/${encodeURIComponent(id)}`);

export const deleteComposerConversation = (id: string) => request<{ deleted: boolean }>('DELETE', `/org/composer/conversations/${encodeURIComponent(id)}`);

/**
 * The header proving a call comes from the dashboard's server. Composer turns move the organization's money on
 * usage the server reports, so the operator accepts them only with it. Throws 503 when DASHBOARD_SERVICE_SECRET is unset.
 */
function dashboardServerHeaders(): Record<string, string> {
  const secret = process.env.DASHBOARD_SERVICE_SECRET;
  if (!secret) throw new OperatorError('DASHBOARD_SERVICE_SECRET is not set: the Composer is disabled', 503);
  return { 'x-stellarium-dashboard-secret': secret };
}

export const holdComposerTurn = (turn: { conversationId?: string; title: string }) =>
  request<{ chargeId: string; conversationId: string; holdMicroUsd: number }>('POST', '/org/composer/turns', turn, dashboardServerHeaders());

export interface ComposerUsage {
  inputTokens: number;
  cacheWriteTokens: number;
  cacheReadTokens: number;
  outputTokens: number;
}

export const completeComposerTurn = (chargeId: string, turn: { messages: ComposerMessage[]; usage: ComposerUsage }) =>
  request<{ amountMicroUsd: number }>('POST', `/org/composer/turns/${encodeURIComponent(chargeId)}/complete`, turn, dashboardServerHeaders());

export const releaseComposerTurn = (chargeId: string) =>
  request<{ released: boolean }>('POST', `/org/composer/turns/${encodeURIComponent(chargeId)}/release`, undefined, dashboardServerHeaders());
