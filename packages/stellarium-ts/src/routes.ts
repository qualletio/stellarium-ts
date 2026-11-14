import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import rateLimit from '@fastify/rate-limit';
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { decodeValue, interpretParsed, parseScript, RequestScriptError, type ResourceInvoker, TokenMeter, valueToJson } from 'requestscript';
import { looksLikeJwt, type RunTokenClaims } from './client/runTokens.js';
import { Peer } from './peer/repository.js';
import { type ContractPaymentVoucher, contractVoucherPayload, type InferencePaymentVoucher, inferenceVoucherPayload, invocationHash, isContractVoucher, isInferenceVoucher, MAX_CONTRACT_DEPTH, PaymentVoucher, paymentVoucherPayload } from './resource/invoker.js';
import { estimateInputTokens, inferenceCharge, isInferenceFunction, isInferenceManifest, parseMaxTokens } from './resource/inference.js';
import { type InvokeResult, settlePaidCall } from './resource/settlement.js';
import { MoneyRun } from './money/account.js';
import { isContractFunction, isContractManifest, StellariumResource, StellariumResourceFunction, StellariumResourceFunctionPaymentManifest } from './resource/repository.js';
import type { ContractCaller } from './contract/service.js';
import type { StoredContract } from './contract/repository.js';
import type { Service } from './service.js';
import { safeVerifyData } from './crypto/utils.js';
import type { Grant, GrantRenewalRequest, GrantRequest } from './grant/grant.js';
import { InvalidPublicKeyError } from './grant/service.js';
import type { EventAnnouncement, EventEnvelope, EventLineage } from './event/types.js';
import { MAX_EVENT_DEPTH } from './event/types.js';
import type { StructAnnouncement } from './struct/types.js';

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
    /** For a contract: the version the caller's script pinned, which the call runs. Absent means the latest. */
    resourceVersion?: string;
    paymentVoucher?: PaymentVoucher | InferencePaymentVoucher | ContractPaymentVoucher;
    /** For a contract: how many contracts deep the call is, so contracts calling each other across nodes stop. */
    contractDepth?: number;
    /** For a contract called from a script that an event started: the chain of events, so it can't call back into it. */
    eventLineage?: EventLineage;
    /** For a contract: money the caller attached, which it staged on the operator under this id. */
    attachmentId?: string;
    /** For a contract called by a contract: the calling one, whose owner the operator vouches for as `sender`. */
    senderContract?: { name: string, version: string };
    /** The call's place in the caller's run, for a signed answer: a tag only this provider sees, and an index. */
    attestation?: { runTag: string, callIndex: number };
}

interface RunRequest {
    source: string;
}

/**
 * Who is calling `POST /v1/run`: the holder of this node's API key, or an API client with a run token.
 * Set by the route's preValidation hook.
 */
type RunCaller = { kind: 'apiKey' } | ({ kind: 'client', token: string } & RunTokenClaims);

declare module 'fastify' {
    interface FastifyRequest {
        runCaller?: RunCaller;
    }
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
    required: ['requestId', 'invocationId', 'amount', 'recipientOrganizationId', 'signature', 'expiresAt', 'invocationHash', 'publicKey'],
    properties: {
        requestId: { type: 'string' },
        invocationId: { type: 'string' },
        amount: { type: 'integer' },
        recipientOrganizationId: { type: 'string' },
        signature: { type: 'string' },
        expiresAt: { type: 'string' },
        invocationHash: { type: 'string' },
        publicKey: { type: 'string' },
    },
} as const;

const inferenceVoucherSchema = {
    type: 'object',
    required: ['kind', 'requestId', 'invocationId', 'maxAmount', 'inputCostMicroUsdPerMillionTokens', 'outputCostMicroUsdPerMillionTokens', 'maxTokens', 'recipientOrganizationId', 'signature', 'expiresAt', 'invocationHash', 'publicKey'],
    properties: {
        kind: { const: 'inference' },
        requestId: { type: 'string' },
        invocationId: { type: 'string' },
        maxAmount: { type: 'integer', minimum: 0 },
        inputCostMicroUsdPerMillionTokens: { type: 'integer', minimum: 0 },
        outputCostMicroUsdPerMillionTokens: { type: 'integer', minimum: 0 },
        maxTokens: { type: 'integer', minimum: 1 },
        recipientOrganizationId: { type: 'string' },
        signature: { type: 'string' },
        expiresAt: { type: 'string' },
        invocationHash: { type: 'string' },
        publicKey: { type: 'string' },
    },
} as const;

