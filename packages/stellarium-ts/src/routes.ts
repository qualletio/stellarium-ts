import { createHash, timingSafeEqual } from 'node:crypto';
import rateLimit from '@fastify/rate-limit';
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { interpretParsed, parseScript } from 'requestscript';
import { Peer } from './peer/repository.js';
import { type InferencePaymentVoucher, inferenceVoucherPayload, invocationHash, isInferenceVoucher, PaymentVoucher, paymentVoucherPayload } from './resource/invoker.js';
import { inferenceCharge, type InferenceUsage, isInferenceFunction, isInferenceManifest, parseMaxTokens } from './resource/inference.js';
import { StellariumResource, StellariumResourceFunction, StellariumResourceFunctionPaymentManifest } from './resource/repository.js';
import type { Service } from './service.js';
import { safeVerifyData } from './crypto/utils.js';
import type { Grant, GrantRenewalRequest, GrantRequest } from './grant/grant.js';
import { InvalidPublicKeyError } from './grant/service.js';

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

interface ResourceCallRequest {
    resourcePath: string;
    resourceName: string;
    functionName: string;
    parameters: ResourceRequestFunctionCallParameter[];
    /** An `InvocationAuthorization`, checked by `GrantService.verifyInvocation`. */
    authorization?: unknown;
}

interface ResourceRunRequest extends ResourceCallRequest {
    paymentVoucher?: PaymentVoucher | InferencePaymentVoucher;
}

interface RunRequest {
    source: string;
}

// Body schemas check only the shape the handlers rely on. Signed payloads (resources) are
// left unvalidated inside, since coercing or stripping them would change the signed bytes.
const nonEmptyString = { type: 'string', minLength: 1 } as const;

const peerRequestSchema = {
    type: 'object',
    required: ['baseUrl', 'name', 'publicKey', 'signature', 'expiry'],
    properties: { baseUrl: nonEmptyString, name: nonEmptyString, publicKey: nonEmptyString, signature: nonEmptyString, expiry: nonEmptyString },
} as const;

const resourceRequestSchema = {
    type: 'object',
    required: ['publicKey', 'signature', 'expiry', 'resources'],
    properties: { publicKey: nonEmptyString, signature: nonEmptyString, expiry: nonEmptyString, resources: { type: 'array' } },
} as const;

export const DEFAULT_PAGE_SIZE = 100;
export const MAX_PAGE_SIZE = 500;

interface PageQuery {
    offset: number;
    limit: number;
}

const pageQuerySchema = {
    type: 'object',
    properties: {
        offset: { type: 'integer', minimum: 0, default: 0 },
        limit: { type: 'integer', minimum: 1, maximum: MAX_PAGE_SIZE, default: DEFAULT_PAGE_SIZE },
    },
} as const;

const revokeQuerySchema = {
    type: 'object',
    properties: {
        issuer: { type: 'string', minLength: 1 },
    },
} as const;

/**
 * Fetches one extra item to tell whether another page follows. `nextOffset` is null on the last page.
 */
async function getPage<T>(query: PageQuery, fetchPage: (offset: number, limit: number) => Promise<T[]>): Promise<{ items: T[], nextOffset: number | null }> {
    const { offset, limit } = query;
    const items = await fetchPage(offset, limit + 1);
    return {
        items: items.slice(0, limit),
        nextOffset: items.length > limit ? offset + limit : null,
    };
}

const runRequestSchema = {
    type: 'object',
    required: ['source'],
    properties: { source: { type: 'string' } },
} as const;

const resourceCallProperties = {
    resourcePath: { type: 'string' },
    resourceName: { type: 'string' },
    functionName: { type: 'string' },
    parameters: {
        type: 'array',
        items: { type: 'object', required: ['name'], properties: { name: { type: 'string' } } },
    },
    // Shape only: the grants inside are signed, so coercing them would change the signed bytes.
    authorization: { type: 'object' },
} as const;

const fixedVoucherSchema = {
    type: 'object',
    required: ['requestId', 'invocationId', 'amount', 'recipientAddress', 'signature', 'expiresAt', 'invocationHash', 'publicKey'],
    properties: {
        requestId: { type: 'string' },
        invocationId: { type: 'string' },
        amount: { type: 'integer' },
        recipientAddress: { type: 'string' },
        signature: { type: 'string' },
        expiresAt: { type: 'string' },
        invocationHash: { type: 'string' },
        publicKey: { type: 'string' },
    },
} as const;

