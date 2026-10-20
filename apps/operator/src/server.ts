import 'dotenv/config';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Connection, Keypair, PublicKey } from '@solana/web3.js';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import rateLimit from '@fastify/rate-limit';
import Fastify from 'fastify';
import { DEFAULT_SETTLEMENT_FEE_MULTIPLE } from './escrow/escrowService.js';
import routes from './routes.js';
import { createService } from './service.js';

const fastify = Fastify({
  logger: { redact: ['req.headers.authorization'] },
})

const escrowProgramId = new PublicKey(process.env.ESCROW_PROGRAM_ID!);
const protocolFeeRecipient = new PublicKey(process.env.PROTOCOL_FEE_RECIPIENT!);
// Must equal the escrow program's USDC_MINT.
const usdcMint = new PublicKey(process.env.USDC_MINT!);
const privateKey = Keypair.fromSecretKey(new Uint8Array(JSON.parse(process.env.PRIVATE_KEY!)));
fastify.log.info(`Loaded authority account: ${privateKey.publicKey.toBase58()}`);
const connection = new Connection(process.env.SOLANA_RPC_URL ?? 'http://localhost:8899', 'confirmed');

// Prices settlement transaction fees in USDC, which decides when accrued receipts are worth paying out.
const solPriceUsdc = Number(process.env.SOL_PRICE_USDC);
if (!Number.isFinite(solPriceUsdc) || solPriceUsdc <= 0) {
  fastify.log.error('SOL_PRICE_USDC must be set to the price of one SOL in USDC, for example 150');
  process.exit(1);
}
const settlementPolicy = {
  solPriceMicroUsdc: BigInt(Math.round(solPriceUsdc * 1_000_000)),
  feeMultiple: DEFAULT_SETTLEMENT_FEE_MULTIPLE,
};

const db = drizzle(process.env.DATABASE_URL!);
const migrationsFolder = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../drizzle');
try {
  await migrate(db, { migrationsFolder });
} catch (error) {
  fastify.log.error(error);
  process.exit(1);
}
fastify.log.info('Applied database migrations');
const service = createService(db, escrowProgramId, privateKey, protocolFeeRecipient, usdcMint, connection, settlementPolicy);

// Applies to every operator route. Limits are per client IP.
await fastify.register(rateLimit, {
  max: Number(process.env.RATE_LIMIT_MAX ?? 100),
  timeWindow: process.env.RATE_LIMIT_TIME_WINDOW ?? '1 minute',
});
if (!process.env.OPERATOR_API_TOKEN) {
  fastify.log.warn('OPERATOR_API_TOKEN is not set: POST /v1/escrow will reject every request');
}
fastify.register(routes, { prefix: '/v1', service, apiToken: process.env.OPERATOR_API_TOKEN });

// Resolve settlements left pending or unconfirmed, then pay out accrued receipts that are due.
// Reconciling first releases the receipts of failed and expired settlements to this pass. Runs one pass at a time.
const settleIntervalMs = Number(process.env.SETTLE_INTERVAL_MS ?? 30_000);
let settling = false;
const settleTimer = setInterval(async () => {
  if (settling) return;
  settling = true;
  try {
    const reconciled = await service.escrowService.reconcile();
    if (reconciled.checked > 0) fastify.log.info(reconciled, 'Reconciled settlements');
    const settled = await service.escrowService.settleDue();
    if (settled.sent > 0) fastify.log.info(settled, 'Settled accrued receipts');
    for (const failure of settled.failures) fastify.log.warn(failure, 'Failed to settle accrued receipts');
  } catch (error) {
    fastify.log.error(error, 'Failed to settle receipts');
  } finally {
    settling = false;
  }
}, settleIntervalMs);
settleTimer.unref();
fastify.addHook('onClose', async () => clearInterval(settleTimer));

fastify.listen({ port: 3001, host: '0.0.0.0' }, function (err, address) {
  if (err) {
    fastify.log.error(err)
    process.exit(1)
  }

  fastify.log.info(`server listening on ${address}`)
})
