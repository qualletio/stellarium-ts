import type { FastifyPluginAsync } from 'fastify';
import { authenticateNode } from '../auth/nodeAuth.js';
import type { ContractRunAuthorizationRequest, EventMandateRequest, EventRunAuthorizationRequest, RunAuthorizationRequest, RunCaptureRequest } from '../runs/runService.js';
import type { RunReceipt } from '../verification/replay.js';
import type { RouteOptions } from './index.js';

const runId = { type: 'string', format: 'uuid' } as const;

const authorizeSchema = {
    type: 'object',
    required: ['token', 'runId', 'source'],
    properties: {
        token: { type: 'string', minLength: 1, maxLength: 4096 },
        runId,
        source: { type: 'string', maxLength: 100_000 },
    },
} as const;

const captureSchema = {
    type: 'object',
    required: ['runId', 'tokens'],
    properties: { runId, tokens: { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER }, failed: { type: 'boolean' } },
} as const;

const releaseSchema = { type: 'object', required: ['runId'], properties: { runId } } as const;

const contractAuthorizeSchema = {
    type: 'object',
    required: ['voucher', 'source'],
    properties: {
        // Signed, so only checked enough for the service to read it. The invocationId becomes the run's id.
        voucher: {
            type: 'object',
            required: ['kind', 'requestId', 'invocationId', 'maxAmount', 'priceMicroUsdPerMillionTokens', 'recipientOrganizationId', 'signature', 'expiresAt', 'invocationHash', 'publicKey'],
            properties: {
                kind: { const: 'contract' },
                requestId: { type: 'string', minLength: 1, maxLength: 255 },
                invocationId: runId,
                maxAmount: { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER },
                priceMicroUsdPerMillionTokens: { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER },
                recipientOrganizationId: { type: 'string', minLength: 1, maxLength: 64 },
                signature: { type: 'string', minLength: 1, maxLength: 1024 },
                expiresAt: { type: 'string', minLength: 1, maxLength: 64 },
                invocationHash: { type: 'string', minLength: 1, maxLength: 255 },
                publicKey: { type: 'string', minLength: 1, maxLength: 255 },
                runId,
            },
        },
        source: { type: 'string', maxLength: 100_000 },
        senderContract: {
            type: 'object',
            required: ['name', 'version'],
            properties: { name: { type: 'string', minLength: 1, maxLength: 512 }, version: { type: 'string', minLength: 1, maxLength: 64 } },
            additionalProperties: false,
        },
    },
} as const;

const eventMandateSchema = {
    type: 'object',
    required: ['token', 'consumer'],
    properties: {
        token: { type: 'string', minLength: 1, maxLength: 4096 },
        consumer: { type: 'string', minLength: 1, maxLength: 512 },
    },
} as const;

const eventAuthorizeSchema = {
    type: 'object',
    required: ['mandateId', 'runId', 'source'],
    properties: {
        mandateId: { type: 'string', minLength: 1, maxLength: 64 },
        runId,
        source: { type: 'string', maxLength: 100_000 },
    },
} as const;

/**
 * A node authorizes a script run by another organization's API client, or a call to one of its contracts,
 * before running it, then captures it with the tokens executed, or releases it. Requests are signed by the node.
 */
const runRoutes: FastifyPluginAsync<RouteOptions> = async function (fastify, { service }) {
    fastify.addHook('preValidation', authenticateNode);

    fastify.post<{ Body: RunAuthorizationRequest }>('/runs/authorize', { schema: { body: authorizeSchema } }, async (request) => {
        return service.runs.authorize(request.nodePublicKey!, request.body);
    });

    fastify.post<{ Body: ContractRunAuthorizationRequest }>('/runs/contract/authorize', { schema: { body: contractAuthorizeSchema } }, async (request) => {
        return service.runs.authorizeContract(request.nodePublicKey!, request.body);
    });

    // When an API client deploys an event contract, and before each event the contract consumes.
    fastify.post<{ Body: EventMandateRequest }>('/runs/event/mandates', { schema: { body: eventMandateSchema } }, async (request) => {
        return service.runs.createEventMandate(request.nodePublicKey!, request.body);
    });

    fastify.post<{ Body: EventRunAuthorizationRequest }>('/runs/event/authorize', { schema: { body: eventAuthorizeSchema } }, async (request) => {
        return service.runs.authorizeEvent(request.nodePublicKey!, request.body);
    });

    // A node opens a run for a script it runs for itself before it moves money (docs/money.md, Settlement).
    fastify.post<{ Body: { runId: string, now?: number } }>('/runs/open', {
        schema: { body: { type: 'object', required: ['runId'], properties: { runId, now: { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER } } } },
    }, async (request) => {
        return service.runs.open(request.nodePublicKey!, request.body);
    });

    // Receipts of the contract runs in a run's tree, which the operator replays (docs/money.md, Verified runs).
    fastify.post<{ Body: { runId: string, receipts: RunReceipt[], signature: string } }>('/runs/receipts', {
        schema: { body: { type: 'object', required: ['runId', 'receipts', 'signature'], properties: { runId, receipts: { type: 'array', maxItems: 256, items: { type: 'object' } }, signature: { type: 'string', minLength: 1, maxLength: 255 } } } },
        bodyLimit: 8 * 1024 * 1024,
    }, async (request) => {
        return service.verification.submit(request.nodePublicKey!, request.body);
    });

    // Whether the money changes in a run's tree were applied, so the node saves or discards pending state.
    fastify.post<{ Body: { runId: string } }>('/runs/outcome', { schema: { body: releaseSchema } }, async (request) => {
        return service.money.outcome(request.nodePublicKey!, request.body.runId);
    });

    fastify.post<{ Body: RunCaptureRequest }>('/runs/capture', { schema: { body: captureSchema } }, async (request) => {
        return service.runs.capture(request.nodePublicKey!, request.body);
    });

    fastify.post<{ Body: { runId: string } }>('/runs/release', { schema: { body: releaseSchema } }, async (request) => {
        return service.runs.release(request.nodePublicKey!, request.body);
    });
};

export default runRoutes;
