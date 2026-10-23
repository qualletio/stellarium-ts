'use client';

import Link from 'next/link';
import { useState } from 'react';
import styles from '@/app/auth.module.css';
import ui from '@/components/ui.module.css';
import { authClient, errorMessage } from '@/lib/auth-client';

export function ForgotPasswordForm() {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();
  const [sent, setSent] = useState(false);

  async function submit(formData: FormData) {
    setPending(true);
    setError(undefined);
    const { error } = await authClient.requestPasswordReset({ email: String(formData.get('email')), redirectTo: '/reset-password' });
    if (error) setError(errorMessage(error));
    else setSent(true);
    setPending(false);
  }

  return (
    <>
      {sent ? (
        // The same answer whether or not the account exists.
        <p role="status">If an account uses that email, a link to reset its password is on its way.</p>
      ) : (
        <form action={submit} className={styles.form}>
          <label className={ui.field}>
            Email
            <input className={ui.input} name="email" type="email" autoComplete="email" required />
          </label>
          {error && <p className={ui.error} role="alert">{error}</p>}
          <button type="submit" className={`${ui.button} ${styles.wide}`} disabled={pending}>
            {pending ? 'Sending…' : 'Send reset link'}
          </button>
        </form>
      )}
      <p className={styles.footer}>
        <Link href="/sign-in" className={ui.textLink}>Back to sign in</Link>
      </p>
    </>
  );
}
