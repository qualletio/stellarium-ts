'use server';

import { refresh } from 'next/cache';
import { redirect } from 'next/navigation';
import * as api from './api';

/** What a form's action reports back. Undefined until it has run. */
export type ActionState = {
  error?: string;
  enrollment?: { token: string; expiresAt: string };
  /** A new API client's credentials, shown once. */
  client?: { id: string; secret: string; nodePublicKey: string };
  saved?: boolean;
} | undefined;

/**
 * Dollars from a form field, as micro-USD: `"2.5"` → `2_500_000`. Undefined when the field is empty, and
 * null when it isn't a nonnegative amount with at most six decimal places.
 */
function microUsd(value: FormDataEntryValue | null): number | undefined | null {
  const text = String(value ?? '').trim();
  if (text === '') return undefined;
  const dollars = Number(text);
  const micros = Math.round(dollars * 1_000_000);
  if (!Number.isFinite(dollars) || dollars < 0 || !Number.isSafeInteger(micros) || Math.abs(dollars * 1_000_000 - micros) > 1e-3) return null;
  return micros;
}

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

/** Saves a node's listing details. Listing it also has the operator check that the node's URL answers with its key. */
export async function updateListingAction(_state: ActionState, formData: FormData): Promise<ActionState> {
  const price = microUsd(formData.get('price'));
  if (price === null) return { error: 'Enter a price in dollars per million tokens, such as 2.50, or 0 for free.' };
  const name = String(formData.get('name') ?? '').trim();
  const description = String(formData.get('description') ?? '').trim();
  const result = await attempt(() => api.updateListing(String(formData.get('publicKey')), {
    ...(name && { name }),
    description: description || null,
    priceMicroUsdPerMillionTokens: price ?? 0,
    listed: formData.get('listed') === 'on',
  }));
  if ('error' in result) return result;
  refresh();
  return { saved: true };
}

/** Creates an API client. Its secret is shown once: the operator keeps only its hash. */
export async function createClientAction(_state: ActionState, formData: FormData): Promise<ActionState> {
  const maxRunCost = microUsd(formData.get('maxRunCost'));
  const monthlyCap = microUsd(formData.get('monthlyCap'));
  if (maxRunCost === null || maxRunCost === 0) return { error: 'Enter a maximum run cost in dollars, such as 1.00.' };
  if (monthlyCap === null || monthlyCap === 0) return { error: 'Enter a monthly cap in dollars, or leave it empty for none.' };
  const label = String(formData.get('label') ?? '').trim();
  const result = await attempt(() => api.createClient({
    nodePublicKey: String(formData.get('nodePublicKey')),
    ...(label && { label }),
    ...(maxRunCost !== undefined && { maxRunCostMicroUsd: maxRunCost }),
    monthlyCapMicroUsd: monthlyCap ?? null,
  }));
  if ('error' in result) return result;
  refresh();
  return { client: { id: result.value.client.id, secret: result.value.clientSecret, nodePublicKey: result.value.client.nodePublicKey } };
}

export async function revokeClientAction(_state: ActionState, formData: FormData): Promise<ActionState> {
  const result = await attempt(() => api.revokeClient(String(formData.get('id'))));
  if ('error' in result) return result;
  refresh();
  return undefined;
}
