import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PublicKey } from '@solana/web3.js';
import { getEscrowBudget } from '../dist/solana/escrow-budget.js';

const programId = new PublicKey(new Uint8Array(32).fill(1));
const authority = new PublicKey(new Uint8Array(32).fill(2));
const user = new PublicKey(new Uint8Array(32).fill(3));
const [address, bump] = PublicKey.findProgramAddressSync(
    [Buffer.from('escrow'), authority.toBuffer(), user.toBuffer()], programId,
);
const rent = 1_398_960;

function fixture(balance = rent + 500) {
    const account = { owner: programId, executable: false, lamports: balance,
        data: Buffer.concat([Buffer.from('ESCROW01'), user.toBuffer(), authority.toBuffer(), Buffer.from([bump])]) };
    const connection = {
        async getAccountInfoAndContext(actualAddress, commitment) {
            assert(actualAddress.equals(address));
            assert.equal(commitment, 'confirmed');
            return { context: { slot: 123 }, value: account };
        },
        async getMinimumBalanceForRentExemption(size, commitment) {
            assert.equal(size, 73);
            assert.equal(commitment, 'confirmed');
            return rent;
        },
    };
    return { account, input: { connection, programId, authority, user } };
}

test('subtracts rent and handles exact and insufficient withdrawal budgets', async () => {
    const { input } = fixture();
    for (const [amount, enough, shortfall] of [[499n, true, 0n], [500n, true, 0n], [501n, false, 1n]]) {
        const budget = await getEscrowBudget({ ...input, requestedWithdrawalLamports: amount });
        assert.equal(budget.totalBalanceLamports, BigInt(rent + 500));
        assert.equal(budget.rentReserveLamports, BigInt(rent));
        assert.equal(budget.availableBudgetLamports, 500n);
        assert.equal(budget.requestedWithdrawalLamports, amount);
        assert.equal(budget.hasEnoughBudget, enough);
        assert.equal(budget.shortfallLamports, shortfall);
        assert.equal(budget.slot, 123);
        assert.equal(budget.isInitialized, true);
    }
});

test('rent-only and underfunded accounts expose no spendable budget', async () => {
    for (const balance of [rent, rent - 1, 0]) {
        const { input } = fixture(balance);
        const budget = await getEscrowBudget({ ...input, requestedWithdrawalLamports: 1n });
        assert.equal(budget.availableBudgetLamports, 0n);
        assert.equal(budget.hasEnoughBudget, false);
        assert.equal(budget.isRentExempt, balance >= rent);
        assert.equal(budget.shortfallLamports, 1n);
    }
    assert.equal((await getEscrowBudget(fixture(rent - 1).input)).hasEnoughBudget, false);
});

test('missing escrow is explicitly uninitialized, even for a zero request', async () => {
    const { input } = fixture();
    input.connection.getAccountInfoAndContext = async () => ({ context: { slot: 124 }, value: null });
    const budget = await getEscrowBudget(input);
    assert.equal(budget.isInitialized, false);
    assert.equal(budget.totalBalanceLamports, 0n);
    assert.equal(budget.availableBudgetLamports, 0n);
    assert.equal(budget.hasEnoughBudget, false);
});

test('rejects spoofed or malformed escrow state rather than reporting its balance', async () => {
    for (const alter of [
        a => { a.owner = user; }, a => { a.executable = true; },
        a => { a.data[0] = 0; }, a => { a.data[72] ^= 1; },
        a => { a.data = a.data.subarray(0, 72); },
        a => { authority.toBuffer().copy(a.data, 8); },
    ]) {
        const { input, account } = fixture();
        alter(account);
        await assert.rejects(getEscrowBudget(input), /Invalid escrow/);
    }
});

test('rejects invalid amounts before making RPC requests', async () => {
    for (const amount of [-1n, 2n ** 64n, 1, NaN, '1']) {
        const { input } = fixture();
        input.connection.getAccountInfoAndContext = async () => assert.fail('Unexpected RPC call');
        await assert.rejects(getEscrowBudget({ ...input, requestedWithdrawalLamports: amount }), /u64 range/);
    }
});

test('rejects imprecise balances and invalid rent responses', async () => {
    for (const value of [Number.MAX_SAFE_INTEGER + 1, -1, 1.5, NaN]) {
        await assert.rejects(getEscrowBudget(fixture(value).input), /safe integer/);
    }
    for (const value of [0, -1, NaN, Number.MAX_SAFE_INTEGER + 1]) {
        const { input } = fixture();
        input.connection.getMinimumBalanceForRentExemption = async () => value;
        await assert.rejects(getEscrowBudget(input), /rent reserve|Rent reserve/);
    }
});

test('propagates RPC failures without treating unavailable data as a zero balance', async () => {
    for (const method of ['getAccountInfoAndContext', 'getMinimumBalanceForRentExemption']) {
        const { input } = fixture();
        input.connection[method] = async () => { throw new Error('RPC unavailable'); };
        await assert.rejects(getEscrowBudget(input), /RPC unavailable/);
    }
});
