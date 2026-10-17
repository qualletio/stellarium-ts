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

| Option              | Default                               | Purpose                                                                 |
| ------------------- | ------------------------------------- | ----------------------------------------------------------------------- |
| `port`              | `3000`                                | Port Fastify listens on                                                 |
| `host`              | `0.0.0.0`                             | Interface Fastify listens on                                            |
| `startingPeer`      | none                                  | Origin of a peer to bootstrap from, with no `/v1` suffix                |
| `rateLimit`         | 100 per minute                        | Per-IP limit on `POST /v1/run/resource`                                 |
| `baseUrl`           | `BASE_URL`                            | URL peers use to reach this node                                        |
| `publicKey`         | `SIGNING_PUBLIC_KEY`                  | This node's signing public key                                          |
| `privateKey`        | `SIGNING_PRIVATE_KEY`                 | This node's signing private key                                         |
| `apiKey`            | `API_KEY`                             | Bearer token for `POST /v1/run`                                         |
| `operatorUrl`       | `OPERATOR_URL`                        | Operator to settle payments with                                        |
| `costLimitLamports` | `COST_LIMIT_LAMPORTS`, then `10000`   | Most this node pays for one remote call                                 |
| `databasePath`      | `./requestscript.db`                  | SQLite file. `:memory:` keeps everything in memory                      |

`start` resolves once the node is listening and, with `startingPeer`, once it has joined the network. It rejects if it can't listen, if a required setting is missing, or if bootstrapping fails.

