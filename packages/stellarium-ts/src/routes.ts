import rateLimit from '@fastify/rate-limit';
import type { FastifyPluginAsync } from 'fastify';
import { interpretParsed, parseScript } from 'requestscript';
import { Peer } from './peer/repository.js';
import { invocationHash, PaymentVoucher, paymentVoucherPayload } from './resource/invoker.js';
import { StellariumResource, StellariumResourceFunction } from './resource/repository.js';
import type { Service } from './service.js';
import { verifyData } from './crypto/utils.js';

export interface RateLimitConfig {
    max: number;
    /** Milliseconds, or a string such as '1 minute'. */
    timeWindow: number | string;
}

interface RouteOptions {
    service: Service;
    rateLimit?: RateLimitConfig;
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

    // Rate limiting is opt-in per route via `config.rateLimit`.
    await fastify.register(rateLimit, { global: false });

    // Start Meta Routes

    fastify.get('/', async (request, reply) => {
        return {
            hello: 'world',
        }
    });

    fastify.get('/self', async (request, reply) => {
        return { 
            baseUrl: process.env.BASE_URL,
            publicKey: process.env.SIGNING_PUBLIC_KEY,
            name: process.env.BASE_URL,
         }
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
        
        // Check that the API Key matches the env variable
        const authorizationHeader = request.headers['authorization'];
        if (!authorizationHeader) {
            return reply.status(401).send({ error: 'Authorization header is required' });
        }
        const apiKey = authorizationHeader.split(' ')[1];
        if (apiKey !== process.env.API_KEY) {
            return reply.status(401).send({ error: 'Invalid API Key' });
        }
        
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
            fastify.log.error(error);
            reply.status(500).send({ error: 'Internal server error' });
        }
    });

    fastify.post('/run/resource', {
        config: { rateLimit: options.rateLimit ?? { max: 100, timeWindow: '1 minute' } },
    }, async (request, reply) => {
        const resourceRequest = request.body as ResourceRunRequest;
        const paymentVoucher = resourceRequest.paymentVoucher;

        const resource = await options.service.resourceRepository.getInternalResource(resourceRequest.resourcePath, resourceRequest.resourceName);
        if (!resource) {
            return reply.status(400).send({ error: 'Resource not found' });
        }

        if (paymentVoucher && resource.metadata.paymentManifest) {
            const expectedHash = invocationHash(resourceRequest.resourcePath, resourceRequest.resourceName, resourceRequest.functionName, resourceRequest.parameters);
            const isValid = paymentVoucher.invocationHash === expectedHash && verifyData(
                paymentVoucherPayload(paymentVoucher),
                paymentVoucher.publicKey,
                paymentVoucher.signature,
            );
            if (!isValid) {
                return reply.status(400).send({ error: 'Invalid payment voucher' });
            }
        }

        const result = await options.service.resourceInvoker.invoke(resource, resourceRequest.functionName, resourceRequest.parameters);

        // A voucher is optional. Settlement runs only after a successful invoke. Run this on a separate thread to avoid blocking the main thread.
        if (paymentVoucher) {
            setTimeout(async () => {
                // Nothing awaits this callback, so an uncaught error here would be an unhandled rejection.
                try {
                    await options.service.operatorClient.settlePayment({ voucher: paymentVoucher });
                } catch (error) {
                    fastify.log.error(error, 'Failed to settle payment');
                }
            }, 0);
        }

        return result;
    });

    // End Run Routes
};

// ESM
export default routes;
