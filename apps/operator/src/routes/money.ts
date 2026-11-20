import type { FastifyPluginAsync } from 'fastify';
import { authenticateNode } from '../auth/nodeAuth.js';
import type { ContractRegistration, MoneyReadRequest, StageRequest } from '../money/moneyService.js';
import type { RouteOptions } from './index.js';

const runId = { type: 'string', format: 'uuid' } as const;
const name = { type: 'string', minLength: 3, maxLength: 512 } as const;
const version = { type: 'string', minLength: 1, maxLength: 64 } as const;
const organization = { type: 'string', minLength: 1, maxLength: 64 } as const;
const key = { type: ['string', 'null'], minLength: 1, maxLength: 255 } as const;
// The service checks amounts too, and refuses them with 422 so the run fails rather than retries.
const amount = { type: 'integer' } as const;
const localContract = { type: 'object', required: ['name', 'version'], properties: { name, version }, additionalProperties: false } as const;
const contract = {
    type: 'object',
    required: ['nodePublicKey', 'name', 'version'],
    properties: { nodePublicKey: { type: 'string', minLength: 1, maxLength: 255 }, name, version },
    additionalProperties: false,
} as const;

const registrationSchema = {
    type: 'object',
    required: ['name', 'version', 'payable', 'source', 'requestscriptVersion', 'dependencies'],
    properties: {
        name,
        version,
        payable: { type: 'boolean' },
        source: { type: 'string', maxLength: 100_000 },
        requestscriptVersion: { type: 'string', minLength: 1, maxLength: 64 },
        dependencies: { type: 'array', maxItems: 256, items: contract },
        token: { type: 'string', minLength: 1, maxLength: 4096 },
    },
    additionalProperties: false,
} as const;

const call = { runId, callIndex: { type: 'integer', minimum: 0, maximum: 1_000_000 }, contract: localContract } as const;

const stageSchema = {
    type: 'object',
    required: ['runId', 'callIndex', 'function', 'parameters'],
    properties: { ...call, function: { enum: ['attach', 'earmark', 'pay', 'refund', 'random_request'] }, parameters: { type: 'object' } },
    additionalProperties: false,
    oneOf: [
        {
            properties: {
                function: { const: 'attach' },
                parameters: {
                    type: 'object',
                    required: ['to', 'amount', 'attachmentId'],
                    properties: {
                        to: contract,
                        amount,
                        attachmentId: { type: 'string', format: 'uuid' },
                        payees: { type: 'array', items: organization },
                        from: organization,
                        key,
                    },
                    additionalProperties: false,
                },
            },
        },
        {
            properties: {
                function: { const: 'earmark' },
                parameters: { type: 'object', required: ['attachmentId', 'key'], properties: { attachmentId: { type: 'string', format: 'uuid' }, key: { type: 'string', minLength: 1, maxLength: 255 } }, additionalProperties: false },
            },
        },
        {
            properties: {
                function: { const: 'pay' },
                parameters: { type: 'object', required: ['to', 'amount', 'from'], properties: { to: organization, amount, from: organization, key, try: { type: 'boolean' } }, additionalProperties: false },
            },
        },
        {
            properties: {
                function: { const: 'random_request' },
                parameters: { type: 'object', required: ['key'], properties: { key: { type: 'string', minLength: 1, maxLength: 255 } }, additionalProperties: false },
            },
        },
        {
            properties: {
                function: { const: 'refund' },
                parameters: { type: 'object', required: ['to', 'amount'], properties: { to: organization, amount, key }, additionalProperties: false },
            },
        },
    ],
} as const;

const readSchema = {
    type: 'object',
    required: ['runId', 'callIndex', 'contract', 'function', 'parameters'],
    properties: { ...call, function: { enum: ['balance', 'fundingOf', 'canReceive', 'attachment', 'random'] }, parameters: { type: 'object' } },
    additionalProperties: false,
    oneOf: [
        { properties: { function: { const: 'balance' }, parameters: { type: 'object', additionalProperties: false } } },
        { properties: { function: { const: 'fundingOf' }, parameters: { type: 'object', required: ['org'], properties: { org: organization, key }, additionalProperties: false } } },
        { properties: { function: { const: 'canReceive' }, parameters: { type: 'object', required: ['org'], properties: { org: organization }, additionalProperties: false } } },
        { properties: { function: { const: 'random' }, parameters: { type: 'object', required: ['key'], properties: { key: { type: 'string', minLength: 1, maxLength: 255 } }, additionalProperties: false } } },
        { properties: { function: { const: 'attachment' }, parameters: { type: 'object', required: ['attachmentId'], properties: { attachmentId: { type: 'string', format: 'uuid' } }, additionalProperties: false } } },
    ],
} as const;

/**
 * Contract money (docs/money.md). Nodes register contract versions, and stage and read their accounts' changes
 * for the runs they run, signed like every node request. Anyone can read a registered contract version.
 */
const moneyRoutes: FastifyPluginAsync<RouteOptions> = async function (fastify, { service }) {
    // Buyers read a contract from the operator, never from its host, which could lie.
    fastify.get<{ Params: { node: string, ref: string } }>('/contracts/:node/:ref', async (request, reply) => {
        const at = request.params.ref.lastIndexOf('@');
        if (at <= 0) return reply.status(400).send({ error: 'Name a contract version as path.Name@version' });
        const found = await service.money.publicContract({ nodePublicKey: request.params.node, name: request.params.ref.slice(0, at), version: request.params.ref.slice(at + 1) });
        if (!found) return reply.status(404).send({ error: 'Contract not found' });
        return found;
    });

    // Signed checkpoints anyone can check their entries against.
    fastify.get('/checkpoints/latest', async (_request, reply) => {
        const checkpoint = await service.governance.latestCheckpoint();
        if (!checkpoint) return reply.status(404).send({ error: 'No checkpoint yet' });
        return checkpoint;
    });

    await fastify.register(async (signed) => {
        signed.addHook('preValidation', authenticateNode);

        signed.post<{ Body: ContractRegistration }>('/money/contracts', { schema: { body: registrationSchema } }, async (request) => {
            const { source: _, ...contract } = await service.money.register(request.nodePublicKey!, request.body);
            return { contract };
        });

        signed.post<{ Body: StageRequest }>('/money/stage', { schema: { body: stageSchema } }, async (request) => {
            return service.money.stage(request.nodePublicKey!, request.body);
        });

        signed.post<{ Body: MoneyReadRequest }>('/money/read', { schema: { body: readSchema } }, async (request) => {
            return service.money.read(request.nodePublicKey!, request.body);
        });
    });
};

export default moneyRoutes;
