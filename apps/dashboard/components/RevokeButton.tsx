'use client';

import { useActionState, useState } from 'react';
import { revokeNodeAction } from '@/lib/actions';
import ui from './ui.module.css';

/** Asks once more before revoking, without a browser dialog. A revoked key can never be enrolled again. */
export function RevokeButton({ publicKey }: { publicKey: string }) {
  const [confirming, setConfirming] = useState(false);
  const [state, formAction, pending] = useActionState(revokeNodeAction, undefined);

  if (!confirming) {
    return (
      <button type="button" className={ui.buttonSecondary} onClick={() => setConfirming(true)}>
        Revoke
      </button>
    );
  }
  return (
    <form action={formAction} className={ui.form}>
      <input type="hidden" name="publicKey" value={publicKey} />
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
