import { and, eq, gt, gte, isNotNull, lt, sql } from "drizzle-orm";
import type { Database } from "../db/database.js";
import { organizationsTable, payoutsTable, receiptsTable } from "../db/schema.js";
import { accounts, adjustOrganization, lockOrganizations, postLedgerTransaction } from "../ledger.js";
import { type StripeGateway, StripeRequestError } from "../stripe/gateway.js";

export type Payout = typeof payoutsTable.$inferSelect;

export const MICRO_USD_PER_CENT = 10_000;

export interface PayoutPolicy {
    /** Captured payments become payable this long after capture, so early disputes surface first. */
    holdMs: number;
    /** An organization is paid at most once per interval. */
    intervalMs: number;
    /** Smaller eligible balances wait for the next run. */
    minimumMicroUsd: number;
}

const DAY_MS = 1000 * 60 * 60 * 24;
export const DEFAULT_PAYOUT_POLICY: PayoutPolicy = { holdMs: 7 * DAY_MS, intervalMs: 7 * DAY_MS, minimumMicroUsd: 10 * 1_000_000 };

/**
 * A pending payout is retried after this long, so a run doesn't race its own in-flight transfer, and
 * until Stripe forgets its idempotency key (24 hours). After that a retry could pay twice, so it is left for review.
 */
export const PENDING_RETRY_AFTER_MS = 1000 * 60;
export const PENDING_RETRY_UNTIL_MS = 1000 * 60 * 60 * 23;

export interface PayoutSummary {
    paid: number;
    failed: number;
    /** Still pending after a transient failure; retried by `reconcilePending`. */
    pending: number;
}

/**
 * Pays organizations' payable balances out to their Connect accounts. A payout is claimed and
 * debited from the payable balance in one transaction, then sent as a Stripe transfer whose
 * idempotency key is the payout's id, so a retry never pays twice.
 */
export class PayoutService {
    constructor(private readonly db: Database, private readonly stripe: StripeGateway, private readonly policy: PayoutPolicy = DEFAULT_PAYOUT_POLICY) {}

    /** Claims and sends a payout for every organization that is due one. */
    async runPayouts(now: Date = new Date()): Promise<PayoutSummary> {
        const candidates = await this.db.select({ id: organizationsTable.id }).from(organizationsTable).where(and(
            eq(organizationsTable.payoutsEnabled, true),
            isNotNull(organizationsTable.stripeAccountId),
            gte(organizationsTable.payableMicroUsd, this.policy.minimumMicroUsd),
        ));
        const summary: PayoutSummary = { paid: 0, failed: 0, pending: 0 };
        for (const { id } of candidates) {
            const claimed = await this.claim(id, now);
            if (claimed) summary[await this.send(claimed.payout, claimed.destination)]++;
        }
        return summary;
    }

    /** Retries payouts left pending by a transient failure. Returns the ones too old to retry safely, for review. */
    async reconcilePending(now: Date = new Date()): Promise<PayoutSummary & { stale: Payout[] }> {
        const pending = await this.db.select({ payout: payoutsTable, destination: organizationsTable.stripeAccountId })
            .from(payoutsTable)
            .innerJoin(organizationsTable, eq(organizationsTable.id, payoutsTable.organizationId))
            .where(and(eq(payoutsTable.status, 'pending'), lt(payoutsTable.createdAt, new Date(now.getTime() - PENDING_RETRY_AFTER_MS))));
        const summary = { paid: 0, failed: 0, pending: 0, stale: [] as Payout[] };
        for (const { payout, destination } of pending) {
            if (payout.createdAt.getTime() < now.getTime() - PENDING_RETRY_UNTIL_MS) {
                summary.stale.push(payout);
                continue;
            }
            summary[await this.send(payout, destination!)]++;
        }
        return summary;
    }

    /**
     * Records a reversal of a payout's transfer, crediting the newly reversed amount back to the
     * organization's payable balance. `amountReversedCents` is Stripe's cumulative total. Ignores unknown transfers.
     */
    async handleTransferReversed(transferId: string, amountReversedCents: number): Promise<void> {
        const [found] = await this.db.select().from(payoutsTable).where(eq(payoutsTable.stripeTransferId, transferId)).limit(1);
        if (!found) return;
        await this.db.transaction(async (tx) => {
            await lockOrganizations(tx, [found.organizationId]);
            const [payout] = await tx.select().from(payoutsTable).where(eq(payoutsTable.id, found.id)).for('update');
            const newlyReversedCents = Math.min(amountReversedCents, payout!.amountCents) - payout!.reversedCents;
            if (newlyReversedCents <= 0) return;
            const amount = newlyReversedCents * MICRO_USD_PER_CENT;
            await postLedgerTransaction(tx, 'payout_returned', [
                { account: accounts.payouts, amountMicroUsd: -amount },
                { account: accounts.payable(payout!.organizationId), amountMicroUsd: amount },
            ], { payoutId: payout!.id, stripeObjectId: transferId });
            await adjustOrganization(tx, payout!.organizationId, { payable: amount });
            const reversedCents = payout!.reversedCents + newlyReversedCents;
            await tx.update(payoutsTable).set({
                reversedCents,
                status: reversedCents >= payout!.amountCents ? 'reversed' : payout!.status,
                updatedAt: new Date(),
            }).where(eq(payoutsTable.id, payout!.id));
        });
    }

