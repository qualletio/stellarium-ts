import { CombinationResourceInvoker, invocationHash } from 'stellarium-ts';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import type { Database } from './db/database.js';
import { receiptsTable } from './db/schema.js';
import { OperationError } from './errors.js';
import { PaymentService } from './paymentService.js';
import { ReceiptRepository } from './repository.js';
import { createTestDatabase, generateNodeKeys, RECIPIENT, signedVoucher } from './testing.js';

describe('PaymentService.verifyPayment', () => {
    let db: Database;
    let close: () => Promise<void>;
    let service: PaymentService;

    beforeEach(async () => {
        ({ db, close } = await createTestDatabase());
        service = new PaymentService(new ReceiptRepository(db));
    });

    afterEach(async () => {
        await close();
    });

    const rejection = (promise: Promise<unknown>) => promise.then(
        () => { throw new Error('expected a rejection'); },
        (error: OperationError) => ({ status: error.statusCode, message: error.message }),
    );

    test('accepts a voucher created by the stellarium-ts node', async () => {
        // The contract the three copies of the wire format must agree on.
        const keys = generateNodeKeys();
        const invoker = new CombinationResourceInvoker(undefined as never, 100_000, keys.publicKey, keys.privateKey);
        const parameters = [{ name: 'city', value: 'Oslo' }];
        const voucher = invoker.createPaymentVoucher(RECIPIENT.toBase58(), 10_000, 'com.example', 'Weather', 'temperature', parameters);

        await expect(service.verifyPayment({ voucher })).resolves.toBeUndefined();
        expect(voucher.invocationHash).toBe(invocationHash('com.example', 'Weather', 'temperature', parameters));
    });

    test('rejects a voucher with an altered field', async () => {
        const submission = signedVoucher();
        submission.voucher.amount += 1;

        expect(await rejection(service.verifyPayment(submission))).toEqual({ status: 401, message: 'Invalid voucher signature' });
    });

    test('rejects a malformed public key', async () => {
        const submission = signedVoucher();
        submission.voucher.publicKey = 'not-a-key';

        expect(await rejection(service.verifyPayment(submission))).toMatchObject({ status: 400 });
    });

    test('rejects an expired voucher', async () => {
        const submission = signedVoucher(undefined, { expiresAt: new Date(Date.now() - 1000).toISOString() });

        expect(await rejection(service.verifyPayment(submission))).toEqual({ status: 401, message: 'Voucher has expired' });
    });

    test('checks the signature before revealing whether a receipt exists', async () => {
        const submission = signedVoucher();
        await insertReceipt(submission, 'confirmed');
        submission.voucher.signature = signedVoucher().voucher.signature;

        expect(await rejection(service.verifyPayment(submission))).toMatchObject({ status: 401 });
    });

    test.each(['pending', 'unconfirmed', 'confirmed'] as const)('rejects a voucher whose receipt is %s', async (status) => {
        const submission = signedVoucher();
        await insertReceipt(submission, status);

        expect(await rejection(service.verifyPayment(submission))).toEqual({ status: 409, message: 'Receipt has already been settled' });
    });

    test.each(['failed', 'expired'] as const)('lets a voucher whose settlement %s be retried', async (status) => {
        const submission = signedVoucher();
        await insertReceipt(submission, status);

        await expect(service.verifyPayment(submission)).resolves.toBeUndefined();
    });

    async function insertReceipt({ voucher }: ReturnType<typeof signedVoucher>, status: typeof receiptsTable.$inferInsert.status) {
        await db.insert(receiptsTable).values({
            requestId: voucher.requestId,
            invocationId: voucher.invocationId,
            amount: voucher.amount,
            recipientAddress: voucher.recipientAddress,
            voucherSignature: voucher.signature,
            transactionSignature: crypto.randomUUID(),
            expiresAt: new Date(voucher.expiresAt),
            publicKey: voucher.publicKey,
            invocationHash: voucher.invocationHash,
            status,
        });
    }
});
