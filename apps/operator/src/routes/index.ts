import type { FastifyPluginAsync } from 'fastify';
import { OperationError } from '../errors.js';
import type { Service } from '../service.js';
import nodeRoutes from './nodes.js';
import paymentRoutes from './payments.js';

export interface RouteOptions {
    service: Service;
}

const routes: FastifyPluginAsync<RouteOptions> = async function (fastify, { service }) {
    // Rejections keep their status so callers only retry unexpected (500) failures.
    fastify.setErrorHandler((error, request, reply) => {
        if (error instanceof OperationError) {
            fastify.log.warn({ statusCode: error.statusCode }, error.message);
            return reply.status(error.statusCode).send({ error: error.message });
        }
        const validation = (error as { validation?: unknown }).validation;
        if (validation) {
            return reply.status(400).send({ error: (error as Error).message });
        }
        fastify.log.error(error);
        return reply.status(500).send({ error: 'Internal error', details: error instanceof Error ? error.message : undefined });
    });

    fastify.get('/', async () => ({ hello: 'world' }));

    await fastify.register(nodeRoutes, { service });
    await fastify.register(paymentRoutes, { service });
};

export default routes;
