import type { FastifyPluginAsync } from 'fastify'
import type { Service } from './service.js';
import { interpretParsed, parseScript, type Resource, type ResourceFunction } from 'requestscript';
import { ResourceWithBaseUrl } from './resource/repository.js';
import { Peer } from './peer/repository.js';
import { verifyData } from './crypto/utils.js';

interface RouteOptions {
    service: Service;
}

interface PeerRequest extends Peer {
    signature: string;
}

interface ResourceRequest {
    publicKey: string;
    signature: string;
    resources: ResourceWithBaseUrl[];
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

    fastify.put('/peers', async (request, reply) => {
        const peer = request.body as PeerRequest;
        await options.service.peerRepository.createIfNotExists(peer, peer.signature);
        return { success: true };
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

    fastify.put('/all-resources', async (request, reply) => {
        const resourceRequest = request.body as ResourceRequest;
        
        const resources = resourceRequest.resources;

        const existingPeer = await options.service.peerRepository.getPeerByPublicKey(resourceRequest.publicKey);

        if (!existingPeer) {
            return reply.status(400).send({ error: 'Peer not found' });
        }

        const success = await options.service.resourceRepository.saveAll(resources, existingPeer, resourceRequest.signature);
        if (!success) {
            return reply.status(400).send({ error: 'Invalid signature' });
        }

        return { success: true };
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
