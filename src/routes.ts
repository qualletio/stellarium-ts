import type { FastifyPluginAsync } from 'fastify'
import type { Service } from './service.js';
import { interpretParsed, parseScript, type Resource, type ResourceFunction } from 'requestscript';
import { ResourceWithBaseUrl } from './resource/resource.js';

interface RouteOptions {
    service: Service;
}

/**
 * Encapsulates the routes
 * @param fastify Encapsulated Fastify Instance
 * @param options plugin options, refer to https://fastify.dev/docs/latest/Reference/Plugins/#plugin-options
 */
const routes: FastifyPluginAsync<RouteOptions> = async function (fastify, options) {

    // Start Meta Routes

    fastify.get('/', async (request, reply) => {
        return { hello: 'world' }
    });

    fastify.get('/peers', async (request, reply) => {
        const peers = await options.service.peerRepository.getPeerList();
        return { peers };
    });

    /**
     * Returns the list of resources that are available on the server.
     * Does not return resources that are external to the server.
     */
    fastify.get('/resources', async (request, reply) => {
        const resources = await options.service.resourceRepository.getAllResources();
        return {
            resources: resources.map((resource: ResourceWithBaseUrl) => ({
                path: resource.path,
                name: resource.name,
                functions: resource.functions.map((fn: ResourceFunction) => ({
                    name: fn.name,
                    returnType: fn.returnType,
                    parameters: fn.parameters,
                })),
                baseUrl: resource.baseUrl,
            })),
        }
    });

    // End Meta Routes

    // Start Run Routes

    fastify.post('/run', async (request, reply) => {
        const source: string = request.body as string;
        
        try {
            const script = parseScript(source);

            if (script.declaration.kind !== 'request') {
                return reply.status(400).send({ error: 'Invalid script' });
            }

            const result = await interpretParsed(script, { 
                resourceResolver: options.service.resourceResolver, 
                resourceInvoker: options.service.resourceInvoker
            });

            reply.status(200).send({ returnValue: result.returnValue ?? null });
        } catch (error) {
            reply.status(500).send({ error: 'Internal server error' });
        }
    });

    // End Run Routes
}

// ESM
export default routes;
