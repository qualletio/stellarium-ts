'use client';

import { useActionState, useState } from 'react';
import { refundAllAction } from '@/lib/actions';
import ui from './ui.module.css';

/**
 * A contract version's emergency stop, which asks once more: its funding goes back to its funders, and it refuses
 * money from then on. It can't be undone, though the version can still be called without money.
 */
export function RefundAllButton({ id }: { id: number }) {
  const [confirming, setConfirming] = useState(false);
  const [state, formAction, pending] = useActionState(refundAllAction, undefined);

  if (state?.saved) return <p className={ui.note}>Refunded. The version refuses money from now on.</p>;
  if (!confirming) {
    return (
      <button type="button" className={ui.buttonSecondary} onClick={() => setConfirming(true)}>
        Refund all
      </button>
    );
  }
  return (
    <form action={formAction} className={ui.form}>
      <input type="hidden" name="id" value={id} />
      <button type="submit" className={ui.buttonDanger} disabled={pending}>
        {pending ? 'Refunding…' : 'Confirm refund all'}
      </button>
      <button type="button" className={ui.buttonSecondary} onClick={() => setConfirming(false)} disabled={pending}>
        Cancel
      </button>
      {state?.error && <p className={ui.error} role="alert">{state.error}</p>}
    </form>
  );
}
