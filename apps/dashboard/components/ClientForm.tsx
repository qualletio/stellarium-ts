'use client';

import { useActionState } from 'react';
import { createClientAction } from '@/lib/actions';
import { CopyButton } from './CopyButton';
// The same shown-once panel as an enrollment token's.
import styles from './EnrollmentForm.module.css';
import ui from './ui.module.css';

/** A node an API client can be created for. */
export interface ClientNodeOption {
  publicKey: string;
  label: string;
  /** Where its `/v1/run` is, for the example request. */
  baseUrl: string | null;
  group: 'Your nodes' | 'Listed nodes';
}

/**
 * Creates an API client for one node and shows its secret once, with the requests that exchange it for a run
 * token and run a script.
 */
export function ClientForm({ nodes, defaultNode, operatorUrl }: { nodes: ClientNodeOption[]; defaultNode?: string; operatorUrl: string }) {
  const [state, formAction, pending] = useActionState(createClientAction, undefined);
  const created = state?.client;
  const groups = (['Your nodes', 'Listed nodes'] as const).map((group) => ({ group, options: nodes.filter((node) => node.group === group) }));
  return (
    <div className={styles.wrap}>
      <form action={formAction} className={ui.form}>
        <label className={ui.field}>
          Node
          <select className={ui.input} name="nodePublicKey" defaultValue={defaultNode} required>
            {groups.filter(({ options }) => options.length > 0).map(({ group, options }) => (
              <optgroup key={group} label={group}>
                {options.map((node) => <option key={node.publicKey} value={node.publicKey}>{node.label}</option>)}
              </optgroup>
            ))}
          </select>
        </label>
        <label className={ui.field}>
          Label
          <input className={ui.input} name="label" placeholder="ci" maxLength={255} />
        </label>
        <label className={ui.field}>
          Max per run
          <span className={ui.prefixed}>
            <span className={ui.prefix}>$</span>
            <input className={ui.input} name="maxRunCost" type="number" inputMode="decimal" min="0.000001" step="0.000001" defaultValue="1" required />
          </span>
        </label>
        <label className={ui.field}>
          Monthly cap
          <span className={ui.prefixed}>
            <span className={ui.prefix}>$</span>
            <input className={ui.input} name="monthlyCap" type="number" inputMode="decimal" min="0.000001" step="0.000001" placeholder="None" />
          </span>
        </label>
        <button type="submit" className={ui.button} disabled={pending}>
          {pending ? 'Creating…' : 'Create API client'}
        </button>
        {state?.error && <p className={ui.error} role="alert">{state.error}</p>}
      </form>
      {created && <Credentials id={created.id} secret={created.secret} operatorUrl={operatorUrl} baseUrl={nodes.find((node) => node.publicKey === created.nodePublicKey)?.baseUrl} />}
    </div>
  );
}

function Credentials({ id, secret, operatorUrl, baseUrl }: { id: string; secret: string; operatorUrl: string; baseUrl?: string | null }) {
  const example = [
    `TOKEN="$(curl -s -X POST ${operatorUrl}/oauth/token \\`,
    `  -d grant_type=client_credentials -d client_id=${id} -d client_secret=${secret} \\`,
    `  | node -pe 'JSON.parse(require("fs").readFileSync(0)).access_token')"`,
    `curl -X POST ${baseUrl ?? '<node URL>'}/v1/run \\`,
    `  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \\`,
    `  -d '{"source": "request Hello {\\n  return \\"Hello\\"\\n}"}'`,
  ].join('\n');
  return (
    <div className={styles.token}>
      <p className={styles.tokenHead}>
        <span className={ui.kicker}>Shown once</span>
        <span className={ui.note}>Store the secret now. It can't be shown again.</span>
      </p>
      <pre className={styles.code}>{`STELLARIUM_CLIENT_ID=${id}\nSTELLARIUM_CLIENT_SECRET=${secret}`}</pre>
      <div className={ui.actions}>
        <CopyButton value={`STELLARIUM_CLIENT_ID=${id}\nSTELLARIUM_CLIENT_SECRET=${secret}`} label="Copy env lines" />
        <CopyButton value={secret} label="Copy secret" />
      </div>
      <p className={ui.note}>Exchange them for a run token, which lasts 15 minutes, and call the node with it:</p>
      <pre className={styles.code}>{example}</pre>
      <div className={ui.actions}>
        <CopyButton value={example} label="Copy example" />
      </div>
    </div>
  );
}
