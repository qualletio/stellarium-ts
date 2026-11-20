import { eq } from 'drizzle-orm';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import type { Database } from '../db/database.js';
import { nodesTable, topUpsTable } from '../db/schema.js';
import { createService, type Service } from '../service.js';
import { createTestDatabase, generateNodeKeys, ledgerProblems, type NodeKeys, nodeAuthorization, PAYER_ORGANIZATION, PROVIDER_ORGANIZATION, seedOrganizations, APPLY_BEFORE_VERIFYING } from '../testing.js';
import routes from './index.js';

const COURIER = 'org_courier';
const SOURCE = 'payable contract com.example.Job(action: string): string { return action }';

describe('money routes', () => {
    let db: Database;
    let close: () => Promise<void>;
    let fastify: FastifyInstance;
    let service: Service;
    let provider: NodeKeys;
    let payer: NodeKeys;

    beforeEach(async () => {
        ({ db, close } = await createTestDatabase());
        const seeded = await seedOrganizations(db, 50_000_000);
        ({ provider, payer } = seeded);
        const { organizations } = seeded;
        await db.insert(topUpsTable).values({ organizationId: PAYER_ORGANIZATION, amountMicroUsd: 50_000_000, status: 'succeeded' });
        await organizations.create('Courier', { id: COURIER });
        await organizations.setPayoutsEnabled(COURIER, true);
        await db.update(nodesTable).set({ listed: true }).where(eq(nodesTable.publicKey, provider.publicKey));
        await organizations.setNodeMoneyLimits(provider.publicKey, { maxContractBalanceMicroUsd: 100_000_000 });
        await organizations.setNodeMoneyLimits(payer.publicKey, { maxApiKeyRunValueMicroUsd: 10_000_000, monthlyApiKeyValueCapMicroUsd: 10_000_000 });
        service = createService(db, { money: APPLY_BEFORE_VERIFYING, platformFeeBps: 100, runTokenPrivateKey: generateNodeKeys().privateKey });
        fastify = Fastify();
        await fastify.register(routes, { prefix: '/v1', service });
        await fastify.ready();
    });

    afterEach(async () => {
        expect(await ledgerProblems(db)).toEqual([]);
        await fastify.close();
        await close();
    });

    const signed = (keys: NodeKeys, url: string, payload: object) => fastify.inject({
        method: 'POST',
        url,
        payload,
        headers: { authorization: nodeAuthorization(keys, 'POST', url, payload) },
    });

    test('a node registers a contract, a script funds it, and buyers read it from the operator', async () => {
        const registration = { name: 'com.example.Job', version: '1', payable: true, source: SOURCE, requestscriptVersion: '1.8.0', dependencies: [] };
        const registered = await signed(provider, '/v1/money/contracts', registration);
        expect(registered.statusCode).toBe(200);
        expect(registered.json().contract).toMatchObject({ name: 'com.example.Job', ownerOrganizationId: PROVIDER_ORGANIZATION });
        expect(registered.json().contract.source).toBeUndefined();

        const runId = crypto.randomUUID();
        expect((await signed(payer, '/v1/runs/open', { runId })).json()).toEqual({ status: 'held', now: expect.any(Number) });
        const to = { nodePublicKey: provider.publicKey, name: 'com.example.Job', version: '1' };
        const stage = await signed(payer, '/v1/money/stage', {
            runId, callIndex: 0, function: 'attach', parameters: { to, amount: 5_000_000, attachmentId: crypto.randomUUID(), payees: [COURIER] },
        });
        expect(stage.statusCode).toBe(200);
        expect(stage.json()).toEqual({ result: null });
        expect((await signed(payer, '/v1/runs/outcome', { runId })).json()).toEqual({ outcome: 'pending' });
        expect((await signed(payer, '/v1/runs/capture', { runId, tokens: 0 })).json()).toEqual({ status: 'released' });
        expect((await signed(payer, '/v1/runs/outcome', { runId })).json()).toEqual({ outcome: 'applied' });

        const url = `/v1/contracts/${provider.publicKey}/com.example.Job@1`;
        const published = await fastify.inject({ method: 'GET', url });
        expect(published.statusCode).toBe(200);
        expect(published.json()).toMatchObject({ source: SOURCE, balanceMicroUsd: 5_000_000, log: [{ kind: 'inflow', amountMicroUsd: 5_000_000 }] });
        expect(JSON.stringify(published.json())).not.toContain(PAYER_ORGANIZATION);
        expect((await fastify.inject({ method: 'GET', url: `/v1/contracts/${provider.publicKey}/com.example.Job@2` })).statusCode).toBe(404);
    });

    test('refuses unsigned and malformed requests', async () => {
        expect((await fastify.inject({ method: 'POST', url: '/v1/money/stage', payload: {} })).statusCode).toBe(401);
        const runId = crypto.randomUUID();
        await signed(payer, '/v1/runs/open', { runId });
        const bad = await signed(payer, '/v1/money/stage', { runId, callIndex: 0, function: 'pay', parameters: { to: COURIER } });
        expect(bad.statusCode).toBe(400);
        const fractional = await signed(payer, '/v1/money/stage', {
            runId, callIndex: 0, function: 'attach',
            parameters: { to: { nodePublicKey: provider.publicKey, name: 'com.example.Job', version: '1' }, amount: 1.5, attachmentId: crypto.randomUUID(), payees: [COURIER] },
        });
        expect(fractional.statusCode).toBe(400);
        await signed(payer, '/v1/runs/release', { runId });
    });
});