    /**
     * Claims a pending payout of the organization's eligible payable balance, rounded down to whole cents,
     * if it is due one. Eligible means captured at least `holdMs` ago: the payable balance less what was
     * captured more recently.
     */
    private async claim(organizationId: string, now: Date): Promise<{ payout: Payout, destination: string } | undefined> {
        return this.db.transaction(async (tx) => {
            const organization = (await lockOrganizations(tx, [organizationId])).get(organizationId);
            if (!organization?.payoutsEnabled || !organization.stripeAccountId) return undefined;

            // A failed payout counts too, so a refused transfer isn't retried on every run; its amount waits for the next interval.
            const [recentPayout] = await tx.select({ id: payoutsTable.id }).from(payoutsTable).where(and(
                eq(payoutsTable.organizationId, organizationId),
                gt(payoutsTable.createdAt, new Date(now.getTime() - this.policy.intervalMs)),
            )).limit(1);
            if (recentPayout) return undefined;

            const [recent] = await tx.select({ total: sql<string>`coalesce(sum(${receiptsTable.amountMicroUsd} - ${receiptsTable.feeMicroUsd}), 0)` })
                .from(receiptsTable).where(and(
                    eq(receiptsTable.recipientOrganizationId, organizationId),
                    eq(receiptsTable.status, 'captured'),
                    gt(receiptsTable.capturedAt, new Date(now.getTime() - this.policy.holdMs)),
                ));
            const eligible = organization.payableMicroUsd - Number(recent!.total);
            const amountCents = Math.floor(eligible / MICRO_USD_PER_CENT);
            const amount = amountCents * MICRO_USD_PER_CENT;
            if (amount <= 0 || amount < this.policy.minimumMicroUsd) return undefined;

            const [payout] = await tx.insert(payoutsTable).values({ organizationId, amountCents }).returning();
            await postLedgerTransaction(tx, 'payout', [
                { account: accounts.payable(organizationId), amountMicroUsd: -amount },
                { account: accounts.payouts, amountMicroUsd: amount },
            ], { payoutId: payout!.id });
            await adjustOrganization(tx, organizationId, { payable: -amount });
            return { payout: payout!, destination: organization.stripeAccountId };
        });
    }

    /** Sends a claimed payout's transfer. A definitive refusal fails it and returns its amount to the payable balance. */
    private async send(payout: Payout, destination: string): Promise<'paid' | 'failed' | 'pending'> {
        try {
            const transfer = await this.stripe.createTransfer({ destination, amountCents: payout.amountCents, payoutId: payout.id, idempotencyKey: `payout_${payout.id}` });
            await this.db.update(payoutsTable).set({ status: 'paid', stripeTransferId: transfer.id, updatedAt: new Date() })
                .where(and(eq(payoutsTable.id, payout.id), eq(payoutsTable.status, 'pending')));
            return 'paid';
        } catch (error) {
            if (!(error instanceof StripeRequestError) || !error.definitive) {
                console.error(`Payout ${payout.id} transfer failed transiently; it stays pending`, error);
                return 'pending';
            }
            await this.fail(payout, error.message);
            return 'failed';
        }
    }

    private async fail(payout: Payout, reason: string): Promise<void> {
        await this.db.transaction(async (tx) => {
            await lockOrganizations(tx, [payout.organizationId]);
            const [current] = await tx.select().from(payoutsTable).where(eq(payoutsTable.id, payout.id)).for('update');
            if (current?.status !== 'pending') return;
            const amount = payout.amountCents * MICRO_USD_PER_CENT;
            await postLedgerTransaction(tx, 'payout_returned', [
                { account: accounts.payouts, amountMicroUsd: -amount },
                { account: accounts.payable(payout.organizationId), amountMicroUsd: amount },
            ], { payoutId: payout.id });
            await adjustOrganization(tx, payout.organizationId, { payable: amount });
            await tx.update(payoutsTable).set({ status: 'failed', failureReason: reason.slice(0, 1024), updatedAt: new Date() })
                .where(eq(payoutsTable.id, payout.id));
        });
    }
}
