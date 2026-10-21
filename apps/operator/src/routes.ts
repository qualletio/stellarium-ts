import { PublicKey } from '@solana/web3.js';
import type { FastifyPluginAsync, FastifyReply } from 'fastify';
import type { OperationResult } from './escrow/escrowService.js';
import { OperationError } from './errors.js';
import type { Service } from './service.js';

interface RouteOptions {
    service: Service;
}

// Wire formats match PaymentVoucher and InferencePaymentVoucher in stellarium-ts/resource/invoker.ts,
// and PaymentSubmission in stellarium-ts/client/operatorClient.ts.
export type PaymentSubmission = FixedPaymentSubmission | InferencePaymentSubmission;

export interface FixedPaymentSubmission {
    voucher: {
        kind?: undefined;
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

/** An inference voucher signs rates instead of an amount. The provider reports the call's usage beside it. */
export interface InferencePaymentSubmission {
    voucher: {
        kind: 'inference';
        requestId: string;
        invocationId: string;
        maxAmount: number;
        inputCostMicroUsdcPerMillionTokens: number;
        outputCostMicroUsdcPerMillionTokens: number;
        maxTokens: number;
        recipientAddress: string;
        signature: string;
        expiresAt: string;
        invocationHash: string;
        publicKey: string;
    };
    usage: {
        inputTokens: number;
        outputTokens: number;
    };
}

const nonEmptyString = { type: 'string', minLength: 1, maxLength: 255 } as const;
const amount = { type: 'integer', minimum: 1, maximum: Number.MAX_SAFE_INTEGER } as const;
const count = { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER } as const;

// Fastify answers 400 for bodies that don't match, before anything reaches the service, so a
// malformed voucher is a rejection rather than a 500 that the node would retry. If Fastify coerces
// a type (a numeric string amount), the signed payload no longer matches and verification fails.
// An inference voucher has `kind` and no `amount`, so at most one shape matches.
const paymentSchema = {
    oneOf: [
        {
            type: 'object',
            required: ['voucher'],
            properties: {
                voucher: {
                    type: 'object',
                    required: ['requestId', 'invocationId', 'amount', 'recipientAddress', 'signature', 'expiresAt', 'invocationHash', 'publicKey'],
                    properties: {
                        requestId: nonEmptyString,
                        invocationId: nonEmptyString,
                        amount,
                        recipientAddress: nonEmptyString,
                        signature: nonEmptyString,
                        expiresAt: nonEmptyString,
                        invocationHash: nonEmptyString,
                        publicKey: nonEmptyString,
                    },
                    not: { required: ['kind'] },
                },
            },
        },
        {
            type: 'object',
            required: ['voucher', 'usage'],
            properties: {
                voucher: {
                    type: 'object',
                    required: ['kind', 'requestId', 'invocationId', 'maxAmount', 'inputCostMicroUsdcPerMillionTokens', 'outputCostMicroUsdcPerMillionTokens', 'maxTokens', 'recipientAddress', 'signature', 'expiresAt', 'invocationHash', 'publicKey'],
                    properties: {
                        kind: { const: 'inference' },
                        requestId: nonEmptyString,
                        invocationId: nonEmptyString,
                        maxAmount: amount,
                        inputCostMicroUsdcPerMillionTokens: count,
                        outputCostMicroUsdcPerMillionTokens: count,
                        maxTokens: { type: 'integer', minimum: 1, maximum: 2_147_483_647 },
                        recipientAddress: nonEmptyString,
                        signature: nonEmptyString,
                        expiresAt: nonEmptyString,
                        invocationHash: nonEmptyString,
                        publicKey: nonEmptyString,
                    },
                },
                usage: {
                    type: 'object',
                    required: ['inputTokens', 'outputTokens'],
                    properties: { inputTokens: count, outputTokens: count },
                },
            },
        },
    ],
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


/** An uncertain or accrued submission is accepted but not confirmed. */
function sendResult(reply: FastifyReply, result: OperationResult) {
    return reply.status(result.status === 'unconfirmed' || result.status === 'accrued' ? 202 : 200).send(result);
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
        return reply.status(500).send({ error: 'Failed to verify and accept payment', details: error instanceof Error ? error.message : undefined });
    });

    fastify.get('/', async () => ({ hello: 'world' }));

    // Open to anyone: the operator only builds the transaction, and the user signs it and pays its rent and fees.
    fastify.post('/escrow', { schema: { body: escrowSchema } }, async (request, reply) => {
        const { user } = request.body as { user: string };
        return sendResult(reply, await service.escrowService.initiateEscrow(publicKey(user)));
    });

    // Authenticated by the voucher signature, not a token.
    fastify.post<{ Body: PaymentSubmission }>('/payment', { schema: { body: paymentSchema } }, async (request, reply) => {
        // First verify the payment submission.
        await service.paymentService.verifyPayment(request.body);
        return sendResult(reply, await service.escrowService.accruePayment(request.body));
    });
};

export default routes;
