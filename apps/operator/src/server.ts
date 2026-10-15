import 'dotenv/config';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Connection, Keypair, PublicKey } from '@solana/web3.js';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
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

fastify.register(routes, { prefix: '/v1', service });

fastify.listen({ port: 3001, host: '0.0.0.0' }, function (err, address) {
  if (err) {
    fastify.log.error(err)
    process.exit(1)
  }

  fastify.log.info(`server listening on ${address}`)
})
