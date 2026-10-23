import type { Receipt } from '@/lib/api';
import { formatDateTime, formatPreciseUsd, shortKey } from '@/lib/format';
import { StatusBadge } from './StatusBadge';
import ui from './ui.module.css';

/**
 * Paid calls, newest first. As the payer, the amount is what was charged (or is held); as the provider,
 * it is what the organization earned after the platform fee.
 */
export function ReceiptTable({ receipts, as, empty }: { receipts: Receipt[]; as: 'payer' | 'provider'; empty: string }) {
  if (receipts.length === 0) return <p className={ui.empty}>{empty}</p>;
  return (
    <div className={ui.tableWrap}>
      <table className={ui.table}>
        <thead>
          <tr>
            <th>Time</th>
            <th>{as === 'payer' ? 'Provider node' : 'Caller node'}</th>
            <th>Tokens</th>
            <th>Status</th>
            <th className={ui.numeric}>{as === 'payer' ? 'Charged' : 'Earned'}</th>
          </tr>
        </thead>
        <tbody>
          {receipts.map((receipt) => (
            <tr key={receipt.id}>
              <td>
                {formatDateTime(receipt.createdAt)}
                <span className={`${ui.secondary} ${ui.mono}`} title={receipt.requestId}>{receipt.requestId.slice(0, 8)}</span>
              </td>
              <td className={ui.mono} title={as === 'payer' ? receipt.providerPublicKey : receipt.payerPublicKey}>
                {shortKey(as === 'payer' ? receipt.providerPublicKey : receipt.payerPublicKey)}
              </td>
              <td>
                {receipt.inputTokens === null ? (
                  <span className={ui.secondary}>—</span>
                ) : (
                  <>
                    {receipt.inputTokens.toLocaleString('en-US')} in
                    <span className={ui.secondary}>{(receipt.outputTokens ?? 0).toLocaleString('en-US')} out</span>
                  </>
                )}
              </td>
              <td><StatusBadge status={receipt.status} /></td>
              <td className={ui.numeric}>
                <Amount receipt={receipt} as={as} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Amount({ receipt, as }: { receipt: Receipt; as: 'payer' | 'provider' }) {
  if (receipt.status === 'held') {
    return <>{formatPreciseUsd(receipt.heldMicroUsd)}<span className={ui.secondary}>held</span></>;
  }
  if (receipt.status === 'released' || receipt.amountMicroUsd === null) {
    return <span className={ui.secondary}>—</span>;
  }
  if (as === 'payer') return <>{formatPreciseUsd(receipt.amountMicroUsd)}</>;
  return (
    <>
      {formatPreciseUsd(receipt.amountMicroUsd - (receipt.feeMicroUsd ?? 0))}
      <span className={ui.secondary}>of {formatPreciseUsd(receipt.amountMicroUsd)}</span>
    </>
  );
}
