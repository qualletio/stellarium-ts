# stellarium-ts

TypeScript implementation of a Stellarium node.

## What is Stellarium?

Stellarium is a decentralized API platform built on the [RequestScript](https://github.com/qualletio/requestscript-js) programming language. Users run their own node(s) and share `Resources` and `Contracts` with peers.

This package is the node. You embed it in a Fastify server, register the RequestScript resources that live on this process, and optionally bootstrap peer and resource lists from a node that is already running.

Join us in the `Discussions` tab, or our discord: https://discord.gg/WWTWKmYWv6.

## Running a node

### Prerequisites

- Node.js 20+
- [Fastify](https://fastify.dev/) 5, which you create and pass to the node
- [RequestScript](https://www.npmjs.com/package/requestscript), which supplies the `Resource` type your node registers

Install the node and the packages your application imports directly:

```sh
npm install stellarium-ts fastify requestscript
```

### Register resources and start

A resource is a host object scripts can call. `path` and `name` form its fully qualified name (`com.example.Weather`). Each function declares RequestScript parameter and return types, and `exec` runs in this process.

Call `register` before `start`. `start` creates the SQLite database, mounts the HTTP API, and listens.

```typescript
import Fastify from "fastify";
import { StellariumNode } from "stellarium-ts";
import type { Resource } from "requestscript";

const weather: Resource = {
    metadata: {},
    path: "com.example",
    name: "Weather",
    functions: [
        {
            name: "temperature",
            parameters: [{ name: "city", type: "string" }],
            returnType: "int32",
            exec: async (args) => {
                const city = args.find((arg) => arg.name === "city")?.value;
                return city === "Oslo" ? 12 : 20;
            },
        },
    ],
};

const node = new StellariumNode();
await node.register(weather);

const fastify = Fastify({ logger: true });
await node.start(fastify, {
    port: 3000,
    // Omit this to run standalone. Set it to copy peers and resources
    // from a node that is already up.
    startingPeer: "http://127.0.0.1:3001",
});
```

`StellariumNodeOptions`:

| Option         | Default | Purpose                                                  |
| -------------- | ------- | -------------------------------------------------------- |
| `port`         | `3000`  | Port Fastify listens on                                  |
| `startingPeer` | none    | Origin of a peer to bootstrap from, with no `/v1` suffix |

Importing `StellariumNode` loads [dotenv](https://github.com/motdotla/dotenv), so a `.env` file in the working directory is applied automatically.

| Variable              | Purpose                                                                                                                                                                            |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `BASE_URL`            | Public URL prefix stored on resources this node hosts. Peers call `{BASE_URL}/v1/run`. Set it to this node's API prefix, for example `http://127.0.0.1:3000`. Do not include `/v1` |
| `SIGNING_PRIVATE_KEY` | The base64url encoded ED25519 private key used to sign data for publishing to peers.                                                                                               |
| `SIGNING_PUBLIC_KEY`  | The base64url ED25519 public key used to verify data for publishing to peers. Must be paired with the private key.                                                                 |

Signing keys can be generated with the following script:

```bash
node --input-type=module -e '
import { generateKeyPairSync } from "node:crypto";

const { publicKey, privateKey } = generateKeyPairSync("ed25519", {
  publicKeyEncoding: { type: "spki", format: "der" },
  privateKeyEncoding: { type: "pkcs8", format: "der" },
});

console.log(JSON.stringify({
  publicKey: publicKey.toString("base64url"),
  privateKey: privateKey.toString("base64url"),
}, null, 2));
'
```

The node stores peers and resources it learns from other nodes in `requestscript.db` in the current working directory. That file is created on startup.

### Paid resources and relay mode

SIP-1 adds explicit payment configuration, signed invocation grants, durable receipt delivery, and on-chain settlement. Applications configure the chain, all contract addresses, and execution authority. Register a paid resource with a second argument:

```typescript
await node.register(weather, {
    identitySigner: providerIdentity,
    receiptSigner: providerReceiptSigner,
    paymentRecipient: providerIdentity.address,
    grossPriceUsdc: 1_000_000n, // 1 USDC per function call
});
await node.start(fastify, {
    baseUrl: "https://provider.example",
    databasePath: "./provider.db",
    payments: { chain, executionSigner, evidenceKeys },
    relay: {
        signer: relaySigner,
        endpoint: "https://provider.example",
        relayFeeUsdc: 100_000n,
    },
});
```

`chain` is a `ViemChainAccess` with an explicit `ChainConfiguration`, public client, wallet client, and transaction account. Signers implement `ProtocolSigner`; backend applications can use `createPrivateKeySigner`. Persist `createEvidenceKeys()` output securely across restarts. Relay mode is optional and requires a sponsored, staked relay identity. A node may run only a relay without registering resources. Prices may instead be set per function with `functions: { temperature: 1_000_000n }`.

Quotes have no time expiry. Startup preserves unchanged manifests and publishes changed resource payment settings before serving requests. Nested Stellarium resource calls are unsupported. Peer bootstrap uses ED25519 signing keys and refreshes signed publications and relay advertisements every minute.

### HTTP requests

Every `/v1/run` request uses a versioned JSON object:

```sh
curl http://127.0.0.1:3000/v1/run \
  -H 'Content-Type: application/json' \
  -d '{"version":1,"kind":"request","source":"request GetTemperature { const weather: com.example.Weather return weather.temperature(city: \"Oslo\") }"}'
```

The response is `{ "returnValue": 12, "executions": [] }` for free calls. Paid requests add signed authorization and a private access proof; the SDK builds these envelopes. Forwarded calls use a structured invocation body. Raw text is no longer accepted.

### Caller SDK

Import browser-compatible caller functionality from `stellarium-ts/sdk`. Supply the application's existing viem wallet client; WalletConnect pairing and wallet connection UI belong to the application.

```typescript
import {
    StellariumClient,
    ViemChainAccess,
    walletSigner,
} from "stellarium-ts/sdk";

const chain = new ViemChainAccess(
    configuration,
    publicClient,
    walletClient,
    callerAddress,
);
const sdk = new StellariumClient(chain, walletSigner(chain, callerAddress));
// Show source, total budget, expiry, and executionAuthority in the app before signing.
const authorization = await sdk.authorize({
    source,
    budgetUsdc: 5_000_000n,
    executionAuthority,
    expiresAt: BigInt(Math.floor(Date.now() / 1000)) + 3600n,
    nonce: callerNonce, // Choose a nonce for which usedNonce(caller, nonce) is false.
});
// Deposit USDC first when available balance is insufficient.
const hash = await sdk.openRequest(authorization);
await publicClient.waitForTransactionReceipt({ hash });
const result = await sdk.run(
    "https://execution.example",
    source,
    authorization,
);
```

Caller acceptance is automatic after signature and response-hash validation. Construct `new StellariumClient(chain, signer, fetch, false)` to perform application-specific validation before calling `sdk.accept`. The SDK also provides deposits, withdrawals, budget closure, challenges, evidence delivery, and appeals. Use the next unused caller nonce; the vault exposes `usedNonce(caller, nonce)` rather than choosing nonces for the application.

The [implementation guide](docs/SIP-1-implementation.md) describes all wire fields, endpoints, accounting, arbitration deadlines, governance, recovery, and deployment setup. [Protocol vectors](docs/protocol-vectors.json) define canonical hashing and cross-language signatures.

## Developing

```sh
pnpm install
pnpm test              # node, protocol, SDK, encryption and HTTP tests
pnpm contracts:build   # pinned solc; artifacts, storage layouts, generated ABIs
pnpm build             # TypeScript package
pnpm vectors:check     # canonicalization and EIP-712 vectors
pnpm contracts:test    # Foundry contract tests and fuzzing
pnpm deploy:plan       # local plan only; no RPC requests or transactions
pnpm check             # all implementation checks
```

Install Foundry separately for contract tests. The included compiler wrapper uses npm's pinned solc; production compilation checks the EVM contract size limit. The example deployment configuration contains placeholder addresses. No live deployment occurs by default. Contracts require independent auditing and real Base Sepolia integration before Mainnet use.
