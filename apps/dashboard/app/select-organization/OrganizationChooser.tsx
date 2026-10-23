'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import styles from '@/app/auth.module.css';
import ui from '@/components/ui.module.css';
import type { OrganizationListItem } from '@/lib/api';
import { authClient, errorMessage } from '@/lib/auth-client';

/** A URL-safe slug from the name, made unique with a random suffix. Nothing shows it, but Better Auth requires one. */
const slugFor = (name: string) =>
  `${name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'org'}-${crypto.randomUUID().slice(0, 8)}`;

/** Lists the user's organizations to switch to, and creates a new one. Either becomes the active organization. */
export function OrganizationChooser({ organizations }: { organizations: OrganizationListItem[] }) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();

  async function run(call: () => Promise<{ error: { message?: string } | null }>) {
    setPending(true);
    setError(undefined);
    const { error } = await call();
    if (!error) {
      router.replace('/');
      router.refresh();
      return;
    }
    setError(errorMessage(error));
    setPending(false);
  }

  async function create(formData: FormData) {
    const name = String(formData.get('name')).trim();
    // Creating an organization makes it the active one.
    await run(() => authClient.organization.create({ name, slug: slugFor(name) }));
  }

  return (
    <>
      {organizations.length > 0 && (
        <>
          <div className={styles.list}>
            {organizations.map((organization) => (
              <button
                key={organization.id}
                type="button"
                className={styles.listItem}
                disabled={pending}
                onClick={() => run(() => authClient.organization.setActive({ organizationId: organization.id }))}
              >
                {organization.name} <span aria-hidden="true">→</span>
              </button>
            ))}
          </div>
          <p className={styles.divider}>or create one</p>
        </>
      )}
      <form action={create} className={styles.form}>
        <label className={ui.field}>
          Organization name
          <input className={ui.input} name="name" maxLength={100} required />
        </label>
        <button type="submit" className={`${ui.button} ${styles.wide}`} disabled={pending}>
          {pending ? 'Working…' : 'Create organization'}
        </button>
      </form>
      {error && <p className={ui.error} role="alert">{error}</p>}
    </>
  );
}
