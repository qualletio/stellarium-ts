'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import type { OrganizationListItem, User } from '@/lib/api';
import { DOCS_URL } from '@/lib/site';
import { AccountMenu } from './AccountMenu';
import { OrganizationSwitcher } from './OrganizationSwitcher';
import styles from './Sidebar.module.css';
import { StarMark } from './StarMark';
import { ThemeToggle } from './ThemeToggle';

const GROUPS = [
  {
    items: [
      { href: '/', label: 'Overview' },
      { href: '/usage', label: 'Usage' },
      { href: '/nodes', label: 'Nodes' },
      { href: '/explore', label: 'Explore' },
      { href: '/clients', label: 'API clients' },
      { href: '/composer', label: 'Composer' },
    ],
  },
  {
    label: 'Billing',
    items: [
      { href: '/billing', label: 'Credits' },
      { href: '/payouts', label: 'Payouts' },
    ],
  },
  {
    label: 'Organization',
    items: [{ href: '/settings', label: 'Settings' }],
  },
];

const isActive = (pathname: string, href: string) => (href === '/' ? pathname === '/' : pathname === href || pathname.startsWith(`${href}/`));

export function Sidebar({ user, organizations, activeOrganizationId }: { user: User; organizations: OrganizationListItem[]; activeOrganizationId: string }) {
  const pathname = usePathname();
  return (
    <aside className={styles.sidebar}>
      <Link href="/" className={styles.brand}>
        <StarMark className={styles.mark} />
        Stellarium <span className={styles.product}>Platform</span>
      </Link>

      <div className={styles.switcher}>
        <OrganizationSwitcher organizations={organizations} activeOrganizationId={activeOrganizationId} />
      </div>

      <nav className={styles.nav} aria-label="Main">
        {GROUPS.map((group) => (
          <div key={group.label ?? 'main'} className={styles.group}>
            {group.label && <p className={styles.groupLabel}>{group.label}</p>}
            {group.items.map((item) => (
              <Link
                key={item.href}
                href={item.href}
                className={styles.item}
                aria-current={isActive(pathname, item.href) ? 'page' : undefined}
              >
                {item.label}
              </Link>
            ))}
          </div>
        ))}
      </nav>

      <div className={styles.footer}>
        <a href={DOCS_URL} target="_blank" rel="noreferrer" className={styles.item}>
          Documentation <span aria-hidden="true">↗</span>
        </a>
        <div className={styles.account}>
          <AccountMenu user={user} />
          <ThemeToggle />
        </div>
      </div>
    </aside>
  );
}
