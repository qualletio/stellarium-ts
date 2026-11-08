import { generateKeyPairSync } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import { StellariumNode } from 'stellarium-ts';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { StellariumClient, type StellariumError } from '../index.js';

function freePort(): Promise<number> {
    return new Promise((resolve, reject) => {
        const server = createServer();
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => {
            const { port } = server.address() as { port: number };
            server.close(() => resolve(port));
        });
    });
}

function keyPair() {
    const { publicKey, privateKey } = generateKeyPairSync('ed25519', {
        publicKeyEncoding: { type: 'spki', format: 'der' },
        privateKeyEncoding: { type: 'pkcs8', format: 'der' },
    });
    return { publicKey: publicKey.toString('base64url'), privateKey: privateKey.toString('base64url') };
}

const temperature = 'request GetTemperature {\n  const weather: com.example.Weather\n\n  return weather.temperature(city: "Oslo")\n}';
// \${...} is RequestScript's interpolation, not JavaScript's.
const forecast = `contract com.example.Forecast(city: string): string {
  const weather: com.example.Weather
  const temperature = weather.temperature(city: city)
  return "\${temperature} degrees"
}`;

/** A real node over HTTP, hosting a free resource, with no operator. */
describe('against a node', () => {
    let fastify: FastifyInstance;
    let dir: string;
    let nodeUrl: string;
    const keys = keyPair();

    beforeAll(async () => {
        dir = await mkdtemp(path.join(tmpdir(), 'stellarium-client-'));
        const port = await freePort();
        nodeUrl = `http://127.0.0.1:${port}`;
        const node = new StellariumNode();
        await node.register({
            id: 1,
            baseUrl: nodeUrl,
            metadata: {},
            path: 'com.example',
            name: 'Weather',
            description: 'Temperatures by city',
            functions: [{
                name: 'temperature',
                parameters: [{ name: 'city', type: 'string' }],
                returnType: 'int32',
                exec: async (args) => (args.find((arg) => arg.name === 'city')?.value === 'Oslo' ? 12 : 20),
            }],
        });
        fastify = Fastify();
        await node.start(fastify, { host: '127.0.0.1', port, baseUrl: nodeUrl, ...keys, apiKey: 'node-key', databasePath: path.join(dir, 'node.db') });
    });

    afterAll(async () => {
        await fastify?.close();
        await rm(dir, { recursive: true, force: true });
    });

    test('reads the node and its resources', async () => {
        const client = new StellariumClient({ nodeUrl });

        await expect(client.self()).resolves.toEqual({ baseUrl: nodeUrl, publicKey: keys.publicKey, name: nodeUrl });
        const weather = await client.resources.get('com.example', 'Weather');
        expect(weather).toMatchObject({ description: 'Temperatures by city', functions: [{ name: 'temperature', returnType: 'int32' }] });
        await expect(client.peers.list()).resolves.toEqual({ items: [], nextOffset: null });
        await expect(client.structs.get('com.example.Point@1')).resolves.toBeUndefined();
    });

    test('runs a script', async () => {
        const client = new StellariumClient({ nodeUrl, apiKey: 'node-key' });

        const result = await client.run(temperature);
        expect(result.returnValue).toEqual(expect.objectContaining({ value: 12 }));
        expect(result.usage.tokens).toBeGreaterThan(0);
    });

    test('reports refusals and failures', async () => {
        const refused = await new StellariumClient({ nodeUrl, apiKey: 'wrong' }).run(temperature).catch((error: StellariumError) => error);
        expect(refused).toMatchObject({ status: 401, error: 'Invalid API Key' });

        const client = new StellariumClient({ nodeUrl, apiKey: 'node-key' });
        await expect(client.run('request {')).rejects.toMatchObject({ status: 400, error: 'Invalid script' });
        const failed = await client.run('request Missing {\n  const nothing: com.example.Nothing\n\n  return nothing.call()\n}').catch((error: StellariumError) => error);
        expect(failed).toMatchObject({ status: 422, error: 'Script failed', isScriptFailure: true });
    });

    test('deploys, lists and deletes a contract', async () => {
        const client = new StellariumClient({ nodeUrl, apiKey: 'node-key' });

        await expect(client.contracts.deploy(forecast, { description: 'A forecast' })).resolves.toMatchObject({ path: 'com.example', name: 'Forecast', feeMicroUsd: 0 });
        const contracts = [];
        for await (const contract of client.contracts.all()) contracts.push(contract);
        expect(contracts).toEqual([expect.objectContaining({ name: 'Forecast', description: 'A forecast', returnType: 'string', source: forecast })]);
        await expect(client.resources.get('com.example', 'Forecast')).resolves.toMatchObject({ functions: [{ name: 'run', kind: 'contract' }] });

        await client.contracts.delete('com.example.Forecast');
        await expect(client.contracts.list()).resolves.toEqual({ items: [], nextOffset: null });
    });
});
