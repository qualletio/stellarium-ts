import { eq } from 'drizzle-orm';
import Fastify, { type FastifyInstance } from 'fastify';
import Stripe from 'stripe';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import type { DashboardAuthenticator, DashboardSession } from '../auth/dashboardAuth.js';
import type { Database } from '../db/database.js';
import { authOrganizationsTable, nodesTable } from '../db/schema.js';
import type { OrganizationService } from '../organizations.js';
import { DEFAULT_PAYOUT_POLICY } from '../payouts/payoutService.js';
import { createService, type Service } from '../service.js';
import { StripeRequestError, StripeSdkGateway } from '../stripe/gateway.js';
import { BILLING_CONFIG, createTestDatabase, FakeStripe, generateNodeKeys, seedOrganizations, signedVoucher } from '../testing.js';
import routes from './index.js';

/** Accepts a `session=<userId>:<organizationId>:<role>` cookie. The organization is named `Org <id>`. */
class FakeAuthenticator implements DashboardAuthenticator {
    async verify(headers: Headers): Promise<DashboardSession | undefined> {
        const token = headers.get('cookie')?.match(/(?:^|; )session=([^;]*)/)?.[1];
        const [userId, organizationId, role] = token?.split(':') ?? [];
        if (!userId) return undefined;
        return { userId, activeOrganization: organizationId ? { id: organizationId, name: `Org ${organizationId}`, role: role ?? 'member' } : undefined };
    }
}

const WEBHOOK_SECRET = 'whsec_platform';
const CONNECT_WEBHOOK_SECRET = 'whsec_connect';

