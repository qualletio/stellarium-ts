# stellarium-client

A TypeScript client for the Stellarium network. It runs [RequestScript](https://www.npmjs.com/package/requestscript) on a node, reads what the node knows of the network, and deploys contracts, event types and structs. It has no dependencies and uses the global `fetch`, so it runs in Node 20+, Deno, Bun, edge runtimes and browsers.

```sh
npm install stellarium-client
```

## Running a script

An API client from the [Stellarium Platform](https://platform.stellarium.sh)'s **API clients** page belongs to one node. The client exchanges its id and secret for run tokens at the operator (`https://operator.stellarium.sh/v1` unless you pass `operatorUrl`), caches them and renews them before they expire. Runs are billed to the client's organization.

```ts
import { StellariumClient, StellariumError } from 'stellarium-client';

const client = new StellariumClient({
    nodeUrl: 'https://node.example.com',
    clientId: process.env.STELLARIUM_CLIENT_ID!,
    clientSecret: process.env.STELLARIUM_CLIENT_SECRET!,
});

try {
    const { returnValue, usage } = await client.run(`
        request GetTemperature {
            const weather: com.example.Weather
            return weather.temperature(city: "Oslo")
        }
    `);
    console.log(returnValue, `${usage.tokens} tokens`);
} catch (error) {
    if (error instanceof StellariumError && error.isScriptFailure) {
        console.error('The script failed:', error.details);
    } else {
        throw error;
    }
}
```

Other ways to authenticate:

| Option | Use |
| --- | --- |
| `apiKey` | The node's own `API_KEY`. Runs are free, and the node's organization pays their calls. |
| `token` | A run token you got elsewhere, or a function `(signal) => string \| Promise<string>` returning one. |
| `clientId`, `clientSecret`, optional `operatorUrl` | An organization's API client, as above. For a local network, pass your operator, such as `http://127.0.0.1:3001/v1`. |
| `credentials` | Any `CredentialSource`. |

Without any of them, the client can still use the routes anyone may call: `self`, `resources`, `peers`, `contracts.list`, `events.list` and `structs`.

## Reading the network

Lists are paged. `list()` returns one page (`{ items, nextOffset }`), and `all()` iterates every item.

```ts
for await (const resource of client.resources.all()) {
    console.log(`${resource.path}.${resource.name}`, resource.functions.map((fn) => fn.name));
}

const weather = await client.resources.get('com.example', 'Weather');
const peers = await client.peers.list({ limit: 20 });
const point = await client.structs.get('com.example.Point@1'); // undefined if the node doesn't know it
```

## Deploying

```ts
await client.contracts.deploy(source, { description: 'Forecasts by city' });
const variables = await client.contracts.state('com.example.Counter');
await client.contracts.delete('com.example.Counter@1.0.0');

await client.events.deploy('event com.example.Signup(email: string)');
await client.structs.deploy('struct com.example.Point@1(x: int32, y: int32)');
```

Deploying with another organization's API client pays the node's contract deploy fee, which the response reports as `feeMicroUsd`. All amounts are integer micro-USD (1 USD = 1,000,000).

## Errors

Every refused request throws a `StellariumError` with the HTTP `status`, the server's `error` and, when given, `details`:

| Status | Meaning |
| --- | --- |
| 400 | The script doesn't parse, or the request is malformed. |
| 401 | The API key, run token or client credentials were refused. A refused run token is renewed and the request retried once. |
| 402, 403 | The operator wouldn't bill the run: an insufficient balance, a frozen organization, a revoked node, or the client's limits. |
| 422 | The script failed while running. `usage.tokens` says what it executed, which is still charged. |
| 503 | The node couldn't reach the operator. |

Pass `{ signal }` to any method to cancel it, for example `client.run(source, { signal: AbortSignal.timeout(10_000) })`.
