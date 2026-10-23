import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import { StellariumNode, type StellariumResource } from 'stellarium-ts';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { Database } from './db/database.js';
import type { OrganizationService } from './organizations.js';
import routes from './routes/index.js';
import { createService } from './service.js';
import { createTestDatabase, generateNodeKeys, PAYER_ORGANIZATION, PROVIDER_ORGANIZATION, seedOrganizations } from './testing.js';

const temperatureSource = 'request Temperature {\n  const weather: com.example.Weather\n\n  return weather.temperature(city: "Oslo")\n}';

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

    beforeEach(async () => {
        ({ db, close } = await createTestDatabase());
        dir = await mkdtemp(path.join(tmpdir(), 'stellarium-operator-e2e-'));
        const operator = Fastify();
        servers.push(operator);
        await operator.register(routes, { prefix: '/v1', service: createService(db, { platformFeeBps: 2000 }) });
        operatorUrl = `${await operator.listen({ port: 0, host: '127.0.0.1' })}/v1`;
    });

    afterEach(async () => {
        await Promise.all(servers.splice(0).map(server => server.close()));
        await close();
        await rm(dir, { recursive: true, force: true });
    });

    /** Starts a node on a free port. A provider registers the weather resource before starting. */
    async function startNode(keys: { publicKey: string, privateKey: string }, options: { provider?: boolean, startingPeer?: string, enrollmentToken?: string } = {}) {
        const fastify = Fastify();
        servers.push(fastify);
        // Listening first gives the node its port, which its resources' base URL needs.
        await fastify.listen({ port: 0, host: '127.0.0.1' });
        const { port } = fastify.server.address() as { port: number };
        await fastify.close();
        const baseUrl = `http://127.0.0.1:${port}`;
        const node = new StellariumNode();
        if (options.provider) await node.register(weatherResource(baseUrl));
        const app = Fastify();
        servers.push(app);
        await node.start(app, {
            host: '127.0.0.1', port, baseUrl, ...keys, apiKey: 'key', operatorUrl,
            databasePath: path.join(dir, `${port}.db`), startingPeer: options.startingPeer, enrollmentToken: options.enrollmentToken,
        });
        return baseUrl;
    }

    const run = (url: string) => fetch(`${url}/v1/run`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer key' },
        body: JSON.stringify({ source: temperatureSource }),
    }).then(response => response.json() as Promise<any>);

    test('a paid call holds, then captures, the caller organization\'s balance', async () => {
        const seeded = await seedOrganizations(db, 100_000);
        organizations = seeded.organizations;
        const providerUrl = await startNode(seeded.provider, { provider: true });
        const callerUrl = await startNode(seeded.payer, { startingPeer: providerUrl });

        expect(await run(callerUrl)).toEqual({ returnValue: { value: 12, error: null } });

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

    test('a provider that isn\'t enrolled fails to start', async () => {
        await expect(startNode(generateNodeKeys(), { provider: true })).rejects.toThrow('Node is not enrolled in an organization');
    });
});
