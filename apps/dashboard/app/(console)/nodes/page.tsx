import type { Metadata } from 'next';
import { CopyButton } from '@/components/CopyButton';
import { EnrollmentForm } from '@/components/EnrollmentForm';
import { RevokeButton } from '@/components/RevokeButton';
import { StatusBadge } from '@/components/StatusBadge';
import ui from '@/components/ui.module.css';
import { getOrganization, listNodes } from '@/lib/api';
import { formatDate, shortKey } from '@/lib/format';

export const metadata: Metadata = { title: 'Nodes' };

export default async function NodesPage() {
  const [organization, nodes] = await Promise.all([getOrganization(), listNodes()]);
  const admin = organization.admin;

  return (
    <>
      <header className={ui.header}>
        <h1 className={ui.title}>Nodes</h1>
      </header>

      <section className={ui.section}>
        <div className={ui.sectionHead}>
          <div>
            <h2 className={ui.sectionTitle}>Enroll a node</h2>
            <p className={ui.description}>
              An enrolled node pays for calls from your balance, and is paid into your earnings for its paid functions. Create a token, then
              start the node with <code>ENROLLMENT_TOKEN</code> set. Tokens work once and expire after 24 hours.
            </p>
          </div>
        </div>
        {admin ? <EnrollmentForm /> : <p className={ui.note}>Only organization admins can enroll nodes.</p>}
      </section>

      <section className={ui.section}>
        <div className={ui.sectionHead}>
          <div>
            <h2 className={ui.sectionTitle}>Enrolled nodes</h2>
            <p className={ui.description}>
              Nodes are identified by their signing public key. A revoked node can neither pay nor be paid, and its key can't be enrolled again.
            </p>
          </div>
        </div>
        {nodes.length === 0 ? (
          <p className={ui.empty}>No nodes enrolled yet.</p>
        ) : (
          <div className={ui.tableWrap}>
            <table className={ui.table}>
              <thead>
                <tr>
                  <th>Node</th>
                  <th>Public key</th>
                  <th>Enrolled</th>
                  <th>Status</th>
                  {admin && <th aria-label="Actions" />}
                </tr>
              </thead>
              <tbody>
                {nodes.map((node) => (
                  <tr key={node.publicKey}>
                    <td>{node.label ?? <span className={ui.secondary}>Unlabeled</span>}</td>
                    <td>
                      <span className={ui.actions}>
                        <span className={ui.mono} title={node.publicKey}>{shortKey(node.publicKey)}</span>
                        <CopyButton value={node.publicKey} />
                      </span>
                    </td>
                    <td>{formatDate(node.createdAt)}</td>
                    <td>
                      {node.revokedAt ? <StatusBadge status="revoked" /> : <StatusBadge status="active" />}
                    </td>
                    {admin && <td className={ui.numeric}>{!node.revokedAt && <RevokeButton publicKey={node.publicKey} />}</td>}
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
