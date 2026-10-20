# Escrow program

Creates one program-owned escrow state account per `(authority, user)` pair, plus
that PDA's USDC associated token account, and returns the PDA's 32-byte public key
through Solana return data. The controlling wallet must sign setup; the payer funds
rent for both accounts, and the user can be a readonly public key. The authority can
be the payer. Setup does not debit the user. Users fund the escrow by transferring
USDC to its token account. That same controlling wallet can withdraw USDC to a
chosen token account of the mint. Each withdrawal pays a 20% protocol fee to the
compiled `PROTOCOL_FEE_RECIPIENT` wallet's USDC associated token account. Amounts
are USDC base units (micro-USDC, 6 decimals).

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

Also replace the protocol fee wallet:

```rust
pub const PROTOCOL_FEE_RECIPIENT: Option<Pubkey> =
    Some(solana_program::pubkey!("PROTOCOL_FEE_WALLET_PUBLIC_KEY"));
```

Until configured, withdrawals fail with custom error `2` (setup still works). Passing
any fee account other than that wallet's USDC associated token account fails with
custom error `3`. The fee rate is `PROTOCOL_FEE_BPS` (2000 basis points = 20%);
changing either value requires a program upgrade.

And the USDC mint:

```rust
pub const USDC_MINT: Option<Pubkey> =
    Some(solana_program::pubkey!("USDC_MINT_ADDRESS"));
```

Use `EPjFWdd5AufqSSqeM2qZzJpgyyhwJaZgw7tFFtbs2Mn` on mainnet,
`4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU` on devnet, or a 6-decimal test mint
on localnet. Until configured, setup and withdrawal fail with custom error `4`.
Passing a different mint fails with custom error `5`. `USDC_DECIMALS` (6) must match
the mint, or the Token Program rejects every transfer.

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
pnpm --filter operator test
```

Rust unit tests cover authorization, instruction parsing, account validation,
reinitialization prevention, canonical PDA derivation, withdrawal balance changes,
protocol fee splitting and rounding, and failure atomicity. Withdrawal tests run the
Token Program CPIs in-process: a `SyscallStubs` implementation passes them to
spl-token's own processor, so token balances really move. Client tests cover
instruction construction, decoding, and budget queries. These are not validator
integration tests; exercise setup and withdrawal on localnet after configuring the
authority, fee wallet and mint.

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

const { escrowAddress, escrowTokenAddress, instruction } = createEscrowInstruction({
  programId: new PublicKey('DEPLOYED_PROGRAM_ID'),
  authority: new PublicKey('YOUR_PUBLIC_KEY'),
  user: new PublicKey('USER_PUBLIC_KEY'),
  mint: new PublicKey('USDC_MINT_ADDRESS'),
  // payer defaults to authority; specify another signer to sponsor rent.
});
console.log(escrowAddress.toBase58(), escrowTokenAddress.toBase58());
```

`escrowAddress` is derivable before signing and is the same address returned by
the program. `escrowTokenAddress` is its USDC associated token account (also
available from `getEscrowTokenAddress`), where deposits go. It exists on-chain only after successful transaction confirmation.
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
  mint: new PublicKey('USDC_MINT_ADDRESS'),
  requestedWithdrawalMicroUsdc: 10_000n, // 0.01 USDC
});

console.log({
  escrowTokenAddress: budget.escrowTokenAddress.toBase58(),
  availableMicroUsdc: budget.availableBudgetMicroUsdc.toString(),
  hasEnoughBudget: budget.hasEnoughBudget,
  slot: budget.slot,
});
```

The utility derives the escrow PDA and its USDC token account, and reads both at
`confirmed` commitment by default. It validates the escrow state and checks that
the token account belongs to the Token Program, holds the configured mint, and is
owned by the escrow PDA. Amounts are bigint micro-USDC (1 USDC = 1,000,000); convert
to decimal strings when serializing to JSON.

Results include:
- `totalBalanceMicroUsdc`.
- `availableBudgetMicroUsdc`: the whole token balance, or zero while the account is frozen.
- `requestedWithdrawalMicroUsdc`, which defaults to zero.
- `shortfallMicroUsdc`: the gap between the request and the available budget.
- `isInitialized`, `hasEnoughBudget`, and the snapshot's `slot`.

A missing state or token account means `isInitialized: false` and
`hasEnoughBudget: false`. Invalid escrow state, a token account with the wrong
mint or owner, and RPC failures throw rather than reporting a usable budget. The
PDA's SOL rent is separate from the USDC balance and is never spent.

This is a read-only USDC balance check. It does not reserve budget across concurrent
requests, include fees paid by a separate transaction payer, or grant withdrawal
permission. The withdrawal instruction checks authority and funds again on-chain. Providers
can read budgets, but only the controlling wallet can authorize payments.

## Withdraw USDC to a chosen account

Use `createWithdrawEscrowInstruction` from the escrow client adapter:

```ts
import { createWithdrawEscrowInstruction } from './solana/escrow.js';

