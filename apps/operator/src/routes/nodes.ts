import type { FastifyPluginAsync } from 'fastify';
import { authenticateNode } from '../auth/nodeAuth.js';
import type { RouteOptions } from './index.js';

const sessionSchema = {
    type: 'object',
    properties: {
        enrollmentToken: { type: 'string', minLength: 1, maxLength: 255 },
        // The URL the node serves on, which listing verifies.
        baseUrl: { type: 'string', pattern: '^https?://', maxLength: 1024 },
    },
    additionalProperties: false,
} as const;

/** Routes a node calls as itself. Every request is signed with the node's key. */
const nodeRoutes: FastifyPluginAsync<RouteOptions> = async function (fastify, { service }) {
    fastify.addHook('preValidation', authenticateNode);

    // A node calls this at startup to learn its organization, enrolling with a dashboard token the first time.
    // It also gets a membership token, which proves its organization to the nodes that receive its events.
    fastify.post<{ Body: { enrollmentToken?: string, baseUrl?: string } }>('/nodes/session', { schema: { body: sessionSchema } }, async (request) => {
        const session = await service.organizations.session(request.nodePublicKey!, request.body?.enrollmentToken, request.body?.baseUrl?.replace(/\/+$/, ''));
        if (!service.runTokens) {
            return session;
        }
        return { ...session, membershipToken: await service.runTokens.signMembership(request.nodePublicKey!, session.organizationId) };
    });
};

export default nodeRoutes;
