import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import Fastify, { type FastifyInstance } from 'fastify';
import { StellariumNode, type StellariumResource } from 'stellarium-ts';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { Database } from './db/database.js';
import { nodesTable, runsTable } from './db/schema.js';
import type { OrganizationService } from './organizations.js';
import routes from './routes/index.js';
import { createService, type Service } from './service.js';
import { createTestDatabase, generateNodeKeys, ledgerProblems, PAYER_ORGANIZATION, PROVIDER_ORGANIZATION, seedOrganizations } from './testing.js';

const temperatureSource = 'request Temperature {\n  const weather: com.example.Weather\n\n  return weather.temperature(city: "Oslo")\n}';

/** A third organization's paid function, which scripts on the provider's node call. */
function forecastResource(baseUrl: string): StellariumResource {
    return {
        id: 2,
        baseUrl,
        metadata: {},
        path: 'com.example',
        name: 'Forecast',
        functions: [{
            name: 'tomorrow',
            parameters: [{ name: 'city', type: 'string' }],
            returnType: 'int32',
            exec: async () => 9,
            paymentManifest: { costMicroUsd: 5_000 },
        }],
    };
}

function weatherResource(baseUrl: string): StellariumResource {
    return {
        id: 1,
        baseUrl,
        metadata: {},
        path: 'com.example',
        name: 'Weather',
        functions: [{
            name: 'temperature',
            parameters: [{ name: 'city', type: 'string' }],
            returnType: 'int32',
            exec: async () => 12,
            paymentManifest: { costMicroUsd: 10_000 },
        }],
    };
}

