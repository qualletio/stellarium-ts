# Running Stellarium end to end on localnet

This guide covers a local Solana validator, the native Rust escrow program,
PostgreSQL, the operator API, and two Stellarium nodes: a caller and a paid
resource provider. All money is **local test SOL**. Commands assume macOS/Linux,
run from the repository root unless a different directory is shown.

**Current status (2026-10-16):** the source blockers this guide used to list are
fixed, and the paid two-node flow is covered by automated tests (see the end of this
guide). The validator-backed procedure in sections 7–9 has not been rerun since
those fixes. An HTTP success or a receipt alone is not proof of payment.
This guide does not deploy anything for you.

## 1. What the source does now

The source is the authority here. Summary of the behavior this guide relies on:

| Area | Behavior |
| --- | --- |
| Program authority | `programs/escrow_program/src/lib.rs` has local fixture keys compiled in. Replace them with your own (section 4). |
| Node configuration | `StellariumNode.start` takes `baseUrl`, keys, `apiKey`, `operatorUrl`, `costLimitLamports` and `databasePath`, falling back to the environment. It rejects when a required value is missing. |
| SQLite | Schema is created on startup and reused on restart. Bootstrapping is idempotent, and a provider may host several resources. |
| Peer discovery | Announcements are signed over `{ baseUrl, name, publicKey, expiry }` and verified with the announced key. Resource broadcasts carry the sender's `publicKey`, and a peer may only publish its own resources. |
| Provider verification | `/v1/run/resource` requires a voucher for a paid function and checks its invocation hash, amount, recipient, expiry and signature before running it. It settles only after a successful run. |
| Operator authorization/errors | `POST /v1/escrow` requires `Authorization: Bearer <OPERATOR_API_TOKEN>`. Request bodies are schema-validated, and `OperationError`s keep their HTTP status. |
| Payment durability | Migrations create `receipts` at startup. A receipt is claimed atomically before broadcast and moves through `pending` → `confirmed`, `unconfirmed`, `failed` or `expired`. A reconciliation loop checks the chain for uncertain receipts. A voucher can be settled again only after `failed` or `expired`. |

Do not work around voucher failures by disabling verification or using a different
wallet as the escrow user. Fix the key conversion and signed-payload agreement.
The Rust program authorizes the operator wallet; voucher verification is enforced
off-chain by the operator, not by the program.

## 2. Topology and identities

```text
Caller node :3000  -- signed paid invocation --> Provider node :3002
                                                    |
                                          POST /v1/payment
                                                    v
                                             Operator :3001 --> PostgreSQL :5433
                                                    |
                                      simulate/sign/send/confirm
                                                    v
                                          Solana RPC :8899
                                         WebSocket   :8900
                                                    |
                                        Escrow program + PDA
                                                    |
                                            SOL to provider
```

| Identity | Format / role |
| --- | --- |
| Operator authority | Solana keypair JSON, loaded as `PRIVATE_KEY`; pays transaction fees and setup rent, signs withdrawals, and is the compiled `ESCROW_AUTHORITY` and deployment upgrade authority. |
| Program ID | Separate Solana program keypair's public address; becomes `ESCROW_PROGRAM_ID`. Not the authority. |
| Caller/user | Node Ed25519 signing key; **raw public key underlying SPKI**, converted to Solana base58. Used in escrow PDA seeds. No separate caller wallet is automatically linked to it. |
| Provider signing key | Separate node Ed25519 key for peer discovery. |
| Provider recipient | Separate Solana public address in the function payment manifest. Receives 80% of each withdrawal; does not sign it. |
| Protocol fee wallet | Separate Solana public address compiled as `PROTOCOL_FEE_RECIPIENT` and set as the operator's `PROTOCOL_FEE_RECIPIENT`. Receives 20% of each withdrawal; does not sign it. |
| Escrow PDA | Derived from `["escrow", authority bytes, user bytes]` under the deployed program ID. Has no private key. Holds 73 bytes of state and SOL. |

Use three terminals for validator/operator/provider and another for the caller;
use a fifth for commands. Set the same `REPO` in each terminal:

```sh
export REPO="$(pwd)" # run at the repository root
export RPC=http://127.0.0.1:8899
```

