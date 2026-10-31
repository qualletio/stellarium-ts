import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import type { Database } from '../db/database.js';
import { composerChargesTable, ledgerEntriesTable, organizationsTable } from '../db/schema.js';
import type { OperationError } from '../errors.js';
import { HOLD_GRACE_MS } from '../payments/paymentService.js';
import { createTestDatabase, ledgerProblems, PAYER_ORGANIZATION, seedOrganizations } from '../testing.js';
import { COMPOSER_TURN_LIFETIME_MS, ComposerService, composerCharge, type ComposerUsage } from './composerService.js';

const POLICY = {
    rates: { inputMicroUsdPerMillionTokens: 4_000_000, cacheReadMicroUsdPerMillionTokens: 400_000, outputMicroUsdPerMillionTokens: 20_000_000 },
    turnHoldMicroUsd: 100_000,
};
const USER = 'user_1';
/** 1,000 input × $4/M + 500 cache writes × $4/M + 10,000 cache reads × $0.40/M + 2,000 output × $20/M = 50,000 micro-USD. */
const USAGE: ComposerUsage = { inputTokens: 1_000, cacheWriteTokens: 500, cacheReadTokens: 10_000, outputTokens: 2_000 };
const MESSAGES = [
    { role: 'user' as const, content: [{ type: 'text', text: 'Hi' }] },
    { role: 'assistant' as const, content: [{ type: 'text', text: 'Hello' }] },
];