/** Real stellarium-ts nodes paying through this operator over HTTP: the wire formats and request signing, end to end. */
describe('nodes paying through the operator', { timeout: 30_000 }, () => {
    const servers: FastifyInstance[] = [];
    let db: Database;
    let close: () => Promise<void>;
    let organizations: OrganizationService;
    let dir: string;
    let operatorUrl: string;
    let service: Service;

    beforeEach(async () => {
        ({ db, close } = await createTestDatabase());
        dir = await mkdtemp(path.join(tmpdir(), 'stellarium-operator-e2e-'));
        const operator = Fastify();
        servers.push(operator);
        service = createService(db, { platformFeeBps: 2000, runTokenPrivateKey: generateNodeKeys().privateKey });
        await operator.register(routes, { prefix: '/v1', service });
        operatorUrl = `${await operator.listen({ port: 0, host: '127.0.0.1' })}/v1`;
    });

    afterEach(async () => {
        await Promise.all(servers.splice(0).map(server => server.close()));
        await close();
        await rm(dir, { recursive: true, force: true });
    });

    /** Starts a node on a free port. A provider registers the weather resource before starting. */
    async function startNode(keys: { publicKey: string, privateKey: string }, options: { provider?: boolean, resources?: (baseUrl: string) => StellariumResource[], startingPeer?: string, enrollmentToken?: string, contractDeployFeeMicroUsd?: number, contractCostLimitMicroUsd?: number } = {}) {
        const fastify = Fastify();
        servers.push(fastify);
        // Listening first gives the node its port, which its resources' base URL needs.
        await fastify.listen({ port: 0, host: '127.0.0.1' });
        const { port } = fastify.server.address() as { port: number };
        await fastify.close();
        const baseUrl = `http://127.0.0.1:${port}`;
        const node = new StellariumNode();
        if (options.provider) await node.register(weatherResource(baseUrl));
        for (const resource of options.resources?.(baseUrl) ?? []) await node.register(resource);
        const app = Fastify();
        servers.push(app);
        await node.start(app, {
            host: '127.0.0.1', port, baseUrl, ...keys, apiKey: 'key', operatorUrl,
            databasePath: path.join(dir, `${port}.db`), startingPeer: options.startingPeer, enrollmentToken: options.enrollmentToken,
            contractDeployFeeMicroUsd: options.contractDeployFeeMicroUsd, contractCostLimitMicroUsd: options.contractCostLimitMicroUsd,
        });
        return baseUrl;
    }

    const run = (url: string, source = temperatureSource, authorization = 'Bearer key') => fetch(`${url}/v1/run`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: authorization },
        body: JSON.stringify({ source }),
    }).then(response => response.json() as Promise<any>);

    /** A run token for a new API client of `organizationId` on `nodePublicKey`, from the token endpoint. */
    async function runToken(organizationId: string, nodePublicKey: string): Promise<string> {
        const { client, clientSecret } = await service.clients.create(organizationId, { nodePublicKey });
        const response = await fetch(`${operatorUrl}/oauth/token`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({ grant_type: 'client_credentials', client_id: client.id, client_secret: clientSecret }),
        });
        return (await response.json() as { access_token: string }).access_token;
    }

    test('a paid call holds, then captures, the caller organization\'s balance', async () => {
        const seeded = await seedOrganizations(db, 100_000);
        organizations = seeded.organizations;
        const providerUrl = await startNode(seeded.provider, { provider: true });
        const callerUrl = await startNode(seeded.payer, { startingPeer: providerUrl });

        expect(await run(callerUrl)).toEqual({ returnValue: { value: 12, error: null }, usage: { tokens: 17 } });

        // Capture runs after the response is sent.
        await vi.waitFor(async () => expect(await organizations.get(PROVIDER_ORGANIZATION)).toMatchObject({ payableMicroUsd: 8_000 }));
        expect(await organizations.get(PAYER_ORGANIZATION)).toMatchObject({ balanceMicroUsd: 90_000, heldMicroUsd: 0 });
    });

    test('a provider enrolls with a token at startup, and a caller without balance is refused before the call runs', async () => {
        const seeded = await seedOrganizations(db, 0);
        organizations = seeded.organizations;
        const { token } = await organizations.createEnrollmentToken(PROVIDER_ORGANIZATION);
        const newProvider = generateNodeKeys();
        const providerUrl = await startNode(newProvider, { provider: true, enrollmentToken: token });
        expect(await organizations.getNode(newProvider.publicKey)).toMatchObject({ organizationId: PROVIDER_ORGANIZATION });
        const callerUrl = await startNode(seeded.payer, { startingPeer: providerUrl });

        const result = await run(callerUrl);

        expect(result.returnValue.value).toBeNull();
        expect(result.returnValue.error.message).toContain('Insufficient balance');
    });

    test('an API client\'s run on a listed node pays for the tokens it executed and for every paid call it makes', async () => {
        const seeded = await seedOrganizations(db, 100_000);
        organizations = seeded.organizations;
        const downstream = generateNodeKeys();
        await organizations.create('Downstream', { id: 'org_downstream' });
        await organizations.setPayoutsEnabled('org_downstream', true);
        await organizations.enroll('org_downstream', downstream.publicKey);
        const downstreamUrl = await startNode(downstream, { resources: (baseUrl) => [forecastResource(baseUrl)] });
        // The listed node hosts the paid Weather function and learns the paid Forecast function from its peer.
        const providerUrl = await startNode(seeded.provider, { provider: true, startingPeer: downstreamUrl });
        await db.update(nodesTable).set({ listed: true, priceMicroUsdPerMillionTokens: 1_000_000 }).where(eq(nodesTable.publicKey, seeded.provider.publicKey));
        const token = await runToken(PAYER_ORGANIZATION, seeded.provider.publicKey);
        // The else branch, which isn't taken, costs more tokens than the branch that is.
        const source = [
            'request Forecast {',
            '  const weather: com.example.Weather',
            '  const forecast: com.example.Forecast',
            '  var today = weather.temperature(city: "Oslo").value',
            '  if (today < 100) {',
            '    return { today: today, tomorrow: forecast.tomorrow(city: "Oslo").value }',
            '  } else {',
            '    return 1 + 2 + 3 + 4 + 5 + 6 + 7 + 8 + 9 + 10 + 11 + 12 + 13 + 14 + 15 + 16 + 17 + 18 + 19 + 20',
            '  }',
            '}',
        ].join('\n');

        const result = await run(providerUrl, source, `Bearer ${token}`);

        expect(result.returnValue).toEqual({ today: 12, tomorrow: 9 });
        const tokens = result.usage.tokens;
        await vi.waitFor(async () => expect(await organizations.get('org_downstream')).toMatchObject({ payableMicroUsd: 4_000 }));
        await vi.waitFor(async () => expect((await db.select().from(runsTable))[0]).toMatchObject({ status: 'captured', tokens }));
        const [recorded] = await db.select().from(runsTable);
        expect(tokens).toBeLessThan(recorded!.maxTokens);
        // Weather (10,000) and Forecast (5,000) from the run's hold, and a micro-USD a token.
        expect(await organizations.get(PAYER_ORGANIZATION)).toMatchObject({ balanceMicroUsd: 100_000 - 15_000 - tokens, heldMicroUsd: 0 });
        expect(await organizations.get(PROVIDER_ORGANIZATION)).toMatchObject({ payableMicroUsd: 8_000 + tokens - Math.floor(tokens * 0.2) });
        expect(await ledgerProblems(db)).toEqual([]);
    });

    test('the node\'s own organization runs free with a run token, as with the API key', async () => {
        const seeded = await seedOrganizations(db, 100_000);
        organizations = seeded.organizations;
        const providerUrl = await startNode(seeded.provider, { provider: true });
        const token = await runToken(PROVIDER_ORGANIZATION, seeded.provider.publicKey);

        expect((await run(providerUrl, temperatureSource, `Bearer ${token}`)).returnValue).toEqual({ value: 12, error: null });
        expect((await run(providerUrl, temperatureSource, 'Bearer not.a.token')).error).toBe('Invalid run token');

        expect(await db.select().from(runsTable)).toEqual([]);
        expect(await organizations.get(PROVIDER_ORGANIZATION)).toMatchObject({ payableMicroUsd: 0 });
    });

    const deploy = (url: string, source: string, authorization = 'Bearer key') => fetch(`${url}/v1/contracts`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: authorization },
        body: JSON.stringify({ source }),
    });

    const forecastContract = 'contract com.example.Outlook(city: string): string {\n  const weather: com.example.Weather\n  return "${weather.temperature(city: city).value} degrees"\n}';

    test('a call to another node\'s contract pays for the tokens it executed and for the paid call it makes', async () => {
        const seeded = await seedOrganizations(db, 100_000);
        organizations = seeded.organizations;
        // A micro-USD a token, which the provider learns at startup. Its session reports a new URL, which unlists it.
        await db.update(nodesTable).set({ priceMicroUsdPerMillionTokens: 1_000_000 }).where(eq(nodesTable.publicKey, seeded.provider.publicKey));
        const providerUrl = await startNode(seeded.provider, { provider: true });
        await db.update(nodesTable).set({ listed: true }).where(eq(nodesTable.publicKey, seeded.provider.publicKey));
        // Enough for the contract's tokens and the paid call it makes, which the default, a single call's limit, isn't.
        const callerUrl = await startNode(seeded.payer, { startingPeer: providerUrl, contractCostLimitMicroUsd: 50_000 });

        expect((await deploy(providerUrl, forecastContract)).status).toBe(201);
        await vi.waitFor(async () => {
            const { resources } = await (await fetch(`${callerUrl}/v1/resources`)).json() as { resources: StellariumResource[] };
            expect(resources.map(resource => resource.name)).toContain('Outlook');
        });

        const result = await run(callerUrl, 'request R {\n  const outlook: com.example.Outlook\n  return outlook.run(city: "Oslo")\n}');

        expect(result.returnValue).toEqual({ value: '12 degrees', error: null });
        await vi.waitFor(async () => expect((await db.select().from(runsTable))[0]).toMatchObject({ kind: 'contract', status: 'captured', clientId: null }));
        const [contractRun] = await db.select().from(runsTable);
        const tokens = contractRun!.tokens!;
        expect(tokens).toBeGreaterThan(0);
        await vi.waitFor(async () => expect(await organizations.get(PAYER_ORGANIZATION)).toMatchObject({ heldMicroUsd: 0 }));
        // Weather (10,000) from the contract run's hold, and a micro-USD a token.
        expect(await organizations.get(PAYER_ORGANIZATION)).toMatchObject({ balanceMicroUsd: 100_000 - 10_000 - tokens });
        expect(await organizations.get(PROVIDER_ORGANIZATION)).toMatchObject({ payableMicroUsd: 8_000 + tokens - Math.floor(tokens * 0.2) });
        expect(await ledgerProblems(db)).toEqual([]);
    });

    test('another organization\'s API client pays the deploy fee', async () => {
        const seeded = await seedOrganizations(db, 100_000);
        organizations = seeded.organizations;
        const providerUrl = await startNode(seeded.provider, { provider: true, contractDeployFeeMicroUsd: 2_000 });
        await db.update(nodesTable).set({ listed: true }).where(eq(nodesTable.publicKey, seeded.provider.publicKey));
        const token = await runToken(PAYER_ORGANIZATION, seeded.provider.publicKey);

        const response = await deploy(providerUrl, forecastContract, `Bearer ${token}`);

        expect(response.status).toBe(201);
        expect(await response.json()).toMatchObject({ feeMicroUsd: 2_000 });
        await vi.waitFor(async () => expect(await organizations.get(PAYER_ORGANIZATION)).toMatchObject({ balanceMicroUsd: 98_000, heldMicroUsd: 0 }));
        expect(await organizations.get(PROVIDER_ORGANIZATION)).toMatchObject({ payableMicroUsd: 1_600 });
        expect(await ledgerProblems(db)).toEqual([]);
    });

    test('a provider that isn\'t enrolled fails to start', async () => {
        await expect(startNode(generateNodeKeys(), { provider: true })).rejects.toThrow('Node is not enrolled in an organization');
    });
});
