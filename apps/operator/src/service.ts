import { type Auth, type AuthConfig, createAuth } from './auth/betterAuth.js';
import { BetterAuthAuthenticator, type DashboardAuthenticator } from './auth/dashboardAuth.js';
import { type BillingConfig, BillingService } from './billing/billingService.js';
import { type ComposerPolicy, ComposerService } from './composer/composerService.js';
import type { Database } from './db/database.js';
import { type NodeVerifier, OrganizationService } from './organizations.js';
import { type PaymentPolicy, PaymentService } from './payments/paymentService.js';
import { type PayoutPolicy, PayoutService } from './payouts/payoutService.js';
import { ApiClientService } from './runs/clients.js';
import { RunService } from './runs/runService.js';
import { RunTokenSigner } from './runs/tokens.js';
import type { StripeGateway } from './stripe/gateway.js';
import { StripeWebhookService } from './stripe/webhooks.js';

export interface StripeConfig {
    gateway: StripeGateway;
    webhookSecret: string;
    connectWebhookSecret: string;
    billing: BillingConfig;
    payouts: PayoutPolicy;
}

export interface ServiceConfig extends PaymentPolicy {
    /** Without it, top-ups, onboarding and payouts are unavailable: balances come only from promotions. */
    stripe?: StripeConfig;
    /** Without it, neither sign-in nor the dashboard API is served. */
    auth?: AuthConfig;
    /** Replaces the Better Auth sessions `auth` enables, in tests. */
    dashboardAuthenticator?: DashboardAuthenticator;
    /** The Ed25519 key run tokens are signed with (PKCS#8 DER, base64url). Without it, API clients can't get tokens. */
    runTokenPrivateKey?: string;
    /** Replaces fetching `{baseUrl}/v1/self` when a node is listed, in tests. */
    verifyNode?: NodeVerifier;
    /** Rates and the per-turn hold for the dashboard's Composer. */
    composer?: ComposerPolicy;
    /**
     * Shared with the dashboard's server, which sends it with the Composer turns it holds and completes.
     * Without it, Composer turns are refused.
     */
    dashboardServiceSecret?: string;
}

export interface Service {
    organizations: OrganizationService;
    payments: PaymentService;
    clients: ApiClientService;
    runs: RunService;
    composer: ComposerService;
    dashboardServiceSecret?: string;
    runTokens?: RunTokenSigner;
    billing?: BillingService;
    payouts?: PayoutService;
    webhooks?: StripeWebhookService;
    stripe?: StripeConfig;
    auth?: Auth;
    dashboardAuthenticator?: DashboardAuthenticator;
}

export function createService(db: Database, config: ServiceConfig): Service {
    const organizations = new OrganizationService(db, config.verifyNode);
    const payments = new PaymentService(db, organizations, config);
    const runTokens = config.runTokenPrivateKey ? new RunTokenSigner(config.runTokenPrivateKey) : undefined;
    const clients = new ApiClientService(db, runTokens);
    const service: Service = {
        organizations,
        payments,
        clients,
        runs: new RunService(db, organizations, clients, payments, runTokens),
        composer: new ComposerService(db, config.composer),
        dashboardServiceSecret: config.dashboardServiceSecret,
        runTokens,
        dashboardAuthenticator: config.dashboardAuthenticator,
    };
    if (config.auth) {
        service.auth = createAuth(db, config.auth);
        service.dashboardAuthenticator ??= new BetterAuthAuthenticator(service.auth, db);
    }
    if (config.stripe) {
        service.stripe = config.stripe;
        service.billing = new BillingService(db, config.stripe.gateway, config.stripe.billing);
        service.payouts = new PayoutService(db, config.stripe.gateway, config.stripe.payouts);
        service.webhooks = new StripeWebhookService(db, service.billing, service.payouts);
    }
    return service;
}
