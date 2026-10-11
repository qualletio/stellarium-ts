import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Keypair, PublicKey } from '@solana/web3.js';
import { createService } from '../dist/service.js';
import { verifyPayment } from '../dist/payment.js';
import { paymentFixture } from './helpers/payment.mjs';

function fixture() {
    const { input, user } = paymentFixture();
    const signer = Keypair.generate();
    const programId = new PublicKey(new Uint8Array(32).fill(1));
    const [address, bump] = PublicKey.findProgramAddressSync(
        [Buffer.from('escrow'), signer.publicKey.toBuffer(), user.toBuffer()], programId,
    );
    const rent = 1_398_960;
    const records = new Map();
    const store = {
        async claim(id, fingerprint) {
            if (records.has(id)) return false;
            records.set(id, { fingerprint, result: null, error: null });
            return true;
        },
        async get(id) { return records.get(id); },
        async saveResult(id, result) { records.get(id).result = result; },
        async saveError(id, error) { records.get(id).error = error; },
    };
    let sends = 0;
    const connection = {
        async getAccountInfoAndContext() {
            return { context: { slot: 10 }, value: { owner: programId, executable: false, lamports: rent + 500,
                data: Buffer.concat([Buffer.from('ESCROW01'), user.toBuffer(), signer.publicKey.toBuffer(), Buffer.from([bump])]) } };
        },
        async getMinimumBalanceForRentExemption() { return rent; },
        async getLatestBlockhash() { return { blockhash: user.toBase58(), lastValidBlockHeight: 123 }; },
        async simulateTransaction() { return { context: { slot: 11 }, value: { err: null } }; },
        async sendTransaction(transaction) {
            // The settlement signature must already be recorded before broadcast.
            assert.equal(records.get(verifyPayment(input).voucherId).result.status, 'unconfirmed');
            const instruction = transaction.message.compiledInstructions[0];
            assert.equal(instruction.data[0], 1);
            assert.equal(Buffer.from(instruction.data).readBigUInt64LE(1), 500n);
            assert(transaction.message.staticAccountKeys[instruction.accountKeyIndexes[1]].equals(address));
            assert.equal(transaction.message.staticAccountKeys[instruction.accountKeyIndexes[2]].toBase58(), input.voucher.recipientAddress);
            sends++;
            return 'signature';
        },
        async confirmTransaction() { return { value: { err: null } }; },
    };
    const options = { signer, programId, connection, paymentStore: store };
    return { input, store, records, connection, service: createService({}, options),
        restart: () => createService({}, options), sends: () => sends };
}

test('verified provider voucher pays the signer-derived escrow exactly once, including after restart', async () => {
    const f = fixture();
    const first = await f.service.settlePayment(f.input);
    assert.equal(first.status, 'confirmed');
    assert.deepEqual(await f.service.settlePayment(f.input), first);
    assert.deepEqual(await f.restart().settlePayment(f.input), first);
    assert.equal(f.sends(), 1);
});

test('concurrent settlement attempts cannot broadcast twice', async () => {
    const f = fixture();
    const results = await Promise.allSettled([f.service.settlePayment(f.input), f.service.settlePayment(f.input)]);
    assert.equal(f.sends(), 1);
    assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
    assert.equal(results.find(r => r.status === 'rejected').reason.statusCode, 409);
});

test('invalid signatures and expiry never claim a voucher or contact the chain', async () => {
    for (const alter of [p => { p.voucher.signature = 'invalid'; }, p => { p.voucher.expiresAt = new Date(0).toISOString(); }]) {
        const f = fixture();
        alter(f.input);
        f.connection.getAccountInfoAndContext = async () => assert.fail('Unexpected RPC');
        await assert.rejects(f.service.settlePayment(f.input));
        assert.equal(f.records.size, 0);
        assert.equal(f.sends(), 0);
    }
});

test('uncertain confirmation replays the saved signature without resubmitting', async () => {
    const f = fixture();
    f.connection.confirmTransaction = async () => { throw new Error('timeout'); };
    const first = await f.service.settlePayment(f.input);
    assert.equal(first.status, 'unconfirmed');
    assert.deepEqual(await f.restart().settlePayment(f.input), first);
    assert.equal(f.sends(), 1);
});

test('database failure to record a signature prevents broadcasting funds', async () => {
    const f = fixture();
    f.store.saveResult = async () => { throw new Error('database unavailable'); };
    await assert.rejects(f.service.settlePayment(f.input), /database unavailable/);
    assert.equal(f.sends(), 0);
    await assert.rejects(f.restart().settlePayment(f.input), e => e.statusCode === 409);
});

test('budget or simulation failure is stored and cannot be paid by replaying the voucher', async () => {
    const f = fixture();
    f.connection.simulateTransaction = async () => ({ value: { err: 'failure' } });
    await assert.rejects(f.service.settlePayment(f.input), e => e.statusCode === 422);
    await assert.rejects(f.restart().settlePayment(f.input), e => e.statusCode === 422);
    assert.equal(f.sends(), 0);
});

test('reused voucher identity with a different fingerprint is rejected', async () => {
    const f = fixture();
    const verified = verifyPayment(f.input);
    f.records.set(verified.voucherId, { fingerprint: 'different', result: null, error: null });
    await assert.rejects(f.service.settlePayment(f.input), e => e.statusCode === 409);
    assert.equal(f.sends(), 0);
});

test('expiry is checked again after simulation before broadcast', async () => {
    const f = fixture();
    const originalNow = Date.now;
    f.connection.simulateTransaction = async () => {
        Date.now = () => Date.parse(f.input.voucher.expiresAt) + 1;
        return { context: { slot: 11 }, value: { err: null } };
    };
    try {
        await assert.rejects(f.service.settlePayment(f.input), e => e.statusCode === 410);
        assert.equal(f.sends(), 0);
    } finally {
        Date.now = originalNow;
    }
});

test('provider HTTP submission verifies original parameter JSON and returns the settlement result', async t => {
    const { default: Fastify } = await import('fastify');
    const { default: routes } = await import('../dist/routes.js');
    const f = fixture();
    const app = Fastify({ ajv: { customOptions: { removeAdditional: false, coerceTypes: false } } });
    app.register(routes, { prefix: '/v1', apiToken: 'operator-only', service: f.service });
    t.after(() => app.close());
    const first = await app.inject({ method: 'POST', url: '/v1/payment', payload: f.input });
    assert.equal(first.statusCode, 200);
    assert.equal(first.json().status, 'confirmed');
    const replay = await app.inject({ method: 'POST', url: '/v1/payment', payload: f.input });
    assert.equal(replay.statusCode, 200);
    assert.equal(replay.json().signature, first.json().signature);
    assert.equal(f.sends(), 1);
    f.input.parameters[0].value = 'tampered';
    const invalid = await app.inject({ method: 'POST', url: '/v1/payment', payload: f.input });
    assert.equal(invalid.statusCode, 401);
    assert.equal(f.sends(), 1);
});
