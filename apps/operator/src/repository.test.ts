import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import type { Database } from './db/database.js';
import { receiptsTable, SETTLEMENT_STATUSES, settlementsTable } from './db/schema.js';
import { type NewReceipt, ReceiptRepository } from './repository.js';
import { createTestDatabase } from './testing.js';

describe('ReceiptRepository', () => {
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
        requestId: crypto.randomUUID(),
        invocationId: 'invocation',
        amount: 10,
        recipientAddress: 'recipient',
        voucherSignature: 'voucher-signature',
        expiresAt: new Date(),
        publicKey: 'signer',
        invocationHash: 'hash',
        ...overrides,
    });
    const longAgo = new Date(0);
    const accrue = (overrides: Partial<NewReceipt> = {}, balance = 1_000n) => receipts.accrue(receipt(overrides), balance, longAgo);

    /** Settles every accrued receipt of `publicKey` and gives the settlement `status`. */
    async function settle(status: typeof SETTLEMENT_STATUSES[number], publicKey = 'signer') {
        const group = (await receipts.findAccruedGroups()).find(group => group.publicKey === publicKey)!;
        const transactionSignature = crypto.randomUUID();
        expect(await receipts.claimSettlement({ publicKey, recipientAddress: group.recipientAddress, amount: Number(group.amount), transactionSignature, lastValidBlockHeight: 100 }, group.receiptIds)).toBe(true);
        await receipts.setSettlementStatus(transactionSignature, status);
        return transactionSignature;
    }

    describe('accrue', () => {
        test('accepts a voucher once', async () => {
            const voucher = receipt();

            expect(await receipts.accrue(voucher, 1_000n, longAgo)).toBe('accrued');
            expect(await receipts.accrue(voucher, 1_000n, longAgo)).toBe('duplicate');
            expect(await db.select().from(receiptsTable)).toHaveLength(1);
        });

        test('refuses a voucher the balance cannot cover on top of accrued receipts', async () => {
            expect(await accrue({ amount: 600 })).toBe('accrued');
            expect(await accrue({ amount: 400 })).toBe('accrued');
            expect(await accrue({ amount: 1 })).toBe('insufficient');
            // Another payer's receipts don't count.
            expect(await accrue({ amount: 1_000, publicKey: 'other' })).toBe('accrued');
        });

        test('only one of two concurrent vouchers fits the balance', async () => {
            const results = await Promise.all([accrue({ amount: 600 }), accrue({ amount: 600 })]);

            expect(results.sort()).toEqual(['accrued', 'insufficient']);
        });

        test.each(['pending', 'unconfirmed', 'failed', 'expired'] as const)('counts receipts of a %s settlement as owed', async (status) => {
            await accrue({ amount: 600 });
            await settle(status);

            expect(await accrue({ amount: 600 })).toBe('insufficient');
        });

        test('counts a confirmed settlement as owed only if the balance may predate it', async () => {
            await accrue({ amount: 600 });
            await settle('confirmed');

            // The balance was read after the settlement confirmed, so it already reflects the withdrawal.
            expect(await receipts.accrue(receipt({ amount: 600 }), 1_000n, new Date(Date.now() + 60_000))).toBe('accrued');
            // Read before: the withdrawal may be missing from it.
            expect(await receipts.accrue(receipt({ amount: 600 }), 1_000n, longAgo)).toBe('insufficient');
        });
    });

    describe('settlements', () => {
        test('groups accrued receipts by payer and recipient', async () => {
            await accrue({ amount: 1 });
            await accrue({ amount: 2 });
            await accrue({ amount: 4, recipientAddress: 'another' });
            await accrue({ amount: 8, publicKey: 'other' });

            const groups = await receipts.findAccruedGroups();

            expect(groups.map(({ publicKey, recipientAddress, amount, receiptIds }) => ({ publicKey, recipientAddress, amount, receipts: receiptIds.length }))
                .sort((a, b) => Number(a.amount - b.amount))).toEqual([
                { publicKey: 'signer', recipientAddress: 'recipient', amount: 3n, receipts: 2 },
                { publicKey: 'signer', recipientAddress: 'another', amount: 4n, receipts: 1 },
                { publicKey: 'other', recipientAddress: 'recipient', amount: 8n, receipts: 1 },
            ]);
        });

        test('settled receipts are no longer accrued', async () => {
            await accrue();
            await settle('pending');

            expect(await receipts.findAccruedGroups()).toEqual([]);
        });

        test('a claim fails without changes when a receipt is already in a settlement', async () => {
            await accrue();
            const [group] = await receipts.findAccruedGroups();
            await settle('pending');

            expect(await receipts.claimSettlement({ publicKey: 'signer', recipientAddress: 'recipient', amount: 10, transactionSignature: 'second' }, group!.receiptIds)).toBe(false);
            expect(await db.select().from(settlementsTable)).toHaveLength(1);
        });

        test.each(SETTLEMENT_STATUSES.map(status => [status, status === 'failed' || status === 'expired'] as const))(
            'a %s settlement releases its receipts: %s',
            async (status, released) => {
                await accrue();
                await settle(status);

                expect(await receipts.findAccruedGroups()).toHaveLength(released ? 1 : 0);
            },
        );

        test('finds in-flight settlements older than a cutoff', async () => {
            await accrue();
            const signature = await settle('unconfirmed');

            expect(await receipts.findUnsettled(new Date(0))).toEqual([]);
            expect(await receipts.findUnsettled(new Date(Date.now() + 1000))).toMatchObject([{ transactionSignature: signature, amount: 10 }]);
        });
    });
});
