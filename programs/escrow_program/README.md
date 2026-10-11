# Escrow program

Creates one program-owned escrow state account per `(authority, user)` pair and
returns its 32-byte public key through Solana return data. The controlling wallet
must sign setup; the payer funds rent, and the user can be a readonly public key.
The authority can be the payer. Setup does not debit the user. That same
controlling wallet can withdraw SOL to a chosen nonexecutable account while
preserving the escrow's rent reserve.

## TODO: configure your wallet

In `src/lib.rs`, replace:

```rust
pub const ESCROW_AUTHORITY: Option<Pubkey> = None;
```

with:

```rust
pub const ESCROW_AUTHORITY: Option<Pubkey> =
    Some(solana_program::pubkey!("YOUR_PUBLIC_KEY"));
```

Until configured, setup and withdrawal fail with custom error `0`. An incorrect authority
fails with custom error `1`. Only a public key belongs here.

Use that same wallet as the deployed program's **upgrade authority**. These are
separate concepts: the escrow account's runtime owner is this program; its data
stores your wallet as authority; the program's runtime owner is the Solana
loader, whose upgrade authority is your wallet. Changing upgrade authority does
not change the escrow authority compiled into the program.

## Build and test

From the repository root:

```sh
NO_DNA=1 cargo test --manifest-path programs/escrow_program/Cargo.toml
NO_DNA=1 cargo build-sbf --manifest-path programs/escrow_program/Cargo.toml \
  --sbf-out-dir programs/escrow_program/target/deploy
pnpm --filter operator exec tsc
node --test apps/operator/tests/*.test.mjs
```

Rust unit tests cover authorization, instruction parsing, account validation,
reinitialization prevention, canonical PDA derivation, withdrawal balance changes,
rent preservation, and failure atomicity. Client tests cover instruction
construction, decoding, and budget queries. These are not validator integration
tests; exercise setup and withdrawal on localnet after configuring the authority.