describe('stellarium-ts\'s OperatorClient', () => {
    test('registers, stages, reads and settles against the operator, and verifies its signed reads', async () => {
        const { createPublicKey, verify } = await import('node:crypto');
        const { moneyReadPayload, OperatorClient } = await import('stellarium-ts');
        const { db, close } = await createTestDatabase();
        const { organizations, provider, payer } = await seedOrganizations(db, 50_000_000);
        await db.insert(topUpsTable).values({ organizationId: PAYER_ORGANIZATION, amountMicroUsd: 50_000_000, status: 'succeeded' });
        await organizations.create('Courier', { id: COURIER });
        await organizations.setPayoutsEnabled(COURIER, true);
        await organizations.setNodeMoneyLimits(provider.publicKey, { maxContractBalanceMicroUsd: 100_000_000 });
        await organizations.setNodeMoneyLimits(payer.publicKey, { maxApiKeyRunValueMicroUsd: 10_000_000, monthlyApiKeyValueCapMicroUsd: 10_000_000 });
        const service = createService(db, { money: APPLY_BEFORE_VERIFYING, platformFeeBps: 100, runTokenPrivateKey: generateNodeKeys().privateKey });
        const operator = Fastify();
        await operator.register(routes, { prefix: '/v1', service });
        const url = `${await operator.listen({ port: 0, host: '127.0.0.1' })}/v1`;
        try {
            const host = new OperatorClient(url, provider.publicKey, provider.privateKey);
            const caller = new OperatorClient(url, payer.publicKey, payer.privateKey);
            expect(await host.registerContract({ name: 'com.example.Job', version: '1', payable: true, source: SOURCE, requestscriptVersion: '1.8.0', dependencies: [] }))
                .toEqual({ ok: true });

            // The provider runs its own script, which funds its own contract and then reads it.
            const runId = crypto.randomUUID();
            expect(await host.openRun({ runId })).toEqual({ ok: true });
            await organizations.setNodeMoneyLimits(provider.publicKey, { maxApiKeyRunValueMicroUsd: 1_000_000, monthlyApiKeyValueCapMicroUsd: 1_000_000 });
            expect(await host.stageMoney({
                runId, callIndex: 0, function: 'attach',
                parameters: { to: { nodePublicKey: provider.publicKey, name: 'com.example.Job', version: '1' }, amount: 1_000_000, attachmentId: crypto.randomUUID(), payees: [COURIER] },
            })).toEqual({ ok: false, status: 402, error: expect.stringContaining('top') });

            const callerRun = crypto.randomUUID();
            expect(await caller.openRun({ runId: callerRun })).toEqual({ ok: true });
            expect(await caller.stageMoney({
                runId: callerRun, callIndex: 0, function: 'attach',
                parameters: { to: { nodePublicKey: provider.publicKey, name: 'com.example.Job', version: '1' }, amount: 2_000_000, attachmentId: crypto.randomUUID(), payees: [COURIER] },
            })).toEqual({ ok: true, result: null });
            await caller.captureRun({ runId: callerRun, tokens: 0 });
            expect(await caller.runOutcome({ runId: callerRun })).toEqual({ ok: true, outcome: 'applied' });

            const result = await host.readMoney({ runId, callIndex: 1, contract: { name: 'com.example.Job', version: '1' }, function: 'fundingOf', parameters: { org: PAYER_ORGANIZATION, key: null } });
            if (!result.ok) throw new Error(result.error);
            expect(result.read.response).toBe(2_000_000);
            const payload = moneyReadPayload({ runId, callIndex: 1, function: 'fundingOf', parameters: { org: PAYER_ORGANIZATION, key: null }, response: result.read.response, signedAt: result.read.signedAt });
            const key = createPublicKey({ key: Buffer.from(result.read.publicKey, 'base64url'), format: 'der', type: 'spki' });
            expect(verify(null, Buffer.from(JSON.stringify(payload)), key, Buffer.from(result.read.signature, 'base64url'))).toBe(true);

            expect(await host.stageMoney({ runId, callIndex: 2, contract: { name: 'com.example.Job', version: '1' }, function: 'pay', parameters: { to: COURIER, amount: 2_000_000, from: PAYER_ORGANIZATION } }))
                .toEqual({ ok: true, result: 0 });
            await host.captureRun({ runId, tokens: 0, failed: true });
            expect(await host.runOutcome({ runId })).toEqual({ ok: true, outcome: 'dropped' });
            expect((await service.money.publicContract({ nodePublicKey: provider.publicKey, name: 'com.example.Job', version: '1' }))!.balanceMicroUsd).toBe(2_000_000);
            expect(await ledgerProblems(db)).toEqual([]);
        } finally {
            await operator.close();
            await close();
        }
    });
});
