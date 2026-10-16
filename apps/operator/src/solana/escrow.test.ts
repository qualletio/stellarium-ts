import { Keypair, PublicKey } from '@solana/web3.js';
import { describe, expect, test } from 'vitest';
import { escrowAccount, RENT_MINIMUM } from '../testing.js';
import { encodeBase58 } from './base58.js';
import { getEscrowBudget } from './escrow-budget.js';
import { createWithdrawEscrowInstruction, decodeEscrowAccount, getEscrowAddress, protocolFeeLamports } from './escrow.js';

const programId = Keypair.generate().publicKey;
const authority = Keypair.generate().publicKey;
const user = Keypair.generate().publicKey;
const address = getEscrowAddress(programId, authority, user);

describe('encodeBase58', () => {
    test('matches web3.js for public keys, including leading zero bytes', () => {
        for (const bytes of [new Uint8Array(32), Uint8Array.from({ length: 32 }, (_, i) => (i < 3 ? 0 : i)), Keypair.generate().publicKey.toBytes()]) {
            expect(encodeBase58(bytes)).toBe(new PublicKey(bytes).toBase58());
        }
    });

    test('encodes a 64-byte signature of zeros as 64 ones', () => {
        expect(encodeBase58(new Uint8Array(64))).toBe('1'.repeat(64));
    });

    test('encodes empty input as an empty string', () => {
        expect(encodeBase58(new Uint8Array())).toBe('');
    });
});

describe('createWithdrawEscrowInstruction', () => {
    const base = { programId, authority, user, recipient: Keypair.generate().publicKey, feeRecipient: Keypair.generate().publicKey };

    test('encodes the withdraw tag and little-endian amount', () => {
        const { instruction, escrowAddress } = createWithdrawEscrowInstruction({ ...base, amountLamports: 258n });

        expect(escrowAddress.equals(address)).toBe(true);
        expect([...instruction.data]).toEqual([1, 2, 1, 0, 0, 0, 0, 0, 0]);
        expect(instruction.keys.map(k => [k.isSigner, k.isWritable])).toEqual([[true, false], [false, true], [false, true], [false, true]]);
    });

    test.each([0n, -1n, 2n ** 64n])('rejects an amount of %s', (amountLamports) => {
        expect(() => createWithdrawEscrowInstruction({ ...base, amountLamports })).toThrow(RangeError);
    });

    test('rejects paying the escrow itself', () => {
        expect(() => createWithdrawEscrowInstruction({ ...base, recipient: address, amountLamports: 1n })).toThrow('must differ from the escrow');
    });
});

describe('protocolFeeLamports', () => {
    test('takes 20%, rounded down', () => {
        expect(protocolFeeLamports(10_000n)).toBe(2_000n);
        expect(protocolFeeLamports(4n)).toBe(0n);
        expect(protocolFeeLamports(9n)).toBe(1n);
    });
});

describe('decodeEscrowAccount', () => {
    const valid = () => escrowAccount(programId, authority, user, RENT_MINIMUM);

    test('decodes valid escrow state', () => {
        const state = decodeEscrowAccount(programId, address, valid());

        expect(state.user.equals(user) && state.authority.equals(authority)).toBe(true);
    });

    test.each([
        ['a foreign owner', (a: ReturnType<typeof valid>) => ({ ...a, owner: Keypair.generate().publicKey })],
        ['an executable account', (a: ReturnType<typeof valid>) => ({ ...a, executable: true })],
        ['the wrong size', (a: ReturnType<typeof valid>) => ({ ...a, data: a.data.subarray(0, 72) })],
        ['the wrong discriminator', (a: ReturnType<typeof valid>) => ({ ...a, data: Buffer.concat([Buffer.from('ESCROW02'), a.data.subarray(8)]) })],
        ['a non-canonical bump', (a: ReturnType<typeof valid>) => ({ ...a, data: Buffer.concat([a.data.subarray(0, 72), Buffer.from([(a.data[72]! + 1) % 256])]) })],
    ])('rejects %s', (_, change) => {
        expect(() => decodeEscrowAccount(programId, address, change(valid()))).toThrow();
    });

    test('rejects state stored at another address', () => {
        expect(() => decodeEscrowAccount(programId, Keypair.generate().publicKey, valid())).toThrow('Invalid escrow PDA or bump');
    });
});

describe('getEscrowBudget', () => {
    function connection(account: ReturnType<typeof escrowAccount> | null, rent = RENT_MINIMUM) {
        return {
            getAccountInfoAndContext: async () => ({ context: { slot: 9 }, value: account }),
            getMinimumBalanceForRentExemption: async () => rent,
        } as never;
    }

    const budget = (account: ReturnType<typeof escrowAccount> | null, requestedWithdrawalLamports: bigint, rent?: number) =>
        getEscrowBudget({ connection: connection(account, rent), programId, authority, user, requestedWithdrawalLamports });

    test('reports everything above the rent reserve as available', async () => {
        const result = await budget(escrowAccount(programId, authority, user, RENT_MINIMUM + 500), 500n);

        expect(result).toMatchObject({ isInitialized: true, isRentExempt: true, availableBudgetLamports: 500n, shortfallLamports: 0n, hasEnoughBudget: true });
    });

    test('reports the shortfall one lamport over the budget', async () => {
        const result = await budget(escrowAccount(programId, authority, user, RENT_MINIMUM + 500), 501n);

        expect(result).toMatchObject({ shortfallLamports: 1n, hasEnoughBudget: false });
    });

    test('has no budget below rent exemption', async () => {
        const result = await budget(escrowAccount(programId, authority, user, RENT_MINIMUM - 1), 1n);

        expect(result).toMatchObject({ isRentExempt: false, availableBudgetLamports: 0n, hasEnoughBudget: false });
    });

    test('reports a missing escrow as uninitialized', async () => {
        expect(await budget(null, 1n)).toMatchObject({ isInitialized: false, hasEnoughBudget: false });
    });

    test('fails closed when the RPC reports zero rent', async () => {
        await expect(budget(null, 1n, 0)).rejects.toThrow('positive escrow rent reserve');
    });

    test('rejects an escrow belonging to another authority', async () => {
        const foreign = escrowAccount(programId, Keypair.generate().publicKey, user, RENT_MINIMUM);

        await expect(budget(foreign, 1n)).rejects.toThrow();
    });

    test('rejects a withdrawal outside the u64 range', async () => {
        await expect(budget(null, -1n)).rejects.toThrow(RangeError);
    });
});
