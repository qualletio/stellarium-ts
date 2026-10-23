import type { Metadata } from 'next';
import { ActionButton } from '@/components/ActionButton';
import { OrgAlerts } from '@/components/OrgAlerts';
import { Pagination } from '@/components/Pagination';
import { StatusBadge } from '@/components/StatusBadge';
import { TopUpForm } from '@/components/TopUpForm';
import ui from '@/components/ui.module.css';
import { openBillingPortal } from '@/lib/actions';
import { getOrganization, listTopUps, PAGE_SIZE, type TopUp } from '@/lib/api';
import { formatDate, formatUsd } from '@/lib/format';

export const metadata: Metadata = { title: 'Credits' };

const cursor = (value: string | string[] | undefined) => {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
};

export default async function BillingPage({ searchParams }: PageProps<'/billing'>) {
  const query = await searchParams;
  const before = cursor(query.before);
  const [organization, topUps] = await Promise.all([getOrganization(), listTopUps(before)]);
  const admin = organization.role === 'admin';

  return (
    <>
      <header className={ui.header}>
        <h1 className={ui.title}>Credits</h1>
      </header>

      {/* Stripe returns here from Checkout. The webhook credits the balance, usually within seconds. */}
      {query.top_up === 'success' && (
        <p className={ui.alertWarning} role="status">Payment received. Your balance updates as soon as Stripe confirms it, usually within a few seconds.</p>
      )}
      {query.top_up === 'cancelled' && <p className={ui.alertWarning} role="status">Checkout was cancelled. You weren't charged.</p>}
      <OrgAlerts organization={organization} onBillingPage />

      <section className={ui.section}>
        <div className={ui.sectionHead}>
          <div>
            <h2 className={ui.sectionTitle}>Credit balance</h2>
            <p className={ui.description}>Your nodes' paid calls draw on this prepaid balance. Credit doesn't expire.</p>
          </div>
        </div>
        <div className={ui.panel}>
          <div>
            <p className={ui.stat}>{formatUsd(organization.balanceMicroUsd)}</p>
            <p className={ui.note}>
              {formatUsd(organization.availableMicroUsd)} available · {formatUsd(organization.heldMicroUsd)} held for calls in progress
            </p>
          </div>
        </div>
        <div className={ui.panel}>
          {admin ? <TopUpForm /> : <p className={ui.note}>Only organization admins can buy credits.</p>}
          <p className={ui.note}>Card payments through Stripe, from $10 to $1,000.</p>
        </div>
      </section>

      <section className={ui.section}>
        <div className={ui.sectionHead}>
          <div>
            <h2 className={ui.sectionTitle}>Payment details</h2>
            <p className={ui.description}>Saved cards, billing details and receipts are managed in Stripe's billing portal.</p>
          </div>
          {admin && <ActionButton action={openBillingPortal} label="Manage in Stripe" />}
        </div>
      </section>

      <section className={ui.section}>
        <div className={ui.sectionHead}>
          <div>
            <h2 className={ui.sectionTitle}>Top-up history</h2>
            <p className={ui.description}>Dates are UTC.</p>
          </div>
        </div>
        <TopUpTable topUps={topUps} empty={before ? 'No older top-ups.' : 'No top-ups yet.'} />
        <Pagination path="/billing" before={before} lastId={topUps.at(-1)?.id} full={topUps.length === PAGE_SIZE} />
      </section>
    </>
  );
}

function TopUpTable({ topUps, empty }: { topUps: TopUp[]; empty: string }) {
  if (topUps.length === 0) return <p className={ui.empty}>{empty}</p>;
  return (
    <div className={ui.tableWrap}>
      <table className={ui.table}>
        <thead>
          <tr>
            <th>Date</th>
            <th>Status</th>
            <th>Adjustments</th>
            <th className={ui.numeric}>Amount</th>
          </tr>
        </thead>
        <tbody>
          {topUps.map((topUp) => (
            <tr key={topUp.id}>
              <td>{formatDate(topUp.createdAt)}</td>
              <td>
                <StatusBadge status={topUp.status} label={topUp.status === 'pending' ? 'awaiting payment' : 'paid'} />
              </td>
              <td>
                {topUp.refundedMicroUsd > 0 && <span className={ui.secondary}>{formatUsd(topUp.refundedMicroUsd)} refunded</span>}
                {topUp.disputedMicroUsd > 0 && <span className={ui.secondary}>{formatUsd(topUp.disputedMicroUsd)} disputed</span>}
                {topUp.refundedMicroUsd === 0 && topUp.disputedMicroUsd === 0 && <span className={ui.secondary}>—</span>}
              </td>
              <td className={ui.numeric}>{formatUsd(topUp.amountMicroUsd)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
