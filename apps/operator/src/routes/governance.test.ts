import { createPublicKey, verify } from 'node:crypto';
import { eq } from 'drizzle-orm';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import type { DashboardAuthenticator, DashboardSession } from '../auth/dashboardAuth.js';
import type { Database } from '../db/database.js';
import { authOrganizationsTable, organizationsTable } from '../db/schema.js';
import { createService, type Service } from '../service.js';
import { createTestDatabase, generateNodeKeys, PROVIDER_ORGANIZATION, seedOrganizations } from '../testing.js';
import routes from './index.js';

/** Accepts a `session=<userId>:<organizationId>:<role>` cookie. */
class FakeAuthenticator implements DashboardAuthenticator {
    async verify(headers: Headers): Promise<DashboardSession | undefined> {
        const [userId, organizationId, role] = headers.get('cookie')?.match(/session=([^;]*)/)?.[1]?.split(':') ?? [];
        if (!userId) return undefined;
        return { userId, activeOrganization: organizationId ? { id: organizationId, name: `Org ${organizationId}`, role: role ?? 'member' } : undefined };
    }
}

describe('governance routes', () => {
    let db: Database;
    let close: () => Promise<void>;
    let fastify: FastifyInstance;
    let service: Service;

    beforeEach(async () => {
        ({ db, close } = await createTestDatabase());
        await seedOrganizations(db, 0);
        await db.insert(authOrganizationsTable).values({ id: 'acme', name: 'Org acme', slug: 'acme', createdAt: new Date() });
        service = createService(db, {
            platformFeeBps: 100,
            runTokenPrivateKey: generateNodeKeys().privateKey,
            staffApiKeys: 'alice:key-alice,bob:key-bob',
            dashboardAuthenticator: new FakeAuthenticator(),
        });
        fastify = Fastify();
        await fastify.register(routes, { prefix: '/v1', service });
        await fastify.ready();
    });

    afterEach(async () => {
        await fastify.close();
        await close();
    });

    const staff = (key: string) => ({ authorization: `Bearer ${key}` });

    test('the staff API needs a staff key', async () => {
        expect((await fastify.inject({ method: 'GET', url: '/v1/staff/reviews' })).statusCode).toBe(401);
        expect((await fastify.inject({ method: 'GET', url: '/v1/staff/reviews', headers: staff('wrong') })).statusCode).toBe(401);
        expect((await fastify.inject({ method: 'GET', url: '/v1/staff/reviews', headers: staff('key-alice') })).json()).toEqual({ reviews: [] });
    });

    test('a ban takes two different staff members, and every step is audited', async () => {
        const proposed = (await fastify.inject({
            method: 'POST', url: '/v1/staff/actions', headers: staff('key-alice'),
            payload: { kind: 'ban', payload: { organizationId: PROVIDER_ORGANIZATION }, reason: 'Proven fraud' },
        })).json().action;
        expect(proposed).toMatchObject({ status: 'proposed', approvedBy: 'alice' });
        expect((await fastify.inject({ method: 'POST', url: `/v1/staff/actions/${proposed.id}/approve`, headers: staff('key-alice') })).statusCode).toBe(409);
        const approved = (await fastify.inject({ method: 'POST', url: `/v1/staff/actions/${proposed.id}/approve`, headers: staff('key-bob') })).json().action;
        expect(approved).toMatchObject({ status: 'executed', approvedBy: 'alice,bob' });
        const [provider] = await db.select().from(organizationsTable).where(eq(organizationsTable.id, PROVIDER_ORGANIZATION));
        expect(provider!.bannedAt).not.toBeNull();
        const entries = (await fastify.inject({ method: 'GET', url: '/v1/staff/audit', headers: staff('key-bob') })).json().entries;
        expect(entries.map((entry: { action: string }) => entry.action)).toEqual(['execute_ban', 'approve_ban', 'propose_ban']);
    });

    test('checkpoints are signed by the operator, and anyone can read the latest', async () => {
        expect((await fastify.inject({ method: 'GET', url: '/v1/checkpoints/latest' })).statusCode).toBe(404);
        await fastify.inject({ method: 'POST', url: '/v1/staff/checkpoints', headers: staff('key-alice') });
        const checkpoint = (await fastify.inject({ method: 'GET', url: '/v1/checkpoints/latest' })).json();
        const key = createPublicKey({ key: Buffer.from(checkpoint.publicKey, 'base64url'), format: 'der', type: 'spki' });
        expect(verify(null, Buffer.from(JSON.stringify({ hash: checkpoint.hash })), key, Buffer.from(checkpoint.signature, 'base64url'))).toBe(true);
        expect(checkpoint.summary).toMatchObject({ contracts: [], moneyLog: { entries: 0 } });
    });

    test('a banned organization can read and appeal, once, but change nothing else', async () => {
        const owner = { cookie: 'session=user_owner:acme:owner' };
        const admin = { cookie: 'session=user_admin:acme:admin' };
        const id = (await fastify.inject({ method: 'GET', url: '/v1/org', headers: owner })).json().id;
        await db.update(organizationsTable).set({ bannedAt: new Date(), banReason: 'Proven fraud' }).where(eq(organizationsTable.id, id));

        expect((await fastify.inject({ method: 'GET', url: '/v1/org', headers: owner })).json()).toMatchObject({ banned: true, heldForVerificationMicroUsd: 0 });
        expect((await fastify.inject({ method: 'POST', url: '/v1/org/enrollment-tokens', headers: admin, payload: {} })).statusCode).toBe(403);
        expect((await fastify.inject({ method: 'POST', url: '/v1/org/appeal', headers: admin, payload: { statement: 'x' } })).statusCode).toBe(403);
        expect((await fastify.inject({ method: 'POST', url: '/v1/org/appeal', headers: owner, payload: { statement: 'A bug, not fraud' } })).statusCode).toBe(200);
        expect((await fastify.inject({ method: 'POST', url: '/v1/org/appeal', headers: owner, payload: { statement: 'again' } })).statusCode).toBe(409);
        const ban = (await fastify.inject({ method: 'GET', url: '/v1/org/ban', headers: admin })).json();
        expect(ban).toMatchObject({ banned: true, reason: 'Proven fraud', appeal: { status: 'open', statement: 'A bug, not fraud' } });
        expect((await fastify.inject({ method: 'GET', url: '/v1/org/audit', headers: admin })).json().entries).toMatchObject([{ action: 'appeal' }]);
    });
});
