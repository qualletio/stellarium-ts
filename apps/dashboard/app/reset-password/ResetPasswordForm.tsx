'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import styles from '@/app/auth.module.css';
import ui from '@/components/ui.module.css';
import { authClient, errorMessage } from '@/lib/auth-client';

export function ResetPasswordForm({ token }: { token: string }) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();

  async function submit(formData: FormData) {
    setPending(true);
    setError(undefined);
    const { error } = await authClient.resetPassword({ newPassword: String(formData.get('password')), token });
    if (!error) return router.replace('/sign-in?reset=1');
    setError(errorMessage(error));
    setPending(false);
  }

  return (
    <form action={submit} className={styles.form}>
      <label className={ui.field}>
        New password
        <input className={ui.input} name="password" type="password" autoComplete="new-password" minLength={8} required />
      </label>
      {error && <p className={ui.error} role="alert">{error}</p>}
      <button type="submit" className={`${ui.button} ${styles.wide}`} disabled={pending}>
        {pending ? 'Saving…' : 'Set password'}
      </button>
    </form>
  );
}
