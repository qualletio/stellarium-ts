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
- [RequestScript](https://www.npmjs.com/package/requestscript), whose `Resource` type `StellariumResource` extends

Install the node and the packages your application imports directly:

```sh
npm install stellarium-ts fastify requestscript
```

### Register resources and start

A resource is a host object scripts can call. `path` and `name` form its fully qualified name (`com.example.Weather`). Each function declares RequestScript parameter and return types, and `exec` runs in this process.

Call `register` before `start`. `start` creates the SQLite database, mounts the HTTP API, and listens.

```typescript
import Fastify from "fastify";
import { StellariumNode, type StellariumResource } from "stellarium-ts";

const weather: StellariumResource = {
  id: 1,
  // Replaced by the node's own base URL when it announces its resources.
  baseUrl: "http://localhost:3000",
  metadata: {},
  path: "com.example",
  name: "Weather",
  website: "https://weather.example.com",
  description: "Current weather conditions",
  functions: [
    {
      name: "temperature",
      description: "Current temperature in degrees Celsius",
      parameters: [{ name: "city", type: "string", description: "City name, such as Oslo" }],
      returnType: "int32",
      exec: async (args) => {
        const city = args.find((arg) => arg.name === "city")?.value;
        return city === "Oslo" ? 12 : 20;
      },
    },
  ],
};

co......nst node = new StellariumNode();
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

| Option              | Default                             | Purpose                                                  |
| ------------------- | ----------------------------------- | -------------------------------------------------------- |
| `port`              | `3000`                              | Port Fastify listens on                                  |
| `host`              | `0.0.0.0`                           | Interface Fastify listens on                             |
| `startingPeer`      | none                                | Origin of a peer to bootstrap from, with no `/v1` suffix |
| `rateLimit`         | 100 per minute                      | Per-IP limit on `POST /v1/run/resource`                  |
| `baseUrl`           | `BASE_URL`                          | URL peers use to reach this node                         |
| `publicKey`         | `SIGNING_PUBLIC_KEY`                | This node's signing public key                           |
| `privateKey`        | `SIGNING_PRIVATE_KEY`               | This node's signing private key                          |
| `apiKey`            | `API_KEY`                           | Bearer token for `POST /v1/run` and the admin routes     |
| `operatorUrl`       | `OPERATOR_URL`                      | Operator that moves money for paid calls and issues [run tokens](#api-clients-and-run-tokens) |
| `enrollmentToken`   | `ENROLLMENT_TOKEN`                  | One-time token that enrolls this node in an organization ([Payments](#payments)) |
| `costLimitMicroUsd` | `COST_LIMIT_MICRO_USD`, then `10000` | Most this node pays for one remote call, in micro-USD    |
| `inferenceCostLimitMicroUsd` | `INFERENCE_COST_LIMIT_MICRO_USD`, then `costLimitMicroUsd` | Most this node signs for in one remote inference call (its voucher's `maxAmount`) |
| `contractCostLimitMicroUsd` | `CONTRACT_COST_LIMIT_MICRO_USD`, then `costLimitMicroUsd` | Most one call to a [contract](#contracts) on another node may cost, with the paid calls it makes (its voucher's `maxAmount`) |
| `contractDeployFeeMicroUsd` | `CONTRACT_DEPLOY_FEE_MICRO_USD`, then `0` | What another organization pays to deploy a [contract](#contracts) to this node |
| `maxContractSourceBytes` | `MAX_CONTRACT_SOURCE_BYTES`, then `65536` | Largest contract this node accepts |
| `maxContractStateBytes` | `MAX_CONTRACT_STATE_BYTES`, then `65536` | Most one contract's [state](#contract-state) may hold in one scope |
| `databasePath`      | `DATABASE_PATH`, then `./requestscript.db` | SQLite file. `:memory:` keeps everything in memory |
| `databaseUrl`       | `DATABASE_URL`                      | A `postgres://` or `postgresql://` URL. When set, the node uses [Postgres](#postgres) instead of SQLite, and `databasePath` must not be set |
| `databaseSchema`    | `DATABASE_SCHEMA`                   | Postgres schema for the node's tables, created if missing, so several nodes can share one database |

`start` resolves once the node is listening and, with `startingPeer`, once it has joined the network. It rejects if it can't listen, if a required setting is missing, or if bootstrapping fails.

Importing `StellariumNode` loads [dotenv](https://github.com/motdotla/dotenv), so a `.env` file in the working directory is applied automatically. Options take precedence over these variables.

| Variable              | Purpose                                                                                                                                                                                           |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `BASE_URL`            | Required. Public URL prefix stored on resources this node hosts. Peers call `{BASE_URL}/v1/run/resource`. Set it to this node's origin, for example `http://127.0.0.1:3000`. Do not include `/v1` |
| `SIGNING_PRIVATE_KEY` | Required. The base64url encoded ED25519 private key used to sign data for publishing to peers and payment vouchers.                                                                               |
| `SIGNING_PUBLIC_KEY`  | Required. The base64url ED25519 public key used to verify data for publishing to peers. Must be paired with the private key.                                                                      |
| `API_KEY`             | Bearer token for `POST /v1/run` and the `/v1/admin` routes. When unset, `/v1/run` accepts only run tokens, and the admin routes reject every request.                                          |
| `OPERATOR_URL`        | Operator base URL including `/v1`. Required when the node hosts paid functions, and to accept [run tokens](#api-clients-and-run-tokens).                                                         |
| `ENROLLMENT_TOKEN`    | One-time token from the [Stellarium Platform](https://platform.stellarium.sh) that enrolls this node in an organization at startup. Only needed until the node is enrolled.                       |
| `COST_LIMIT_MICRO_USD` | Most this node pays for one remote call, in micro-USD.                                                                                                                                          |
| `INFERENCE_COST_LIMIT_MICRO_USD` | Most this node signs for in one remote inference call, in micro-USD. Defaults to the cost limit.                                                                                    |
| `CONTRACT_COST_LIMIT_MICRO_USD` | Most one call to a contract on another node may cost, with the paid calls it makes, in micro-USD. Defaults to the cost limit.                                                       |
| `CONTRACT_DEPLOY_FEE_MICRO_USD` | What another organization pays to deploy a contract to this node, in micro-USD. Defaults to `0`.                                                                                     |
| `MAX_CONTRACT_STATE_BYTES` | Most one contract's state may hold in one scope, in bytes. Defaults to 64 KiB.                                                                                                         |
| `MAX_CONTRACT_SOURCE_BYTES` | Largest contract this node accepts. Defaults to 64 KiB.                                                                                                                                  |
| `DATABASE_PATH`       | SQLite file the node keeps peers, learned resources, grants and contracts in. Defaults to `./requestscript.db`. In a container, point it at a persistent volume, for example `/data/requestscript.db`. |
| `DATABASE_URL`        | A `postgres://` or `postgresql://` URL. When set, the node keeps its data in Postgres instead of SQLite. Don't set `DATABASE_PATH` too.                                                     |
| `DATABASE_SCHEMA`     | The Postgres schema the node's tables live in, created if missing. Lets several nodes share one database.                                                                                 |

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

| Method and path                               | Body                      | Purpose                                                                                                                        |
| --------------------------------------------- | ------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `GET /v1/`                                    | —                         | Liveness check. Responds `{ "hello": "world" }`                                                                                |
| `GET /v1/self`                                | —                         | This node: `{ "baseUrl", "publicKey", "name" }`                                                                                |
| `GET /v1/peers`                               | —                         | One page of peers stored on this node: `{ "peers": [{ "baseUrl", "name", "publicKey" }], "nextOffset" }`                       |
| `PUT /v1/peers`                               | Signed peer announcement  | Add or update a peer                                                                                                           |
| `GET /v1/resources`                           | —                         | One page of resources registered here, then resources learned from peers: `{ "resources", "nextOffset" }`                      |
| `PUT /v1/all-resources`                       | Signed resource broadcast | Store a peer's resources                                                                                                       |
| `POST /v1/run`                                | `{ "source": "..." }`     | Run one `request` script. Requires `Authorization: Bearer <API_KEY>` or a [run token](#api-clients-and-run-tokens)             |
| `POST /v1/run/resource`                       | One function call         | Called by peers to run a function hosted here                                                                                  |
| `POST /v1/run/resource/estimate`              | One function call         | Called by peers to price a call to a paid inference function hosted here: `{ "inputTokens", "maxAmount" }`                     |
| `POST /v1/contracts`                          | `{ "source", "description"? }` | Deploy a version of a [contract](#contracts). Requires the API key or a run token. Responds `201` with `{ "path", "name", "version", "feeMicroUsd" }` |
| `GET /v1/contracts`                           | —                         | One page of every contract version on this node, with its source: `{ "contracts", "nextOffset" }`                              |
| `DELETE /v1/contracts/:ref`                   | —                         | Delete `path.Name@version`, or every version of `path.Name` and its state. Requires the API key, or a run token from the owner's organization |
| `GET /v1/contracts/:ref/state`                | —                         | A contract's [state](#contract-state), every variable and scope: `{ "variables": [{ "name", "scope", "value", "updatedAt" }] }`. Requires the API key, or a run token from the owner's organization |
| `POST /v1/grants/request`                     | Signed grant request      | Ask for a new grant, decided by the node's `approveGrant` hook: `{ "grants" }`                                                 |
| `POST /v1/grants/renew`                       | Signed renewal request    | Re-issue a grant this node issued to its audience: `{ "grants" }`                                                              |
| `PUT /v1/admin/revoked-grants/:grantId`       | —                         | Revoke a grant this node issued, or another issuer's grant with `?issuer=<key>`. Requires the API key                          |
| `GET /v1/admin/blocked-callers`               | —                         | One page of blocked caller keys: `{ "callers": [{ "publicKey", "reason", "blockedAt" }], "nextOffset" }`. Requires the API key |
| `PUT /v1/admin/blocked-callers/:publicKey`    | Optional `{ "reason" }`   | Block a caller key. Requires the API key                                                                                       |
| `DELETE /v1/admin/blocked-callers/:publicKey` | —                         | Unblock a caller key (`404` if not blocked). Requires the API key                                                              |

`GET /v1/peers`, `GET /v1/resources`, `GET /v1/contracts` and `GET /v1/admin/blocked-callers` are paginated with `?offset=` (default `0`) and `?limit=` (default `100`, at most `500`). `nextOffset` is the `offset` of the next page, or `null` on the last page.

`GET /v1/resources` returns each resource's `path`, `name`, `baseUrl`, `website`, `description`, and functions (`name`, `returnType`, `description`, `parameters` with their `name`, `type` and `description`, `paymentManifest` for paid functions, `restricted: true` for functions that need a grant, `kind: "inference"` for [inference functions](#inference-functions), and `kind: "contract"` for [contracts](#contracts)). `website` and all descriptions are optional and appear only when the node registering the resource sets them. A node drops a description from a peer that isn't a string, and a `website` that isn't an `http` or `https` URL. Function implementations stay on the node that hosts them.

`POST /v1/run` takes a JSON body whose `source` is the script. The declaration must be a `request`. A successful run responds `200` with `{ "returnValue": ..., "usage": { "tokens": ... } }`, where `tokens` counts the [script tokens](https://github.com/qualletio/requestscript-js#token-metering) the run executed. Each resource call in the script evaluates to `{ "value", "error" }`, so a script can handle a failed call. A missing or wrong API key or run token responds `401`. A script that doesn't parse, or is not a request, responds `400` with `{ "error": "Invalid script" }`. A script that fails while running, for example dividing by zero, responds `422` with `{ "error": "Script failed", "details", "usage" }`. Any other failure responds `500` with `{ "error": "Internal server error" }`.

```sh
curl -X POST http://127.0.0.1:3000/v1/run \
  -H 'Content-Type: application/json' \
  -H "Authorization: Bearer $API_KEY" \
  -d '{"source": "request GetTemperature {\n  const weather: com.example.Weather\n\n  return weather.temperature(city: \"Oslo\")\n}"}'
```

```json
{ "returnValue": { "value": 12, "error": null }, "usage": { "tokens": 17 } }
```

### API clients and run tokens

Anyone can run scripts on a node without knowing its API key, using an **API client** from the [Stellarium Platform](https://platform.stellarium.sh). An organization creates a client for one node: one of its own, or another organization's **listed** node. A listed node sets a price per million script tokens, or is free. A client exchanges its id and secret for a run token, which lasts 15 minutes:

```sh
curl -X POST "$OPERATOR_URL/oauth/token" \
  -d grant_type=client_credentials -d client_id="$CLIENT_ID" -d client_secret="$CLIENT_SECRET"
# { "access_token": "eyJ…", "token_type": "Bearer", "expires_in": 900 }

curl -X POST https://node.example.com/v1/run \
  -H 'Content-Type: application/json' -H "Authorization: Bearer $ACCESS_TOKEN" \
  -d '{"source": "…"}'
```

The node verifies the token against the operator's published keys. The token names the node as its audience, so no other node accepts it.

- **The node's own organization** runs free, as with the API key.
- **Another organization** is billed from its balance:
  1. Before the script runs, the node asks the operator to authorize the run. The operator holds up to the client's maximum run cost.
  2. Every paid function the script calls draws on that hold: remote ones, and this node's own. Each is charged at its manifest price.
  3. After the script, the run is charged for the tokens it executed at the node's price. Branches the script didn't take cost nothing. The rest of the hold is released.

  If the operator refuses the run, the node answers with the operator's status and doesn't run the script: `402` for an insufficient balance or a reached monthly cap, for example. A script that fails partway is charged for what it executed.

A node reports its `BASE_URL` to the operator whenever it has an `OPERATOR_URL`. An organization admin lists it on the platform's Nodes page, which checks that `{BASE_URL}/v1/self` answers with the node's key.

A script reads its run token's claims as the built-in variable `jwt`, for example to tell a function which client is calling (`com.example.Quotas` is hypothetical):

```
request CheckQuota {
    const quotas: com.example.Quotas
    return quotas.remaining(clientId: jwt.sub, organizationId: jwt.org)
}
```

| Field | Type | Value |
| ----- | ---- | ----- |
| `iss` | string | Always `"stellarium"` |
| `sub` | string | The API client's id |
| `aud` | string | The public key of the node running the script |
| `org` | string | The id of the organization the client belongs to |
| `iat` | int | When the token was issued, in Unix seconds |
| `exp` | int | When the token expires, in Unix seconds |
| `jti` | string | The token's unique id |

`jwt` is `null` for a run made with the API key. It is read-only: assigning to it or to one of its fields fails the script (`422`), and so does declaring a variable named `jwt`.

### Payments

A function with a `paymentManifest` (`costMicroUsd`) is paid. Every amount is an integer number of micro-USD (1 USD = 1,000,000), so `costMicroUsd: 10000` is $0.01.

Callers pay from their **organization's** prepaid balance, bought by card, and providers are paid out through Stripe Connect. An operator service holds the balances and moves the money. Organizations manage credits, nodes and payouts on the [Stellarium Platform](https://platform.stellarium.sh).

A node joins an organization with a one-time enrollment token, created on the platform's Nodes page. Pass it as `enrollmentToken`, or set `ENROLLMENT_TOKEN`. The node presents it to the operator at startup, and after that needs only its signing key. A node that hosts paid functions refuses to start until it's enrolled, and it adds its organization to its paid functions' manifests as `recipientOrganizationId`. Resource authors don't name a recipient.

A caller attaches a `paymentVoucher` signed with its key, as long as the cost is within its `costLimitMicroUsd`. The hosting node runs the function only if:

- the voucher is bound to this exact call (resource, function and parameters),
- it pays at least `costMicroUsd` to the hosting node's organization,
- it has not expired, and has a valid signature, and
- the operator **authorizes** it, holding the amount on the caller organization's balance.

A paid call without a voucher responds `402`; an invalid voucher responds `400`. If the operator refuses the hold, the function doesn't run and the caller gets the operator's status: `402` for an unenrolled caller or an insufficient balance, `403` for a revoked node or frozen organization, `422` if the caller and provider are the same organization or the provider can't receive payouts yet, and `503` if the operator can't be reached. After the call, the node **captures** the voucher, which charges the caller and credits the provider's organization less a 20% platform fee. If the function returned an error, it **releases** the hold instead. Vouchers sent to free functions are ignored.

See [`apps/operator/README.md`](apps/operator/README.md) for the operator's routes, top-ups and payouts, and the [Payments](https://docs.stellarium.sh/concepts/payments) page of the docs for the full flow.

### Inference functions

An inference function runs AI inference, so its cost depends on how many tokens a call uses. Declare one with `kind: "inference"`. It must take a `maxTokens: int32` parameter, the most output tokens the caller allows, and it may take any others. Its `exec` returns `{ value, usage: { inputTokens, outputTokens } }`. Scripts see only `value`.

A paid inference function is priced per token rather than per call. Its `paymentManifest` has `inputCostMicroUsdPerMillionTokens` and `outputCostMicroUsdPerMillionTokens`, and either rate may be `0`. It must also declare `estimateInputTokens`, which counts the input tokens a call will use. Like `exec`, the estimator runs only on the hosting node, so it can call a token-counting API such as Anthropic's. `start` throws if an inference function is declared without these.

```typescript
{
  name: "complete",
  kind: "inference",
  parameters: [{ name: "prompt", type: "string" }, { name: "maxTokens", type: "int32" }],
  returnType: "string",
  estimateInputTokens: async (args) => countTokens(prompt(args)),
  exec: async (args) => {
    const { text, inputTokens, outputTokens } = await runModel(prompt(args), maxTokens(args));
    return { value: text, usage: { inputTokens, outputTokens } };
  },
  paymentManifest: {
    inputCostMicroUsdPerMillionTokens: 3_000_000,   // $3 per million input tokens
    outputCostMicroUsdPerMillionTokens: 15_000_000, // $15 per million output tokens
  },
}
```

A call's charge is `ceil((inputTokens × inputRate + outputTokens × outputRate) / 1,000,000)` micro-USD. Both nodes and the operator are protected from bad estimates:

1. The caller posts the call to the provider's `POST /v1/run/resource/estimate`. The provider runs its estimator and answers `{ inputTokens, maxAmount }`, where `maxAmount` is the charge for those input tokens plus `maxTokens` output tokens.
2. The caller checks that `maxAmount` follows from the advertised rates and is within its `inferenceCostLimitMicroUsd`. It then signs an inference voucher (`kind: "inference"`) for `maxAmount`, both rates and `maxTokens`.
3. The provider checks the voucher as it would a fixed one, plus that its rates match the manifest and its `maxTokens` matches the call. It runs the estimator again and refuses with `402` and `requiredMaxAmount` if the voucher doesn't cover it, so inference never runs unpaid.
4. The provider authorizes the voucher, which holds `maxAmount` on the caller's balance. After the call, it captures the reported usage, with output tokens capped at `maxTokens`. The operator charges the usage at the signed rates, never more than the hold. A call that charges nothing releases the hold.

An inference function without a `paymentManifest` is free. It still needs `maxTokens`, but no estimator.

### Contracts

A contract is a [RequestScript](https://github.com/qualletio/requestscript-js) script deployed to a node, so a resource can be written without TypeScript. Its latest version is one of the node's resources, with one function, `run`, which takes the contract's parameters. A contract must have a path and declare its return type (requestscript 1.4.0 or later):

```
contract com.example.Outlook(city: string): string {
    const weather: com.example.Weather
    const today = weather.temperature(city: city)
    if (today.error != null) {
        return "unknown"
    }
    return "${today.value} degrees"
}
```

Deploy it with the node's API key, or with a [run token](#api-clients-and-run-tokens) from an organization's API client:

```sh
curl -X POST http://127.0.0.1:3000/v1/contracts \
  -H 'Content-Type: application/json' \
  -H "Authorization: Bearer $API_KEY" \
  -d '{"source": "contract com.example.Outlook(city: string): string { ... }", "description": "Today in words"}'
```

- **Versions are immutable.** Deploying a version that exists responds `409`. Deploy `com.example.Outlook@2` to change it. Calls always run the latest version, and `GET /v1/contracts` lists every version with its source, so callers can read what a call does.
- **The first organization to deploy a contract owns it.** Only its API clients can add versions or delete it. The node's API key can do both for any contract. A contract can't take the name of a registered resource, or of a resource learned from a peer.
- **Another organization pays a deploy fee**, `contractDeployFeeMicroUsd`, from its API client's run. The node's own organization and its API key deploy for free. A deploy that's refused isn't charged.
- **Peers learn of a contract as soon as it's deployed**, and forget it when it's deleted, since the node announces its resources again.

A script calls a contract like any other resource:

```
request Today {
    const outlook: com.example.Outlook
    return outlook.run(city: "Oslo")
}
```

Calls are charged for the [script tokens](https://github.com/qualletio/requestscript-js#token-metering) the contract executes, at the hosting node's listed price per million tokens, which its manifest advertises as `priceMicroUsdPerMillionTokens`. **A contract's own paid calls are paid by whoever called it**, never by the node hosting it:

1. The caller signs a contract voucher (`kind: "contract"`) for the call, with the price and `maxAmount`, its `contractCostLimitMicroUsd`. A call from a billed run also carries the run's id.
2. The hosting node checks the voucher as it would a fixed one, then asks the operator to authorize a run for the call. The operator holds up to `maxAmount` on the caller's organization, or out of the caller's run's hold. It charges at most the price the caller signed.
3. The node runs the contract. Each paid call the contract makes draws on that run, as a billed script's calls do. Afterwards, the node captures the tokens the contract executed, and what's left of the hold goes back where it came from.

A contract that fails, for example by dividing by zero, is reported as the call's `error`, and its tokens are still charged. A call by the node's own organization isn't billed. Contracts may call other contracts, at most 8 deep. Set `contractCostLimitMicroUsd` above the cost of the paid calls the contracts you call make, since the default, `costLimitMicroUsd`, covers a single call. A contract reads the calling run's token as `jwt` when it's called from a script on the same node, and `null` otherwise.

The node learns its price from the operator at startup, and checks it again every five minutes. When it changes, the node announces its contracts again.

#### Contract state

A contract keeps values between calls in **state variables** (requestscript 1.5.0 or later), declared with `var state` at the top level of its body. Only the contract's own code can change them:

```
contract com.example.Visits(page: string): int32 {
    var state total: int32 = 0
    var state(caller.org) mine: int32 = 0

    total = total + 1
    mine = mine + 1
    return mine
}
```

- `var state name = value` is one copy shared by every caller. `var state(scope) name = value` keeps a copy per value of `scope`, any expression that evaluates to a string or an integer. The initializer runs the first time a copy is used.
- **`caller`** is a built-in every contract reads: `{ org, node }`, the organization paying for the call and the node that made it. For a call from another node, `org` is the payer the operator authorized and `node` is the key that signed the voucher. For a script on this node, `org` is the run token's organization, or this node's own. So `var state(caller.org) …` gives each paying organization its own copy, which no one else can reach.
- **State is saved only if the call succeeds.** A call that fails, or would grow a scope past `maxContractStateBytes`, saves nothing, and its tokens are still charged.
- **Calls to a stateful contract run one at a time on its node.** A call waits at most 30 seconds for earlier ones, which also breaks a cycle of calls between nodes. A contract that calls itself, directly or through other contracts, fails its outer call rather than lose the inner call's update: the call that saves second finds the state changed.
- **State belongs to the contract, not a version**, so a new version keeps it. A stored value is converted to the new version's declared type, and a value that doesn't fit fails the call. Deleting every version deletes the state.
- **State is private.** A contract shares it through what it returns. Its owner and the node's admin can read all of it with `GET /v1/contracts/:ref/state`.

### Restricted functions and grants

A function with `restricted: true` runs only for callers holding a **grant** from the hosting node. A grant is a signed statement that one key may call some functions until an expiry. Its holder can **delegate** a narrower grant to another key, and the caller sends the whole chain with each call. The hosting node checks the chain's signatures without looking up the caller. It refuses a restricted call without an authorization, or with an invalid one, with `403`. It checks this before the payment voucher.

```ts
// On the provider: grant a caller access to every function of com.example.Weather for a day.
const chain = await provider.issueGrant(
  callerPublicKey,
  [{ resourcePath: "com.example", resourceName: "Weather" }],
  { lifetimeMs: 24 * 60 * 60 * 1000 },
);

// On the caller: store it, or pass it at start with `grants: [chain]`.
await caller.addGrant(chain);

// The caller may hand a narrower grant on, for example one function and one parameter value.
const delegated = await caller.delegateGrant(
  chain[0].id,
  otherPublicKey,
  [
    {
      resourcePath: "com.example",
      resourceName: "Weather",
      functionName: "temperature",
      constraints: { city: "Oslo" },
    },
  ],
  { lifetimeMs: 60 * 60 * 1000 },
);

// Refuse the grant, and everything delegated from it, in calls to the provider.
await provider.revokeGrant(chain[0].id);
```

A provider can also let callers ask for grants. Its `approveGrant` hook decides each signed request. The hook gets the caller's key, the capabilities it asked for, and any `details` (such as an invite code). It returns the grant's options, optionally with narrower capabilities, or `undefined` to refuse. Each signed request reaches the hook at most once. Without a hook, the node refuses every request. When the hook is set, a `403` for a restricted call includes `grantEndpoint`, so a caller knows where to ask.

```ts
await provider.start(fastify, {
  approveGrant: ({ publicKey, capabilities, details }) =>
    details?.invite === process.env.INVITE_CODE
      ? { lifetimeMs: 24 * 60 * 60 * 1000 }
      : undefined,
});

// On the caller. Throws if refused; otherwise stores the grant, which is then renewed like any other.
await caller.requestGrant(
  "https://provider.example",
  [{ resourcePath: "com.example", resourceName: "Weather" }],
  { invite: "letmein" },
);
```

#### Revoking grants and blocking callers

The `/v1/admin` routes take the same `Authorization: Bearer <API_KEY>` as `/v1/run`. The same actions are available in code as `revokeGrant`, `blockCaller` and `unblockCaller`.

```sh
# Revoke one grant, and everything delegated from it.
curl -X PUT "http://127.0.0.1:3000/v1/admin/revoked-grants/$GRANT_ID" -H "Authorization: Bearer $API_KEY"

# Revoke a grant delegated further down a chain. Issuers choose their own ids, so name its issuer too.
curl -X PUT "http://127.0.0.1:3000/v1/admin/revoked-grants/$GRANT_ID?issuer=$DELEGATOR_KEY" -H "Authorization: Bearer $API_KEY"

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

A capability's `resourcePath` is exact, a prefix such as `com.example.*`, or `*`. An omitted `resourceName` or `functionName` matches any, and each constraint requires that parameter to equal the given value. The hosting node refuses any call (`400`) whose parameters repeat a name or use one the function doesn't declare, so a constraint always sees the value the function gets.

A grant lasts at most 30 days, and a chain holds at most four grants. Each node renews its held grants in the background, once they are past half their lifetime (checked every `grantRefreshIntervalMs`, 5 minutes by default), so calls don't wait on renewal. A held grant that its issuer still refuses to renew 30 days after it expired is deleted. A grant keeps its `id` across renewals. `renewableUntil` ends access at a given time: no copy expires later, and none is renewed after it. Verifiers allow signers' clocks to run up to 30 seconds ahead (`CLOCK_SKEW_TOLERANCE_MS`). Seen authorization nonces are kept in the node's database, so they survive restarts, but replicas that don't share a database don't share them either. A revocation at the hosting node takes effect immediately. A delegator's revocation only stops renewal, so it takes effect when the current copy expires.

Resources are bound with `const <name>: <path>.<ResourceName>` and called with named arguments. See the [RequestScript readme](https://www.npmjs.com/package/requestscript) for the language.

### Postgres

A node keeps its peers, learned resources, grants and contracts in SQLite by default. For more throughput, or to run several nodes against one database, set `DATABASE_URL` to a Postgres URL. With `DATABASE_SCHEMA`, each node keeps its tables in its own schema:

```sh
DATABASE_URL=postgresql://stellarium:password@db.example:5432/stellarium
DATABASE_SCHEMA=weather_node
```

The node creates its tables at startup, in either database.

## Developing

This repository uses `pnpm` and is organized as a monorepo.

To run the operator, the dashboard and two paid nodes on your machine, including card payments and payouts in Stripe test mode, see [Running Locally](#running-locally).

### Modules

- packages/stellarium-ts: the main package for stellarium-ts, helps run a Stellarium node using Typescript.
- apps/operator: the centralized operator. It holds organizations' prepaid balances, moves money for paid calls, and handles Stripe top-ups and Connect payouts.
- apps/dashboard: the console at platform.stellarium.sh, where organizations buy credits, enroll nodes and set up payouts.
- apps/local-caller-node: a node for running locally that has no resources. Syncs to the local-resource-node.
- apps/local-resource-node: a node for running locally with a paid resource.

```sh
pnpm install
pnpm build         # tsc to dist/; also runs before pack
pnpm check-types   # after build: the operator checks against stellarium-ts's dist/ types
pnpm test          # vitest; the operator's database tests use in-memory PGlite, so no Postgres is needed
```

`pnpm build` emits `dist/`, which is what the package exports. Start a node from your own process with `StellariumNode`, as shown above.

`apps/local-caller-node` and `apps/local-resource-node` depend on the workspace package (`workspace:*`), so they also run the compiled code in `dist/`, not `src/`. After editing `packages/stellarium-ts`, rebuild it with `pnpm --filter stellarium-ts build`, or keep `pnpm --filter stellarium-ts exec tsc --watch` running while you work.

### Running Locally

Docker Compose runs Postgres, the operator and the two fixture nodes. The guide has three parts, each building on the last:

1. [Paid calls](#1-paid-calls): two nodes paying each other from seeded credit. Needs only Docker.
2. [The dashboard](#2-the-dashboard): sign in, enroll nodes with tokens, and view balances. Needs only Node and pnpm besides Docker.
3. [Stripe end to end](#3-stripe-end-to-end): buy credits by card, onboard to Connect, and receive a payout, all in Stripe test mode.

You need Docker, Node.js 20+ and pnpm. Install the workspace once with `pnpm install`.

| Service             | Port | URL                       |
| ------------------- | ---- | ------------------------- |
| Operator            | 3001 | http://localhost:3001/v1  |
| local-resource-node | 3002 | http://localhost:3002     |
| local-caller-node   | 3003 | http://localhost:3003     |
| Dashboard           | 3010 | http://localhost:3010     |

Each app's `.env` is copied into its image, so after changing one, rebuild that service with `docker compose up -d --build <service>`. A restart isn't enough.

#### 1. Paid calls

Generate signing keys for the two nodes. This writes each node's `.env`, and a root `.env` with their public keys, which the operator's seed reads. It refuses to overwrite existing files:

```sh
node --input-type=module <<'JS'
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { writeFileSync } from 'node:fs';
const write = (file, values) => writeFileSync(file,
  Object.entries(values).map(([key, value]) => `${key}=${value}`).join('\n') + '\n', { mode: 0o600, flag: 'wx' });
const publicKeys = {};
for (const [role, app] of [['PROVIDER', 'local-resource-node'], ['CALLER', 'local-caller-node']]) {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const keys = {
    SIGNING_PUBLIC_KEY: publicKey.export({ format: 'der', type: 'spki' }).toString('base64url'),
    SIGNING_PRIVATE_KEY: privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64url'),
  };
  write(`apps/${app}/.env`, { ...keys, API_KEY: randomBytes(24).toString('base64url') });
  publicKeys[`${role}_SIGNING_PUBLIC_KEY`] = keys.SIGNING_PUBLIC_KEY;
}
write('.env', publicKeys);
console.log('Wrote apps/local-resource-node/.env, apps/local-caller-node/.env and .env');
JS
```

Start everything:

```sh
docker compose up -d --build
```

On startup the operator runs its development seed (`apps/operator/src/seed.ts`). It creates two organizations, `org_local_provider` and `org_local_caller`, and enrolls each node's key in one of them. It marks the provider as able to receive payouts, and gives the caller $10 of credit. The seed is safe to rerun: restarts don't add more credit.

Make a paid call from the caller. `com.example.Weather.temperature` costs $0.01:

```sh
CALLER_API_KEY="$(sed -n 's/^API_KEY=//p' apps/local-caller-node/.env)"
curl -s -X POST http://localhost:3003/v1/run \
  -H "Authorization: Bearer $CALLER_API_KEY" -H 'Content-Type: application/json' \
  -d '{"source": "request GetTemperature {\n  const weather: com.example.Weather\n\n  return weather.temperature(city: \"Oslo\")\n}"}'
```

```json
{ "returnValue": { "value": 12, "error": null }, "usage": { "tokens": 17 } }
```

The provider held $0.01 of the caller's credit before running the function, then captured it. Check the balances in Postgres. The caller has $9.99, and the provider is owed $0.008 after the 20% platform fee:

```sh
docker compose exec postgres psql -U stellarium -d stellarium \
  -c 'select id, "balanceMicroUsd", "heldMicroUsd", "payableMicroUsd" from organizations'
```

The fixture provider also hosts a paid inference function. Try `return echo.complete(prompt: "Hello world!", maxTokens: 10)` with `const echo: com.example.Echo`. It holds the most the call can cost and charges only the tokens it used.

The seed also lists the provider's node at $1 per million script tokens, and gives the caller's organization an [API client](#api-clients-and-run-tokens) for it. Run the same script directly on the provider, as that client, without either node's API key:

```sh
TOKEN="$(curl -s -X POST http://localhost:3001/v1/oauth/token \
  -d grant_type=client_credentials -d client_id=cli_local_caller -d client_secret=cs_local-only-client-secret \
  | node -pe 'JSON.parse(require("fs").readFileSync(0)).access_token')"
curl -s -X POST http://localhost:3002/v1/run \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"source": "request GetTemperature {\n  const weather: com.example.Weather\n\n  return weather.temperature(city: \"Oslo\")\n}"}'
```

The caller's organization pays $0.01 for the temperature, plus 17 tokens at $1 per million. The provider's organization is owed both, less the fee. The run is in the `runs` table.

Deploy a [contract](#contracts) to the provider with the same token. As another organization's API client, it pays the provider's $0.001 deploy fee (`CONTRACT_DEPLOY_FEE_MICRO_USD` in `compose.yaml`):

```sh
curl -s -X POST http://localhost:3002/v1/contracts \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"source": "contract com.example.Outlook(city: string): string {\n  const weather: com.example.Weather\n  return \"${weather.temperature(city: city).value} degrees\"\n}"}'
```

The provider announces it, so the caller can call it:

```sh
curl -s -X POST http://localhost:3003/v1/run \
  -H "Authorization: Bearer $CALLER_API_KEY" -H 'Content-Type: application/json' \
  -d '{"source": "request Today {\n  const outlook: com.example.Outlook\n\n  return outlook.run(city: \"Oslo\")\n}"}'
```

```json
{ "returnValue": { "value": "12 degrees", "error": null }, "usage": { "tokens": 17 } }
```

The caller's organization pays for the contract's tokens at the provider's price, and for the $0.01 temperature call the contract makes. The call is a `contract` row in the `runs` table, and the temperature's receipt names it.

The resource node keeps its data in Postgres, in the `resource_node` schema of the operator's database (`DATABASE_URL` and `DATABASE_SCHEMA` in `compose.yaml`). The caller node uses SQLite.

#### 2. The dashboard

The dashboard signs people in with [Better Auth](https://www.better-auth.com), which runs inside the operator: users, sessions, organizations and roles are tables in its Postgres. The dashboard forwards its `/api/auth/*` to the operator, so the session cookie is the dashboard's. Compose sets a local `BETTER_AUTH_SECRET`, so there is nothing to sign up for.

Create `apps/dashboard/.env`:

```
OPERATOR_URL=http://127.0.0.1:3001/v1
```

Without `RESEND_API_KEY`, the operator doesn't send email: it logs each verification, password reset and invitation link instead. Find them with `docker compose logs operator | grep Email`. To send real email, or to offer GitHub sign-in, add to `apps/operator/.env`:

```
RESEND_API_KEY=re_...
EMAIL_FROM="Stellarium <no-reply@your-verified-domain>"
# A GitHub OAuth app with the callback URL http://localhost:3010/api/auth/callback/github
GITHUB_CLIENT_ID=...
GITHUB_CLIENT_SECRET=...
```

and `GITHUB_SIGN_IN=true` to `apps/dashboard/.env`, so the sign-in page shows the button.

To enroll the fixture nodes from the dashboard instead of the seed, add `SEED_DEV=0` to the root `.env`. Then reset the stack, so the seed's organizations are gone, and start the operator:

```sh
docker compose down
docker compose up -d --build postgres operator
pnpm --filter dashboard dev
```

The dashboard runs on port 3010, so it can sit beside the [registry](https://github.com/qualletio/stellarium-resource-registry), which uses 3000. Open http://localhost:3010 (not 127.0.0.1: the operator accepts only `DASHBOARD_URL`'s origin) and sign up, then open the verification link from the operator's log. Create two organizations, the second from the organization switcher's **Create organization…**: one to pay for calls (say "Caller") and one to host the paid functions ("Weather Provider"). Then enroll each node in its organization:

1. Select the organization, go to **Nodes**, and create an enrollment token. It is shown once and works once, within 24 hours.
2. Add the `ENROLLMENT_TOKEN=...` line to that node's `.env`: `apps/local-resource-node/.env` for the provider and `apps/local-caller-node/.env` for the caller.
3. Start the provider first, since the caller bootstraps from it:

```sh
docker compose up -d --build local-resource-node
docker compose up -d --build local-caller-node
```

Each node presents its token at startup and joins its organization. After that it needs only its signing key, so the used token can stay in its `.env`. A provider that isn't enrolled refuses to start and says how to enroll it.

The provider's paid calls are refused until its organization can receive payouts ("Organization ... can't receive payouts yet"), and the caller has no credit yet. Part 3 sets up both.

##### The Composer

The dashboard's **Composer** is a chat with Claude that writes RequestScript for the resources one node knows, checks each script against that node's catalog, and proposes it. An admin runs a proposed request script, or deploys a proposed contract, with one click. The dashboard gets a short-lived run token for one of the organization's API clients, so the run is billed like any of that client's runs. Each message is charged to the organization's balance for the Claude tokens it used, at the operator's `COMPOSER_*` rates (Claude Opus 5.5's list prices by default). The operator holds `COMPOSER_TURN_HOLD_MICRO_USD` ($0.50 by default) while a message is answered. Conversations are saved per user.

Add to `apps/dashboard/.env`:

```
ANTHROPIC_API_KEY=sk-ant-...
# Matches the operator's DASHBOARD_SERVICE_SECRET in compose.yaml.
DASHBOARD_SERVICE_SECRET=local-only-dashboard-secret
# The compose nodes report container hostnames. The dashboard runs on the host, so it reaches them on localhost.
NODE_URL_REWRITES=http://local-resource-node:3002=http://127.0.0.1:3002,http://local-caller-node:3003=http://127.0.0.1:3003
```

The organization needs credit (part 3), and an API client for a node: on **Explore**, click **Create API client** for "Local resource node". Then open **Composer**, choose the client, and ask for something like "get the temperature in Oslo and Paris and return the warmer city".

#### 3. Stripe end to end

In the [Stripe dashboard](https://dashboard.stripe.com), turn on **Test mode**. Then:

1. Under **Developers → API keys**, copy the **Secret key** (`sk_test_...`).
2. Under **Settings → Connect**, finish **Get started** as a platform or marketplace. Connect is needed to create the providers' Express accounts.
3. Under **Settings → Billing → Customer portal**, click **Activate test link**. The dashboard's **Manage in Stripe** button opens this portal.

Forward Stripe's webhooks to the operator with the [Stripe CLI](https://docs.stripe.com/stripe-cli). Keep this running in its own terminal:

```sh
stripe login
stripe listen --forward-to localhost:3001/v1/stripe/webhook --forward-connect-to localhost:3001/v1/stripe/connect-webhook
```

It prints a webhook signing secret (`whsec_...`). One `stripe listen` signs both streams, so the same secret goes in both variables. Add these to `apps/operator/.env`:

```
STRIPE_SECRET_KEY=sk_test_...
STRIPE_WEBHOOK_SECRET=whsec_...
STRIPE_CONNECT_WEBHOOK_SECRET=whsec_...
# For testing only: pay out every maintenance pass (30 seconds), with no hold, from one cent.
# The defaults are a 7-day hold, weekly payouts and a $10 minimum.
PAYOUT_HOLD_DAYS=0
PAYOUT_INTERVAL_DAYS=0
PAYOUT_MIN_MICRO_USD=10000
```

Rebuild the operator so it picks them up:

```sh
docker compose up -d --build operator
```

Buy credits as the caller. Select the caller organization in the dashboard and go to **Credits**. Enter an amount and click **Buy credits**, then pay on Stripe Checkout with:

- Card: **4000 0000 0000 0077**, with any future expiry and any CVC. Unlike 4242 4242 4242 4242, its funds are available in your platform balance immediately. Transfers to providers need available funds, so with 4242 the payout fails for insufficient funds.

After Stripe redirects you back, the balance updates within a few seconds, once the `checkout.session.completed` webhook arrives through `stripe listen`.

Set up payouts as the provider. Select the provider organization, go to **Payouts → Set up payouts**, and complete Stripe's test-mode Express onboarding:

- Phone **000 000 0000**, with SMS code **000000**.
- An individual with any name, address and date of birth (over 18), and SSN last four **0000**.
- For the bank account, choose **Test (OAuth)** and pick the **Success** account. If an "enter bank details manually" link is offered instead, use routing number **110000000** and account number **000123456789**.

Back on the Payouts page, the status changes to **Ready** when the `account.updated` webhook arrives.

Make a few paid calls from the caller with the `curl` command in part 1. On the next maintenance pass, the operator transfers the provider's earnings, in whole cents, to its Express account. The remainder stays payable until a later payout. You can see the payout in three places:

- The provider's **Payouts** page in the dashboard.
- The caller's **Usage** page, where each call shows what it was charged.
- Stripe: `stripe transfers list --limit 1`.

When you're done, remove the three `PAYOUT_*` lines from `apps/operator/.env` and rebuild the operator. Otherwise it pays out every 30 seconds.

#### Resetting

Postgres has no volume, so `docker compose down` deletes every organization, balance and receipt. The next `docker compose up -d --build` starts fresh and reseeds, unless `SEED_DEV=0` is set. After a reset, nodes enrolled through the dashboard need new enrollment tokens. Dashboard accounts and organizations live in the same database, so they go too: sign up again. Stripe's test data stays in your Stripe account.

#### Troubleshooting

| Symptom | Cause |
| --- | --- |
| The operator exits with `SEED_PROVIDER_PUBLIC_KEY is required` | The root `.env` is missing the nodes' public keys. Rerun the key script in part 1, or set `SEED_DEV=0`. |
| The provider exits with `Node is not enrolled in an organization` | Seeding is off and its `.env` has no valid `ENROLLMENT_TOKEN`. Create one on the dashboard's Nodes page. |
| The caller exits at startup with a connection error | It started before the provider was listening. Start it again with `docker compose up -d local-caller-node`. |
| A paid call answers `Insufficient balance` | The caller's organization has no available credit. Buy credits, or use the seed. |
| A paid call answers `can't receive payouts yet` | The provider's organization hasn't finished Connect onboarding. |
| Signing in or creating an organization answers `Invalid origin` | The dashboard's origin doesn't match the operator's `DASHBOARD_URL`. Open http://localhost:3010, not 127.0.0.1. |
| No verification email arrives | Without `RESEND_API_KEY` emails are only logged: `docker compose logs operator \| grep Email`. |
| Buy credits shows `Stripe is not configured on this operator` | `STRIPE_SECRET_KEY` isn't set in `apps/operator/.env`, or the operator wasn't rebuilt. |
| A top-up succeeds in Stripe but the balance doesn't change | `stripe listen` isn't running, or its secret doesn't match `STRIPE_WEBHOOK_SECRET`. |
| A payout fails with insufficient funds | The top-up used 4242 4242 4242 4242, whose funds aren't available yet. Use 4000 0000 0000 0077. |

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