Keep the URLs consistent: `BASE_URL` is the node origin **without** `/v1`;
`OPERATOR_URL=http://127.0.0.1:3001/v1` **includes** `/v1`, because the client
appends `/payment`. Operator port 3001 is currently hardcoded.

## 3. Toolchain and install

Needed: Node, pnpm 12.11.2 (the root `packageManager`), Rust/Cargo, Solana CLI,
`cargo build-sbf`, `solana-test-validator`, Docker with its daemon running,
and `curl`. Commands below also use Python 3 for JSON/public env extraction.
Anchor is not required: this is a native `solana-program` crate, not an Anchor
workspace. No token mint, SPL token account, oracle, or external RPC secret is
needed for this SOL-only flow.

The machine inspected for this guide had Node 25.0.0, pnpm 12.11.2, and Solana CLI,
builder and validator 3.1.10. This is an observed baseline, not a guarantee that
every version combination works. The package declares Node >=20; use emitted
JavaScript to avoid relying on native TypeScript execution/version behavior.

```sh
node --version
pnpm --version
cargo --version
solana --version
cargo build-sbf --version
solana-test-validator --version
docker info
pnpm install

# Direct compiler checks/builds, without Turbo cache/env forwarding.
pnpm --filter operator exec tsc
pnpm --filter stellarium-ts exec tsc
NO_DNA=1 cargo test --manifest-path programs/escrow_program/Cargo.toml --locked
```

Type checking does not detect the SQL or payment integration failures above.
The 23 Rust tests exercise helpers and program logic without a validator. The
operator README's `apps/operator/tests/*.test.mjs` files do not exist in this
checkout; do not treat that command as validator coverage.

## 4. Local identities, authority, validator, deployment

Create disposable local test identities on your machine. Keep private material in
ignored files, do not paste it into chat or logs, and do not use funded real-world
wallets. The following generator is run by you; it writes secrets without printing
them. It refuses to replace existing fixture files.

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
    USER_ADDRESS: new PublicKey(raw).toBase58(),
    API_KEY: randomBytes(32).toString('hex') };
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

`USER_ADDRESS` in **caller.env** identifies the paying user's escrow. The provider
also has a generated node address but is not the escrow user for this test.

Read only public addresses into the command terminal:

```sh
export AUTHORITY_ADDRESS="$(solana-keygen pubkey .keys/local-e2e/operator.json)"
export ESCROW_PROGRAM_ID="$(solana-keygen pubkey .keys/local-e2e/program.json)"
export RECIPIENT_ADDRESS="$(solana-keygen pubkey .keys/local-e2e/recipient.json)"
export PROTOCOL_FEE_RECIPIENT="$(solana-keygen pubkey .keys/local-e2e/protocol-fee.json)"
export USER_ADDRESS="$(python3 -c 'from pathlib import Path; print(dict(line.split("=",1) for line in Path(".keys/local-e2e/caller.env").read_text().splitlines())["USER_ADDRESS"])')"
```

Edit `programs/escrow_program/src/lib.rs`, replacing each `None` with your public
`AUTHORITY_ADDRESS` and `PROTOCOL_FEE_RECIPIENT` (only public addresses belong in source):

```rust
pub const ESCROW_AUTHORITY: Option<Pubkey> =
    Some(solana_program::pubkey!("YOUR_LOCAL_OPERATOR_PUBLIC_ADDRESS"));
pub const PROTOCOL_FEE_RECIPIENT: Option<Pubkey> =
    Some(solana_program::pubkey!("YOUR_LOCAL_PROTOCOL_FEE_ADDRESS"));
```

Build the configured binary:

```sh
NO_DNA=1 cargo build-sbf --manifest-path programs/escrow_program/Cargo.toml \
  --sbf-out-dir programs/escrow_program/target/deploy
```

Start the validator in its own terminal. Omit `--reset` to retain an existing test
ledger; a fresh run can use a new ledger directory. No accounts are cloned from a
public cluster.

```sh
NO_DNA=1 solana-test-validator --ledger "$REPO/.local-ledger/local-e2e" --rpc-port 8899
```

From the command terminal, wait for health, fund the operator and recipient, then
deploy. Every chain command specifies the local URL and signer rather than
changing your global Solana configuration:

