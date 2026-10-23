import { OrganizationList } from '@clerk/nextjs';
import { auth } from '@clerk/nextjs/server';
import type { Metadata } from 'next';
import { AuthShell } from '@/components/AuthShell';

export const metadata: Metadata = { title: 'Choose an organization' };

/** Balances, nodes and payouts belong to organizations, so the console needs one selected. */
export default async function SelectOrganizationPage() {
  const { userId, redirectToSignIn } = await auth();
  if (!userId) return redirectToSignIn();
  return (
    <AuthShell>
      <OrganizationList hidePersonal afterSelectOrganizationUrl="/" afterCreateOrganizationUrl="/" />
    </AuthShell>
  );
}
