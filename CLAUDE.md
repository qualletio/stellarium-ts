# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

Stellarium is a decentralized API platform built on [RequestScript](https://www.npmjs.com/package/requestscript). Nodes share `Resources` with peers. Paid resource calls are settled on Solana through a centralized operator. See `AGENTS.md` for Turborepo guidance: read the installed `turbo` package's bundled docs before changing turbo config.

## Commands

The repo is a pnpm monorepo (`apps/*`, `packages/*`) driven by Turborepo. `test` depends on `build`.

```sh
pnpm install
pnpm build          # turbo run build (tsc -> dist/)
pnpm test           # turbo run test (vitest)
pnpm lint           # turbo run lint (biome lint src; formatter disabled)
pnpm turbo run build test lint --continue   # everything, without stopping at the first failure

# Single package / single test
pnpm --filter stellarium-ts test
pnpm --filter stellarium-ts exec vitest run src/tests/resource/invoker.test.ts -t "payment voucher"
pnpm --filter stellarium-ts check-types
```

CI (`.github/workflows/ci.yml`) runs `pnpm build`, `pnpm check-types` and `pnpm test` on Node 20, plus `cargo test` for the escrow program. `check-types` must run after `build`: the operator type-checks against `stellarium-ts`'s `dist/` declarations. Lint is not part of CI, and the operator has pre-existing biome errors.

**Operator DB schema changes** (`apps/operator/src/db/schema.ts`) need a generated migration committed under `apps/operator/drizzle/`. The operator applies migrations itself at startup.
```sh
cd apps/operator && DATABASE_URL='postgresql://stellarium:local-only-password@127.0.0.1:5432/stellarium' pnpm exec drizzle-kit generate
```
When it is ambiguous whether a column was renamed or newly created, drizzle-kit stops with `missing_hints`. Re-run with `--hints '[...]'` as the output instructs.

**Escrow program** (Rust, Solana): `cargo build-sbf --manifest-path programs/escrow_program/Cargo.toml --sbf-out-dir programs/escrow_program/target/deploy`. `ESCROW_AUTHORITY` and `PROTOCOL_FEE_RECIPIENT` in `src/lib.rs` must be set to real keys before deploying.

**Full local stack** (validator, Postgres, operator, two nodes): `docker compose up -d --build`. Setup is in the README's "Running Locally" section and in `docs/local-e2e.md`, which also lists known source blockers.

## Architecture

### Components
- **`packages/stellarium-ts`**: the node library, published to npm. `StellariumNode` (`src/server.ts`) collects registered resources, resolves a `NodeConfig` from its options and then the environment (`resolveConfig`), opens the SQLite DB (`openDatabase` in `src/db/db.ts`; `requestscript.db` in the cwd by default, `:memory:` in tests), mounts `src/routes.ts` at `/v1` on a caller-supplied Fastify instance, and optionally bootstraps from a `startingPeer` (`src/startup.ts`). Dependencies are wired together in `src/service.ts`. Nothing reads `process.env` outside `resolveConfig`, so several nodes can run in one process. SQLite schema changes that `CREATE TABLE IF NOT EXISTS` can't apply bump `SCHEMA_VERSION` in `db.ts`, which rebuilds the learned-resource tables.
- **`apps/operator`**: a Fastify service on port 3001 backed by Postgres and Drizzle. It verifies payment vouchers (`paymentService.ts`), withdraws from the user's escrow PDA on Solana (`escrow/escrowService.ts`, `solana/`), and tracks each voucher as a row in `receipts` (`repository.ts`): claimed `pending` before broadcast, then `confirmed`/`failed`/`unconfirmed`/`expired`. `EscrowService.reconcile` runs on an interval and resolves uncertain receipts from the chain. Only `failed`/`expired` vouchers can be settled again.
- **`programs/escrow_program`**: a native Solana program (not Anchor). It holds one escrow per (authority, user). Withdrawals pay 20% to the protocol fee wallet and 80% to the recipient.
- **`apps/local-caller-node` / `apps/local-resource-node`**: fixture nodes for local end-to-end runs. The resource node hosts a paid `com.example.Weather.temperature`. They depend on the workspace package (`"stellarium-ts": "workspace:*"`), which resolves to `packages/stellarium-ts/dist`. Rebuild the package (`pnpm --filter stellarium-ts build`) for changes to reach them. `docker compose up --build` does this already.

### Request flow
1. `POST /v1/run` parses a RequestScript `request` and runs it with `interpretParsed`, using the node's `CombinationResourceResolver` and `CombinationResourceInvoker` (`src/resource/`).
2. The invoker runs local resources in-process (`exec`). A resource with `metadata.baseUrl` (learned from a peer) is forwarded instead: the invoker POSTs `{resourcePath, resourceName, functionName, parameters}` to `{baseUrl}/v1/run/resource`, with retry and exponential backoff.
3. If the remote function is `restricted`, the caller attaches an authorization built from a held grant chain rooted at the provider (`GrantService.chainFor`). Without one, it fails before any network call.
4. If the remote function has a `paymentManifest`, the caller attaches a signed `PaymentVoucher`. Its `costLamports` is checked against the invoker's cost limit first. The provider's `/run/resource` requires a voucher for a paid function (402 without one) and checks its invocation hash, amount ≥ cost, recipient, expiry and signature against the function's own manifest. Only after an invoke without an error does it call `OperatorClient.settlePayment`, fire-and-forget in a `setTimeout`. The operator re-verifies the voucher, claims a receipt by `(requestId, invocationId)`, and settles on-chain.

### Signing and voucher invariants
- Keys are Ed25519: the public key is SPKI DER and the private key is PKCS#8 DER, both base64url (`SIGNING_PUBLIC_KEY`/`SIGNING_PRIVATE_KEY`). The operator derives the Solana user address from the raw 32 bytes inside the SPKI key (`solana/userAddress.ts`).
- `signData`, `verifyData` and `hashData` (`src/crypto/utils.ts`) operate on `JSON.stringify` output, not canonical JSON. **Key insertion order is part of the signed or hashed bytes.**
- The voucher carries `invocationHash`: the hash of `{resourcePath, resourceName, functionName, parameters}`, built by `invocationHash()` in `src/resource/invoker.ts`. The signature covers `paymentVoucherPayload(voucher)`, meaning every voucher field except `signature`, in a fixed order. The provider recomputes the hash from the incoming request. The operator receives only `{ voucher }`.
- The voucher wire format is duplicated in places that must stay in sync: `PaymentVoucher` in `packages/stellarium-ts/src/resource/invoker.ts`, `PaymentSubmission` in `packages/stellarium-ts/src/client/operatorClient.ts`, and `PaymentSubmission` plus the payload rebuilt by hand in `apps/operator/src/routes.ts`, `apps/operator/src/paymentService.ts` and `apps/operator/src/testing.ts`. `apps/operator/src/paymentService.test.ts` verifies a voucher made by the real `CombinationResourceInvoker`, so drift fails the test.
- Grants (`src/grant/`) are signed over `grantPayload` (every field except `signature`) and linked by `grantHash`. A call to a restricted function carries an `InvocationAuthorization` signed over `invocationAuthorizationPayload` (`{ invocationHash, publicKey, nonce, expiresAt, grantsHash }`). The provider checks it before the voucher, and refuses a nonce it has already seen, so the invoker signs a new authorization on each retry while reusing the voucher. Renewal requests are signed over `grantRenewalPayload`, and grant requests (`POST /v1/grants/request`, decided by the node's `approveGrant` hook) over `grantRequestPayload`, which signs omitted `details` as `null`. Keys blocked through `/v1/admin/blocked-callers` are refused in any chain audience, in renewals and requests, and as a voucher's `publicKey`. The `/v1/admin` routes share `/v1/run`'s `requireApiKey` hook.
- Peer announcements are signed over `peerAnnouncementPayload` (`{ baseUrl, name, publicKey, expiry }`) and verified with the announced key. Resource broadcasts are signed over `resourceAnnouncementPayload` (`{ resources, expiry }`) and carry the sender's `publicKey`. Both expiries must be within `MAX_SIGNATURE_LIFETIME_MS` (one hour). A peer may only publish resources served from its own base URL that no other peer owns.

### Conventions
- ESM throughout. Relative imports use `.js` extensions.
- `dist/` directories are build output. Don't edit them by hand.
- Tests live in `packages/stellarium-ts/src/tests/` (mirroring `src/`, shared fixtures in `tests/helpers.ts`, a two-node HTTP test in `tests/integration/`) and as `*.test.ts` files next to the source in the operator. Operator DB tests use in-memory PGlite with the committed migrations (`src/testing.ts`), so no Postgres is needed. Operator services take the `Database` type from `src/db/database.ts`, which both node-postgres and PGlite satisfy.
