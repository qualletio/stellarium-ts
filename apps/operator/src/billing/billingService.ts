import { and, eq, isNull } from "drizzle-orm";
import type { Database, Transaction } from "../db/database.js";
import { organizationsTable, topUpsTable } from "../db/schema.js";
import { OperationError } from "../errors.js";
import { accounts, adjustOrganization, lockOrganizations, type Organization, postLedgerTransaction } from "../ledger.js";
import { MICRO_USD_PER_CENT } from "../payouts/payoutService.js";
import type { StripeGateway } from "../stripe/gateway.js";

export type TopUp = typeof topUpsTable.$inferSelect;

export interface BillingConfig {
    /** The dashboard's origin. Stripe returns users to pages under it. */
    dashboardUrl: string;
    minimumTopUpCents: number;
    maximumTopUpCents: number;
}

export const DEFAULT_MINIMUM_TOP_UP_CENTS = 1_000;
export const DEFAULT_MAXIMUM_TOP_UP_CENTS = 100_000;

/**
 * Card top-ups through Stripe Checkout, the Stripe Customer Portal, and Connect onboarding.
 * Balances change only when Stripe's webhooks confirm a payment, refund or dispute.
 */
export class BillingService {
    constructor(private readonly db: Database, private readonly stripe: StripeGateway, private readonly config: BillingConfig) {}

    /** Starts a top-up. Returns the Checkout URL to send the user to. The balance is credited by the webhook. */
    async createTopUp(organization: Organization, amountCents: number, createdBy?: string): Promise<{ topUpId: number, url: string }> {
        const { minimumTopUpCents, maximumTopUpCents } = this.config;
        if (!Number.isSafeInteger(amountCents) || amountCents < minimumTopUpCents || amountCents > maximumTopUpCents) {
            throw new OperationError(400, `Top-ups must be whole cents from ${minimumTopUpCents} to ${maximumTopUpCents}`);
        }
        const customer = await this.customer(organization);
        const [topUp] = await this.db.insert(topUpsTable)
            .values({ organizationId: organization.id, amountMicroUsd: amountCents * MICRO_USD_PER_CENT, createdBy })
            .returning();
        const session = await this.stripe.createCheckoutSession({
            customer,
            amountCents,
            organizationId: organization.id,
            topUpId: topUp!.id,
            successUrl: `${this.config.dashboardUrl}/billing?top_up=success`,
            cancelUrl: `${this.config.dashboardUrl}/billing?top_up=cancelled`,
        });
        await this.db.update(topUpsTable).set({ checkoutSessionId: session.id, updatedAt: new Date() }).where(eq(topUpsTable.id, topUp!.id));
        return { topUpId: topUp!.id, url: session.url };
    }

    /** A Stripe Customer Portal URL, for saved cards and receipts. */
    async customerPortal(organization: Organization): Promise<{ url: string }> {
        return this.stripe.createPortalSession({ customer: await this.customer(organization), returnUrl: `${this.config.dashboardUrl}/billing` });
    }

    /** A Connect onboarding URL, creating the organization's Express account the first time. */
    async connectOnboarding(organization: Organization): Promise<{ url: string }> {
        let account = organization.stripeAccountId;
        if (!account) {
            // The idempotency key is the organization, so a concurrent call gets the same account.
            account = (await this.stripe.createExpressAccount({ organizationId: organization.id })).id;
            await this.db.update(organizationsTable).set({ stripeAccountId: account, updatedAt: new Date() })
                .where(and(eq(organizationsTable.id, organization.id), isNull(organizationsTable.stripeAccountId)));
        }
        return this.stripe.createAccountLink({
            account,
            refreshUrl: `${this.config.dashboardUrl}/payouts?onboarding=refresh`,
            returnUrl: `${this.config.dashboardUrl}/payouts?onboarding=return`,
        });
    }

    /** A login link to the organization's Express dashboard. */
    async connectDashboard(organization: Organization): Promise<{ url: string }> {
        if (!organization.stripeAccountId) {
            throw new OperationError(409, 'Organization has not started payout onboarding');
        }
        return this.stripe.createLoginLink(organization.stripeAccountId);
    }

    private async customer(organization: Organization): Promise<string> {
        if (organization.stripeCustomerId) return organization.stripeCustomerId;
        const { id } = await this.stripe.createCustomer({ organizationId: organization.id, name: organization.name });
        await this.db.update(organizationsTable).set({ stripeCustomerId: id, updatedAt: new Date() })
            .where(and(eq(organizationsTable.id, organization.id), isNull(organizationsTable.stripeCustomerId)));
        return id;
    }

