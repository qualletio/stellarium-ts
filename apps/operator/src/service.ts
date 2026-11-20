import { type Auth, type AuthConfig, createAuth } from './auth/betterAuth.js';
import { BetterAuthAuthenticator, type DashboardAuthenticator } from './auth/dashboardAuth.js';
import { type BillingConfig, BillingService } from './billing/billingService.js';
import { type ComposerPolicy, ComposerService } from './composer/composerService.js';
import type { Database } from './db/database.js';
import { AuditLog } from './governance/audit.js';
import { GovernanceService, parseStaffKeys, type SanctionsScreener } from './governance/governanceService.js';
import { NotificationService } from './governance/notifications.js';
import { type AlertPolicy, AlertService, DEFAULT_ALERT_POLICY } from './governance/alerts.js';
import { DEFAULT_MONEY_POLICY, type MoneyPolicy, MoneyService } from './money/moneyService.js';
import { FraudService } from './verification/fraudService.js';
import { VerificationService } from './verification/verificationService.js';
import { type IdleBalancePolicy, type NodeVerifier, OrganizationService } from './organizations.js';
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
    /** When the dashboard warns an organization that its prepaid balance is large and unspent. */
    idleBalance?: IdleBalancePolicy;
    /** Rates and the per-turn hold for the dashboard's Composer. */
    composer?: ComposerPolicy;
    /** Limits on money in contracts (docs/money.md). The platform fee comes from `platformFeeBps`. */
    money?: Partial<Omit<MoneyPolicy, 'platformFeeBps'>>;
    /** Staff members' API keys, as `STAFF_API_KEYS` writes them (`name:key,...`). Without any, the staff API is off. */
    staffApiKeys?: string;
    /** How long after a tree is applied its receipts may still arrive (docs/money.md, State hash chains). */
    receiptDeadlineMs?: number;
    /** Checks organizations against sanctions lists. Without one, only staff block organizations. */
    sanctionsScreener?: SanctionsScreener;
    /** When nodes' contracts raise alerts for staff. */
    alerts?: Partial<AlertPolicy>;
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
    money: MoneyService;
    verification: VerificationService;
    fraud: FraudService;
    governance: GovernanceService;
    audit: AuditLog;
    notifications: NotificationService;
    alerts: AlertService;
    /** Staff members by their API key. */
    staff: Map<string, string>;
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
    const organizations = new OrganizationService(db, config.verifyNode, config.idleBalance);
    const payments = new PaymentService(db, organizations, config);
    const runTokens = config.runTokenPrivateKey ? new RunTokenSigner(config.runTokenPrivateKey) : undefined;
    const clients = new ApiClientService(db, runTokens);
    const runs = new RunService(db, organizations, clients, payments, runTokens);
    const money = new MoneyService(db, { ...DEFAULT_MONEY_POLICY, ...config.money, platformFeeBps: config.platformFeeBps }, runTokens);
    runs.settlement = money;
    money.activeNode = (publicKey) => organizations.requireActiveNode(publicKey);
    const notifications = new NotificationService(db, config.auth?.mailer, runTokens);
    money.notify = (organizationId, kind, details) => notifications.notify(organizationId, kind, details);
    const audit = new AuditLog(db);
    const fraud = new FraudService(db, money, audit);
    const governance = new GovernanceService(db, organizations, fraud, audit, money, runTokens, config.auth?.mailer, config.sanctionsScreener);
    fraud.bans = governance;
    const service: Service = {
        organizations,
        payments,
        clients,
        runs,
        money,
        verification: new VerificationService(db, fraud, audit, money, config.receiptDeadlineMs),
        fraud,
        governance,
        audit,
        notifications,
        alerts: new AlertService(db, audit, { ...DEFAULT_ALERT_POLICY, ...config.alerts }),
        staff: parseStaffKeys(config.staffApiKeys),
        composer: new ComposerService(db, config.composer),
        dashboardServiceSecret: config.dashboardServiceSecret,
        runTokens,
        dashboardAuthenticator: config.dashboardAuthenticator,
    };
    if (config.auth) {
        service.auth = createAuth(db, config.auth, (userId) => governance.isPaused(userId));
        service.dashboardAuthenticator ??= new BetterAuthAuthenticator(service.auth, db);
    }
    if (config.stripe) {
        service.stripe = config.stripe;
        service.billing = new BillingService(db, config.stripe.gateway, config.stripe.billing);
        service.payouts = new PayoutService(db, config.stripe.gateway, config.stripe.payouts);
        service.webhooks = new StripeWebhookService(db, service.billing, service.payouts, (organizationId, amount) => money.recoverFromFunding(organizationId, amount));
    }
    return service;
}
