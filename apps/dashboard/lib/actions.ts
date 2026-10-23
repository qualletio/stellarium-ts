'use server';

import { refresh } from 'next/cache';
import { redirect } from 'next/navigation';
import * as api from './api';

/** What a form's action reports back. Undefined until it has run. */
export type ActionState = { error?: string; enrollment?: { token: string; expiresAt: string } } | undefined;

/** Runs an operator call, turning its refusals into a message for the form. Unexpected errors propagate to error.tsx. */
async function attempt<T>(call: () => Promise<T>): Promise<{ value: T } | { error: string }> {
  try {
    return { value: await call() };
  } catch (error) {
    if (error instanceof api.OperatorError) return { error: error.message };
    throw error;
  }
}

/** Opens Stripe Checkout for a top-up. The balance is credited when Stripe confirms the payment. */
export async function startTopUp(_state: ActionState, formData: FormData): Promise<ActionState> {
  const dollars = Number(formData.get('amount'));
  const cents = Math.round(dollars * 100);
  if (!Number.isFinite(dollars) || cents <= 0 || Math.abs(dollars * 100 - cents) > 1e-6) {
    return { error: 'Enter an amount in dollars and cents.' };
  }
  const result = await attempt(() => api.createTopUp(cents));
  if ('error' in result) return result;
  // Outside any try: redirect works by throwing.
  redirect(result.value.url);
}

export async function openBillingPortal(_state: ActionState): Promise<ActionState> {
  const result = await attempt(api.billingPortal);
  if ('error' in result) return result;
  redirect(result.value.url);
}

export async function startPayoutOnboarding(_state: ActionState): Promise<ActionState> {
  const result = await attempt(api.connectOnboarding);
  if ('error' in result) return result;
  redirect(result.value.url);
}

export async function openPayoutDashboard(_state: ActionState): Promise<ActionState> {
  const result = await attempt(api.connectDashboard);
  if ('error' in result) return result;
  redirect(result.value.url);
}

/** Creates a one-time enrollment token. It is shown once: the operator keeps only its hash. */
export async function createNodeToken(_state: ActionState, formData: FormData): Promise<ActionState> {
  const label = String(formData.get('label') ?? '').trim();
  const result = await attempt(() => api.createEnrollmentToken(label || undefined));
  if ('error' in result) return result;
  return { enrollment: result.value };
}

export async function revokeNodeAction(_state: ActionState, formData: FormData): Promise<ActionState> {
  const result = await attempt(() => api.revokeNode(String(formData.get('publicKey'))));
  if ('error' in result) return result;
  refresh();
  return undefined;
}
