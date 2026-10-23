'use client';

import { useActionState } from 'react';
import { startTopUp } from '@/lib/actions';
import ui from './ui.module.css';

const PRESETS = [10, 25, 100];

/** Takes an amount in dollars and continues to Stripe Checkout. */
export function TopUpForm() {
  const [state, formAction, pending] = useActionState(startTopUp, undefined);
  return (
    <form action={formAction} className={ui.form}>
      <label className={ui.field}>
        Amount
        <span className={ui.prefixed}>
          <span className={ui.prefix}>$</span>
          <input className={ui.input} name="amount" type="number" inputMode="decimal" min="10" max="1000" step="0.01" defaultValue="25" required />
        </span>
      </label>
      {PRESETS.map((amount) => (
        <button
          key={amount}
          type="button"
          className={ui.buttonSecondary}
          onClick={(event) => {
            const input = event.currentTarget.form?.elements.namedItem('amount') as HTMLInputElement | null;
            if (input) input.value = String(amount);
          }}
        >
          ${amount}
        </button>
      ))}
      <button type="submit" className={ui.button} disabled={pending}>
        {pending ? 'Opening Stripe…' : 'Buy credits'}
      </button>
      {state?.error && (
        <p className={ui.error} role="alert">
          {state.error}
        </p>
      )}
    </form>
  );
}
