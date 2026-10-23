import Link from 'next/link';
import type { Organization } from '@/lib/api';
import ui from './ui.module.css';

/** Why the organization's nodes can't pay right now, if they can't. `onBillingPage` drops the links to the page the user is on. */
export function OrgAlerts({ organization, onBillingPage = false }: { organization: Organization; onBillingPage?: boolean }) {
  const buyCredits = onBillingPage ? null : <Link href="/billing" className={ui.textLink}>Buy credits</Link>;
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
  return null;
}
