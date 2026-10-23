import { SignIn } from '@clerk/nextjs';
import type { Metadata } from 'next';
import { AuthShell } from '@/components/AuthShell';

export const metadata: Metadata = { title: 'Sign in' };

export default function SignInPage() {
  return (
    <AuthShell>
      <SignIn />
    </AuthShell>
  );
}