describe('dashboard and Stripe routes', () => {
    let db: Database;
    let close: () => Promise<void>;
    let fastify: FastifyInstance;
    let service: Service;
    let stripe: FakeStripe;
    /** What the fake `{baseUrl}/v1/self` answers, by base URL. */
    let selves: Map<string, string>;

    async function start(options: { stripe?: boolean } = { stripe: true }) {
        stripe = new FakeStripe();
        // Signatures are checked by the real SDK; everything else goes to the fake.
        stripe.constructEvent = (payload, signature, secret) => new StripeSdkGateway('sk_test_unused').constructEvent(payload, signature, secret);
        selves = new Map();
        service = createService(db, {
            platformFeeBps: 2000,
            dashboardAuthenticator: new FakeAuthenticator(),
            verifyNode: async (baseUrl) => selves.get(baseUrl),
            stripe: options.stripe ? {
                gateway: stripe, webhookSecret: WEBHOOK_SECRET, connectWebhookSecret: CONNECT_WEBHOOK_SECRET,
                billing: BILLING_CONFIG, payouts: DEFAULT_PAYOUT_POLICY,
            } : undefined,
        });
        fastify = Fastify();
        await fastify.register(routes, { prefix: '/v1', service });
        await fastify.ready();
    }

    beforeEach(async () => {
        ({ db, close } = await createTestDatabase());
        // The dashboard organization the fake sessions act in.
        await db.insert(authOrganizationsTable).values({ id: 'acme', name: 'Org acme', slug: 'acme', createdAt: new Date() });
    });

    afterEach(async () => {
        await fastify.close();
        await close();
    });

    const as = (token: string) => ({ cookie: `theme=dark; session=${token}` });
    const admin = as('user_admin:acme:admin');
    const member = as('user_member:acme:member');

    describe('dashboard', () => {
        beforeEach(() => start());

        test('creates the organization for a dashboard organization on first use, then reuses it', async () => {
            const first = await fastify.inject({ method: 'GET', url: '/v1/org', headers: member });
            const second = await fastify.inject({ method: 'GET', url: '/v1/org', headers: admin });

            expect(first.statusCode).toBe(200);
            expect(first.json()).toMatchObject({
                id: expect.stringMatching(/^org_/), name: 'Org acme', role: 'member', admin: false,
                balanceMicroUsd: 0, availableMicroUsd: 0, payableMicroUsd: 0, payoutsEnabled: false, payoutOnboardingStarted: false, frozen: false,
            });
            expect(second.json().id).toBe(first.json().id);
        });

        test.each([
            ['no session', {}, 401],
            ['no active organization', as('user_1::'), 403],
        ])('refuses a request with %s', async (_, headers, status) => {
            expect((await fastify.inject({ method: 'GET', url: '/v1/org', headers })).statusCode).toBe(status);
        });

        test('lets only admins move money or manage nodes', async () => {
            for (const [method, url, payload] of [
                ['POST', '/v1/org/top-ups', { amountCents: 2_000 }],
                ['POST', '/v1/org/billing-portal', undefined],
                ['POST', '/v1/org/connect/onboarding', undefined],
                ['POST', '/v1/org/enrollment-tokens', {}],
                ['DELETE', '/v1/org/nodes/key', undefined],
                ['PATCH', '/v1/org/nodes/key', { listed: false }],
                ['POST', '/v1/org/clients', { nodePublicKey: 'key' }],
                ['PATCH', '/v1/org/clients/cli_x', { maxRunCostMicroUsd: 1 }],
                ['DELETE', '/v1/org/clients/cli_x', undefined],
            ] as const) {
                const response = await fastify.inject({ method, url, payload, headers: member });
                expect(response.statusCode, `${method} ${url}`).toBe(403);
            }
        });

        test('counts owners as admins', async () => {
            const response = await fastify.inject({ method: 'POST', url: '/v1/org/enrollment-tokens', payload: {}, headers: as('user_owner:acme:owner') });

            expect(response.statusCode).toBe(200);
            expect((await fastify.inject({ method: 'GET', url: '/v1/org', headers: as('user_owner:acme:owner') })).json()).toMatchObject({ role: 'owner', admin: true });
        });

        test('an admin starts a top-up, opens the portal and Connect onboarding', async () => {
            const topUp = await fastify.inject({ method: 'POST', url: '/v1/org/top-ups', payload: { amountCents: 2_000 }, headers: admin });
            expect(topUp.json()).toMatchObject({ topUpId: expect.any(Number), url: expect.stringMatching(/^https:\/\/checkout/) });
            expect((await fastify.inject({ method: 'POST', url: '/v1/org/billing-portal', headers: admin })).json()).toEqual({ url: 'https://billing.stripe.test/session' });
            expect((await fastify.inject({ method: 'POST', url: '/v1/org/connect/onboarding', headers: admin })).json().url).toMatch(/^https:\/\/connect/);

            const org = (await fastify.inject({ method: 'GET', url: '/v1/org', headers: member })).json();
            expect(org.payoutOnboardingStarted).toBe(true);
            const topUps = (await fastify.inject({ method: 'GET', url: '/v1/org/top-ups', headers: member })).json().topUps;
            expect(topUps).toMatchObject([{ status: 'pending', amountMicroUsd: 20_000_000, createdBy: 'user_admin' }]);
        });

        test('summarizes a Stripe refusal instead of answering an internal error', async () => {
            stripe.createExpressAccount = async () => {
                throw new StripeRequestError("The provided key 'rk_live_...' does not have the required permissions", true, { type: 'StripePermissionError' });
            };
            const refused = await fastify.inject({ method: 'POST', url: '/v1/org/connect/onboarding', headers: admin });
            expect(refused.statusCode).toBe(502);
            expect(refused.json().error).toMatch(/^Stripe refused the operator's API key/);
            expect(refused.body).not.toContain('rk_live');

            stripe.createExpressAccount = async () => { throw new StripeRequestError('Connection reset', false); };
            const unreachable = await fastify.inject({ method: 'POST', url: '/v1/org/connect/onboarding', headers: admin });
            expect(unreachable.statusCode).toBe(503);
            expect(unreachable.json()).toEqual({ error: 'Stripe could not be reached. Try again in a moment.' });
        });

        test('an admin enrolls a node with a token, lists it and revokes it', async () => {
            const { token } = (await fastify.inject({ method: 'POST', url: '/v1/org/enrollment-tokens', payload: { label: 'prod-1' }, headers: admin })).json();
            const node = generateNodeKeys();
            await service.organizations.session(node.publicKey, token);

            const nodes = (await fastify.inject({ method: 'GET', url: '/v1/org/nodes', headers: member })).json().nodes;
            expect(nodes).toMatchObject([{ publicKey: node.publicKey, label: 'prod-1', revokedAt: null }]);

            const revoked = await fastify.inject({ method: 'DELETE', url: `/v1/org/nodes/${node.publicKey}`, headers: admin });
            expect(revoked.json()).toEqual({ revoked: true });
            expect((await service.organizations.getNode(node.publicKey))!.revokedAt).not.toBeNull();
        });

        test('an admin can\'t revoke another organization\'s node', async () => {
            const { provider } = await seedOrganizations(db, 0);

            const response = await fastify.inject({ method: 'DELETE', url: `/v1/org/nodes/${provider.publicKey}`, headers: admin });

            expect(response.statusCode).toBe(404);
            expect((await service.organizations.getNode(provider.publicKey))!.revokedAt).toBeNull();
        });

        test('an admin lists a node once its URL answers with its key, and sets its price', async () => {
            const { token } = (await fastify.inject({ method: 'POST', url: '/v1/org/enrollment-tokens', payload: {}, headers: admin })).json();
            const node = generateNodeKeys();
            await service.organizations.session(node.publicKey, token, 'https://node.example');
            const patch = (payload: object) => fastify.inject({ method: 'PATCH', url: `/v1/org/nodes/${node.publicKey}`, payload, headers: admin });

            expect((await patch({ listed: true })).statusCode).toBe(400);
            expect((await patch({ name: 'Weather', listed: true })).statusCode).toBe(422);

            selves.set('https://node.example', node.publicKey);
            const listed = await patch({ name: 'Weather', description: 'Forecasts', priceMicroUsdPerMillionTokens: 2_000_000, listed: true });
            expect(listed.statusCode).toBe(200);
            expect(listed.json().node).toMatchObject({ listed: true, verifiedAt: expect.any(String), priceMicroUsdPerMillionTokens: 2_000_000 });

            const listings = (await fastify.inject({ method: 'GET', url: '/v1/listings', headers: member })).json().listings;
            expect(listings).toEqual([expect.objectContaining({ publicKey: node.publicKey, name: 'Weather', baseUrl: 'https://node.example', organizationName: 'Org acme' })]);

            // A new URL unlists it until it is verified again.
            await service.organizations.session(node.publicKey, undefined, 'https://moved.example');
            expect((await service.organizations.getNode(node.publicKey))).toMatchObject({ listed: false, verifiedAt: null, baseUrl: 'https://moved.example' });
        });

        test('an admin creates an API client for a listed node, sees it without its secret, and revokes it', async () => {
            const { provider } = await seedOrganizations(db, 0);
            const create = (nodePublicKey: string) => fastify.inject({ method: 'POST', url: '/v1/org/clients', payload: { nodePublicKey, label: 'ci', maxRunCostMicroUsd: 5_000 }, headers: admin });

            expect((await create(provider.publicKey)).statusCode).toBe(404);

            await db.update(nodesTable).set({ listed: true }).where(eq(nodesTable.publicKey, provider.publicKey));
            const created = await create(provider.publicKey);
            expect(created.statusCode).toBe(200);
            const { client, clientSecret } = created.json();
            expect(client).toMatchObject({ id: expect.stringMatching(/^cli_/), label: 'ci', maxRunCostMicroUsd: 5_000, createdBy: 'user_admin' });
            expect(client.secretHash).toBeUndefined();
            expect(clientSecret).toMatch(/^cs_/);

            const clients = (await fastify.inject({ method: 'GET', url: '/v1/org/clients', headers: member })).json().clients;
            expect(clients).toEqual([expect.objectContaining({ id: client.id, monthToDateMicroUsd: 0 })]);
            expect(clients[0].secretHash).toBeUndefined();

            expect((await fastify.inject({ method: 'DELETE', url: `/v1/org/clients/${client.id}`, headers: admin })).json()).toEqual({ revoked: true });
            expect((await service.clients.get(client.id))!.revokedAt).not.toBeNull();
        });

        test('an admin updates an API client\'s limits', async () => {
            const { provider } = await seedOrganizations(db, 0);
            await db.update(nodesTable).set({ listed: true }).where(eq(nodesTable.publicKey, provider.publicKey));
            const { client } = (await fastify.inject({ method: 'POST', url: '/v1/org/clients', payload: { nodePublicKey: provider.publicKey, maxRunCostMicroUsd: 5_000 }, headers: admin })).json();
            const update = (payload: object, id = client.id) => fastify.inject({ method: 'PATCH', url: `/v1/org/clients/${id}`, payload, headers: admin });

            const capped = await update({ monthlyCapMicroUsd: 20_000 });
            expect(capped.statusCode).toBe(200);
            expect(capped.json().client).toMatchObject({ maxRunCostMicroUsd: 5_000, monthlyCapMicroUsd: 20_000 });
            expect(capped.json().client.secretHash).toBeUndefined();

            // The cap is checked against the merged limits.
            expect((await update({ maxRunCostMicroUsd: 30_000 })).statusCode).toBe(400);
            expect((await update({ maxRunCostMicroUsd: 30_000, monthlyCapMicroUsd: null })).json().client).toMatchObject({ maxRunCostMicroUsd: 30_000, monthlyCapMicroUsd: null });
            expect((await update({ maxRunCostMicroUsd: 0 })).statusCode).toBe(400);

            expect((await update({ maxRunCostMicroUsd: 1 }, 'cli_missing')).statusCode).toBe(404);
            await fastify.inject({ method: 'DELETE', url: `/v1/org/clients/${client.id}`, headers: admin });
            expect((await update({ maxRunCostMicroUsd: 1 })).statusCode).toBe(409);
        });

        test('lists receipts as payer and as provider', async () => {
            const { provider } = await seedOrganizations(db, 0);
            const organizationId = (await fastify.inject({ method: 'GET', url: '/v1/org', headers: admin })).json().id;
            const node = generateNodeKeys();
            await service.organizations.enroll(organizationId, node.publicKey);
            await service.organizations.grantPromotion(organizationId, 100_000);
            const { voucher } = signedVoucher(node);
            await service.payments.authorize(provider.publicKey, voucher);

            const asPayer = (await fastify.inject({ method: 'GET', url: '/v1/org/receipts?as=payer', headers: member })).json();
            expect(asPayer.receipts).toMatchObject([{ requestId: voucher.requestId, status: 'held', heldMicroUsd: 10_000 }]);
            expect((await fastify.inject({ method: 'GET', url: '/v1/org/receipts?as=provider', headers: member })).json()).toEqual({ receipts: [] });
            expect((await fastify.inject({ method: 'GET', url: '/v1/org/receipts', headers: member })).statusCode).toBe(400);
        });
    });

    test('answers 503 for billing when Stripe isn\'t configured', async () => {
        await start({ stripe: false });

        const response = await fastify.inject({ method: 'POST', url: '/v1/org/top-ups', payload: { amountCents: 2_000 }, headers: admin });

        expect(response.statusCode).toBe(503);
        expect((await fastify.inject({ method: 'POST', url: '/v1/stripe/webhook', payload: {} })).statusCode).toBe(404);
    });

    describe('Stripe webhooks', () => {
        beforeEach(() => start());

        function deliver(url: string, event: object, secret: string, signature?: string) {
            const payload = JSON.stringify(event);
            const header = signature ?? new Stripe('sk_test_unused').webhooks.generateTestHeaderString({ payload, secret });
            return fastify.inject({ method: 'POST', url, payload, headers: { 'content-type': 'application/json', 'stripe-signature': header } });
        }

        test('credits a top-up from a signed checkout.session.completed', async () => {
            const { topUpId } = (await fastify.inject({ method: 'POST', url: '/v1/org/top-ups', payload: { amountCents: 2_000 }, headers: admin })).json();
            const sessionId = (await service.organizations.listTopUps((await fastify.inject({ method: 'GET', url: '/v1/org', headers: admin })).json().id, { limit: 1 }))[0]!.checkoutSessionId;
            const event = { id: 'evt_1', type: 'checkout.session.completed', data: { object: { id: sessionId, payment_status: 'paid', currency: 'usd', amount_total: 2_000, payment_intent: 'pi_1' } } };

            const response = await deliver('/v1/stripe/webhook', event, WEBHOOK_SECRET);

            expect(response.statusCode).toBe(200);
            expect(topUpId).toBeGreaterThan(0);
            expect((await fastify.inject({ method: 'GET', url: '/v1/org', headers: member })).json().balanceMicroUsd).toBe(20_000_000);
        });

        test('refuses an event signed with the other endpoint\'s secret, or not signed', async () => {
            const event = { id: 'evt_1', type: 'account.updated', data: { object: { id: 'acct_1' } } };

            expect((await deliver('/v1/stripe/webhook', event, CONNECT_WEBHOOK_SECRET)).statusCode).toBe(400);
            expect((await deliver('/v1/stripe/connect-webhook', event, CONNECT_WEBHOOK_SECRET)).statusCode).toBe(200);
            expect((await deliver('/v1/stripe/connect-webhook', event, CONNECT_WEBHOOK_SECRET, 't=1,v1=bad')).statusCode).toBe(400);
        });
    });
});
