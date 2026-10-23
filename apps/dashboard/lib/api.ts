import 'server-only';
import { auth } from '@clerk/nextjs/server';

// Wire types match the operator's dashboard routes (apps/operator/src/routes/dashboard.ts). Amounts are micro-USD.

export interface Organization {
  id: string;
  name: string;
  role?: string;
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
  createdAt: string;
  revokedAt: string | null;
}

export const PAGE_SIZE = 25;

const OPERATOR_URL = (process.env.OPERATOR_URL ?? 'http://127.0.0.1:3001/v1').replace(/\/+$/, '');

export class OperatorError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = 'OperatorError';
  }
}

/** Calls the operator as the signed-in user, acting on their active organization. Balances change constantly, so nothing is cached. */
async function request<T>(method: 'GET' | 'POST' | 'DELETE', path: string, body?: unknown): Promise<T> {
  const session = await auth();
  const token = await session.getToken();
  // The session ended between the layout's check and this call.
  if (!token) return session.redirectToSignIn();
  const response = await fetch(`${OPERATOR_URL}${path}`, {
    method,
    cache: 'no-store',
    headers: { Authorization: `Bearer ${token}`, ...(body !== undefined && { 'Content-Type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
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
