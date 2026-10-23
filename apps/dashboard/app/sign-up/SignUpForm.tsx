'use client';

import Link from 'next/link';
import { useState } from 'react';
import styles from '@/app/auth.module.css';
import ui from '@/components/ui.module.css';
import { authClient, errorMessage } from '@/lib/auth-client';
import { withRedirect } from '@/lib/redirect';

/** Creates the account. The verification link in the email signs the user in and continues to `redirect`. */
export function SignUpForm({ redirect }: { redirect: string }) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();
  const [sentTo, setSentTo] = useState<string>();

  async function submit(formData: FormData) {
    setPending(true);
    setError(undefined);
    const email = String(formData.get('email'));
    const { error } = await authClient.signUp.email({
      name: String(formData.get('name')),
      email,
      password: String(formData.get('password')),
      callbackURL: redirect,
    });
    if (error) setError(errorMessage(error));
    else setSentTo(email);
    setPending(false);
  }

  if (sentTo) {
    return (
      <p role="status">
        We sent a link to <strong>{sentTo}</strong>. Open it to verify your email and sign in.
      </p>
    );
  }

  return (
    <>
      <form action={submit} className={styles.form}>
        <label className={ui.field}>
          Name
          <input className={ui.input} name="name" autoComplete="name" required />
        </label>
        <label className={ui.field}>
          Email
          <input className={ui.input} name="email" type="email" autoComplete="email" required />
        </label>
        <label className={ui.field}>
          Password
          <input className={ui.input} name="password" type="password" autoComplete="new-password" minLength={8} required />
        </label>
        {error && <p className={ui.error} role="alert">{error}</p>}
        <button type="submit" className={`${ui.button} ${styles.wide}`} disabled={pending}>
          {pending ? 'Creating account…' : 'Create account'}
        </button>
      </form>
      <p className={styles.footer}>
        Have an account? <Link href={withRedirect('/sign-in', redirect)} className={ui.textLink}>Sign in</Link>
      </p>
    </>
  );
}
