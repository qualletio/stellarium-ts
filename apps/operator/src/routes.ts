import { createHash, timingSafeEqual } from 'node:crypto';
import { PublicKey } from '@solana/web3.js';
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import type { OperationResult } from './escrow/escrowService.js';
import { OperationError } from './errors.js';
import type { Service } from './service.js';

interface RouteOptions {
    service: Service;
    /** Bearer token required by `POST /escrow`. When unset, escrow creation is refused. */
    apiToken?: string;
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

const nonEmptyString = { type: 'string', minLength: 1, maxLength: 255 } as const;

// Fastify answers 400 for bodies that don't match, before anything reaches the service, so a
// malformed voucher is a rejection rather than a 500 that the node would retry. If Fastify coerces
// a type (a numeric string amount), the signed payload no longer matches and verification fails.
const paymentSchema = {
    type: 'object',
    required: ['voucher'],
    properties: {
        voucher: {
            type: 'object',
            required: ['requestId', 'invocationId', 'amount', 'recipientAddress', 'signature', 'expiresAt', 'invocationHash', 'publicKey'],
            properties: {
                requestId: nonEmptyString,
                invocationId: nonEmptyString,
                amount: { type: 'integer', minimum: 1, maximum: Number.MAX_SAFE_INTEGER },
                recipientAddress: nonEmptyString,
                signature: nonEmptyString,
                expiresAt: nonEmptyString,
                invocationHash: nonEmptyString,
                publicKey: nonEmptyString,
            },
        },
    },
} as const;

const escrowSchema = {
    type: 'object',
    required: ['user'],
    properties: { user: nonEmptyString },
} as const;

function publicKey(value: string): PublicKey {
    try { return new PublicKey(value); }
    catch { throw new OperationError(400, 'Invalid public key'); }
}

/** Constant-time comparison. Hashing first gives equal-length buffers for timingSafeEqual. */
function secretsEqual(a: string, b: string): boolean {
    const digest = (value: string) => createHash('sha256').update(value).digest();
    return timingSafeEqual(digest(a), digest(b));
}

/** An uncertain submission is accepted but not confirmed. */
function sendResult(reply: FastifyReply, result: OperationResult) {
    return reply.status(result.status === 'unconfirmed' ? 202 : 200).send(result);
}

const routes: FastifyPluginAsync<RouteOptions> = async function (fastify, { service, apiToken }) {
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
        return reply.status(500).send({ error: 'Failed to verify and settle payment', details: error instanceof Error ? error.message : undefined });
    });

    async function requireApiToken(request: FastifyRequest, reply: FastifyReply) {
        const [scheme, token] = (request.headers.authorization ?? '').split(' ');
        if (!apiToken || scheme !== 'Bearer' || !token || !secretsEqual(token, apiToken)) {
            return reply.status(401).send({ error: 'Missing or invalid bearer token' });
        }
    }

    fastify.get('/', async () => ({ hello: 'world' }));

    // The operator pays rent for every escrow it creates, so creation is limited to token holders.
    fastify.post('/escrow', { schema: { body: escrowSchema }, preValidation: requireApiToken }, async (request, reply) => {
        const { user } = request.body as { user: string };
        return sendResult(reply, await service.escrowService.initiateEscrow(publicKey(user)));
    });

    // Authenticated by the voucher signature, not a token.
    fastify.post<{ Body: PaymentSubmission }>('/payment', { schema: { body: paymentSchema } }, async (request, reply) => {
        // First verify the payment submission.
        await service.paymentService.verifyPayment(request.body);
        return sendResult(reply, await service.escrowService.settlePayment(request.body));
    });
};

export default routes;
