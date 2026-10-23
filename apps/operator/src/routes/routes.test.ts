import Fastify, { type FastifyInstance } from 'fastify';
import { CombinationResourceInvoker, operatorAuthorization } from 'stellarium-ts';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import type { Database } from '../db/database.js';
import type { OrganizationService } from '../organizations.js';
import { createService } from '../service.js';
import {
    createTestDatabase, generateNodeKeys, nodeAuthorization, type NodeKeys, PAYER_ORGANIZATION, PROVIDER_ORGANIZATION, seedOrganizations, signedInferenceVoucher, signedVoucher,
} from '../testing.js';
import routes from './index.js';

describe('operator routes', () => {
    let db: Database;
    let close: () => Promise<void>;
    let fastify: FastifyInstance;
    let organizations: OrganizationService;
    let provider: NodeKeys;
    let payer: NodeKeys;

    beforeEach(async () => {
        ({ db, close } = await createTestDatabase());
        ({ organizations, provider, payer } = await seedOrganizations(db, 100_000));
        fastify = Fastify();
        await fastify.register(routes, { prefix: '/v1', service: createService(db, { platformFeeBps: 2000 }) });
        await fastify.ready();
    });

    afterEach(async () => {
        await fastify.close();
        await close();
    });

    /** POSTs `body` as the node with `keys`, signed with `authorization` (the stellarium-ts signer by default). */
    function post(path: string, body: unknown, keys: NodeKeys, authorization = operatorAuthorization('POST', `http://operator${path}`, body, keys.publicKey, keys.privateKey)) {
        return fastify.inject({ method: 'POST', url: path, payload: body as object, headers: { authorization } });
    }

    describe('node authentication', () => {
        const body = { voucher: signedVoucher().voucher };

        test('accepts a request signed by stellarium-ts\'s operatorAuthorization', async () => {
            // A voucher from an unenrolled payer gets past authentication to the payment checks.
            const response = await post('/v1/payments/authorize', body, provider);
            expect(response.statusCode).toBe(402);
        });

        test.each([
            ['no header', () => ''],
            ['another scheme', () => 'Bearer token'],
            ['a malformed credential', () => 'Stellarium not-json'],
            ['a signature over a different path', () => nodeAuthorization(provider, 'POST', '/v1/payments/release', body)],
            ['a signature over a different body', () => nodeAuthorization(provider, 'POST', '/v1/payments/authorize', { voucher: { ...body.voucher, amount: 1 } })],
            ['a stale timestamp', () => nodeAuthorization(provider, 'POST', '/v1/payments/authorize', body, new Date(Date.now() - 6 * 60_000).toISOString())],
            ['a signature by another key', () => nodeAuthorization(provider, 'POST', '/v1/payments/authorize', body).replace(/^Stellarium (.*)$/, (_, encoded) => {
                const credentials = JSON.parse(Buffer.from(encoded, 'base64url').toString());
                return `Stellarium ${Buffer.from(JSON.stringify({ ...credentials, publicKey: payer.publicKey })).toString('base64url')}`;
            })],
        ])('refuses %s with 401', async (_, authorization) => {
            const response = await post('/v1/payments/authorize', body, provider, authorization());

            expect(response.statusCode).toBe(401);
        });
    });

    describe('POST /v1/nodes/session', () => {
        test('returns an enrolled node\'s organization', async () => {
            const response = await post('/v1/nodes/session', {}, provider);

            expect(response.statusCode).toBe(200);
            expect(response.json()).toEqual({ organizationId: PROVIDER_ORGANIZATION });
        });

        test('enrolls a new node with a one-time token', async () => {
            const { token } = await organizations.createEnrollmentToken(PAYER_ORGANIZATION, { label: 'second caller' });
            const node = generateNodeKeys();

            expect(await post('/v1/nodes/session', {}, node).then(r => r.statusCode)).toBe(403);
            const enrolled = await post('/v1/nodes/session', { enrollmentToken: token }, node);
            expect(enrolled.json()).toEqual({ organizationId: PAYER_ORGANIZATION });
            expect(await organizations.getNode(node.publicKey)).toMatchObject({ organizationId: PAYER_ORGANIZATION, label: 'second caller' });

            // Used up: it can't enroll another node.
            const reused = await post('/v1/nodes/session', { enrollmentToken: token }, generateNodeKeys());
            expect(reused.statusCode).toBe(403);
            expect(reused.json().error).toContain('invalid, used or expired');
        });

        test('refuses an expired token', async () => {
            const { token } = await organizations.createEnrollmentToken(PAYER_ORGANIZATION, { lifetimeMs: -1 });

            expect((await post('/v1/nodes/session', { enrollmentToken: token }, generateNodeKeys())).statusCode).toBe(403);
        });

        test('keeps an enrolled node in its organization when it presents another token', async () => {
            const { token } = await organizations.createEnrollmentToken(PAYER_ORGANIZATION);

            const response = await post('/v1/nodes/session', { enrollmentToken: token }, provider);

            expect(response.json()).toEqual({ organizationId: PROVIDER_ORGANIZATION });
        });
    });

    describe('payments', () => {
        test('authorizes, then captures a voucher made by the stellarium-ts node', async () => {
            const invoker = new CombinationResourceInvoker(undefined as never, 100_000, payer.publicKey, payer.privateKey);
            const voucher = invoker.createPaymentVoucher(PROVIDER_ORGANIZATION, 10_000, 'com.example', 'Weather', 'temperature', [{ name: 'city', value: 'Oslo' }]);

            const authorized = await post('/v1/payments/authorize', { voucher }, provider);
            expect(authorized.statusCode).toBe(200);
            expect(authorized.json()).toEqual({ status: 'held', heldMicroUsd: 10_000 });

            const captured = await post('/v1/payments/capture', { voucher }, provider);
            expect(captured.json()).toEqual({ status: 'captured', amountMicroUsd: 10_000 });
            expect(await organizations.get(PROVIDER_ORGANIZATION)).toMatchObject({ payableMicroUsd: 8_000 });
        });

        test('captures inference usage and releases a hold', async () => {
            const inference = signedInferenceVoucher(payer);
            await post('/v1/payments/authorize', { voucher: inference.voucher }, provider);
            expect((await post('/v1/payments/capture', inference, provider)).json()).toEqual({ status: 'captured', amountMicroUsd: 10_500 });

            const { voucher } = signedVoucher(payer);
            await post('/v1/payments/authorize', { voucher }, provider);
            expect((await post('/v1/payments/release', { voucher }, provider)).json()).toEqual({ status: 'released' });
        });

        test('answers 402 for an insufficient balance', async () => {
            const response = await post('/v1/payments/authorize', signedVoucher(payer, { amount: 100_001 }), provider);

            expect(response.statusCode).toBe(402);
            expect(response.json().error).toContain('Insufficient balance');
        });

        test.each([
            ['no voucher', {}],
            ['a missing field', (() => { const { voucher } = signedVoucher(); const { signature: _, ...rest } = voucher; return { voucher: rest }; })()],
            ['a zero amount', signedVoucher(undefined, { amount: 0 })],
            ['a fractional amount', signedVoucher(undefined, { amount: 1.5 })],
            ['an amount beyond the safe integer range', signedVoucher(undefined, { amount: 2 ** 60 })],
        ])('rejects %s with 400', async (_, payload) => {
            const response = await post('/v1/payments/authorize', payload, provider);

            expect(response.statusCode).toBe(400);
        });

        test('rejects an inference capture without usage', async () => {
            const { voucher } = signedInferenceVoucher(payer);

            expect((await post('/v1/payments/capture', { voucher }, provider)).statusCode).toBe(400);
        });
    });
});
