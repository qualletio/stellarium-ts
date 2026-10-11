import 'dotenv/config';
import { FastifyInstance } from 'fastify';
import { createTables } from './db/db.js';
import { StellariumResource } from './resource/repository.js';
import routes from './routes.js';
import { createService } from './service.js';
import { StartupService } from './startup.js';

export interface StellariumNodeOptions {
    port?: number;
    startingPeer?: string;
}

export class StellariumNode {
    private resources: StellariumResource[] = [];

    async register(resource: StellariumResource): Promise<void> {
        this.resources.push(resource);
    }

    async start(fastify: FastifyInstance, options: StellariumNodeOptions): Promise<void> {;
        const service = createService(this.resources);

        await createTables();

        fastify.register(routes, { prefix: '/v1', service });

        // Run the server!
        fastify.listen({ port: options.port ?? 3000 }, function (err, address) {
            if (err) {
                fastify.log.error(err)
                process.exit(1)
            }

            if (options.startingPeer) {
                const startupService = new StartupService(
                    fastify.log,
                    service,
                    options.startingPeer,
                    process.env.BASE_URL!,
                    process.env.SIGNING_PUBLIC_KEY!,
                    process.env.SIGNING_PRIVATE_KEY!,
                );

                Promise.resolve(startupService.seedFromPeer()).catch(err => {
                    fastify.log.error(err);
                    process.exit(1);
                });
            }

            fastify.log.info(`server listening on ${address}`)
        })
    }
}
