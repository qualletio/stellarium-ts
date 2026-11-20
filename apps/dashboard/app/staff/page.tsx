import type { Metadata } from 'next';
import { StaffForm } from '@/components/StaffForm';
import ui from '@/components/ui.module.css';
import { formatDateTime, formatUsd, shortKey } from '@/lib/format';
import { type Alert, listActions, listAlerts, listAppeals, listFraudCases, listPaymentFlags, listReviews, listStaffAudit, type StaffAction } from '@/lib/staff';
import { approveAction, proposeAction, publishCheckpoint, rejectAction, staffSignOut } from '@/lib/staffActions';
import styles from './staff.module.css';

export const metadata: Metadata = { title: 'Console' };

/** What a staff action does, in a few words. */
function describe(action: StaffAction): string {
  const payload = action.payload;
  switch (action.kind) {
    case 'ban': return `Ban ${String(payload.organizationId)}`;
    case 'lift_ban': return `Lift the ban on ${String(payload.organizationId)}`;
    case 'uphold_appeal': return `Uphold the ban on ${String(payload.organizationId)}`;
    case 'overturn_appeal': return `Overturn the ban on ${String(payload.organizationId)}`;
    case 'decide_review': return `Review ${String(payload.reviewId)}: ${payload.decision === 'host_fault' ? 'the host is at fault' : 'the runtime is at fault'}`;
    case 'set_node_limits': return `Set limits on node ${shortKey(String(payload.publicKey))}: ${JSON.stringify(payload.limits)}`;
    case 'verify_identity': return `Record ${String(payload.organizationId)}'s identity as verified`;
    case 'block_sanctions': return `Block ${String(payload.organizationId)} for sanctions`;
    case 'clear_sanctions': return `Clear ${String(payload.organizationId)}'s sanctions block`;
    case 'close_organization': return `Close ${String(payload.organizationId)}, refunding its contract funding`;
    case 'clear_payment_flag': return `Clear payment flag ${String(payload.flagId)}`;
    case 'acknowledge_alert': return `Acknowledge alert ${String(payload.alertId)}`;
  }
}

/** What an alert found, in a sentence. */
function describeAlert(alert: Alert): string {
  const details = alert.details;
  const usd = (name: string) => typeof details[name] === 'number' ? formatUsd(details[name] as number) : '?';
  switch (alert.kind) {
    case 'self_payment': return `Contracts on this node paid its own organization ${usd('paidMicroUsd')} in the last 24 hours.`;
    case 'outflow_jump': return `Contracts on this node paid out ${usd('todayMicroUsd')} today, against ${usd('dailyAverageMicroUsd')} a day the week before.`;
    case 'release_rate': return `${String(details.dropped)} of the last ${String(details.settled)} money trees on this node were dropped.`;
  }
}

