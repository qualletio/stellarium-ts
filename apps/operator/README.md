# Stellarium Operator

For a local setup with PostgreSQL, a Solana validator, and on-chain verification,
see the [local end-to-end runbook](../../docs/local-e2e.md).

The operator creates Solana escrow accounts and submits authority-controlled USDC
withdrawals. Its configured signer is the escrow authority and transaction fee
payer. The deployed escrow program must have the same public key configured in
`ESCROW_AUTHORITY`.

## Configuration

- `DATABASE_URL`: PostgreSQL connection string. Migrations in `drizzle/` are applied at startup.
- `ESCROW_PROGRAM_ID`: deployed escrow program address (also used for withdrawals).
- `PROTOCOL_FEE_RECIPIENT`: wallet receiving the 20% protocol fee on each
  withdrawal. Must equal the program's compiled `PROTOCOL_FEE_RECIPIENT`.
- `USDC_MINT`: the USDC mint escrows hold. Must equal the program's compiled
  `USDC_MINT`.
- `PRIVATE_KEY`: JSON-encoded Solana secret key byte array for the authority.
  Configure it privately; never include it in requests or logs.
- `OPERATOR_API_TOKEN`: bearer token for `POST /v1/escrow`. When unset, escrow
  creation rejects every request.
- `SOLANA_RPC_URL`: RPC endpoint; defaults to `http://localhost:8899`.
- `RATE_LIMIT_MAX` / `RATE_LIMIT_TIME_WINDOW`: per-IP limit on every route;
  defaults to 100 per minute.
- `RECONCILE_INTERVAL_MS`: how often uncertain receipts are checked against the
  chain; defaults to 30000.

The operator listens on port 3001. The authorization header is redacted from server
logs. Token holders are trusted operator callers; do not distribute the token as a
public resource-provider credential.

## POST /v1/escrow

Requires `Authorization: Bearer <OPERATOR_API_TOKEN>`.

```json
{ "user": "USER_SOLANA_PUBLIC_KEY" }
```

Creates the deterministic escrow for this user and the configured authority, along
with the escrow's USDC associated token account. The response's
`escrowTokenAddress` is where the user deposits USDC. The operator sponsors rent
and fees, which is why creation requires the token.

```json
{
  "escrowAddress": "ESCROW_PUBLIC_KEY",
  "status": "confirmed",
  "signature": "TRANSACTION_SIGNATURE",
  "blockhash": "RECENT_BLOCKHASH",
  "lastValidBlockHeight": 123
}
```

An already initialized and validated escrow returns `status: "existing"` and its
address, without sending another transaction. Submission and confirmation use
`confirmed` commitment. Every transaction is simulated before signing, and
submission also performs RPC preflight. Transactions use v0.

## POST /v1/payment

Resource providers submit the `PaymentVoucher` that the caller attached to the call
(`PaymentVoucher` in `packages/stellarium-ts/src/resource/invoker.ts`):

```json
{
  "voucher": {
    "requestId": "REQUEST_ID",
    "invocationId": "INVOCATION_ID",
    "amount": 500,
    "recipientAddress": "PROVIDER_SOLANA_PUBLIC_KEY",
    "signature": "BASE64URL_ED25519_SIGNATURE",
    "expiresAt": "ISO_EXPIRY",
    "invocationHash": "BASE64URL_SHA256",
    "publicKey": "BASE64URL_SPKI_PUBLIC_KEY"
  }
}
```

No token is needed: the voucher's signature authorizes the transfer. The signature
covers every field except `signature`, in the order above, as `JSON.stringify`
output (not canonical JSON). `amount` is a positive safe integer of micro-USDC (1 USDC = 1,000,000).
Checking that the amount and recipient match the function's price is the
provider's job, done before it runs the function.

The **escrow user is the raw Ed25519 public key inside the voucher's SPKI public
key**, converted to a Solana base58 address. Create the escrow with that address;
a different Solana wallet is not automatically linked to the node signing key.

The service verifies the signature and expiry, checks the escrow's state and its
USDC balance, simulates, claims a receipt, signs, submits and confirms. The
voucher's recipient must already have a USDC associated token account (initialized,
unfrozen, of `USDC_MINT`). Otherwise settlement is refused with `422` before a receipt
is claimed, so the voucher can be resubmitted once the account exists (until it expires).
The operator does not create recipient accounts. The transaction creates only the
protocol fee wallet's USDC token account, if missing, at the operator's expense. The program
then pays 20% of the amount (rounded down) to `PROTOCOL_FEE_RECIPIENT` and the
remaining 80% to the voucher's recipient.

## Payment replay protection

Each voucher is identified by `(requestId, invocationId)`, which is unique in the
`receipts` table. The receipt is claimed with status `pending` before the
transaction is broadcast, so a repeat or concurrent submission of the same voucher
gets 409 instead of paying twice. The receipt stores the transaction signature and
its `lastValidBlockHeight`, then moves to:

- `confirmed` when the withdrawal lands,
- `failed` when it lands with an error,
- `unconfirmed` when broadcast or confirmation was uncertain.

A reconciliation loop checks `pending` and `unconfirmed` receipts (once they are two
minutes old) against the chain. A transaction that landed becomes `confirmed` or
`failed`. One that was never seen and whose blockhash has expired becomes
`expired`. A `failed` or `expired` voucher can be submitted again by the same
signer, because nothing was paid. Receipts without a recorded block height (from
before it was stored) stay `unconfirmed` for manual review.

Do not mint a new voucher for an uncertain payment: different IDs are separate
authorizations.

## Results and failures

- 200: confirmed, or an existing escrow.
- 202: submission or confirmation is uncertain. The response includes
  `status: "unconfirmed"`, the transaction signature and blockhash lifetime.
  Reconciliation resolves it; check the signature before retrying.
- 400: malformed request body, invalid public key or recipient address.
- 401: missing/incorrect escrow bearer token, invalid voucher signature, or expired voucher.
- 404: escrow missing during withdrawal.
- 409: invalid escrow state, insufficient budget, or voucher already settled or in progress.
- 422: transaction simulation or confirmed execution failure.
- 500: unexpected failure (for example an RPC error). The node retries these.

## Tests

```sh
pnpm --filter stellarium-ts build   # the voucher contract test uses the node package
pnpm --filter operator test
```

Database tests run against in-memory PGlite with the committed migrations applied.
Solana calls go through a fake connection (`src/testing.ts`), so no transactions are
submitted to a cluster.