const contractVoucherSchema = {
    type: 'object',
    required: ['kind', 'requestId', 'invocationId', 'maxAmount', 'priceMicroUsdPerMillionTokens', 'recipientOrganizationId', 'signature', 'expiresAt', 'invocationHash', 'publicKey'],
    properties: {
        kind: { const: 'contract' },
        requestId: { type: 'string' },
        invocationId: { type: 'string' },
        maxAmount: { type: 'integer', minimum: 0 },
        priceMicroUsdPerMillionTokens: { type: 'integer', minimum: 0 },
        recipientOrganizationId: { type: 'string' },
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
        // Inference and contract vouchers have their own `kind`, and no `amount`, so at most one shape matches.
        paymentVoucher: { oneOf: [fixedVoucherSchema, inferenceVoucherSchema, contractVoucherSchema] },
        resourceVersion: { type: 'string', minLength: 1, maxLength: 64 },
        contractDepth: { type: 'integer', minimum: 1 },
        attachmentId: { type: 'string', format: 'uuid' },
        attestation: {
            type: 'object',
            required: ['runTag', 'callIndex'],
            properties: { runTag: { type: 'string', minLength: 1, maxLength: 128 }, callIndex: { type: 'integer', minimum: 0, maximum: 1_000_000 } },
            additionalProperties: false,
        },
        senderContract: {
            type: 'object',
            required: ['name', 'version'],
            properties: { name: { type: 'string', minLength: 1, maxLength: 512 }, version: { type: 'string', minLength: 1, maxLength: 64 } },
            additionalProperties: false,
        },
        eventLineage: {
            type: 'object',
            required: ['depth', 'types', 'contracts'],
            properties: {
                depth: { type: 'integer', minimum: 1, maximum: MAX_EVENT_DEPTH },
                types: { type: 'array', maxItems: 64, items: { type: 'string' } },
                contracts: { type: 'array', maxItems: 64, items: { type: 'string' } },
            },
        },
    },
} as const;

const stringList = { type: 'array', maxItems: 64, items: { type: 'string', maxLength: 512 } } as const;

// The envelope is signed, so its data is only checked to be an object.
const eventEnvelopeSchema = {
    type: 'object',
    required: ['id', 'type', 'version', 'ownerOrganizationId', 'data', 'publishedAt', 'depth', 'lineage', 'publisherPublicKey', 'membershipToken', 'signature'],
    properties: {
        id: { type: 'string', minLength: 1, maxLength: 64 },
        type: { type: 'string', minLength: 1, maxLength: 512 },
        version: { type: 'string', minLength: 1, maxLength: 64 },
        ownerOrganizationId: { type: 'string', minLength: 1, maxLength: 64 },
        data: { type: 'object' },
        publishedAt: { type: 'string', minLength: 1, maxLength: 64 },
        depth: { type: 'integer' },
        lineage: { type: 'object', required: ['types', 'contracts'], properties: { types: stringList, contracts: stringList } },
        publisherPublicKey: { type: 'string', minLength: 1, maxLength: 255 },
        membershipToken: { type: 'string', minLength: 1, maxLength: 4096 },
        signature: { type: 'string', minLength: 1, maxLength: 1024 },
    },
} as const;

// Signed: the types and subscriptions inside are checked by the service, not coerced here.
const eventAnnouncementSchema = {
    type: 'object',
    required: ['publicKey', 'membershipToken', 'eventTypes', 'subscriptions', 'expiry', 'signature'],
    properties: {
        publicKey: nonEmptyString,
        membershipToken: { type: ['string', 'null'] },
        eventTypes: { type: 'array', maxItems: 1000, items: { type: 'object', required: ['path', 'name', 'version', 'fields', 'restricted', 'ownerOrganizationId'] } },
        subscriptions: { type: 'array', maxItems: 1000, items: { type: 'object', required: ['eventPath', 'eventName', 'eventVersion', 'consumer'] } },
        expiry: nonEmptyString,
        signature: nonEmptyString,
    },
} as const;

// Signed: the structs inside are checked by the service, not coerced here.
const structAnnouncementSchema = {
    type: 'object',
    required: ['publicKey', 'membershipToken', 'structs', 'expiry', 'signature'],
    properties: {
        publicKey: nonEmptyString,
        membershipToken: { type: ['string', 'null'] },
        structs: { type: 'array', maxItems: 1000, items: { type: 'object', required: ['path', 'name', 'version', 'fields', 'ownerOrganizationId'] } },
        expiry: nonEmptyString,
        signature: nonEmptyString,
    },
} as const;

