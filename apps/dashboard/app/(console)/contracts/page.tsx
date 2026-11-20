import type { Metadata } from 'next';
import Link from 'next/link';
import { RefundAllButton } from '@/components/RefundAllButton';
import { PublicContractView } from '@/components/PublicContractView';
import { StatusBadge } from '@/components/StatusBadge';
import ui from '@/components/ui.module.css';
import { getOrganization, getPublicContract, listContracts } from '@/lib/api';
import { formatDate, formatUsd, shortKey } from '@/lib/format';

export const metadata: Metadata = { title: 'Contracts' };

const text = (value: string | string[] | undefined) => (typeof value === 'string' ? value.trim() : '');

export default async function ContractsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const query = await searchParams;
  const node = text(query.node);
  const ref = text(query.ref);
  const [organization, contracts, lookedUp] = await Promise.all([
    getOrganization(),
    listContracts(),
    node && ref ? getPublicContract(node, ref) : Promise.resolve(undefined),
  ]);

  return (
    <>
      <header className={ui.header}>
        <h1 className={ui.title}>Contracts</h1>
      </header>

      <section className={ui.section}>
        <div className={ui.sectionHead}>
          <div>
            <h2 className={ui.sectionTitle}>Your contract versions</h2>
            <p className={ui.description}>
              Versions your API clients or nodes deployed, as the operator registered them. A payable version holds money for conditional
              payouts, which its funders get back after 14 days if it doesn&apos;t pay them out. Refund all returns a version&apos;s money to its
              funders, and it refuses money from then on.
            </p>
          </div>
        </div>
        {contracts.length === 0 ? (
          <p className={ui.empty}>No contract versions yet.</p>
        ) : (
          <div className={ui.tableWrap}>
            <table className={ui.table}>
              <thead>
                <tr>
                  <th>Contract</th>
                  <th>Node</th>
                  <th className={ui.numeric}>Balance</th>
                  <th>Registered</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {contracts.map((contract) => (
                  <tr key={contract.id}>
                    <td>
                      <Link href={`/contracts/${contract.id}`} className={ui.textLink}>{contract.name}@{contract.version}</Link>
                      <span className={ui.secondary}>
                        {contract.payable ? <StatusBadge status="active" label="Payable" /> : 'Not payable'}
                        {contract.refundAllAt && <> · <StatusBadge status="revoked" label="Refunded" /></>}
                      </span>
                    </td>
                    <td className={ui.mono}>{shortKey(contract.nodePublicKey)}</td>
                    <td className={ui.numeric}>{formatUsd(contract.balanceMicroUsd)}</td>
                    <td>{formatDate(contract.createdAt)}</td>
                    <td>{organization.admin && contract.payable && !contract.refundAllAt && contract.balanceMicroUsd > 0 && <RefundAllButton id={contract.id} />}</td>
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
            <h2 className={ui.sectionTitle}>Look up a contract</h2>
            <p className={ui.description}>
              Before funding a contract, read it as the operator registered it, never as its host describes it: its source, owner, host,
              dependencies and money log.
            </p>
          </div>
        </div>
        <form className={ui.form} method="get">
          <label className={ui.field}>
            Node public key
            <input className={ui.input} name="node" defaultValue={node} required />
          </label>
          <label className={ui.field}>
            Contract version
            <input className={ui.input} name="ref" placeholder="com.example.Job@1" defaultValue={ref} required />
          </label>
          <button type="submit" className={ui.buttonSecondary}>Look up</button>
        </form>
        {node && ref && (lookedUp ? <PublicContractView contract={lookedUp} /> : <p className={ui.empty}>The operator has no registration of {ref} on that node.</p>)}
      </section>
    </>
  );
}
