import type { Metadata } from 'next';
import { InvitationActions, InviteForm, LeaveButton, MemberActions, RenameForm } from '@/components/OrganizationSettings';
import { StatusBadge } from '@/components/StatusBadge';
import ui from '@/components/ui.module.css';
import { WebhookForm } from '@/components/WebhookForm';
import { getFullOrganization, getOrganization, getSession, listNotifications, type Notification } from '@/lib/api';
import { formatDate, formatDateTime, formatUsd } from '@/lib/format';

export const metadata: Metadata = { title: 'Organization' };

const ROLE_LABELS: Record<string, string> = { owner: 'Owner', admin: 'Admin', member: 'Member' };
/** What a notification says, in a sentence. */
function describeNotification(notification: Notification): string {
  const details = notification.details;
  const amount = typeof details.amountMicroUsd === 'number' ? formatUsd(details.amountMicroUsd) : undefined;
  switch (notification.kind) {
    case 'funding_returned': {
      const why: Record<string, string> = {
        expiry_refund: 'its time limit passed',
        refund_all: 'its owner refunded everyone',
        fraud_reversal: 'fraud was found in a run that spent it',
        closed: 'its host closed',
      };
      const from = typeof details.contract === 'string' ? ` from ${details.contract}` : '';
      return `${amount ?? 'Funding'} came back to your balance${from} because ${why[String(details.reason)] ?? String(details.reason).replace(/_/g, ' ')}.`;
    }
    case 'dispute_recovered':
      return `${amount ?? 'Money'} was taken from your contract funding to cover a card dispute or refund.`;
    case 'organization_closed':
      return `The organization was closed${typeof details.refundedMicroUsd === 'number' ? `, and ${formatUsd(details.refundedMicroUsd)} of contract funding came back first` : ''}.`;
    default:
      return notification.kind.replace(/_/g, ' ');
  }
}

const roleLabel = (role: string | null) => (role ?? 'member').split(',').map((name) => ROLE_LABELS[name.trim()] ?? name).join(', ');

/** The organization's name, members and invitations. Owners and admins move money and manage nodes; members view. */
export default async function SettingsPage() {
  const [organization, full, session, notifications] = await Promise.all([getOrganization(), getFullOrganization(), getSession(), listNotifications()]);
  const admin = organization.admin;
  const members = full?.members ?? [];
  const invitations = (full?.invitations ?? []).filter((invitation) => invitation.status === 'pending');

  return (
    <>
      <header className={ui.header}>
        <h1 className={ui.title}>Organization</h1>
      </header>

      <section className={ui.section}>
        <div className={ui.sectionHead}>
          <div>
            <h2 className={ui.sectionTitle}>Name</h2>
            <p className={ui.description}>Shown to your team here, and on Stripe receipts.</p>
          </div>
        </div>
        {admin ? <RenameForm name={organization.name} /> : <p>{organization.name}</p>}
      </section>

      <section className={ui.section}>
        <div className={ui.sectionHead}>
          <div>
            <h2 className={ui.sectionTitle}>Members</h2>
            <p className={ui.description}>Owners and admins buy credits, set up payouts and manage nodes. Members can view everything.</p>
          </div>
        </div>
        <div className={ui.tableWrap}>
          <table className={ui.table}>
            <thead>
              <tr>
                <th>Name</th>
                <th>Role</th>
                <th>Joined</th>
                <th aria-label="Actions" />
              </tr>
            </thead>
            <tbody>
              {members.map((member) => {
                const self = member.user.id === session?.user.id;
                return (
                  <tr key={member.id}>
                    <td>
                      {member.user.name}
                      {self && ' (you)'}
                      <span className={ui.secondary}>{member.user.email}</span>
                    </td>
                    <td>{roleLabel(member.role)}</td>
                    <td>{formatDate(member.createdAt)}</td>
                    <td className={ui.numeric}>
                      {self ? (
                        <LeaveButton organizationId={organization.id} />
                      ) : (
                        admin && member.role !== 'owner' && <MemberActions memberId={member.id} role={member.role} />
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>

      <section className={ui.section}>
        <div className={ui.sectionHead}>
          <div>
            <h2 className={ui.sectionTitle}>Verification</h2>
            <p className={ui.description}>
              Until we verify who is behind an organization, the money it can attach to contracts each month is limited. To get verified, contact support.
            </p>
          </div>
        </div>
        <p>
          <StatusBadge status={organization.identityVerified ? 'verified' : 'pending'} label={organization.identityVerified ? 'verified' : 'not verified'} />{' '}
          {organization.identityVerified ? 'Identity verified.' : 'Not verified yet.'}
        </p>
      </section>

      <section className={ui.section}>
        <div className={ui.sectionHead}>
          <div>
            <h2 className={ui.sectionTitle}>Notifications</h2>
            <p className={ui.description}>
              We email your owners when contract funding comes back to you or is taken for a dispute. We can also post each notification to
              a webhook, signed with the operator&apos;s key in the <code>Stellarium-Signature</code> header.
            </p>
          </div>
        </div>
        {admin ? <WebhookForm url={organization.webhookUrl} /> : <p>{organization.webhookUrl ?? 'No webhook.'}</p>}
        {notifications.length === 0 ? <p className={`${ui.empty} ${ui.spacedAbove}`}>No notifications yet.</p> : (
          <div className={`${ui.tableWrap} ${ui.spacedAbove}`}>
            <table className={ui.table}>
              <thead>
                <tr>
                  <th>When</th>
                  <th>What happened</th>
                  {organization.webhookUrl && <th>Webhook</th>}
                </tr>
              </thead>
              <tbody>
                {notifications.map((notification) => (
                  <tr key={notification.id}>
                    <td>{formatDateTime(notification.createdAt)}</td>
                    <td>{describeNotification(notification)}</td>
                    {organization.webhookUrl && (
                      <td>{notification.webhookDeliveredAt ? 'Delivered' : notification.webhookAttempts > 0 ? `Retrying (${notification.webhookAttempts} tries)` : 'Waiting'}</td>
                    )}
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
            <h2 className={ui.sectionTitle}>Invitations</h2>
            <p className={ui.description}>We email each invitation. It expires after 48 hours, and must be accepted by the invited address.</p>
          </div>
        </div>
        {admin && <InviteForm />}
        {invitations.length > 0 && (
          <div className={`${ui.tableWrap} ${ui.spacedAbove}`}>
            <table className={ui.table}>
              <thead>
                <tr>
                  <th>Email</th>
                  <th>Role</th>
                  <th>Expires</th>
                  <th>Status</th>
                  {admin && <th aria-label="Actions" />}
                </tr>
              </thead>
              <tbody>
                {invitations.map((invitation) => (
                  <tr key={invitation.id}>
                    <td>{invitation.email}</td>
                    <td>{roleLabel(invitation.role)}</td>
                    <td>{formatDate(invitation.expiresAt)}</td>
                    <td><StatusBadge status="pending" /></td>
                    {admin && <td className={ui.numeric}><InvitationActions invitationId={invitation.id} /></td>}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {!admin && invitations.length === 0 && <p className={ui.empty}>No pending invitations.</p>}
      </section>
    </>
  );
}
