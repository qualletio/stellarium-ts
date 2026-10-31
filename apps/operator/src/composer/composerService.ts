import { and, asc, desc, eq, lt } from "drizzle-orm";
import type { Database, Transaction } from "../db/database.js";
import { composerChargesTable, composerConversationsTable, composerMessagesTable } from "../db/schema.js";
import { OperationError } from "../errors.js";
import { accounts, adjustOrganization, lockOrganizations, postLedgerTransaction } from "../ledger.js";
import { HOLD_GRACE_MS, TOP_UP_URL } from "../payments/paymentService.js";

export type ComposerConversation = typeof composerConversationsTable.$inferSelect;
export type ComposerCharge = typeof composerChargesTable.$inferSelect;

/** What the platform charges per million Claude tokens. Cache writes are charged as input. */
export interface ComposerRates {
    inputMicroUsdPerMillionTokens: number;
    cacheReadMicroUsdPerMillionTokens: number;
    outputMicroUsdPerMillionTokens: number;
}

export interface ComposerPolicy {
    rates: ComposerRates;
    /** Held on the organization's balance for each turn, and the most a turn can cost. */
    turnHoldMicroUsd: number;
}

/** Claude Opus 5.5's list prices, and a $0.50 hold per turn. */
export const DEFAULT_COMPOSER_POLICY: ComposerPolicy = {
    rates: {
        inputMicroUsdPerMillionTokens: 4_000_000,
        cacheReadMicroUsdPerMillionTokens: 400_000,
        outputMicroUsdPerMillionTokens: 20_000_000,
    },
    turnHoldMicroUsd: 500_000,
};

/** How long a turn's hold lasts before maintenance releases it. */
export const COMPOSER_TURN_LIFETIME_MS = 1000 * 60 * 15;

/** The tokens a turn used, summed over its Messages API calls. */
export interface ComposerUsage {
    inputTokens: number;
    cacheWriteTokens: number;
    cacheReadTokens: number;
    outputTokens: number;
}

/** A message as the Claude Messages API takes it: a role and its content blocks. */
export interface ComposerMessage {
    role: 'user' | 'assistant';
    content: unknown[];
}

/** Micro-USD for `usage` at `rates`, rounded up. */
export function composerCharge(usage: ComposerUsage, rates: ComposerRates): number {
    const micros = BigInt(usage.inputTokens + usage.cacheWriteTokens) * BigInt(rates.inputMicroUsdPerMillionTokens)
        + BigInt(usage.cacheReadTokens) * BigInt(rates.cacheReadMicroUsdPerMillionTokens)
        + BigInt(usage.outputTokens) * BigInt(rates.outputMicroUsdPerMillionTokens);
    return Number((micros + 999_999n) / 1_000_000n);
}

/**
 * The dashboard's Composer: conversations a user has with Claude about RequestScript, and the charge for
 * each turn. The dashboard holds a turn before calling Claude, then completes it with the messages it
 * produced and the tokens it used, which are charged to the organization's balance and credited to the
 * platform. Each step is idempotent per charge.
 */
export class ComposerService {
    constructor(private readonly db: Database, readonly policy: ComposerPolicy = DEFAULT_COMPOSER_POLICY) {}

    /** The user's conversations in the organization, most recently updated first. */
    async listConversations(organizationId: string, userId: string, limit = 50): Promise<ComposerConversation[]> {
        return this.db.select().from(composerConversationsTable)
            .where(and(eq(composerConversationsTable.organizationId, organizationId), eq(composerConversationsTable.userId, userId)))
            .orderBy(desc(composerConversationsTable.updatedAt))
            .limit(limit);
    }

    async getConversation(organizationId: string, userId: string, id: string): Promise<{ conversation: ComposerConversation, messages: ComposerMessage[] }> {
        const conversation = await this.findConversation(this.db, organizationId, userId, id);
        const messages = await this.db.select({ role: composerMessagesTable.role, content: composerMessagesTable.content })
            .from(composerMessagesTable)
            .where(eq(composerMessagesTable.conversationId, id))
            .orderBy(asc(composerMessagesTable.id));
        return { conversation, messages: messages as ComposerMessage[] };
    }

    async deleteConversation(organizationId: string, userId: string, id: string): Promise<void> {
        const deleted = await this.db.delete(composerConversationsTable)
            .where(and(
                eq(composerConversationsTable.id, id),
                eq(composerConversationsTable.organizationId, organizationId),
                eq(composerConversationsTable.userId, userId),
            ))
            .returning({ id: composerConversationsTable.id });
        if (deleted.length === 0) throw new OperationError(404, 'Conversation not found');
    }

    /**
     * Holds `turnHoldMicroUsd` for one turn of a conversation, creating the conversation, titled `title`,
     * when `conversationId` is omitted. Refuses a frozen organization (403) and too low a balance (402).
     */
    async hold(organizationId: string, userId: string, request: { conversationId?: string, title: string }): Promise<{ chargeId: string, conversationId: string, holdMicroUsd: number }> {
        const hold = this.policy.turnHoldMicroUsd;
        return this.db.transaction(async (tx) => {
            const organization = (await lockOrganizations(tx, [organizationId])).get(organizationId)!;
            if (organization.frozenAt) {
                throw new OperationError(403, 'Organization is frozen');
            }
            if (organization.balanceMicroUsd - organization.heldMicroUsd < hold) {
                throw new OperationError(402, `Insufficient balance: a Composer turn holds up to ${hold} micro-USD. Top up at ${TOP_UP_URL}`);
            }
            let conversationId = request.conversationId;
            if (conversationId === undefined) {
                const [created] = await tx.insert(composerConversationsTable)
                    .values({ organizationId, userId, title: request.title.slice(0, 255) })
                    .returning({ id: composerConversationsTable.id });
                conversationId = created!.id;
            } else {
                await this.findConversation(tx, organizationId, userId, conversationId);
            }
            const [charge] = await tx.insert(composerChargesTable).values({
                organizationId,
                userId,
                conversationId,
                holdMicroUsd: hold,
                expiresAt: new Date(Date.now() + COMPOSER_TURN_LIFETIME_MS),
            }).returning({ id: composerChargesTable.id });
            await adjustOrganization(tx, organizationId, { held: hold });
            return { chargeId: charge!.id, conversationId, holdMicroUsd: hold };
        });
    }

