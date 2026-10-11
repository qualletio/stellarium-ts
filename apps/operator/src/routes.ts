import { PublicKey } from '@solana/web3.js';
import type { FastifyPluginAsync } from 'fastify';
import { OperationError } from './errors.js';
import type { Service } from './service.js';

interface RouteOptions {
    service: Service;
    apiToken: string;
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
        publicKey: string;
    };
    // These fields are signed by createPaymentVoucher but absent from its result.
    resourcePath: string;
    resourceName: string;
    parameters: unknown[];
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
