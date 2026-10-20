import { AccountState, getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID } from '@solana/spl-token';
import type { AccountInfo } from '@solana/web3.js';
import { Keypair, PublicKey } from '@solana/web3.js';
import { describe, expect, test } from 'vitest';
import { escrowAccount, MINT, RENT_MINIMUM, tokenAccount } from '../testing.js';
import { encodeBase58 } from './base58.js';
import { getEscrowBudget } from './escrow-budget.js';
import { createWithdrawEscrowInstruction, decodeEscrowAccount, getEscrowAddress, getEscrowTokenAddress, protocolFee } from './escrow.js';

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
    const base = { programId, authority, user, recipient: Keypair.generate().publicKey, feeRecipient: Keypair.generate().publicKey, mint: MINT };

    test('encodes the withdraw tag and little-endian amount', () => {
        const { instruction, escrowAddress } = createWithdrawEscrowInstruction({ ...base, amountMicroUsdc: 258n });

        expect(escrowAddress.equals(address)).toBe(true);
        expect([...instruction.data]).toEqual([1, 2, 1, 0, 0, 0, 0, 0, 0]);
        expect(instruction.keys.map(k => [k.isSigner, k.isWritable])).toEqual([
            [true, false], [false, false], [false, true], [false, true], [false, true], [false, false], [false, false],
        ]);
    });

    test('moves tokens between the associated token accounts of the escrow, recipient and fee recipient', () => {
        const { instruction } = createWithdrawEscrowInstruction({ ...base, amountMicroUsdc: 1n });
        const ata = (owner: PublicKey) => getAssociatedTokenAddressSync(MINT, owner, true);

        expect(instruction.keys.map(k => k.pubkey.toBase58())).toEqual([
            authority, address, ata(address), ata(base.recipient), ata(base.feeRecipient), MINT, TOKEN_PROGRAM_ID,
        ].map(key => key.toBase58()));
    });

    test.each([0n, -1n, 2n ** 64n])('rejects an amount of %s', (amountMicroUsdc) => {
        expect(() => createWithdrawEscrowInstruction({ ...base, amountMicroUsdc })).toThrow(RangeError);
    });

    test('rejects paying the escrow itself', () => {
        expect(() => createWithdrawEscrowInstruction({ ...base, recipient: address, amountMicroUsdc: 1n })).toThrow('must differ from the escrow');
    });
});

describe('protocolFee', () => {
    test('takes 20%, rounded down', () => {
        expect(protocolFee(10_000n)).toBe(2_000n);
        expect(protocolFee(4n)).toBe(0n);
        expect(protocolFee(9n)).toBe(1n);
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
        ['the old SOL discriminator', (a: ReturnType<typeof valid>) => ({ ...a, data: Buffer.concat([Buffer.from('ESCROW01'), a.data.subarray(8)]) })],
        ['a non-canonical bump', (a: ReturnType<typeof valid>) => ({ ...a, data: Buffer.concat([a.data.subarray(0, 72), Buffer.from([(a.data[72]! + 1) % 256])]) })],
    ])('rejects %s', (_, change) => {
        expect(() => decodeEscrowAccount(programId, address, change(valid()))).toThrow();
    });

    test('rejects state stored at another address', () => {
        expect(() => decodeEscrowAccount(programId, Keypair.generate().publicKey, valid())).toThrow('Invalid escrow PDA or bump');
    });
});

describe('getEscrowBudget', () => {
    const tokenAddress = getEscrowTokenAddress(programId, authority, user, MINT);
    const state = () => escrowAccount(programId, authority, user, RENT_MINIMUM);
    const tokens = (amount: bigint, accountState?: AccountState) => tokenAccount(MINT, address, amount, accountState);

    function connection(escrow: AccountInfo<Buffer> | null, token: AccountInfo<Buffer> | null) {
        return {
            getAccountInfoAndContext: async (key: PublicKey) =>
                ({ context: { slot: 9 }, value: key.equals(address) ? escrow : key.equals(tokenAddress) ? token : null }),
        } as never;
    }

    const budget = (escrow: AccountInfo<Buffer> | null, token: AccountInfo<Buffer> | null, requestedWithdrawalMicroUsdc: bigint) =>
        getEscrowBudget({ connection: connection(escrow, token), programId, authority, user, mint: MINT, requestedWithdrawalMicroUsdc });

    test('reports the whole token balance as available', async () => {
        const result = await budget(state(), tokens(500n), 500n);

        expect(result).toMatchObject({ isInitialized: true, totalBalanceMicroUsdc: 500n, availableBudgetMicroUsdc: 500n, shortfallMicroUsdc: 0n, hasEnoughBudget: true });
        expect(result.escrowTokenAddress.equals(tokenAddress)).toBe(true);
    });

    test('reports the shortfall one micro-USDC over the budget', async () => {
        const result = await budget(state(), tokens(500n), 501n);

        expect(result).toMatchObject({ shortfallMicroUsdc: 1n, hasEnoughBudget: false });
    });

    test('has no budget while the token account is frozen', async () => {
        const result = await budget(state(), tokens(500n, AccountState.Frozen), 1n);

        expect(result).toMatchObject({ totalBalanceMicroUsdc: 500n, availableBudgetMicroUsdc: 0n, hasEnoughBudget: false });
    });

    test('reports a missing escrow or token account as uninitialized', async () => {
        expect(await budget(null, null, 1n)).toMatchObject({ isInitialized: false, hasEnoughBudget: false });
        expect(await budget(state(), null, 1n)).toMatchObject({ isInitialized: false, hasEnoughBudget: false });
        expect(await budget(null, tokens(500n), 1n)).toMatchObject({ isInitialized: false, availableBudgetMicroUsdc: 0n, hasEnoughBudget: false });
    });

    test('rejects an escrow belonging to another authority', async () => {
        const foreign = escrowAccount(programId, Keypair.generate().publicKey, user, RENT_MINIMUM);

        await expect(budget(foreign, tokens(500n), 1n)).rejects.toThrow();
    });

    test.each([
        ['another mint', () => tokenAccount(Keypair.generate().publicKey, address, 500n)],
        ['another owner', () => tokenAccount(MINT, Keypair.generate().publicKey, 500n)],
        ['a non-token-program account', () => ({ ...tokens(500n), owner: Keypair.generate().publicKey })],
    ])('rejects a token account with %s', async (_, token) => {
        await expect(budget(state(), token(), 1n)).rejects.toThrow();
    });

    test('rejects a withdrawal outside the u64 range', async () => {
        await expect(budget(null, null, -1n)).rejects.toThrow(RangeError);
    });
});
