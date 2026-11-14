'use client';

import { useActionState } from 'react';
import { appealBanAction } from '@/lib/actions';
import ui from './ui.module.css';

/** The owner's one appeal of a ban. Stellarium reviews it against the run receipts. */
export function AppealForm() {
  const [state, formAction, pending] = useActionState(appealBanAction, undefined);
  if (state?.saved) return <p className={ui.note}>Your appeal was sent. Stellarium reviews it against the run receipts.</p>;
  return (
    <form action={formAction} className={ui.form}>
      <label className={ui.field}>
        Why should the ban be lifted?
        <textarea className={ui.input} name="statement" rows={6} maxLength={8192} required />
      </label>
      <button type="submit" className={ui.button} disabled={pending}>
        {pending ? 'Sending…' : 'Send appeal'}
      </button>
      {state?.error && <p className={ui.error} role="alert">{state.error}</p>}
    </form>
  );
}