    /**
     * Charges the turn's usage, at most its hold, releases the rest, and appends its messages to the
     * conversation. Completing it again returns the same amount and appends nothing.
     */
    async complete(organizationId: string, userId: string, chargeId: string, request: { messages: ComposerMessage[], usage: ComposerUsage }): Promise<{ amountMicroUsd: number }> {
        return this.db.transaction(async (tx) => {
            const charge = await this.lockCharge(tx, organizationId, userId, chargeId);
            if (charge.status === 'captured') {
                return { amountMicroUsd: charge.amountMicroUsd! };
            }
            if (charge.status === 'released') {
                throw new OperationError(409, 'The turn\'s hold was already released');
            }
            const { usage } = request;
            const amount = Math.min(composerCharge(usage, this.policy.rates), charge.holdMicroUsd);
            if (amount > 0) {
                await postLedgerTransaction(tx, 'composer_capture', [
                    { account: accounts.balance(organizationId), amountMicroUsd: -amount },
                    { account: accounts.revenue, amountMicroUsd: amount },
                ], { composerChargeId: charge.id });
            }
            await adjustOrganization(tx, organizationId, { balance: -amount, held: -charge.holdMicroUsd });
            await tx.update(composerChargesTable).set({
                status: 'captured',
                inputTokens: usage.inputTokens,
                cacheWriteTokens: usage.cacheWriteTokens,
                cacheReadTokens: usage.cacheReadTokens,
                outputTokens: usage.outputTokens,
                amountMicroUsd: amount,
                capturedAt: new Date(),
            }).where(eq(composerChargesTable.id, charge.id));
            if (charge.conversationId !== null && request.messages.length > 0) {
                await tx.insert(composerMessagesTable).values(request.messages.map(message => ({
                    conversationId: charge.conversationId!,
                    role: message.role,
                    content: message.content,
                })));
                await tx.update(composerConversationsTable).set({ updatedAt: new Date() }).where(eq(composerConversationsTable.id, charge.conversationId));
            }
            return { amountMicroUsd: amount };
        });
    }

    /** Releases a turn's hold without charging it, for a turn that never reached Claude. */
    async release(organizationId: string, userId: string, chargeId: string): Promise<void> {
        await this.db.transaction(async (tx) => {
            const charge = await this.lockCharge(tx, organizationId, userId, chargeId);
            if (charge.status === 'captured') {
                throw new OperationError(409, 'The turn was already charged');
            }
            if (charge.status === 'held') {
                await this.releaseHeld(tx, charge);
            }
        });
    }

    /** Releases turns that expired more than `HOLD_GRACE_MS` before `now`. Returns how many. */
    async releaseExpired(now: Date = new Date()): Promise<number> {
        const expired = await this.db.select().from(composerChargesTable).where(and(
            eq(composerChargesTable.status, 'held'),
            lt(composerChargesTable.expiresAt, new Date(now.getTime() - HOLD_GRACE_MS)),
        ));
        let released = 0;
        for (const candidate of expired) {
            await this.db.transaction(async (tx) => {
                await lockOrganizations(tx, [candidate.organizationId]);
                const [charge] = await tx.select().from(composerChargesTable).where(eq(composerChargesTable.id, candidate.id)).for('update');
                // Settled since the scan.
                if (charge?.status !== 'held') return;
                await this.releaseHeld(tx, charge);
                released++;
            });
        }
        return released;
    }

    private async findConversation(db: Database | Transaction, organizationId: string, userId: string, id: string): Promise<ComposerConversation> {
        const [conversation] = await db.select().from(composerConversationsTable).where(and(
            eq(composerConversationsTable.id, id),
            eq(composerConversationsTable.organizationId, organizationId),
            eq(composerConversationsTable.userId, userId),
        )).limit(1);
        if (!conversation) throw new OperationError(404, 'Conversation not found');
        return conversation;
    }

    /** The charge, with its organization and then its own row locked, the order `hold` locks in. */
    private async lockCharge(tx: Transaction, organizationId: string, userId: string, chargeId: string): Promise<ComposerCharge> {
        await lockOrganizations(tx, [organizationId]);
        const [charge] = await tx.select().from(composerChargesTable).where(and(
            eq(composerChargesTable.id, chargeId),
            eq(composerChargesTable.organizationId, organizationId),
            eq(composerChargesTable.userId, userId),
        )).for('update');
        if (!charge) throw new OperationError(404, 'Turn not found');
        return charge;
    }

    /** Call with the charge's organization and row locked. */
    private async releaseHeld(tx: Transaction, charge: ComposerCharge): Promise<void> {
        await adjustOrganization(tx, charge.organizationId, { held: -charge.holdMicroUsd });
        await tx.update(composerChargesTable).set({ status: 'released', releasedAt: new Date() }).where(eq(composerChargesTable.id, charge.id));
    }
}
