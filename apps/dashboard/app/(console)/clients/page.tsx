import type { Metadata } from 'next';
import Link from 'next/link';
import { ClientForm, type ClientNodeOption } from '@/components/ClientForm';
import { ClientLimitsForm } from '@/components/ClientLimitsForm';
import { RevokeButton } from '@/components/RevokeButton';
import { StatusBadge } from '@/components/StatusBadge';
import ui from '@/components/ui.module.css';
import { revokeClientAction } from '@/lib/actions';
import { getOrganization, listClients, listListings, listNodes } from '@/lib/api';
import { formatDate, formatPreciseUsd, formatTokenPrice, shortKey } from '@/lib/format';
import { publicOperatorUrl } from '@/lib/site';

export const metadata: Metadata = { title: 'API clients' };

export default async function ClientsPage({ searchParams }: PageProps<'/clients'>) {
  const query = await searchParams;
  const [organization, clients, nodes, listings] = await Promise.all([getOrganization(), listClients(), listNodes(), listListings()]);
  const admin = organization.admin;

  // The organization's own nodes run free, listed or not. Other organizations' nodes must be listed.
  const options: ClientNodeOption[] = [
    ...nodes.filter((node) => !node.revokedAt).map((node) => ({
      publicKey: node.publicKey,
      label: `${node.name ?? node.label ?? shortKey(node.publicKey)} · free`,
      baseUrl: node.baseUrl,
      group: 'Your nodes' as const,
    })),
    ...listings.filter((listing) => listing.organizationId !== organization.id).map((listing) => ({
      publicKey: listing.publicKey,
      label: `${listing.name ?? shortKey(listing.publicKey)} (${listing.organizationName}) · ${formatTokenPrice(listing.priceMicroUsdPerMillionTokens)}`,
      baseUrl: listing.baseUrl,
      group: 'Listed nodes' as const,
    })),
  ];
  const nodeNames = new Map(options.map((option) => [option.publicKey, option.label.split(' · ')[0]!]));
  const defaultNode = typeof query.node === 'string' && options.some((option) => option.publicKey === query.node) ? query.node : undefined;

  return (
    <>
      <header className={ui.header}>
        <h1 className={ui.title}>API clients</h1>
        <Link href="/explore" className={ui.buttonSecondary}>Explore nodes</Link>
      </header>

      <section className={ui.section}>
        <div className={ui.sectionHead}>
          <div>
            <h2 className={ui.sectionTitle}>Create an API client</h2>
            <p className={ui.description}>
              An API client runs scripts on one node, without running a node yourself or knowing the node&apos;s API key. It exchanges its
              secret for a run token, which the node accepts on <code>POST /v1/run</code>. Runs on your own nodes are free. Runs on another
              organization&apos;s listed node are paid from your balance, up to the client&apos;s maximum per run and monthly cap.
            </p>
          </div>
        </div>
        {!admin ? (
          <p className={ui.note}>Only organization admins can create API clients.</p>
        ) : options.length === 0 ? (
          <p className={ui.note}>
            There is no node to create a client for yet. <Link href="/nodes" className={ui.textLink}>Enroll a node</Link>, or wait for one to
            be listed on <Link href="/explore" className={ui.textLink}>Explore</Link>.
          </p>
        ) : (
          <ClientForm nodes={options} defaultNode={defaultNode} operatorUrl={publicOperatorUrl()} />
        )}
      </section>

      <section className={ui.section}>
        <div className={ui.sectionHead}>
          <div>
            <h2 className={ui.sectionTitle}>Your API clients</h2>
            <p className={ui.description}>This month&apos;s spend counts runs since the 1st (UTC), including what is still held for runs in progress.</p>
          </div>
        </div>
        {clients.length === 0 ? (
          <p className={ui.empty}>No API clients yet.</p>
        ) : (
          <div className={ui.tableWrap}>
            <table className={ui.table}>
              <thead>
                <tr>
                  <th>Client</th>
                  <th>Node</th>
                  <th>Limits</th>
                  <th>Created</th>
                  <th>Status</th>
                  <th className={ui.numeric}>This month</th>
                  {admin && <th aria-label="Actions" />}
                </tr>
              </thead>
              <tbody>
                {clients.map((client) => (
                  <tr key={client.id}>
                    <td>
                      {client.label ?? <span className={ui.secondary}>Unlabeled</span>}
                      <span className={`${ui.secondary} ${ui.mono}`}>{client.id}</span>
                    </td>
                    <td>
                      {nodeNames.get(client.nodePublicKey) ?? <span className={ui.secondary}>No longer listed</span>}
                      <span className={`${ui.secondary} ${ui.mono}`} title={client.nodePublicKey}>{shortKey(client.nodePublicKey)}</span>
                    </td>
                    <td>
                      <ClientLimitsForm client={client} editable={admin && !client.revokedAt} />
                    </td>
                    <td>{formatDate(client.createdAt)}</td>
                    <td>{client.revokedAt ? <StatusBadge status="revoked" /> : <StatusBadge status="active" />}</td>
                    <td className={ui.numeric}>{formatPreciseUsd(client.monthToDateMicroUsd)}</td>
                    {admin && <td className={ui.numeric}>{!client.revokedAt && <RevokeButton action={revokeClientAction} name="id" value={client.id} />}</td>}
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
