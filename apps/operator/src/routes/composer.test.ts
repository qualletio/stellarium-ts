import { eq } from 'drizzle-orm';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import type { DashboardAuthenticator, DashboardSession } from '../auth/dashboardAuth.js';
import type { Database } from '../db/database.js';
import { authOrganizationsTable, nodesTable, organizationsTable } from '../db/schema.js';
import { RunTokenSigner } from '../runs/tokens.js';
import { createService, type Service } from '../service.js';
import { createTestDatabase, generateNodeKeys, seedOrganizations } from '../testing.js';
import { DASHBOARD_SECRET_HEADER } from './composer.js';
import routes from './index.js';

/** Accepts a `session=<userId>:<organizationId>:<role>` cookie. */
class FakeAuthenticator implements DashboardAuthenticator {
    async verify(headers: Headers): Promise<DashboardSession | undefined> {
        const token = headers.get('cookie')?.match(/(?:^|; )session=([^;]*)/)?.[1];
        const [userId, organizationId, role] = token?.split(':') ?? [];
        if (!userId) return undefined;
        return { userId, activeOrganization: organizationId ? { id: organizationId, name: `Org ${organizationId}`, role: role ?? 'member' } : undefined };
    }
}

const SECRET = 'dashboard-secret';
const USAGE = { inputTokens: 1_000, cacheWriteTokens: 0, cacheReadTokens: 0, outputTokens: 1_000 };

describe('Composer routes', () => {
    let db: Database;
    let close: () => Promise<void>;
    let fastify: FastifyInstance;
    let service: Service;
    const runTokenKeys = generateNodeKeys();

    async function start(dashboardServiceSecret: string | undefined = SECRET) {
        service = createService(db, {
            platformFeeBps: 2000,
            dashboardAuthenticator: new FakeAuthenticator(),
            runTokenPrivateKey: runTokenKeys.privateKey,
            composer: { rates: { inputMicroUsdPerMillionTokens: 4_000_000, cacheReadMicroUsdPerMillionTokens: 400_000, outputMicroUsdPerMillionTokens: 20_000_000 }, turnHoldMicroUsd: 100_000 },
            dashboardServiceSecret,
        });
        fastify = Fastify();
        await fastify.register(routes, { prefix: '/v1', service });
        await fastify.ready();
    }

    beforeEach(async () => {
        ({ db, close } = await createTestDatabase());
        await db.insert(authOrganizationsTable).values({ id: 'acme', name: 'Org acme', slug: 'acme', createdAt: new Date() });
    });

    afterEach(async () => {
        await fastify.close();
        await close();
    });

    const as = (token: string) => ({ cookie: `session=${token}` });
    const admin = as('user_admin:acme:admin');
    const member = as('user_member:acme:member');
    const server = { [DASHBOARD_SECRET_HEADER]: SECRET };

    /** The operator organization behind `acme`, credited with $1. */
    async function fund(): Promise<string> {
        const { id } = (await fastify.inject({ method: 'GET', url: '/v1/org', headers: admin })).json();
        await service.organizations.grantPromotion(id, 1_000_000);
        return id;
    }

    test('an admin\'s turn, through the dashboard\'s server, is held, charged and saved', async () => {
        await start();
        const id = await fund();
        const held = await fastify.inject({ method: 'POST', url: '/v1/org/composer/turns', payload: { title: 'Weather' }, headers: { ...admin, ...server } });
        expect(held.statusCode).toBe(200);
        const { chargeId, conversationId } = held.json();

        const messages = [{ role: 'user', content: [{ type: 'text', text: 'Hi' }] }, { role: 'assistant', content: [{ type: 'text', text: 'Hello' }] }];
        const completed = await fastify.inject({ method: 'POST', url: `/v1/org/composer/turns/${chargeId}/complete`, payload: { messages, usage: USAGE }, headers: { ...admin, ...server } });
        expect(completed.json()).toEqual({ amountMicroUsd: 24_000 });

        const [organization] = await db.select().from(organizationsTable).where(eq(organizationsTable.id, id));
        expect(organization).toMatchObject({ balanceMicroUsd: 976_000, heldMicroUsd: 0 });
        const conversation = await fastify.inject({ method: 'GET', url: `/v1/org/composer/conversations/${conversationId}`, headers: admin });
        expect(conversation.json()).toMatchObject({ conversation: { title: 'Weather' }, messages });
        expect((await fastify.inject({ method: 'GET', url: '/v1/org/composer/conversations', headers: admin })).json().conversations).toHaveLength(1);
        // Conversations are the user's own.
        expect((await fastify.inject({ method: 'GET', url: '/v1/org/composer/conversations', headers: member })).json().conversations).toEqual([]);
        expect((await fastify.inject({ method: 'GET', url: `/v1/org/composer/conversations/${conversationId}`, headers: member })).statusCode).toBe(404);

        expect((await fastify.inject({ method: 'DELETE', url: `/v1/org/composer/conversations/${conversationId}`, headers: admin })).json()).toEqual({ deleted: true });
    });

    test('turns need the dashboard\'s secret and an admin', async () => {
        await start();
        await fund();
        const turn = (headers: Record<string, string>) => fastify.inject({ method: 'POST', url: '/v1/org/composer/turns', payload: { title: 'x' }, headers });

        expect((await turn(admin)).statusCode).toBe(403);
        expect((await turn({ ...admin, [DASHBOARD_SECRET_HEADER]: 'wrong' })).statusCode).toBe(403);
        expect((await turn({ ...member, ...server })).statusCode).toBe(403);
        expect((await turn({ ...server })).statusCode).toBe(401);
        expect((await fastify.inject({ method: 'POST', url: '/v1/org/composer/turns/not-a-uuid/complete', payload: { messages: [], usage: USAGE }, headers: { ...admin, ...server } })).statusCode).toBe(400);
    });

    test('turns are refused without a configured secret', async () => {
        await start('');
        expect((await fastify.inject({ method: 'POST', url: '/v1/org/composer/turns', payload: { title: 'x' }, headers: { ...admin, ...server } })).statusCode).toBe(503);
    });

    test('an admin gets a run token for one of the organization\'s API clients, without its secret', async () => {
        await start();
        const { provider } = await seedOrganizations(db, 0);
        await db.update(nodesTable).set({ listed: true, baseUrl: 'https://node.example' }).where(eq(nodesTable.publicKey, provider.publicKey));
        const { client } = (await fastify.inject({ method: 'POST', url: '/v1/org/clients', payload: { nodePublicKey: provider.publicKey }, headers: admin })).json();

        const issued = await fastify.inject({ method: 'POST', url: `/v1/org/clients/${client.id}/token`, headers: admin });
        expect(issued.statusCode).toBe(200);
        const body = issued.json();
        expect(body).toMatchObject({ token_type: 'Bearer', expires_in: expect.any(Number), nodeBaseUrl: 'https://node.example' });
        const claims = await new RunTokenSigner(runTokenKeys.privateKey).verify(body.access_token, provider.publicKey);
        expect(claims).toMatchObject({ clientId: client.id });

        expect((await fastify.inject({ method: 'POST', url: `/v1/org/clients/${client.id}/token`, headers: member })).statusCode).toBe(403);
        expect((await fastify.inject({ method: 'POST', url: '/v1/org/clients/cli_missing/token', headers: admin })).statusCode).toBe(404);
        await fastify.inject({ method: 'DELETE', url: `/v1/org/clients/${client.id}`, headers: admin });
        expect((await fastify.inject({ method: 'POST', url: `/v1/org/clients/${client.id}/token`, headers: admin })).statusCode).toBe(409);
    });
});
