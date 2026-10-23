import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import type { Database } from '../db/database.js';
import { organizationsTable, payoutsTable, receiptsTable } from '../db/schema.js';
import type { OrganizationService } from '../organizations.js';
import { PaymentService } from '../payments/paymentService.js';
import { StripeRequestError } from '../stripe/gateway.js';
import { createTestDatabase, FakeStripe, ledgerProblems, type NodeKeys, PROVIDER_ORGANIZATION, seedOrganizations, signedVoucher } from '../testing.js';
import { PENDING_RETRY_UNTIL_MS, type PayoutPolicy, PayoutService } from './payoutService.js';

const DAY = 1000 * 60 * 60 * 24;
const POLICY: PayoutPolicy = { holdMs: 7 * DAY, intervalMs: 7 * DAY, minimumMicroUsd: 10_000_000 };

describe('PayoutService', () => {
    let db: Database;
    let close: () => Promise<void>;
    let organizations: OrganizationService;
    let payments: PaymentService;
    let stripe: FakeStripe;
    let payouts: PayoutService;
    let provider: NodeKeys;
    let payer: NodeKeys;

    beforeEach(async () => {
        ({ db, close } = await createTestDatabase());
        ({ organizations, provider, payer } = await seedOrganizations(db, 1_000_000_000));
        await db.update(organizationsTable).set({ stripeAccountId: 'acct_provider' }).where(eq(organizationsTable.id, PROVIDER_ORGANIZATION));
        payments = new PaymentService(db, organizations, { platformFeeBps: 2000 });
        stripe = new FakeStripe();
        payouts = new PayoutService(db, stripe, POLICY);
    });

    afterEach(async () => {
        await close();
    });

    /** Captures a payment of `amount` (the provider is owed 80%) and backdates its capture by `ageMs`. */
    async function earn(amount: number, ageMs: number) {
        const submission = signedVoucher(payer, { amount });
        await payments.authorize(provider.publicKey, submission.voucher);
        await payments.capture(provider.publicKey, submission);
        await db.update(receiptsTable).set({ capturedAt: new Date(Date.now() - ageMs) }).where(eq(receiptsTable.requestId, submission.voucher.requestId));
    }

    const provider_ = async () => (await organizations.get(PROVIDER_ORGANIZATION))!;
    const transfers = () => stripe.calls.filter(call => call.method === 'createTransfer').map(call => call.params);

    test('pays out what was captured before the hold window, in whole cents, keeping the remainder payable', async () => {
        // Owed 12,000,008 + 4,000,000 micro-USD; only the first is past the hold.
        await earn(15_000_010, 8 * DAY);
        await earn(5_000_000, 1 * DAY);

        expect(await payouts.runPayouts()).toEqual({ paid: 1, failed: 0, pending: 0 });

        expect(transfers()).toEqual([{ destination: 'acct_provider', amountCents: 1_200, payoutId: expect.any(Number), idempotencyKey: expect.stringMatching(/^payout_/) }]);
        expect((await provider_()).payableMicroUsd).toBe(4_000_008);
        const [payout] = await db.select().from(payoutsTable);
        expect(payout).toMatchObject({ status: 'paid', amountCents: 1_200, stripeTransferId: expect.stringMatching(/^tr_/) });
        expect(await ledgerProblems(db)).toEqual([]);
    });

    test('waits for the minimum', async () => {
        await earn(12_000_000, 8 * DAY);

        expect(await payouts.runPayouts()).toEqual({ paid: 0, failed: 0, pending: 0 });
        expect(transfers()).toEqual([]);
    });

    test('pays an organization at most once per interval', async () => {
        await earn(20_000_000, 8 * DAY);
        await payouts.runPayouts();
        await earn(20_000_000, 8 * DAY);

        expect(await payouts.runPayouts()).toMatchObject({ paid: 0 });
        expect(await payouts.runPayouts(new Date(Date.now() + 7 * DAY + 1000))).toMatchObject({ paid: 1 });
    });

    test('skips organizations that can\'t be paid out', async () => {
        await earn(20_000_000, 8 * DAY);
        await organizations.setPayoutsEnabled(PROVIDER_ORGANIZATION, false);

        expect(await payouts.runPayouts()).toMatchObject({ paid: 0 });
    });

    test('fails a refused transfer and returns its amount to the payable balance', async () => {
        await earn(20_000_000, 8 * DAY);
        stripe.createTransfer = async () => { throw new StripeRequestError('No such destination', true); };

        expect(await payouts.runPayouts()).toEqual({ paid: 0, failed: 1, pending: 0 });

        expect((await provider_()).payableMicroUsd).toBe(16_000_000);
        expect((await db.select().from(payoutsTable))[0]).toMatchObject({ status: 'failed', failureReason: 'No such destination' });
        expect(await ledgerProblems(db)).toEqual([]);
    });

    test('keeps a payout pending after a transient failure and retries it with the same idempotency key', async () => {
        await earn(20_000_000, 8 * DAY);
        const send = stripe.createTransfer;
        stripe.createTransfer = async () => { throw new StripeRequestError('Connection reset', false); };
        expect(await payouts.runPayouts()).toEqual({ paid: 0, failed: 0, pending: 1 });
        expect((await provider_()).payableMicroUsd).toBe(0);

        stripe.createTransfer = send;
        // Not retried until it has been pending a minute, so a run doesn't race its own transfer.
        expect(await payouts.reconcilePending()).toMatchObject({ paid: 0 });
        const retried = await payouts.reconcilePending(new Date(Date.now() + 2 * 60_000));

        expect(retried).toMatchObject({ paid: 1, stale: [] });
        expect((await db.select().from(payoutsTable))[0]).toMatchObject({ status: 'paid' });
    });

    test('leaves a payout pending past Stripe\'s idempotency window for review', async () => {
        await earn(20_000_000, 8 * DAY);
        stripe.createTransfer = async () => { throw new StripeRequestError('Timeout', false); };
        await payouts.runPayouts();

        const result = await payouts.reconcilePending(new Date(Date.now() + PENDING_RETRY_UNTIL_MS + 60_000));

        expect(result.stale).toHaveLength(1);
        expect(result.paid).toBe(0);
    });

    test('credits reversals back to the payable balance by Stripe\'s cumulative amount', async () => {
        await earn(20_000_000, 8 * DAY);
        await payouts.runPayouts();
        const [payout] = await db.select().from(payoutsTable);

        await payouts.handleTransferReversed(payout!.stripeTransferId!, 600);
        await payouts.handleTransferReversed(payout!.stripeTransferId!, 600);
        expect((await provider_()).payableMicroUsd).toBe(6_000_000);
        expect((await db.select().from(payoutsTable))[0]).toMatchObject({ status: 'paid', reversedCents: 600 });

        await payouts.handleTransferReversed(payout!.stripeTransferId!, 1_600);
        expect((await provider_()).payableMicroUsd).toBe(16_000_000);
        expect((await db.select().from(payoutsTable))[0]).toMatchObject({ status: 'reversed', reversedCents: 1_600 });
        expect(await ledgerProblems(db)).toEqual([]);
    });
});
