import 'dotenv/config';
import { drizzle } from 'drizzle-orm/node-postgres';
import Fastify from 'fastify';
import routes from './routes.js';
import { createService } from './service.js';

const fastify = Fastify({
  logger: true
})

const db = drizzle(process.env.DATABASE_URL!);
const service = createService(db);

fastify.register(routes, { prefix: '/v1', service });

fastify.listen({ port: 3001 }, function (err, address) {
  if (err) {
    fastify.log.error(err)
    process.exit(1)
  }

  fastify.log.info(`server listening on ${address}`)
})
