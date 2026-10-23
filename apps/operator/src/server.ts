import 'dotenv/config';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import rateLimit from '@fastify/rate-limit';
import Fastify from 'fastify';
import { DEFAULT_PLATFORM_FEE_BPS } from './payments/paymentService.js';
import routes from './routes/index.js';
import { createService } from './service.js';

const fastify = Fastify({
  logger: { redact: ['req.headers.authorization'] },
})

const platformFeeBps = Number(process.env.PLATFORM_FEE_BPS ?? DEFAULT_PLATFORM_FEE_BPS);
if (!Number.isInteger(platformFeeBps) || platformFeeBps < 0 || platformFeeBps > 10_000) {
  fastify.log.error('PLATFORM_FEE_BPS must be an integer from 0 to 10000');
  process.exit(1);
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
const service = createService(db, { platformFeeBps });

// Applies to every operator route. Limits are per client IP.
await fastify.register(rateLimit, {
  max: Number(process.env.RATE_LIMIT_MAX ?? 100),
  timeWindow: process.env.RATE_LIMIT_TIME_WINDOW ?? '1 minute',
});
fastify.register(routes, { prefix: '/v1', service });

// Releases holds that providers never captured or released. Runs one pass at a time.
const maintenanceIntervalMs = Number(process.env.MAINTENANCE_INTERVAL_MS ?? 30_000);
let running = false;
const maintenanceTimer = setInterval(async () => {
  if (running) return;
  running = true;
  try {
    const released = await service.payments.releaseExpiredHolds();
    if (released > 0) fastify.log.info({ released }, 'Released expired holds');
  } catch (error) {
    fastify.log.error(error, 'Failed to release expired holds');
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
