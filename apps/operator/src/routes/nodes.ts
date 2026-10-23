import type { FastifyPluginAsync } from 'fastify';
import { authenticateNode } from '../auth/nodeAuth.js';
import type { RouteOptions } from './index.js';

const sessionSchema = {
    type: 'object',
    properties: { enrollmentToken: { type: 'string', minLength: 1, maxLength: 255 } },
    additionalProperties: false,
} as const;

/** Routes a node calls as itself. Every request is signed with the node's key. */
const nodeRoutes: FastifyPluginAsync<RouteOptions> = async function (fastify, { service }) {
    fastify.addHook('preValidation', authenticateNode);

    // A node calls this at startup to learn its organization, enrolling with a dashboard token the first time.
    fastify.post<{ Body: { enrollmentToken?: string } }>('/nodes/session', { schema: { body: sessionSchema } }, async (request) => {
        return service.organizations.session(request.nodePublicKey!, request.body?.enrollmentToken);
    });
};

export default nodeRoutes;
