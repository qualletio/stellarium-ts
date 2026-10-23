import 'dotenv/config';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import Fastify from 'fastify';
import { ClerkAuthenticator } from './auth/clerk.js';
import { DEFAULT_MAXIMUM_TOP_UP_CENTS, DEFAULT_MINIMUM_TOP_UP_CENTS } from './billing/billingService.js';
import { DEFAULT_PLATFORM_FEE_BPS } from './payments/paymentService.js';
import { DEFAULT_PAYOUT_POLICY } from './payouts/payoutService.js';
import routes from './routes/index.js';
import { createService, type StripeConfig } from './service.js';
import { StripeSdkGateway } from './stripe/gateway.js';

const fastify = Fastify({
  logger: { redact: ['req.headers.authorization', 'req.headers["stripe-signature"]'] },
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

const dashboardAuthenticator = process.env.CLERK_SECRET_KEY
  ? new ClerkAuthenticator({ secretKey: process.env.CLERK_SECRET_KEY, jwtKey: process.env.CLERK_JWT_KEY, authorizedParties: [dashboardUrl] })
  : undefined;
if (!dashboardAuthenticator) fastify.log.warn('CLERK_SECRET_KEY is not set: the dashboard API is disabled');

const db = drizzle(process.env.DATABASE_URL!);
const migrationsFolder = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../drizzle');
try {
  await migrate(db, { migrationsFolder });
} catch (error) {
  fastify.log.error(error);
  process.exit(1);
}
fastify.log.info('Applied database migrations');
const service = createService(db, { platformFeeBps, stripe, dashboardAuthenticator });

// Applies to every operator route. Limits are per client IP.
await fastify.register(rateLimit, {
  max: Number(process.env.RATE_LIMIT_MAX ?? 100),
  timeWindow: process.env.RATE_LIMIT_TIME_WINDOW ?? '1 minute',
});
// Only the dashboard calls the operator from a browser.
await fastify.register(cors, { origin: dashboardUrl, methods: ['GET', 'POST', 'DELETE'] });
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
