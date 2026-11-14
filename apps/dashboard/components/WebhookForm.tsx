'use client';

import { useActionState } from 'react';
import { setWebhookAction } from '@/lib/actions';
import ui from './ui.module.css';

/** Where the operator posts the organization's notifications. Empty stops posting them. */
export function WebhookForm({ url }: { url: string | null }) {
  const [state, formAction, pending] = useActionState(setWebhookAction, undefined);
  return (
    <form action={formAction} className={ui.form}>
      <input className={ui.input} name="url" type="url" defaultValue={url ?? ''} placeholder="https://example.com/stellarium-webhook" aria-label="Webhook URL" />
      <button type="submit" className={ui.buttonSecondary} disabled={pending}>
        {pending ? 'Saving…' : 'Save'}
      </button>
      {state?.saved && <p className={ui.note}>Saved.</p>}
      {state?.error && <p className={ui.error} role="alert">{state.error}</p>}
    </form>
  );
}
