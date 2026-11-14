import 'dotenv/config';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import Fastify from 'fastify';
import type { AuthConfig } from './auth/betterAuth.js';
import { LogMailer, ResendMailer } from './auth/email.js';
import { DEFAULT_MAXIMUM_TOP_UP_CENTS, DEFAULT_MINIMUM_TOP_UP_CENTS } from './billing/billingService.js';
import { DEFAULT_COMPOSER_POLICY } from './composer/composerService.js';
import { DEFAULT_MONEY_POLICY, MAX_CONTRACT_HOLD_LIMIT_MS } from './money/moneyService.js';
import { DEFAULT_ALERT_POLICY } from './governance/alerts.js';
import { DEFAULT_IDLE_BALANCE_POLICY } from './organizations.js';
import { DEFAULT_PLATFORM_FEE_BPS } from './payments/paymentService.js';
import { DEFAULT_PAYOUT_POLICY } from './payouts/payoutService.js';
import routes from './routes/index.js';
import { createService, type StripeConfig } from './service.js';
import { StripeSdkGateway } from './stripe/gateway.js';

const fastify = Fastify({
  logger: { redact: ['req.headers.authorization', 'req.headers.cookie', 'req.headers["stripe-signature"]'] },
})

const DAY_MS = 1000 * 60 * 60 * 24;

/** An integer env var within [min, max], or `fallback` when unset or empty. Exits on an invalid value. */
function integer(name: string, fallback: number, min: number, max = Number.MAX_SAFE_INTEGER): number {
  const value = Number(process.env[name] || fallback);
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    fastify.log.error(`${name} must be an integer from ${min} to ${max}`);
    process.exit(1);
  }
  return value;
}

const platformFeeBps = integer('PLATFORM_FEE_BPS', DEFAULT_PLATFORM_FEE_BPS, 0, 10_000);
const dashboardUrl = (process.env.DASHBOARD_URL ?? 'https://platform.stellarium.sh').replace(/\/$/, '');

// Stripe is optional so a local stack can run on promotional credit alone.
let stripe: StripeConfig | undefined;
if (process.env.STRIPE_SECRET_KEY) {
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
  const connectWebhookSecret = process.env.STRIPE_CONNECT_WEBHOOK_SECRET;
  if (!webhookSecret || !connectWebhookSecret) {
    fastify.log.error('STRIPE_WEBHOOK_SECRET and STRIPE_CONNECT_WEBHOOK_SECRET are required with STRIPE_SECRET_KEY');
    process.exit(1);
  }
  stripe = {
    gateway: new StripeSdkGateway(process.env.STRIPE_SECRET_KEY),
    webhookSecret,
    connectWebhookSecret,
    billing: {
      dashboardUrl,
      minimumTopUpCents: integer('MIN_TOP_UP_CENTS', DEFAULT_MINIMUM_TOP_UP_CENTS, 50),
      maximumTopUpCents: integer('MAX_TOP_UP_CENTS', DEFAULT_MAXIMUM_TOP_UP_CENTS, 50),
    },
    payouts: {
      holdMs: integer('PAYOUT_HOLD_DAYS', DEFAULT_PAYOUT_POLICY.holdMs / DAY_MS, 0) * DAY_MS,
      intervalMs: integer('PAYOUT_INTERVAL_DAYS', DEFAULT_PAYOUT_POLICY.intervalMs / DAY_MS, 0) * DAY_MS,
      minimumMicroUsd: integer('PAYOUT_MIN_MICRO_USD', DEFAULT_PAYOUT_POLICY.minimumMicroUsd, 10_000),
    },
  };
} else {
  fastify.log.warn('STRIPE_SECRET_KEY is not set: top-ups, payout onboarding and payouts are disabled');
}

// Dashboard sign-in and the dashboard API need a secret for session cookies.
let auth: AuthConfig | undefined;
if (process.env.BETTER_AUTH_SECRET) {
  if (process.env.BETTER_AUTH_SECRET.length < 32) {
    fastify.log.error('BETTER_AUTH_SECRET must be at least 32 characters');
    process.exit(1);
  }
  const { RESEND_API_KEY, EMAIL_FROM, GITHUB_CLIENT_ID, GITHUB_CLIENT_SECRET } = process.env;
  if (RESEND_API_KEY && !EMAIL_FROM) {
    fastify.log.error('EMAIL_FROM is required with RESEND_API_KEY');
    process.exit(1);
  }
  if (!RESEND_API_KEY) fastify.log.warn('RESEND_API_KEY is not set: verification, password reset and invitation emails are logged instead of sent');
  const skipEmailVerification = process.env.SKIP_EMAIL_VERIFICATION === '1';
  if (skipEmailVerification) fastify.log.warn('SKIP_EMAIL_VERIFICATION=1: new users are signed in without verifying their email. Local development only');
  auth = {
    secret: process.env.BETTER_AUTH_SECRET,
    dashboardUrl,
    mailer: RESEND_API_KEY ? new ResendMailer(RESEND_API_KEY, EMAIL_FROM!, fastify.log) : new LogMailer(fastify.log),
    github: GITHUB_CLIENT_ID && GITHUB_CLIENT_SECRET ? { clientId: GITHUB_CLIENT_ID, clientSecret: GITHUB_CLIENT_SECRET } : undefined,
    skipEmailVerification,
  };
} else {
  fastify.log.warn('BETTER_AUTH_SECRET is not set: dashboard sign-in and the dashboard API are disabled');
}

