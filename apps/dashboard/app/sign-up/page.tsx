import type { Metadata } from 'next';
import { AuthShell } from '@/components/AuthShell';
import { GitHubButton } from '@/components/GitHubButton';
import { safeRedirect } from '@/lib/redirect';
import { githubSignIn } from '@/lib/site';
import { SignUpForm } from './SignUpForm';

export const metadata: Metadata = { title: 'Sign up' };

export default async function SignUpPage({ searchParams }: PageProps<'/sign-up'>) {
  const redirect = safeRedirect((await searchParams).redirect);
  return (
    <AuthShell title="Create your account" subtitle="to pay for and sell API calls on Stellarium">
      {githubSignIn() && <GitHubButton redirect={redirect} />}
      <SignUpForm redirect={redirect} />
    </AuthShell>
  );
}
