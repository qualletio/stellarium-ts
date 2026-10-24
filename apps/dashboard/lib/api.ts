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
  createdBy: string | null;
  createdAt: string;
  revokedAt: string | null;
  /** What its runs have cost or still hold this calendar month (UTC). */
  monthToDateMicroUsd: number;
}

/** One script an API client ran on another organization's node. Its paid calls are receipts. */
export interface Run {
  id: number;
  runId: string;
  clientId: string;
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

/** Calls the operator as the signed-in user, acting on their active organization. Balances change constantly, so nothing is cached. */
async function request<T>(method: 'GET' | 'POST' | 'PATCH' | 'DELETE', path: string, body?: unknown): Promise<T> {
  const response = await fetch(`${OPERATOR_URL}${path}`, {
    method,
    cache: 'no-store',
    headers: { ...(await cookieHeader()), ...(body !== undefined && { 'Content-Type': 'application/json' }) },
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

export const revokeClient = (id: string) => request<{ revoked: boolean }>('DELETE', `/org/clients/${encodeURIComponent(id)}`);

export const listRuns = (as: 'payer' | 'provider', before?: number) =>
  request<{ runs: Run[] }>('GET', `/org/runs?as=${as}&${page(before)}`).then((r) => r.runs);
