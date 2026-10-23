import type { Metadata } from 'next';
import { AuthShell } from '@/components/AuthShell';
import { GitHubButton } from '@/components/GitHubButton';
import { safeRedirect } from '@/lib/redirect';
import { githubSignIn } from '@/lib/site';
import { SignInForm } from './SignInForm';

export const metadata: Metadata = { title: 'Sign in' };

export default async function SignInPage({ searchParams }: PageProps<'/sign-in'>) {
  const query = await searchParams;
  const redirect = safeRedirect(query.redirect);
  return (
    <AuthShell title="Sign in" subtitle="to the Stellarium console">
      {githubSignIn() && <GitHubButton redirect={redirect} />}
      <SignInForm redirect={redirect} notice={query.reset === '1' ? 'Your password was changed. Sign in with the new one.' : undefined} />
    </AuthShell>
  );
}
