import { AccountState, ASSOCIATED_TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync } from '@solana/spl-token';
import { Keypair, type VersionedTransaction } from '@solana/web3.js';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import type { Database } from '../db/database.js';
import { receiptsTable } from '../db/schema.js';
import { OperationError } from '../errors.js';
import { ReceiptRepository } from '../repository.js';
import { createTestDatabase, FakeConnection, generateNodeKeys, MINT, RECIPIENT, signedVoucher, tokenAccount } from '../testing.js';
import { EscrowService, RECONCILE_MIN_AGE_MS } from './escrowService.js';

describe('EscrowService', () => {
    const programId = Keypair.generate().publicKey;
    const authority = Keypair.generate();
    const feeRecipient = Keypair.generate().publicKey;
    const keys = generateNodeKeys();

    let db: Database;
    let close: () => Promise<void>;
    let connection: FakeConnection;
    let service: EscrowService;

    beforeEach(async () => {
        ({ db, close } = await createTestDatabase());
        connection = new FakeConnection(programId, authority.publicKey);
        connection.fund(keys.publicKey, 1_000_000n);
        service = new EscrowService(new ReceiptRepository(db), programId, authority, feeRecipient, MINT, connection);
    });

    afterEach(async () => {
        await close();
    });

    const receipts = () => db.select().from(receiptsTable);
    const rejectsWithStatus = (promise: Promise<unknown>, statusCode: number) =>
        expect(promise).rejects.toSatisfy((error) => error instanceof OperationError && error.statusCode === statusCode);

    describe('settlePayment', () => {
        test('sends one withdrawal and records a confirmed receipt', async () => {
            const result = await service.settlePayment(signedVoucher(keys));

            expect(result.status).toBe('confirmed');
            expect(connection.sent).toHaveLength(1);
            expect(await receipts()).toMatchObject([{ status: 'confirmed', transactionSignature: result.signature, lastValidBlockHeight: 100 }]);
        });

        test('creates a missing fee token account, but not the recipient\'s', async () => {
            let simulated: VersionedTransaction | undefined;
            const simulate = connection.simulateTransaction;
            connection.simulateTransaction = (async (transaction: VersionedTransaction, ...rest: unknown[]) => {
                simulated = transaction;
                return (simulate as (...args: unknown[]) => unknown)(transaction, ...rest);
            }) as typeof connection.simulateTransaction;

            await service.settlePayment(signedVoucher(keys));

            const message = simulated!.message;
            const keyAt = (index: number) => message.staticAccountKeys[index]!;
            const programs = message.compiledInstructions.map(ix => keyAt(ix.programIdIndex).toBase58());
            expect(programs).toEqual([ASSOCIATED_TOKEN_PROGRAM_ID, programId].map(key => key.toBase58()));
            // Associated token account creation takes the new account second.
            expect(keyAt(message.compiledInstructions[0]!.accountKeyIndexes[1]!).toBase58())
                .toBe(getAssociatedTokenAddressSync(MINT, feeRecipient, true).toBase58());
        });

        test('422s without sending or claiming when the recipient has no USDC token account', async () => {
            const unprepared = Keypair.generate().publicKey;

            await rejectsWithStatus(service.settlePayment(signedVoucher(keys, { recipientAddress: unprepared.toBase58() })), 422);
            expect(connection.sent).toEqual([]);
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

            await rejectsWithStatus(service.settlePayment(signedVoucher(keys)), 422);
            expect(connection.sent).toEqual([]);
        });

        test('stores amounts above the 32-bit integer range', async () => {
            connection.fund(keys.publicKey, 5_000_000_000n);

            await service.settlePayment(signedVoucher(keys, { amount: 3_000_000_000 }));

            expect((await receipts())[0]?.amount).toBe(3_000_000_000);
        });

        test('rejects a second settlement of the same voucher without sending', async () => {
            const submission = signedVoucher(keys);
            await service.settlePayment(submission);

            await rejectsWithStatus(service.settlePayment(submission), 409);
            expect(connection.sent).toHaveLength(1);
        });

        test('only one of two concurrent settlements sends', async () => {
            const submission = signedVoucher(keys);
            const results = await Promise.allSettled([service.settlePayment(submission), service.settlePayment(submission)]);

            expect(results.map(r => r.status).sort()).toEqual(['fulfilled', 'rejected']);
            expect(connection.sent).toHaveLength(1);
        });

        test('404s when the escrow does not exist', async () => {
            const stranger = generateNodeKeys();

            await rejectsWithStatus(service.settlePayment(signedVoucher(stranger)), 404);
        });

        test('409s when the escrow cannot cover the amount', async () => {
            await rejectsWithStatus(service.settlePayment(signedVoucher(keys, { amount: 1_000_001 })), 409);
            expect(await receipts()).toEqual([]);
        });

        test('422s on a failed simulation without writing a receipt', async () => {
            connection.simulateTransaction = (async () => ({ context: { slot: 2 }, value: { err: 'boom' } })) as never;

            await rejectsWithStatus(service.settlePayment(signedVoucher(keys)), 422);
            expect(await receipts()).toEqual([]);
        });

        test('records an uncertain broadcast as unconfirmed', async () => {
            connection.sendTransaction = (async () => { throw new Error('socket hang up'); }) as never;

            const result = await service.settlePayment(signedVoucher(keys));

            expect(result.status).toBe('unconfirmed');
            expect(await receipts()).toMatchObject([{ status: 'unconfirmed' }]);
        });

        test('records a confirmation timeout as unconfirmed', async () => {
            connection.confirmTransaction = (async () => { throw new Error('timeout'); }) as never;

            expect((await service.settlePayment(signedVoucher(keys))).status).toBe('unconfirmed');
            expect(await receipts()).toMatchObject([{ status: 'unconfirmed' }]);
        });

        test('marks a transaction that landed with an error as failed, and lets the voucher be retried', async () => {
            const submission = signedVoucher(keys);
            connection.confirmTransaction = (async () => ({ context: { slot: 3 }, value: { err: 'custom program error' } })) as never;

            await rejectsWithStatus(service.settlePayment(submission), 422);
            expect(await receipts()).toMatchObject([{ status: 'failed' }]);

            connection.confirmTransaction = (async () => ({ context: { slot: 3 }, value: { err: null } })) as never;
            const retry = await service.settlePayment(submission);

            expect(retry.status).toBe('confirmed');
            expect(await receipts()).toMatchObject([{ status: 'confirmed', transactionSignature: retry.signature }]);
        });

        test('400s on a recipient that is not a Solana address', async () => {
            await rejectsWithStatus(service.settlePayment(signedVoucher(keys, { recipientAddress: 'nope' })), 400);
        });
    });

    describe('reconcile', () => {
        // Run reconciliation as if enough time had passed for every receipt to be eligible.
        const later = () => new Date(Date.now() + RECONCILE_MIN_AGE_MS + 1000);

        async function unconfirmedReceipt() {
            connection.sendTransaction = (async () => { throw new Error('socket hang up'); }) as never;
            const { signature } = await service.settlePayment(signedVoucher(keys));
            return signature!;
        }

        test('leaves recent receipts to the in-flight settlement', async () => {
            await unconfirmedReceipt();

            expect(await service.reconcile()).toEqual({ checked: 0, confirmed: 0, failed: 0, expired: 0 });
        });

        test('confirms a transaction that landed', async () => {
            const signature = await unconfirmedReceipt();
            connection.statuses.set(signature, { err: null, confirmationStatus: 'finalized' });

            expect(await service.reconcile(later())).toMatchObject({ checked: 1, confirmed: 1 });
            expect(await receipts()).toMatchObject([{ status: 'confirmed' }]);
        });

        test('fails a transaction that landed with an error', async () => {
            const signature = await unconfirmedReceipt();
            connection.statuses.set(signature, { err: { InstructionError: [0, 'Custom'] }, confirmationStatus: 'confirmed' });

            expect(await service.reconcile(later())).toMatchObject({ failed: 1 });
        });

        test('waits on a transaction that is only processed', async () => {
            const signature = await unconfirmedReceipt();
            connection.statuses.set(signature, { err: null, confirmationStatus: 'processed' });

            expect(await service.reconcile(later())).toMatchObject({ checked: 1, confirmed: 0, expired: 0 });
            expect(await receipts()).toMatchObject([{ status: 'unconfirmed' }]);
        });

        test('expires a transaction that never landed once its blockhash is too old, freeing the voucher', async () => {
            await unconfirmedReceipt();

            connection.blockHeight = 100;
            expect(await service.reconcile(later())).toMatchObject({ expired: 0 });

            connection.blockHeight = 101;
            expect(await service.reconcile(later())).toMatchObject({ expired: 1 });
            expect(await receipts()).toMatchObject([{ status: 'expired' }]);
        });

        test('leaves receipts without a recorded block height for manual review', async () => {
            await unconfirmedReceipt();
            await db.update(receiptsTable).set({ lastValidBlockHeight: null });
            connection.blockHeight = 1_000_000;

            expect(await service.reconcile(later())).toMatchObject({ checked: 1, expired: 0 });
        });
    });
});
