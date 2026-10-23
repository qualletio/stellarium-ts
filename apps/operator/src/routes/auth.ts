import type { FastifyPluginAsync } from 'fastify';
import { AUTH_BASE_PATH, type Auth } from '../auth/betterAuth.js';
import { requestHeaders } from '../auth/dashboardAuth.js';

/**
 * Better Auth's endpoints, at `/v1/auth/*`. The dashboard forwards its `/api/auth/*` here, so cookies are set on
 * the dashboard's domain. Bodies are passed through unparsed.
 */
const authRoutes: FastifyPluginAsync<{ auth: Auth }> = async function (fastify, { auth }) {
    fastify.removeAllContentTypeParsers();
    fastify.addContentTypeParser('*', { parseAs: 'buffer' }, (_request, body, done) => done(null, body));

    fastify.route({
        method: ['GET', 'POST'],
        url: '/auth/*',
        // Requests arrive through the dashboard, from one address. Better Auth limits them per client instead.
        config: { rateLimit: false },
        handler: async (request, reply) => {
            // The path after `/auth`, with its query, under the base path Better Auth expects.
            const rest = request.url.slice(request.url.indexOf('/auth/') + '/auth'.length);
            const response = await auth.handler(new Request(new URL(`${AUTH_BASE_PATH}${rest}`, auth.options.baseURL), {
                method: request.method,
                headers: requestHeaders(request),
                body: Buffer.isBuffer(request.body) && request.body.length > 0 ? request.body : undefined,
            }));
            reply.status(response.status);
            response.headers.forEach((value, name) => {
                if (name !== 'set-cookie') reply.header(name, value);
            });
            const cookies = response.headers.getSetCookie();
            if (cookies.length > 0) reply.header('set-cookie', cookies);
            return reply.send(response.body ? Buffer.from(await response.arrayBuffer()) : null);
        },
    });
};

export default authRoutes;
