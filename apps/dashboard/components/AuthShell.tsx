import styles from '@/app/auth.module.css';
import { StarMark } from './StarMark';

/** The brand above a centered card, on the grid background of stellarium.sh's hero. */
export function AuthShell({ children }: { children: React.ReactNode }) {
  return (
    <main className={styles.page}>
      <p className={styles.brand}>
        <StarMark className={styles.mark} />
        Stellarium <span className={styles.muted}>Platform</span>
      </p>
      {children}
    </main>
  );
}
