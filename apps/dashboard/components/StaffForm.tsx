'use client';

import { type ReactNode, useActionState } from 'react';
import type { StaffActionState } from '@/lib/staffActions';
import ui from './ui.module.css';

/** A staff action's form: hidden fields in `fields`, visible ones as `children`, and the operator's answer below. */
export function StaffForm({ action, fields = {}, label, variant = 'secondary', children }: {
  action: (state: StaffActionState, formData: FormData) => Promise<StaffActionState>;
  fields?: Record<string, string | number>;
  label: string;
  variant?: 'primary' | 'secondary' | 'danger';
  children?: ReactNode;
}) {
  const [state, formAction, pending] = useActionState(action, undefined);
  const button = variant === 'primary' ? ui.button : variant === 'danger' ? ui.buttonDanger : ui.buttonSecondary;
  return (
    <form action={formAction} className={ui.form}>
      {Object.entries(fields).map(([name, value]) => <input key={name} type="hidden" name={name} value={value} />)}
      {children}
      <button type="submit" className={button} disabled={pending}>{pending ? 'Working…' : label}</button>
      {state?.error && <p className={ui.error} role="alert">{state.error}</p>}
      {state?.message && <p className={ui.note}>{state.message}</p>}
    </form>
  );
}
