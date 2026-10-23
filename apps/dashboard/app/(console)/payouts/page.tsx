import type { Metadata } from 'next';
import { ActionButton } from '@/components/ActionButton';
import { Pagination } from '@/components/Pagination';
import { StatusBadge } from '@/components/StatusBadge';
import ui from '@/components/ui.module.css';
import { openPayoutDashboard, startPayoutOnboarding } from '@/lib/actions';
import { getOrganization, listPayouts, PAGE_SIZE, type Organization, type Payout } from '@/lib/api';
import { formatCents, formatDate, formatUsd } from '@/lib/format';

export const metadata: Metadata = { title: 'Payouts' };

const cursor = (value: string | string[] | undefined) => {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
};

export default async function PayoutsPage({ searchParams }: PageProps<'/payouts'>) {
  const query = await searchParams;
  const before = cursor(query.before);
  const [organization, payouts] = await Promise.all([getOrganization(), listPayouts(before)]);
  const admin = organization.role === 'admin';

  return (
    <>
      <header className={ui.header}>
        <h1 className={ui.title}>Payouts</h1>
      </header>

      <section className={ui.section}>
        <div className={ui.sectionHead}>
          <div>
            <h2 className={ui.sectionTitle}>Payout account</h2>
            <p className={ui.description}>
              Earnings are paid to a bank account through Stripe Connect. Stripe verifies your identity or business once. US only for now.
            </p>
          </div>
        </div>
        <AccountPanel organization={organization} admin={admin} />
      </section>

      <section className={ui.section}>
        <div className={ui.sectionHead}>
          <div>
            <h2 className={ui.sectionTitle}>Earnings</h2>
            <p className={ui.description}>
              Calls to your functions earn their charge less a 20% platform fee. Earnings become payable 7 days after the call, and are paid
              weekly once at least $10 is payable. Smaller amounts carry over.
            </p>
          </div>
        </div>
        <div className={ui.panel}>
          <div>
            <p className={ui.stat}>{formatUsd(organization.payableMicroUsd)}</p>
            <p className={ui.note}>Earned and not yet paid out</p>
          </div>
        </div>
      </section>

      <section className={ui.section}>
        <div className={ui.sectionHead}>
          <div>
            <h2 className={ui.sectionTitle}>Payout history</h2>
            <p className={ui.description}>Transfers to your Stripe account. Stripe then pays them to your bank on its schedule. Dates are UTC.</p>
          </div>
        </div>
        <PayoutTable payouts={payouts} empty={before ? 'No older payouts.' : 'No payouts yet.'} />
        <Pagination path="/payouts" before={before} lastId={payouts.at(-1)?.id} full={payouts.length === PAGE_SIZE} />
      </section>
    </>
  );
}

function AccountPanel({ organization, admin }: { organization: Organization; admin: boolean }) {
  if (organization.payoutsEnabled) {
    return (
      <div className={ui.panel}>
        <div>
          <StatusBadge status="active" label="Ready" />
          <p className={ui.note}>Stripe can pay out to this organization.</p>
        </div>
        {admin && <ActionButton action={openPayoutDashboard} label="Open Stripe dashboard" />}
      </div>
    );
  }
  const started = organization.payoutOnboardingStarted;
  return (
    <div className={ui.panel}>
      <div>
        <StatusBadge status="pending" label={started ? 'Incomplete' : 'Not set up'} />
        <p className={ui.note}>
          {started ? 'Stripe needs more details before it can pay you.' : 'Calls to your paid functions are refused until payouts are set up.'}
        </p>
      </div>
      {admin ? (
        <ActionButton action={startPayoutOnboarding} label={started ? 'Continue in Stripe' : 'Set up payouts'} variant="primary" />
      ) : (
        <p className={ui.note}>Ask an organization admin to set up payouts.</p>
      )}
    </div>
  );
}

function PayoutTable({ payouts, empty }: { payouts: Payout[]; empty: string }) {
  if (payouts.length === 0) return <p className={ui.empty}>{empty}</p>;
  return (
    <div className={ui.tableWrap}>
      <table className={ui.table}>
        <thead>
          <tr>
            <th>Date</th>
            <th>Status</th>
            <th>Details</th>
            <th className={ui.numeric}>Amount</th>
          </tr>
        </thead>
        <tbody>
          {payouts.map((payout) => (
            <tr key={payout.id}>
              <td>{formatDate(payout.createdAt)}</td>
              <td><StatusBadge status={payout.status} /></td>
              <td>
                <span className={ui.secondary}>
                  {payout.status === 'failed'
                    ? `Returned to earnings: ${payout.failureReason ?? 'Stripe refused the transfer'}`
                    : payout.reversedCents > 0
                      ? `${formatCents(payout.reversedCents)} reversed and returned to earnings`
                      : payout.status === 'pending'
                        ? 'Sending to Stripe'
                        : '—'}
                </span>
              </td>
              <td className={ui.numeric}>{formatCents(payout.amountCents)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
