# Stellarium Operator

The operator holds organizations' prepaid USD balances and moves money for paid calls
between them. Organizations top up by card through Stripe Checkout, and providers are
paid out through Stripe Connect Express (US only). The dashboard at
platform.stellarium.sh calls the operator's dashboard API; the dashboard itself is not
built yet. Without Stripe keys, balances come only from promotional credit, such as the
local development seed.

All amounts are integer micro-USD (1 USD = 1,000,000).

## Configuration

- `DATABASE_URL`: PostgreSQL connection string. Migrations in `drizzle/` are applied at startup.
- `PLATFORM_FEE_BPS`: the platform's share of each captured payment, in basis
  points. Defaults to 2000 (20%).
- `RATE_LIMIT_MAX` / `RATE_LIMIT_TIME_WINDOW`: per-IP limit on every route;
  defaults to 100 per minute.
- `MAINTENANCE_INTERVAL_MS`: how often expired holds and runs are released and
  payouts run; defaults to 30000.
- `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_CONNECT_WEBHOOK_SECRET`:
  enable top-ups, Connect onboarding and payouts. The two webhook secrets belong to the
  two endpoints below. Without a secret key, those features are off.
- `MIN_TOP_UP_CENTS` / `MAX_TOP_UP_CENTS`: default 1000 ($10) and 100000 ($1,000).
- `PAYOUT_HOLD_DAYS`, `PAYOUT_INTERVAL_DAYS`, `PAYOUT_MIN_MICRO_USD`: captured
  payments become payable after the hold, an organization is paid at most once per
  interval, and smaller balances wait. Default 7 days, 7 days and 10000000 ($10).
- `BETTER_AUTH_SECRET`: at least 32 characters. Enables dashboard sign-in (Better Auth,
  at `/v1/auth/*`) and the dashboard API. It signs session cookies.
- `RESEND_API_KEY`, `EMAIL_FROM`: send verification, password reset and invitation
  emails through Resend. Without them, the emails are logged instead.
