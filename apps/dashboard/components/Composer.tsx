'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { type FormEvent, useEffect, useRef, useState } from 'react';
import { CHECK_TOOL, type ComposerEvent, type DisplayItem, PROPOSE_TOOL } from '@/lib/composer/events';
import { formatPreciseUsd } from '@/lib/format';
import styles from './Composer.module.css';
import { ScriptProposal } from './ScriptProposal';
import ui from './ui.module.css';

/** An API client the Composer can write for: its node's resources, and where Run and Deploy go. */
export interface ComposerClient {
  id: string;
  label: string;
}

const CLIENT_STORAGE_KEY = 'composer.clientId';

const TOOL_LABELS: Record<string, string> = {
  [CHECK_TOOL]: 'Checked the script',
  [PROPOSE_TOOL]: 'Proposed a script',
};

/** Adds one streamed event to the turn's items. `fresh` starts a new item: a new content block began. */
function apply(items: DisplayItem[], event: ComposerEvent, fresh: boolean): DisplayItem[] {
  const last = items.at(-1);
  switch (event.type) {
    case 'text':
      if (!fresh && last?.kind === 'assistant') return [...items.slice(0, -1), { kind: 'assistant', text: last.text + event.text }];
      return [...items, { kind: 'assistant', text: event.text }];
    case 'thinking':
      if (!fresh && last?.kind === 'thinking') return [...items.slice(0, -1), { kind: 'thinking', text: last.text + event.text }];
      return [...items, { kind: 'thinking', text: event.text }];
    case 'tool':
      return [...items, { kind: 'tool', name: event.name }];
    case 'proposal':
      return [...items, { kind: 'proposal', proposal: event.proposal }];
    default:
      return items;
  }
}

export function Composer({ clients, conversationId: initialConversationId, initialItems, admin, availableMicroUsd }: {
  clients: ComposerClient[];
  conversationId?: string;
  initialItems: DisplayItem[];
  admin: boolean;
  availableMicroUsd: number;
}) {
  const router = useRouter();
  const [items, setItems] = useState(initialItems);
  const [conversationId, setConversationId] = useState(initialConversationId);
  const [clientId, setClientId] = useState(clients[0]?.id);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [lastCost, setLastCost] = useState<number>();
  const end = useRef<HTMLDivElement>(null);

  // The last API client chosen, when it still exists.
  useEffect(() => {
    try {
      const saved = localStorage.getItem(CLIENT_STORAGE_KEY);
      if (saved && clients.some((client) => client.id === saved)) setClientId(saved);
    } catch {}
  }, [clients]);

  // Follows the conversation as it grows.
  useEffect(() => {
    if (items.length > 0) end.current?.scrollIntoView({ block: 'end' });
  }, [items]);

  const chooseClient = (id: string) => {
    setClientId(id);
    try {
      localStorage.setItem(CLIENT_STORAGE_KEY, id);
    } catch {}
  };

  const send = async (text: string) => {
    if (!text.trim() || !clientId || busy) return;
    setBusy(true);
    setError(undefined);
    setInput('');
    setItems((current) => [...current, { kind: 'user', text }]);
    try {
      const response = await fetch('/api/composer', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ clientId, message: text, conversationId }),
      });
      if (!response.ok || !response.body) {
        const json = (await response.json().catch(() => ({}))) as { error?: string };
        setError(json.error ?? `The Composer answered ${response.status}.`);
        setInput(text);
        setItems((current) => current.slice(0, -1));
        return;
      }
      const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
      let buffer = '';
      let fresh = true;
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += value;
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';
        for (const line of lines) {
          if (!line.trim()) continue;
          const event = JSON.parse(line) as ComposerEvent;
          if (event.type === 'started' && !conversationId) {
            setConversationId(event.conversationId);
            window.history.replaceState(null, '', `/composer/${event.conversationId}`);
          } else if (event.type === 'block') {
            fresh = true;
          } else if (event.type === 'error') {
            setError(event.message);
          } else if (event.type === 'done') {
            setLastCost(event.amountMicroUsd);
          } else {
            const isFresh = fresh;
            fresh = false;
            setItems((current) => apply(current, event, isFresh));
          }
        }
      }
    } catch {
      setError('The connection to the Composer was lost.');
    } finally {
      setBusy(false);
      // Updates the balance and, for a new conversation, the list of conversations.
      router.refresh();
    }
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    void send(input);
  };

  if (clients.length === 0) {
    return (
      <p className={ui.empty}>
        The Composer writes scripts for one node&apos;s resources and runs them with an API client.{' '}
        {admin ? <Link href="/explore" className={ui.textLink}>Create an API client for a node</Link> : 'Ask an admin to create an API client'} first.
      </p>
    );
  }

  return (
    <div className={styles.chat}>
      <div className={styles.messages} aria-live="polite">
        {items.length === 0 && (
          <p className={ui.description}>
            Describe what you want a script to do, such as &ldquo;get the temperature in Oslo and Paris and return the warmer city&rdquo;. The
            Composer writes RequestScript for the resources the API client&apos;s node knows, checks it, and proposes it to run or deploy as a
            contract.
          </p>
        )}
        {items.map((item, index) => {
          const key = `${item.kind}-${index}`;
          switch (item.kind) {
            case 'user':
              return <div key={key} className={styles.user}>{item.text}</div>;
            case 'assistant':
              return <div key={key} className={`${styles.assistant} ${busy && index === items.length - 1 ? styles.cursor : ''}`}>{item.text}</div>;
            case 'thinking':
              return (
                <details key={key} className={styles.thinking}>
                  <summary>Thinking</summary>
                  <p>{item.text}</p>
                </details>
              );
            case 'tool':
              return <div key={key} className={styles.tool}>{TOOL_LABELS[item.name] ?? item.name}</div>;
            case 'proposal':
              return <ScriptProposal key={item.proposal.id} proposal={item.proposal} clientId={clientId} admin={admin} onFix={admin ? send : undefined} />;
          }
          return null;
        })}
        {busy && items.at(-1)?.kind === 'user' && <div className={`${styles.tool} ${styles.cursor}`}>Working</div>}
        <div ref={end} />
      </div>

      <form className={styles.composerForm} onSubmit={submit}>
        {error && <p className={ui.error} role="alert">{error}</p>}
        <textarea
          className={styles.textarea}
          value={input}
          onChange={(event) => setInput(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault();
              void send(input);
            }
          }}
          placeholder={admin ? 'What should the script do?' : 'Only organization admins can use the Composer.'}
          disabled={!admin || busy}
          aria-label="Message"
        />
        <div className={styles.formRow}>
          <label className={ui.field}>
            API client
            <select className={ui.input} value={clientId} onChange={(event) => chooseClient(event.target.value)} disabled={busy}>
              {clients.map((client) => <option key={client.id} value={client.id}>{client.label}</option>)}
            </select>
          </label>
          <span className={styles.meta}>
            {lastCost !== undefined && `Last message: ${formatPreciseUsd(lastCost)}. `}
            Available: {formatPreciseUsd(availableMicroUsd)}. Each message is charged for the Claude tokens it uses.
          </span>
          <button type="submit" className={ui.button} disabled={!admin || busy || !input.trim()}>
            {busy ? 'Working…' : 'Send'}
          </button>
        </div>
      </form>
    </div>
  );
}