Importing `StellariumNode` loads [dotenv](https://github.com/motdotla/dotenv), so a `.env` file in the working directory is applied automatically. Options take precedence over these variables.

| Variable              | Purpose                                                                                                                                                                         |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `BASE_URL`            | Required. Public URL prefix stored on resources this node hosts. Peers call `{BASE_URL}/v1/run/resource`. Set it to this node's origin, for example `http://127.0.0.1:3000`. Do not include `/v1` |
| `SIGNING_PRIVATE_KEY` | Required. The base64url encoded ED25519 private key used to sign data for publishing to peers and payment vouchers.                                                            |
| `SIGNING_PUBLIC_KEY`  | Required. The base64url ED25519 public key used to verify data for publishing to peers. Must be paired with the private key.                                                   |
| `API_KEY`             | Bearer token for `POST /v1/run`. When unset, `/v1/run` rejects every request.                                                                                                   |
| `OPERATOR_URL`        | Operator base URL including `/v1`. Required when the node hosts paid functions.                                                                                                 |
| `COST_LIMIT_LAMPORTS` | Most this node pays for one remote call.                                                                                                                                        |

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

The node stores peers and resources it learns from other nodes in `requestscript.db` in the current working directory (or `databasePath`). That file is created on startup and reused on restart. Learned resources are a cache: after an upgrade that changes their tables, they are dropped and relearned from peers.

### Joining a network

When `startingPeer` is set, the node waits until it is listening, then:

1. `GET {startingPeer}/v1/self`, then every page of `GET {startingPeer}/v1/peers`. Peers this node doesn't know yet are stored, along with the starting peer. Known peers are left alone, so this is safe on every restart, and a run cut off partway through completes on the next one.
2. Every page of `GET {startingPeer}/v1/resources`. Resources this node doesn't know yet are stored with the `baseUrl` that peer advertised. Known resources are left alone.
3. Announces itself to every peer with `PUT /v1/peers`, signed over `{ baseUrl, name, publicKey, expiry }`.
4. Broadcasts its own resources to every peer with `PUT /v1/all-resources`, signed over `{ resources, expiry }`.

A peer that fails to respond to a broadcast is logged and skipped. Signed broadcasts must expire within an hour.

A peer announcement must be signed by the key it announces. A known peer can change its base URL and name. A new key can't take a base URL or name that another peer holds (`409`). A resource broadcast is accepted only from a known peer, and only for resources served from that peer's own base URL that no other peer owns. Other resources are listed in the response's `rejected` field. An accepted resource replaces what was stored for it, including its functions and prices.

A script that names a resource registered on this process runs `exec` locally. A script that names a resource learned from a peer is forwarded: this node posts the call to `{baseUrl}/v1/run/resource` and returns that peer's `{ value, error }` result. Paid functions are covered in [Payments](#payments).

## HTTP API

Routes are mounted at `/v1`.

| Method and path          | Body                       | Purpose                                                                       |
| ------------------------ | -------------------------- | ----------------------------------------------------------------------------- |
| `GET /v1/`               | —                          | Liveness check. Responds `{ "hello": "world" }`                               |
| `GET /v1/self`           | —                          | This node: `{ "baseUrl", "publicKey", "name" }`                               |
| `GET /v1/peers`          | —                          | One page of peers stored on this node: `{ "peers": [{ "baseUrl", "name", "publicKey" }], "nextOffset" }` |
| `PUT /v1/peers`          | Signed peer announcement   | Add or update a peer                                                          |
| `GET /v1/resources`      | —                          | One page of resources registered here, then resources learned from peers: `{ "resources", "nextOffset" }` |
| `PUT /v1/all-resources`  | Signed resource broadcast  | Store a peer's resources                                                      |
| `POST /v1/run`           | `{ "source": "..." }`      | Run one `request` script. Requires `Authorization: Bearer <API_KEY>`          |
| `POST /v1/run/resource`  | One function call          | Called by peers to run a function hosted here                                 |
| `POST /v1/grants/request`| Signed grant request       | Ask for a new grant, decided by the node's `approveGrant` hook: `{ "grants" }` |
| `POST /v1/grants/renew`  | Signed renewal request     | Re-issue a grant this node issued to its audience: `{ "grants" }`             |
| `PUT /v1/admin/revoked-grants/:grantId` | — | Revoke a grant. Requires the API key                                  |
| `GET /v1/admin/blocked-callers` | —                   | One page of blocked caller keys: `{ "callers": [{ "publicKey", "reason", "blockedAt" }], "nextOffset" }`. Requires the API key |
| `PUT /v1/admin/blocked-callers/:publicKey` | Optional `{ "reason" }` | Block a caller key. Requires the API key                          |
| `DELETE /v1/admin/blocked-callers/:publicKey` | —     | Unblock a caller key (`404` if not blocked). Requires the API key             |

`GET /v1/peers`, `GET /v1/resources` and `GET /v1/admin/blocked-callers` are paginated with `?offset=` (default `0`) and `?limit=` (default `100`, at most `500`). `nextOffset` is the `offset` of the next page, or `null` on the last page.

`GET /v1/resources` returns each resource's `path`, `name`, `baseUrl`, and functions (`name`, `returnType`, `parameters`, `paymentManifest` for paid functions, and `restricted: true` for functions that need a grant). Function implementations stay on the node that hosts them.

`POST /v1/run` takes a JSON body whose `source` is the script. The declaration must be a `request`. A successful run responds `200` with `{ "returnValue": ... }`. Each resource call in the script evaluates to `{ "value", "error" }`, so a script can handle a failed call. A missing or wrong API key responds `401`. A script that doesn't parse, or is not a request, responds `400` with `{ "error": "Invalid script" }`. Any other failure responds `500` with `{ "error": "Internal server error" }`.

```sh
curl -X POST http://127.0.0.1:3000/v1/run \
  -H 'Content-Type: application/json' \
  -H "Authorization: Bearer $API_KEY" \
  -d '{"source": "request GetTemperature {\n  const weather: com.example.Weather\n\n  return weather.temperature(city: \"Oslo\")\n}"}'
```

```json
{ "returnValue": { "value": 12, "error": null } }
```

### Payments

A function with a `paymentManifest` (`costLamports`, `recipientAddress`) is paid. A caller attaches a `paymentVoucher` signed with its key, as long as the cost is within its `costLimitLamports`. The hosting node runs the function only if the voucher:

- is bound to this exact call (resource, function and parameters),
- pays at least `costLamports` to `recipientAddress`,
- has not expired, and
- has a valid signature.

A paid call without a voucher responds `402`; an invalid voucher responds `400`. After the function runs without an error, the node sends the voucher to the operator to settle. Vouchers sent to free functions are ignored.

### Restricted functions and grants

A function with `restricted: true` runs only for callers holding a **grant** from the hosting node. A grant is a signed statement that one key may call some functions until an expiry. Its holder can **delegate** a narrower grant to another key, and the caller sends the whole chain with each call. The hosting node checks the chain's signatures without looking up the caller. It refuses a restricted call without an authorization, or with an invalid one, with `403`. It checks this before the payment voucher.

```ts
// On the provider: grant a caller access to every function of com.example.Weather for a day.
const chain = await provider.issueGrant(callerPublicKey, [{ resourcePath: 'com.example', resourceName: 'Weather' }], { lifetimeMs: 24 * 60 * 60 * 1000 });

// On the caller: store it, or pass it at start with `grants: [chain]`.
await caller.addGrant(chain);

// The caller may hand a narrower grant on, for example one function and one parameter value.
const delegated = await caller.delegateGrant(chain[0].id, otherPublicKey, [{ resourcePath: 'com.example', resourceName: 'Weather', functionName: 'temperature', constraints: { city: 'Oslo' } }], { lifetimeMs: 60 * 60 * 1000 });

// Refuse the grant, and everything delegated from it, in calls to the provider.
await provider.revokeGrant(chain[0].id);
```

A provider can also let callers ask for grants. Its `approveGrant` hook decides each signed request. The hook gets the caller's key, the capabilities it asked for, and any `details` (such as an invite code). It returns the grant's options, optionally with narrower capabilities, or `undefined` to refuse. Each signed request reaches the hook at most once. Without a hook, the node refuses every request. When the hook is set, a `403` for a restricted call includes `grantEndpoint`, so a caller knows where to ask.

```ts
await provider.start(fastify, {
    approveGrant: ({ publicKey, capabilities, details }) =>
        details?.invite === process.env.INVITE_CODE ? { lifetimeMs: 24 * 60 * 60 * 1000 } : undefined,
});

// On the caller. Throws if refused; otherwise stores the grant, which is then renewed like any other.
await caller.requestGrant('https://provider.example', [{ resourcePath: 'com.example', resourceName: 'Weather' }], { invite: 'letmein' });
```

#### Revoking grants and blocking callers

The `/v1/admin` routes take the same `Authorization: Bearer <API_KEY>` as `/v1/run`. The same actions are available in code as `revokeGrant`, `blockCaller` and `unblockCaller`.

```sh
# Revoke one grant, and everything delegated from it.
curl -X PUT "http://127.0.0.1:3000/v1/admin/revoked-grants/$GRANT_ID" -H "Authorization: Bearer $API_KEY"

# Block a caller's key, and lift the block later.
curl -X PUT "http://127.0.0.1:3000/v1/admin/blocked-callers/$CALLER_KEY" \
  -H "Authorization: Bearer $API_KEY" -H 'Content-Type: application/json' -d '{"reason": "abuse"}'
curl -X DELETE "http://127.0.0.1:3000/v1/admin/blocked-callers/$CALLER_KEY" -H "Authorization: Bearer $API_KEY"
```

A blocked key is refused wherever the node can identify a caller:
- in restricted calls, at any position in the grant chain, so blocking a delegator also cuts off the grants it handed on
- in grant renewals and grant requests
- in paid calls, where the voucher carries the payer's key (`403 Caller is blocked`).

Unrestricted free functions stay open to everyone, since their callers are anonymous. Unblocking restores access, and a held grant that expired while blocked is renewed on the next call. Revocation, unlike blocking, is permanent.

A capability's `resourcePath` is exact, a prefix such as `com.example.*`, or `*`. An omitted `resourceName` or `functionName` matches any, and each constraint requires that parameter to equal the given value.

A grant lasts at most 30 days, and a chain holds at most four grants. Each node renews its held grants in the background, once they are past half their lifetime (checked every `grantRefreshIntervalMs`, 5 minutes by default), so calls don't wait on renewal. A grant keeps its `id` across renewals, and `renewableUntil` ends renewal at a given time. A revocation at the hosting node takes effect immediately. A delegator's revocation only stops renewal, so it takes effect when the current copy expires.

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
pnpm build         # tsc to dist/; also runs before pack
pnpm check-types   # after build: the operator checks against stellarium-ts's dist/ types
pnpm test          # vitest; the operator's database tests use in-memory PGlite, so no Postgres is needed
cargo test --manifest-path programs/escrow_program/Cargo.toml
```

`pnpm build` emits `dist/`, which is what the package exports. Start a node from your own process with `StellariumNode`, as shown above.

`apps/local-caller-node` and `apps/local-resource-node` depend on the workspace package (`workspace:*`), so they also run the compiled code in `dist/`, not `src/`. After editing `packages/stellarium-ts`, rebuild it with `pnpm --filter stellarium-ts build`, or keep `pnpm --filter stellarium-ts exec tsc --watch` running while you work.

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
OPERATOR_API_TOKEN=SET_THIS_TO_ANYTHING
```

`PROTOCOL_FEE_RECIPIENT` must be the same address compiled into the escrow program.
If it doesn't match, withdrawals fail with custom program error `3`.

Start the services:

```sh
docker compose up -d --build
```

Initialize an escrow account:

POST to `http://localhost:3001/v1/escrow`

Authorization header: `Bearer YOUR_OPERATOR_API_TOKEN`

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
