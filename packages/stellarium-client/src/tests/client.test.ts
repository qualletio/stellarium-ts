import { describe, expect, test, vi } from 'vitest';
import { ClientCredentials, StellariumClient, StellariumError } from '../index.js';

interface Recorded {
    url: string;
    method: string;
    headers: Record<string, string>;
    body?: string;
}

/** A fetch that records each request and answers from `handler`. */
function fakeFetch(handler: (request: Recorded, index: number) => Response | Promise<Response>) {
    const requests: Recorded[] = [];
    const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const request: Recorded = {
            url: String(input),
            method: init?.method ?? 'GET',
            headers: { ...(init?.headers as Record<string, string>) },
            body: init?.body as string | undefined,
        };
        requests.push(request);
        return handler(request, requests.length - 1);
    });
    return { fetch: fetch as unknown as typeof globalThis.fetch, requests };
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const tokenResponse = (token: string, expiresIn = 300) => json({ access_token: token, token_type: 'Bearer', expires_in: expiresIn });

describe('StellariumClient', () => {
    test('runs a script with the API key', async () => {
        const { fetch, requests } = fakeFetch(() => json({ returnValue: 12, usage: { tokens: 17 } }));
        const client = new StellariumClient({ nodeUrl: 'https://node.example/', apiKey: 'secret', fetch });

        await expect(client.run('request A { return 12 }')).resolves.toEqual({ returnValue: 12, usage: { tokens: 17 } });
        expect(requests).toEqual([{
            url: 'https://node.example/v1/run',
            method: 'POST',
            headers: { Accept: 'application/json', Authorization: 'Bearer secret', 'Content-Type': 'application/json' },
            body: JSON.stringify({ source: 'request A { return 12 }' }),
        }]);
    });

    test('accepts a node URL that already ends in /v1', () => {
        expect(new StellariumClient({ nodeUrl: 'http://localhost:3000/v1/' }).nodeUrl).toBe('http://localhost:3000');
    });

    test('refuses conflicting or missing credentials', () => {
        expect(() => new StellariumClient({ nodeUrl: 'https://node.example', apiKey: 'a', token: 'b' } as never)).toThrow(/not apiKey and token/);
        expect(() => new StellariumClient({ nodeUrl: 'node.example' })).toThrow(/nodeUrl/);
    });

    test('needs credentials only for authenticated routes', async () => {
        const { fetch, requests } = fakeFetch(() => json({ baseUrl: 'https://node.example', publicKey: 'key', name: 'https://node.example' }));
        const client = new StellariumClient({ nodeUrl: 'https://node.example', fetch });

        await expect(client.self()).resolves.toMatchObject({ publicKey: 'key' });
        expect(requests[0]?.headers.Authorization).toBeUndefined();
        await expect(client.run('request A { return 1 }')).rejects.toThrow(/needs credentials/);
    });

    test('exchanges client credentials for a run token and caches it', async () => {
        const { fetch, requests } = fakeFetch((request) => request.url.endsWith('/oauth/token')
            ? tokenResponse('jwt-1')
            : json({ returnValue: null, usage: { tokens: 3 } }));
        const client = new StellariumClient({
            nodeUrl: 'https://node.example',
            clientId: 'cli_1',
            clientSecret: 'cs_1',
            operatorUrl: 'https://operator.example',
            fetch,
        });

        await Promise.all([client.run('request A { }'), client.run('request A { }')]);
        await client.run('request A { }');

        const tokenRequests = requests.filter((request) => request.url.endsWith('/oauth/token'));
        expect(tokenRequests).toHaveLength(1);
        expect(tokenRequests[0]).toMatchObject({
            url: 'https://operator.example/v1/oauth/token',
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: 'grant_type=client_credentials&client_id=cli_1&client_secret=cs_1',
        });
        expect(requests.filter((request) => request.url.endsWith('/v1/run')).map((request) => request.headers.Authorization))
            .toEqual(['Bearer jwt-1', 'Bearer jwt-1', 'Bearer jwt-1']);
    });

    test('fetches a new run token once the cached one is about to expire', async () => {
        vi.useFakeTimers();
        try {
            let issued = 0;
            const { fetch } = fakeFetch(() => tokenResponse(`jwt-${++issued}`, 300));
            const credentials = new ClientCredentials({ operatorUrl: 'https://operator.example/v1', clientId: 'cli_1', clientSecret: 'cs_1', fetch });

            expect(await credentials.credential()).toBe('jwt-1');
            vi.advanceTimersByTime(200_000);
            expect(await credentials.credential()).toBe('jwt-1');
            // Within the 60-second margin of the five-minute token's expiry.
            vi.advanceTimersByTime(50_000);
            expect(await credentials.credential()).toBe('jwt-2');
        } finally {
            vi.useRealTimers();
        }
    });

    test('gets run tokens from the Stellarium network\'s operator by default', async () => {
        const { fetch, requests } = fakeFetch((request) => request.url.endsWith('/oauth/token') ? tokenResponse('jwt-1') : json({ returnValue: null, usage: { tokens: 1 } }));
        const client = new StellariumClient({ nodeUrl: 'https://node.example', clientId: 'cli_1', clientSecret: 'cs_1', fetch });

        await client.run('request A { }');
        expect(requests[0]?.url).toBe('https://operator.stellarium.sh/v1/oauth/token');
    });

    test('retries once with a fresh run token when the node refuses one', async () => {
        let issued = 0;
        const { fetch, requests } = fakeFetch((request) => {
            if (request.url.endsWith('/oauth/token')) return tokenResponse(`jwt-${++issued}`);
            return request.headers.Authorization === 'Bearer jwt-1'
                ? json({ error: 'Invalid run token' }, 401)
                : json({ returnValue: 'ok', usage: { tokens: 1 } });
        });
        const client = new StellariumClient({ nodeUrl: 'https://node.example', clientId: 'cli_1', clientSecret: 'cs_1', operatorUrl: 'https://operator.example/v1', fetch });

        await expect(client.run('request A { }')).resolves.toMatchObject({ returnValue: 'ok' });
        expect(requests.map((request) => request.url.replace(/^https:\/\/[^/]+/, ''))).toEqual(['/v1/oauth/token', '/v1/run', '/v1/oauth/token', '/v1/run']);
    });

    test('does not retry a refused API key', async () => {
        const { fetch, requests } = fakeFetch(() => json({ error: 'Invalid API Key' }, 401));
        const client = new StellariumClient({ nodeUrl: 'https://node.example', apiKey: 'wrong', fetch });

        await expect(client.run('request A { }')).rejects.toMatchObject({ status: 401, error: 'Invalid API Key' });
        expect(requests).toHaveLength(1);
    });

    test('reports the operator refusing client credentials', async () => {
        const { fetch } = fakeFetch(() => json({ error: 'invalid_client', error_description: 'Invalid client credentials' }, 401));
        const client = new StellariumClient({ nodeUrl: 'https://node.example', clientId: 'cli_1', clientSecret: 'cs_bad', operatorUrl: 'https://operator.example/v1', fetch });

        const error = await client.run('request A { }').catch((caught: unknown) => caught);
        expect(error).toBeInstanceOf(StellariumError);
        expect(error).toMatchObject({ status: 401, error: 'invalid_client', details: 'Invalid client credentials', message: 'invalid_client: Invalid client credentials' });
    });

    test('reports a script failure with what it executed', async () => {
        const { fetch } = fakeFetch(() => json({ error: 'Script failed', details: 'Division by zero', usage: { tokens: 9 } }, 422));
        const client = new StellariumClient({ nodeUrl: 'https://node.example', apiKey: 'secret', fetch });

        const error = await client.run('request A { return 1 / 0 }').catch((caught: unknown) => caught) as StellariumError;
        expect(error.isScriptFailure).toBe(true);
        expect(error).toMatchObject({ status: 422, error: 'Script failed', details: 'Division by zero', usage: { tokens: 9 } });
    });

    test('reports a response that is not JSON', async () => {
        const { fetch } = fakeFetch(() => new Response('upstream timed out', { status: 504, statusText: 'Gateway Timeout' }));
        const client = new StellariumClient({ nodeUrl: 'https://node.example', fetch });

        await expect(client.self()).rejects.toMatchObject({ status: 504, error: 'Gateway Timeout', details: 'upstream timed out' });
    });

    test('pages through a list', async () => {
        const { fetch, requests } = fakeFetch((request) => {
            const offset = Number(new URL(request.url).searchParams.get('offset'));
            return offset === 0
                ? json({ resources: [{ path: 'a', name: 'One', functions: [] }], nextOffset: 100 })
                : json({ resources: [{ path: 'a', name: 'Two', functions: [] }], nextOffset: null });
        });
        const client = new StellariumClient({ nodeUrl: 'https://node.example', fetch });

        const names: string[] = [];
        for await (const resource of client.resources.all()) names.push(resource.name);
        expect(names).toEqual(['One', 'Two']);
        expect(requests.map((request) => request.url)).toEqual([
            'https://node.example/v1/resources?offset=0&limit=100',
            'https://node.example/v1/resources?offset=100&limit=100',
        ]);

        await expect(client.resources.get('a', 'Two')).resolves.toMatchObject({ name: 'Two' });
        await expect(client.resources.get('a', 'Three')).resolves.toBeUndefined();
        await expect(client.resources.list({ limit: 5 })).resolves.toEqual({ items: [{ path: 'a', name: 'One', functions: [] }], nextOffset: 100 });
    });

    test('encodes references in paths', async () => {
        const { fetch, requests } = fakeFetch((request) => request.method === 'DELETE' ? json({ success: true }) : json({ variables: [] }));
        const client = new StellariumClient({ nodeUrl: 'https://node.example', apiKey: 'secret', fetch });

        await client.contracts.delete('com.example.Counter@1.0.0');
        await client.contracts.state('com.example.Counter');
        expect(requests.map((request) => request.url)).toEqual([
            'https://node.example/v1/contracts/com.example.Counter%401.0.0',
            'https://node.example/v1/contracts/com.example.Counter/state',
        ]);
    });

    test('answers undefined for a struct the node does not know', async () => {
        const { fetch } = fakeFetch(() => json({ error: 'No struct com.example.Point@1' }, 404));
        const client = new StellariumClient({ nodeUrl: 'https://node.example', fetch });

        await expect(client.structs.get('com.example.Point@1')).resolves.toBeUndefined();
    });
});
