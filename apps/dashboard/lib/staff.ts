import 'server-only';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { OPERATOR_URL, OperatorError } from './api';

// Wire types match the operator's staff routes (apps/operator/src/routes/staff.ts).

/** The cookie that holds a staff member's API key, httpOnly so the page's scripts never see it. */
export const STAFF_COOKIE = 'stellarium_staff';

export interface Review {
  id: number;
  rootRunId: number;
  nodePublicKey: string;
  reason: string;
  status: 'open' | 'host_fault' | 'runtime_fault';
  createdAt: string;
}

export interface StaffAction {
  id: number;
  kind:
    | 'ban' | 'lift_ban' | 'uphold_appeal' | 'overturn_appeal' | 'set_node_limits' | 'decide_review'
    | 'verify_identity' | 'block_sanctions' | 'clear_sanctions' | 'close_organization' | 'clear_payment_flag' | 'acknowledge_alert';
  organizationId: string | null;
  payload: Record<string, unknown>;
  reason: string;
  status: 'proposed' | 'executed' | 'rejected';
  proposedBy: string;
  /** The staff members who approved it, comma-separated, the proposer first. */
  approvedBy: string | null;
  createdAt: string;
}

export interface Appeal {
  id: number;
  organizationId: string;
  statement: string;
  status: 'open' | 'upheld' | 'overturned';
  createdAt: string;
}

export interface FraudCase {
  id: number;
  rootRunId: number;
  organizationId: string;
  nodePublicKey: string;
  kind: 'proof' | 'review';
  reason: string;
  reversedMicroUsd: number;
  recoveredMicroUsd: number;
  shortfallMicroUsd: number;
  createdAt: string;
}

/** Something unusual about a node's contracts (apps/operator/src/governance/alerts.ts). */
export interface Alert {
  id: number;
  kind: 'self_payment' | 'outflow_jump' | 'release_rate';
  nodePublicKey: string;
  organizationId: string | null;
  details: Record<string, unknown>;
  createdAt: string;
}

/** A contract payment to a payee that looks linked to its funder, which payouts hold until staff clear it. */
export interface PaymentFlag {
  id: number;
  payeeOrganizationId: string;
  funderOrganizationId: string;
  rootRunId: number;
  reason: string;
  createdAt: string;
}

export interface AuditEntry {
  id: number;
  actor: string;
  action: string;
  organizationId: string | null;
  details: Record<string, unknown>;
  createdAt: string;
}

export async function staffKey(): Promise<string | undefined> {
  return (await cookies()).get(STAFF_COOKIE)?.value;
}

/** Calls the operator's staff API with the signed-in staff member's key. Without a valid one, back to sign-in. */
export async function staffRequest<T>(method: 'GET' | 'POST', path: string, body?: unknown, key?: string): Promise<T> {
  const apiKey = key ?? await staffKey();
  if (!apiKey) redirect('/staff/sign-in');
  const response = await fetch(`${OPERATOR_URL}${path}`, {
    method,
    cache: 'no-store',
    headers: { Authorization: `Bearer ${apiKey}`, ...(body !== undefined && { 'Content-Type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (response.status === 401 && !key) redirect('/staff/sign-in');
  if (!response.ok) {
    const detail = await response.json().then((json: { error?: unknown }) => json?.error, () => undefined);
    throw new OperatorError(typeof detail === 'string' ? detail : `${method} ${path} returned ${response.status}`, response.status);
  }
  return response.json() as Promise<T>;
}

export const listReviews = () => staffRequest<{ reviews: Review[] }>('GET', '/staff/reviews').then((r) => r.reviews);
export const listActions = (status?: StaffAction['status']) => staffRequest<{ actions: StaffAction[] }>('GET', `/staff/actions${status ? `?status=${status}` : ''}`).then((r) => r.actions);
export const listAppeals = () => staffRequest<{ appeals: Appeal[] }>('GET', '/staff/appeals').then((r) => r.appeals);
export const listFraudCases = () => staffRequest<{ fraudCases: FraudCase[] }>('GET', '/staff/fraud-cases').then((r) => r.fraudCases);
export const listAlerts = () => staffRequest<{ alerts: Alert[] }>('GET', '/staff/alerts').then((r) => r.alerts);
export const listPaymentFlags = () => staffRequest<{ flags: PaymentFlag[] }>('GET', '/staff/payment-flags').then((r) => r.flags);
export const listStaffAudit = () => staffRequest<{ entries: AuditEntry[] }>('GET', '/staff/audit').then((r) => r.entries);
