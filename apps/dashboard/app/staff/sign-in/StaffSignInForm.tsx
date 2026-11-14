'use client';

import { useActionState } from 'react';
import ui from '@/components/ui.module.css';
import { staffSignIn } from '@/lib/staffActions';

export function StaffSignInForm() {
  const [state, formAction, pending] = useActionState(staffSignIn, undefined);
  return (
    <form action={formAction} className={ui.form}>
      <label className={ui.field}>
        Staff API key
        <input className={ui.input} name="key" type="password" autoComplete="off" required />
      </label>
      <button type="submit" className={ui.button} disabled={pending}>{pending ? 'Checking…' : 'Sign in'}</button>
      {state?.error && <p className={ui.error} role="alert">{state.error}</p>}
    </form>
  );
}
