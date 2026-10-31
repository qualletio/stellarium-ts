// Shared by the Composer's route handler and the browser: what a turn streams, and how a saved
// conversation is shown.

export const PROPOSE_TOOL = 'propose_script';
export const CHECK_TOOL = 'check_script';

/** What the checker found, as the proposal's tool result records it. */
export interface ProposalDetails {
  kind: 'request' | 'contract';
  contract?: { path: string; name: string; version: string };
  maxTokens: number;
  paidCalls: { call: string; price: string }[];
  warnings: string[];
}

/** A script Claude proposed, which the user can run or deploy. */
export interface Proposal extends ProposalDetails {
  /** The tool call's id. */
  id: string;
  title: string;
  summary: string;
  source: string;
}

/** One line of a turn's NDJSON stream. */
export type ComposerEvent =
  | { type: 'started'; conversationId: string }
  | { type: 'text'; text: string }
  | { type: 'thinking'; text: string }
  | { type: 'block' }
  | { type: 'tool'; name: string }
  | { type: 'proposal'; proposal: Proposal }
  | { type: 'error'; message: string }
  | { type: 'done'; amountMicroUsd: number };

/** A conversation as it is shown: the user's words, Claude's words and thinking, and its proposals. */
export type DisplayItem =
  | { kind: 'user'; text: string }
  | { kind: 'assistant'; text: string }
  | { kind: 'thinking'; text: string }
  | { kind: 'tool'; name: string }
  | { kind: 'proposal'; proposal: Proposal };

type Block = { type?: unknown; [key: string]: unknown };

/**
 * The saved messages as display items. Tool results are hidden, except that a proposal shows only when its
 * result recorded the checker's details, which it does only when the script passed.
 */
export function displayItems(messages: { role: 'user' | 'assistant'; content: unknown[] }[]): DisplayItem[] {
  const details = new Map<string, ProposalDetails>();
  for (const message of messages) {
    for (const block of message.content as Block[]) {
      if (block.type !== 'tool_result' || block.is_error) continue;
      try {
        const parsed = JSON.parse(String(block.content)) as { proposed?: ProposalDetails };
        if (parsed.proposed) details.set(String(block.tool_use_id), parsed.proposed);
      } catch {
        // Not a proposal's result.
      }
    }
  }

  const items: DisplayItem[] = [];
  for (const message of messages) {
    for (const block of message.content as Block[]) {
      if (message.role === 'user' && block.type === 'text') items.push({ kind: 'user', text: String(block.text) });
      if (message.role !== 'assistant') continue;
      if (block.type === 'text' && String(block.text).trim()) items.push({ kind: 'assistant', text: String(block.text) });
      if (block.type === 'thinking' && String(block.thinking ?? '').trim()) items.push({ kind: 'thinking', text: String(block.thinking) });
      if (block.type === 'tool_use') {
        const input = block.input as { source?: string; title?: string; summary?: string };
        const proposed = details.get(String(block.id));
        if (block.name === PROPOSE_TOOL && proposed) {
          items.push({ kind: 'proposal', proposal: { id: String(block.id), title: input.title ?? 'Script', summary: input.summary ?? '', source: input.source ?? '', ...proposed } });
        } else {
          items.push({ kind: 'tool', name: String(block.name) });
        }
      }
    }
  }
  return items;
}
