import { PublicKey } from '@solana/web3.js';
import type { FastifyPluginAsync } from 'fastify';
import { OperationError } from './errors.js';
import type { Service } from './service.js';

interface RouteOptions {
    service: Service;
}

// Wire formats match PaymentVoucher in stellarium-ts/resource/invoker.ts and
// StellariumResourceFunctionPaymentManifest in resource/repository.ts.
export interface PaymentSubmission {
    voucher: {
        requestId: string; 
        invocationId: string; 
        amount: number;
        recipientAddress: string; 
        signature: string; 
        expiresAt: string; 
        invocationHash: string;
        publicKey: string;
    };
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
        try {
            await service.paymentService.verifyPayment(body);
            return await service.escrowService.settlePayment(body);
        } catch (error) {
            fastify.log.error(error);
            return reply.status(500).send({ error: 'Failed to verify and settle payment', details: error instanceof Error ? error.message : undefined });
        }
    });
};

export default routes;
