import type { Metadata } from 'next';
import Link from 'next/link';
import { AuthShell } from '@/components/AuthShell';
import ui from '@/components/ui.module.css';
import { ResetPasswordForm } from './ResetPasswordForm';

export const metadata: Metadata = { title: 'Choose a new password' };

/** The reset link from the email lands here with a token, or with an error if the link expired. */
export default async function ResetPasswordPage({ searchParams }: PageProps<'/reset-password'>) {
  const { token } = await searchParams;
  return (
    <AuthShell title="Choose a new password">
      {typeof token === 'string' ? (
        <ResetPasswordForm token={token} />
      ) : (
        <>
          <p className={ui.error} role="alert">This link is invalid or has expired.</p>
          <Link href="/forgot-password" className={ui.textLink}>Send a new link</Link>
        </>
      )}
    </AuthShell>
  );
}
