import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import type { Database } from './db/database.js';
import { organizationsTable, topUpsTable } from './db/schema.js';
import type { Organization } from './ledger.js';
import { OrganizationService } from './organizations.js';
import { createTestDatabase } from './testing.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const USD = 1_000_000;
const NOW = new Date('2026-11-11T12:00:00Z');

describe('OrganizationService.idleBalance', () => {
    let db: Database;
    let close: () => Promise<void>;
    let organizations: OrganizationService;
    let organization: Organization;

    beforeEach(async () => {
        ({ db, close } = await createTestDatabase());
        organizations = new OrganizationService(db, async () => undefined, { ageMs: 30 * DAY_MS, warningMicroUsd: 100 * USD });
        organization = (await organizations.create('Acme'))!;
    });

    afterEach(() => close());

    async function topUp(amountUsd: number, daysAgo: number, options: { refundedUsd?: number, disputedUsd?: number, status?: 'pending' | 'succeeded' } = {}) {
        await db.insert(topUpsTable).values({
            organizationId: organization.id,
            amountMicroUsd: amountUsd * USD,
            refundedMicroUsd: (options.refundedUsd ?? 0) * USD,
            disputedMicroUsd: (options.disputedUsd ?? 0) * USD,
            status: options.status ?? 'succeeded',
            createdAt: new Date(NOW.getTime() - daysAgo * DAY_MS),
        });
    }

    async function idle(balanceUsd: number, heldUsd = 0) {
        const [updated] = await db.update(organizationsTable)
            .set({ balanceMicroUsd: balanceUsd * USD, heldMicroUsd: heldUsd * USD })
            .where(eq(organizationsTable.id, organization.id))
            .returning();
        return organizations.idleBalance(updated!, NOW);
    }

    test('reports top-ups older than the policy\'s age that are still unspent', async () => {
        await topUp(800, 45);

        expect(await idle(800)).toEqual({ amountMicroUsd: 800 * USD, days: 30 });
        expect(await idle(250)).toEqual({ amountMicroUsd: 250 * USD, days: 30 });
    });

    test('reports nothing below the warning amount', async () => {
        await topUp(800, 45);

        expect(await idle(99)).toBeNull();
        expect(await idle(0)).toBeNull();
        expect(await idle(-20)).toBeNull();
    });

    test('counts recent top-ups as spent last', async () => {
        await topUp(600, 45);
        await topUp(1_000, 5);

        // $550 was spent: it came out of the old top-up first, leaving $50 of it, under the warning amount.
        expect(await idle(1_050)).toBeNull();
        expect(await idle(1_250)).toEqual({ amountMicroUsd: 250 * USD, days: 30 });
        expect(await idle(1_600)).toEqual({ amountMicroUsd: 600 * USD, days: 30 });
    });

    test('leaves out amounts held for calls in progress', async () => {
        await topUp(800, 45);

        expect(await idle(800, 750)).toBeNull();
        expect(await idle(800, 300)).toEqual({ amountMicroUsd: 500 * USD, days: 30 });
    });

    test('leaves out refunded and disputed amounts, and pending top-ups', async () => {
        await topUp(800, 45, { refundedUsd: 300, disputedUsd: 200 });
        await topUp(5_000, 60, { status: 'pending' });

        expect(await idle(5_000)).toEqual({ amountMicroUsd: 300 * USD, days: 30 });
    });

    test('ignores promotional credit', async () => {
        await organizations.grantPromotion(organization.id, 1_000 * USD);

        expect(await organizations.idleBalance((await organizations.get(organization.id))!, NOW)).toBeNull();
    });
});
