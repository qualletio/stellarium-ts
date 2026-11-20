import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { STAFF_ACTION_KINDS, type StaffActionKind } from '../db/schema.js';
import { OperationError } from '../errors.js';
import type { RouteOptions } from './index.js';

declare module 'fastify' {
    interface FastifyRequest {
        staffName?: string;
    }
}

const proposalSchema = {
    type: 'object',
    required: ['kind', 'payload', 'reason'],
    properties: {
        kind: { enum: STAFF_ACTION_KINDS },
        payload: { type: 'object' },
        reason: { type: 'string', minLength: 1, maxLength: 4096 },
        organizationId: { type: 'string', minLength: 1, maxLength: 64 },
    },
    additionalProperties: false,
} as const;

/**
 * The staff API (docs/money.md, Trust): reviews, fraud cases, appeals and staff actions. Every request names its
 * staff member by API key, and sensitive actions need a second staff member's approval.
 */
const staffRoutes: FastifyPluginAsync<RouteOptions> = async function (fastify, { service }) {
    fastify.addHook('preValidation', async (request: FastifyRequest) => {
        const [scheme, key] = (request.headers.authorization ?? '').split(' ');
        const name = scheme === 'Bearer' && key ? service.staff.get(key) : undefined;
        if (!name) throw new OperationError(401, 'A staff API key is required');
        request.staffName = name;
    });

    fastify.get('/staff/reviews', async () => ({ reviews: await service.governance.openReviews() }));
    fastify.get('/staff/fraud-cases', async () => ({ fraudCases: await service.governance.fraudCases() }));
    fastify.get('/staff/appeals', async () => ({ appeals: await service.governance.openAppeals() }));
    fastify.get<{ Querystring: { status?: 'proposed' | 'executed' | 'rejected' } }>('/staff/actions', async (request) => ({ actions: await service.governance.actions(request.query.status) }));
    fastify.get('/staff/audit', async () => ({ entries: await service.audit.recent() }));
    fastify.get('/staff/alerts', async () => ({ alerts: await service.alerts.open() }));
    fastify.get('/staff/payment-flags', async () => ({ flags: await service.governance.openPaymentFlags() }));

    fastify.post<{ Body: { kind: StaffActionKind, payload: Record<string, unknown>, reason: string, organizationId?: string } }>('/staff/actions', { schema: { body: proposalSchema } }, async (request) => {
        const { kind, payload, reason, organizationId } = request.body;
        return { action: await service.governance.propose(request.staffName!, kind, payload, reason, organizationId ?? (typeof payload.organizationId === 'string' ? payload.organizationId : null)) };
    });

    fastify.post<{ Params: { id: string } }>('/staff/actions/:id/approve', async (request) => {
        return { action: await service.governance.approve(Number(request.params.id), request.staffName!) };
    });

    fastify.post<{ Params: { id: string } }>('/staff/actions/:id/reject', async (request) => {
        return { action: await service.governance.reject(Number(request.params.id), request.staffName!) };
    });

    fastify.post('/staff/checkpoints', async () => ({ checkpoint: await service.governance.checkpoint() }));
};

export default staffRoutes;
