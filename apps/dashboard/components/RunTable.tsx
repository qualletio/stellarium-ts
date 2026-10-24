import type { Run } from '@/lib/api';
import { formatDateTime, formatPreciseUsd, shortKey } from '@/lib/format';
import { StatusBadge } from './StatusBadge';
import ui from './ui.module.css';

/**
 * Script runs by API clients, newest first. The amount is the script's tokens only: paid calls the script
 * made are receipts. As the payer it is what was charged; as the provider, what the organization earned
 * after the platform fee.
 */
export function RunTable({ runs, as, empty }: { runs: Run[]; as: 'payer' | 'provider'; empty: string }) {
  if (runs.length === 0) return <p className={ui.empty}>{empty}</p>;
  return (
    <div className={ui.tableWrap}>
      <table className={ui.table}>
        <thead>
          <tr>
            <th>Time</th>
            <th>{as === 'payer' ? 'Node' : 'API client'}</th>
            <th>Tokens</th>
            <th>Status</th>
            <th className={ui.numeric}>{as === 'payer' ? 'Charged' : 'Earned'}</th>
          </tr>
        </thead>
        <tbody>
          {runs.map((run) => (
            <tr key={run.id}>
              <td>
                {formatDateTime(run.createdAt)}
                <span className={`${ui.secondary} ${ui.mono}`} title={run.runId}>{run.runId.slice(0, 8)}</span>
              </td>
              <td className={ui.mono} title={as === 'payer' ? run.nodePublicKey : run.clientId}>
                {as === 'payer' ? shortKey(run.nodePublicKey) : run.clientId}
              </td>
              <td>
                {run.tokens === null ? <span className={ui.secondary}>—</span> : run.tokens.toLocaleString('en-US')}
                <span className={ui.secondary}>of {run.maxTokens.toLocaleString('en-US')} at most</span>
              </td>
              <td><StatusBadge status={run.status} /></td>
              <td className={ui.numeric}>
                <Amount run={run} as={as} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Amount({ run, as }: { run: Run; as: 'payer' | 'provider' }) {
  if (run.status === 'held') {
    return <>{formatPreciseUsd(run.holdMicroUsd)}<span className={ui.secondary}>held, with its calls</span></>;
  }
  if (run.status === 'released' || run.amountMicroUsd === null) {
    return <span className={ui.secondary}>{run.priceMicroUsdPerMillionTokens === 0 ? 'free' : '—'}</span>;
  }
  if (as === 'payer') return <>{formatPreciseUsd(run.amountMicroUsd)}</>;
  return (
    <>
      {formatPreciseUsd(run.amountMicroUsd - (run.feeMicroUsd ?? 0))}
      <span className={ui.secondary}>of {formatPreciseUsd(run.amountMicroUsd)}</span>
    </>
  );
}
