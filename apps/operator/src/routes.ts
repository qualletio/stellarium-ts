import type { FastifyPluginAsync } from 'fastify';
import type { Service } from './service.js';

interface RouteOptions {
    service: Service;
}

/**
 * Encapsulates the routes
 * @param fastify Encapsulated Fastify Instance
 * @param options plugin options, refer to https://fastify.dev/docs/latest/Reference/Plugins/#plugin-options
 */
const routes: FastifyPluginAsync<RouteOptions> = async function (fastify, options) {

    // Start Meta Routes

    fastify.get('/', async (request, reply) => {
        return { hello: 'world' }
    });
}

// ESM
export default routes;
