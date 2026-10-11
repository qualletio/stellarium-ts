import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Keypair, PublicKey } from '@solana/web3.js';
import { createService } from '../dist/service.js';
import { getEscrowAddress } from '../dist/solana/escrow.js';

const signer = Keypair.generate();
const programId = new PublicKey(new Uint8Array(32).fill(1));
const user = new PublicKey(new Uint8Array(32).fill(3));
const recipient = new PublicKey(new Uint8Array(32).fill(4));
const blockhash = new PublicKey(new Uint8Array(32).fill(5)).toBase58();
const rent = 1_398_960;

function fixture() {
    const calls = [];
    let account = null;
    const connection = {
        async getAccountInfoAndContext() { return { context: { slot: 10 }, value: account }; },
        async getMinimumBalanceForRentExemption() { return rent; },
        async getLatestBlockhash() { return { blockhash, lastValidBlockHeight: 123 }; },
        async simulateTransaction(tx, config) {
            calls.push('simulate');
            assert.equal(config.sigVerify, false);
            assert.equal(config.minContextSlot, 10);
            assert(tx.signatures[0].every(byte => byte === 0));
            return { context: { slot: 11 }, value: { err: null } };
        },
        async sendTransaction(tx, config) {
            calls.push('send');
            assert(tx.signatures[0].some(byte => byte !== 0));
            assert.equal(config.skipPreflight, false);
            assert.equal(config.minContextSlot, 11);
            assert(tx.message.staticAccountKeys[0].equals(signer.publicKey));
            assert(tx.message.staticAccountKeys.includes(programId) || tx.message.staticAccountKeys.some(k => k.equals(programId)));
            return 'unused-RPC-signature';
        },
        async confirmTransaction(strategy) {
            calls.push('confirm');
            assert.equal(strategy.blockhash, blockhash);
            assert.equal(strategy.lastValidBlockHeight, 123);
            assert.match(strategy.signature, /^[1-9A-HJ-NP-Za-km-z]{64,88}$/);
            return { value: { err: null } };
        },
    };
    return { connection, calls, service: createService({}, { connection, signer, programId }),
        setAccount(value) { account = value; },
        initialized(balance = rent + 500) {
            const [address, bump] = PublicKey.findProgramAddressSync(
                [Buffer.from('escrow'), signer.publicKey.toBuffer(), user.toBuffer()], programId,
            );
            assert(address.equals(getEscrowAddress(programId, signer.publicKey, user)));
            account = { owner: programId, executable: false, lamports: balance,
                data: Buffer.concat([Buffer.from('ESCROW01'), user.toBuffer(), signer.publicKey.toBuffer(), Buffer.from([bump])]) };
        },
    };
}

test('setup simulates before signing/sending and confirms using blockhash lifetime', async () => {
    const f = fixture();
    const result = await f.service.initiateEscrow(user);
    assert.equal(result.status, 'confirmed');
    assert.equal(result.escrowAddress, getEscrowAddress(programId, signer.publicKey, user).toBase58());
    assert.deepEqual(f.calls, ['simulate', 'send', 'confirm']);
});

test('repeated setup returns validated existing escrow without sending', async () => {
    const f = fixture();
    f.initialized();
    assert.equal((await f.service.initiateEscrow(user)).status, 'existing');
    assert.deepEqual(f.calls, []);
    f.setAccount({ owner: programId, data: Buffer.alloc(73), executable: false });
    await assert.rejects(f.service.initiateEscrow(user), e => e.statusCode === 409);
});

test('failed simulation prevents submission', async () => {
    const f = fixture();
    f.connection.simulateTransaction = async () => ({ value: { err: 'failure' } });
    await assert.rejects(f.service.initiateEscrow(user), e => e.statusCode === 422);
    assert.deepEqual(f.calls, []);
});

test('send or confirmation transport failure returns identifiable uncertain result', async () => {
    for (const method of ['sendTransaction', 'confirmTransaction']) {
        const f = fixture();
        f.connection[method] = async () => { throw new Error('RPC timeout'); };
        const result = await f.service.initiateEscrow(user);
        assert.equal(result.status, 'unconfirmed');
        assert.match(result.signature, /^[1-9A-HJ-NP-Za-km-z]{64,88}$/);
        assert.equal(result.lastValidBlockHeight, 123);
    }
});

test('confirmed on-chain failure is not reported as success', async () => {
    const f = fixture();
    f.connection.confirmTransaction = async () => ({ value: { err: 'failure' } });
    await assert.rejects(f.service.initiateEscrow(user), e => e.statusCode === 422);
});

test('withdrawal checks initialized escrow and budget before sending', async () => {
    const f = fixture();
    await assert.rejects(f.service.withdrawEscrow(user, recipient, 1n), e => e.statusCode === 404);
    f.initialized();
    await assert.rejects(f.service.withdrawEscrow(user, recipient, 501n), e => e.statusCode === 409);
    assert.deepEqual(f.calls, []);
    assert.equal((await f.service.withdrawEscrow(user, recipient, 500n)).status, 'confirmed');
    assert.deepEqual(f.calls, ['simulate', 'send', 'confirm']);
});