- `RUN_TOKEN_PRIVATE_KEY`: an Ed25519 key (PKCS#8 DER, base64url, the format of a
  node's `SIGNING_PRIVATE_KEY`) that signs API clients' run tokens. Its public key is
  served at `/v1/.well-known/jwks.json`. Without it, `/v1/oauth/token` answers 503.
- `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`: offer GitHub sign-in. The OAuth app's
  callback URL is `<DASHBOARD_URL>/api/auth/callback/github`.
- `DASHBOARD_URL`: the dashboard's origin, default `https://platform.stellarium.sh`.
  It is the only CORS origin and the only origin Better Auth accepts. Links in emails
  point at it, and Stripe returns users to pages under it.

The operator listens on port 3001. The authorization and cookie headers are redacted
from server logs.

## Organizations and nodes

An organization owns node keys, a prepaid **balance** and a **payable** balance.
Its nodes' vouchers draw on its balance, and calls to its nodes' functions are paid
into its payable balance. A node key belongs to at most one organization.

A node joins an organization with a one-time enrollment token. The node presents the
token once, and after that only its key.

### Signed node requests

Every `/v1/nodes`, `/v1/payments` and `/v1/runs` request is signed by the calling node:

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
{ "enrollmentToken": "enr_…", "baseUrl": "https://node.example.com" }
```

Returns the signing node's organization: `{ "organizationId": "org_…" }`. A node that
isn't enrolled yet must send a token. The token is used up, and the node joins the
token's organization. An enrolled node's token is ignored. The operator answers 403
for an unenrolled node without a valid token, and for a revoked node.

`baseUrl`, optional, is where the node serves. Listing a node requires it. A listed
node that reports a different URL is unlisted until an admin lists it again.

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

A voucher with a `runId` is a paid call made by a [run](#api-clients-and-runs)'s script.
It must be signed by the run's node. The run's payer pays, and the amount moves from
the run's hold to the receipt instead of being held again. Authorization answers 402
when the run's remaining hold, less its token budget, can't cover the call, and 409
once the run has been captured or released.

## API clients and runs

An organization creates API clients on the dashboard. Each client is bound to one
node: either one of the organization's own nodes or another organization's listed
node. A client exchanges its credentials for a run token, and calls the node's
`POST /v1/run` with it as a Bearer token. The node verifies the token against
`GET /v1/.well-known/jwks.json`.

- A run on the organization's own node is free, and the operator isn't involved.
- A run on another organization's node is billed. The node authorizes the run first,
  which holds up to the client's `maxRunCostMicroUsd`. The hold is less when the
  balance or the client's monthly cap allows less, but it always covers the script's
  token budget. The script's paid calls draw on that hold. Afterwards, the node
  captures the run with the tokens the script executed.

### POST /v1/oauth/token

The OAuth 2.0 client credentials grant. The body is form-encoded or JSON:
`grant_type=client_credentials`, plus `client_id` and `client_secret` unless they're
sent with HTTP Basic. The response is
`{ "access_token": "…", "token_type": "Bearer", "expires_in": 900 }`.

The token is an EdDSA JWT with these claims:
- `iss`: `stellarium`
- `sub`: the client id
- `aud`: the node's public key, so no other node accepts it
- `org`: the paying organization
- `jti`: a unique id

Errors follow RFC 6749:
- `invalid_client` (401): unknown, revoked or wrongly authenticated client.
- `unauthorized_client` (400): frozen organization, or a node that is revoked or no longer listed.
- `unsupported_grant_type` (400).

### POST /v1/runs/authorize

`{ "token", "runId", "source" }`. `runId` is a UUID the node picks, so a retry finds the
same run. The operator parses `source` itself and computes the most tokens any run of
it can execute (`maxTokens` from `requestscript`). The node can't claim more than that.
The response is `{ "status": "held", "heldMicroUsd", "maxTokens", "tokenBudgetMicroUsd" }`.

| Status | When |
|---|---|
| 400 | The source isn't a request script |
| 401 | Invalid or expired token, a token for another node, or a revoked client |
| 402 | The script's token budget exceeds the client's maximum run cost, the balance can't cover it, or the monthly cap is reached |
| 403 | The node is revoked or no longer listed, or the payer organization is frozen |
| 409 | Another client's run already used this `runId` |
| 422 | The client is the node's own organization's (those runs are free), or a priced node's organization can't receive payouts |

### POST /v1/runs/capture

`{ "runId", "tokens" }`. Charges the tokens, capped at the run's `maxTokens`, at the
node's price when the run was authorized: `ceil(tokens × price / 1,000,000)`. The fee
is taken as for payments, and the rest of the run's own hold is released. A charge of
nothing releases the run instead. Calls the run paid for settle separately, before or
after it. Only the node that authorized the run can capture or release it.

### POST /v1/runs/release

`{ "runId" }`. Frees the run's own hold without charging. Runs that are never settled
are released ten minutes after their 15-minute lifetime ends.

## Dashboard API

Requests carry the Better Auth session cookie, which the dashboard forwards, and act on
the session's active organization. The first request from a dashboard organization
creates its operator organization, linked by `authOrganizationId`. Members can read.
Owners and admins can also move money and manage nodes.

Better Auth's own endpoints (sign-up, sign-in, organizations, invitations) are at
`/v1/auth/*`, reached through the dashboard's `/api/auth/*`. They are exempt from the
per-IP limit, since they all arrive from the dashboard, and Better Auth limits them per
client by `X-Forwarded-For`.

| Route | Who | |
|---|---|---|
| `GET /v1/org` | member | Balance, held, available and payable amounts, payout status |
| `GET /v1/org/receipts?as=payer\|provider` | member | Newest first; `limit` (max 100) and `before` (an id) page |
| `GET /v1/org/top-ups`, `GET /v1/org/payouts` | member | Paged the same way |
| `GET /v1/org/nodes` | member | Enrolled nodes, including revoked ones |
| `POST /v1/org/top-ups` `{ amountCents }` | admin | Returns `{ topUpId, url }`: send the user to the Checkout `url` |
| `POST /v1/org/billing-portal` | admin | Stripe Customer Portal URL |
| `POST /v1/org/connect/onboarding` | admin | Connect onboarding URL. Creates the Express account the first time |
| `POST /v1/org/connect/dashboard` | admin | Express dashboard login URL |
| `POST /v1/org/enrollment-tokens` `{ label? }` | admin | `{ token, expiresAt }`. The token is shown once and lasts 24 hours |
| `DELETE /v1/org/nodes/:publicKey` | admin | Revokes a node. Its key can't be enrolled again |
| `PATCH /v1/org/nodes/:publicKey` `{ name?, description?, priceMicroUsdPerMillionTokens?, listed? }` | admin | Lists or unlists a node, and sets its price. Listing needs a name and a reported `baseUrl` whose `/v1/self` answers with the node's key |
| `GET /v1/listings` | member | Every organization's listed nodes, with their price |
| `GET /v1/org/clients` | member | API clients, with what each spent this month. Secrets are never returned |
| `POST /v1/org/clients` `{ nodePublicKey, label?, maxRunCostMicroUsd?, monthlyCapMicroUsd? }` | admin | `{ client, clientSecret }`. The secret is shown once. The node must be the organization's own or listed. `maxRunCostMicroUsd` defaults to $1 |
| `PATCH /v1/org/clients/:id` `{ maxRunCostMicroUsd?, monthlyCapMicroUsd? }` | admin | `{ client }`. Omitted limits are kept, and a null `monthlyCapMicroUsd` removes the cap. 400 if the cap would be below the maximum run cost, 409 for a revoked client. Applies from the client's next run |
| `DELETE /v1/org/clients/:id` | admin | Revokes an API client |
| `GET /v1/org/runs?as=payer\|provider` | member | Runs, paged like receipts |

Billing routes answer 503 when Stripe isn't configured.

## Stripe

Balances change only when Stripe's webhooks confirm a payment, a refund or a dispute.
`POST /v1/stripe/webhook` takes the platform account's events, and
`POST /v1/stripe/connect-webhook` takes connected accounts' events. Each is verified
with its own signing secret, handled at most once per event id, and exempt from the
rate limit.

| Event | Effect |
|---|---|
| `checkout.session.completed`, `checkout.session.async_payment_succeeded` | A paid top-up credits the balance with what Stripe collected |
| `charge.refunded` | Debits the newly refunded amount |
| `charge.dispute.created` / `charge.dispute.closed` | Debits the disputed amount when the dispute opens (the balance may go negative, which stops the organization's nodes paying), and credits it back if the dispute is won |
| `account.updated` (Connect) | `payoutsEnabled` follows `payouts_enabled` with an active `transfers` capability |
| `transfer.reversed` | Credits the newly reversed amount back to the payable balance |

Register these events on the two endpoints in the Stripe dashboard. Payment methods
come from the dashboard's settings. For local development, run
`stripe listen --forward-to localhost:3001/v1/stripe/webhook --forward-connect-to localhost:3001/v1/stripe/connect-webhook`
and use the secret it prints for both endpoints.

### Payouts

Each maintenance pass pays each organization that is due a payout:
- payouts are enabled for it,
- it hasn't had a payout (even a failed one) in the last interval, and
- the payable balance captured before the hold window is at least the minimum.

That balance is rounded down to whole cents. The rest of the payable balance waits for
a later payout.

A payout is claimed (debiting the payable balance) before its Stripe transfer is sent
with the payout's id as the idempotency key:
- Stripe refuses the transfer: the payout fails and the amount returns to the payable balance.
- A transient error: the payout stays pending, and is retried with the same key after a minute.
- Pending for 23 hours: Stripe has forgotten the key, so a retry could pay twice. The payout is logged for review instead.

The platform absorbs card fees, Connect fees and lost disputes.

## Ledger

Every balance change (capture, run capture, top-up, refund, dispute, payout) is a balanced transaction in `ledger_entries`, an append-only,
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