The installed builder (3.1.10) produced an SBPFv0 binary and warned about
`sol_log_`, `abort`, and `sol_memcpy_`. Its local `syscalls.txt` is empty; these
symbols appear in the upstream builder's
[known syscall list](https://github.com/anza-xyz/cargo-build-sbf/blob/master/cargo-build-sbf/src/syscalls.rs).
This indicates a local syscall-list problem, but runtime execution has not been
verified. Before deployment, use a current Solana build toolchain and validate
the configured binary on localnet.

The binary is `target/deploy/escrow_program.so`. Rebuild after setting the TODO.
For deployment, use `solana program deploy` on localnet/devnet and specify
`--upgrade-authority` with a signer for the wallet matching `ESCROW_AUTHORITY`
(e.g. your hardware wallet signer). Verify the resulting authority with
`solana program show <PROGRAM_ID>`. Do not use `--final`, which removes upgradeability.
No deployment or transaction submission is performed by this implementation.

## Client usage

The operator has an adapter for its existing `@solana/web3.js` dependency at
`apps/operator/src/solana/escrow.ts`:

```ts
import { PublicKey } from '@solana/web3.js';
import { createEscrowInstruction, decodeEscrowAccount } from './solana/escrow.js';

const { escrowAddress, instruction } = createEscrowInstruction({
  programId: new PublicKey('DEPLOYED_PROGRAM_ID'),
  authority: new PublicKey('YOUR_PUBLIC_KEY'),
  user: new PublicKey('USER_PUBLIC_KEY'),
  // payer defaults to authority; specify another signer to sponsor rent.
});
console.log(escrowAddress.toBase58());
```

`escrowAddress` is derivable before signing and is the same address returned by
the program. It exists on-chain only after successful transaction confirmation.
Have your wallet sign a transaction containing `instruction`; simulate before
sending and set the cluster, fee payer and recent blockhash. Both payer and
authority must sign if they differ. After confirmation, fetch the escrow account
and call `decodeEscrowAccount(programId, escrowAddress, account)` to validate its
owner, layout, address, and bump. The helper builds instructions without accessing
private keys or sending transactions. The operator service uses these helpers
to submit transactions through its configured signer; see `apps/operator/README.md`
for the `/escrow` route and signed manifest/voucher payment submissions.

## Check a resource provider's withdrawal budget

`apps/operator/src/solana/escrow-budget.ts` exports `getEscrowBudget`. Providers
can call it without a signing wallet, using their chosen cluster's RPC connection:

```ts
import { Connection, PublicKey } from '@solana/web3.js';
import { getEscrowBudget } from './solana/escrow-budget.js';

const budget = await getEscrowBudget({
  connection: new Connection('https://api.devnet.solana.com', 'confirmed'),
  programId: new PublicKey('DEPLOYED_PROGRAM_ID'),
  authority: new PublicKey('YOUR_PUBLIC_KEY'),
  user: new PublicKey('USER_PUBLIC_KEY'),
  requestedWithdrawalLamports: 10_000_000n, // 0.01 SOL
});

console.log({
  escrowAddress: budget.escrowAddress.toBase58(),
  availableLamports: budget.availableBudgetLamports.toString(),
  hasEnoughBudget: budget.hasEnoughBudget,
  slot: budget.slot,
});
```

The utility derives the escrow PDA, reads its balance and state at `confirmed`
commitment by default, validates the account, and queries the cluster's current
rent minimum for the 73-byte state. Amounts use bigint lamports (1 SOL =
1,000,000,000 lamports); convert to decimal strings when serializing to JSON.

Results include `totalBalanceLamports`, `rentReserveLamports`,
`availableBudgetLamports` (balance above rent, floored at zero),
`requestedWithdrawalLamports` (defaults to zero), `shortfallLamports` (the gap
between the request and available budget), `isInitialized`, `isRentExempt`,
`hasEnoughBudget`, and the account snapshot's `slot`. Missing accounts return
zero balance and `hasEnoughBudget: false`. Underfunded accounts also return
`hasEnoughBudget: false`, even for a zero request. Invalid escrow state or RPC
failures throw rather than reporting a usable budget. Unsafe numeric RPC balances
are rejected to avoid precision loss in the operator's existing web3.js SDK.
Zero rent responses are also rejected because this SDK can return zero on RPC
errors.

This is a read-only SOL balance check. It does not reserve budget across concurrent
requests, include fees paid by a separate transaction payer, or grant withdrawal
permission. The withdrawal instruction checks authority and funds again on-chain. Providers
can read budgets, but only the controlling wallet can authorize payments.

## Withdraw SOL to a chosen account

Use `createWithdrawEscrowInstruction` from the escrow client adapter:

```ts
import { createWithdrawEscrowInstruction } from './solana/escrow.js';

const { instruction } = createWithdrawEscrowInstruction({
  programId,
  authority, // must match ESCROW_AUTHORITY and sign the transaction
  user,      // identifies which user's escrow to withdraw from
  recipient: new PublicKey('RECIPIENT_PUBLIC_KEY'),
  amountLamports: 10_000_000n, // 0.01 SOL
});
```

Simulate the transaction, then have the controlling wallet sign and submit it
with your chosen fee payer, cluster and recent blockhash. A separate fee payer
also signs. The recipient needs no signature and can be the controlling wallet.
For a newly created recipient account, fund it sufficiently to satisfy the
cluster's rent rules; simulation will report any runtime rejection.

The program checks the configured signer, escrow owner, discriminator, stored
authority, canonical PDA and bump, and writable accounts. It rejects zero amounts,
self-transfers to the escrow, executable recipients, overflow, and withdrawals
that would consume the rent reserve. Balance changes conserve lamports and leave
the escrow's state intact. SOL is debited directly from the program-owned account.

Withdraw instruction data is `[1]` followed by a positive **u64 amount in
little-endian order**, for a total of 9 bytes. Account order:

| Index | Account | Signer | Writable |
| --- | --- | --- | --- |
| 0 | Configured authority | Yes | No |
| 1 | Escrow PDA | No | Yes |
| 2 | Chosen recipient | No | Yes |

The authority becomes writable as well when it is the recipient or fee payer.
Neither the System Program nor a user signature is needed for withdrawal.

## Instruction and account format

Initialize instruction data is exactly `[0]`. Account order:

| Index | Account | Signer | Writable |
| --- | --- | --- | --- |
| 0 | Payer, System-owned wallet | Yes | Yes |
| 1 | User | No | No |
| 2 | Configured authority | Yes | No |
| 3 | Escrow PDA | No | Yes |
| 4 | System Program | No | No |

PDA seeds: `[b"escrow", authority.to_bytes(), user.to_bytes()]`, with the canonical
bump. Prefunded empty System-owned PDAs are supported: setup tops up rent,
allocates 73 bytes, and assigns ownership to this program. Duplicate setup fails
without changing the existing state.

| Byte offset | Length | Field |
| --- | --- | --- |
| 0 | 8 | `ESCROW01` discriminator/version |
| 8 | 32 | User public key |
| 40 | 32 | Authority public key |
| 72 | 1 | PDA bump |

Return data is the raw 32-byte escrow public key (not base58 text). On-chain
callers can use `get_return_data`; off-chain callers can derive the address or
read RPC transaction return data when available. Validate the return-data program
ID before trusting it.

## Funds and scope

This program supports escrow setup and authority-controlled SOL withdrawals.
An initialized escrow can receive SOL through an ordinary System Program transfer;
only the configured controlling wallet can release it. Withdrawals preserve rent,
so reclaiming the rent reserve would require a future close instruction. There is
no token vault or automatic settlement logic. Your wallet also controls program
upgrades. Upgrades must preserve or explicitly migrate the state layout and check
this authority when releasing funds.
