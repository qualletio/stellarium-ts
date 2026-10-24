'use client';

import { useActionState, useEffect, useState } from 'react';
import { updateClientLimitsAction } from '@/lib/actions';
import type { ApiClient } from '@/lib/api';
import { formatUsd } from '@/lib/format';
import ui from './ui.module.css';

/**
 * An API client's limits, with an Edit button for admins that swaps them for a form. New limits apply from the
 * client's next run: runs already authorized keep their hold.
 */
export function ClientLimitsForm({ client, editable }: { client: Pick<ApiClient, 'id' | 'maxRunCostMicroUsd' | 'monthlyCapMicroUsd'>; editable: boolean }) {
  const [editing, setEditing] = useState(false);
  const [state, formAction, pending] = useActionState(updateClientLimitsAction, undefined);

  // Close the form once the save goes through.
  useEffect(() => {
    if (state?.saved) setEditing(false);
  }, [state]);

  if (!editing) {
    return (
      <div className={ui.actions}>
        <span>
          {formatUsd(client.maxRunCostMicroUsd)} per run
          <span className={ui.secondary}>{client.monthlyCapMicroUsd === null ? 'No monthly cap' : `${formatUsd(client.monthlyCapMicroUsd)} a month`}</span>
        </span>
        {editable && (
          <button type="button" className={ui.buttonSecondary} onClick={() => setEditing(true)}>
            Edit
          </button>
        )}
      </div>
    );
  }
  return (
    <form action={formAction} className={ui.form}>
      <input type="hidden" name="id" value={client.id} />
      <label className={ui.field}>
        Max per run
        <span className={ui.prefixed}>
          <span className={ui.prefix}>$</span>
          <input
            className={ui.input}
            name="maxRunCost"
            type="number"
            inputMode="decimal"
            min="0.000001"
            step="0.000001"
            defaultValue={client.maxRunCostMicroUsd / 1_000_000}
            required
          />
        </span>
      </label>
      <label className={ui.field}>
        Monthly cap
        <span className={ui.prefixed}>
          <span className={ui.prefix}>$</span>
          <input
            className={ui.input}
            name="monthlyCap"
            type="number"
            inputMode="decimal"
            min="0.000001"
            step="0.000001"
            placeholder="None"
            defaultValue={client.monthlyCapMicroUsd === null ? '' : client.monthlyCapMicroUsd / 1_000_000}
          />
        </span>
      </label>
      <button type="submit" className={ui.button} disabled={pending}>
        {pending ? 'Saving…' : 'Save'}
      </button>
      <button type="button" className={ui.buttonSecondary} onClick={() => setEditing(false)} disabled={pending}>
        Cancel
      </button>
      {state?.error && <p className={ui.error} role="alert">{state.error}</p>}
    </form>
  );
}