const queueQuerySchema = {
    type: 'object',
    properties: {
        ...pageQuerySchema.properties,
        status: { type: 'string', enum: ['pending', 'sending', 'delivered', 'running', 'done', 'failed'] },
    },
} as const;

const contractRequestSchema = {
    type: 'object',
    required: ['source'],
    properties: { source: { type: 'string' }, description: { type: 'string', maxLength: 2048 } },
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
 * and pays this node's organization. A fixed voucher must pay at least the function's cost. An inference
 * voucher must be for an inference function, carry its rates, and sign the call's `maxTokens`.
 * Whether its `maxAmount` covers the call is checked separately, against the function's estimator.
 */
function isValidPaymentVoucher(voucher: PaymentVoucher | InferencePaymentVoucher, resourceFunction: StellariumResourceFunction, manifest: StellariumResourceFunctionPaymentManifest, request: ResourceRunRequest, organizationId: string | undefined): boolean {
    const expectedHash = invocationHash(request.resourcePath, request.resourceName, request.functionName, request.parameters, request.resourceVersion);
    if (voucher.invocationHash !== expectedHash) {
        return false;
    }
    if (!organizationId || voucher.recipientOrganizationId !== organizationId) {
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
        if (voucher.inputCostMicroUsdPerMillionTokens !== manifest.inputCostMicroUsdPerMillionTokens
            || voucher.outputCostMicroUsdPerMillionTokens !== manifest.outputCostMicroUsdPerMillionTokens) {
            return false;
        }
        if (voucher.maxTokens !== parseMaxTokens(request.parameters)) {
            return false;
        }
        return safeVerifyData(inferenceVoucherPayload(voucher), voucher.publicKey, voucher.signature);
    }
    if (isInferenceFunction(resourceFunction) || isInferenceManifest(manifest) || isContractFunction(resourceFunction) || isContractManifest(manifest)) {
        return false;
    }
    if (voucher.amount < manifest.costMicroUsd) {
        return false;
    }
    return safeVerifyData(paymentVoucherPayload(voucher), voucher.publicKey, voucher.signature);
}

/**
 * A contract voucher is valid when it is bound to this exact call, signed by its public key, unexpired, pays
 * this node's organization, and agrees to at least this node's current price.
 */
function isValidContractVoucher(voucher: ContractPaymentVoucher, request: ResourceRunRequest, organizationId: string | undefined, price: number): boolean {
    const expectedHash = invocationHash(request.resourcePath, request.resourceName, request.functionName, request.parameters, request.resourceVersion);
    if (voucher.invocationHash !== expectedHash || !organizationId || voucher.recipientOrganizationId !== organizationId) {
        return false;
    }
    const expiresAt = Date.parse(voucher.expiresAt);
    if (!Number.isFinite(expiresAt) || expiresAt <= Date.now() || voucher.priceMicroUsdPerMillionTokens < price) {
        return false;
    }
    return safeVerifyData(contractVoucherPayload(voucher), voucher.publicKey, voucher.signature);
}

/** Splits `path.Name` or `path.Name@version`. */
function contractRef(ref: string): { path: string, name: string, version?: string } | undefined {
    const at = ref.indexOf('@');
    const qualified = at === -1 ? ref : ref.slice(0, at);
    const version = at === -1 ? undefined : ref.slice(at + 1);
    const dot = qualified.lastIndexOf('.');
    if (dot <= 0 || dot === qualified.length - 1 || version === '') {
        return undefined;
    }
    return { path: qualified.slice(0, dot), name: qualified.slice(dot + 1), version };
}

/** A contract as `GET /v1/contracts` lists it. Its source is public, so callers can read what a call does. */
function contractView(contract: StoredContract) {
    const { path, name, version, parameters, returnType, ownerOrganizationId, description, source, createdAt } = contract;
    return { path, name, version, parameters, returnType, ownerOrganizationId, description, source, createdAt };
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

    /**
     * Requires `Authorization: Bearer <API_KEY>` or `Bearer <run token>`, a JWT from the operator addressed to
     * this node. Records the caller on `request.runCaller`.
     */
    const requireRunAuthorization = async (request: FastifyRequest, reply: FastifyReply) => {
        const authorizationHeader = request.headers['authorization'];
        if (!authorizationHeader) {
            return reply.status(401).send({ error: 'Authorization header is required' });
        }
        const token = authorizationHeader.split(' ')[1];
        const expectedApiKey = options.service.config.apiKey;
        if (token && expectedApiKey && secretsEqual(token, expectedApiKey)) {
            request.runCaller = { kind: 'apiKey' };
            return;
        }
        const verifier = options.service.runTokenVerifier;
        if (token && verifier && looksLikeJwt(token)) {
            const claims = await verifier.verify(token);
            if (!claims) {
                return reply.status(401).send({ error: 'Invalid run token' });
            }
            request.runCaller = { kind: 'client', token, ...claims };
            return;
        }
        return reply.status(401).send({ error: 'Invalid API Key' });
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
                // A contract's latest version, which a contract calling it must pin.
                version: resource.version,
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
                    paymentManifest: !fn.paymentManifest ? undefined : isContractManifest(fn.paymentManifest) ? {
                        priceMicroUsdPerMillionTokens: fn.paymentManifest.priceMicroUsdPerMillionTokens,
                        recipientOrganizationId: fn.paymentManifest.recipientOrganizationId,
                    } : isInferenceManifest(fn.paymentManifest) ? {
                        inputCostMicroUsdPerMillionTokens: fn.paymentManifest.inputCostMicroUsdPerMillionTokens,
                        outputCostMicroUsdPerMillionTokens: fn.paymentManifest.outputCostMicroUsdPerMillionTokens,
                        recipientOrganizationId: fn.paymentManifest.recipientOrganizationId,
                    } : {
                        costMicroUsd: fn.paymentManifest.costMicroUsd,
                        recipientOrganizationId: fn.paymentManifest.recipientOrganizationId,
                    },
                    restricted: fn.restricted || undefined,
                    kind: isInferenceFunction(fn) || isContractFunction(fn) ? fn.kind : undefined,
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

    /**
     * Runs a request script. A run token from another organization's API client is billed: the operator
     * holds the run's cost first, the script's paid calls draw on that hold, and afterwards the run is
     * charged for the tokens the script executed at this node's listed price. Runs by the API key holder or
     * by this node's own organization are free, and their paid calls are paid by this node's organization.
     */
    // Authenticate before body validation, so unauthenticated callers learn nothing about the schema.
    fastify.post('/run', { schema: { body: runRequestSchema }, preValidation: requireRunAuthorization }, async (request, reply) => {
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

        const caller = request.runCaller!;
        const billed = caller.kind === 'client' && caller.organizationId !== options.service.config.organizationId;
        const runId = billed ? randomUUID() : undefined;
        let stamp: number | undefined;
        if (billed) {
            const authorization = await options.service.operatorClient.authorizeRun({ token: caller.token, runId: runId!, source: runRequest.source });
            if (!authorization.ok) {
                return reply.status(authorization.status).send({ error: authorization.error });
            }
            stamp = authorization.now;
        }
        // The run token's claims, or null for an API-key run, so the name is always reserved.
        const jwt = caller.kind === 'client' ? caller.payload : null;
        // Contracts the script calls on this node see who pays for the run: the client's organization, or this node's own.
        const { organizationId, publicKey } = options.service.config;
        const runFor = { org: caller.kind === 'client' ? caller.organizationId : organizationId ?? null, node: publicKey };
        // The run money moves in: a billed run's own, or else a free one, opened when the script or a contract it
        // calls here first moves money, so everything the script starts settles together (docs/money.md, Settlement).
        // The tree's time: the operator's stamp for a billed run, or else when this node started the script, which it
        // tells the operator if it opens a free run.
        const now = stamp ?? Date.now();
        const moneyRun = runId !== undefined
            ? new MoneyRun(runId)
            : new MoneyRun(undefined, (id) => options.service.operatorClient.openRun({ runId: id, now }));
        const resourceInvoker: ResourceInvoker = options.service.resourceInvoker.forScript({ runId, jwt, depth: 0, caller: runFor, moneyRun, now });

        // Kept in the outbox before the response, and sent from there. A script that fails is charged for what it
        // executed, and the money changes in its run's tree are dropped.
        const settle = async (outcome: 'capture' | 'release', tokens: number, failed = false) => {
            const settled = runId ?? moneyRun.opened;
            if (!settled) return;
            const { outbox } = options.service;
            await (outcome === 'capture' ? outbox.captureRun(settled, tokens, failed) : outbox.releaseRun(settled))
                .catch(error => fastify.log.error(error, `Failed to keep the ${outcome} of run ${settled}`));
        };

        // The script's events are published as its organization's, which only this node's own organization may.
        const emitter = options.service.eventService.emitter({ scriptOwner: runFor.org });
        const meter = new TokenMeter();
        try {
            const result = await interpretParsed(script, {
                resourceResolver: options.service.resourceResolver,
                resourceInvoker,
                meter,
                builtins: { jwt },
                events: emitter.resolver,
                structs: options.service.structService.resolver,
            });
            // Money the script couldn't attach, or a contract that failed after moving money in the script's run,
            // fails the script, so nothing moves because a payment was refused.
            const moneyFailure = moneyRun.failure ?? moneyRun.poisoned;
            if (moneyFailure !== undefined) {
                await settle('capture', meter.tokens, true);
                return reply.status(422).send({ error: 'Script failed', details: moneyFailure, usage: { tokens: meter.tokens } });
            }
            const unpublishable = emitter.check(result.events);
            await settle('capture', meter.tokens, unpublishable !== undefined);
            if (unpublishable) {
                return reply.status(422).send({ error: 'Script failed', details: `${unpublishable}, so no events were published`, usage: { tokens: meter.tokens } });
            }
            await emitter.publish(result.events).catch(error => fastify.log.error(error, 'Failed to publish a run\'s events'));
            return reply.status(200).send({ returnValue: result.returnValue ?? null, usage: { tokens: meter.tokens } });
        } catch (error) {
            // A script that fails at runtime is the caller's mistake, and is charged for what it executed.
            if (error instanceof RequestScriptError) {
                await settle('capture', meter.tokens, true);
                return reply.status(422).send({ error: 'Script failed', details: error.message, usage: { tokens: meter.tokens } });
            }
            await settle('release', meter.tokens);
            fastify.log.error(error);
            return reply.status(500).send({ error: 'Internal server error' });
        }
    });

    /**
     * Finds the local function a call names and checks its parameters and, for a restricted function,
     * its authorization. Sends the refusal and returns undefined if a check fails.
     */
    /** With `version`, the call is to that version of a contract, whose parameters it is checked against. */
    async function checkCall(resourceRequest: ResourceCallRequest, reply: FastifyReply, version?: string): Promise<{ resource: StellariumResource, resourceFunction: StellariumResourceFunction } | undefined> {
        const resource = await options.service.resourceRepository.getInternalResource(resourceRequest.resourcePath, resourceRequest.resourceName, version);
        if (!resource) {
            reply.status(400).send({ error: version === undefined ? 'Resource not found' : `Resource not found: this node has no ${resourceRequest.resourcePath}.${resourceRequest.resourceName}@${version} to call` });
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
        const inputTokens = await estimateInputTokens(resourceFunction, resourceRequest.parameters);
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
        // A call that names its place in a run gets a signed answer, the same one each time it's asked
        // (docs/money.md, Signed responses), so a host can neither make one up nor call again for another.
        const attestation = resourceRequest.attestation;
        const hash = invocationHash(resourceRequest.resourcePath, resourceRequest.resourceName, resourceRequest.functionName, resourceRequest.parameters, resourceRequest.resourceVersion);
        if (attestation) {
            const served = await options.service.servedCalls.get(attestation.runTag, attestation.callIndex);
            if (served) {
                if (served.invocationHash !== hash) {
                    return reply.status(409).send({ error: 'This call index of the run was already answered for another call' });
                }
                return served.answer;
            }
        }
        const result = await serveResource(resourceRequest, reply);
        if (result === reply || !attestation) {
            return result;
        }
        return options.service.servedCalls.answer(attestation.runTag, attestation.callIndex, hash, result as InvokeResult);
    });

    /** Whether this node answered a call, by its run tag and index: what the operator asks when a host says a call failed. */
    fastify.get('/served-calls/:runTag/:callIndex', async (request, reply) => {
        const { runTag, callIndex } = request.params as { runTag: string, callIndex: string };
        const served = await options.service.servedCalls.get(runTag, Number(callIndex));
        if (!served) {
            return reply.status(404).send({ error: 'No call with that tag and index was answered' });
        }
        return { responseHash: served.responseHash, signedAt: served.answer.attestation.signedAt };
    });

    async function serveResource(resourceRequest: ResourceRunRequest, reply: FastifyReply): Promise<unknown> {
        const paymentVoucher = resourceRequest.paymentVoucher;
        const version = resourceRequest.resourceVersion;

        const call = await checkCall(resourceRequest, reply, version);
        if (!call) {
            return reply;
        }
        const { resource, resourceFunction } = call;

        // A contract is always paid for with a contract voucher, since its paid calls are paid by its caller.
        if (isContractFunction(resourceFunction)) {
            const contract = version === undefined
                ? await options.service.contractRepository.latest(resource.path, resource.name)
                : await options.service.contractRepository.callable(resource.path, resource.name, version);
            if (!contract) {
                return reply.status(400).send({ error: 'Resource not found' });
            }
            if (!isContractVoucher(paymentVoucher)) {
                return reply.status(402).send({ error: 'A contract voucher is required' });
            }
            const { organizationId, priceMicroUsdPerMillionTokens } = options.service.config;
            if (!isValidContractVoucher(paymentVoucher, resourceRequest, organizationId, priceMicroUsdPerMillionTokens ?? 0)) {
                return reply.status(400).send({ error: 'Invalid payment voucher' });
            }
            if (await options.service.grantService.isBlocked(paymentVoucher.publicKey)) {
                return reply.status(403).send({ error: 'Caller is blocked' });
            }
            const depth = resourceRequest.contractDepth ?? 1;
            if (depth > MAX_CONTRACT_DEPTH) {
                return reply.status(400).send({ error: `Contracts may call each other at most ${MAX_CONTRACT_DEPTH} deep` });
            }
            const result = await options.service.contractService.serve(paymentVoucher, contract, resourceRequest.parameters, depth, resourceRequest.eventLineage, resourceRequest.attachmentId, resourceRequest.senderContract);
            if ('refused' in result) {
                return reply.status(result.refused.status).send({ error: result.refused.error });
            }
            return result;
        }
        if (isContractVoucher(paymentVoucher)) {
            return reply.status(400).send({ error: 'Invalid payment voucher' });
        }

        // A struct-typed parameter is checked before anything is paid or run.
        const parameterRefusal = await options.service.structService.parameterRefusal(resourceFunction.parameters, resourceRequest.parameters);
        if (parameterRefusal) {
            return reply.status(400).send({ error: 'Invalid parameters', details: parameterRefusal });
        }

        // Payment manifests are per function. A paid function is never run without a valid voucher.
        const paymentManifest = resourceFunction.paymentManifest;
        if (paymentManifest) {
            if (!paymentVoucher) {
                return reply.status(402).send({ error: 'Payment voucher is required' });
            }
            if (!isValidPaymentVoucher(paymentVoucher, resourceFunction, paymentManifest, resourceRequest, options.service.config.organizationId)) {
                return reply.status(400).send({ error: 'Invalid payment voucher' });
            }
            if (await options.service.grantService.isBlocked(paymentVoucher.publicKey)) {
                return reply.status(403).send({ error: 'Caller is blocked' });
            }
            // Re-estimated here, so inference never runs on a voucher that can't cover the expected cost.
            if (isInferenceVoucher(paymentVoucher)) {
                const inputTokens = await estimateInputTokens(resourceFunction, resourceRequest.parameters);
                if (inputTokens === undefined) {
                    return reply.status(500).send({ error: 'Failed to estimate input tokens' });
                }
                const requiredMaxAmount = inferenceCharge(paymentVoucher, inputTokens, paymentVoucher.maxTokens);
                if (paymentVoucher.maxAmount < requiredMaxAmount) {
                    return reply.status(402).send({ error: `Payment voucher maxAmount ${paymentVoucher.maxAmount} is below the estimated ${requiredMaxAmount} micro-USD`, requiredMaxAmount });
                }
            }
        }

        const invoke = () => options.service.resourceInvoker.invoke(resource, resourceRequest.functionName, resourceRequest.parameters) as Promise<InvokeResult>;
        // A free function ignores any voucher sent with it.
        if (!paymentManifest || !paymentVoucher) {
            return invoke();
        }
        const result = await settlePaidCall(options.service.operatorClient, options.service.outbox, paymentVoucher, invoke);
        if ('refused' in result) {
            return reply.status(result.refused.status).send({ error: result.refused.error });
        }
        return result;
    }

    // End Run Routes

    // Start Contract Routes

    /** The node's admin, or an organization's API client, from `requireRunAuthorization`. */
    const contractCaller = (request: FastifyRequest): ContractCaller => {
        const caller = request.runCaller!;
        return caller.kind === 'apiKey' ? caller : { kind: 'client', token: caller.token, organizationId: caller.organizationId };
    };

    /**
     * Deploys a version of a contract, which becomes one of this node's resources. Another organization's
     * API client pays the node's deploy fee from its run hold.
     */
    fastify.post('/contracts', { schema: { body: contractRequestSchema }, preValidation: requireRunAuthorization }, async (request, reply) => {
        const { source, description } = request.body as { source: string, description?: string };
        const result = await options.service.contractService.deploy(source, description, contractCaller(request));
        if (!result.ok) {
            return reply.status(result.status).send({ error: result.error });
        }
        return reply.status(201).send(result.contract);
    });

    /** Every version of every contract on this node, with its source. */
    fastify.get('/contracts', { schema: { querystring: pageQuerySchema } }, async (request) => {
        const { items, nextOffset } = await getPage(request.query as PageQuery, (offset, limit) => options.service.contractRepository.list(offset, limit));
        return { contracts: items.map(contractView), nextOffset };
    });

    /**
     * One version of a contract callers can call, `path.Name@version`. Peers announce only a contract's latest
     * version, so a node whose script pins an older one asks for it here to learn its parameters.
     */
    fastify.get('/contracts/:ref', async (request, reply) => {
        const ref = contractRef((request.params as { ref: string }).ref);
        if (!ref || ref.version === undefined) {
            return reply.status(400).send({ error: 'Name a contract version as path.Name@version' });
        }
        const contract = await options.service.contractRepository.callable(ref.path, ref.name, ref.version);
        if (!contract) {
            return reply.status(404).send({ error: `No contract ${ref.path}.${ref.name}@${ref.version} to call` });
        }
        return contractView(contract);
    });

    /**
     * A contract's state variables, every scope, with values as JSON. Only its owner and this node's admin may
     * read them: a contract shares its state with callers through what it returns.
     */
    fastify.get('/contracts/:ref/state', { preValidation: requireRunAuthorization }, async (request, reply) => {
        const ref = contractRef((request.params as { ref: string }).ref);
        if (!ref || ref.version !== undefined) {
            return reply.status(400).send({ error: 'Name a contract as path.Name: state belongs to every version' });
        }
        const result = await options.service.contractService.readState(ref.path, ref.name, contractCaller(request));
        if (!result.ok) {
            return reply.status(result.status).send({ error: result.error });
        }
        return {
            variables: result.variables.map(({ variable, scope, value, updatedAt }) => ({
                name: variable,
                scope,
                value: valueToJson(decodeValue(value)),
                updatedAt,
            })),
        };
    });

    /** Deletes `path.Name@version`, or every version of `path.Name`. */
    fastify.delete('/contracts/:ref', { preValidation: requireRunAuthorization }, async (request, reply) => {
        const ref = contractRef((request.params as { ref: string }).ref);
        if (!ref) {
            return reply.status(400).send({ error: 'Name a contract as path.Name or path.Name@version' });
        }
        const result = await options.service.contractService.delete(ref.path, ref.name, ref.version, contractCaller(request));
        if (!result.ok) {
            return reply.status(result.status).send({ error: result.error });
        }
        return { success: true };
    });

    // End Contract Routes

    // Start Event Routes

    /** Declares a version of an event type, owned by this node's organization. */
    fastify.post('/events', { schema: { body: contractRequestSchema }, preValidation: requireRunAuthorization }, async (request, reply) => {
        const { source, description } = request.body as { source: string, description?: string };
        const result = await options.service.eventService.deployType(source, description, contractCaller(request));
        if (!result.ok) {
            return reply.status(result.status).send({ error: result.error });
        }
        return reply.status(201).send(result.eventType);
    });

    /** Every event type this node knows: the ones it declared, then the ones it learned from peers. */
    fastify.get('/events', { schema: { querystring: pageQuerySchema } }, async (request) => {
        const { items, nextOffset } = await getPage(request.query as PageQuery, (offset, limit) => options.service.eventService.repository.listTypes(offset, limit));
        return { eventTypes: items, nextOffset };
    });

    /** Deletes `path.Name@version`, or every version of `path.Name`, of an event type this node declared. */
    fastify.delete('/events/:ref', { preValidation: requireRunAuthorization }, async (request, reply) => {
        const ref = contractRef((request.params as { ref: string }).ref);
        if (!ref) {
            return reply.status(400).send({ error: 'Name an event type as path.Name or path.Name@version' });
        }
        const result = await options.service.eventService.deleteType(ref.path, ref.name, ref.version, contractCaller(request));
        if (!result.ok) {
            return reply.status(result.status).send({ error: result.error });
        }
        return { success: true };
    });

    /** An event a peer published, for this node's event contracts. Accepted once queued; they run afterwards. */
    fastify.post('/events/deliver', {
        schema: { body: eventEnvelopeSchema },
        config: { rateLimit: options.rateLimit ?? { max: 100, timeWindow: '1 minute' } },
    }, async (request, reply) => {
        const result = await options.service.eventService.receive(request.body as EventEnvelope);
        if (!result.ok) {
            return reply.status(result.status).send({ error: result.error });
        }
        return reply.status(202).send({ accepted: result.accepted });
    });

    /** This node's event types and event contracts, signed, for a peer learning them. */
    fastify.get('/events/announcement', async () => options.service.eventService.announcement());

    /** A peer's event types and event contracts, replacing what it announced before. */
    fastify.put('/all-events', { schema: { body: eventAnnouncementSchema } }, async (request, reply) => {
        const announcement = request.body as EventAnnouncement;
        const peer = await options.service.peerRepository.getPeerByPublicKey(announcement.publicKey);
        if (!peer) {
            return reply.status(400).send({ error: 'Peer not found' });
        }
        const result = await options.service.eventService.applyAnnouncement(announcement, peer.baseUrl);
        if (!result.ok) {
            return reply.status(result.status).send({ error: result.error });
        }
        return { success: true, rejected: result.rejected };
    });

    /** Events this node is delivering to peers, newest first. */
    fastify.get('/admin/events/outbox', { preValidation: requireApiKey, schema: { querystring: queueQuerySchema } }, async (request) => {
        const { status, ...page } = request.query as PageQuery & { status?: string };
        const { items, nextOffset } = await getPage(page, (offset, limit) => options.service.eventService.repository.listOutbox(status, offset, limit));
        return { deliveries: items, nextOffset };
    });

    /** Events delivered to this node's event contracts, newest first, with the error of each that failed. */
    fastify.get('/admin/events/inbox', { preValidation: requireApiKey, schema: { querystring: queueQuerySchema } }, async (request) => {
        const { status, ...page } = request.query as PageQuery & { status?: string };
        const { items, nextOffset } = await getPage(page, (offset, limit) => options.service.eventService.repository.listInbox(status, offset, limit));
        return { events: items, nextOffset };
    });

    // End Event Routes

    // Start Struct Routes

    /** Declares a version of a struct, owned by this node's organization. Declaring it again with the same fields changes nothing. */
    fastify.post('/structs', { schema: { body: contractRequestSchema }, preValidation: requireRunAuthorization }, async (request, reply) => {
        const { source, description } = request.body as { source: string, description?: string };
        const result = await options.service.structService.deploy(source, description, contractCaller(request));
        if (!result.ok) {
            return reply.status(result.status).send({ error: result.error });
        }
        return reply.status(result.created ? 201 : 200).send(result.struct);
    });

    /** Every struct this node knows: the ones it declared, then the ones it learned from peers. */
    fastify.get('/structs', { schema: { querystring: pageQuerySchema } }, async (request) => {
        const { items, nextOffset } = await getPage(request.query as PageQuery, (offset, limit) => options.service.structService.repository.list(offset, limit));
        return { structs: items, nextOffset };
    });

    /** This node's structs, signed, for a peer learning them. */
    fastify.get('/structs/announcement', async () => options.service.structService.announcement());

    /** One struct: `path.Name@version`, or the latest version of `path.Name`. */
    fastify.get('/structs/:ref', async (request, reply) => {
        const ref = contractRef((request.params as { ref: string }).ref);
        if (!ref) {
            return reply.status(400).send({ error: 'Name a struct as path.Name or path.Name@version' });
        }
        const repository = options.service.structService.repository;
        const struct = ref.version === undefined ? await repository.latest(ref.path, ref.name) : await repository.get(ref.path, ref.name, ref.version);
        if (!struct) {
            return reply.status(404).send({ error: `No struct ${ref.path}.${ref.name}${ref.version === undefined ? '' : `@${ref.version}`}` });
        }
        return struct;
    });

    /** A peer's structs. Learned ones are kept: struct versions never change or go away. */
    fastify.put('/all-structs', { schema: { body: structAnnouncementSchema } }, async (request, reply) => {
        const announcement = request.body as StructAnnouncement;
        const peer = await options.service.peerRepository.getPeerByPublicKey(announcement.publicKey);
        if (!peer) {
            return reply.status(400).send({ error: 'Peer not found' });
        }
        const result = await options.service.structService.applyAnnouncement(announcement, peer.baseUrl);
        if (!result.ok) {
            return reply.status(result.status).send({ error: result.error });
        }
        return { success: true, rejected: result.rejected };
    });

    // End Struct Routes

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
