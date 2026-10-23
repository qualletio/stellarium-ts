'use client';

import { useActionState } from 'react';
import type { ActionState } from '@/lib/actions';
import ui from './ui.module.css';

/**
 * A button that runs a Server Action, such as one that redirects to Stripe. Shows a pending label while
 * it runs and the operator's error if it fails.
 */
export function ActionButton({
  action,
  label,
  pendingLabel = 'Opening…',
  variant = 'secondary',
}: {
  action: (state: ActionState) => Promise<ActionState>;
  label: string;
  pendingLabel?: string;
  variant?: 'primary' | 'secondary';
}) {
  const [state, formAction, pending] = useActionState(action, undefined);
  return (
    <form action={formAction} className={ui.form}>
      <button type="submit" className={variant === 'primary' ? ui.button : ui.buttonSecondary} disabled={pending}>
        {pending ? pendingLabel : label}
      </button>
      {state?.error && (
        <p className={ui.error} role="alert">
          {state.error}
        </p>
      )}
    </form>
  );
}
