import { inArray, sql } from "drizzle-orm";
import type { Transaction } from "./db/database.js";
import { ledgerEntriesTable, organizationsTable } from "./db/schema.js";

export type Organization = typeof organizationsTable.$inferSelect;

/** Ledger account names. Organization accounts mirror the cached balances on `organizations`. */
export const accounts = {
    balance: (organizationId: string) => `org:${organizationId}:balance`,
    payable: (organizationId: string) => `org:${organizationId}:payable`,
    /** The platform's share of captured payments. */
    revenue: 'platform:revenue',
    /** Credit granted without a payment, such as the local development seed. */
    promotions: 'platform:promotions',
    /** Card money moving through Stripe: top-ups in, refunds and disputes out. */
    stripe: 'platform:stripe',
    /** Money transferred to organizations' Connect accounts. */
    payouts: 'platform:payouts',
} as const;

export type LedgerKind = 'capture' | 'promotion' | 'top_up' | 'refund' | 'dispute' | 'dispute_won' | 'payout' | 'payout_returned';

/** What a ledger transaction records. */
export interface LedgerReference {
    receiptId?: number;
    topUpId?: number;
    payoutId?: number;
    stripeObjectId?: string;
}

export interface LedgerEntry {
    account: string;
    amountMicroUsd: number;
}

/**
 * Appends one balanced ledger transaction. Throws, so the caller's database transaction rolls back,
 * if the entries don't sum to zero.
 */
export async function postLedgerTransaction(tx: Transaction, kind: LedgerKind, entries: LedgerEntry[], reference: LedgerReference = {}): Promise<void> {
    const total = entries.reduce((sum, entry) => sum + BigInt(entry.amountMicroUsd), 0n);
    if (total !== 0n) {
        throw new Error(`Unbalanced ${kind} ledger transaction: entries sum to ${total}`);
    }
    const transactionId = crypto.randomUUID();
    await tx.insert(ledgerEntriesTable).values(entries
        .filter(entry => entry.amountMicroUsd !== 0)
        .map(entry => ({ transactionId, kind, ...reference, ...entry })));
}

/**
 * Locks the organizations' rows for the rest of the transaction and returns them by id. Rows are
 * locked in id order, so two transactions locking the same pair can't deadlock.
 */
export async function lockOrganizations(tx: Transaction, ids: string[]): Promise<Map<string, Organization>> {
    const rows = await tx.select().from(organizationsTable)
        .where(inArray(organizationsTable.id, [...new Set(ids)]))
        .orderBy(organizationsTable.id)
        .for('update');
    return new Map(rows.map(row => [row.id, row]));
}

/** Adds the deltas to an organization's cached balances. Call only with its row locked. */
export async function adjustOrganization(tx: Transaction, id: string, delta: { balance?: number, held?: number, payable?: number }): Promise<void> {
    await tx.update(organizationsTable).set({
        balanceMicroUsd: sql`${organizationsTable.balanceMicroUsd} + ${delta.balance ?? 0}`,
        heldMicroUsd: sql`${organizationsTable.heldMicroUsd} + ${delta.held ?? 0}`,
        payableMicroUsd: sql`${organizationsTable.payableMicroUsd} + ${delta.payable ?? 0}`,
        updatedAt: new Date(),
    }).where(sql`${organizationsTable.id} = ${id}`);
}
