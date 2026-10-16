import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import type { Database } from './db/database.js';
import { RECEIPT_STATUSES } from './db/schema.js';
import { type NewReceipt, ReceiptRepository } from './repository.js';
import { createTestDatabase } from './testing.js';

describe('ReceiptRepository.claim', () => {
    let db: Database;
    let close: () => Promise<void>;
    let receipts: ReceiptRepository;

    beforeEach(async () => {
        ({ db, close } = await createTestDatabase());
        receipts = new ReceiptRepository(db);
    });

    afterEach(async () => {
        await close();
    });

    const receipt = (overrides: Partial<NewReceipt> = {}): NewReceipt => ({
        requestId: 'request',
        invocationId: 'invocation',
        amount: 10,
        recipientAddress: 'recipient',
        voucherSignature: 'voucher-signature',
        transactionSignature: crypto.randomUUID(),
        expiresAt: new Date(),
        publicKey: 'signer',
        invocationHash: 'hash',
        lastValidBlockHeight: 100,
        ...overrides,
    });

    test.each(RECEIPT_STATUSES.map(status => [status, status === 'failed' || status === 'expired'] as const))(
        'a %s receipt can be claimed again: %s',
        async (status, reclaimable) => {
            const first = receipt();
            expect(await receipts.claim(first)).toBe(true);
            await receipts.setStatus(first.transactionSignature, status);

            const second = receipt();
            expect(await receipts.claim(second)).toBe(reclaimable);
            const stored = await receipts.getByRequestIdAndInvocationId('request', 'invocation');
            expect(stored?.transactionSignature).toBe(reclaimable ? second.transactionSignature : first.transactionSignature);
            expect(stored?.status).toBe(reclaimable ? 'pending' : status);
        },
    );

    test('only the original signer can claim a failed voucher again', async () => {
        const first = receipt();
        await receipts.claim(first);
        await receipts.setStatus(first.transactionSignature, 'failed');

        expect(await receipts.claim(receipt({ publicKey: 'someone-else' }))).toBe(false);
    });
});
