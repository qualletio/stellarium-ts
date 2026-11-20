import type { Metadata } from 'next';
import { AppealForm } from '@/components/AppealForm';
import { StatusBadge } from '@/components/StatusBadge';
import ui from '@/components/ui.module.css';
import { getBanStatus, getOrganization } from '@/lib/api';
import { formatDateTime, formatUsd, shortKey } from '@/lib/format';

export const metadata: Metadata = { title: 'Ban and appeal' };

export default async function AppealPage() {
  const [organization, ban] = await Promise.all([getOrganization(), getBanStatus()]);
  return (
    <>
      <header className={ui.header}>
        <h1 className={ui.title}>Ban and appeal</h1>
      </header>
      {!ban.banned ? (
        <section className={ui.section}>
          <p className={ui.empty}>This organization isn&apos;t banned.</p>
        </section>
      ) : (
        <>
          <section className={ui.section}>
            <div className={ui.sectionHead}>
              <div>
                <h2 className={ui.sectionTitle}>The ban</h2>
                <p className={ui.description}>
                  Banned {formatDateTime(ban.bannedAt)}. Its nodes are suspended, its API clients can&apos;t run, and nothing is paid out. The
                  organization&apos;s members can still read everything here.
                </p>
              </div>
            </div>
            {ban.reason && <p className={ui.alert}>{ban.reason}</p>}
          </section>

          <section className={ui.section}>
            <h2 className={ui.sectionTitle}>What was found</h2>
            {ban.fraudCases.length === 0 ? (
              <p className={ui.empty}>No fraud case is recorded.</p>
            ) : (
              <div className={ui.tableWrap}>
                <table className={ui.table}>
                  <thead>
                    <tr><th>When</th><th>Node</th><th>How</th><th>Finding</th><th className={ui.numeric}>Returned to payers</th></tr>
                  </thead>
                  <tbody>
                    {ban.fraudCases.map((fraudCase) => (
                      <tr key={fraudCase.id}>
                        <td>{formatDateTime(fraudCase.createdAt)}</td>
                        <td className={ui.mono}>{shortKey(fraudCase.nodePublicKey)}</td>
                        <td>{fraudCase.kind === 'proof' ? 'Proven by its receipts' : 'Found by review'}</td>
                        <td>{fraudCase.reason}</td>
                        <td className={ui.numeric}>{formatUsd(fraudCase.reversedMicroUsd)}</td>
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
                <h2 className={ui.sectionTitle}>Appeal</h2>
                <p className={ui.description}>
                  The owner can appeal once. Stellarium reviews the appeal against the run receipts. If it&apos;s overturned, the ban and the
                  suspensions are lifted; refunds already made to payers stay where they are.
                </p>
              </div>
            </div>
            {ban.appeal ? (
              <div className={ui.panel}>
                <div>
                  <StatusBadge status={ban.appeal.status === 'open' ? 'pending' : ban.appeal.status === 'overturned' ? 'active' : 'failed'} label={ban.appeal.status} />
                  <p className={ui.note}>Sent {formatDateTime(ban.appeal.createdAt)}: {ban.appeal.statement}</p>
                </div>
              </div>
            ) : organization.role === 'owner' ? (
              <AppealForm />
            ) : (
              <p className={ui.empty}>Only the organization&apos;s owner can appeal.</p>
            )}
          </section>
        </>
      )}
    </>
  );
}
