import type { FastifyPluginAsync } from 'fastify';
import { interpretParsed, parseScript } from 'requestscript';
import { Peer } from './peer/repository.js';
import { PaymentVoucher } from './resource/invoker.js';
import { StellariumResource, StellariumResourceFunction } from './resource/repository.js';
import type { Service } from './service.js';
import { verifyData } from './crypto/utils.js';

interface RouteOptions {
    service: Service;
}

interface PeerRequest extends Peer {
    signature: string;
    expiry: string;
}

interface ResourceRequest {
    publicKey: string;
    signature: string;
    resources: StellariumResource[];
    expiry: string;
}

interface ResourceRequestFunctionCallParameter {
    name: string;
    value: unknown;
}

interface ResourceRunRequest {
    resourcePath: string;
    resourceName: string;
    functionName: string;
    parameters: ResourceRequestFunctionCallParameter[];
    paymentVoucher?: PaymentVoucher;
}

interface RunRequest {
    source: string;
}

/**
 * Encapsulates the routes
 * @param fastify Encapsulated Fastify Instance
 * @param options plugin options, refer to https://fastify.dev/docs/latest/Reference/Plugins/#plugin-options
 */
const routes: FastifyPluginAsync<RouteOptions> = async (fastify, options) => {

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
        await options.service.peerRepository.createIfNotExists(peer, peer.signature, peer.expiry);
        return { success: true };
    });

    /**
     * Returns the list of resources that are available on the server.
     * Does not return resources that are external to the server.
     */
    fastify.get('/resources', async (request, reply) => {
        const resources = await options.service.resourceRepository.getAllResources();
        return {
            resources: resources.map((resource: StellariumResource) => ({
                path: resource.path,
                name: resource.name,
                functions: resource.functions.map((fn: StellariumResourceFunction) => ({
                    name: fn.name,
                    returnType: fn.returnType,
                    parameters: fn.parameters,
                    paymentManifest: fn.paymentManifest ? ({
                        costLamports: fn.paymentManifest.costLamports,
                        recipientAddress: fn.paymentManifest.recipientAddress,
                    }) : undefined,
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

        const success = await options.service.resourceRepository.saveAll(resources, existingPeer, resourceRequest.signature, resourceRequest.expiry);
        if (!success) {
            return reply.status(400).send({ error: 'Invalid signature' });
        }

        return { success: true };
    });

    // End Meta Routes

    // Start Run Routes

    fastify.post('/run', async (request, reply) => {
        const runRequest = request.body as RunRequest;
        
        try {
            const script = parseScript(runRequest.source);

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

    fastify.post('/run/resource', async (request, reply) => {
        const resourceRequest = request.body as ResourceRunRequest;
        
        if (resourceRequest.paymentVoucher) {
            const paymentVoucher = resourceRequest.paymentVoucher;
            const isValid = verifyData(paymentVoucher, paymentVoucher.publicKey, paymentVoucher.signature);
            if (!isValid) {
                return reply.status(400).send({ error: 'Invalid payment voucher' });
            }
        }
        const resource = await options.service.resourceRepository.getInternalResource(resourceRequest.resourcePath, resourceRequest.resourceName);
        if (!resource) {
            return reply.status(400).send({ error: 'Resource not found' });
        }

        const result = await options.service.resourceInvoker.invoke(resource, resourceRequest.functionName, resourceRequest.parameters);

        return { returnValue: result };
    });

    // End Run Routes
};

// ESM
export default routes;
