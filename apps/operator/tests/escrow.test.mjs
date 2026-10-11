import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PublicKey, SystemProgram } from '@solana/web3.js';
import { createEscrowInstruction, createWithdrawEscrowInstruction, decodeEscrowAccount, getEscrowAddress } from '../src/solana/escrow.ts';

const programId = new PublicKey(new Uint8Array(32).fill(1));
const authority = new PublicKey(new Uint8Array(32).fill(2));
const user = new PublicKey(new Uint8Array(32).fill(3));

test('withdrawal instruction encodes an exact u64 amount and the controlling signer', () => {
    const recipient = new PublicKey(new Uint8Array(32).fill(4));
    for (const amountLamports of [1n, 10_000_000n, 2n ** 64n - 1n]) {
        const { instruction, escrowAddress } = createWithdrawEscrowInstruction({ programId, authority, user, recipient, amountLamports });
        assert(escrowAddress.equals(getEscrowAddress(programId, authority, user)));
        assert(instruction.programId.equals(programId));
        assert.equal(instruction.data.length, 9);
        assert.equal(instruction.data[0], 1);
        assert.equal(instruction.data.readBigUInt64LE(1), amountLamports);
        assert.deepEqual(instruction.keys.map(k => [k.pubkey.toBase58(), k.isSigner, k.isWritable]), [
            [authority.toBase58(), true, false], [escrowAddress.toBase58(), false, true],
            [recipient.toBase58(), false, true],
        ]);
    }
});

test('withdrawal builder rejects invalid amounts and sending back to the escrow', () => {
    for (const amountLamports of [0n, -1n, 2n ** 64n, 1, '1']) {
        assert.throws(() => createWithdrawEscrowInstruction({ programId, authority, user, recipient: authority, amountLamports }), /positive bigint/);
    }
    assert.throws(() => createWithdrawEscrowInstruction({ programId, authority, user,
        recipient: getEscrowAddress(programId, authority, user), amountLamports: 1n }), /differ/);
    assert.doesNotThrow(() => createWithdrawEscrowInstruction({ programId, authority, user, recipient: authority, amountLamports: 1n }));
});

function fixture() {
    const [address, bump] = PublicKey.findProgramAddressSync(
        [Buffer.from('escrow'), authority.toBuffer(), user.toBuffer()], programId,
    );
    const data = Buffer.concat([Buffer.from('ESCROW01'), user.toBuffer(), authority.toBuffer(), Buffer.from([bump])]);
    return { address, account: { data, owner: programId, executable: false, lamports: 1_500_000, rentEpoch: 0 } };
}

test('returns the canonical address and correct setup account permissions', () => {
    const { instruction, escrowAddress } = createEscrowInstruction({ programId, authority, user });
    assert(escrowAddress.equals(fixture().address));
    assert(instruction.programId.equals(programId));
    assert.deepEqual([...instruction.data], [0]);
    assert.deepEqual(instruction.keys.map(k => [k.pubkey.toBase58(), k.isSigner, k.isWritable]), [
        [authority.toBase58(), true, true], [user.toBase58(), false, false],
        [authority.toBase58(), true, false], [escrowAddress.toBase58(), false, true],
        [SystemProgram.programId.toBase58(), false, false],
    ]);
});

test('allows a separate payer and isolates escrow addresses by user and authority', () => {
    const payer = new PublicKey(new Uint8Array(32).fill(4));
    const result = createEscrowInstruction({ programId, authority, user, payer });
    assert(result.instruction.keys[0].pubkey.equals(payer));
    assert(!getEscrowAddress(programId, authority, payer).equals(result.escrowAddress));
    assert(!getEscrowAddress(programId, payer, user).equals(result.escrowAddress));
});

test('decodes valid state and rejects spoofed owner, layout, discriminator, PDA, and bump', () => {
    const { address, account } = fixture();
    const decoded = decodeEscrowAccount(programId, address, account);
    assert(decoded.user.equals(user));
    assert(decoded.authority.equals(authority));
    for (const invalid of [
        { ...account, owner: authority }, { ...account, executable: true },
        { ...account, data: account.data.subarray(0, 72) },
        { ...account, data: Buffer.alloc(73) },
        { ...account, data: Buffer.concat([account.data.subarray(0, 72), Buffer.from([account.data[72] ^ 1])]) },
    ]) assert.throws(() => decodeEscrowAccount(programId, address, invalid));
    assert.throws(() => decodeEscrowAccount(programId, user, account));
});