const db = drizzle(process.env.DATABASE_URL!);
const migrationsFolder = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../drizzle');
try {
  await migrate(db, { migrationsFolder });
} catch (error) {
  fastify.log.error(error);
  process.exit(1);
}
fastify.log.info('Applied database migrations');
// API clients' run tokens are signed with this key, and nodes verify them against /v1/.well-known/jwks.json.
const runTokenPrivateKey = process.env.RUN_TOKEN_PRIVATE_KEY || undefined;
if (!runTokenPrivateKey) fastify.log.warn('RUN_TOKEN_PRIVATE_KEY is not set: API clients can\'t get run tokens');
// The dashboard's server sends this with the Composer turns it charges for.
const dashboardServiceSecret = process.env.DASHBOARD_SERVICE_SECRET || undefined;
if (!dashboardServiceSecret) fastify.log.warn('DASHBOARD_SERVICE_SECRET is not set: the dashboard\'s Composer is disabled');
const composer = {
  rates: {
    inputMicroUsdPerMillionTokens: integer('COMPOSER_INPUT_MICRO_USD_PER_MILLION_TOKENS', DEFAULT_COMPOSER_POLICY.rates.inputMicroUsdPerMillionTokens, 0),
    cacheReadMicroUsdPerMillionTokens: integer('COMPOSER_CACHE_READ_MICRO_USD_PER_MILLION_TOKENS', DEFAULT_COMPOSER_POLICY.rates.cacheReadMicroUsdPerMillionTokens, 0),
    outputMicroUsdPerMillionTokens: integer('COMPOSER_OUTPUT_MICRO_USD_PER_MILLION_TOKENS', DEFAULT_COMPOSER_POLICY.rates.outputMicroUsdPerMillionTokens, 0),
  },
  turnHoldMicroUsd: integer('COMPOSER_TURN_HOLD_MICRO_USD', DEFAULT_COMPOSER_POLICY.turnHoldMicroUsd, 1),
};
// The dashboard warns organizations whose card top-ups sit unspent, which Stripe's risk checks flag.
const idleBalance = {
  ageMs: integer('IDLE_BALANCE_DAYS', DEFAULT_IDLE_BALANCE_POLICY.ageMs / DAY_MS, 1) * DAY_MS,
  warningMicroUsd: integer('IDLE_BALANCE_WARNING_MICRO_USD', DEFAULT_IDLE_BALANCE_POLICY.warningMicroUsd, 1),
};
// Money in contracts (docs/money.md). Stripe's risk checks look at how long a charge waits before it's paid out.
const money = {
  maxFundingSourceAgeMs: integer('MAX_FUNDING_SOURCE_AGE_DAYS', DEFAULT_MONEY_POLICY.maxFundingSourceAgeMs / DAY_MS, 1) * DAY_MS,
  maxContractHoldMs: integer('MAX_CONTRACT_HOLD_DAYS', DEFAULT_MONEY_POLICY.maxContractHoldMs / DAY_MS, 1, MAX_CONTRACT_HOLD_LIMIT_MS / DAY_MS) * DAY_MS,
  childReceiptDeadlineMs: integer('CHILD_RECEIPT_DEADLINE_MS', DEFAULT_MONEY_POLICY.childReceiptDeadlineMs, 1_000),
  // Trees moving less are applied first and verified within the payout hold. 0 verifies every tree first.
  optimisticVerifyLimitMicroUsd: integer('OPTIMISTIC_VERIFY_LIMIT_MICRO_USD', DEFAULT_MONEY_POLICY.optimisticVerifyLimitMicroUsd, 0),
  maxUnverifiedMicroUsdPerNode: integer('MAX_UNVERIFIED_MICRO_USD_PER_NODE', DEFAULT_MONEY_POLICY.maxUnverifiedMicroUsdPerNode, 0),
  // Card-fraud limits (docs/money.md, Card fraud): what a payer may attach, and when its identity must be verified.
  maxPendingMoneyRunsPerContract: integer('MAX_PENDING_MONEY_RUNS_PER_CONTRACT', DEFAULT_MONEY_POLICY.maxPendingMoneyRunsPerContract, 1),
  maxPendingMoneyRunsPerPayer: integer('MAX_PENDING_MONEY_RUNS_PER_PAYER', DEFAULT_MONEY_POLICY.maxPendingMoneyRunsPerPayer, 1),
  attachLimitBaseMicroUsd: integer('ATTACH_LIMIT_BASE_MICRO_USD', DEFAULT_MONEY_POLICY.attachLimitBaseMicroUsd, 0),
  attachWindowMs: integer('ATTACH_WINDOW_DAYS', DEFAULT_MONEY_POLICY.attachWindowMs / DAY_MS, 1) * DAY_MS,
  payerKycThresholdMicroUsd: integer('PAYER_KYC_THRESHOLD_MICRO_USD', DEFAULT_MONEY_POLICY.payerKycThresholdMicroUsd, 0),
};
// Verified runs and governance (docs/money.md). Without staff keys the staff API is off.
const receiptDeadlineMs = integer('RECEIPT_DEADLINE_MS', 10 * 60 * 1000, 1_000);
const checkpointIntervalMs = integer('CHECKPOINT_INTERVAL_MS', 60 * 60 * 1000, 60_000);
// Alerts for staff about what nodes' contracts do with money.
const alerts = {
  selfPaymentMicroUsd: integer('SELF_PAYMENT_ALERT_MICRO_USD', DEFAULT_ALERT_POLICY.selfPaymentMicroUsd, 0),
  outflowJumpMinMicroUsd: integer('OUTFLOW_JUMP_ALERT_MICRO_USD', DEFAULT_ALERT_POLICY.outflowJumpMinMicroUsd, 0),
};
const service = createService(db, { platformFeeBps, stripe, auth, runTokenPrivateKey, composer, dashboardServiceSecret, idleBalance, money, receiptDeadlineMs, alerts, staffApiKeys: process.env.STAFF_API_KEYS });
if (service.staff.size === 0) {
  fastify.log.warn('STAFF_API_KEYS is not set: verification reviews, bans and appeals can\'t be decided');
}

