import { PublicKey } from '@solana/web3.js';
import type { FastifyPluginAsync } from 'fastify';
import type { PaymentSubmission } from './payment.js';
import type { Service } from './service.js';
import { OperationError } from './errors.js';

interface RouteOptions {
    service: Service;
    apiToken: string;
}

function publicKey(value: string): PublicKey {
    try { return new PublicKey(value); }
    catch { throw new OperationError(400, 'Invalid public key'); }
}

const routes: FastifyPluginAsync<RouteOptions> = async function (fastify, { service }) {
    fastify.get('/', async () => ({ hello: 'world' }));

    fastify.post('/escrow', async (request, reply) => {
        const { user } = request.body as { user: string };
        return service.escrowService.initiateEscrow(publicKey(user));
    });

    fastify.post<{ Body: PaymentSubmission }>('/payment', async (request, reply) => {
        const body = request.body as PaymentSubmission;
        // First verify the payment submission.
        await service.paymentService.verifyPayment(body);
        // Then settle the payment.
        return service.escrowService.settlePayment(body);
    });
};

export default routes;
