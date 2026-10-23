import type { FastifyPluginAsync } from 'fastify';
import { OperationError } from '../errors.js';
import type { StripeGateway } from '../stripe/gateway.js';
import type { StripeWebhookService } from '../stripe/webhooks.js';

export interface StripeRouteOptions {
    gateway: StripeGateway;
    webhooks: StripeWebhookService;
    /** Signing secret of the endpoint for the platform account's events. */
    webhookSecret: string;
    /** Signing secret of the endpoint for connected accounts' events. */
    connectWebhookSecret: string;
}

/**
 * Stripe webhook endpoints. Stripe signs the raw body, so this plugin keeps JSON bodies as buffers.
 * Each endpoint has its own signing secret.
 */
const stripeRoutes: FastifyPluginAsync<StripeRouteOptions> = async function (fastify, { gateway, webhooks, webhookSecret, connectWebhookSecret }) {
    fastify.addContentTypeParser('application/json', { parseAs: 'buffer' }, (_request, body, done) => done(null, body));

    const endpoint = (secret: string) => async (request: { body: unknown, headers: Record<string, string | string[] | undefined> }) => {
        const signature = request.headers['stripe-signature'];
        if (typeof signature !== 'string' || !Buffer.isBuffer(request.body)) {
            throw new OperationError(400, 'Missing Stripe signature');
        }
        let event;
        try {
            event = gateway.constructEvent(request.body, signature, secret);
        } catch {
            throw new OperationError(400, 'Invalid Stripe signature');
        }
        await webhooks.handle(event);
        return { received: true };
    };

    // Exempt from the per-IP rate limit: Stripe delivers bursts from a few addresses, and the signature already authenticates.
    fastify.post('/stripe/webhook', { config: { rateLimit: false } }, endpoint(webhookSecret));
    fastify.post('/stripe/connect-webhook', { config: { rateLimit: false } }, endpoint(connectWebhookSecret));
};

export default stripeRoutes;
