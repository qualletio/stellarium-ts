import type { Metadata } from 'next';
import { CopyButton } from '@/components/CopyButton';
import { EnrollmentForm } from '@/components/EnrollmentForm';
import { ListingForm } from '@/components/ListingForm';
import { RevokeButton } from '@/components/RevokeButton';
import { StatusBadge } from '@/components/StatusBadge';
import ui from '@/components/ui.module.css';
import { revokeNodeAction } from '@/lib/actions';
import { getOrganization, listNodes } from '@/lib/api';
import { formatDate, formatTokenPrice, shortKey } from '@/lib/format';

export const metadata: Metadata = { title: 'Nodes' };

export default async function NodesPage() {
  const [organization, nodes] = await Promise.all([getOrganization(), listNodes()]);
  const admin = organization.admin;
  const active = nodes.filter((node) => !node.revokedAt);

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
                  <th>Listing</th>
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
                      {node.listed ? formatTokenPrice(node.priceMicroUsdPerMillionTokens) : <span className={ui.secondary}>Not listed</span>}
                    </td>
                    <td>
                      {node.revokedAt ? <StatusBadge status="revoked" /> : <StatusBadge status="active" />}
                    </td>
                    {admin && <td className={ui.numeric}>{!node.revokedAt && <RevokeButton action={revokeNodeAction} name="publicKey" value={node.publicKey} />}</td>}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {active.length > 0 && (
        <section className={ui.section}>
          <div className={ui.sectionHead}>
            <div>
              <h2 className={ui.sectionTitle}>Listings</h2>
              <p className={ui.description}>
                A listed node shows on Explore, and other organizations can create API clients that run scripts on it. They pay your price
                for each million script tokens their runs execute, plus your paid functions' prices. You earn both less the 20% platform fee.
                Your own API clients always run free. Listing checks that the node&apos;s URL answers with its key.
              </p>
            </div>
          </div>
          {admin
            ? active.map((node) => <ListingForm key={node.publicKey} node={node} />)
            : <p className={ui.note}>Only organization admins can list nodes.</p>}
        </section>
      )}
    </>
  );
}