// Applies to every operator route. Limits are per client IP.
await fastify.register(rateLimit, {
  max: Number(process.env.RATE_LIMIT_MAX ?? 100),
  timeWindow: process.env.RATE_LIMIT_TIME_WINDOW ?? '1 minute',
});
// Only the dashboard calls the operator from a browser.
await fastify.register(cors, { origin: dashboardUrl, methods: ['GET', 'POST', 'PATCH', 'DELETE'] });
fastify.register(routes, { prefix: '/v1', service });

// Releases holds that providers never captured or released, then retries and runs payouts. One pass at a time.
const maintenanceIntervalMs = Number(process.env.MAINTENANCE_INTERVAL_MS ?? 30_000);
let running = false;
const maintenanceTimer = setInterval(async () => {
  if (running) return;
  running = true;
  try {
    const released = await service.payments.releaseExpiredHolds();
    if (released > 0) fastify.log.info({ released }, 'Released expired holds');
    const releasedRuns = await service.runs.releaseExpiredRuns();
    if (releasedRuns > 0) fastify.log.info({ releasedRuns }, 'Released expired runs');
    const settledTrees = await service.money.settleTrees();
    if (settledTrees > 0) fastify.log.info({ settledTrees }, 'Settled run trees');
    const expiredFunding = await service.money.refundExpired();
    if (expiredFunding > 0) fastify.log.info({ expiredFunding }, 'Refunded contract funding past its time limit');
    const raised = await service.alerts.check();
    for (const alert of raised) fastify.log.warn({ alert }, 'Raised an alert for staff');
    await service.notifications.deliverDue();
    const matched = await service.governance.screenSanctions();
    if (matched > 0) fastify.log.warn({ matched }, 'Blocked organizations matching a sanctions list');
    const verifiedTrees = await service.verification.verifyTrees();
    if (verifiedTrees > 0) fastify.log.info({ verifiedTrees }, 'Verified run trees');
    if (service.runTokens && await service.governance.checkpointDue(checkpointIntervalMs)) {
      const checkpoint = await service.governance.checkpoint();
      fastify.log.info({ checkpoint: checkpoint.hash }, 'Published a signed checkpoint');
    }
    const releasedTurns = await service.composer.releaseExpired();
    if (releasedTurns > 0) fastify.log.info({ releasedTurns }, 'Released expired Composer turns');
    if (service.payouts) {
      const { stale, ...retried } = await service.payouts.reconcilePending();
      if (retried.paid + retried.failed > 0) fastify.log.info(retried, 'Retried pending payouts');
      // Past Stripe's idempotency window a retry could pay twice, so these need a person.
      for (const payout of stale) fastify.log.error({ payoutId: payout.id }, 'Payout has been pending too long to retry safely; check Stripe for its transfer');
      const ran = await service.payouts.runPayouts();
      if (ran.paid + ran.failed + ran.pending > 0) fastify.log.info(ran, 'Ran payouts');
    }
  } catch (error) {
    fastify.log.error(error, 'Maintenance failed');
  } finally {
    running = false;
  }
}, maintenanceIntervalMs);
maintenanceTimer.unref();
fastify.addHook('onClose', async () => clearInterval(maintenanceTimer));

fastify.listen({ port: 3001, host: '0.0.0.0' }, function (err, address) {
  if (err) {
    fastify.log.error(err)
    process.exit(1)
  }

  fastify.log.info(`server listening on ${address}`)
})
