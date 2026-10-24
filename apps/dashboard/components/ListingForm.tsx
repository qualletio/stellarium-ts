'use client';

import { useActionState } from 'react';
import { updateListingAction } from '@/lib/actions';
import type { Node } from '@/lib/api';
import { formatDateTime, shortKey } from '@/lib/format';
import { StatusBadge } from './StatusBadge';
import styles from './ListingForm.module.css';
import ui from './ui.module.css';

/**
 * Edits one node's listing. A listed node accepts runs from other organizations' API clients at its price.
 * Listing it has the operator check that the URL the node reported answers with its key.
 */
export function ListingForm({ node }: { node: Node }) {
  const [state, formAction, pending] = useActionState(updateListingAction, undefined);
  return (
    <div className={styles.wrap}>
      <div className={styles.head}>
        <span className={ui.actions}>
          <strong>{node.name ?? node.label ?? 'Unnamed node'}</strong>
          <span className={ui.mono} title={node.publicKey}>{shortKey(node.publicKey)}</span>
          {node.listed ? <StatusBadge status="active" label="listed" /> : <StatusBadge status="revoked" label="not listed" />}
        </span>
        <span className={ui.note}>
          {node.baseUrl
            ? <>Serves at <span className={ui.mono}>{node.baseUrl}</span>{node.verifiedAt && <> · verified {formatDateTime(node.verifiedAt)} UTC</>}</>
            : 'Hasn\'t reported its URL. Start it with OPERATOR_URL set.'}
        </span>
      </div>
      <form action={formAction} className={ui.form}>
        <input type="hidden" name="publicKey" value={node.publicKey} />
        <label className={ui.field}>
          Name
          <input className={ui.input} name="name" defaultValue={node.name ?? node.label ?? ''} placeholder="Weather" maxLength={255} />
        </label>
        <label className={`${ui.field} ${styles.wide}`}>
          Description
          <input className={ui.input} name="description" defaultValue={node.description ?? ''} placeholder="What its scripts can call" maxLength={2048} />
        </label>
        <label className={ui.field}>
          Price per million tokens
          <span className={ui.prefixed}>
            <span className={ui.prefix}>$</span>
            <input
              className={ui.input}
              name="price"
              type="number"
              inputMode="decimal"
              min="0"
              step="0.000001"
              defaultValue={node.priceMicroUsdPerMillionTokens / 1_000_000}
            />
          </span>
        </label>
        <label className={ui.check}>
          <input type="checkbox" name="listed" defaultChecked={node.listed} disabled={!node.baseUrl && !node.listed} />
          Listed
        </label>
        <button type="submit" className={ui.button} disabled={pending}>
          {pending ? 'Saving…' : 'Save'}
        </button>
        {state?.error && <p className={ui.error} role="alert">{state.error}</p>}
        {state?.saved && !pending && <p className={ui.note} role="status">Saved.</p>}
      </form>
    </div>
  );
}
