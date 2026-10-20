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
- `SOL_PRICE_USDC`: the price of one SOL in USDC (for example `150`), used to price
  settlement transaction fees. Required. Keep it current: a stale low price lowers
  the settlement threshold.
- `SETTLE_INTERVAL_MS`: how often uncertain settlements are checked against the
  chain and due receipts are paid out; defaults to 30000.

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

The service verifies the signature and expiry, checks the escrow's state and the
recipient's USDC token account, and records the voucher as an **accrued receipt**.
It sends no transaction and answers `202` with `status: "accrued"`. The voucher is
refused with `409` when the escrow's USDC balance can't cover it on top of
everything the payer already owes (accrued receipts, and settlements in flight or
just confirmed). A per-payer lock makes this check safe for concurrent vouchers.
The voucher's recipient must already have a USDC associated token account
(initialized, unfrozen, of `USDC_MINT`). Otherwise the voucher is refused with `422`
before a receipt is recorded, so it can be resubmitted once the account exists (until it expires).
The operator does not create recipient accounts.

## Settlement

A call can cost less than a Solana transaction, so receipts are paid in batches.
Every `SETTLE_INTERVAL_MS`, the operator groups accrued receipts by payer and
recipient and pays a group with one withdrawal of its total once the 20% protocol
fee on the total is at least 10 estimated transaction costs. Until then the group
is never paid, however old its receipts are; it stays accrued until later vouchers
raise it. The transaction cost is the RPC's fee for a
settlement transaction (`getFeeForMessage`), converted at `SOL_PRICE_USDC`.

Each withdrawal creates only the protocol fee wallet's USDC token account, if
missing, at the operator's expense. The program then pays 20% of the amount
(rounded down) to `PROTOCOL_FEE_RECIPIENT` and the remaining 80% to the recipient.
A group whose transaction fails simulation, for example because the escrow is
underfunded, stays accrued and is retried on the next pass. The operator logs
`Failed to settle accrued receipts` with the reason.

## Payment replay protection

Each voucher is identified by `(requestId, invocationId)`, which is unique in the
`receipts` table, so a repeat or concurrent submission of the same voucher gets
409. A voucher is accepted once and never needs to be resubmitted: the operator
pays it, retrying failed settlements itself.

Each withdrawal is a row in `settlements`. It is claimed with status `pending`,
and its receipts attached to it, before the transaction is broadcast, so two
passes can't pay the same receipt. The settlement stores the transaction signature
and its `lastValidBlockHeight`, then moves to:

- `confirmed` when the withdrawal lands,
- `failed` when it lands with an error,
- `unconfirmed` when broadcast or confirmation was uncertain.

A reconciliation pass checks `pending` and `unconfirmed` settlements (once they
are two minutes old) against the chain. A transaction that landed becomes
`confirmed` or `failed`. One that was never seen and whose blockhash has expired
becomes `expired`. A `failed` or `expired` settlement paid nothing, so its receipts
are detached and accrue again. Settlements without a recorded block height (from
before it was stored) stay `unconfirmed` for manual review.

## Results and failures

- 200: confirmed, or an existing escrow.
- 202: the voucher was accepted as an accrued receipt, or escrow creation is
  uncertain. An uncertain creation includes `status: "unconfirmed"`, the
  transaction signature and blockhash lifetime; check the signature before retrying.
- 400: malformed request body, invalid public key or recipient address.
- 401: missing/incorrect escrow bearer token, invalid voucher signature, or expired voucher.
- 404: the payer's escrow doesn't exist.
- 409: invalid escrow state, insufficient budget, or voucher already accepted.
- 422: the recipient has no usable USDC token account, or escrow creation failed
  simulation or execution.
- 500: unexpected failure (for example an RPC error). The node retries these.

## Tests

```sh
pnpm --filter stellarium-ts build   # the voucher contract test uses the node package
pnpm --filter operator test
```

Database tests run against in-memory PGlite with the committed migrations applied.
Solana calls go through a fake connection (`src/testing.ts`), so no transactions are
submitted to a cluster.
