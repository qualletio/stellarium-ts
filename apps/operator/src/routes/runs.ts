import type { FastifyPluginAsync } from 'fastify';
import { authenticateNode } from '../auth/nodeAuth.js';
import type { ContractRunAuthorizationRequest, RunAuthorizationRequest } from '../runs/runService.js';
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
    properties: { runId, tokens: { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER } },
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

    fastify.post<{ Body: { runId: string, tokens: number } }>('/runs/capture', { schema: { body: captureSchema } }, async (request) => {
        return service.runs.capture(request.nodePublicKey!, request.body);
    });

    fastify.post<{ Body: { runId: string } }>('/runs/release', { schema: { body: releaseSchema } }, async (request) => {
        return service.runs.release(request.nodePublicKey!, request.body);
    });
};

export default runRoutes;
