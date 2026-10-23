import type { FastifyPluginAsync } from 'fastify';
import { authenticateNode } from '../auth/nodeAuth.js';
import type { PaymentSubmission, Voucher } from '../payments/types.js';
import type { RouteOptions } from './index.js';

const nonEmptyString = { type: 'string', minLength: 1, maxLength: 255 } as const;
const amount = { type: 'integer', minimum: 1, maximum: Number.MAX_SAFE_INTEGER } as const;
const count = { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER } as const;

const fixedVoucherSchema = {
    type: 'object',
    required: ['requestId', 'invocationId', 'amount', 'recipientOrganizationId', 'signature', 'expiresAt', 'invocationHash', 'publicKey'],
    properties: {
        requestId: nonEmptyString,
        invocationId: nonEmptyString,
        amount,
        recipientOrganizationId: nonEmptyString,
        signature: nonEmptyString,
        expiresAt: nonEmptyString,
        invocationHash: nonEmptyString,
        publicKey: nonEmptyString,
    },
    not: { required: ['kind'] },
} as const;

const inferenceVoucherSchema = {
    type: 'object',
    required: ['kind', 'requestId', 'invocationId', 'maxAmount', 'inputCostMicroUsdPerMillionTokens', 'outputCostMicroUsdPerMillionTokens', 'maxTokens', 'recipientOrganizationId', 'signature', 'expiresAt', 'invocationHash', 'publicKey'],
    properties: {
        kind: { const: 'inference' },
        requestId: nonEmptyString,
        invocationId: nonEmptyString,
        maxAmount: count,
        inputCostMicroUsdPerMillionTokens: count,
        outputCostMicroUsdPerMillionTokens: count,
        maxTokens: { type: 'integer', minimum: 1, maximum: 2_147_483_647 },
        recipientOrganizationId: nonEmptyString,
        signature: nonEmptyString,
        expiresAt: nonEmptyString,
        invocationHash: nonEmptyString,
        publicKey: nonEmptyString,
    },
} as const;

const usageSchema = {
    type: 'object',
    required: ['inputTokens', 'outputTokens'],
    properties: { inputTokens: count, outputTokens: count },
} as const;

// Fastify answers 400 for bodies that don't match, before anything reaches the service, so a
// malformed voucher is a rejection rather than a 500 that the node would retry. If Fastify coerces
// a type (a numeric string amount), the signed payload no longer matches and verification fails.
// An inference voucher has `kind` and no `amount`, so at most one shape matches.
const voucherBodySchema = {
    type: 'object',
    required: ['voucher'],
    properties: { voucher: { oneOf: [fixedVoucherSchema, inferenceVoucherSchema] } },
} as const;

/** Capture carries an inference call's usage beside its voucher. */
const captureSchema = {
    oneOf: [
        { type: 'object', required: ['voucher'], properties: { voucher: fixedVoucherSchema } },
        { type: 'object', required: ['voucher', 'usage'], properties: { voucher: inferenceVoucherSchema, usage: usageSchema } },
    ],
} as const;

/**
 * A provider node authorizes a voucher before running a paid call, then captures or releases it.
 * Requests are signed by the provider node; the voucher inside is signed by the payer.
 */
const paymentRoutes: FastifyPluginAsync<RouteOptions> = async function (fastify, { service }) {
    fastify.addHook('preValidation', authenticateNode);

    fastify.post<{ Body: { voucher: Voucher } }>('/payments/authorize', { schema: { body: voucherBodySchema } }, async (request) => {
        return service.payments.authorize(request.nodePublicKey!, request.body.voucher);
    });

    fastify.post<{ Body: PaymentSubmission }>('/payments/capture', { schema: { body: captureSchema } }, async (request) => {
        return service.payments.capture(request.nodePublicKey!, request.body);
    });

    fastify.post<{ Body: { voucher: Voucher } }>('/payments/release', { schema: { body: voucherBodySchema } }, async (request) => {
        return service.payments.release(request.nodePublicKey!, request.body.voucher);
    });
};

export default paymentRoutes;
