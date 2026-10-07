import 'dotenv/config';
import Fastify, { FastifyInstance } from 'fastify';
import routes from './routes.js';
import { createService } from './service.js';
import { StartupService } from './startup.js';
import { Resource } from 'requestscript';
import { createTables } from './db/db.js';

export interface StellariumNodeOptions {
    baseUrl: string;
    port?: number;
    startingPeer?: string;
}

export class StellariumNode {
    private resources: Resource[] = [];

    async register(resource: Resource): Promise<void> {
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
                const startupService = new StartupService(fastify.log, service, options.startingPeer, options.baseUrl);

                Promise.resolve(startupService.seedFromPeer()).catch(err => {
                    fastify.log.error(err);
                    process.exit(1);
                });
            }

            fastify.log.info(`server listening on ${address}`)
        })
    }
}
