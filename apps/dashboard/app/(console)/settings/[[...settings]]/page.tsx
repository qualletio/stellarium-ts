import { OrganizationProfile } from '@clerk/nextjs';
import type { Metadata } from 'next';
import ui from '@/components/ui.module.css';

export const metadata: Metadata = { title: 'Organization' };

/** The organization's profile, members, invitations and roles are Clerk's. Admins move money and manage nodes; members view. */
export default function SettingsPage() {
  return (
    <>
      <header className={ui.header}>
        <h1 className={ui.title}>Organization</h1>
      </header>
      <OrganizationProfile
        routing="path"
        path="/settings"
        // Full width, with a hairline instead of Clerk's card shadow, like the rest of the console.
        appearance={{ elements: { rootBox: { width: '100%' }, cardBox: { width: '100%', maxWidth: 'none', boxShadow: 'none', border: '1px solid var(--line)' } } }}
      />
    </>
  );
}
