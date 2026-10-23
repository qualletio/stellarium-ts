import { redirect } from 'next/navigation';
import { Sidebar } from '@/components/Sidebar';
import { getSession, listOrganizations } from '@/lib/api';
import styles from './layout.module.css';

/** Every console page acts on the signed-in user's active organization. */
export default async function ConsoleLayout({ children }: LayoutProps<'/'>) {
  const session = await getSession();
  if (!session) redirect('/sign-in');
  const organizations = await listOrganizations();
  const activeOrganizationId = session.session.activeOrganizationId;
  // None chosen yet, or the user has since left it.
  if (!activeOrganizationId || !organizations.some((organization) => organization.id === activeOrganizationId)) redirect('/select-organization');
  return (
    <div className={styles.shell}>
      <Sidebar user={session.user} organizations={organizations} activeOrganizationId={activeOrganizationId} />
      <main className={styles.main}>
        <div className={styles.content}>{children}</div>
        <footer className={styles.footer}>
          <a href="https://stellarium.sh" target="_blank" rel="noreferrer">stellarium.sh</a>
          <a href="https://docs.stellarium.sh" target="_blank" rel="noreferrer">Documentation</a>
          <a href="https://github.com/qualletio/stellarium-ts" target="_blank" rel="noreferrer">GitHub</a>
        </footer>
      </main>
    </div>
  );
}
