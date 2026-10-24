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
  auth = {
    secret: process.env.BETTER_AUTH_SECRET,
    dashboardUrl,
    mailer: RESEND_API_KEY ? new ResendMailer(RESEND_API_KEY, EMAIL_FROM!, fastify.log) : new LogMailer(fastify.log),
    github: GITHUB_CLIENT_ID && GITHUB_CLIENT_SECRET ? { clientId: GITHUB_CLIENT_ID, clientSecret: GITHUB_CLIENT_SECRET } : undefined,
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
const service = createService(db, { platformFeeBps, stripe, auth, runTokenPrivateKey });

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
