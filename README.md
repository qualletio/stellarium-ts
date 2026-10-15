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

const weather: StellariumResource = {
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

| Variable              | Purpose                                                                                                                                                                         |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `BASE_URL`            | Public URL prefix stored on resources this node hosts. Peers call `{BASE_URL}/run`. Set it to this node's API prefix, for example `http://127.0.0.1:3000`. Do not include `/v1` |
| `SIGNING_PRIVATE_KEY` | The base64url encoded ED25519 private key used to sign data for publishing to peers.                                                                                            |
| `SIGNING_PUBLIC_KEY`  | The base64url ED25519 public key used to verify data for publishing to peers. Must be paired with the private key.                                                              |

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

### Joining a network

When `startingPeer` is set, the node waits until it is listening, then:

1. `GET {startingPeer}/v1/peers`. If this node has no peers yet, it stores the returned list. An existing list is left as-is.
2. `GET {startingPeer}/v1/resources`. Each resource is stored with the `baseUrl` that peer advertised.
3. Broadcasts self to all peers in the network.
4. Broadcasts its internal Resources to the network.

A script that names a resource registered on this process runs `exec` locally. A script that names a resource learned from a peer is forwarded: this node posts a RequestScript request to `{baseUrl}/run` and returns that peer's `returnValue`.

## HTTP API

Routes are mounted at `/v1`.

| Method and path     | Body        | Purpose                                                           |
| ------------------- | ----------- | ----------------------------------------------------------------- |
| `GET /v1/`          | —           | Liveness check. Responds `{ "hello": "world" }`                   |
| `GET /v1/peers`     | —           | Peers stored on this node: `{ "peers": [{ "baseUrl", "name" }] }` |
| `GET /v1/resources` | —           | Resources registered here and resources learned from peers        |
| `POST /v1/run`      | JSON string | Run one `request` script                                          |

`GET /v1/resources` returns each resource's `path`, `name`, `baseUrl`, and functions (`name`, `returnType`, `parameters`). Function implementations stay on the node that hosts them.

`POST /v1/run` accepts the script source as raw text (`Content-Type: text/plain`). The declaration must be a `request`. A successful run responds `200` with the response body in `application/json` format `{ "returnValue": ... }`. A script that is not a request responds `400` with `{ "error": "Invalid script" }`. Any other failure responds `500` with `{ "error": "Internal server error" }`.

```sh
curl -X POST http://127.0.0.1:3000/v1/run \
  -H 'Content-Type: text/plain' \
  -d '"request GetTemperature {\n  const weather: com.example.Weather\n\n  return weather.temperature(city: \"Oslo\")\n}"'
```

```json
{ "returnValue": 12 }
```

Resources are bound with `const <name>: <path>.<ResourceName>` and called with named arguments. See the [RequestScript readme](https://www.npmjs.com/package/requestscript) for the language.

## Developing

This repository uses `pnpm` and is organized as a monorepo.

For local Solana, PostgreSQL, operator, and paid two-node testing, see the
[local end-to-end runbook](docs/local-e2e.md). It includes the current source
blockers, local identity and secret setup, and transaction/balance verification.

### Modules

- packages/stellarium-ts: the main package for stellarium-ts, helps run a Stellarium node using Typescript.
- apps/operator: the centralized operator that interacts with the Solana blockchain and stores receipt records.
- apps/local-caller-node: a node for running locally that has no resources. Syncs to the local-resource-node.
- apps/local-resource-node: a node for running locally with a monetized resource.

```sh
pnpm install
pnpm build   # tsc to dist/; also runs before pack
pnpm dev     # reload src/server.ts when it changes
```

`pnpm build` emits `dist/`, which is what the package exports. Start a node from your own process with `StellariumNode`, as shown above.

### Running Locally

Install Solana using their guide: https://solana.com/docs/intro/installation

Start the local validator in its own terminal.

```sh
solana-test-validator
```

Point the Solana CLI at your localnet:

```sh
solana config set -ul
```

Generate Keys for Solana:

```sh
umask 077
mkdir -p .keys/local-e2e
solana-keygen new --no-bip39-passphrase --silent --outfile .keys/local-e2e/operator.json
solana-keygen new --no-bip39-passphrase --silent --outfile .keys/local-e2e/program.json
solana-keygen new --no-bip39-passphrase --silent --outfile .keys/local-e2e/recipient.json
solana-keygen new --no-bip39-passphrase --silent --outfile .keys/local-e2e/protocol-fee.json

node --input-type=module <<'JS'
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(new URL('./apps/operator/package.json', `file://${process.cwd()}/`));
const { PublicKey, Keypair } = require('@solana/web3.js');
const address = name => Keypair.fromSecretKey(Uint8Array.from(JSON.parse(
  readFileSync(`.keys/local-e2e/${name}.json`, 'utf8')))).publicKey.toBase58();
const common = {
  SOLANA_RPC_URL: 'http://127.0.0.1:8899',
  ESCROW_PROGRAM_ID: address('program'),
  AUTHORITY_ADDRESS: address('operator'),
  RECIPIENT_ADDRESS: address('recipient'),
  PROTOCOL_FEE_RECIPIENT: address('protocol-fee'),
};
for (const [role, port] of [['caller', 3000], ['provider', 3002]]) {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const spki = publicKey.export({ format: 'der', type: 'spki' });
  const raw = Buffer.from(publicKey.export({ format: 'jwk' }).x, 'base64url');
  const values = { ...common, BASE_URL: `http://127.0.0.1:${port}`,
    OPERATOR_URL: 'http://127.0.0.1:3001/v1',
    SIGNING_PUBLIC_KEY: spki.toString('base64url'),
    SIGNING_PRIVATE_KEY: privateKey.export({format: 'der', type: 'pkcs8'}).toString('base64url'),
    USER_ADDRESS: new PublicKey(raw).toBase58() };
  writeFileSync(`.keys/local-e2e/${role}.env`, Object.entries(values)
    .map(([key, value]) => `${key}=${value}`).join('\n') + '\n', { mode: 0o600, flag: 'wx' });
}
const values = { ...common,
  DATABASE_URL: 'postgresql://stellarium:local-only-password@127.0.0.1:5433/stellarium',
  OPERATOR_API_TOKEN: randomBytes(32).toString('hex'),
  PRIVATE_KEY: readFileSync('.keys/local-e2e/operator.json', 'utf8').trim() };
writeFileSync('.keys/local-e2e/operator.env', Object.entries(values)
  .map(([key, value]) => `${key}=${value}`).join('\n') + '\n', { mode: 0o600, flag: 'wx' });
console.log('Local fixture configuration written; no secrets printed.');
JS
```

Generate a caller wallet that funds the user's escrow:

```sh
solana-keygen new --no-bip39-passphrase --silent --outfile .keys/local-e2e/caller.json
```

Configure the escrow program. The operator key is the escrow authority: it signs
escrow setup and withdrawals and is the program's upgrade authority. Each escrow
withdrawal pays 20% of the amount to the protocol fee wallet and the remaining
80% to the resource provider. Print both addresses:

```sh
solana-keygen pubkey .keys/local-e2e/operator.json
solana-keygen pubkey .keys/local-e2e/protocol-fee.json
```

In `programs/escrow_program/src/lib.rs`, set both constants to those addresses:

```rust
pub const ESCROW_AUTHORITY: Option<Pubkey> =
    Some(solana_program::pubkey!("YOUR_OPERATOR_ADDRESS"));
pub const PROTOCOL_FEE_RECIPIENT: Option<Pubkey> =
    Some(solana_program::pubkey!("YOUR_PROTOCOL_FEE_ADDRESS"));
```

If `ESCROW_AUTHORITY` is unset, setup and withdrawals fail with custom program
error `0`; if it is a different wallet than the operator, they fail with error `1`.
If `PROTOCOL_FEE_RECIPIENT` is unset, withdrawals fail with error `2`.

Build the Escrow program:

```sh
cargo build-sbf --manifest-path programs/escrow_program/Cargo.toml \
  --sbf-out-dir programs/escrow_program/target/deploy
```

Fund the wallets. The operator pays for the program deploy and escrow setup. The
recipient and protocol fee wallets are prefunded so small payments don't fail the
rent check on a new account:

```sh
solana airdrop 100 "$(solana-keygen pubkey .keys/local-e2e/operator.json)"
solana airdrop 5 "$(solana-keygen pubkey .keys/local-e2e/caller.json)"
solana airdrop 1 "$(solana-keygen pubkey .keys/local-e2e/recipient.json)"
solana airdrop 1 "$(solana-keygen pubkey .keys/local-e2e/protocol-fee.json)"
```

Deploy the Escrow program with the operator as fee payer and upgrade authority:

```sh
solana program deploy \
  --keypair .keys/local-e2e/operator.json \
  --upgrade-authority .keys/local-e2e/operator.json \
  --program-id .keys/local-e2e/program.json \
  programs/escrow_program/target/deploy/escrow_program.so
solana program show "$(solana-keygen pubkey .keys/local-e2e/program.json)"
```

The program ID is the address of `.keys/local-e2e/program.json`. Its upgrade
authority should be the operator address.

Create a `.env` file in each app directory. The generated files in
`.keys/local-e2e/` (`operator.env`, `caller.env`, `provider.env`) hold the
values to copy.

`apps/local-caller-node/.env`:

```
SIGNING_PUBLIC_KEY=
SIGNING_PRIVATE_KEY=
USER_ADDRESS=
PORT=
API_KEY=SET_THIS_TO_ANYTHING
```

`apps/local-resource-node/.env`:

```
SIGNING_PUBLIC_KEY=
SIGNING_PRIVATE_KEY=
USER_ADDRESS=
RECIPIENT_ADDRESS=
PORT=
API_KEY=SET_THIS_TO_ANYTHING
```

`apps/operator/.env`:

```
ESCROW_PROGRAM_ID=
PROTOCOL_FEE_RECIPIENT=
PRIVATE_KEY=
PORT=
```

`PROTOCOL_FEE_RECIPIENT` must be the same address compiled into the escrow program.
If it doesn't match, withdrawals fail with custom program error `3`.

Start the services:

```sh
docker compose up -d --build
```

Initialize an escrow account:

POST to `http://localhost:3001/v1/escrow`

request body:

```json
{
  "user": "YOUR_USER_ADDRESS"
}
```

Copy the escrow address value:

```json
{
  "escrowAddress": "ESCROW_ADDRESS",
  "signature": "SIGNATURE",
  "blockhash": "BLOCKHASH",
  "lastValidBlockHeight": 1111,
  "status": "confirmed"
}
```

Fund the escrow address:

```sh
ESCROW_ADDRESS=YOUR_ESCROW_ADDRESS
solana transfer "$ESCROW_ADDRESS" 0.1 \
  --from .keys/local-e2e/caller.json \
  --fee-payer .keys/local-e2e/caller.json \
  --allow-unfunded-recipient
```

Run a request. If it fails, check each `.env` file, then rerun `docker compose up -d --build`.

POST `localhost:3003/v1/run`

Authorization header: `Bearer YOUR_CALLER_API_KEY`

```json
{
  "source": "request MyRequest { \n\n const weather: com.example.Weather \n\n return weather.temperature(city: \"Oslo\") }"
}
```

### Contributing

Stellarium has a backlog [here](https://github.com/orgs/qualletio/projects/7/views/1)

If you change the Operator db schema, you need to generate the migrations before making a PR:

```sh
cd apps/operator
DATABASE_URL='postgresql://stellarium:local-only-password@127.0.0.1:5432/stellarium' pnpm exec drizzle-kit generate
```

### Publishing

The `stellarium-ts` package can be published to npm with the command:

```sh
pnpm --filter stellarium-ts publish
```
