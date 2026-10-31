'use client';

import { useState, useTransition } from 'react';
import { deployContractAction, runScriptAction, type ScriptOutcome } from '@/lib/actions';
import type { Proposal } from '@/lib/composer/events';
import styles from './Composer.module.css';
import { CopyButton } from './CopyButton';
import ui from './ui.module.css';

/**
 * A script the Composer proposed. An admin runs a request, or deploys a contract, on the selected API client's
 * node. A failure can go back to the Composer to fix.
 */
export function ScriptProposal({ proposal, clientId, admin, onFix }: {
  proposal: Proposal;
  clientId: string | undefined;
  admin: boolean;
  onFix?: (message: string) => void;
}) {
  const [outcome, setOutcome] = useState<ScriptOutcome>();
  const [pending, startTransition] = useTransition();
  const contract = proposal.kind === 'contract';
  const action = contract ? 'Deploy' : 'Run';

  const go = () => {
    if (!clientId) return;
    setOutcome(undefined);
    startTransition(async () => {
      setOutcome(contract
        ? await deployContractAction(clientId, proposal.source, proposal.summary)
        : await runScriptAction(clientId, proposal.source));
    });
  };

  return (
    <div className={styles.proposal}>
      <div className={styles.proposalHead}>
        <span>
          <span className={styles.proposalTitle}>{proposal.title}</span>{' '}
          <span className={`${ui.badge} ${ui.badgeMuted}`}>{contract ? 'contract' : 'request'}</span>
        </span>
        <span className={ui.actions}>
          <CopyButton value={proposal.source} />
          <button type="button" className={ui.button} onClick={go} disabled={!admin || !clientId || pending}
            title={!admin ? 'Only organization admins can run scripts' : undefined}>
            {pending ? `${action === 'Run' ? 'Running' : 'Deploying'}…` : action}
          </button>
        </span>
      </div>
      {proposal.summary && <p>{proposal.summary}</p>}
      <pre className={styles.code}>{proposal.source}</pre>
      <div className={styles.facts}>
        {contract && proposal.contract && (
          <span>Becomes {proposal.contract.path}.{proposal.contract.name}@{proposal.contract.version}, called with <code>run</code>.</span>
        )}
        <span>At most {proposal.maxTokens} script tokens{contract ? ' per call' : ''}, at the node&apos;s price per million.</span>
        {proposal.paidCalls.map((paid) => <span key={paid.call}>Calls {paid.call}: {paid.price}.</span>)}
        {proposal.warnings.map((warning) => <span key={warning}>{warning}</span>)}
      </div>
      {outcome && (
        <div className={styles.outcome} role="status">
          {outcome.ok && outcome.kind === 'run' && (
            <>
              Returned, after {outcome.tokens} tokens:
              <pre>{JSON.stringify(outcome.returnValue, null, 2)}</pre>
            </>
          )}
          {outcome.ok && outcome.kind === 'deploy' && (
            <>
              Deployed {outcome.contract.path}.{outcome.contract.name}@{outcome.contract.version}
              {outcome.contract.feeMicroUsd > 0 && ` for a fee of ${outcome.contract.feeMicroUsd} micro-USD`}.
            </>
          )}
          {!outcome.ok && (
            <>
              <span className={ui.error}>{outcome.error}</span>
              {onFix && (
                <div className={ui.spacedAbove}>
                  <button type="button" className={ui.buttonSecondary}
                    onClick={() => onFix(`The ${contract ? 'deploy' : 'run'} of "${proposal.title}" failed: ${outcome.error}`)}>
                    Ask Composer to fix
                  </button>
                </div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}
