import { SignUp } from '@clerk/nextjs';
import type { Metadata } from 'next';
import { AuthShell } from '@/components/AuthShell';

export const metadata: Metadata = { title: 'Sign up' };

export default function SignUpPage() {
  return (
    <AuthShell>
      <SignUp />
    </AuthShell>
  );
}
