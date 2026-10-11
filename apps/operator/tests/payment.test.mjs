import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PublicKey } from '@solana/web3.js';
import { paymentFixture } from './helpers/payment.mjs';
import { verifyPayment } from '../dist/payment.js';


test('verifies the exact invoker signing format and derives the escrow user from SPKI', () => {
    const { input, user } = paymentFixture();
    const result = verifyPayment(input);
    assert(result.user.equals(user));
    assert.equal(result.amountLamports, 500n);
    assert.equal(result.recipient.toBase58(), input.manifest.recipientAddress);
    assert.equal(result.voucherId, verifyPayment(input).voucherId);
});

test('rejects unsigned amount, recipient, and invocation-context changes', () => {
    for (const alter of [
        p => { p.voucher.amount++; p.manifest.costLamports++; },
        p => { p.voucher.recipientAddress = new PublicKey(new Uint8Array(32).fill(6)).toBase58(); p.manifest.recipientAddress = p.voucher.recipientAddress; },
        p => { p.resourcePath = 'changed'; }, p => { p.resourceName = 'changed'; },
        p => { p.parameters[0].value = 'changed'; }, p => { p.voucher.requestId = 'changed'; },
        p => { p.voucher.invocationId = 'changed'; }, p => { p.voucher.signature = 'invalid'; },
        p => { p.voucher.publicKey = 'invalid'; },
    ]) {
        const { input } = paymentFixture();
        alter(input);
        assert.throws(() => verifyPayment(input), e => e.statusCode === 401);
    }
});

test('rejects expired, malformed, mismatched, and imprecise payments', () => {
    for (const [alter, code] of [
        [p => { p.voucher.expiresAt = new Date(0).toISOString(); }, 410],
        [p => { p.voucher.expiresAt = 'invalid'; }, 400],
        [p => { p.manifest.costLamports++; }, 400],
        [p => { p.manifest.recipientAddress = 'different'; }, 400],
        [p => { p.voucher.amount = Number.MAX_SAFE_INTEGER + 1; }, 400],
        [p => { p.voucher.amount = 0; }, 400],
        [p => { p.parameters = undefined; }, 400],
    ]) {
        const { input } = paymentFixture();
        alter(input);
        assert.throws(() => verifyPayment(input), e => e.statusCode === code);
    }
});
