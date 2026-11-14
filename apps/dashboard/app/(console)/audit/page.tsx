import type { Metadata } from 'next';
import ui from '@/components/ui.module.css';
import { listAudit } from '@/lib/api';
import { formatDateTime } from '@/lib/format';

export const metadata: Metadata = { title: 'Audit log' };

export default async function AuditPage() {
  const entries = await listAudit();
  return (
    <>
      <header className={ui.header}>
        <h1 className={ui.title}>Audit log</h1>
      </header>
      <section className={ui.section}>
        <div className={ui.sectionHead}>
          <div>
            <h2 className={ui.sectionTitle}>What the operator recorded about this organization</h2>
            <p className={ui.description}>
              Every staff action about the organization, and everything the operator did on its own, such as verification reviews and
              fraud findings. The log is append-only. Bans and raised limits needed two staff members.
            </p>
          </div>
        </div>
        {entries.length === 0 ? (
          <p className={ui.empty}>Nothing has been recorded about this organization.</p>
        ) : (
          <div className={ui.tableWrap}>
            <table className={ui.table}>
              <thead>
                <tr><th>When</th><th>Who</th><th>What</th><th>Details</th></tr>
              </thead>
              <tbody>
                {entries.map((entry) => (
                  <tr key={entry.id}>
                    <td>{formatDateTime(entry.createdAt)}</td>
                    <td>{entry.actor}</td>
                    <td>{entry.action.replace(/_/g, ' ')}</td>
                    <td className={ui.mono}>{typeof entry.details.reason === 'string' ? entry.details.reason : JSON.stringify(entry.details)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </>
  );
}
