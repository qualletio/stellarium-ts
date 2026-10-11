import { test } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { PublicKey } from '@solana/web3.js';
import routes from '../dist/routes.js';
import { OperationError } from '../dist/service.js';

const user = new PublicKey(new Uint8Array(32).fill(3)).toBase58();
const token = 'test-operator-token';
async function appFor(t, initiateEscrow) {
    const app = Fastify({ ajv: { customOptions: { removeAdditional: false, coerceTypes: false } } });
    app.register(routes, { prefix: '/v1', apiToken: token, service: {
        initiateEscrow,
        async withdrawEscrow() { assert.fail('Provider payload must not directly authorize withdrawal'); },
        async settlePayment() { return { status: 'confirmed', escrowAddress: user, signature: 'payment-signature' }; },
    } });
    t.after(() => app.close());
    return app;
}
const headers = { authorization: `Bearer ${token}` };

test('escrow validates user and returns confirmed address and signature', async t => {
    const app = await appFor(t, async actualUser => {
        assert.equal(actualUser.toBase58(), user);
        return { status: 'confirmed', escrowAddress: user, signature: 'signature' };
    });
    const response = await app.inject({ method: 'POST', url: '/v1/escrow', headers, payload: { user } });
    assert.equal(response.statusCode, 201);
    assert.equal(response.json().signature, 'signature');
});

test('escrow initiation rejects missing and incorrect bearer authorization', async t => {
    const app = await appFor(t, async () => assert.fail('Unauthorized service call'));
    for (const url of ['/v1/escrow']) {
        for (const authorization of [undefined, 'Bearer wrong']) {
            const response = await app.inject({ method: 'POST', url, headers: authorization ? { authorization } : {}, payload: {} });
            assert.equal(response.statusCode, 401);
        }
    }
});

test('escrow rejects malformed and missing public keys', async t => {
    const app = await appFor(t, async () => assert.fail('Invalid service call'));
    for (const payload of [{}, { user: 'invalid' }, { user: '1'.repeat(33) }]) {
        assert.equal((await app.inject({ method: 'POST', url: '/v1/escrow', headers, payload })).statusCode, 400);
    }
});

test('escrow reports existing and uncertain transactions distinctly', async t => {
    let status = 'existing';
    const app = await appFor(t, async () => ({ status, escrowAddress: user }));
    assert.equal((await app.inject({ method: 'POST', url: '/v1/escrow', headers, payload: { user } })).statusCode, 200);
    status = 'unconfirmed';
    assert.equal((await app.inject({ method: 'POST', url: '/v1/escrow', headers, payload: { user } })).statusCode, 202);
});

test('escrow exposes operation errors and masks unexpected RPC errors', async t => {
    let failure = new OperationError(422, 'Transaction simulation failed');
    const app = await appFor(t, async () => { throw failure; });
    assert.equal((await app.inject({ method: 'POST', url: '/v1/escrow', headers, payload: { user } })).statusCode, 422);
    failure = new Error('internal details');
    const response = await app.inject({ method: 'POST', url: '/v1/escrow', headers, payload: { user } });
    assert.equal(response.statusCode, 502);
    assert(!response.body.includes('internal details'));
});

test('payment requires signed invocation context and delegates provider submissions without a bearer token', async t => {
    const app = await appFor(t, async () => assert.fail('Unexpected setup'));
    assert.equal((await app.inject({ method: 'POST', url: '/v1/payment', headers,
        payload: { user, recipient: user, amountLamports: '1' } })).statusCode, 400);
    assert.equal((await app.inject({ method: 'POST', url: '/v1/payment', headers,
        payload: { manifest: {}, voucher: {} } })).statusCode, 400);
    const response = await app.inject({ method: 'POST', url: '/v1/payment',
        payload: { manifest: {}, voucher: {}, resourcePath: 'com.example', resourceName: 'Weather', parameters: [] } });
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().signature, 'payment-signature');
});
