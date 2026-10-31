'use client';

import { useActionState, useState } from 'react';
import { deleteConversationAction } from '@/lib/actions';
import ui from './ui.module.css';

/** Asks once more before deleting a Composer conversation, without a browser dialog. Its charges stay in the ledger. */
export function DeleteConversationButton({ id }: { id: string }) {
  const [confirming, setConfirming] = useState(false);
  const [state, formAction, pending] = useActionState(deleteConversationAction, undefined);

  if (!confirming) {
    return (
      <button type="button" className={ui.buttonSecondary} onClick={() => setConfirming(true)}>
        Delete
      </button>
    );
  }
  return (
    <form action={formAction} className={ui.form}>
      <input type="hidden" name="id" value={id} />
      <button type="submit" className={ui.buttonDanger} disabled={pending}>
        {pending ? 'Deleting…' : 'Confirm delete'}
      </button>
      <button type="button" className={ui.buttonSecondary} onClick={() => setConfirming(false)} disabled={pending}>
        Cancel
      </button>
      {state?.error && <p className={ui.error}>{state.error}</p>}
    </form>
  );
}
