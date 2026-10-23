'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import type { OrganizationListItem } from '@/lib/api';
import { authClient } from '@/lib/auth-client';
import styles from './Sidebar.module.css';

const OTHER = '__other__';

/** Switches the active organization, which every console page acts on. */
export function OrganizationSwitcher({ organizations, activeOrganizationId }: { organizations: OrganizationListItem[]; activeOrganizationId: string }) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  return (
    <select
      className={styles.select}
      aria-label="Organization"
      value={activeOrganizationId}
      disabled={pending}
      onChange={async (event) => {
        const organizationId = event.target.value;
        if (organizationId === OTHER) return router.push('/select-organization');
        setPending(true);
        await authClient.organization.setActive({ organizationId });
        router.push('/');
        router.refresh();
        setPending(false);
      }}
    >
      {organizations.map((organization) => (
        <option key={organization.id} value={organization.id}>{organization.name}</option>
      ))}
      <option value={OTHER}>Create organization…</option>
    </select>
  );
}