const inferenceVoucherSchema = {
    type: 'object',
    required: ['kind', 'requestId', 'invocationId', 'maxAmount', 'inputCostMicroUsdcPerMillionTokens', 'outputCostMicroUsdcPerMillionTokens', 'maxTokens', 'recipientAddress', 'signature', 'expiresAt', 'invocationHash', 'publicKey'],
    properties: {
        kind: { const: 'inference' },
        requestId: { type: 'string' },
        invocationId: { type: 'string' },
        maxAmount: { type: 'integer', minimum: 0 },
        inputCostMicroUsdcPerMillionTokens: { type: 'integer', minimum: 0 },
        outputCostMicroUsdcPerMillionTokens: { type: 'integer', minimum: 0 },
        maxTokens: { type: 'integer', minimum: 1 },
        recipientAddress: { type: 'string' },
        signature: { type: 'string' },
        expiresAt: { type: 'string' },
        invocationHash: { type: 'string' },
        publicKey: { type: 'string' },
    },
} as const;

const resourceRunRequestSchema = {
    type: 'object',
    required: ['resourcePath', 'resourceName', 'functionName', 'parameters'],
    properties: {
        ...resourceCallProperties,
        // An inference voucher has `kind` and no `amount`, so at most one shape matches.
        paymentVoucher: { oneOf: [fixedVoucherSchema, inferenceVoucherSchema] },
    },
} as const;

const resourceEstimateRequestSchema = {
    type: 'object',
    required: ['resourcePath', 'resourceName', 'functionName', 'parameters'],
    properties: resourceCallProperties,
} as const;

const grantRenewalRequestSchema = {
    type: 'object',
    required: ['grantId', 'publicKey', 'nonce', 'expiresAt', 'signature'],
    properties: { grantId: nonEmptyString, publicKey: nonEmptyString, nonce: nonEmptyString, expiresAt: nonEmptyString, signature: nonEmptyString },
} as const;

// Capabilities and details are signed, so only their outer types are checked here.
const grantRequestSchema = {
    type: 'object',
    required: ['publicKey', 'capabilities', 'nonce', 'expiresAt', 'signature'],
    properties: {
        publicKey: nonEmptyString,
        capabilities: { type: 'array', minItems: 1 },
        details: { type: ['object', 'null'] },
        nonce: nonEmptyString,
        expiresAt: nonEmptyString,
        signature: nonEmptyString,
    },
} as const;

/** Constant-time comparison. Hashing first gives equal-length buffers for timingSafeEqual. */
function secretsEqual(a: string, b: string): boolean {
    const digest = (value: string) => createHash('sha256').update(value).digest();
    return timingSafeEqual(digest(a), digest(b));
}

/**
 * A voucher is valid when it is bound to this exact call, signed by its public key, unexpired,
 * and pays the function's recipient. A fixed voucher must pay at least the function's cost. An inference
 * voucher must be for an inference function, carry its rates, and sign the call's `maxTokens`.
 * Whether its `maxAmount` covers the call is checked separately, against the function's estimator.
 */
function isValidPaymentVoucher(voucher: PaymentVoucher | InferencePaymentVoucher, resourceFunction: StellariumResourceFunction, manifest: StellariumResourceFunctionPaymentManifest, request: ResourceRunRequest): boolean {
    const expectedHash = invocationHash(request.resourcePath, request.resourceName, request.functionName, request.parameters);
    if (voucher.invocationHash !== expectedHash) {
        return false;
    }
    if (voucher.recipientAddress !== manifest.recipientAddress) {
        return false;
    }
    const expiresAt = Date.parse(voucher.expiresAt);
    if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) {
        return false;
    }
    if (isInferenceVoucher(voucher)) {
        if (!isInferenceFunction(resourceFunction) || !isInferenceManifest(manifest)) {
            return false;
        }
        if (voucher.inputCostMicroUsdcPerMillionTokens !== manifest.inputCostMicroUsdcPerMillionTokens
            || voucher.outputCostMicroUsdcPerMillionTokens !== manifest.outputCostMicroUsdcPerMillionTokens) {
            return false;
        }
        if (voucher.maxTokens !== parseMaxTokens(request.parameters)) {
            return false;
        }
        return safeVerifyData(inferenceVoucherPayload(voucher), voucher.publicKey, voucher.signature);
    }
    if (isInferenceFunction(resourceFunction) || isInferenceManifest(manifest)) {
        return false;
    }
    if (voucher.amount < manifest.costMicroUsdc) {
        return false;
    }
    return safeVerifyData(paymentVoucherPayload(voucher), voucher.publicKey, voucher.signature);
}

