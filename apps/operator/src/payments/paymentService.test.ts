import { eq, sql } from 'drizzle-orm';
import { CombinationResourceInvoker } from 'stellarium-ts';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import type { Database } from '../db/database.js';
import { ledgerEntriesTable, nodesTable, organizationsTable, receiptsTable } from '../db/schema.js';
import { OperationError } from '../errors.js';
import type { OrganizationService } from '../organizations.js';
import {
    createTestDatabase, generateNodeKeys, type NodeKeys, PAYER_ORGANIZATION, PROVIDER_ORGANIZATION, seedOrganizations, signedInferenceVoucher, signedVoucher,
} from '../testing.js';
import { HOLD_GRACE_MS, PaymentService } from './paymentService.js';

describe('PaymentService', () => {
    let db: Database;
    let close: () => Promise<void>;
    let organizations: OrganizationService;
    let service: PaymentService;
    let provider: NodeKeys;
    let payer: NodeKeys;

    beforeEach(async () => {
        ({ db, close } = await createTestDatabase());
        ({ organizations, provider, payer } = await seedOrganizations(db, 100_000));
        service = new PaymentService(db, organizations, { platformFeeBps: 2000 });
    });

    afterEach(async () => {
        await close();
    });

    const rejection = (promise: Promise<unknown>) => promise.then(
        () => { throw new Error('expected a rejection'); },
        (error: OperationError) => ({ status: error.statusCode, message: error.message }),
    );

    async function balances(id: string) {
        const [row] = await db.select().from(organizationsTable).where(eq(organizationsTable.id, id));
        return { balance: row!.balanceMicroUsd, held: row!.heldMicroUsd, payable: row!.payableMicroUsd };
    }

    /** Every ledger transaction sums to zero, and the cached balances match the ledger. */
    async function expectLedgerConsistent() {
        const unbalanced = await db.select({ transactionId: ledgerEntriesTable.transactionId })
            .from(ledgerEntriesTable).groupBy(ledgerEntriesTable.transactionId)
            .having(sql`sum(${ledgerEntriesTable.amountMicroUsd}) <> 0`);
        expect(unbalanced).toEqual([]);
        for (const id of [PAYER_ORGANIZATION, PROVIDER_ORGANIZATION]) {
            const sum = async (account: string) => Number((await db.select({ total: sql<string>`coalesce(sum(${ledgerEntriesTable.amountMicroUsd}), 0)` })
                .from(ledgerEntriesTable).where(eq(ledgerEntriesTable.account, account)))[0]!.total);
            const cached = await balances(id);
            expect(cached.balance).toBe(await sum(`org:${id}:balance`));
            expect(cached.payable).toBe(await sum(`org:${id}:payable`));
        }
    }

    describe('authorize', () => {
        test('accepts a voucher created by the stellarium-ts node and holds its amount', async () => {
            // The contract the copies of the wire format must agree on.
            const invoker = new CombinationResourceInvoker(undefined as never, 100_000, payer.publicKey, payer.privateKey);
            const voucher = invoker.createPaymentVoucher(PROVIDER_ORGANIZATION, 10_000, 'com.example', 'Weather', 'temperature', [{ name: 'city', value: 'Oslo' }]);

            expect(await service.authorize(provider.publicKey, voucher)).toEqual({ status: 'held', heldMicroUsd: 10_000 });
            expect(await balances(PAYER_ORGANIZATION)).toEqual({ balance: 100_000, held: 10_000, payable: 0 });
        });

        test('accepts an inference voucher created by the stellarium-ts node and holds its maxAmount', async () => {
            const invoker = new CombinationResourceInvoker(undefined as never, 100_000, payer.publicKey, payer.privateKey);
            const rates = { inputCostMicroUsdPerMillionTokens: 3_000_000, outputCostMicroUsdPerMillionTokens: 15_000_000, recipientOrganizationId: PROVIDER_ORGANIZATION };
            const voucher = invoker.createInferenceVoucher(rates, 1_503, 100, 'com.example', 'Model', 'complete', [{ name: 'prompt', value: 'Hi' }, { name: 'maxTokens', value: 100 }]);

            expect(await service.authorize(provider.publicKey, voucher)).toEqual({ status: 'held', heldMicroUsd: 1_503 });
        });

        test('returns the same hold for a retried authorization', async () => {
            const { voucher } = signedVoucher(payer);
            await service.authorize(provider.publicKey, voucher);

            expect(await service.authorize(provider.publicKey, voucher)).toEqual({ status: 'held', heldMicroUsd: 10_000 });
            expect((await balances(PAYER_ORGANIZATION)).held).toBe(10_000);
        });

        test('refuses a voucher beyond the available balance, counting other holds', async () => {
            await service.authorize(provider.publicKey, signedVoucher(payer, { amount: 60_000 }).voucher);

            expect(await rejection(service.authorize(provider.publicKey, signedVoucher(payer, { amount: 40_001 }).voucher)))
                .toMatchObject({ status: 402, message: expect.stringContaining('Insufficient balance') });
            await expect(service.authorize(provider.publicKey, signedVoucher(payer, { amount: 40_000 }).voucher)).resolves.toMatchObject({ status: 'held' });
        });

        test('concurrent authorizations can\'t hold more than the balance together', async () => {
            const results = await Promise.allSettled(Array.from({ length: 5 }, () =>
                service.authorize(provider.publicKey, signedVoucher(payer, { amount: 30_000 }).voucher)));

            expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(3);
            expect((await balances(PAYER_ORGANIZATION)).held).toBe(90_000);
        });

        test.each([
            ['an altered amount', (keys: NodeKeys) => ({ ...signedVoucher(keys).voucher, amount: 1 }), 401],
            ['an expired voucher', (keys: NodeKeys) => signedVoucher(keys, { expiresAt: new Date(Date.now() - 1000).toISOString() }).voucher, 401],
            ['a malformed key', (keys: NodeKeys) => ({ ...signedVoucher(keys).voucher, publicKey: 'not-a-key' }), 400],
        ])('rejects %s', async (_, voucher, status) => {
            expect(await rejection(service.authorize(provider.publicKey, voucher(payer)))).toMatchObject({ status });
        });

        test('refuses a provider node that isn\'t in the recipient organization', async () => {
            expect(await rejection(service.authorize(payer.publicKey, signedVoucher(payer).voucher))).toMatchObject({ status: 403 });
            expect(await rejection(service.authorize(generateNodeKeys().publicKey, signedVoucher(payer).voucher))).toMatchObject({ status: 403 });
        });

        test('refuses a payer node that isn\'t enrolled', async () => {
            expect(await rejection(service.authorize(provider.publicKey, signedVoucher(generateNodeKeys()).voucher)))
                .toMatchObject({ status: 402, message: expect.stringContaining('not enrolled') });
        });

        test('refuses a revoked payer node and a frozen payer organization', async () => {
            const revoked = generateNodeKeys();
            await organizations.enroll(PAYER_ORGANIZATION, revoked.publicKey);
            await db.update(nodesTable).set({ revokedAt: new Date() }).where(eq(nodesTable.publicKey, revoked.publicKey));
            expect(await rejection(service.authorize(provider.publicKey, signedVoucher(revoked).voucher))).toEqual({ status: 403, message: 'Payer node has been revoked' });

            await db.update(organizationsTable).set({ frozenAt: new Date() }).where(eq(organizationsTable.id, PAYER_ORGANIZATION));

            expect(await rejection(service.authorize(provider.publicKey, signedVoucher(payer).voucher))).toEqual({ status: 403, message: 'Payer organization is frozen' });
        });

        test('refuses an organization paying itself', async () => {
            const sibling = generateNodeKeys();
            await organizations.enroll(PROVIDER_ORGANIZATION, sibling.publicKey);

            expect(await rejection(service.authorize(provider.publicKey, signedVoucher(sibling).voucher))).toMatchObject({ status: 422 });
        });

        test('refuses a recipient organization that can\'t be paid out', async () => {
            await organizations.setPayoutsEnabled(PROVIDER_ORGANIZATION, false);

            expect(await rejection(service.authorize(provider.publicKey, signedVoucher(payer).voucher))).toMatchObject({ status: 422 });
        });

        test('refuses a reused requestId and invocationId', async () => {
            const { voucher } = signedVoucher(payer);
            await service.authorize(provider.publicKey, voucher);

            const reused = signedVoucher(payer, { requestId: voucher.requestId, invocationId: voucher.invocationId, amount: 5_000 }).voucher;
            expect(await rejection(service.authorize(provider.publicKey, reused))).toMatchObject({ status: 409 });
        });
    });

    describe('capture', () => {
        test('charges the payer and credits the recipient less the platform fee', async () => {
            const submission = signedVoucher(payer);
            await service.authorize(provider.publicKey, submission.voucher);

            expect(await service.capture(provider.publicKey, submission)).toEqual({ status: 'captured', amountMicroUsd: 10_000 });

            expect(await balances(PAYER_ORGANIZATION)).toEqual({ balance: 90_000, held: 0, payable: 0 });
            expect(await balances(PROVIDER_ORGANIZATION)).toEqual({ balance: 0, held: 0, payable: 8_000 });
            const [receipt] = await db.select().from(receiptsTable);
            expect(receipt).toMatchObject({ status: 'captured', amountMicroUsd: 10_000, feeMicroUsd: 2_000 });
            await expectLedgerConsistent();
        });

        test('is idempotent', async () => {
            const submission = signedVoucher(payer);
            await service.authorize(provider.publicKey, submission.voucher);
            await service.capture(provider.publicKey, submission);

            expect(await service.capture(provider.publicKey, submission)).toEqual({ status: 'captured', amountMicroUsd: 10_000 });
            expect((await balances(PAYER_ORGANIZATION)).balance).toBe(90_000);
        });

        test('lets any active node of the recipient organization capture', async () => {
            const sibling = generateNodeKeys();
            await organizations.enroll(PROVIDER_ORGANIZATION, sibling.publicKey);
            const submission = signedVoucher(payer);
            await service.authorize(provider.publicKey, submission.voucher);

            await expect(service.capture(sibling.publicKey, submission)).resolves.toMatchObject({ status: 'captured' });
        });

        test('charges inference usage at the voucher\'s rates, capped at the hold', async () => {
            // 1,000 input at $3/M plus 500 output at $15/M: 3,000 + 7,500.
            const submission = signedInferenceVoucher(payer);
            await service.authorize(provider.publicKey, submission.voucher);
            expect(await service.capture(provider.publicKey, submission)).toEqual({ status: 'captured', amountMicroUsd: 10_500 });

            const capped = signedInferenceVoucher(payer, { maxAmount: 5_000 });
            await service.authorize(provider.publicKey, capped.voucher);
            expect(await service.capture(provider.publicKey, capped)).toEqual({ status: 'captured', amountMicroUsd: 5_000 });
            await expectLedgerConsistent();
        });

        test('releases an inference hold whose usage costs nothing', async () => {
            const submission = signedInferenceVoucher(payer, {}, { inputTokens: 0, outputTokens: 0 });
            await service.authorize(provider.publicKey, submission.voucher);

            expect(await service.capture(provider.publicKey, submission)).toEqual({ status: 'released' });
            expect(await balances(PAYER_ORGANIZATION)).toEqual({ balance: 100_000, held: 0, payable: 0 });
        });

        test('rejects reported output beyond the voucher\'s maxTokens', async () => {
            const submission = signedInferenceVoucher(payer, { maxTokens: 100 }, { inputTokens: 10, outputTokens: 101 });
            await service.authorize(provider.publicKey, submission.voucher);

            expect(await rejection(service.capture(provider.publicKey, submission))).toMatchObject({ status: 400 });
        });

        test('refuses a voucher that was never authorized, or a different one with the same ids', async () => {
            const submission = signedVoucher(payer);
            expect(await rejection(service.capture(provider.publicKey, submission))).toMatchObject({ status: 404 });

            await service.authorize(provider.publicKey, submission.voucher);
            const other = signedVoucher(payer, { requestId: submission.voucher.requestId, invocationId: submission.voucher.invocationId, amount: 9_000 });
            expect(await rejection(service.capture(provider.publicKey, other))).toMatchObject({ status: 409 });
        });

        test('refuses a provider outside the recipient organization', async () => {
            const submission = signedVoucher(payer);
            await service.authorize(provider.publicKey, submission.voucher);

            expect(await rejection(service.capture(payer.publicKey, submission))).toMatchObject({ status: 403 });
        });
    });

    describe('release', () => {
        test('frees the hold without charging, and is idempotent', async () => {
            const { voucher } = signedVoucher(payer);
            await service.authorize(provider.publicKey, voucher);

            expect(await service.release(provider.publicKey, voucher)).toEqual({ status: 'released' });
            expect(await service.release(provider.publicKey, voucher)).toEqual({ status: 'released' });
            expect(await balances(PAYER_ORGANIZATION)).toEqual({ balance: 100_000, held: 0, payable: 0 });
            expect(await rejection(service.capture(provider.publicKey, { voucher }))).toMatchObject({ status: 409 });
        });

        test('refuses to release a captured voucher', async () => {
            const submission = signedVoucher(payer);
            await service.authorize(provider.publicKey, submission.voucher);
            await service.capture(provider.publicKey, submission);

            expect(await rejection(service.release(provider.publicKey, submission.voucher))).toMatchObject({ status: 409 });
        });
    });

    test('releaseExpiredHolds frees holds past their voucher\'s expiry and grace period only', async () => {
        const expiring = signedVoucher(payer, { expiresAt: new Date(Date.now() + 1_000).toISOString() });
        const fresh = signedVoucher(payer, { expiresAt: new Date(Date.now() + 3_600_000).toISOString() });
        await service.authorize(provider.publicKey, expiring.voucher);
        await service.authorize(provider.publicKey, fresh.voucher);

        expect(await service.releaseExpiredHolds(new Date(Date.now() + 1_000 + HOLD_GRACE_MS - 1_000))).toBe(0);
        expect(await service.releaseExpiredHolds(new Date(Date.now() + 2_000 + HOLD_GRACE_MS))).toBe(1);
        expect((await balances(PAYER_ORGANIZATION)).held).toBe(10_000);
    });
});
