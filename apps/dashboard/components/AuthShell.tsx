import styles from '@/app/auth.module.css';
import { StarMark } from './StarMark';

/** The brand above a centered card, on the grid background of stellarium.sh's hero. */
export function AuthShell({ title, subtitle, children }: { title?: string; subtitle?: string; children: React.ReactNode }) {
  return (
    <main className={styles.page}>
      <p className={styles.brand}>
        <StarMark className={styles.mark} />
        Stellarium <span className={styles.muted}>Platform</span>
      </p>
      <div className={styles.card}>
        {title && (
          <header>
            <h1 className={styles.title}>{title}</h1>
            {subtitle && <p className={styles.subtitle}>{subtitle}</p>}
          </header>
        )}
        {children}
      </div>
    </main>
  );
}