/** The function's own input-token estimate, or undefined if its estimator failed or returned something other than a count. */
async function estimateInputTokens(resourceFunction: StellariumResourceFunction, request: ResourceCallRequest): Promise<number | undefined> {
    try {
        const inputTokens = await resourceFunction.estimateInputTokens?.(request.parameters);
        return Number.isSafeInteger(inputTokens) && inputTokens! >= 0 ? inputTokens : undefined;
    } catch {
        return undefined;
    }
}

/** What the operator will accrue for `usage`: its charge at the voucher's rates, capped at `maxAmount`. */
function cappedInferenceCharge(voucher: InferencePaymentVoucher, usage: InferenceUsage): number {
    try {
        return Math.min(inferenceCharge(voucher, usage.inputTokens, usage.outputTokens), voucher.maxAmount);
    } catch {
        // The charge isn't a safe integer, so it is over any maxAmount.
        return voucher.maxAmount;
    }
}

/**
 * Encapsulates the routes
 * @param fastify Encapsulated Fastify Instance
 * @param options plugin options, refer to https://fastify.dev/docs/latest/Reference/Plugins/#plugin-options
 */
const routes: FastifyPluginAsync<RouteOptions> = async (fastify, options) => {

    // Rate limiting is opt-in per route via `config.rateLimit`.
    await fastify.register(rateLimit, { global: false });

    /** Requires `Authorization: Bearer <API_KEY>`. Used by the routes only this node's operator may call. */
    const requireApiKey = async (request: FastifyRequest, reply: FastifyReply) => {
        // Check that the API Key matches the configured key
        const authorizationHeader = request.headers['authorization'];
        if (!authorizationHeader) {
            return reply.status(401).send({ error: 'Authorization header is required' });
        }
        const apiKey = authorizationHeader.split(' ')[1];
        // An unset API key must not match a header with no token.
        const expectedApiKey = options.service.config.apiKey;
        if (!expectedApiKey || !apiKey || !secretsEqual(apiKey, expectedApiKey)) {
            return reply.status(401).send({ error: 'Invalid API Key' });
        }
    };

    // Start Meta Routes

    fastify.get('/', async (request, reply) => {
        return {
            hello: 'world',
        }
    });

    fastify.get('/self', async (request, reply) => {
        const { baseUrl, publicKey } = options.service.config;
        return { baseUrl, publicKey, name: baseUrl };
    });

    fastify.get('/peers', { schema: { querystring: pageQuerySchema } }, async (request, reply) => {
        const { items: peers, nextOffset } = await getPage(request.query as PageQuery, (offset, limit) => options.service.peerRepository.getPeers(offset, limit));
        return { peers, nextOffset };
    });

    fastify.put('/peers', { schema: { body: peerRequestSchema } }, async (request, reply) => {
        const { baseUrl, name, publicKey, signature, expiry } = request.body as PeerRequest;
        const result = await options.service.peerRepository.announce({ baseUrl, name, publicKey }, signature, expiry);
        if (!result.ok) {
            return result.error === 'conflict'
                ? reply.status(409).send({ error: 'Base URL or name belongs to another peer' })
                : reply.status(400).send({ error: 'Invalid signature' });
        }
        return { success: true };
    });

    /**
     * Returns one page of the resources hosted on this node, followed by the resources it learned from peers.
     */
    fastify.get('/resources', { schema: { querystring: pageQuerySchema } }, async (request, reply) => {
        const { items: resources, nextOffset } = await getPage(request.query as PageQuery, (offset, limit) => options.service.resourceRepository.getResources(offset, limit));
        return {
            resources: resources.map((resource: StellariumResource) => ({
                path: resource.path,
                name: resource.name,
                website: resource.website,
                description: resource.description,
                functions: resource.functions.map((fn: StellariumResourceFunction) => ({
                    name: fn.name,
                    returnType: fn.returnType,
                    description: fn.description,
                    parameters: fn.parameters.map(parameter => ({
                        name: parameter.name,
                        type: parameter.type,
                        description: parameter.description,
                    })),
                    paymentManifest: !fn.paymentManifest ? undefined : isInferenceManifest(fn.paymentManifest) ? {
                        inputCostMicroUsdcPerMillionTokens: fn.paymentManifest.inputCostMicroUsdcPerMillionTokens,
                        outputCostMicroUsdcPerMillionTokens: fn.paymentManifest.outputCostMicroUsdcPerMillionTokens,
                        recipientAddress: fn.paymentManifest.recipientAddress,
                    } : {
                        costMicroUsdc: fn.paymentManifest.costMicroUsdc,
                        recipientAddress: fn.paymentManifest.recipientAddress,
                    },
                    restricted: fn.restricted || undefined,
                    kind: isInferenceFunction(fn) ? 'inference' : undefined,
                })),
                baseUrl: resource.baseUrl,
            })),
            nextOffset,
        };
    });

    fastify.put('/all-resources', { schema: { body: resourceRequestSchema } }, async (request, reply) => {
        const resourceRequest = request.body as ResourceRequest;
        
        const resources = resourceRequest.resources;

        const existingPeer = await options.service.peerRepository.getPeerByPublicKey(resourceRequest.publicKey);

        if (!existingPeer) {
            return reply.status(400).send({ error: 'Peer not found' });
        }

        const result = await options.service.resourceRepository.saveAll(resources, existingPeer, resourceRequest.signature, resourceRequest.expiry);
        if (!result.ok) {
            return reply.status(400).send({ error: 'Invalid signature' });
        }

        // Resources this peer may not publish (not served from its base URL, or owned elsewhere).
        return { success: true, rejected: result.rejected };
    });

    // End Meta Routes

    // Start Run Routes

    // Authenticate before body validation, so unauthenticated callers learn nothing about the schema.
    fastify.post('/run', { schema: { body: runRequestSchema }, preValidation: requireApiKey }, async (request, reply) => {
        const runRequest = request.body as RunRequest;

        let script: ReturnType<typeof parseScript>;
        try {
            script = parseScript(runRequest.source);
        } catch (error) {
            // A script that doesn't parse is the caller's mistake, not a server failure.
            return reply.status(400).send({ error: 'Invalid script', details: error instanceof Error ? error.message : undefined });
        }

        if (script.declaration.kind !== 'request') {
            return reply.status(400).send({ error: 'Invalid script' });
        }

        try {
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

    /**
     * Finds the local function a call names and checks its parameters and, for a restricted function,
     * its authorization. Sends the refusal and returns undefined if a check fails.
     */
    async function checkCall(resourceRequest: ResourceCallRequest, reply: FastifyReply): Promise<{ resource: StellariumResource, resourceFunction: StellariumResourceFunction } | undefined> {
        const resource = await options.service.resourceRepository.getInternalResource(resourceRequest.resourcePath, resourceRequest.resourceName);
        if (!resource) {
            reply.status(400).send({ error: 'Resource not found' });
            return undefined;
        }

        const resourceFunction = resource.functions.find(fn => fn.name === resourceRequest.functionName);
        if (!resourceFunction) {
            reply.status(400).send({ error: 'Function not found' });
            return undefined;
        }

        // Grant constraints and the function both read parameters by name, so each name must be
        // declared and appear once. Otherwise a duplicate or extra parameter could pass a
        // constraint check with one value and reach the function with another.
        const declared = new Set(resourceFunction.parameters.map(parameter => parameter.name));
        const names = resourceRequest.parameters.map(parameter => parameter.name);
        if (new Set(names).size !== names.length || !names.every(name => declared.has(name))) {
            reply.status(400).send({ error: 'Parameters must be declared by the function and appear once each' });
            return undefined;
        }

        // A restricted function is never run without a grant from this node. Checked before the
        // voucher, so an unauthorized caller never gets near settlement.
        if (resourceFunction.restricted) {
            // Tells a caller without a usable grant where it can ask for one.
            const grantEndpoint = options.service.grantService.acceptsRequests ? `${options.service.config.baseUrl}/v1/grants/request` : undefined;
            if (!resourceRequest.authorization) {
                reply.status(403).send({ error: 'Authorization is required', grantEndpoint });
                return undefined;
            }
            if (!await options.service.grantService.verifyInvocation(resourceRequest.authorization, resourceRequest)) {
                reply.status(403).send({ error: 'Invalid authorization', grantEndpoint });
                return undefined;
            }
        }

        return { resource, resourceFunction };
    }

    /**
     * Prices a call to a paid inference function before the caller signs its voucher: the function's
     * estimate of the input tokens, and `maxAmount`, the charge for those plus `maxTokens` output tokens.
     * Runs the provider's estimator, so a restricted function needs authorization here too.
     */
    fastify.post('/run/resource/estimate', {
        schema: { body: resourceEstimateRequestSchema },
        config: { rateLimit: options.rateLimit ?? { max: 100, timeWindow: '1 minute' } },
    }, async (request, reply) => {
        const resourceRequest = request.body as ResourceCallRequest;
        const call = await checkCall(resourceRequest, reply);
        if (!call) {
            return reply;
        }

        const { resourceFunction } = call;
        const manifest = resourceFunction.paymentManifest;
        if (!isInferenceFunction(resourceFunction) || !isInferenceManifest(manifest)) {
            return reply.status(400).send({ error: 'Function is not a paid inference function' });
        }
        const maxTokens = parseMaxTokens(resourceRequest.parameters);
        if (maxTokens === undefined) {
            return reply.status(400).send({ error: 'maxTokens must be a positive int32' });
        }
        const inputTokens = await estimateInputTokens(resourceFunction, resourceRequest);
        if (inputTokens === undefined) {
            return reply.status(500).send({ error: 'Failed to estimate input tokens' });
        }
        return { inputTokens, maxAmount: inferenceCharge(manifest, inputTokens, maxTokens) };
    });

    fastify.post('/run/resource', {
        schema: { body: resourceRunRequestSchema },
        config: { rateLimit: options.rateLimit ?? { max: 100, timeWindow: '1 minute' } },
    }, async (request, reply) => {
        const resourceRequest = request.body as ResourceRunRequest;
        const paymentVoucher = resourceRequest.paymentVoucher;

        const call = await checkCall(resourceRequest, reply);
        if (!call) {
            return reply;
        }
        const { resource, resourceFunction } = call;

        // Payment manifests are per function. A paid function is never run without a valid voucher.
        const paymentManifest = resourceFunction.paymentManifest;
        if (paymentManifest) {
            if (!paymentVoucher) {
                return reply.status(402).send({ error: 'Payment voucher is required' });
            }
            if (!isValidPaymentVoucher(paymentVoucher, resourceFunction, paymentManifest, resourceRequest)) {
                return reply.status(400).send({ error: 'Invalid payment voucher' });
            }
            if (await options.service.grantService.isBlocked(paymentVoucher.publicKey)) {
                return reply.status(403).send({ error: 'Caller is blocked' });
            }
            // Re-estimated here, so inference never runs on a voucher that can't cover the expected cost.
            if (isInferenceVoucher(paymentVoucher)) {
                const inputTokens = await estimateInputTokens(resourceFunction, resourceRequest);
                if (inputTokens === undefined) {
                    return reply.status(500).send({ error: 'Failed to estimate input tokens' });
                }
                const requiredMaxAmount = inferenceCharge(paymentVoucher, inputTokens, paymentVoucher.maxTokens);
                if (paymentVoucher.maxAmount < requiredMaxAmount) {
                    return reply.status(402).send({ error: `Payment voucher maxAmount ${paymentVoucher.maxAmount} is below the estimated ${requiredMaxAmount} micro-USDC`, requiredMaxAmount });
                }
            }
        }

        const result = await options.service.resourceInvoker.invoke(resource, resourceRequest.functionName, resourceRequest.parameters) as { value: unknown, error: { message: string } | null, usage?: InferenceUsage };

        let settlement: Parameters<typeof options.service.operatorClient.settlePayment>[0] | undefined;
        if (paymentManifest && paymentVoucher && !result.error) {
            if (!isInferenceVoucher(paymentVoucher)) {
                settlement = { voucher: paymentVoucher };
            } else if (result.usage) {
                // The function may report more output than it was allowed; the caller only signed for maxTokens.
                const usage = { inputTokens: result.usage.inputTokens, outputTokens: Math.min(result.usage.outputTokens, paymentVoucher.maxTokens) };
                result.usage = usage;
                // A free call has nothing to settle, and the operator refuses an empty receipt.
                if (cappedInferenceCharge(paymentVoucher, usage) > 0) {
                    settlement = { voucher: paymentVoucher, usage };
                }
            }
        }

        // Settle only verified vouchers, and only after a successful invoke. A voucher sent to a free function is ignored.
        // Run this on a separate thread to avoid blocking the main thread.
        if (settlement) {
            const payment = settlement;
            setTimeout(async () => {
                // Nothing awaits this callback, so an uncaught error here would be an unhandled rejection.
                try {
                    await options.service.operatorClient.settlePayment(payment);
                } catch (error) {
                    fastify.log.error(error, 'Failed to settle payment');
                }
            }, 0);
        }

        return result;
    });

    // End Run Routes

    // Start Grant Routes

    /** Issues a root grant to the request's signer, if the node's approval hook allows it. */
    fastify.post('/grants/request', {
        schema: { body: grantRequestSchema },
        config: { rateLimit: options.rateLimit ?? { max: 100, timeWindow: '1 minute' } },
    }, async (request, reply) => {
        if (!options.service.grantService.acceptsRequests) {
            return reply.status(403).send({ error: 'This node does not issue grants on request' });
        }
        let grants: Grant[] | undefined;
        try {
            grants = await options.service.grantService.handleRequest(request.body as GrantRequest);
        } catch (error) {
            // An approval hook that throws or returns an invalid approval is this node's fault, not the requester's.
            fastify.log.error(error, 'Failed to decide grant request');
            return reply.status(500).send({ error: 'Internal server error' });
        }
        if (!grants) {
            return reply.status(403).send({ error: 'Grant request refused' });
        }
        return { grants };
    });

    /** Re-issues a grant this node issued to the grant's audience, with a new expiry. */
    fastify.post('/grants/renew', {
        schema: { body: grantRenewalRequestSchema },
        config: { rateLimit: options.rateLimit ?? { max: 100, timeWindow: '1 minute' } },
    }, async (request, reply) => {
        const grants = await options.service.grantService.renew(request.body as GrantRenewalRequest);
        if (!grants) {
            return reply.status(403).send({ error: 'Grant renewal refused' });
        }
        return { grants };
    });

    // End Grant Routes

    // Start Admin Routes
    // Authenticated before validation, like /run, so unauthenticated callers learn nothing about the schema.

    /**
     * Revokes a grant: this node refuses it in any chain, with everything delegated from it, and
     * stops renewing it. Without `?issuer=`, the grant is one this node issued. With it, the grant
     * may be one delegated further down a chain, so it can be cut off too.
     */
    fastify.put('/admin/revoked-grants/:grantId', { preValidation: requireApiKey, schema: { querystring: revokeQuerySchema } }, async (request) => {
        const { grantId } = request.params as { grantId: string };
        const { issuer } = request.query as { issuer?: string };
        await options.service.grantService.revoke(issuer === undefined ? grantId : { issuer, id: grantId });
        return { success: true };
    });

    fastify.get('/admin/blocked-callers', { preValidation: requireApiKey, schema: { querystring: pageQuerySchema } }, async (request) => {
        const { items: callers, nextOffset } = await getPage(request.query as PageQuery, (offset, limit) => options.service.grantService.getBlocked(offset, limit));
        return { callers, nextOffset };
    });

    /** Blocks a caller key, with an optional `{ "reason" }` body. Unrestricted free functions stay open to it, since their callers are anonymous. */
    fastify.put('/admin/blocked-callers/:publicKey', { preValidation: requireApiKey }, async (request, reply) => {
        const { publicKey } = request.params as { publicKey: string };
        // The body is optional, so it is checked here rather than by a schema that would require one.
        const reason = (request.body as { reason?: unknown } | undefined)?.reason;
        if (reason !== undefined && typeof reason !== 'string') {
            return reply.status(400).send({ error: 'reason must be a string' });
        }
        try {
            await options.service.grantService.block(publicKey, reason);
        } catch (error) {
            if (error instanceof InvalidPublicKeyError) {
                return reply.status(400).send({ error: error.message });
            }
            throw error;
        }
        return { success: true };
    });

    fastify.delete('/admin/blocked-callers/:publicKey', { preValidation: requireApiKey }, async (request, reply) => {
        const { publicKey } = request.params as { publicKey: string };
        if (!await options.service.grantService.unblock(publicKey)) {
            return reply.status(404).send({ error: 'Caller is not blocked' });
        }
        return { success: true };
    });

    // End Admin Routes
};

// ESM
export default routes;
