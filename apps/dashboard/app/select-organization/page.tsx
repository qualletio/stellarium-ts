import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { AuthShell } from '@/components/AuthShell';
import { getSession, listOrganizations } from '@/lib/api';
import { OrganizationChooser } from './OrganizationChooser';

export const metadata: Metadata = { title: 'Choose an organization' };

/** Balances, nodes and payouts belong to organizations, so the console needs one selected. */
export default async function SelectOrganizationPage() {
  if (!(await getSession())) redirect('/sign-in?redirect=/select-organization');
  const organizations = await listOrganizations();
  return (
    <AuthShell
      title={organizations.length > 0 ? 'Choose an organization' : 'Create your organization'}
      subtitle="Balances, nodes and payouts belong to an organization. Invite your team to it later."
    >
      <OrganizationChooser organizations={organizations} />
    </AuthShell>
  );
}
