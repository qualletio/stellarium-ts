import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { RefundAllButton } from '@/components/RefundAllButton';
import ui from '@/components/ui.module.css';
import { getContractLog, getOrganization, getPublicContract, listContracts } from '@/lib/api';
import { formatDateTime, formatUsd } from '@/lib/format';
import { PublicContractView } from '@/components/PublicContractView';

export const metadata: Metadata = { title: 'Contract' };

export default async function ContractPage({ params }: { params: Promise<{ id: string }> }) {
  const id = Number((await params).id);
  const [organization, contracts] = await Promise.all([getOrganization(), listContracts()]);
  const contract = contracts.find((candidate) => candidate.id === id);
  if (!contract) notFound();
  const [published, log] = await Promise.all([getPublicContract(contract.nodePublicKey, `${contract.name}@${contract.version}`), getContractLog(id)]);

  return (
    <>
      <header className={ui.header}>
        <h1 className={ui.title}>{contract.name}@{contract.version}</h1>
        <div className={ui.actions}>
          <Link href="/contracts" className={ui.textLink}>All contracts</Link>
          {organization.admin && contract.payable && !contract.refundAllAt && contract.balanceMicroUsd > 0 && <RefundAllButton id={contract.id} />}
        </div>
      </header>

      {published && (
        <section className={ui.section}>
          <h2 className={ui.sectionTitle}>As buyers see it</h2>
          <PublicContractView contract={published} />
        </section>
      )}

      <section className={ui.section}>
        <div className={ui.sectionHead}>
          <div>
            <h2 className={ui.sectionTitle}>Money log</h2>
            <p className={ui.description}>Every movement of the version&apos;s money, with whose funding it was. Buyers see the amounts, without funders.</p>
          </div>
        </div>
        {log.length === 0 ? (
          <p className={ui.empty}>No money has moved.</p>
        ) : (
          <div className={ui.tableWrap}>
            <table className={ui.table}>
              <thead>
                <tr><th>When</th><th>What</th><th>Funder</th><th>Counterparty</th><th className={ui.numeric}>Amount</th></tr>
              </thead>
              <tbody>
                {log.map((entry) => (
                  <tr key={entry.id}>
                    <td>{formatDateTime(entry.createdAt)}</td>
                    <td>{entry.kind.replace(/_/g, ' ')}</td>
                    <td className={ui.mono}>{entry.funderOrganizationId}</td>
                    <td className={ui.mono}>{entry.counterpartyOrganizationId ?? (entry.counterpartyContractId ? `contract ${entry.counterpartyContractId}` : '—')}</td>
                    <td className={ui.numeric}>{formatUsd(entry.amountMicroUsd)}</td>
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
