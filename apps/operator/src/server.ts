import 'dotenv/config';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Connection, Keypair, PublicKey } from '@solana/web3.js';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import rateLimit from '@fastify/rate-limit';
import Fastify from 'fastify';
import routes from './routes.js';
import { createService } from './service.js';

const fastify = Fastify({
  logger: { redact: ['req.headers.authorization'] },
})

const escrowProgramId = new PublicKey(process.env.ESCROW_PROGRAM_ID!);
const protocolFeeRecipient = new PublicKey(process.env.PROTOCOL_FEE_RECIPIENT!);
const privateKey = Keypair.fromSecretKey(new Uint8Array(JSON.parse(process.env.PRIVATE_KEY!)));
fastify.log.info(`Loaded authority account: ${privateKey.publicKey.toBase58()}`);
const connection = new Connection(process.env.SOLANA_RPC_URL ?? 'http://localhost:8899', 'confirmed');

const db = drizzle(process.env.DATABASE_URL!);
const migrationsFolder = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../drizzle');
try {
  await migrate(db, { migrationsFolder });
} catch (error) {
  fastify.log.error(error);
  process.exit(1);
}
fastify.log.info('Applied database migrations');
const service = createService(db, escrowProgramId, privateKey, protocolFeeRecipient, connection);

// Applies to every operator route. Limits are per client IP.
await fastify.register(rateLimit, {
  max: Number(process.env.RATE_LIMIT_MAX ?? 100),
  timeWindow: process.env.RATE_LIMIT_TIME_WINDOW ?? '1 minute',
});
if (!process.env.OPERATOR_API_TOKEN) {
  fastify.log.warn('OPERATOR_API_TOKEN is not set: POST /v1/escrow will reject every request');
}
fastify.register(routes, { prefix: '/v1', service, apiToken: process.env.OPERATOR_API_TOKEN });

// Resolve receipts left pending or unconfirmed. Runs one pass at a time.
const reconcileIntervalMs = Number(process.env.RECONCILE_INTERVAL_MS ?? 30_000);
let reconciling = false;
const reconcileTimer = setInterval(async () => {
  if (reconciling) return;
  reconciling = true;
  try {
    const summary = await service.escrowService.reconcile();
    if (summary.checked > 0) fastify.log.info(summary, 'Reconciled receipts');
  } catch (error) {
    fastify.log.error(error, 'Failed to reconcile receipts');
  } finally {
    reconciling = false;
  }
}, reconcileIntervalMs);
reconcileTimer.unref();
fastify.addHook('onClose', async () => clearInterval(reconcileTimer));

fastify.listen({ port: 3001, host: '0.0.0.0' }, function (err, address) {
  if (err) {
    fastify.log.error(err)
    process.exit(1)
  }

  fastify.log.info(`server listening on ${address}`)
})
