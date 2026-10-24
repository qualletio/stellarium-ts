import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { OperationError } from '../errors.js';
import type { RouteOptions } from './index.js';

interface TokenRequest {
    grant_type?: string;
    client_id?: string;
    client_secret?: string;
}

/** The client credentials, from HTTP Basic authentication or else the body (RFC 6749 §2.3.1). */
function clientCredentials(request: FastifyRequest<{ Body: TokenRequest }>): { id?: string, secret?: string, basic: boolean } {
    const [scheme, encoded] = (request.headers.authorization ?? '').split(' ');
    if (scheme?.toLowerCase() === 'basic' && encoded) {
        const decoded = Buffer.from(encoded, 'base64').toString();
        const separator = decoded.indexOf(':');
        if (separator > 0) {
            try {
                return { id: decodeURIComponent(decoded.slice(0, separator)), secret: decodeURIComponent(decoded.slice(separator + 1)), basic: true };
            } catch {
                return { basic: true };
            }
        }
        return { basic: true };
    }
    return { id: request.body?.client_id, secret: request.body?.client_secret, basic: false };
}

/** An OAuth error response (RFC 6749 §5.2). */
function oauthError(reply: FastifyReply, status: number, error: string, description: string, basic = false) {
    if (status === 401 && basic) reply.header('WWW-Authenticate', 'Basic realm="stellarium"');
    return reply.status(status).header('Cache-Control', 'no-store').send({ error, error_description: description });
}

/**
 * Where API clients get run tokens, and where nodes get the keys to verify them. Neither is signed by a node.
 */
const oauthRoutes: FastifyPluginAsync<RouteOptions> = async function (fastify, { service }) {
    // OAuth clients send form-encoded token requests. Scoped to these routes.
    fastify.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string' }, (_request, body, done) => {
        done(null, Object.fromEntries(new URLSearchParams(body as string)));
    });

    /** The OAuth 2.0 client credentials grant. The token runs scripts on the client's node until it expires. */
    fastify.post<{ Body: TokenRequest }>('/oauth/token', async (request, reply) => {
        if (request.body?.grant_type !== 'client_credentials') {
            return oauthError(reply, 400, 'unsupported_grant_type', 'Only the client_credentials grant is supported');
        }
        const { id, secret, basic } = clientCredentials(request);
        if (!id || !secret) {
            return oauthError(reply, 401, 'invalid_client', 'Client credentials are required', basic);
        }
        try {
            const { token, expiresIn } = await service.clients.issueToken(id, secret);
            return reply.header('Cache-Control', 'no-store').send({ access_token: token, token_type: 'Bearer', expires_in: expiresIn });
        } catch (error) {
            if (!(error instanceof OperationError)) throw error;
            if (error.statusCode === 401) return oauthError(reply, 401, 'invalid_client', error.message, basic);
            if (error.statusCode === 403) return oauthError(reply, 400, 'unauthorized_client', error.message);
            return oauthError(reply, error.statusCode, 'temporarily_unavailable', error.message);
        }
    });

    // Nodes cache these keys to verify run tokens offline.
    fastify.get('/.well-known/jwks.json', async (_request, reply) => {
        if (!service.runTokens) throw new OperationError(404, 'Run tokens are not configured on this operator');
        return reply.header('Cache-Control', 'public, max-age=300').send(await service.runTokens.jwks());
    });
};

export default oauthRoutes;