    /**
     * Credits a paid Checkout Session's top-up with what Stripe collected. Ignores a session that isn't
     * a top-up or was already credited.
     */
    async creditTopUp(checkoutSessionId: string, paymentIntentId: string, amountPaidCents: number): Promise<void> {
        await this.withTopUp(eq(topUpsTable.checkoutSessionId, checkoutSessionId), async (tx, topUp) => {
            if (topUp.status !== 'pending') return;
            const amount = amountPaidCents * MICRO_USD_PER_CENT;
            await postLedgerTransaction(tx, 'top_up', [
                { account: accounts.stripe, amountMicroUsd: -amount },
                { account: accounts.balance(topUp.organizationId), amountMicroUsd: amount },
            ], { topUpId: topUp.id, stripeObjectId: paymentIntentId });
            await adjustOrganization(tx, topUp.organizationId, { balance: amount });
            await tx.update(topUpsTable).set({ status: 'succeeded', amountMicroUsd: amount, paymentIntentId, updatedAt: new Date() })
                .where(eq(topUpsTable.id, topUp.id));
        });
    }

    /** Debits refunds of a top-up's charge. `amountRefundedCents` is Stripe's cumulative total. */
    async recordRefund(paymentIntentId: string, chargeId: string, amountRefundedCents: number): Promise<void> {
        await this.withTopUp(eq(topUpsTable.paymentIntentId, paymentIntentId), async (tx, topUp) => {
            const refunded = Math.min(amountRefundedCents * MICRO_USD_PER_CENT, topUp.amountMicroUsd);
            const delta = refunded - topUp.refundedMicroUsd;
            if (delta <= 0) return;
            await this.debit(tx, topUp, 'refund', delta, chargeId);
            await tx.update(topUpsTable).set({ refundedMicroUsd: refunded, updatedAt: new Date() }).where(eq(topUpsTable.id, topUp.id));
        });
    }

    /**
     * Debits a disputed top-up when the dispute opens, so its credit can't be spent while it is contested.
     * The balance may go negative, which stops the organization's nodes from paying.
     */
    async recordDisputeOpened(paymentIntentId: string, disputeId: string, amountCents: number): Promise<void> {
        await this.withTopUp(eq(topUpsTable.paymentIntentId, paymentIntentId), async (tx, topUp) => {
            const disputed = Math.min(amountCents * MICRO_USD_PER_CENT, topUp.amountMicroUsd);
            const delta = disputed - topUp.disputedMicroUsd;
            if (delta <= 0) return;
            await this.debit(tx, topUp, 'dispute', delta, disputeId);
            await tx.update(topUpsTable).set({ disputedMicroUsd: disputed, updatedAt: new Date() }).where(eq(topUpsTable.id, topUp.id));
        });
    }

    /** A won dispute returns its debit to the balance. A lost one keeps it. */
    async recordDisputeClosed(paymentIntentId: string, disputeId: string, won: boolean): Promise<void> {
        if (!won) return;
        await this.withTopUp(eq(topUpsTable.paymentIntentId, paymentIntentId), async (tx, topUp) => {
            if (topUp.disputedMicroUsd <= 0) return;
            await postLedgerTransaction(tx, 'dispute_won', [
                { account: accounts.stripe, amountMicroUsd: -topUp.disputedMicroUsd },
                { account: accounts.balance(topUp.organizationId), amountMicroUsd: topUp.disputedMicroUsd },
            ], { topUpId: topUp.id, stripeObjectId: disputeId });
            await adjustOrganization(tx, topUp.organizationId, { balance: topUp.disputedMicroUsd });
            await tx.update(topUpsTable).set({ disputedMicroUsd: 0, updatedAt: new Date() }).where(eq(topUpsTable.id, topUp.id));
        });
    }

    /** Mirrors a Connect account's ability to receive payouts onto its organization. */
    async recordAccountUpdated(accountId: string, payoutsEnabled: boolean): Promise<void> {
        await this.db.update(organizationsTable).set({ payoutsEnabled, updatedAt: new Date() }).where(eq(organizationsTable.stripeAccountId, accountId));
    }

    private async debit(tx: Transaction, topUp: TopUp, kind: 'refund' | 'dispute', amount: number, stripeObjectId: string): Promise<void> {
        await postLedgerTransaction(tx, kind, [
            { account: accounts.balance(topUp.organizationId), amountMicroUsd: -amount },
            { account: accounts.stripe, amountMicroUsd: amount },
        ], { topUpId: topUp.id, stripeObjectId });
        await adjustOrganization(tx, topUp.organizationId, { balance: -amount });
    }

    /** Runs `work` with the matching top-up and its organization locked. Does nothing if no top-up matches. */
    private async withTopUp(match: ReturnType<typeof eq>, work: (tx: Transaction, topUp: TopUp) => Promise<void>): Promise<void> {
        const [found] = await this.db.select().from(topUpsTable).where(match).limit(1);
        if (!found) return;
        await this.db.transaction(async (tx) => {
            await lockOrganizations(tx, [found.organizationId]);
            const [topUp] = await tx.select().from(topUpsTable).where(eq(topUpsTable.id, found.id)).for('update');
            await work(tx, topUp!);
        });
    }
}
