import type { FastifyPluginAsync } from 'fastify';
import { OperationError } from '../errors.js';
import type { Service } from '../service.js';
import { StripeRequestError } from '../stripe/gateway.js';
import authRoutes from './auth.js';
import dashboardRoutes from './dashboard.js';
import nodeRoutes from './nodes.js';
import oauthRoutes from './oauth.js';
import paymentRoutes from './payments.js';
import runRoutes from './runs.js';
import stripeRoutes from './stripe.js';

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
        if (error instanceof StripeRequestError) {
            // Stripe's message names the platform's account and key, so the caller gets a summary.
            fastify.log.error(error);
            return reply.status(error.definitive ? 502 : 503).send({ error: stripeFailure(error) });
        }
        fastify.log.error(error);
        return reply.status(500).send({ error: 'Internal error', details: error instanceof Error ? error.message : undefined });
    });

    fastify.get('/', async () => ({ hello: 'world' }));

    await fastify.register(nodeRoutes, { service });
    await fastify.register(paymentRoutes, { service });
    await fastify.register(runRoutes, { service });
    await fastify.register(oauthRoutes, { service });
    if (service.auth) {
        await fastify.register(authRoutes, { auth: service.auth });
    }
    if (service.dashboardAuthenticator) {
        await fastify.register(dashboardRoutes, { service, authenticator: service.dashboardAuthenticator });
    }
    if (service.stripe && service.webhooks) {
        const { gateway, webhookSecret, connectWebhookSecret } = service.stripe;
        await fastify.register(stripeRoutes, { gateway, webhooks: service.webhooks, webhookSecret, connectWebhookSecret });
    }
};

function stripeFailure(error: StripeRequestError): string {
    if (error.type === 'StripePermissionError' || error.type === 'StripeAuthenticationError') {
        return "Stripe refused the operator's API key for this request. The operator's logs name the permission it needs.";
    }
    if (error.definitive) return "Stripe refused the request. The operator's logs have the details.";
    return 'Stripe could not be reached. Try again in a moment.';
}

export default routes;
