# Stellarium Operator

For a source-audited local setup with PostgreSQL, a Solana validator, and
on-chain verification, see the [local end-to-end runbook](../../docs/local-e2e.md).
This README describes intended behavior in several places (including escrow
authorization and durable payment replay protection) that the current source
does not yet implement. Consult the runbook's blocker list before testing.

The operator creates Solana escrow accounts and submits authority-controlled SOL
withdrawals. Its configured signer is the escrow authority and transaction fee
payer. The deployed escrow program must have the same public key configured in
`ESCROW_AUTHORITY`.

## Configuration

- `DATABASE_URL`: existing PostgreSQL connection configuration.
- `ESCROW_PROGRAM_ID`: deployed escrow program address (also used for withdrawals).
- `PRIVATE_KEY`: existing server signer configuration, JSON-encoded Solana secret
  key byte array. Configure it privately; never include it in requests or logs.
- `OPERATOR_API_TOKEN`: required bearer token for authenticated operator callers.
- `SOLANA_RPC_URL`: RPC endpoint; defaults to `https://api.devnet.solana.com`.

`PAYMENT_PROGRAM_ID` is no longer needed: setup and withdrawal are instructions
of the same escrow program. Escrow initiation requires
`Authorization: Bearer <OPERATOR_API_TOKEN>`. Payment submissions are authenticated
by the signed voucher and do not require the operator token. The authorization
header is redacted from server logs. Token holders are trusted operator callers;
do not distribute this token as a public resource-provider credential.

## POST /v1/escrow

```json
{ "user": "USER_SOLANA_PUBLIC_KEY" }
```

Creates the deterministic escrow for this user and the configured authority. The
operator sponsors rent and fees. A confirmed creation returns HTTP 201:

```json
{
  "escrowAddress": "ESCROW_PUBLIC_KEY",
  "status": "confirmed",
  "signature": "TRANSACTION_SIGNATURE",
  "blockhash": "RECENT_BLOCKHASH",
  "lastValidBlockHeight": 123
}
```

An already initialized and validated escrow returns HTTP 200 with
`status: "existing"` and its address, without sending another transaction.
Submission and confirmation use `confirmed` commitment. Every transaction is
simulated before signing, and submission also performs RPC preflight. Transactions
use v0 for compatibility with the operator's existing web3.js v1 dependency.

## POST /v1/payment

Resource providers submit the `PaymentVoucher` from
`packages/stellarium-ts/src/resource/invoker.ts` and the
`StellariumResourceFunctionPaymentManifest` from
`packages/stellarium-ts/src/resource/repository.ts`, plus the original invocation
context:

```json
{
  "manifest": {
    "id": 1,
    "costLamports": 500,
    "recipientAddress": "PROVIDER_SOLANA_PUBLIC_KEY"
  },
  "voucher": {
    "requestId": "ORIGINAL_REQUEST_ID",
    "invocationId": "ORIGINAL_INVOCATION_ID",
    "amount": 500,
    "recipientAddress": "PROVIDER_SOLANA_PUBLIC_KEY",
    "signature": "BASE64URL_ED25519_SIGNATURE",
    "expiresAt": "ORIGINAL_ISO_EXPIRY",
    "publicKey": "BASE64URL_SPKI_PUBLIC_KEY"
  },
  "resourcePath": "com.example",
  "resourceName": "Weather",
  "parameters": [{ "name": "city", "value": "Oslo" }]
}
```

`createPaymentVoucher` signs the invocation context but does not include it in the
returned voucher. Send the exact `resourcePath`, `resourceName`, and `parameters`
used when creating the voucher. Preserve parameter object contents and key order:
`signData` signs `JSON.stringify`, not canonical JSON.

The operator verifies the Ed25519 signature using exactly the invoker's signed
field order, checks that the voucher is unexpired, and requires its amount and
recipient to match the manifest. The manifest is metadata, not independently
signed authorization; the voucher authorizes the transfer. Amounts are positive
safe-integer lamports, matching the current node types.

The **escrow user is the raw Ed25519 public key represented by the voucher's
SPKI public key**, converted to a Solana base58 address. Create the escrow with
that address; a different Solana wallet is not automatically linked to the node
signing key. The API accepts no caller-supplied escrow user or transfer overrides.
A valid voucher allows the operator's configured controlling wallet to submit
only the signed amount to the signed recipient. The service validates escrow
state and budget above rent, simulates, checks expiry again, signs, submits, and
confirms. A confirmed payment returns HTTP 200 with the same result fields as
escrow creation.

## Payment replay protection

The service creates `operator_payment_settlement` in the configured PostgreSQL
database on the first valid payment. The database role needs permission to create
this table (or provision it ahead of time from `payment-store.ts`). A unique claim
for the signer, request ID and invocation ID prevents concurrent or repeated
voucher payments across operator processes and restarts. Signed-payload
fingerprints reject reuse of that identity with different contents.

The transaction signature and blockhash lifetime are committed before broadcast.
Repeating an unexpired voucher returns its saved result without sending again.
Unconfirmed results remain unconfirmed until reconciled externally; check the
saved signature's chain status. Claims are never automatically released: a crash
before signature persistence returns a processing conflict on retry and requires
manual reconciliation. Failed claims return their saved error. Do not mint a new
voucher for an uncertain payment: different IDs are separate authorizations.
Expiry validation still applies to repeated submissions.

## Results and failures

- 400: malformed request or invalid public key.
- 401: missing/incorrect escrow bearer token or invalid voucher signature.
- 404: escrow missing during withdrawal.
- 410: voucher expired.
- 409: invalid escrow state, insufficient budget, conflicting voucher, or payment already processing.
- 422: transaction simulation or confirmed execution failure.
- 502: RPC or unexpected service failure before submission.
- 202: submission or confirmation is uncertain. The response includes
  `status: "unconfirmed"`, the locally derived transaction signature and blockhash
  lifetime. Check that signature before retrying; rebuilding a withdrawal creates
  a new transaction and can pay twice. The service does not automatically rebuild
  transactions after an uncertain result.

The current Solana program still has a public-key TODO and must be configured
and deployed before setup or withdrawal succeeds on-chain.

## Tests

```sh
pnpm --filter operator exec tsc
node --test apps/operator/tests/*.test.mjs
```

Tests use Fastify injection and mocked RPC calls, with ephemeral test signers.
They do not submit transactions to a live cluster.
