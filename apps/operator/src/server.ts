import 'dotenv/config';
import { drizzle } from 'drizzle-orm/node-postgres';
import Fastify from 'fastify';
import routes from './routes.js';
import { createService } from './service.js';
import { Connection, Keypair, PublicKey } from '@solana/web3.js';

const fastify = Fastify({
  logger: { redact: ['req.headers.authorization'] },
  ajv: { customOptions: { removeAdditional: false, coerceTypes: false } }
})

const escrowProgramId = new PublicKey(process.env.ESCROW_PROGRAM_ID!);
const privateKey = Keypair.fromSecretKey(new Uint8Array(JSON.parse(process.env.PRIVATE_KEY!)));
const apiToken = process.env.OPERATOR_API_TOKEN;
if (!apiToken) throw new Error('OPERATOR_API_TOKEN is required');
const connection = new Connection(process.env.SOLANA_RPC_URL ?? 'https://api.devnet.solana.com', 'confirmed');

const db = drizzle(process.env.DATABASE_URL!);
const service = createService(db, escrowProgramId, privateKey, connection);

fastify.register(routes, { prefix: '/v1', service, apiToken });

fastify.listen({ port: 3001 }, function (err, address) {
  if (err) {
    fastify.log.error(err)
    process.exit(1)
  }

  fastify.log.info(`server listening on ${address}`)
})
