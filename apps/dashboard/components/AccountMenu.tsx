'use client';

import { useRouter } from 'next/navigation';
import type { User } from '@/lib/api';
import { authClient } from '@/lib/auth-client';
import styles from './Sidebar.module.css';

/** The signed-in user, with sign-out. */
export function AccountMenu({ user }: { user: User }) {
  const router = useRouter();
  // Fetching the session through the browser also renews its cookie while the console is in use.
  const { data } = authClient.useSession();
  const { name, email } = data?.user ?? user;
  return (
    <details className={styles.menu}>
      <summary className={styles.menuButton}>
        <span className={styles.avatar} aria-hidden="true">{(name || email).charAt(0).toUpperCase()}</span>
        <span className={styles.name}>{name || email}</span>
      </summary>
      <div className={styles.menuPanel}>
        <p className={styles.email}>{email}</p>
        <button
          type="button"
          className={styles.menuItem}
          onClick={async () => {
            await authClient.signOut();
            router.replace('/sign-in');
            router.refresh();
          }}
        >
          Sign out
        </button>
      </div>
    </details>
  );
}
