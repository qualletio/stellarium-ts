import { currentUser } from '@clerk/nextjs/server';
import type { Metadata } from 'next';
import Link from 'next/link';
import { OrgAlerts } from '@/components/OrgAlerts';
import { ReceiptTable } from '@/components/ReceiptTable';
import ui from '@/components/ui.module.css';
import { getOrganization, listReceipts } from '@/lib/api';
import { formatUsd } from '@/lib/format';
import { DOCS_URL } from '@/lib/site';
import styles from './page.module.css';

export const metadata: Metadata = { title: 'Overview' };

const GET_STARTED = [
  { href: '/nodes', title: 'Enroll a node', text: 'Create an enrollment token so a node can pay for calls and be paid for its functions.' },
  { href: '/payouts', title: 'Set up payouts', text: 'Connect a bank account through Stripe to receive what your paid functions earn.' },
  { href: DOCS_URL, title: 'Publish a paid function', text: 'Add a payment manifest to a resource function and set its price in micro-USD.', external: true },
];

export default async function OverviewPage() {
  const [organization, user, recent] = await Promise.all([getOrganization(), currentUser(), listReceipts('payer')]);
  const admin = organization.role === 'admin';

  return (
    <>
      <header className={ui.header}>
        <h1 className={ui.title}>{user?.firstName ? `Welcome back, ${user.firstName}` : 'Overview'}</h1>
        <div className={ui.actions}>
          <a href={DOCS_URL} target="_blank" rel="noreferrer" className={ui.buttonSecondary}>Docs</a>
          {admin && <Link href="/nodes" className={ui.buttonSecondary}>Enroll a node</Link>}
          {admin && <Link href="/billing" className={ui.button}>Buy credits</Link>}
        </div>
      </header>

      <OrgAlerts organization={organization} />

      <section className={ui.cards}>
        <div className={ui.card}>
          <p className={ui.kicker}>Credit balance</p>
          <div className={ui.cardRow}>
            <p className={ui.stat}>{formatUsd(organization.balanceMicroUsd)}</p>
            {admin && <Link href="/billing" className={ui.buttonSecondary}>Add funds</Link>}
          </div>
          <p className={ui.note}>Paid calls by your nodes draw on this.</p>
        </div>
        <div className={ui.card}>
          <p className={ui.kicker}>Available</p>
          <div className={ui.cardRow}>
            <p className={ui.stat}>{formatUsd(organization.availableMicroUsd)}</p>
          </div>
          <p className={ui.note}>{formatUsd(organization.heldMicroUsd)} held for calls in progress</p>
        </div>
        <div className={ui.card}>
          <p className={ui.kicker}>Earnings</p>
          <div className={ui.cardRow}>
            <p className={ui.stat}>{formatUsd(organization.payableMicroUsd)}</p>
            <Link href="/payouts" className={ui.buttonSecondary}>Payouts</Link>
          </div>
          <p className={ui.note}>{organization.payoutsEnabled ? 'Paid out weekly once over $10.' : 'Set up payouts to receive them.'}</p>
        </div>
      </section>

      <section className={`${ui.section} ${styles.spaced}`}>
        <div className={ui.sectionHead}>
          <div>
            <h2 className={ui.sectionTitle}>Recent usage</h2>
            <p className={ui.description}>Paid calls your nodes made. Times are UTC.</p>
          </div>
          <Link href="/usage" className={ui.textLink}>View all</Link>
        </div>
        <ReceiptTable receipts={recent.slice(0, 5)} as="payer" empty="No paid calls yet. They appear here as your nodes make them." />
      </section>

      <section className={ui.section}>
        <div className={ui.sectionHead}>
          <h2 className={ui.sectionTitle}>Get started</h2>
        </div>
        <div className={ui.cards}>
          {GET_STARTED.map((item) => {
            const content = (
              <>
                <p className={ui.linkCardTitle}>{item.title} {item.external ? '↗' : '→'}</p>
                <p className={ui.note}>{item.text}</p>
              </>
            );
            return item.external ? (
              <a key={item.title} href={item.href} target="_blank" rel="noreferrer" className={ui.linkCard}>{content}</a>
            ) : (
              <Link key={item.title} href={item.href} className={ui.linkCard}>{content}</Link>
            );
          })}
        </div>
      </section>
    </>
  );
}
