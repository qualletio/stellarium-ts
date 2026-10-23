'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import styles from '@/app/auth.module.css';
import ui from '@/components/ui.module.css';
import { authClient, errorMessage } from '@/lib/auth-client';
import { withRedirect } from '@/lib/redirect';

export function SignInForm({ redirect, notice }: { redirect: string; notice?: string }) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();
  const [message, setMessage] = useState(notice);

  async function submit(formData: FormData) {
    setPending(true);
    setError(undefined);
    const { error } = await authClient.signIn.email({
      email: String(formData.get('email')),
      password: String(formData.get('password')),
      callbackURL: redirect,
    });
    if (!error) {
      router.replace(redirect);
      router.refresh();
      return;
    }
    // Signing in with an unverified email sends a new verification link.
    if (error.code === 'EMAIL_NOT_VERIFIED') setMessage('Verify your email first. We sent you a new link.');
    else setError(errorMessage(error));
    setPending(false);
  }

  return (
    <>
      <form action={submit} className={styles.form}>
        <label className={ui.field}>
          Email
          <input className={ui.input} name="email" type="email" autoComplete="email" required />
        </label>
        <label className={ui.field}>
          <span className={styles.labelRow}>
            Password
            <Link href="/forgot-password" className={ui.textLink}>Forgot password?</Link>
          </span>
          <input className={ui.input} name="password" type="password" autoComplete="current-password" required />
        </label>
        {message && <p className={ui.note} role="status">{message}</p>}
        {error && <p className={ui.error} role="alert">{error}</p>}
        <button type="submit" className={`${ui.button} ${styles.wide}`} disabled={pending}>
          {pending ? 'Signing in…' : 'Sign in'}
        </button>
      </form>
      <p className={styles.footer}>
        No account? <Link href={withRedirect('/sign-up', redirect)} className={ui.textLink}>Sign up</Link>
      </p>
    </>
  );
}
