'use server';

import { cookies } from 'next/headers';
import { refresh } from 'next/cache';
import { redirect } from 'next/navigation';
import { OperatorError } from './api';
import { STAFF_COOKIE, type StaffAction, staffRequest } from './staff';

export type StaffActionState = { error?: string; message?: string } | undefined;

async function attempt(call: () => Promise<{ action?: StaffAction }>): Promise<StaffActionState> {
  try {
    const { action } = await call();
    refresh();
    if (!action) return { message: 'Done.' };
    if (action.status === 'executed') return { message: 'Done.' };
    return { message: 'Proposed. Another staff member must approve it.' };
  } catch (error) {
    if (error instanceof OperatorError) return { error: error.message };
    throw error;
  }
}

/** Checks a staff key against the operator before keeping it. */
export async function staffSignIn(_state: StaffActionState, formData: FormData): Promise<StaffActionState> {
  const key = String(formData.get('key') ?? '').trim();
  if (!key) return { error: 'Enter your staff API key.' };
  try {
    await staffRequest('GET', '/staff/reviews', undefined, key);
  } catch (error) {
    if (error instanceof OperatorError) return { error: error.status === 401 ? "The operator doesn't know that key." : error.message };
    throw error;
  }
  (await cookies()).set(STAFF_COOKIE, key, { httpOnly: true, secure: true, sameSite: 'strict', path: '/staff', maxAge: 60 * 60 * 8 });
  redirect('/staff');
}

export async function staffSignOut(): Promise<void> {
  (await cookies()).delete({ name: STAFF_COOKIE, path: '/staff' });
  redirect('/staff/sign-in');
}

const propose = (kind: StaffAction['kind'], payload: Record<string, unknown>, reason: string) =>
  staffRequest<{ action: StaffAction }>('POST', '/staff/actions', { kind, payload, reason });

/** A staff action proposed from a form: `kind`, a JSON `payload` built from its other fields, and a `reason`. */
export async function proposeAction(_state: StaffActionState, formData: FormData): Promise<StaffActionState> {
  const kind = String(formData.get('kind')) as StaffAction['kind'];
  const reason = String(formData.get('reason') ?? '').trim();
  if (!reason) return { error: 'Give a reason: it goes in the audit log.' };
  let payload: Record<string, unknown>;
  switch (kind) {
    case 'ban':
    case 'lift_ban':
    case 'uphold_appeal':
    case 'overturn_appeal':
    case 'verify_identity':
    case 'block_sanctions':
    case 'clear_sanctions':
    case 'close_organization':
      payload = { organizationId: String(formData.get('organizationId') ?? '').trim() };
      if (!payload.organizationId) return { error: 'Name the organization.' };
      break;
    case 'clear_payment_flag':
      payload = { flagId: Number(formData.get('flagId')) };
      break;
    case 'acknowledge_alert':
      payload = { alertId: Number(formData.get('alertId')) };
      break;
    case 'decide_review':
      payload = { reviewId: Number(formData.get('reviewId')), decision: String(formData.get('decision')) };
      break;
    case 'set_node_limits': {
      const limits: Record<string, number> = {};
      for (const name of ['maxContractBalanceMicroUsd', 'maxApiKeyRunValueMicroUsd', 'monthlyApiKeyValueCapMicroUsd']) {
        const dollars = String(formData.get(name) ?? '').trim();
        if (dollars === '') continue;
        const micros = Math.round(Number(dollars) * 1_000_000);
        if (!Number.isSafeInteger(micros) || micros < 0) return { error: 'Limits are dollar amounts, 0 or more.' };
        limits[name] = micros;
      }
      payload = { publicKey: String(formData.get('publicKey') ?? '').trim(), limits };
      break;
    }
    default:
      return { error: 'Unknown action.' };
  }
  return attempt(() => propose(kind, payload, reason));
}

export async function approveAction(_state: StaffActionState, formData: FormData): Promise<StaffActionState> {
  return attempt(() => staffRequest<{ action: StaffAction }>('POST', `/staff/actions/${Number(formData.get('id'))}/approve`));
}

export async function rejectAction(_state: StaffActionState, formData: FormData): Promise<StaffActionState> {
  return attempt(() => staffRequest<{ action: StaffAction }>('POST', `/staff/actions/${Number(formData.get('id'))}/reject`));
}

export async function publishCheckpoint(_state: StaffActionState): Promise<StaffActionState> {
  return attempt(() => staffRequest('POST', '/staff/checkpoints'));
}
