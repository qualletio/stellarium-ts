import type { PublicContract } from '@/lib/api';
import { formatDate, formatUsd, shortKey } from '@/lib/format';
import { StatusBadge } from './StatusBadge';
import ui from './ui.module.css';

/** What each flag means to a buyer (docs/money.md, What verification doesn't cover). */
const FLAG_TEXT: Record<PublicContract['flags'][number], string> = {
  hostResources: 'calls resources on its own host, whose answers only the host vouches for',
  unsignedProviders: "calls providers that don't sign their answers, so the operator can't check them",
  unverifiedHistory: 'read state its host kept before the operator verified its runs',
};

/** A contract version as any buyer sees it. */
export function PublicContractView({ contract }: { contract: PublicContract }) {
  return (
    <div className={ui.spacedAbove}>
      <div className={ui.cards}>
        <div className={ui.card}>
          <p className={ui.stat}>{formatUsd(contract.balanceMicroUsd)}</p>
          <p className={ui.note}>Balance</p>
        </div>
        <div className={ui.card}>
          <p className={ui.mono}>{contract.ownerOrganizationId}</p>
          <p className={ui.note}>Owner · hosted by {contract.hostOrganizationId}</p>
        </div>
        <div className={ui.card}>
          <p>{contract.payable ? <StatusBadge status="active" label="Payable" /> : 'Not payable'}</p>
          <p className={ui.note}>RequestScript {contract.requestscriptVersion}{contract.refundAllAt ? ' · refuses money' : ''}</p>
        </div>
      </div>
      {contract.flags.length > 0 && (
        <div className={ui.alertWarning}>
          <p>Before funding it, know that its verified runs show it:</p>
          <ul>
            {contract.flags.map((flag) => <li key={flag}>{FLAG_TEXT[flag]}</li>)}
          </ul>
        </div>
      )}
      <h3 className={ui.sectionTitle}>Dependencies</h3>
      {contract.dependencies.length === 0 ? (
        <p className={ui.empty}>It calls no other contract.</p>
      ) : (
        <ul>
          {contract.dependencies.map((dependency) => (
            <li key={`${dependency.nodePublicKey}:${dependency.name}@${dependency.version}`}>
              {dependency.name}@{dependency.version} <span className={ui.mono}>{shortKey(dependency.nodePublicKey)}</span>
            </li>
          ))}
        </ul>
      )}
      <h3 className={ui.sectionTitle}>Source</h3>
      <pre className={ui.mono}>{contract.source}</pre>
      <h3 className={ui.sectionTitle}>Money log</h3>
      {contract.log.length === 0 ? (
        <p className={ui.empty}>No money has moved.</p>
      ) : (
        <div className={ui.tableWrap}>
          <table className={ui.table}>
            <thead>
              <tr><th>When</th><th>What</th><th className={ui.numeric}>Amount</th></tr>
            </thead>
            <tbody>
              {contract.log.map((entry, index) => (
                <tr key={index}>
                  <td>{formatDate(entry.createdAt)}</td>
                  <td>{entry.kind.replace(/_/g, ' ')}</td>
                  <td className={ui.numeric}>{formatUsd(entry.amountMicroUsd)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
