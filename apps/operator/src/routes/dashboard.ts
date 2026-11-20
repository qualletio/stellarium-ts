import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { authenticateDashboard, type DashboardAuthenticator, isAdmin, requireAdmin } from '../auth/dashboardAuth.js';
import type { BillingService } from '../billing/billingService.js';
import { OperationError } from '../errors.js';
import type { Organization } from '../ledger.js';
import type { IdleBalance, ListingUpdate } from '../organizations.js';
import type { ApiClientLimits, NewApiClient } from '../runs/clients.js';
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
        // What one run may attach to contract calls (docs/money.md). 0, the default, attaches nothing.
        maxRunValueMicroUsd: microUsd,
    },
    additionalProperties: false,
} as const;

const clientLimitsSchema = {
    type: 'object',
    properties: {
        maxRunCostMicroUsd: newClientSchema.properties.maxRunCostMicroUsd,
        monthlyCapMicroUsd: newClientSchema.properties.monthlyCapMicroUsd,
        maxRunValueMicroUsd: newClientSchema.properties.maxRunValueMicroUsd,
    },
    additionalProperties: false,
} as const;

function contractId(id: string): number {
    const parsed = Number(id);
    if (!Number.isSafeInteger(parsed) || parsed <= 0 || parsed > 2_147_483_647) throw new OperationError(404, 'Contract not found');
    return parsed;
}

function summary(organization: Organization, role: string | undefined, idleBalance: IdleBalance | null, heldForVerificationMicroUsd: number) {
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
        banned: organization.bannedAt !== null,
        closed: organization.closedAt !== null,
        sanctionsBlocked: organization.sanctionsBlockedAt !== null,
        identityVerified: organization.identityVerifiedAt !== null,
        webhookUrl: organization.webhookUrl,
        // Contract payments to it whose trees the operator hasn't verified yet, which payouts hold.
        heldForVerificationMicroUsd,
        // Large and long unspent, so the dashboard asks the organization to buy credits closer to when it needs them.
        idleBalance,
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
    // A banned organization can read, and appeal, but change nothing (docs/money.md, Appeals).
    fastify.addHook('preHandler', async (request) => {
        if (request.method !== 'GET' && request.organization?.bannedAt && request.url.split('?')[0] !== '/v1/org/appeal') {
            throw new OperationError(403, 'The organization is banned. It can appeal the ban from its dashboard');
        }
    });
    const billing = (): BillingService => {
        if (!service.billing) throw new OperationError(503, 'Stripe is not configured on this operator');
        return service.billing;
    };

    fastify.get('/org', async (request) => summary(
        organization(request),
        request.dashboardSession!.activeOrganization!.role,
        await service.organizations.idleBalance(organization(request)),
        await service.money.heldForVerification(organization(request).id),
    ));

    // What the operator recorded about the organization: staff actions, fraud findings, reviews and appeals.
    fastify.get('/org/audit', async (request) => ({ entries: await service.audit.forOrganization(organization(request).id) }));

    fastify.get('/org/ban', async (request) => service.governance.banStatus(organization(request).id));

    // What the operator did to the organization's funding on its own, and where it posts these.
    fastify.get('/org/notifications', async (request) => ({ notifications: await service.notifications.forOrganization(organization(request).id) }));

    fastify.patch<{ Body: { url: string | null } }>('/org/webhook', {
        preHandler: requireAdmin,
        schema: { body: { type: 'object', required: ['url'], properties: { url: { type: ['string', 'null'], pattern: '^https://', maxLength: 1024 } }, additionalProperties: false } },
    }, async (request) => {
        await service.notifications.setWebhook(organization(request).id, request.body.url);
        return { webhookUrl: request.body.url };
    });

    // The owner appeals a ban, once.
    fastify.post<{ Body: { statement: string } }>('/org/appeal', {
        schema: { body: { type: 'object', required: ['statement'], properties: { statement: { type: 'string', minLength: 1, maxLength: 8192 } }, additionalProperties: false } },
    }, async (request) => {
        if (request.dashboardSession!.activeOrganization!.role !== 'owner') {
            throw new OperationError(403, 'Only the organization\'s owner can appeal its ban');
        }
        return { appeal: await service.governance.appeal(organization(request).id, request.body.statement, request.dashboardSession!.userId) };
    });

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

    fastify.patch<{ Params: { id: string }, Body: ApiClientLimits }>('/org/clients/:id', { preHandler: requireAdmin, schema: { body: clientLimitsSchema } }, async (request) => {
        const { secretHash: _, ...client } = await service.clients.updateLimits(organization(request).id, request.params.id, request.body);
        return { client };
    });

    // For the dashboard to run a script or deploy a contract with the client, for a signed-in admin.
    fastify.post<{ Params: { id: string } }>('/org/clients/:id/token', { preHandler: requireAdmin }, async (request) => {
        const { token, expiresIn, nodeBaseUrl } = await service.clients.issueTokenForOrganization(organization(request).id, request.params.id);
        return { access_token: token, token_type: 'Bearer', expires_in: expiresIn, nodeBaseUrl };
    });

    fastify.delete<{ Params: { id: string } }>('/org/clients/:id', { preHandler: requireAdmin }, async (request) => {
        await service.clients.revoke(organization(request).id, request.params.id);
        return { revoked: true };
    });

    // Event contracts the organization's API clients deployed, which nodes may run and bill to it.
    fastify.get('/org/event-mandates', async (request) => ({ mandates: await service.runs.listEventMandates(organization(request).id) }));

    fastify.delete<{ Params: { id: string } }>('/org/event-mandates/:id', { preHandler: requireAdmin }, async (request) => {
        if (!await service.runs.revokeEventMandate(organization(request).id, request.params.id)) {
            throw new OperationError(404, 'No such active event mandate');
        }
        return { revoked: true };
    });

    // Contract versions the organization owns (docs/money.md), and their money logs. A funder or payee reads the
    // log entries that involve it.
    fastify.get('/org/contracts', async (request) => ({ contracts: await service.money.ownedContracts(organization(request).id) }));

    fastify.get<{ Params: { id: string } }>('/org/contracts/:id/log', async (request) => {
        return { entries: await service.money.moneyLog(organization(request).id, contractId(request.params.id)) };
    });

    // The owner's emergency stop: returns a version's funding to its funders, and refuses money from then on.
    fastify.post<{ Params: { id: string } }>('/org/contracts/:id/refund-all', { preHandler: requireAdmin }, async (request) => {
        return service.money.refundAll(organization(request).id, contractId(request.params.id));
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