export default async function StaffConsolePage() {
  const [reviews, proposed, appeals, fraudCases, alerts, flags, audit] = await Promise.all([
    listReviews(), listActions('proposed'), listAppeals(), listFraudCases(), listAlerts(), listPaymentFlags(), listStaffAudit(),
  ]);
  return (
    <>
      <div className={styles.bar}>
        <h1 className={ui.title}>Staff console</h1>
        <div className={ui.actions}>
          <StaffForm action={publishCheckpoint} label="Publish a checkpoint" />
          <form action={staffSignOut}><button type="submit" className={ui.buttonSecondary}>Sign out</button></form>
        </div>
      </div>

      <section className={ui.section}>
        <div className={ui.sectionHead}>
          <div>
            <h2 className={ui.sectionTitle}>Waiting for approval</h2>
            <p className={ui.description}>A second staff member must approve these. You can&apos;t approve your own.</p>
          </div>
        </div>
        {proposed.length === 0 ? <p className={ui.empty}>Nothing is waiting.</p> : (
          <div className={ui.tableWrap}>
            <table className={ui.table}>
              <thead><tr><th>Action</th><th>Reason</th><th>Proposed</th><th /></tr></thead>
              <tbody>
                {proposed.map((action) => (
                  <tr key={action.id}>
                    <td>{describe(action)}</td>
                    <td>{action.reason}</td>
                    <td>{action.proposedBy}, {formatDateTime(action.createdAt)}<span className={ui.secondary}>Approved by {action.approvedBy ?? 'nobody yet'}</span></td>
                    <td className={ui.actions}>
                      <StaffForm action={approveAction} fields={{ id: action.id }} label="Approve" variant="primary" />
                      <StaffForm action={rejectAction} fields={{ id: action.id }} label="Reject" />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className={ui.section}>
        <div className={ui.sectionHead}>
          <div>
            <h2 className={ui.sectionTitle}>Verification reviews</h2>
            <p className={ui.description}>
              Replays that disagreed without proving anything. The tree&apos;s money waits, and its host is suspended. Finding the host at
              fault is fraud, and needs a second staff member; finding the runtime at fault releases the money and restores the host.
            </p>
          </div>
        </div>
        {reviews.length === 0 ? <p className={ui.empty}>No open reviews.</p> : (
          <div className={ui.tableWrap}>
            <table className={ui.table}>
              <thead><tr><th>Review</th><th>Node</th><th>What disagreed</th><th>Decision</th></tr></thead>
              <tbody>
                {reviews.map((review) => (
                  <tr key={review.id}>
                    <td>{review.id}<span className={ui.secondary}>{formatDateTime(review.createdAt)}</span></td>
                    <td className={ui.mono}>{shortKey(review.nodePublicKey)}</td>
                    <td>{review.reason}</td>
                    <td>
                      <StaffForm action={proposeAction} fields={{ kind: 'decide_review', reviewId: review.id, decision: 'runtime_fault' }} label="Runtime at fault">
                        <input className={ui.input} name="reason" placeholder="Reason" required />
                      </StaffForm>
                      <StaffForm action={proposeAction} fields={{ kind: 'decide_review', reviewId: review.id, decision: 'host_fault' }} label="Host at fault" variant="danger">
                        <input className={ui.input} name="reason" placeholder="Reason" required />
                      </StaffForm>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className={ui.section}>
        <div className={ui.sectionHead}>
          <div>
            <h2 className={ui.sectionTitle}>Appeals</h2>
            <p className={ui.description}>Upholding a ban revokes the organization&apos;s nodes for good, and needs a second staff member. Overturning lifts it.</p>
          </div>
        </div>
        {appeals.length === 0 ? <p className={ui.empty}>No open appeals.</p> : (
          <div className={ui.tableWrap}>
            <table className={ui.table}>
              <thead><tr><th>Organization</th><th>Statement</th><th>Decision</th></tr></thead>
              <tbody>
                {appeals.map((appeal) => (
                  <tr key={appeal.id}>
                    <td className={ui.mono}>{appeal.organizationId}<span className={ui.secondary}>{formatDateTime(appeal.createdAt)}</span></td>
                    <td>{appeal.statement}</td>
                    <td>
                      <StaffForm action={proposeAction} fields={{ kind: 'overturn_appeal', organizationId: appeal.organizationId }} label="Overturn">
                        <input className={ui.input} name="reason" placeholder="Reason" required />
                      </StaffForm>
                      <StaffForm action={proposeAction} fields={{ kind: 'uphold_appeal', organizationId: appeal.organizationId }} label="Uphold" variant="danger">
                        <input className={ui.input} name="reason" placeholder="Reason" required />
                      </StaffForm>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className={ui.section}>
        <div className={ui.sectionHead}>
          <div>
            <h2 className={ui.sectionTitle}>Alerts</h2>
            <p className={ui.description}>Unusual money movement on a node&apos;s contracts. Nothing is stopped: look, then acknowledge, or propose a ban or limits.</p>
          </div>
        </div>
        {alerts.length === 0 ? <p className={ui.empty}>No open alerts.</p> : (
          <div className={ui.tableWrap}>
            <table className={ui.table}>
              <thead><tr><th>When</th><th>Node</th><th>What</th><th /></tr></thead>
              <tbody>
                {alerts.map((alert) => (
                  <tr key={alert.id}>
                    <td>{formatDateTime(alert.createdAt)}</td>
                    <td className={ui.mono}>{shortKey(alert.nodePublicKey)}<span className={ui.secondary}>{alert.organizationId ?? '—'}</span></td>
                    <td>{describeAlert(alert)}</td>
                    <td>
                      <StaffForm action={proposeAction} fields={{ kind: 'acknowledge_alert', alertId: alert.id }} label="Acknowledge">
                        <input className={ui.input} name="reason" placeholder="What you found" required />
                      </StaffForm>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className={ui.section}>
        <div className={ui.sectionHead}>
          <div>
            <h2 className={ui.sectionTitle}>Payment flags</h2>
            <p className={ui.description}>
              Contract payments to a payee that shares a member or an email domain with its funder. Payouts hold the payee until each flag is cleared.
            </p>
          </div>
        </div>
        {flags.length === 0 ? <p className={ui.empty}>No open flags.</p> : (
          <div className={ui.tableWrap}>
            <table className={ui.table}>
              <thead><tr><th>When</th><th>Funder</th><th>Payee</th><th>Why</th><th /></tr></thead>
              <tbody>
                {flags.map((flag) => (
                  <tr key={flag.id}>
                    <td>{formatDateTime(flag.createdAt)}</td>
                    <td className={ui.mono}>{flag.funderOrganizationId}</td>
                    <td className={ui.mono}>{flag.payeeOrganizationId}</td>
                    <td>{flag.reason}</td>
                    <td>
                      <StaffForm action={proposeAction} fields={{ kind: 'clear_payment_flag', flagId: flag.id }} label="Clear">
                        <input className={ui.input} name="reason" placeholder="Reason" required />
                      </StaffForm>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className={ui.section}>
        <h2 className={ui.sectionTitle}>Fraud cases</h2>
        {fraudCases.length === 0 ? <p className={ui.empty}>No fraud found.</p> : (
          <div className={ui.tableWrap}>
            <table className={ui.table}>
              <thead><tr><th>When</th><th>Organization</th><th>Finding</th><th className={ui.numeric}>Returned</th><th className={ui.numeric}>From the fraudster</th><th className={ui.numeric}>Platform covered</th></tr></thead>
              <tbody>
                {fraudCases.map((fraudCase) => (
                  <tr key={fraudCase.id}>
                    <td>{formatDateTime(fraudCase.createdAt)}</td>
                    <td className={ui.mono}>{fraudCase.organizationId}</td>
                    <td>{fraudCase.kind === 'proof' ? 'Proof' : 'Review'}: {fraudCase.reason}</td>
                    <td className={ui.numeric}>{formatUsd(fraudCase.reversedMicroUsd)}</td>
                    <td className={ui.numeric}>{formatUsd(fraudCase.recoveredMicroUsd)}</td>
                    <td className={ui.numeric}>{formatUsd(fraudCase.shortfallMicroUsd)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className={ui.section}>
        <h2 className={ui.sectionTitle}>Propose</h2>
        <div className={ui.cards}>
          <div className={ui.card}>
            <p className={ui.linkCardTitle}>Ban an organization</p>
            <StaffForm action={proposeAction} fields={{ kind: 'ban' }} label="Propose ban" variant="danger">
              <input className={ui.input} name="organizationId" placeholder="org_…" required />
              <input className={ui.input} name="reason" placeholder="Reason" required />
            </StaffForm>
          </div>
          <div className={ui.card}>
            <p className={ui.linkCardTitle}>An organization&apos;s standing</p>
            <p className={ui.description}>Clearing a sanctions block or closing an organization needs a second staff member. Closing refunds its contract funding first.</p>
            <StaffForm action={proposeAction} fields={{ kind: 'verify_identity' }} label="Record identity verified">
              <input className={ui.input} name="organizationId" placeholder="org_…" required />
              <input className={ui.input} name="reason" placeholder="How it was verified" required />
            </StaffForm>
            <StaffForm action={proposeAction} fields={{ kind: 'block_sanctions' }} label="Block for sanctions" variant="danger">
              <input className={ui.input} name="organizationId" placeholder="org_…" required />
              <input className={ui.input} name="reason" placeholder="Reason" required />
            </StaffForm>
            <StaffForm action={proposeAction} fields={{ kind: 'clear_sanctions' }} label="Propose clearing sanctions">
              <input className={ui.input} name="organizationId" placeholder="org_…" required />
              <input className={ui.input} name="reason" placeholder="Reason" required />
            </StaffForm>
            <StaffForm action={proposeAction} fields={{ kind: 'close_organization' }} label="Propose closing" variant="danger">
              <input className={ui.input} name="organizationId" placeholder="org_…" required />
              <input className={ui.input} name="reason" placeholder="Reason" required />
            </StaffForm>
          </div>
          <div className={ui.card}>
            <p className={ui.linkCardTitle}>Set a node&apos;s money limits</p>
            <StaffForm action={proposeAction} fields={{ kind: 'set_node_limits' }} label="Propose limits">
              <input className={ui.input} name="publicKey" placeholder="Node public key" required />
              <input className={ui.input} name="maxContractBalanceMicroUsd" placeholder="Contract balance limit, $" inputMode="decimal" />
              <input className={ui.input} name="maxApiKeyRunValueMicroUsd" placeholder="API-key run attach limit, $" inputMode="decimal" />
              <input className={ui.input} name="monthlyApiKeyValueCapMicroUsd" placeholder="API-key monthly attach cap, $" inputMode="decimal" />
              <input className={ui.input} name="reason" placeholder="Reason" required />
            </StaffForm>
          </div>
        </div>
      </section>

      <section className={ui.section}>
        <h2 className={ui.sectionTitle}>Audit log</h2>
        <div className={ui.tableWrap}>
          <table className={ui.table}>
            <thead><tr><th>When</th><th>Who</th><th>What</th><th>Organization</th></tr></thead>
            <tbody>
              {audit.map((entry) => (
                <tr key={entry.id}>
                  <td>{formatDateTime(entry.createdAt)}</td>
                  <td>{entry.actor}</td>
                  <td>{entry.action.replace(/_/g, ' ')}</td>
                  <td className={ui.mono}>{entry.organizationId ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </>
  );
}
