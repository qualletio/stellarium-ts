import { AccountState, ASSOCIATED_TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync } from '@solana/spl-token';
import { Keypair, type VersionedTransaction } from '@solana/web3.js';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import type { Database } from '../db/database.js';
import { receiptsTable, settlementsTable } from '../db/schema.js';
import { OperationError } from '../errors.js';
import { ReceiptRepository } from '../repository.js';
import { createTestDatabase, FakeConnection, generateNodeKeys, MINT, RECIPIENT, signedVoucher, tokenAccount } from '../testing.js';
import { EscrowService, RECONCILE_MIN_AGE_MS, type SettlementPolicy } from './escrowService.js';

describe('EscrowService', () => {
    const programId = Keypair.generate().publicKey;
    const authority = Keypair.generate();
    const feeRecipient = Keypair.generate().publicKey;
    const keys = generateNodeKeys();
    // At 200 USDC per SOL, the fake's 5,000-lamport fee costs 1,000 micro-USDC, so a group is settled once
    // its protocol fee reaches 10,000 (a 50,000 total).
    const policy: SettlementPolicy = { solPriceMicroUsdc: 200_000_000n, feeMultiple: 10n };

    let db: Database;
    let close: () => Promise<void>;
    let connection: FakeConnection;
    let service: EscrowService;

    beforeEach(async () => {
        ({ db, close } = await createTestDatabase());
        connection = new FakeConnection(programId, authority.publicKey);
        connection.fund(keys.publicKey, 1_000_000n);
        service = new EscrowService(new ReceiptRepository(db), programId, authority, feeRecipient, MINT, connection, policy);
    });

    afterEach(async () => {
        await close();
    });

    const receipts = () => db.select().from(receiptsTable);
    const settlements = () => db.select().from(settlementsTable);
    const rejectsWithStatus = (promise: Promise<unknown>, statusCode: number) =>
        expect(promise).rejects.toSatisfy((error) => error instanceof OperationError && error.statusCode === statusCode);

    /** Accrues vouchers from `keys` with these amounts. */
    async function accrue(...amounts: number[]) {
        for (const amount of amounts) {
            await service.accruePayment(signedVoucher(keys, { amount }));
        }
    }

    /** Captures the transactions passed to simulateTransaction. */
    function captureSimulations() {
        const simulated: VersionedTransaction[] = [];
        const simulate = connection.simulateTransaction;
        connection.simulateTransaction = (async (transaction: VersionedTransaction, ...rest: unknown[]) => {
            simulated.push(transaction);
            return (simulate as (...args: unknown[]) => unknown)(transaction, ...rest);
        }) as typeof connection.simulateTransaction;
        return simulated;
    }

    /** The amount the withdrawal instruction (the transaction's second) withdraws. */
    const withdrawnAmount = (transaction: VersionedTransaction) =>
        Buffer.from(transaction.message.compiledInstructions[1]!.data).readBigUInt64LE(1);

    describe('accruePayment', () => {
        test('records an accrued receipt without sending a transaction', async () => {
            const result = await service.accruePayment(signedVoucher(keys));

            expect(result.status).toBe('accrued');
            expect(connection.sent).toEqual([]);
            expect(await receipts()).toMatchObject([{ amount: 10_000, settlementId: null }]);
        });

        test('422s without recording when the recipient has no USDC token account', async () => {
            const unprepared = Keypair.generate().publicKey;

            await rejectsWithStatus(service.accruePayment(signedVoucher(keys, { recipientAddress: unprepared.toBase58() })), 422);
            expect(await receipts()).toEqual([]);
        });

        test.each([
            ['frozen', () => connection.createTokenAccount(RECIPIENT, 0n, AccountState.Frozen)],
            ['of another mint', () => connection.accounts.set(getAssociatedTokenAddressSync(MINT, RECIPIENT, true).toBase58(),
                tokenAccount(Keypair.generate().publicKey, RECIPIENT, 0n))],
            ['not a token account', () => connection.accounts.set(getAssociatedTokenAddressSync(MINT, RECIPIENT, true).toBase58(),
                { ...tokenAccount(MINT, RECIPIENT, 0n), owner: Keypair.generate().publicKey })],
        ])('422s when the recipient token account is %s', async (_, prepare) => {
            prepare();

            await rejectsWithStatus(service.accruePayment(signedVoucher(keys)), 422);
        });

        test('stores amounts above the 32-bit integer range', async () => {
            connection.fund(keys.publicKey, 5_000_000_000n);

            await service.accruePayment(signedVoucher(keys, { amount: 3_000_000_000 }));

            expect((await receipts())[0]?.amount).toBe(3_000_000_000);
        });

        test('rejects a second submission of the same voucher', async () => {
            const submission = signedVoucher(keys);
            await service.accruePayment(submission);

            await rejectsWithStatus(service.accruePayment(submission), 409);
            expect(await receipts()).toHaveLength(1);
        });

        test('accepts only one of two concurrent submissions', async () => {
            const submission = signedVoucher(keys);
            const results = await Promise.allSettled([service.accruePayment(submission), service.accruePayment(submission)]);

            expect(results.map(r => r.status).sort()).toEqual(['fulfilled', 'rejected']);
        });

        test('404s when the escrow does not exist', async () => {
            await rejectsWithStatus(service.accruePayment(signedVoucher(generateNodeKeys())), 404);
        });

        test('409s when the escrow cannot cover the amount on top of accrued receipts', async () => {
            await accrue(600_000);

            await rejectsWithStatus(service.accruePayment(signedVoucher(keys, { amount: 400_001 })), 409);
            await service.accruePayment(signedVoucher(keys, { amount: 400_000 }));
            expect(await receipts()).toHaveLength(2);
        });

        test('400s on a recipient that is not a Solana address', async () => {
            await rejectsWithStatus(service.accruePayment(signedVoucher(keys, { recipientAddress: 'nope' })), 400);
        });
    });

    describe('estimateTransactionCostMicroUsdc', () => {
        test('prices the fee at the configured SOL price, rounding up', async () => {
            expect(await service.estimateTransactionCostMicroUsdc()).toBe(1_000n);

            connection.feeLamports = 5_001;
            expect(await service.estimateTransactionCostMicroUsdc()).toBe(1_001n);
        });
    });

    describe('settleDue', () => {
        test('leaves receipts accrued until the protocol fee covers ten transactions', async () => {
            await accrue(10_000, 39_999);

            expect(await service.settleDue()).toMatchObject({ groups: 1, sent: 0 });
            expect(connection.sent).toEqual([]);
        });

        test('pays every accrued receipt of a payer and recipient in one withdrawal', async () => {
            const simulated = captureSimulations();
            await accrue(10_000, 20_000, 20_000);

            expect(await service.settleDue()).toMatchObject({ groups: 1, sent: 1, confirmed: 1, failures: [] });
            expect(connection.sent).toHaveLength(1);
            expect(withdrawnAmount(simulated[0]!)).toBe(50_000n);
            const [settlement] = await settlements();
            expect(settlement).toMatchObject({ amount: 50_000, status: 'confirmed', lastValidBlockHeight: 100 });
            expect((await receipts()).map(receipt => receipt.settlementId)).toEqual([settlement!.id, settlement!.id, settlement!.id]);

            // Nothing is left to pay.
            expect(await service.settleDue()).toMatchObject({ groups: 0, sent: 0 });
        });

        test('settles each recipient separately', async () => {
            const other = Keypair.generate().publicKey;
            connection.createTokenAccount(other);
            await accrue(50_000);
            await service.accruePayment(signedVoucher(keys, { amount: 10_000, recipientAddress: other.toBase58() }));

            expect(await service.settleDue()).toMatchObject({ groups: 2, sent: 1 });
            expect(await settlements()).toMatchObject([{ recipientAddress: RECIPIENT.toBase58(), amount: 50_000 }]);
        });

        test('never settles a group whose protocol fee is below the threshold, however old', async () => {
            await accrue(49_999);
            await db.update(receiptsTable).set({ createdAt: new Date(0) });

            expect(await service.settleDue()).toMatchObject({ sent: 0 });

            await accrue(1);
            expect(await service.settleDue()).toMatchObject({ sent: 1, confirmed: 1 });
        });

        test('raises the threshold with the transaction fee', async () => {
            await accrue(50_000);
            connection.feeLamports = 10_000;

            expect(await service.settleDue()).toMatchObject({ sent: 0 });
        });

        test('creates a missing fee token account, but not the recipient\'s', async () => {
            const simulated = captureSimulations();
            await accrue(50_000);

            await service.settleDue();

            const message = simulated[0]!.message;
            const keyAt = (index: number) => message.staticAccountKeys[index]!;
            const programs = message.compiledInstructions.map(ix => keyAt(ix.programIdIndex).toBase58());
            expect(programs).toEqual([ASSOCIATED_TOKEN_PROGRAM_ID, programId].map(key => key.toBase58()));
            // Associated token account creation takes the new account second.
            expect(keyAt(message.compiledInstructions[0]!.accountKeyIndexes[1]!).toBase58())
                .toBe(getAssociatedTokenAddressSync(MINT, feeRecipient, true).toBase58());
        });

        test('leaves receipts accrued and reports a failed simulation', async () => {
            await accrue(50_000);
            connection.simulateTransaction = (async () => ({ context: { slot: 2 }, value: { err: 'boom' } })) as never;

            const summary = await service.settleDue();

            expect(summary).toMatchObject({ sent: 0, failures: [{ publicKey: keys.publicKey, recipientAddress: RECIPIENT.toBase58() }] });
            expect(await settlements()).toEqual([]);
            expect(await receipts()).toMatchObject([{ settlementId: null }]);
        });

        test('records an uncertain broadcast as unconfirmed', async () => {
            await accrue(50_000);
            connection.sendTransaction = (async () => { throw new Error('socket hang up'); }) as never;

            expect(await service.settleDue()).toMatchObject({ sent: 1, unconfirmed: 1 });
            expect(await settlements()).toMatchObject([{ status: 'unconfirmed' }]);
            // The receipts stay with the uncertain settlement.
            expect(await service.settleDue()).toMatchObject({ groups: 0 });
        });

        test('records a confirmation timeout as unconfirmed', async () => {
            await accrue(50_000);
            connection.confirmTransaction = (async () => { throw new Error('timeout'); }) as never;

            expect(await service.settleDue()).toMatchObject({ unconfirmed: 1 });
        });

        test('releases the receipts of a withdrawal that landed with an error, and pays them on the next pass', async () => {
            await accrue(50_000);
            connection.confirmTransaction = (async () => ({ context: { slot: 3 }, value: { err: 'custom program error' } })) as never;

            expect(await service.settleDue()).toMatchObject({ sent: 0, failures: [{ reason: expect.stringContaining('Transaction failed') }] });
            expect(await settlements()).toMatchObject([{ status: 'failed' }]);

            connection.confirmTransaction = (async () => ({ context: { slot: 3 }, value: { err: null } })) as never;
            expect(await service.settleDue()).toMatchObject({ sent: 1, confirmed: 1 });
            expect(connection.sent).toHaveLength(2);
        });

        test('only one of two concurrent passes pays', async () => {
            await accrue(50_000);

            await Promise.all([service.settleDue(), service.settleDue()]);

            expect(connection.sent).toHaveLength(1);
            expect(await settlements()).toHaveLength(1);
        });

        test('confirmed settlements free the escrow balance for new vouchers', async () => {
            connection.fund(keys.publicKey, 60_000n);
            await accrue(50_000);
            await rejectsWithStatus(service.accruePayment(signedVoucher(keys, { amount: 20_000 })), 409);

            await service.settleDue();
            connection.fund(keys.publicKey, 10_000n);

            // The settlement was confirmed just now, so the balance read may not include it yet.
            await rejectsWithStatus(service.accruePayment(signedVoucher(keys, { amount: 10_000 })), 409);
            await db.update(settlementsTable).set({ updatedAt: new Date(Date.now() - 120_000) });
            await service.accruePayment(signedVoucher(keys, { amount: 10_000 }));
        });
    });

    describe('reconcile', () => {
        // Run reconciliation as if enough time had passed for every settlement to be eligible.
        const later = () => new Date(Date.now() + RECONCILE_MIN_AGE_MS + 1000);

        async function unconfirmedSettlement() {
            await accrue(50_000);
            connection.sendTransaction = (async () => { throw new Error('socket hang up'); }) as never;
            await service.settleDue();
            return (await settlements())[0]!.transactionSignature;
        }

        test('leaves recent settlements to the in-flight withdrawal', async () => {
            await unconfirmedSettlement();

            expect(await service.reconcile()).toEqual({ checked: 0, confirmed: 0, failed: 0, expired: 0 });
        });

        test('confirms a transaction that landed', async () => {
            const signature = await unconfirmedSettlement();
            connection.statuses.set(signature, { err: null, confirmationStatus: 'finalized' });

            expect(await service.reconcile(later())).toMatchObject({ checked: 1, confirmed: 1 });
            expect(await settlements()).toMatchObject([{ status: 'confirmed' }]);
        });

        test('fails a transaction that landed with an error, releasing its receipts', async () => {
            const signature = await unconfirmedSettlement();
            connection.statuses.set(signature, { err: { InstructionError: [0, 'Custom'] }, confirmationStatus: 'confirmed' });

            expect(await service.reconcile(later())).toMatchObject({ failed: 1 });
            expect(await receipts()).toMatchObject([{ settlementId: null }]);
        });

        test('waits on a transaction that is only processed', async () => {
            const signature = await unconfirmedSettlement();
            connection.statuses.set(signature, { err: null, confirmationStatus: 'processed' });

            expect(await service.reconcile(later())).toMatchObject({ checked: 1, confirmed: 0, expired: 0 });
            expect(await settlements()).toMatchObject([{ status: 'unconfirmed' }]);
        });

        test('expires a transaction that never landed once its blockhash is too old, releasing its receipts', async () => {
            await unconfirmedSettlement();

            connection.blockHeight = 100;
            expect(await service.reconcile(later())).toMatchObject({ expired: 0 });

            connection.blockHeight = 101;
            expect(await service.reconcile(later())).toMatchObject({ expired: 1 });
            expect(await settlements()).toMatchObject([{ status: 'expired' }]);
            expect(await receipts()).toMatchObject([{ settlementId: null }]);
        });

        test('leaves settlements without a recorded block height for manual review', async () => {
            await unconfirmedSettlement();
            await db.update(settlementsTable).set({ lastValidBlockHeight: null });
            connection.blockHeight = 1_000_000;

            expect(await service.reconcile(later())).toMatchObject({ checked: 1, expired: 0 });
        });
    });
});
