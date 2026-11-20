import { eq } from "drizzle-orm";
import type { BillingService } from "../billing/billingService.js";
import type { Database } from "../db/database.js";
import { organizationsTable, stripeEventsTable, topUpsTable } from "../db/schema.js";
import type { PayoutService } from "../payouts/payoutService.js";
import type { StripeEvent } from "./gateway.js";

type StripeObject = Record<string, unknown>;

/** An expandable Stripe field: the id, or the expanded object's id. */
function id(value: unknown): string | undefined {
    if (typeof value === 'string') return value;
    const expanded = (value as { id?: unknown } | null | undefined)?.id;
    return typeof expanded === 'string' ? expanded : undefined;
}

function cents(value: unknown): number {
    return Number.isSafeInteger(value) ? value as number : 0;
}

/**
 * Applies Stripe webhook events. Each event is handled at most once (by id), and every handler is
 * idempotent too, so two deliveries racing past the check change nothing twice.
 */
export class StripeWebhookService {
    constructor(
        private readonly db: Database,
        private readonly billing: BillingService,
        private readonly payouts: PayoutService,
        /** Recovers what a refund or dispute leaves an organization owing from its contract funding. */
        private readonly recoverFromFunding?: (organizationId: string, amount: number) => Promise<number>,
    ) {}

    /** A refund or dispute that left the organization owing is recovered from its unspent contract funding first. */
    private async recover(paymentIntentId: string): Promise<void> {
        if (!this.recoverFromFunding) return;
        const [topUp] = await this.db.select().from(topUpsTable).where(eq(topUpsTable.paymentIntentId, paymentIntentId)).limit(1);
        if (!topUp) return;
        const [organization] = await this.db.select().from(organizationsTable).where(eq(organizationsTable.id, topUp.organizationId)).limit(1);
        if (organization && organization.balanceMicroUsd < 0) {
            await this.recoverFromFunding(organization.id, -organization.balanceMicroUsd);
        }
    }

    async handle(event: StripeEvent): Promise<void> {
        const [seen] = await this.db.select({ id: stripeEventsTable.id }).from(stripeEventsTable).where(eq(stripeEventsTable.id, event.id)).limit(1);
        if (seen) return;
        await this.apply(event);
        // Recorded after it is applied, so a failure leaves Stripe to redeliver it.
        await this.db.insert(stripeEventsTable).values({ id: event.id, type: event.type }).onConflictDoNothing();
    }

    private async apply(event: StripeEvent): Promise<void> {
        const object: StripeObject = event.data.object;
        switch (event.type) {
            case 'checkout.session.completed':
            case 'checkout.session.async_payment_succeeded': {
                // A delayed payment method completes the session unpaid, and succeeds later.
                const paymentIntent = id(object.payment_intent);
                if (object.payment_status !== 'paid' || object.currency !== 'usd' || !paymentIntent) return;
                await this.billing.creditTopUp(id(object.id)!, paymentIntent, cents(object.amount_total));
                return;
            }
            case 'charge.refunded': {
                const paymentIntent = id(object.payment_intent);
                if (paymentIntent) {
                    await this.billing.recordRefund(paymentIntent, id(object.id)!, cents(object.amount_refunded));
                    await this.recover(paymentIntent);
                }
                return;
            }
            case 'charge.dispute.created': {
                const paymentIntent = id(object.payment_intent);
                if (paymentIntent) {
                    await this.billing.recordDisputeOpened(paymentIntent, id(object.id)!, cents(object.amount));
                    await this.recover(paymentIntent);
                }
                return;
            }
            case 'charge.dispute.closed': {
                const paymentIntent = id(object.payment_intent);
                if (paymentIntent) await this.billing.recordDisputeClosed(paymentIntent, id(object.id)!, object.status === 'won');
                return;
            }
            case 'transfer.reversed':
                await this.payouts.handleTransferReversed(id(object.id)!, cents(object.amount_reversed));
                return;
            case 'account.updated': {
                const transfers = (object.capabilities as StripeObject | undefined)?.transfers;
                await this.billing.recordAccountUpdated(id(object.id)!, object.payouts_enabled === true && transfers === 'active');
                return;
            }
        }
    }
}
