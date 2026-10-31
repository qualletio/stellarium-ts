import 'server-only';
import Anthropic from '@anthropic-ai/sdk';
import { type Catalog, renderCatalog } from './catalog';
import { checkScript } from './check';
import { CHECK_TOOL, type ComposerEvent, PROPOSE_TOOL, type ProposalDetails } from './events';
import { COMPOSER_SYSTEM_PROMPT } from './prompt';

export const COMPOSER_MODEL = 'claude-opus-5-5';
/** Model calls per turn: enough to check, fix, check again and propose. */
const MAX_ITERATIONS = 8;
/** Retries of a model call whose tool input arrived as JSON the SDK couldn't parse. */
const MAX_JSON_RETRIES = 2;

type Message = Anthropic.Beta.BetaMessageParam;

/** The tokens a turn used, summed over its model calls, as the operator charges them. */
export interface TurnUsage {
  inputTokens: number;
  cacheWriteTokens: number;
  cacheReadTokens: number;
  outputTokens: number;
}

const TOOLS: Anthropic.Beta.BetaTool[] = [
  {
    name: CHECK_TOOL,
    description: 'Parses a RequestScript script and checks it against the node\'s catalog: the declaration, that each resource exists, and each call\'s function and argument names. Reports problems, the most script tokens a run can execute, and the paid calls it makes. Types are checked only when the script runs.',
    input_schema: {
      type: 'object',
      properties: { source: { type: 'string', description: 'The complete script.' } },
      required: ['source'],
      additionalProperties: false,
    },
    strict: true,
    eager_input_streaming: true,
  },
  {
    name: PROPOSE_TOOL,
    description: 'Shows a finished script to the user, who can run it (a request) or deploy it (a contract). Checks it first and refuses it if the check finds problems. Propose each finished script once.',
    input_schema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'A short name for the script, such as "Warmer of two cities".' },
        summary: { type: 'string', description: 'One sentence on what it does and returns.' },
        source: { type: 'string', description: 'The complete script.' },
      },
      required: ['title', 'summary', 'source'],
      additionalProperties: false,
    },
    strict: true,
    eager_input_streaming: true,
  },
];

/** Tool input arrives unvalidated with eager input streaming, so each field is checked before use. */
function stringFields<K extends string>(input: unknown, keys: K[]): Record<K, string> | undefined {
  if (typeof input !== 'object' || input === null) return undefined;
  const record = input as Record<string, unknown>;
  for (const key of keys) {
    if (typeof record[key] !== 'string' || record[key] === '') return undefined;
  }
  return record as Record<K, string>;
}

function runTool(block: Anthropic.Beta.BetaToolUseBlock, catalog: Catalog, emit: (event: ComposerEvent) => void): Anthropic.Beta.BetaToolResultBlockParam {
  const fail = (content: string): Anthropic.Beta.BetaToolResultBlockParam => ({ type: 'tool_result', tool_use_id: block.id, is_error: true, content });
  if (block.name === CHECK_TOOL) {
    const input = stringFields(block.input, ['source']);
    if (!input) return fail(JSON.stringify({ INVALID_JSON: block.input }));
    return { type: 'tool_result', tool_use_id: block.id, content: JSON.stringify(checkScript(input.source, catalog)) };
  }
  if (block.name === PROPOSE_TOOL) {
    const input = stringFields(block.input, ['title', 'summary', 'source']);
    if (!input) return fail(JSON.stringify({ INVALID_JSON: block.input }));
    const check = checkScript(input.source, catalog);
    if (!check.ok || !check.kind || check.maxTokens === undefined) {
      return fail(JSON.stringify({ refused: 'The script has problems. Fix them, check it again, then propose it.', problems: check.problems }));
    }
    const details: ProposalDetails = {
      kind: check.kind,
      contract: check.contract && { path: check.contract.path, name: check.contract.name, version: check.contract.version },
      maxTokens: check.maxTokens,
      paidCalls: check.paidCalls,
      warnings: check.warnings,
    };
    emit({ type: 'proposal', proposal: { id: block.id, ...input, ...details } });
    // The result records the details, so a saved conversation shows the proposal again.
    return { type: 'tool_result', tool_use_id: block.id, content: JSON.stringify({ proposed: details }) };
  }
  return fail(`Unknown tool ${block.name}`);
}

/**
 * Answers for every tool call of the last message, if it is an assistant message whose calls never ran, so
 * the saved history stays valid for the next turn.
 */