describe('ComposerService', () => {
    let db: Database;
    let close: () => Promise<void>;
    let service: ComposerService;

    beforeEach(async () => {
        ({ db, close } = await createTestDatabase());
        await seedOrganizations(db, 1_000_000);
        service = new ComposerService(db, POLICY);
    });

    afterEach(async () => {
        await close();
    });

    const rejection = (promise: Promise<unknown>) => promise.then(
        () => { throw new Error('expected a rejection'); },
        (error: OperationError) => ({ status: error.statusCode, message: error.message }),
    );

    async function payer() {
        const [organization] = await db.select().from(organizationsTable).where(eq(organizationsTable.id, PAYER_ORGANIZATION));
        return organization!;
    }

    test('charges by token class, rounding up', () => {
        expect(composerCharge(USAGE, POLICY.rates)).toBe(50_000);
        expect(composerCharge({ inputTokens: 1, cacheWriteTokens: 0, cacheReadTokens: 0, outputTokens: 0 }, POLICY.rates)).toBe(4);
        expect(composerCharge({ inputTokens: 0, cacheWriteTokens: 0, cacheReadTokens: 1, outputTokens: 0 }, POLICY.rates)).toBe(1);
    });

    test('holds a turn, creating the conversation, then charges its usage and saves its messages', async () => {
        const turn = await service.hold(PAYER_ORGANIZATION, USER, { title: 'Weather' });
        expect(turn.holdMicroUsd).toBe(100_000);
        expect((await payer()).heldMicroUsd).toBe(100_000);

        expect(await service.complete(PAYER_ORGANIZATION, USER, turn.chargeId, { messages: MESSAGES, usage: USAGE })).toEqual({ amountMicroUsd: 50_000 });
        expect(await payer()).toMatchObject({ balanceMicroUsd: 950_000, heldMicroUsd: 0 });
        expect(await service.getConversation(PAYER_ORGANIZATION, USER, turn.conversationId)).toMatchObject({
            conversation: { title: 'Weather', userId: USER },
            messages: MESSAGES,
        });
        expect(await ledgerProblems(db)).toEqual([]);
        const entries = await db.select().from(ledgerEntriesTable).where(eq(ledgerEntriesTable.kind, 'composer_capture'));
        expect(entries.map(entry => [entry.account, entry.amountMicroUsd])).toEqual(expect.arrayContaining([
            [`org:${PAYER_ORGANIZATION}:balance`, -50_000],
            ['platform:revenue', 50_000],
        ]));
    });

    test('a completed turn completes again without charging or saving twice', async () => {
        const turn = await service.hold(PAYER_ORGANIZATION, USER, { title: 'Weather' });
        await service.complete(PAYER_ORGANIZATION, USER, turn.chargeId, { messages: MESSAGES, usage: USAGE });
        expect(await service.complete(PAYER_ORGANIZATION, USER, turn.chargeId, { messages: MESSAGES, usage: USAGE })).toEqual({ amountMicroUsd: 50_000 });

        expect((await payer()).balanceMicroUsd).toBe(950_000);
        expect((await service.getConversation(PAYER_ORGANIZATION, USER, turn.conversationId)).messages).toHaveLength(2);
    });

    test('charges at most the hold', async () => {
        const turn = await service.hold(PAYER_ORGANIZATION, USER, { title: 'Long' });
        const usage = { ...USAGE, outputTokens: 1_000_000 };
        expect(await service.complete(PAYER_ORGANIZATION, USER, turn.chargeId, { messages: MESSAGES, usage })).toEqual({ amountMicroUsd: 100_000 });
        expect(await ledgerProblems(db)).toEqual([]);
    });

    test('continues a conversation the user owns, and no one else\'s', async () => {
        const first = await service.hold(PAYER_ORGANIZATION, USER, { title: 'Weather' });
        const second = await service.hold(PAYER_ORGANIZATION, USER, { conversationId: first.conversationId, title: 'ignored' });
        expect(second.conversationId).toBe(first.conversationId);

        expect(await rejection(service.hold(PAYER_ORGANIZATION, 'user_2', { conversationId: first.conversationId, title: 'x' }))).toMatchObject({ status: 404 });
        expect(await rejection(service.complete(PAYER_ORGANIZATION, 'user_2', first.chargeId, { messages: [], usage: USAGE }))).toMatchObject({ status: 404 });
        expect(await service.listConversations(PAYER_ORGANIZATION, 'user_2')).toEqual([]);
        expect(await service.listConversations(PAYER_ORGANIZATION, USER)).toHaveLength(1);
    });

    test('refuses a turn the available balance can\'t hold, or a frozen organization', async () => {
        await db.update(organizationsTable).set({ heldMicroUsd: 950_000 }).where(eq(organizationsTable.id, PAYER_ORGANIZATION));
        expect(await rejection(service.hold(PAYER_ORGANIZATION, USER, { title: 'x' }))).toMatchObject({ status: 402 });

        await db.update(organizationsTable).set({ heldMicroUsd: 0, frozenAt: new Date() }).where(eq(organizationsTable.id, PAYER_ORGANIZATION));
        expect(await rejection(service.hold(PAYER_ORGANIZATION, USER, { title: 'x' }))).toMatchObject({ status: 403 });
        expect(await service.listConversations(PAYER_ORGANIZATION, USER)).toEqual([]);
    });

    test('releases a turn without charging it, and refuses to complete it afterwards', async () => {
        const turn = await service.hold(PAYER_ORGANIZATION, USER, { title: 'x' });
        await service.release(PAYER_ORGANIZATION, USER, turn.chargeId);
        await service.release(PAYER_ORGANIZATION, USER, turn.chargeId);

        expect(await payer()).toMatchObject({ balanceMicroUsd: 1_000_000, heldMicroUsd: 0 });
        expect(await rejection(service.complete(PAYER_ORGANIZATION, USER, turn.chargeId, { messages: [], usage: USAGE }))).toMatchObject({ status: 409 });
    });

    test('maintenance releases turns past their expiry and grace', async () => {
        const turn = await service.hold(PAYER_ORGANIZATION, USER, { title: 'x' });
        expect(await service.releaseExpired(new Date(Date.now() + COMPOSER_TURN_LIFETIME_MS))).toBe(0);
        expect(await service.releaseExpired(new Date(Date.now() + COMPOSER_TURN_LIFETIME_MS + HOLD_GRACE_MS + 1_000))).toBe(1);

        expect((await payer()).heldMicroUsd).toBe(0);
        const [charge] = await db.select().from(composerChargesTable).where(eq(composerChargesTable.id, turn.chargeId));
        expect(charge!.status).toBe('released');
    });

    test('deleting a conversation keeps its charges', async () => {
        const turn = await service.hold(PAYER_ORGANIZATION, USER, { title: 'x' });
        await service.complete(PAYER_ORGANIZATION, USER, turn.chargeId, { messages: MESSAGES, usage: USAGE });
        await service.deleteConversation(PAYER_ORGANIZATION, USER, turn.conversationId);

        expect(await rejection(service.getConversation(PAYER_ORGANIZATION, USER, turn.conversationId))).toMatchObject({ status: 404 });
        const [charge] = await db.select().from(composerChargesTable).where(eq(composerChargesTable.id, turn.chargeId));
        expect(charge).toMatchObject({ status: 'captured', conversationId: null, amountMicroUsd: 50_000 });
        expect(await ledgerProblems(db)).toEqual([]);
    });
});