```sh
curl -sS "$RPC" -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"getHealth"}'
# Expect result: "ok".

solana --url "$RPC" airdrop 100 "$AUTHORITY_ADDRESS"
solana --url "$RPC" airdrop 1 "$RECIPIENT_ADDRESS"
solana --url "$RPC" airdrop 1 "$PROTOCOL_FEE_RECIPIENT"
solana --url "$RPC" program deploy \
  --keypair .keys/local-e2e/operator.json \
  --fee-payer .keys/local-e2e/operator.json \
  --upgrade-authority .keys/local-e2e/operator.json \
  --program-id .keys/local-e2e/program.json \
  programs/escrow_program/target/deploy/escrow_program.so
solana --url "$RPC" program show "$ESCROW_PROGRAM_ID"
```

Expect the program ID to equal `ESCROW_PROGRAM_ID` and its upgrade authority to
equal `AUTHORITY_ADDRESS`. The recipient and protocol fee wallet are prefunded so
a tiny withdrawal does not create an underfunded new account. Setup pays escrow rent; it does **not**
fund the user's spendable budget. CLI deployment and local validation follow the
[Solana Rust program guide](https://solana.com/docs/programs/rust).

## 5. PostgreSQL and operator

Start a local database on host port 5433, avoiding a common existing 5432 service:

```sh
docker run --name stellarium-local-e2e-postgres \
  -e POSTGRES_USER=stellarium -e POSTGRES_PASSWORD=local-only-password \
  -e POSTGRES_DB=stellarium -p 127.0.0.1:5433:5432 \
  -v stellarium-local-e2e-pg:/var/lib/postgresql/data \
  -d postgres:16
docker exec stellarium-local-e2e-postgres pg_isready -U stellarium -d stellarium
```

For a previously created container, use `docker start
stellarium-local-e2e-postgres` instead. The operator applies the migrations in
`apps/operator/drizzle/` itself at startup, so no manual table setup is needed.

Start the operator in its terminal, from its workspace so dependencies resolve.
The Node env file loader avoids putting the secret JSON into a shell command:

```sh
cd "$REPO/apps/operator"
node --env-file="$REPO/.keys/local-e2e/operator.env" dist/server.js
```

```sh
curl -fsS http://127.0.0.1:3001/v1/
# {"hello":"world"}
```

This liveness route does not check PostgreSQL or Solana connectivity. A real
payment database query and escrow simulation are needed to exercise those paths.

## 6. Create and fund the caller's escrow

Run this in the operator workspace in the command terminal. The local fixture
token is loaded by Node and sent only to loopback:

```sh
cd "$REPO/apps/operator"
node --env-file="$REPO/.keys/local-e2e/operator.env" --input-type=module <<'JS'
import { readFileSync, writeFileSync } from 'node:fs';
const env = Object.fromEntries(readFileSync('../../.keys/local-e2e/caller.env', 'utf8')
  .trim().split('\n').map(line => line.split(/=(.*)/s).slice(0, 2)));
const response = await fetch('http://127.0.0.1:3001/v1/escrow', {
  method: 'POST', headers: { 'Content-Type': 'application/json',
    Authorization: `Bearer ${process.env.OPERATOR_API_TOKEN}` },
  body: JSON.stringify({ user: env.USER_ADDRESS }) });
const result = await response.json();
console.log(response.status, result);
if (!response.ok || !['confirmed', 'existing'].includes(result.status))
  throw new Error('Escrow not confirmed; reconcile any returned signature first');
writeFileSync('../../.keys/local-e2e/escrow-result.json', JSON.stringify(result, null, 2));
JS
cd "$REPO"
export ESCROW_ADDRESS="$(python3 -c 'import json; print(json.load(open(".keys/local-e2e/escrow-result.json"))["escrowAddress"])')"
solana --url "$RPC" account "$ESCROW_ADDRESS"
```

Successful creation returns HTTP 200 (202 when the result is `unconfirmed`). Expect `confirmed` and a signature on first creation,
`existing` without a new transaction on a repeat. Verify account owner equals
the program ID and data length is 73. For a first creation, use the signature
verification in section 9. If status is `unconfirmed`, check the saved signature
before proceeding.

Deposit 0.1 SOL above the rent reserve using an ordinary System Program transfer:

```sh
solana --url "$RPC" transfer "$ESCROW_ADDRESS" 0.1 \
  --from .keys/local-e2e/operator.json --fee-payer .keys/local-e2e/operator.json
solana --url "$RPC" balance "$ESCROW_ADDRESS" --lamports
```

The operator sponsors this test deposit. A real user can fund the same escrow
from another wallet. The user key need not itself have lamports for setup or
withdrawal: the operator pays the fees. Escrow balance should be rent minimum
for 73 bytes plus 100,000,000 lamports.

## 7. Start provider and caller

These launchers exercise the system without adding a separate frontend or wallet
extension. `apps/local-resource-node` and `apps/local-caller-node` are equivalent
fixtures used by `docker compose`.

Save this as `packages/stellarium-ts/local-node.mjs` (a local fixture launcher):

```js
import Fastify from 'fastify';
import { StellariumNode } from './dist/index.js';

const provider = process.argv[2] === 'provider';
const node = new StellariumNode();
if (provider) {
  await node.register({
    id: 1, metadata: {}, path: 'com.example', name: 'Weather',
    baseUrl: process.env.BASE_URL,
    functions: [{
      id: 1, name: 'temperature',
      parameters: [{ name: 'city', type: 'string' }], returnType: 'int32',
      paymentManifest: {
        id: 1, costLamports: 500, recipientAddress: process.env.RECIPIENT_ADDRESS,
      },
      exec: async args => args.find(arg => arg.name === 'city')?.value === 'Oslo' ? 12 : 20,
    }],
  });
}
await node.start(Fastify({ logger: true }), {
  port: provider ? 3002 : 3000,
  startingPeer: provider ? undefined : 'http://127.0.0.1:3002',
});
```

Run each node from a **separate working directory** so they do not share the
SQLite `requestscript.db`. The module's absolute path still resolves workspace
dependencies normally:

```sh
# Provider terminal: start first.
mkdir -p "$REPO/.keys/local-e2e/provider-state"
cd "$REPO/.keys/local-e2e/provider-state"
node --env-file="$REPO/.keys/local-e2e/provider.env" \
  "$REPO/packages/stellarium-ts/local-node.mjs" provider
```

```sh
# Caller terminal.
mkdir -p "$REPO/.keys/local-e2e/caller-state"
cd "$REPO/.keys/local-e2e/caller-state"
node --env-file="$REPO/.keys/local-e2e/caller.env" \
  "$REPO/packages/stellarium-ts/local-node.mjs" caller
```

Bootstrap should copy the provider's resource even if its initial peer list is
empty. Check both nodes:

```sh
curl -fsS http://127.0.0.1:3002/v1/
curl -fsS http://127.0.0.1:3000/v1/
curl -fsS http://127.0.0.1:3002/v1/resources
curl -fsS http://127.0.0.1:3000/v1/resources
curl -fsS http://127.0.0.1:3000/v1/peers
```

The caller must resolve `com.example.Weather` as **remote**, with base URL
`http://127.0.0.1:3002` and `temperature`'s 500-lamport manifest. A local resource
invocation bypasses voucher creation, so it cannot prove settlement. For a
separate discovery test, announce each peer with a valid signature and then
broadcast resources; startup only broadcasts to already known peers.
Restarting against existing SQLite data does not duplicate resource rows.

## 8. Execute the paid request and isolate failures

Record escrow and recipient balances, then call the caller's API with its JSON
`{ source }` body and its `API_KEY`:

```sh
solana --url "$RPC" balance "$ESCROW_ADDRESS" --lamports
solana --url "$RPC" balance "$RECIPIENT_ADDRESS" --lamports
export CALLER_API_KEY="$(python3 -c 'from pathlib import Path; print(dict(line.split("=",1) for line in Path(".keys/local-e2e/caller.env").read_text().splitlines())["API_KEY"])')"
curl -sS -i http://127.0.0.1:3000/v1/run \
  -H 'Content-Type: application/json' \
  -H "Authorization: Bearer $CALLER_API_KEY" \
  -d '{"source":"request GetTemperature {\n const weather: com.example.Weather\n return weather.temperature(city: \"Oslo\")\n}"}'
# Expected resource result: {"returnValue":{"value":12,"error":null}}
```

Follow caller, provider, and operator logs. Wait separately for the provider's
operator request to finish; the resource response precedes settlement.
Do not mistake the resource result for payment completion.

Read the receipt and preserve request ID, invocation ID and transaction signature:

```sh
docker exec stellarium-local-e2e-postgres psql -U stellarium -d stellarium -c \
  'SELECT id, "requestId", "invocationId", amount, "recipientAddress", "transactionSignature" FROM receipts ORDER BY id DESC LIMIT 5;'
```

To isolate the operator from discovery/provider failures, generate one voucher
with the caller's signing keys and submit it directly. This is a component test,
not a substitute for the two-node test. Run from the node workspace after fixing
runtime aliases:

```sh
cd "$REPO/packages/stellarium-ts"
node --env-file="$REPO/.keys/local-e2e/caller.env" --input-type=module <<'JS'
import { writeFileSync } from 'node:fs';
import { CombinationResourceInvoker } from './dist/resource/invoker.js';
const invoker = new CombinationResourceInvoker(null, 10000,
  process.env.SIGNING_PUBLIC_KEY, process.env.SIGNING_PRIVATE_KEY);
const parameters = [{ name: 'city', value: 'Oslo' }];
const voucher = invoker.createPaymentVoucher(process.env.RECIPIENT_ADDRESS,
  500, 'com.example', 'Weather', 'temperature', parameters);
const submission = { voucher };
writeFileSync('../../.keys/local-e2e/payment.json', JSON.stringify(submission));
console.log('Voucher saved with a two-minute lifetime.');
JS
cd "$REPO"
curl -sS -i http://127.0.0.1:3001/v1/payment \
  -H 'Content-Type: application/json' --data-binary @.keys/local-e2e/payment.json
```

This matches the operator body (no `manifest` field). The provider validates the
voucher against its own manifest before running the function. Preserve parameter key order;
the invocation hash and signature cover `JSON.stringify`, not canonical JSON. The direct test generates
a new authorization each time it runs, so do not rerun it to retry an uncertain
payment. Reuse the saved body and first reconcile its saved signature.

Expected behavior: a confirmed result with a withdrawal signature, one
`confirmed` receipt, and a 500-lamport transfer.

## 9. Verify on the local chain

Set `SIGNATURE` to the creation response signature or payment receipt signature:

```sh
export SIGNATURE=YOUR_TRANSACTION_SIGNATURE
solana --url "$RPC" confirm "$SIGNATURE" --verbose
curl -sS "$RPC" -H 'Content-Type: application/json' \
  -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"getTransaction\",\"params\":[\"$SIGNATURE\",{\"encoding\":\"json\",\"commitment\":\"confirmed\",\"maxSupportedTransactionVersion\":0}]}" \
  > .keys/local-e2e/transaction.json
```

The current operator emits **v0** transactions, so a maximum of 0 is appropriate
for this fixture. Update the reader if the sender is migrated to a newer version.
`getTransaction` can return `null` before confirmation; retry the read, and never
interpret `null` as successful settlement. See the official
[getTransaction reference](https://solana.com/docs/rpc/http/gettransaction).

For a payment, this dependency-free checker asserts transaction success, program
invocation, the exact withdrawal amount/account order, and transaction-local
balance changes. Run from the command terminal after setting all public env vars:

```sh
python3 <<'PY'
import json, os
response = json.load(open('.keys/local-e2e/transaction.json'))
assert 'error' not in response, response.get('error')
tx = response.get('result')
assert tx and tx.get('meta'), 'Transaction unavailable; check confirmation/cluster'
meta, message = tx['meta'], tx['transaction']['message']
assert meta['err'] is None, meta['err']
keys = message['accountKeys']
loaded = meta.get('loadedAddresses') or {}
keys += loaded.get('writable', []) + loaded.get('readonly', [])
escrow, recipient, authority, program, fee_wallet = [os.environ[name] for name in
    ['ESCROW_ADDRESS', 'RECIPIENT_ADDRESS', 'AUTHORITY_ADDRESS', 'ESCROW_PROGRAM_ID',
     'PROTOCOL_FEE_RECIPIENT']]
def delta(address):
    i = keys.index(address)
    return meta['postBalances'][i] - meta['preBalances'][i]
alphabet = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'
def unbase58(value):
    n = 0
    for c in value:
        n = n * 58 + alphabet.index(c)
    return b'\0' * (len(value) - len(value.lstrip('1'))) + n.to_bytes((n.bit_length()+7)//8, 'big')
withdrawals = [ix for ix in message['instructions']
    if keys[ix['programIdIndex']] == program and unbase58(ix['data'])[:1] == b'\x01']
assert len(withdrawals) == 1, 'Expected one escrow withdrawal instruction'
ix = withdrawals[0]
assert [keys[i] for i in ix['accounts']] == [authority, escrow, recipient, fee_wallet]
data = unbase58(ix['data'])
assert len(data) == 9 and int.from_bytes(data[1:], 'little') == 500
assert delta(escrow) == -500, delta(escrow)
assert delta(recipient) == 400, delta(recipient)
assert delta(fee_wallet) == 100, delta(fee_wallet)
assert keys[0] == authority, 'Expected operator fee payer'
assert delta(authority) == -meta['fee'], (delta(authority), meta['fee'])
print('PASS: 500-lamport withdrawal split 400/100 with protocol fee; operator paid the tx fee; slot', tx['slot'])
PY
```

For creation, inspect the same RPC data: `meta.err` must be null, the top-level
instruction must invoke your program with data `[0]`, and the new account must
be program-owned with valid state. Creation's balance changes include rent plus
the operator's fee, so do not run the withdrawal checker on it.

Validate current escrow state and rent with the repository's decoder/budget helper
(operator workspace, operator env file loaded):

```sh
cd "$REPO/apps/operator"
node --env-file="$REPO/.keys/local-e2e/operator.env" --input-type=module <<'JS'
import assert from 'node:assert/strict';
import { Connection, PublicKey } from '@solana/web3.js';
import { getEscrowBudget } from './dist/solana/escrow-budget.js';
import { decodeEscrowAccount } from './dist/solana/escrow.js';
const connection = new Connection(process.env.SOLANA_RPC_URL, 'confirmed');
const programId = new PublicKey(process.env.ESCROW_PROGRAM_ID);
const authority = new PublicKey(process.env.AUTHORITY_ADDRESS);
const user = new PublicKey(process.env.USER_ADDRESS); // exported public caller address
const budget = await getEscrowBudget({ connection, programId, authority, user });
const account = await connection.getAccountInfo(budget.escrowAddress, 'confirmed');
assert(account);
const state = decodeEscrowAccount(programId, budget.escrowAddress, account);
assert(state.user.equals(user) && state.authority.equals(authority));
assert(budget.isInitialized && budget.isRentExempt);
console.log({ escrowAddress: budget.escrowAddress.toBase58(),
  balance: budget.totalBalanceLamports.toString(),
  rent: budget.rentReserveLamports.toString(),
  spendable: budget.availableBudgetLamports.toString() });
JS
cd "$REPO"
```

For exactly one 500-lamport payment after the 0.1 SOL deposit, spendable budget
must be **99,999,500 lamports**. After both the full-flow test and the separate
direct-payment test succeed it must be **99,999,000**. The state stays intact.
Transaction-specific deltas are stronger evidence than before/after wallet
snapshots when other requests may be running.

Optional visual inspection: open [Solana Explorer](https://explorer.solana.com/),
select **Custom RPC URL**, enter `http://127.0.0.1:8899`, then inspect the signature
and accounts. Browser/HTTPS-to-localhost restrictions can prevent access; the
local CLI/RPC checks above are sufficient. A public-cluster explorer will not
find a transaction from your private local ledger.

## 10. Acceptance and failure cases

The full-system happy path passes only when all of these hold:

1. Fresh provider/caller SQLite databases start and discover the paid function.
2. Caller gets `12` from the remote provider with a valid signed invocation.
3. Operator persists a receipt tied to that request/invocation and a signature.
4. That signature exists on your local validator, succeeds, and invokes the
   configured program's withdrawal instruction.
5. Escrow decreases by exactly 500 lamports; recipient increases by exactly 500;
   operator pays the transaction fee; escrow state and rent reserve stay valid.

Run these additional cases. Use
fresh IDs for independent test authorizations, but the **same saved voucher** for
replay tests. Inspect chain balances and signatures, not only HTTP status codes.

| Case | Expected result |
| --- | --- |
| Repeat escrow creation | `existing`, same PDA, no extra setup transaction. |
| Missing/wrong escrow token | 401; no setup transaction. |
| Tamper signed amount/recipient/context | Rejected, no withdrawal or receipt. |
| Expired voucher | 401 before submission, no transfer. |
| Insufficient spendable escrow balance | Rejected, no withdrawal, rent preserved. |
| Missing escrow | Rejected, no withdrawal. |
| Same voucher twice / concurrent submissions | Exactly one on-chain payment; the repeat gets 409. |
| Operator restart and retry same voucher | No second transfer; reconciliation resolves the saved signature to `confirmed`, `failed` or `expired`. |
| RPC interruption around broadcast | Treat as uncertain, query the saved signature; do not mint a replacement voucher or rebuild a transfer automatically. |
| Resource execution fails | No settlement; provider reports the execution failure. |
| Payment fails after resource succeeds | Explicit observable settlement failure; resource result alone must not mark the test passed. |

## 11. Troubleshooting and resets

| Symptom | Check |
| --- | --- |
| `… is required: pass it to StellariumNode.start` | The node's env file is loaded and has that variable. |
| `/v1/run` answers 401 | `Authorization: Bearer` matches the caller's `API_KEY`. |
| Paid call answers 402 or 400 | The caller knows the provider's current manifest (restart it to relearn) and its `costLimitLamports` covers the cost. |
| Invalid DER / invalid public key | Caller env loaded into the invoker; SPKI/raw conversion in the operator. |
| Simulation error, custom program error 0 | Program was built with `ESCROW_AUTHORITY = None`; configure, rebuild, redeploy. |
| Custom program error 1 | Compiled authority differs from operator `PRIVATE_KEY` public address. |
| Withdrawal fails with custom program error 2 | Program was built with `PROTOCOL_FEE_RECIPIENT = None`; configure, rebuild, redeploy. |
| Withdrawal fails with custom program error 3 | Operator `PROTOCOL_FEE_RECIPIENT` differs from the compiled fee wallet. |
| `relation receipts does not exist` | The operator failed to apply migrations at startup; check its log and `DATABASE_URL`. |
| Receipt stuck `unconfirmed` | Reconciliation runs every `RECONCILE_INTERVAL_MS` (30s) and waits two minutes after the last change. Rows without `lastValidBlockHeight` need manual review. |
| `ECONNREFUSED` on 8899/8900 | Validator process, RPC/WS ports, and local URL. |
| Operator doesn't see a settlement | `OPERATOR_URL` includes `/v1`; provider voucher verification succeeded; background errors surfaced. |
| Signature not found | Check local RPC, wait for confirmation, check whether ledger was reset. A DB receipt is not chain proof. |
| Tiny payment to new recipient fails | Prefund recipient as in section 4 and examine simulation logs. |
| SBF syscall warnings / deploy failure | Record builder/validator versions, update compatible tooling, rebuild; unit tests do not validate binary runtime compatibility. |

Stop the caller/provider/operator before resetting their state. Stop the validator
before a ledger reset. For a clean scenario, choose a **new** ledger directory,
new node working directories, and a fresh database (or deliberately clear the
test-only receipt/settlement tables). Redeploy the same program ID, airdrop again,
recreate escrow, and fund it. Reusing receipts from a different ledger can cause
false replay conflicts or reference signatures that no longer exist.

To pause and resume, retain the ledger, PostgreSQL volume, keys, and each node's
SQLite file; restart PostgreSQL with `docker start stellarium-local-e2e-postgres`
and the validator without `--reset`. Keep signing identities stable or the caller
will derive a different escrow. Restore your temporary public authority source
edit deliberately when finished; private fixture files under `.keys/` and the
ledger under `.local-ledger/` are ignored by Git.

## Validation

- `pnpm build`, `pnpm check-types` and `pnpm test` pass. The tests include a two-node
  network test with real HTTP and a fake operator (discovery, a paid call, settlement,
  restart, cost limit), node route and repository tests on in-memory SQLite, and operator
  tests on in-memory PGlite with a fake Solana connection (claims, retries, reconciliation).
- All 23 Rust unit tests pass (`cargo test`).
- The validator-backed procedure in this guide has not been rerun since the fixes above.