function closeToolUses(messages: Message[], reason: string): void {
  const last = messages.at(-1);
  if (last?.role !== 'assistant' || typeof last.content === 'string') return;
  const pending = last.content.filter((block) => block.type === 'tool_use');
  if (pending.length === 0) return;
  messages.push({
    role: 'user',
    content: pending.map((block) => ({ type: 'tool_result' as const, tool_use_id: (block as Anthropic.Beta.BetaToolUseBlockParam).id, is_error: true, content: reason })),
  });
}

/**
 * One Composer turn: the user's message, then model calls and tool runs until Claude answers without a tool
 * call. Streams events through `emit`. Returns the messages to save, which start with the user's, and the
 * tokens used. `called` is false when no model call succeeded, so nothing is owed.
 */
export async function runTurn(options: {
  history: Message[];
  text: string;
  catalog: Catalog;
  emit: (event: ComposerEvent) => void;
  signal: AbortSignal;
}): Promise<{ messages: Message[]; usage: TurnUsage; called: boolean }> {
  const client = new Anthropic();
  const { catalog, emit, signal } = options;
  const turn: Message[] = [{ role: 'user', content: [{ type: 'text', text: options.text }] }];
  const usage: TurnUsage = { inputTokens: 0, cacheWriteTokens: 0, cacheReadTokens: 0, outputTokens: 0 };
  let called = false;
  const system: Anthropic.Beta.BetaTextBlockParam[] = [
    { type: 'text', text: COMPOSER_SYSTEM_PROMPT },
    { type: 'text', text: `# The node's catalog\n${renderCatalog(catalog)}`, cache_control: { type: 'ephemeral' } },
  ];

  try {
    for (let iteration = 0; iteration < MAX_ITERATIONS; iteration++) {
      let message: Anthropic.Beta.BetaMessage | undefined;
      for (let attempt = 0; message === undefined; attempt++) {
        const stream = client.beta.messages.stream({
          model: COMPOSER_MODEL,
          max_tokens: 64_000,
          betas: ['server-side-fallback-2026-07-01'],
          fallbacks: 'default',
          thinking: { type: 'adaptive', display: 'summarized' },
          output_config: { effort: 'medium' },
          // Also caches the conversation so far, so each call re-reads it at the cache rate.
          cache_control: { type: 'ephemeral' },
          system,
          tools: TOOLS,
          messages: [...options.history, ...turn],
        }, { signal });
        try {
          for await (const event of stream) {
            if (event.type === 'content_block_start') {
              emit({ type: 'block' });
              if (event.content_block.type === 'tool_use') emit({ type: 'tool', name: event.content_block.name });
            } else if (event.type === 'content_block_delta') {
              if (event.delta.type === 'text_delta') emit({ type: 'text', text: event.delta.text });
              if (event.delta.type === 'thinking_delta') emit({ type: 'thinking', text: event.delta.thinking });
            }
          }
          message = await stream.finalMessage();
        } catch (error) {
          // A typed API error, or an abort, is not unparseable tool input: give up on the turn.
          if (error instanceof Anthropic.APIError || signal.aborted || attempt >= MAX_JSON_RETRIES) throw error;
          emit({ type: 'error', message: 'Claude\'s tool input was cut off. Retrying.' });
        }
      }

      called = true;
      usage.inputTokens += message.usage.input_tokens;
      usage.cacheWriteTokens += message.usage.cache_creation_input_tokens ?? 0;
      usage.cacheReadTokens += message.usage.cache_read_input_tokens ?? 0;
      usage.outputTokens += message.usage.output_tokens;
      turn.push({ role: 'assistant', content: message.content });

      if (message.stop_reason === 'refusal') {
        emit({ type: 'error', message: 'Claude declined to continue this request.' });
        closeToolUses(turn, 'Not run: the turn ended.');
        break;
      }
      if (message.stop_reason === 'max_tokens') {
        emit({ type: 'error', message: 'Claude\'s answer reached its length limit.' });
        closeToolUses(turn, 'Not run: the input was cut off at the length limit.');
        break;
      }
      const toolUses = message.content.filter((block): block is Anthropic.Beta.BetaToolUseBlock => block.type === 'tool_use');
      if (message.stop_reason !== 'tool_use' || toolUses.length === 0) break;
      turn.push({ role: 'user', content: toolUses.map((block) => runTool(block, catalog, emit)) });
    }
  } catch (error) {
    closeToolUses(turn, 'Not run: the turn ended.');
    if (signal.aborted) return { messages: turn, usage, called };
    emit({ type: 'error', message: error instanceof Anthropic.APIError ? `Claude returned ${error.status ?? 'an error'}: ${error.message}` : 'The Composer failed. Try again.' });
    if (!(error instanceof Anthropic.APIError)) console.error(error);
    return { messages: turn, usage, called };
  }
  return { messages: turn, usage, called };
}
