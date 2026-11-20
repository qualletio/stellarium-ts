import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import styles from './staff.module.css';

export const metadata: Metadata = { title: { default: 'Staff', template: '%s | Stellarium staff' } };

/** The staff console: outside the organization console, since staff sign in with their own key. */
export default function StaffLayout({ children }: { children: ReactNode }) {
  return <main className={styles.shell}>{children}</main>;
}
