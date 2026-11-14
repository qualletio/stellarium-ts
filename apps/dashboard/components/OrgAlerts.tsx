import Link from 'next/link';
import type { Organization } from '@/lib/api';
import { formatUsd } from '@/lib/format';
import ui from './ui.module.css';

/**
 * Why the organization's nodes can't pay right now, if they can't, or else a warning about a large unspent balance.
 * `onBillingPage` drops the links to the page the user is on.
 */
export function OrgAlerts({ organization, onBillingPage = false }: { organization: Organization; onBillingPage?: boolean }) {
  const buyCredits = onBillingPage ? null : <Link href="/billing" className={ui.textLink}>Buy credits</Link>;
  if (organization.banned) {
    return (
      <p className={ui.alert}>
        This organization is banned after fraud was found in a contract run its node hosted. You can still read everything here.{' '}
        <Link href="/appeal" className={ui.textLink}>See the ban and appeal</Link>
      </p>
    );
  }
  if (organization.closed) {
    return <p className={ui.alert}>This organization is closed. You can still read everything here, but its nodes and API clients are refused.</p>;
  }
  if (organization.sanctionsBlocked) {
    return (
      <p className={ui.alert}>
        Sanctions screening matched this organization, so it can&apos;t receive contract money or payouts while we review it. Contact support.
      </p>
    );
  }
  if (organization.frozen) {
    return <p className={ui.alert}>This organization is frozen, so its nodes can't pay for calls. Contact support.</p>;
  }
  if (organization.balanceMicroUsd < 0) {
    return (
      <p className={ui.alert}>
        Your balance is negative after a refund or dispute, so your nodes can't pay for calls. Buy credits to continue. {buyCredits}
      </p>
    );
  }
  // The billing page already leads with buying credits.
  if (organization.availableMicroUsd <= 0 && !onBillingPage) {
    return (
      <p className={ui.alertWarning}>
        You have no credit available, so paid calls from your nodes are refused. {buyCredits}
      </p>
    );
  }
  if (organization.idleBalance) {
    const { amountMicroUsd, days } = organization.idleBalance;
    return (
      <p className={ui.alertWarning}>
        {formatUsd(amountMicroUsd)} of your balance comes from top-ups more than {days} days old that haven't been spent.
        Buy credits closer to when you need them. To get unused credit back, contact support.
      </p>
    );
  }
  return null;
}
