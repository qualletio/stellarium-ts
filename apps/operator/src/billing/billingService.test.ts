import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import type { Database } from '../db/database.js';
import { topUpsTable } from '../db/schema.js';
import { OperationError } from '../errors.js';
import type { OrganizationService } from '../organizations.js';
import { PayoutService } from '../payouts/payoutService.js';
import { StripeWebhookService } from '../stripe/webhooks.js';
import { BILLING_CONFIG, createTestDatabase, FakeStripe, ledgerProblems, PAYER_ORGANIZATION, PROVIDER_ORGANIZATION, seedOrganizations, stripeEvent } from '../testing.js';
import { BillingService } from './billingService.js';

describe('BillingService and Stripe webhooks', () => {
    let db: Database;
    let close: () => Promise<void>;
    let organizations: OrganizationService;
    let stripe: FakeStripe;
    let billing: BillingService;
    let webhooks: StripeWebhookService;

    beforeEach(async () => {
        ({ db, close } = await createTestDatabase());
        ({ organizations } = await seedOrganizations(db, 0));
        stripe = new FakeStripe();
        billing = new BillingService(db, stripe, BILLING_CONFIG);
        webhooks = new StripeWebhookService(db, billing, new PayoutService(db, stripe));
    });

    afterEach(async () => {
        await close();
    });

    const payer = async () => (await organizations.get(PAYER_ORGANIZATION))!;
    const rejection = (promise: Promise<unknown>) => promise.then(
        () => { throw new Error('expected a rejection'); },
        (error: OperationError) => ({ status: error.statusCode, message: error.message }),
    );

    /** The Checkout Session id the operator stored for a top-up. */
    async function sessionOf(topUpId: number) {
        return (await db.select().from(topUpsTable).where(eq(topUpsTable.id, topUpId)))[0]!.checkoutSessionId!;
    }

    /** Starts a top-up and completes its Checkout Session. Returns the session and payment intent ids. */
    async function topUp(amountCents: number) {
        const { topUpId } = await billing.createTopUp(await payer(), amountCents, 'user_1');
        const sessionId = await sessionOf(topUpId);
        const paymentIntent = `pi_${topUpId}`;
        await webhooks.handle(stripeEvent('checkout.session.completed', {
            id: sessionId, payment_status: 'paid', currency: 'usd', amount_total: amountCents, payment_intent: paymentIntent,
        }));
        return { sessionId, paymentIntent };
    }

    describe('top-ups', () => {
        test('opens a Checkout Session for the organization\'s Stripe customer, created once', async () => {
            const first = await billing.createTopUp(await payer(), 2_500, 'user_1');
            await billing.createTopUp(await payer(), 1_000);

            expect(first.url).toMatch(/^https:\/\/checkout\.stripe\.test\//);
            expect(stripe.calls.filter(call => call.method === 'createCustomer')).toHaveLength(1);
            expect(stripe.calls.find(call => call.method === 'createCheckoutSession')!.params).toMatchObject({
                amountCents: 2_500, organizationId: PAYER_ORGANIZATION, topUpId: first.topUpId,
                successUrl: 'https://platform.test/billing?top_up=success',
            });
            const [row] = await db.select().from(topUpsTable).where(eq(topUpsTable.id, first.topUpId));
            expect(row).toMatchObject({ status: 'pending', amountMicroUsd: 25_000_000, checkoutSessionId: expect.any(String), createdBy: 'user_1' });
            expect((await payer()).balanceMicroUsd).toBe(0);
        });

        test.each([999, 100_001, 10.5])('refuses %s cents', async (amountCents) => {
            expect(await rejection(billing.createTopUp(await payer(), amountCents))).toMatchObject({ status: 400 });
        });

        test('credits the balance once when the session is paid, even if Stripe redelivers', async () => {
            const { topUpId } = await billing.createTopUp(await payer(), 2_500);
            const event = stripeEvent('checkout.session.completed', { id: await sessionOf(topUpId), payment_status: 'paid', currency: 'usd', amount_total: 2_500, payment_intent: 'pi_1' });

            await webhooks.handle(event);
            await webhooks.handle(event);
            // A different event for the same session, such as async_payment_succeeded after completion.
            await webhooks.handle(stripeEvent('checkout.session.async_payment_succeeded', { ...event.data.object }));

            expect((await payer()).balanceMicroUsd).toBe(25_000_000);
            expect(await ledgerProblems(db)).toEqual([]);
        });

        test('waits for a delayed payment method to succeed', async () => {
            const { topUpId } = await billing.createTopUp(await payer(), 2_500);
            const session = { id: await sessionOf(topUpId), currency: 'usd', amount_total: 2_500, payment_intent: 'pi_1' };

            await webhooks.handle(stripeEvent('checkout.session.completed', { ...session, payment_status: 'unpaid' }));
            expect((await payer()).balanceMicroUsd).toBe(0);

            await webhooks.handle(stripeEvent('checkout.session.async_payment_succeeded', { ...session, payment_status: 'paid' }));
            expect((await payer()).balanceMicroUsd).toBe(25_000_000);
        });

        test('ignores sessions that aren\'t top-ups', async () => {
            await webhooks.handle(stripeEvent('checkout.session.completed', { id: 'cs_other', payment_status: 'paid', currency: 'usd', amount_total: 100, payment_intent: 'pi_x' }));

            expect(await ledgerProblems(db)).toEqual([]);
        });
    });

    describe('refunds and disputes', () => {
        test('debits refunds by Stripe\'s cumulative refunded amount', async () => {
            const { paymentIntent } = await topUp(5_000);

            await webhooks.handle(stripeEvent('charge.refunded', { id: 'ch_1', payment_intent: paymentIntent, amount_refunded: 1_000 }));
            await webhooks.handle(stripeEvent('charge.refunded', { id: 'ch_1', payment_intent: paymentIntent, amount_refunded: 3_000 }));

            expect((await payer()).balanceMicroUsd).toBe(20_000_000);
            expect(await ledgerProblems(db)).toEqual([]);
        });

        test('debits a dispute when it opens, possibly below zero, and re-credits it if won', async () => {
            const { paymentIntent } = await topUp(5_000);
            // A negative promotion stands in for spending $45 of the $50 before the dispute.
            await organizations.grantPromotion(PAYER_ORGANIZATION, -45_000_000);

            await webhooks.handle(stripeEvent('charge.dispute.created', { id: 'dp_1', payment_intent: paymentIntent, amount: 5_000 }));
            expect((await payer()).balanceMicroUsd).toBe(-45_000_000);

            await webhooks.handle(stripeEvent('charge.dispute.closed', { id: 'dp_1', payment_intent: paymentIntent, amount: 5_000, status: 'won' }));
            expect((await payer()).balanceMicroUsd).toBe(5_000_000);
            expect(await ledgerProblems(db)).toEqual([]);
        });

        test('keeps a lost dispute\'s debit', async () => {
            const { paymentIntent } = await topUp(5_000);

            await webhooks.handle(stripeEvent('charge.dispute.created', { id: 'dp_1', payment_intent: paymentIntent, amount: 5_000 }));
            await webhooks.handle(stripeEvent('charge.dispute.closed', { id: 'dp_1', payment_intent: paymentIntent, amount: 5_000, status: 'lost' }));

            expect((await payer()).balanceMicroUsd).toBe(0);
        });
    });

    describe('Connect', () => {
        test('creates the Express account once and returns onboarding links', async () => {
            const provider = (await organizations.get(PROVIDER_ORGANIZATION))!;

            const { url } = await billing.connectOnboarding(provider);
            await billing.connectOnboarding((await organizations.get(PROVIDER_ORGANIZATION))!);

            expect(url).toMatch(/^https:\/\/connect\.stripe\.test\/acct_/);
            expect(stripe.calls.filter(call => call.method === 'createExpressAccount')).toHaveLength(1);
            expect((await organizations.get(PROVIDER_ORGANIZATION))!.stripeAccountId).toMatch(/^acct_/);
        });

        test('mirrors account.updated onto payoutsEnabled', async () => {
            await organizations.setPayoutsEnabled(PROVIDER_ORGANIZATION, false);
            await billing.connectOnboarding((await organizations.get(PROVIDER_ORGANIZATION))!);
            const account = (await organizations.get(PROVIDER_ORGANIZATION))!.stripeAccountId!;

            await webhooks.handle(stripeEvent('account.updated', { id: account, payouts_enabled: true, capabilities: { transfers: 'active' } }, account));
            expect((await organizations.get(PROVIDER_ORGANIZATION))!.payoutsEnabled).toBe(true);

            await webhooks.handle(stripeEvent('account.updated', { id: account, payouts_enabled: true, capabilities: { transfers: 'inactive' } }, account));
            expect((await organizations.get(PROVIDER_ORGANIZATION))!.payoutsEnabled).toBe(false);
        });

        test('refuses an Express dashboard link before onboarding starts', async () => {
            expect(await rejection(billing.connectDashboard((await organizations.get(PROVIDER_ORGANIZATION))!))).toMatchObject({ status: 409 });
        });
    });
});
