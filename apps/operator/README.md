# Stellarium Operator

The operator holds organizations' prepaid USD balances and moves money for paid calls
between them. Providers will be paid out through Stripe Connect. Stripe top-ups,
payouts and the dashboard at platform.stellarium.sh are not built yet. Until they
are, balances come from promotional credit, such as the local development seed.

All amounts are integer micro-USD (1 USD = 1,000,000).

## Configuration

- `DATABASE_URL`: PostgreSQL connection string. Migrations in `drizzle/` are applied at startup.
- `PLATFORM_FEE_BPS`: the platform's share of each captured payment, in basis
  points. Defaults to 2000 (20%).
- `RATE_LIMIT_MAX` / `RATE_LIMIT_TIME_WINDOW`: per-IP limit on every route;
  defaults to 100 per minute.
- `MAINTENANCE_INTERVAL_MS`: how often holds past their voucher's expiry are
  released; defaults to 30000.

The operator listens on port 3001. The authorization header is redacted from server
logs.

## Organizations and nodes

An organization owns node keys, a prepaid **balance** and a **payable** balance.
Its nodes' vouchers draw on its balance, and calls to its nodes' functions are paid
into its payable balance. A node key belongs to at most one organization.

A node joins an organization with a one-time enrollment token. The node presents the
token once, and after that only its key.

### Signed node requests

Every `/v1/nodes` and `/v1/payments` request is signed by the calling node:

```
Authorization: Stellarium <base64url JSON { publicKey, timestamp, signature }>
```

`signature` is the node's Ed25519 signature over
`JSON.stringify({ method, path, bodyHash, timestamp })`, where `bodyHash` is the
base64url SHA-256 of `JSON.stringify(body)`. stellarium-ts's `operatorAuthorization`
builds the header. Timestamps more than five minutes from the operator's clock are
refused with 401.

### POST /v1/nodes/session

```json
{ "enrollmentToken": "enr_…" }
```

Returns the signing node's organization: `{ "organizationId": "org_…" }`. A node that
isn't enrolled yet must send a token. The token is used up, and the node joins the
token's organization. An enrolled node's token is ignored. The operator answers 403
for an unenrolled node without a valid token, and for a revoked node.

## Payments

A provider node authorizes a voucher before running a paid call. It then captures or
releases the voucher. The voucher is signed by the payer, and the request is signed by
the provider. Every step is idempotent per voucher (`requestId`, `invocationId`), so a
node may retry it.

### POST /v1/payments/authorize

`{ "voucher": … }`. Holds the voucher's `amount`, or an inference voucher's
`maxAmount`, on the payer organization's available balance (balance minus holds).
Answers `{ "status": "held", "heldMicroUsd": 10000 }`.

| Status | When |
|---|---|
| 400 | Malformed voucher, or a public key that isn't Ed25519 SPKI |
| 401 | Bad node or voucher signature, or an expired voucher |
| 402 | The payer node isn't enrolled, or the payer organization's available balance is too low |
| 403 | The signing node isn't in the voucher's recipient organization, the payer node is revoked, or the payer organization is frozen |
| 409 | Another voucher already used this `requestId` and `invocationId` |
| 422 | The payer and recipient are the same organization, or the recipient can't receive payouts |

### POST /v1/payments/capture

`{ "voucher": … }`, or `{ "voucher": …, "usage": { "inputTokens", "outputTokens" } }`
for an inference voucher. Any active node of the recipient organization may capture.
The charge is the voucher's `amount`, or the usage at the voucher's rates rounded up,
and is capped at the hold. The payer's balance is charged, and the recipient's payable
balance is credited with the charge less the platform fee. An inference charge of
nothing releases the hold instead. Answers
`{ "status": "captured", "amountMicroUsd": 10500 }` or `{ "status": "released" }`.
A voucher that was never authorized is refused with 404. One that was already
released, or that doesn't match the authorized voucher, is refused with 409.

### POST /v1/payments/release

`{ "voucher": … }`. Frees the hold without charging. A voucher that was already
captured is refused with 409.

Holds that are neither captured nor released are released ten minutes after their
voucher expires.

## Ledger

Every balance change is a balanced transaction in `ledger_entries`, an append-only,
double-entry ledger. The cached balances on `organizations` are updated in the same
database transaction. That transaction locks the organizations' rows, so concurrent
authorizations can't overspend a balance.

## Local development

`pnpm seed:dev` (after `pnpm build`) creates `org_local_provider` and
`org_local_caller`. It enrolls `SEED_PROVIDER_PUBLIC_KEY` and `SEED_CALLER_PUBLIC_KEY`
in them, marks the provider as payable, and credits the caller
`SEED_CALLER_CREDIT_MICRO_USD` (default $10) once. It is safe to run on every start.
`docker compose` runs it when `SEED_DEV=1`.

## Tests

```sh
pnpm test
```

Database tests use in-memory PGlite with the committed migrations. `e2e.test.ts`
runs real stellarium-ts nodes against the operator over HTTP.
