'use client';

import { useActionState, useState } from 'react';
import type { ActionState } from '@/lib/actions';
import ui from './ui.module.css';

/**
 * Asks once more before revoking, without a browser dialog. Revoking can't be undone: a revoked node's key
 * can never be enrolled again, and a revoked API client's secret stops working. `action` receives `value` as
 * the form field `name`.
 */
export function RevokeButton({ action, name, value }: { action: (state: ActionState, formData: FormData) => Promise<ActionState>; name: string; value: string }) {
  const [confirming, setConfirming] = useState(false);
  const [state, formAction, pending] = useActionState(action, undefined);

  if (!confirming) {
    return (
      <button type="button" className={ui.buttonSecondary} onClick={() => setConfirming(true)}>
        Revoke
      </button>
    );
  }
  return (
    <form action={formAction} className={ui.form}>
      <input type="hidden" name={name} value={value} />
      <button type="submit" className={ui.buttonDanger} disabled={pending}>
        {pending ? 'Revoking…' : 'Confirm revoke'}
      </button>
      <button type="button" className={ui.buttonSecondary} onClick={() => setConfirming(false)} disabled={pending}>
        Cancel
      </button>
      {state?.error && <p className={ui.error}>{state.error}</p>}
    </form>
  );
}
