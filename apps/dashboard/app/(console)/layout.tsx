import { auth } from '@clerk/nextjs/server';
import { redirect } from 'next/navigation';
import { Sidebar } from '@/components/Sidebar';
import styles from './layout.module.css';

/** Every console page acts on the signed-in user's active organization. */
export default async function ConsoleLayout({ children }: LayoutProps<'/'>) {
  const { userId, orgId, redirectToSignIn } = await auth();
  if (!userId) return redirectToSignIn();
  if (!orgId) redirect('/select-organization');
  return (
    <div className={styles.shell}>
      <Sidebar />
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
