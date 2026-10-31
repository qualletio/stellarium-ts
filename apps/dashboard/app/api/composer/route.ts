import type Anthropic from '@anthropic-ai/sdk';
import {
  type ComposerMessage,
  completeComposerTurn,
  getComposerConversation,
  getOrganization,
  getSession,
  holdComposerTurn,
  listClients,
  listListings,
  listNodes,
  OperatorError,
  releaseComposerTurn,
} from '@/lib/api';
import { fetchCatalog } from '@/lib/composer/catalog';
import type { ComposerEvent } from '@/lib/composer/events';
import { runTurn } from '@/lib/composer/turn';

// A turn can take several model calls.
export const maxDuration = 300;

const MAX_MESSAGE_LENGTH = 20_000;

const fail = (status: number, error: string) => Response.json({ error }, { status });

/**
 * One Composer turn, streamed as NDJSON `ComposerEvent`s. The body is `{ clientId, message, conversationId? }`:
 * the API client names the node whose resources the script may use, and runs it later. The turn is held on the
 * organization's balance first and charged for the tokens it used at the end, so only admins can chat.
 */
export async function POST(request: Request) {
  const body = (await request.json().catch(() => undefined)) as { clientId?: unknown; message?: unknown; conversationId?: unknown } | undefined;
  const message = typeof body?.message === 'string' ? body.message.trim() : '';
  const clientId = typeof body?.clientId === 'string' ? body.clientId : '';
  const conversationId = typeof body?.conversationId === 'string' ? body.conversationId : undefined;
  if (!message || message.length > MAX_MESSAGE_LENGTH) return fail(400, `Write a message of at most ${MAX_MESSAGE_LENGTH} characters.`);
  if (!clientId) return fail(400, 'Choose an API client.');
  if (!process.env.ANTHROPIC_API_KEY) return fail(503, 'ANTHROPIC_API_KEY is not set: the Composer is disabled.');
  if (!(await getSession())) return fail(401, 'Sign in again.');

  let chargeId: string;
  let catalog: Awaited<ReturnType<typeof fetchCatalog>>;
  let history: ComposerMessage[] = [];
  let turnConversationId: string;
  try {
    const [organization, clients, listings, nodes] = await Promise.all([getOrganization(), listClients(), listListings(), listNodes()]);
    if (!organization.admin) return fail(403, 'Only organization admins can use the Composer, since each message is charged to the balance.');
    const client = clients.find((candidate) => candidate.id === clientId && !candidate.revokedAt);
    if (!client) return fail(404, 'That API client was not found or has been revoked.');
    const baseUrl = listings.find((listing) => listing.publicKey === client.nodePublicKey)?.baseUrl
      ?? nodes.find((node) => node.publicKey === client.nodePublicKey)?.baseUrl;
    if (!baseUrl) return fail(422, 'The API client\'s node has not reported its URL.');
    try {
      catalog = await fetchCatalog(baseUrl, request.signal);
    } catch {
      return fail(502, 'The node\'s resource list could not be read. Is the node running?');
    }
    if (conversationId) history = (await getComposerConversation(conversationId)).messages;
    const held = await holdComposerTurn({ conversationId, title: message.slice(0, 80) });
    chargeId = held.chargeId;
    turnConversationId = held.conversationId;
  } catch (error) {
    if (error instanceof OperatorError) return fail(error.status, error.message);
    throw error;
  }

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const emit = (event: ComposerEvent) => {
        // The browser may have gone; the turn still settles.
        try {
          controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
        } catch {}
      };
      emit({ type: 'started', conversationId: turnConversationId });
      const turn = await runTurn({
        history: history as Anthropic.Beta.BetaMessageParam[],
        text: message,
        catalog,
        emit,
        signal: request.signal,
      });
      try {
        if (turn.called) {
          const { amountMicroUsd } = await completeComposerTurn(chargeId, { messages: turn.messages as ComposerMessage[], usage: turn.usage });
          emit({ type: 'done', amountMicroUsd });
        } else {
          await releaseComposerTurn(chargeId);
          emit({ type: 'done', amountMicroUsd: 0 });
        }
      } catch (error) {
        // The operator releases the hold when it expires.
        console.error('Settling a Composer turn failed', error);
        emit({ type: 'error', message: 'The turn could not be saved.' });
      }
      try {
        controller.close();
      } catch {}
    },
  });
  return new Response(stream, { headers: { 'Content-Type': 'application/x-ndjson; charset=utf-8', 'Cache-Control': 'no-store' } });
}
