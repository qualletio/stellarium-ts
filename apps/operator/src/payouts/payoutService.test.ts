import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import type { Database } from '../db/database.js';
import { moneyChangesTable, nodesTable, organizationsTable, payoutsTable, receiptsTable, runsTable, topUpsTable } from '../db/schema.js';
import type { OrganizationService } from '../organizations.js';
import { PaymentService } from '../payments/paymentService.js';
import { StripeRequestError } from '../stripe/gateway.js';
import { createService } from '../service.js';
import { createTestDatabase, FakeStripe, generateNodeKeys, ledgerProblems, type NodeKeys, PAYER_ORGANIZATION, PROVIDER_ORGANIZATION, seedOrganizations, signedContractVoucher, signedVoucher, APPLY_BEFORE_VERIFYING } from '../testing.js';
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

    test('holds a script run\'s charge for the hold window, like a voucher\'s', async () => {
        const service = createService(db, { money: APPLY_BEFORE_VERIFYING, platformFeeBps: 2000, runTokenPrivateKey: generateNodeKeys().privateKey });
        // 4 tokens at 5,000,000 micro-USD each: the provider is owed 16,000,000.
        await db.update(nodesTable).set({ listed: true, priceMicroUsdPerMillionTokens: 5_000_000_000_000 }).where(eq(nodesTable.publicKey, provider.publicKey));
        const { client } = await service.clients.create(PAYER_ORGANIZATION, { nodePublicKey: provider.publicKey, maxRunCostMicroUsd: 50_000_000 });
        const { token } = await service.runTokens!.sign({ clientId: client.id, organizationId: PAYER_ORGANIZATION, nodePublicKey: provider.publicKey });
        const runId = crypto.randomUUID();
        await service.runs.authorize(provider.publicKey, { token, runId, source: 'request R {\n  return 1 + 2\n}' });
        await service.runs.capture(provider.publicKey, { runId, tokens: 4 });

        expect(await payouts.runPayouts()).toEqual({ paid: 0, failed: 0, pending: 0 });
        await db.update(runsTable).set({ capturedAt: new Date(Date.now() - 8 * DAY) }).where(eq(runsTable.runId, runId));
        expect(await payouts.runPayouts()).toEqual({ paid: 1, failed: 0, pending: 0 });
        expect(transfers()).toMatchObject([{ amountCents: 1_600 }]);
    });

    describe('contract payments', () => {
        /** A payer-funded contract on the provider's node pays the provider 20,000,000 (16,000,000 after the fee). Returns the tree's root run. */
        async function paidByContract() {
            const service = createService(db, { money: APPLY_BEFORE_VERIFYING, platformFeeBps: 2000, runTokenPrivateKey: generateNodeKeys().privateKey });
            await db.insert(topUpsTable).values({ organizationId: PAYER_ORGANIZATION, amountMicroUsd: 50_000_000, status: 'succeeded' });
            await db.update(nodesTable).set({ listed: true }).where(eq(nodesTable.publicKey, provider.publicKey));
            await organizations.setNodeMoneyLimits(provider.publicKey, { maxContractBalanceMicroUsd: 1_000_000_000 });
            await organizations.setNodeMoneyLimits(payer.publicKey, { maxApiKeyRunValueMicroUsd: 50_000_000, monthlyApiKeyValueCapMicroUsd: 50_000_000 });
            const job = { nodePublicKey: provider.publicKey, name: 'com.example.Job', version: '1' };
            await service.money.register(provider.publicKey, { name: job.name, version: job.version, payable: true, source: 'payable contract', requestscriptVersion: '1.8.0', dependencies: [] });
            const root = crypto.randomUUID();
            await service.runs.open(payer.publicKey, { runId: root });
            const voucher = signedContractVoucher(payer, { runId: root });
            await service.runs.authorizeContract(provider.publicKey, { voucher, source: 'contract com.example.Job(a: int32): int32 {\n  return a\n}' });
            await service.money.stage(payer.publicKey, { runId: root, callIndex: 0, function: 'attach', parameters: { to: job, amount: 20_000_000, attachmentId: crypto.randomUUID(), payees: [PROVIDER_ORGANIZATION] } });
            await service.money.stage(provider.publicKey, { runId: voucher.invocationId, callIndex: 0, contract: { name: job.name, version: job.version }, function: 'pay', parameters: { to: PROVIDER_ORGANIZATION, amount: 20_000_000, from: PAYER_ORGANIZATION } });
            await service.runs.capture(provider.publicKey, { runId: voucher.invocationId, tokens: 0 });
            await service.runs.capture(payer.publicKey, { runId: root, tokens: 0 });
            expect((await provider_()).payableMicroUsd).toBe(16_000_000);
            const age = () => db.update(moneyChangesTable).set({ settledAt: new Date(Date.now() - 8 * DAY) });
            return { service, root, age };
        }

        test('aren\'t paid out until their tree is verified, and the hold window has passed', async () => {
            const { service, root, age } = await paidByContract();
            expect(await service.money.unverifiedTrees()).toMatchObject([{ runId: root }]);
            expect(await payouts.runPayouts()).toEqual({ paid: 0, failed: 0, pending: 0 });
            await age();
            // Past the hold window, but unverified.
            expect(await payouts.runPayouts()).toEqual({ paid: 0, failed: 0, pending: 0 });

            await service.money.recordVerification(root, 'verified');
            expect(await service.money.unverifiedTrees()).toEqual([]);
            expect(await payouts.runPayouts()).toEqual({ paid: 1, failed: 0, pending: 0 });
            expect(transfers()).toMatchObject([{ amountCents: 1_600 }]);
            expect(await ledgerProblems(db)).toEqual([]);
        });

        test('stay held when their tree fails verification, and a result can\'t be changed', async () => {
            const { service, root, age } = await paidByContract();
            await age();
            await service.money.recordVerification(root, 'failed');
            expect(await payouts.runPayouts()).toEqual({ paid: 0, failed: 0, pending: 0 });
            await expect(service.money.recordVerification(root, 'verified')).rejects.toMatchObject({ statusCode: 409 });
            // Recording the same result again changes nothing.
            await service.money.recordVerification(root, 'failed');
        });
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
