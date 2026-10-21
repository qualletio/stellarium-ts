import { Keypair } from '@solana/web3.js';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { OperationError } from './errors.js';
import routes from './routes.js';
import type { Service } from './service.js';
import { signedInferenceVoucher, signedVoucher } from './testing.js';

describe('operator routes', () => {
    let fastify: FastifyInstance;
    let service: { escrowService: Record<string, ReturnType<typeof vi.fn>>; paymentService: Record<string, ReturnType<typeof vi.fn>> };

    beforeEach(async () => {
        service = {
            escrowService: {
                initiateEscrow: vi.fn().mockResolvedValue({ escrowAddress: 'escrow', status: 'unsigned', transaction: 'tx' }),
                accruePayment: vi.fn().mockResolvedValue({ escrowAddress: 'escrow', status: 'accrued' }),
            },
            paymentService: { verifyPayment: vi.fn().mockResolvedValue(undefined) },
        };
        fastify = Fastify();
        await fastify.register(routes, { prefix: '/v1', service: service as unknown as Service });
        await fastify.ready();
    });

    afterEach(async () => {
        await fastify.close();
    });

    describe('POST /v1/payment', () => {
        const pay = (payload: unknown) => fastify.inject({ method: 'POST', url: '/v1/payment', payload: payload as object });

        test('verifies, then accrues with 202', async () => {
            const submission = signedVoucher();
            const response = await pay(submission);

            expect(response.statusCode).toBe(202);
            expect(response.json()).toEqual({ escrowAddress: 'escrow', status: 'accrued' });
            expect(service.paymentService.verifyPayment).toHaveBeenCalledWith(submission);
            expect(service.escrowService.accruePayment).toHaveBeenCalledWith(submission);
        });

        test.each([
            ['no voucher', {}],
            ['a missing field', (() => { const { voucher } = signedVoucher(); const { signature: _, ...rest } = voucher; return { voucher: rest }; })()],
            ['a zero amount', signedVoucher(undefined, { amount: 0 })],
            ['a negative amount', signedVoucher(undefined, { amount: -5 })],
            ['a fractional amount', signedVoucher(undefined, { amount: 1.5 })],
            ['an amount beyond the safe integer range', signedVoucher(undefined, { amount: 2 ** 60 })],
        ])('rejects %s with 400 before reaching the service', async (_, payload) => {
            const response = await pay(payload);

            expect(response.statusCode).toBe(400);
            expect(service.paymentService.verifyPayment).not.toHaveBeenCalled();
        });

        test('accepts an inference voucher with its usage', async () => {
            const submission = signedInferenceVoucher();
            const response = await pay(submission);

            expect(response.statusCode).toBe(202);
            expect(service.escrowService.accruePayment).toHaveBeenCalledWith(submission);
        });

        test.each([
            ['an inference voucher without usage', { voucher: signedInferenceVoucher().voucher }],
            ['fractional usage', signedInferenceVoucher(undefined, {}, { inputTokens: 1.5, outputTokens: 1 })],
            ['negative usage', signedInferenceVoucher(undefined, {}, { inputTokens: 1, outputTokens: -1 })],
            ['a negative rate', signedInferenceVoucher(undefined, { inputCostMicroUsdcPerMillionTokens: -1 })],
            ['a zero maxAmount', signedInferenceVoucher(undefined, { maxAmount: 0 })],
            ['an unknown kind', (() => { const submission = signedInferenceVoucher(); return { ...submission, voucher: { ...submission.voucher, kind: 'other' } }; })()],
            ['a fixed voucher with a kind', (() => { const submission = signedVoucher(); return { voucher: { ...submission.voucher, kind: 'inference' } }; })()],
        ])('rejects %s with 400 before reaching the service', async (_, payload) => {
            const response = await pay(payload);

            expect(response.statusCode).toBe(400);
            expect(service.paymentService.verifyPayment).not.toHaveBeenCalled();
        });

        test('keeps an OperationError status so the node does not retry it', async () => {
            service.paymentService.verifyPayment!.mockRejectedValue(new OperationError(409, 'Voucher has already been accepted'));

            const response = await pay(signedVoucher());

            expect(response.statusCode).toBe(409);
            expect(response.json()).toEqual({ error: 'Voucher has already been accepted' });
            expect(service.escrowService.accruePayment).not.toHaveBeenCalled();
        });

        test('answers 500 for unexpected errors', async () => {
            service.escrowService.accruePayment!.mockRejectedValue(new Error('RPC down'));

            const response = await pay(signedVoucher());

            expect(response.statusCode).toBe(500);
            expect(response.json()).toMatchObject({ details: 'RPC down' });
        });
    });

    describe('POST /v1/escrow', () => {
        const user = Keypair.generate().publicKey.toBase58();
        const create = (payload: object = { user }) =>
            fastify.inject({ method: 'POST', url: '/v1/escrow', payload });

        test('returns the unsigned creation transaction without a token', async () => {
            const response = await create();

            expect(response.statusCode).toBe(200);
            expect(response.json()).toEqual({ escrowAddress: 'escrow', status: 'unsigned', transaction: 'tx' });
            expect(service.escrowService.initiateEscrow).toHaveBeenCalledOnce();
        });

        test('rejects a missing user', async () => {
            expect((await create({})).statusCode).toBe(400);
            expect(service.escrowService.initiateEscrow).not.toHaveBeenCalled();
        });

        test('rejects a user that is not a Solana address', async () => {
            const response = await create({ user: 'not-a-key' });

            expect(response.statusCode).toBe(400);
            expect(response.json()).toEqual({ error: 'Invalid public key' });
        });
    });
});
