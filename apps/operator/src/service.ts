import type { DashboardAuthenticator } from './auth/clerk.js';
import { type BillingConfig, BillingService } from './billing/billingService.js';
import type { Database } from './db/database.js';
import { OrganizationService } from './organizations.js';
import { type PaymentPolicy, PaymentService } from './payments/paymentService.js';
import { type PayoutPolicy, PayoutService } from './payouts/payoutService.js';
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
    /** Without it, the dashboard API isn't served. */
    dashboardAuthenticator?: DashboardAuthenticator;
}

export interface Service {
    organizations: OrganizationService;
    payments: PaymentService;
    billing?: BillingService;
    payouts?: PayoutService;
    webhooks?: StripeWebhookService;
    stripe?: StripeConfig;
    dashboardAuthenticator?: DashboardAuthenticator;
}

export function createService(db: Database, config: ServiceConfig): Service {
    const organizations = new OrganizationService(db);
    const service: Service = {
        organizations,
        payments: new PaymentService(db, organizations, config),
        dashboardAuthenticator: config.dashboardAuthenticator,
    };
    if (config.stripe) {
        service.stripe = config.stripe;
        service.billing = new BillingService(db, config.stripe.gateway, config.stripe.billing);
        service.payouts = new PayoutService(db, config.stripe.gateway, config.stripe.payouts);
        service.webhooks = new StripeWebhookService(db, service.billing, service.payouts);
    }
    return service;
}
