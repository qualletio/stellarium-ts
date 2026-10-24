import { eq } from 'drizzle-orm';
import Fastify, { type FastifyInstance } from 'fastify';
import { createLocalJWKSet, type JSONWebKeySet } from 'jose';
import { operatorAuthorization, RunTokenVerifier } from 'stellarium-ts';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import type { Database } from '../db/database.js';
import { nodesTable } from '../db/schema.js';
import { createService, type Service } from '../service.js';
import { createTestDatabase, generateNodeKeys, type NodeKeys, PAYER_ORGANIZATION, PROVIDER_ORGANIZATION, seedOrganizations } from '../testing.js';
import routes from './index.js';

describe('API client and run routes', () => {
    let db: Database;
    let close: () => Promise<void>;
    let fastify: FastifyInstance;
    let service: Service;
    let provider: NodeKeys;
    let clientId: string;
    let clientSecret: string;

    beforeEach(async () => {
        ({ db, close } = await createTestDatabase());
        ({ provider } = await seedOrganizations(db, 100_000));
        await db.update(nodesTable).set({ listed: true, priceMicroUsdPerMillionTokens: 1_000_000 }).where(eq(nodesTable.publicKey, provider.publicKey));
        service = createService(db, { platformFeeBps: 2000, runTokenPrivateKey: generateNodeKeys().privateKey });
        ({ client: { id: clientId }, clientSecret } = await service.clients.create(PAYER_ORGANIZATION, { nodePublicKey: provider.publicKey }));
        fastify = Fastify();
        await fastify.register(routes, { prefix: '/v1', service });
        await fastify.ready();
    });

    afterEach(async () => {
        await fastify.close();
        await close();
    });

    const tokenRequest = (payload: string | object, headers: Record<string, string> = {}) => fastify.inject({
        method: 'POST',
        url: '/v1/oauth/token',
        payload,
        headers: typeof payload === 'string' ? { 'content-type': 'application/x-www-form-urlencoded', ...headers } : headers,
    });

    const form = (fields: Record<string, string>) => new URLSearchParams(fields).toString();

    async function verifier() {
        const jwks = (await fastify.inject({ method: 'GET', url: '/v1/.well-known/jwks.json' })).json() as JSONWebKeySet;
        return new RunTokenVerifier('http://operator.invalid/v1', provider.publicKey, createLocalJWKSet(jwks));
    }

    describe('POST /v1/oauth/token', () => {
        test('issues a token that stellarium-ts\'s verifier accepts for the client\'s node', async () => {
            const response = await tokenRequest(form({ grant_type: 'client_credentials', client_id: clientId, client_secret: clientSecret }));

            expect(response.statusCode).toBe(200);
            expect(response.headers['cache-control']).toBe('no-store');
            const body = response.json();
            expect(body).toMatchObject({ token_type: 'Bearer', expires_in: 900 });
            expect(await (await verifier()).verify(body.access_token)).toEqual({ clientId, organizationId: PAYER_ORGANIZATION });
            // Addressed to the client's node only.
            const other = new RunTokenVerifier('http://operator.invalid/v1', generateNodeKeys().publicKey, createLocalJWKSet((await fastify.inject({ method: 'GET', url: '/v1/.well-known/jwks.json' })).json()));
            expect(await other.verify(body.access_token)).toBeUndefined();
        });

        test('accepts HTTP Basic client authentication and JSON bodies', async () => {
            const basic = `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`;
            expect((await tokenRequest(form({ grant_type: 'client_credentials' }), { authorization: basic })).statusCode).toBe(200);
            expect((await tokenRequest({ grant_type: 'client_credentials', client_id: clientId, client_secret: clientSecret })).statusCode).toBe(200);
        });

        test.each([
            ['a wrong secret', () => form({ grant_type: 'client_credentials', client_id: clientId, client_secret: 'cs_wrong' }), 401, 'invalid_client'],
            ['an unknown client', () => form({ grant_type: 'client_credentials', client_id: 'cli_unknown', client_secret: clientSecret }), 401, 'invalid_client'],
            ['missing credentials', () => form({ grant_type: 'client_credentials' }), 401, 'invalid_client'],
            ['another grant type', () => form({ grant_type: 'password', client_id: clientId, client_secret: clientSecret }), 400, 'unsupported_grant_type'],
        ])('refuses %s', async (_, payload, status, error) => {
            const response = await tokenRequest(payload());

            expect(response.statusCode).toBe(status);
            expect(response.json()).toMatchObject({ error });
        });

        test('refuses a revoked client, and a node that was unlisted', async () => {
            await service.organizations.updateListing(PROVIDER_ORGANIZATION, provider.publicKey, { listed: false });
            const unlisted = await tokenRequest(form({ grant_type: 'client_credentials', client_id: clientId, client_secret: clientSecret }));
            expect(unlisted.statusCode).toBe(400);
            expect(unlisted.json()).toMatchObject({ error: 'unauthorized_client' });

            await service.clients.revoke(PAYER_ORGANIZATION, clientId);
            expect((await tokenRequest(form({ grant_type: 'client_credentials', client_id: clientId, client_secret: clientSecret }))).statusCode).toBe(401);
        });
    });

    test('POST /v1/runs/* authorizes and captures a run, signed by stellarium-ts\'s operatorAuthorization', async () => {
        const post = (path: string, body: object) => fastify.inject({
            method: 'POST', url: path, payload: body,
            headers: { authorization: operatorAuthorization('POST', `http://operator${path}`, body, provider.publicKey, provider.privateKey) },
        });
        const token = (await tokenRequest(form({ grant_type: 'client_credentials', client_id: clientId, client_secret: clientSecret }))).json().access_token;
        const runId = crypto.randomUUID();

        const authorized = await post('/v1/runs/authorize', { token, runId, source: 'request R { return 1 }' });
        expect(authorized.statusCode).toBe(200);
        expect(authorized.json()).toMatchObject({ status: 'held', maxTokens: 2 });

        const captured = await post('/v1/runs/capture', { runId, tokens: 2 });
        expect(captured.json()).toEqual({ status: 'captured', amountMicroUsd: 2 });

        expect((await post('/v1/runs/release', { runId: 'not-a-uuid' })).statusCode).toBe(400);
    });

    test('without a signing key, tokens and the key set are unavailable', async () => {
        const plain = Fastify();
        await plain.register(routes, { prefix: '/v1', service: createService(db, { platformFeeBps: 2000 }) });
        const token = await plain.inject({ method: 'POST', url: '/v1/oauth/token', payload: { grant_type: 'client_credentials', client_id: clientId, client_secret: clientSecret } });
        expect(token.statusCode).toBe(503);
        expect((await plain.inject({ method: 'GET', url: '/v1/.well-known/jwks.json' })).statusCode).toBe(404);
        await plain.close();
    });
});