const { instruction } = createWithdrawEscrowInstruction({
  programId,
  authority, // must match ESCROW_AUTHORITY and sign the transaction
  user,      // identifies which user's escrow to withdraw from
  recipient: new PublicKey('RECIPIENT_WALLET_PUBLIC_KEY'),
  feeRecipient: new PublicKey('PROTOCOL_FEE_WALLET_PUBLIC_KEY'), // must match the program
  mint: new PublicKey('USDC_MINT_ADDRESS'),
  amountMicroUsdc: 10_000n, // 0.01 USDC: 0.008 to recipient, 0.002 protocol fee
});
```

`recipient` and `feeRecipient` are wallets. The instruction pays their USDC
associated token accounts (`recipientTokenAddress`, `feeTokenAddress`). Both must
exist when the withdrawal runs. The operator requires the recipient to have created
its own account and refuses to settle otherwise. It prepends
`createAssociatedTokenAccountIdempotentInstruction` from `@solana/spl-token` only for
the protocol fee wallet's account.

The escrow token account is debited `amountMicroUsdc`. The protocol fee account
receives `protocolFee(amountMicroUsdc)` (20%, rounded down, so withdrawals under 5
micro-USDC pay no fee) and the recipient receives the rest. When the recipient is
the protocol fee wallet itself, no fee is split off and it receives the full amount.

Simulate the transaction, then have the controlling wallet sign and submit it
with your chosen fee payer, cluster and recent blockhash. A separate fee payer
also signs. Neither the recipient nor the protocol fee wallet signs, and the
recipient can be the controlling wallet.

The program checks:
- the configured signer, mint and Token Program;
- that the fee account is the fee wallet's associated token account;
- the escrow's owner, discriminator, stored authority, and canonical PDA and bump;
- that the escrow token account is the PDA's associated token account and is owned by the Token Program;
- that the token accounts are writable.

It rejects zero amounts, paying the escrow token account itself, and withdrawals
above its balance (`InsufficientFunds`). It then makes one or two `transfer_checked`
CPIs, signed with the PDA's seeds. Those leave the Token Program to enforce the
destination's mint, frozen state and overflow. If either transfer fails, the whole
transaction is rolled back. The escrow's state and SOL balance are untouched.

Withdraw instruction data is `[1]` followed by a positive **u64 amount in
micro-USDC, little-endian**, for a total of 9 bytes. Account order:

| Index | Account | Signer | Writable |
| --- | --- | --- | --- |
| 0 | Configured authority | Yes | No |
| 1 | Escrow PDA | No | No |
| 2 | Escrow token account (the PDA's USDC associated token account) | No | Yes |
| 3 | Recipient token account | No | Yes |
| 4 | Protocol fee token account (`PROTOCOL_FEE_RECIPIENT`'s associated token account) | No | Yes |
| 5 | USDC mint (`USDC_MINT`) | No | No |
| 6 | Token Program | No | No |

The authority becomes writable as well when it is the fee payer.
Neither the System Program nor a user signature is needed for withdrawal.

## Instruction and account format

Initialize instruction data is exactly `[0]`. Account order:

| Index | Account | Signer | Writable |
| --- | --- | --- | --- |
| 0 | Payer, System-owned wallet | Yes | Yes |
| 1 | User | No | No |
| 2 | Configured authority | Yes | No |
| 3 | Escrow PDA | No | Yes |
| 4 | Escrow token account (the PDA's USDC associated token account) | No | Yes |
| 5 | USDC mint (`USDC_MINT`) | No | No |
| 6 | System Program | No | No |
| 7 | Token Program | No | No |
| 8 | Associated Token Account Program | No | No |

PDA seeds: `[b"escrow", authority.to_bytes(), user.to_bytes()]`, with the canonical
bump. Prefunded empty System-owned PDAs are supported: setup tops up rent,
allocates 73 bytes, and assigns ownership to this program. It then creates the
PDA's USDC associated token account idempotently, so a token account someone
created ahead of time doesn't block setup. Duplicate setup fails without changing
the existing state.

| Byte offset | Length | Field |
| --- | --- | --- |
| 0 | 8 | `ESCROW02` discriminator/version (`ESCROW01` was the SOL escrow) |
| 8 | 32 | User public key |
| 40 | 32 | Authority public key |
| 72 | 1 | PDA bump |

Return data is the raw 32-byte escrow public key (not base58 text). On-chain
callers can use `get_return_data`; off-chain callers can derive the address or
read RPC transaction return data when available. Validate the return-data program
ID before trusting it.

## Funds and scope

This program supports escrow setup and authority-controlled USDC withdrawals,
each paying a 20% protocol fee.
An initialized escrow receives USDC through an ordinary SPL Token transfer to its
token account. Only the configured controlling wallet can release it. SOL sent to
the PDA is not spendable through this program. Reclaiming the PDA's and token
account's rent would require a future close instruction. There is no automatic
settlement logic. Your wallet also controls program
upgrades. Upgrades must preserve or explicitly migrate the state layout and check
this authority when releasing funds.
