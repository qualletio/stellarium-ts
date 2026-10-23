import Fastify, { type FastifyInstance } from 'fastify';
import Stripe from 'stripe';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import type { DashboardAuthenticator, DashboardSession } from '../auth/dashboardAuth.js';
import type { Database } from '../db/database.js';
import { authOrganizationsTable } from '../db/schema.js';
import type { OrganizationService } from '../organizations.js';
import { DEFAULT_PAYOUT_POLICY } from '../payouts/payoutService.js';
import { createService, type Service } from '../service.js';
import { StripeSdkGateway } from '../stripe/gateway.js';
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

    async function start(options: { stripe?: boolean } = { stripe: true }) {
        stripe = new FakeStripe();
        // Signatures are checked by the real SDK; everything else goes to the fake.
        stripe.constructEvent = (payload, signature, secret) => new StripeSdkGateway('sk_test_unused').constructEvent(payload, signature, secret);
        service = createService(db, {
            platformFeeBps: 2000,
            dashboardAuthenticator: new FakeAuthenticator(),
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
