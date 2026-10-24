import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { authenticateDashboard, type DashboardAuthenticator, isAdmin, requireAdmin } from '../auth/dashboardAuth.js';
import type { BillingService } from '../billing/billingService.js';
import { OperationError } from '../errors.js';
import type { Organization } from '../ledger.js';
import type { ListingUpdate } from '../organizations.js';
import type { NewApiClient } from '../runs/clients.js';
import type { RouteOptions } from './index.js';

const pageQuerySchema = {
    type: 'object',
    properties: {
        limit: { type: 'integer', minimum: 1, maximum: 100, default: 25 },
        before: { type: 'integer', minimum: 1 },
    },
} as const;

type PageQuery = { limit: number, before?: number };

const microUsd = { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER } as const;

const listingSchema = {
    type: 'object',
    properties: {
        name: { type: 'string', minLength: 1, maxLength: 255 },
        description: { type: ['string', 'null'], maxLength: 2048 },
        priceMicroUsdPerMillionTokens: microUsd,
        listed: { type: 'boolean' },
    },
    additionalProperties: false,
} as const;

const newClientSchema = {
    type: 'object',
    required: ['nodePublicKey'],
    properties: {
        nodePublicKey: { type: 'string', minLength: 1, maxLength: 255 },
        label: { type: 'string', minLength: 1, maxLength: 255 },
        maxRunCostMicroUsd: { ...microUsd, minimum: 1 },
        monthlyCapMicroUsd: { type: ['integer', 'null'], minimum: 1, maximum: Number.MAX_SAFE_INTEGER },
    },
    additionalProperties: false,
} as const;

function summary(organization: Organization, role: string | undefined) {
    return {
        id: organization.id,
        name: organization.name,
        role,
        admin: isAdmin(role),
        balanceMicroUsd: organization.balanceMicroUsd,
        heldMicroUsd: organization.heldMicroUsd,
        availableMicroUsd: organization.balanceMicroUsd - organization.heldMicroUsd,
        payableMicroUsd: organization.payableMicroUsd,
        payoutsEnabled: organization.payoutsEnabled,
        payoutOnboardingStarted: organization.stripeAccountId !== null,
        frozen: organization.frozenAt !== null,
    };
}

/**
 * The dashboard's API at platform.stellarium.sh. Requests carry the Better Auth session cookie, which the
 * dashboard forwards, and act on the session's active organization. Members can read; owners and admins
 * move money and manage nodes.
 */
const dashboardRoutes: FastifyPluginAsync<RouteOptions & { authenticator: DashboardAuthenticator }> = async function (fastify, { service, authenticator }) {
    fastify.addHook('preHandler', authenticateDashboard(authenticator, service.organizations));
    const organization = (request: FastifyRequest) => request.organization!;
    const billing = (): BillingService => {
        if (!service.billing) throw new OperationError(503, 'Stripe is not configured on this operator');
        return service.billing;
    };

    fastify.get('/org', async (request) => summary(organization(request), request.dashboardSession!.activeOrganization!.role));

    fastify.get<{ Querystring: PageQuery & { as: 'payer' | 'provider' } }>('/org/receipts', {
        schema: { querystring: { ...pageQuerySchema, required: ['as'], properties: { ...pageQuerySchema.properties, as: { enum: ['payer', 'provider'] } } } },
    }, async (request) => {
        const { as, ...page } = request.query;
        return { receipts: await service.organizations.listReceipts(organization(request).id, as, page) };
    });

    fastify.get<{ Querystring: PageQuery }>('/org/top-ups', { schema: { querystring: pageQuerySchema } }, async (request) => {
        return { topUps: await service.organizations.listTopUps(organization(request).id, request.query) };
    });

    fastify.get<{ Querystring: PageQuery }>('/org/payouts', { schema: { querystring: pageQuerySchema } }, async (request) => {
        return { payouts: await service.organizations.listPayouts(organization(request).id, request.query) };
    });

    fastify.get('/org/nodes', async (request) => {
        return { nodes: await service.organizations.listNodes(organization(request).id) };
    });

    fastify.get<{ Querystring: PageQuery & { as: 'payer' | 'provider' } }>('/org/runs', {
        schema: { querystring: { ...pageQuerySchema, required: ['as'], properties: { ...pageQuerySchema.properties, as: { enum: ['payer', 'provider'] } } } },
    }, async (request) => {
        const { as, ...page } = request.query;
        return { runs: await service.organizations.listRuns(organization(request).id, as, page) };
    });

    // Every organization's listed nodes, for choosing one to create an API client for.
    fastify.get('/listings', async () => ({ listings: await service.organizations.listings() }));

    fastify.get('/org/clients', async (request) => ({ clients: await service.clients.list(organization(request).id) }));

    // The secret is shown once: the operator keeps only its hash.
    fastify.post<{ Body: Omit<NewApiClient, 'createdBy'> }>('/org/clients', { preHandler: requireAdmin, schema: { body: newClientSchema } }, async (request) => {
        const { client: { secretHash: _, ...client }, clientSecret } = await service.clients.create(organization(request).id, { ...request.body, createdBy: request.dashboardSession!.userId });
        return { client, clientSecret };
    });

    fastify.delete<{ Params: { id: string } }>('/org/clients/:id', { preHandler: requireAdmin }, async (request) => {
        await service.clients.revoke(organization(request).id, request.params.id);
        return { revoked: true };
    });

    fastify.patch<{ Params: { publicKey: string }, Body: ListingUpdate }>('/org/nodes/:publicKey', { preHandler: requireAdmin, schema: { body: listingSchema } }, async (request) => {
        return { node: await service.organizations.updateListing(organization(request).id, request.params.publicKey, request.body) };
    });

    fastify.post<{ Body: { amountCents: number } }>('/org/top-ups', {
        preHandler: requireAdmin,
        schema: { body: { type: 'object', required: ['amountCents'], properties: { amountCents: { type: 'integer' } } } },
    }, async (request) => {
        return billing().createTopUp(organization(request), request.body.amountCents, request.dashboardSession!.userId);
    });

    fastify.post('/org/billing-portal', { preHandler: requireAdmin }, async (request) => billing().customerPortal(organization(request)));

    fastify.post('/org/connect/onboarding', { preHandler: requireAdmin }, async (request) => billing().connectOnboarding(organization(request)));

    fastify.post('/org/connect/dashboard', { preHandler: requireAdmin }, async (request) => billing().connectDashboard(organization(request)));

    // The token is shown once: the operator keeps only its hash.
    fastify.post<{ Body: { label?: string } }>('/org/enrollment-tokens', {
        preHandler: requireAdmin,
        schema: { body: { type: 'object', properties: { label: { type: 'string', minLength: 1, maxLength: 255 } } } },
    }, async (request) => {
        return service.organizations.createEnrollmentToken(organization(request).id, { label: request.body?.label, createdBy: request.dashboardSession!.userId });
    });

    fastify.delete<{ Params: { publicKey: string } }>('/org/nodes/:publicKey', { preHandler: requireAdmin }, async (request) => {
        await service.organizations.revokeNode(organization(request).id, request.params.publicKey);
        return { revoked: true };
    });
};

export default dashboardRoutes;
