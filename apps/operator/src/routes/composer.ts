import { createHash, timingSafeEqual } from 'node:crypto';
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { authenticateDashboard, type DashboardAuthenticator, requireAdmin } from '../auth/dashboardAuth.js';
import type { ComposerMessage, ComposerUsage } from '../composer/composerService.js';
import { OperationError } from '../errors.js';
import type { RouteOptions } from './index.js';

/** The header the dashboard's server sends the shared secret in. */
export const DASHBOARD_SECRET_HEADER = 'x-stellarium-dashboard-secret';

const idParamsSchema = {
    type: 'object',
    required: ['id'],
    properties: { id: { type: 'string', format: 'uuid' } },
} as const;

const tokens = { type: 'integer', minimum: 0, maximum: 100_000_000 } as const;

const completeSchema = {
    type: 'object',
    required: ['messages', 'usage'],
    properties: {
        messages: {
            type: 'array',
            maxItems: 64,
            items: {
                type: 'object',
                required: ['role', 'content'],
                properties: {
                    role: { enum: ['user', 'assistant'] },
                    content: { type: 'array', maxItems: 256, items: { type: 'object' } },
                },
                additionalProperties: false,
            },
        },
        usage: {
            type: 'object',
            required: ['inputTokens', 'cacheWriteTokens', 'cacheReadTokens', 'outputTokens'],
            properties: { inputTokens: tokens, cacheWriteTokens: tokens, cacheReadTokens: tokens, outputTokens: tokens },
            additionalProperties: false,
        },
    },
    additionalProperties: false,
} as const;

function digest(value: string): Buffer {
    return createHash('sha256').update(value).digest();
}

/**
 * The dashboard's Composer. A user reads and deletes their own conversations with the session cookie.
 * Holding and completing a turn moves the organization's money, on usage the dashboard's server reports,
 * so those also need an admin's session and the server's shared secret.
 */
const composerRoutes: FastifyPluginAsync<RouteOptions & { authenticator: DashboardAuthenticator }> = async function (fastify, { service, authenticator }) {
    fastify.addHook('preHandler', authenticateDashboard(authenticator, service.organizations));
    const organizationId = (request: FastifyRequest) => request.organization!.id;
    const userId = (request: FastifyRequest) => request.dashboardSession!.userId;

    const requireDashboardServer = async (request: FastifyRequest): Promise<void> => {
        if (!service.dashboardServiceSecret) {
            throw new OperationError(503, 'The Composer is not configured on this operator');
        }
        const presented = request.headers[DASHBOARD_SECRET_HEADER];
        if (typeof presented !== 'string' || !timingSafeEqual(digest(presented), digest(service.dashboardServiceSecret))) {
            throw new OperationError(403, 'Only the dashboard\'s server can do this');
        }
    };
    const turnPreHandler = [requireAdmin, requireDashboardServer];

    fastify.get('/org/composer/conversations', async (request) => ({
        conversations: await service.composer.listConversations(organizationId(request), userId(request)),
    }));

    fastify.get<{ Params: { id: string } }>('/org/composer/conversations/:id', { schema: { params: idParamsSchema } }, async (request) => {
        return service.composer.getConversation(organizationId(request), userId(request), request.params.id);
    });

    fastify.delete<{ Params: { id: string } }>('/org/composer/conversations/:id', { schema: { params: idParamsSchema } }, async (request) => {
        await service.composer.deleteConversation(organizationId(request), userId(request), request.params.id);
        return { deleted: true };
    });

    fastify.post<{ Body: { conversationId?: string, title: string } }>('/org/composer/turns', {
        preHandler: turnPreHandler,
        schema: {
            body: {
                type: 'object',
                required: ['title'],
                properties: {
                    conversationId: { type: 'string', format: 'uuid' },
                    title: { type: 'string', minLength: 1, maxLength: 255 },
                },
                additionalProperties: false,
            },
        },
    }, async (request) => service.composer.hold(organizationId(request), userId(request), request.body));

    // A turn's messages carry Claude's thinking and the scripts it wrote, so they can be large.
    fastify.post<{ Params: { id: string }, Body: { messages: ComposerMessage[], usage: ComposerUsage } }>('/org/composer/turns/:id/complete', {
        preHandler: turnPreHandler,
        bodyLimit: 8 * 1024 * 1024,
        schema: { params: idParamsSchema, body: completeSchema },
    }, async (request) => service.composer.complete(organizationId(request), userId(request), request.params.id, request.body));

    fastify.post<{ Params: { id: string } }>('/org/composer/turns/:id/release', {
        preHandler: turnPreHandler,
        schema: { params: idParamsSchema },
    }, async (request) => {
        await service.composer.release(organizationId(request), userId(request), request.params.id);
        return { released: true };
    });
};

export default composerRoutes;
