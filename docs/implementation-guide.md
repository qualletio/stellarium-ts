# Build Stellarium: a step-by-step implementation guide

## Start here

This guide assumes you can work with TypeScript and HTTP APIs but have never built a Solana program. It introduces the Rust and proof concepts you need as you go. Follow the steps in order and finish each checkpoint before advancing. Commands are instructions for you to run; creating this guide has not installed tools, generated wallets, or deployed anything.

The target is [the ZK rollup plan](zk-rollup-plan.md): one centralized Stellarium operator posts accounting data and proofs to Solana. Solana holds SOL and verifies accounting proofs. Providers remain trusted to deliver correct API data. Functions without a `PaymentManifest` bypass payment completely.

You will build four successive demonstrations:

| Demonstration      | What you will see                                                                              |
| ------------------ | ---------------------------------------------------------------------------------------------- |
| Solana basics      | A local program stores state and accepts a signed instruction.                                 |
| Accounting         | One paid call reserves a budget and credits a provider; a free call bypasses it.               |
| Real ZK settlement | A valid accounting proof advances Solana state; an altered proof or unauthorized charge fails. |
| Recovery           | Users withdraw or exit even when the operator stops.                                           |

A rollup is a substantial project. The early escrow and small-circuit exercises are learning tools, not production shortcuts. No step permits an operator signature to replace an accounting proof in the actual settlement program.

Documentation links and tooling instructions were checked on October 10, 2026. Record the versions that work on your machine; do not independently upgrade different parts of the toolchain halfway through a milestone.

## 1. Learn the vocabulary before writing a program

Read [Solana core concepts](https://solana.com/docs/core), then explain these terms in your own words:

| Term                    | Meaning for Stellarium                                                                             |
| ----------------------- | -------------------------------------------------------------------------------------------------- |
| Wallet/keypair          | A signing identity; possession of the private key authorizes actions.                              |
| Account                 | An address containing lamports, data, and an owner program. It is not necessarily a wallet.        |
| Program                 | Code deployed to Solana, comparable to a contract.                                                 |
| Instruction             | One request to a program with arguments and accounts.                                              |
| Transaction             | A signed bundle of instructions that succeeds or rolls back together, apart from transaction fees. |
| PDA                     | A deterministic address controlled through program rules, with no ordinary private key.            |
| Lamport                 | The integer unit of SOL; 1 SOL is 1,000,000,000 lamports.                                          |
| RPC                     | The network API used to submit transactions and read state.                                        |
| Localnet/devnet/mainnet | A local test chain, a public test network, and the real network.                                   |
| Commitment              | How strongly the RPC reports a transaction/state as confirmed.                                     |
| IDL                     | Anchor's machine-readable description of a program's instructions and accounts.                    |
| State root              | A hash committing to the rollup's accounting state.                                                |
| Witness/proof/verifier  | The private computation inputs, evidence of correct computation, and code checking that evidence.  |

A Solana account's owner program is different from the human payer authorized by fields in its data. Your operator key must not own unrestricted withdrawal authority.

**Checkpoint:** explain why a provider signature alone cannot debit a caller's wallet, and why a batch root alone does not prove correct accounting.

## 2. Install tools and record versions

On your Mac, follow the [official Solana installation guide](https://solana.com/docs/intro/installation). Review its installer before running the official command:

```sh
curl --proto '=https' --tlsv1.2 -sSfL https://solana-install.solana.workers.dev | bash
```

Restart your terminal, then run:

```sh
rustc --version
cargo --version
solana --version
anchor --version
node --version
pnpm --version
```

Save their output in `docs/development-toolchain.md`, along with your macOS/CPU architecture. Use the compatible Anchor CLI and Rust crates recommended by the installed starter template. Commit Rust and JavaScript lockfiles. Use a stable Anchor template, not a preview template merely because it has a larger version number.

If a command is unavailable, fix installation/PATH using the official instructions before proceeding. Do not install the entire prover stack yet.

**Checkpoint:** all six commands work in a fresh terminal.

## 3. Create test identities and protect local files

From the repository root, first add these entries to `.gitignore`:

```gitignore
.keys/
.learning/
solana/target/
crates/**/target/
proof-artifacts/
.local-ledger/
```

Then create development-only identities:

```sh
mkdir -p .keys
solana-keygen new --outfile .keys/payer.json
solana-keygen new --outfile .keys/provider.json
solana-keygen new --outfile .keys/operator.json
```

These files contain secrets; their filenames are not public wallet addresses. Do not use them for mainnet funds or publish their contents. A mnemonic passphrase does not make the generated JSON file safe to commit. Obtain public addresses with `solana-keygen pubkey .keys/payer.json`, and similarly for the others.

Set the CLI to the payer and local RPC:

```sh
solana config set --url localhost --keypair "$PWD/.keys/payer.json"
solana config get
```

The generated Anchor wallet path may still point elsewhere. Set its `[provider].wallet` to your development payer's absolute path when you create the project. See [Solana CLI basics](https://solana.com/docs/intro/installation/solana-cli-basics).

**Checkpoint:** configuration reports local RPC and the intended payer. `git status --short` shows no secret files.

## 4. Learn the small amount of Rust needed first

Work in an ignored learning directory:

```sh
mkdir -p .learning
cd .learning
cargo new rust_basics
cd rust_basics
cargo run
cargo test
```

Read the [Rust Book](https://doc.rust-lang.org/book/): Cargo, structs/enums, ownership/borrowing, `Result`, and tests. Write a small balance struct and a transfer function returning an error on insufficient balance. Practice:

```rust
let remaining = balance.checked_sub(amount).ok_or("insufficient balance")?;
```

This line assumes a function returning `Result`; it is an arithmetic pattern, not a complete program. Test zero, exact balance, insufficient balance, and overflow on the destination. Avoid floats and unchecked integer conversion.

**Checkpoint:** you can write and test a transfer without reading or writing a database.

## 5. Build your first Anchor program

Return to the repository root, then use an ignored learning project:

```sh
cd .learning
anchor init solana_basics
cd solana_basics
anchor build
anchor test
```

Follow [Solana's first-program walkthrough](https://solana.com/docs/intro/quick-start/build-first-program). Inspect `Anchor.toml`, the program under `programs/`, its account structs, instructions, and tests. Current starter templates can run Rust tests through LiteSVM without a background validator; read the generated test command rather than assuming every template runs TypeScript tests.

Modify the starter counter to record an authority and permit only that signer to increment. Add a wrong-authority test and an overflow test. Learn how Anchor validates accounts through `#[derive(Accounts)]`, seeds, bumps, `Signer`, and ownership checks.

**Checkpoint:** the valid signer changes state; a different signer cannot. A failed instruction leaves the counter unchanged.

## 6. Connect to an actual local RPC

In a dedicated terminal, start the installed local-chain tool. The official installer provides Surfpool; follow its [local CLI guide](https://solana.com/docs/intro/installation/surfpool-cli-basics) for `surfpool start` and its network/storage options. If your selected toolchain instead provides `solana-test-validator`, use that tool's local setup instructions. Do not run two servers on the same RPC port.

In a second terminal, confirm your RPC and fund the local payer:

```sh
solana config get
solana airdrop 2
solana balance
```

From the learning Anchor project, verify `[provider].cluster = "localnet"` and the wallet path. Deploy with `anchor deploy --provider.cluster localnet`. Use the generated IDL and a compatible TypeScript client to read the counter and submit an increment. Pick the client recommended by that Anchor release and pin it; do not mix unrelated SDK generations.

Use one testing mode at a time: in-process LiteSVM tests or RPC integration tests with an already-running server. Consult [Anchor configuration](https://www.anchor-lang.com/docs/references/anchor-toml) before changing automatic validator startup.

**Checkpoint:** a TypeScript script changes state on your local RPC and prints a transaction signature and the decoded counter value.

## 7. Build an escrow learning exercise

Extend the learning program, not the production settlement program. Create an escrow PDA storing its payer and deposited amount. Implement a signed deposit and a payer-only refund. This direct refund teaches account handling; it will not be copied into the rollup, where refunds need proven accounting or the escape protocol.

Define PDA seeds first, for example `b"learning_escrow"` and payer public-key bytes. Use System Program CPI to transfer from the signer wallet into the vault. If the vault is a data-bearing program-owned account, refund by authorized lamport mutation, preserving required storage funding until closure. Account ownership and transfer details are covered in [Solana account rules](https://solana.com/docs/core/accounts/modification-rules).

Test deposit, wrong payer, duplicate initialization, insufficient funds, prefunded-PDA handling, refund, and repeat refund. Measure balances while separately accounting for fees and storage funding.

**Checkpoint:** someone who knows the PDA cannot withdraw. Deposit/refund do not create lamports. You can explain the difference between the vault balance and its spendable accounting allocation.

## 8. Create the target workspaces

Return to the repository root. Create the real program scaffold:

```sh
anchor init solana
mkdir -p crates
cargo new --lib crates/accounting
mkdir -p packages/payment-sdk services/operator circuits proof-artifacts
```

This layout is proposed work to create, not existing implementation:

```text
solana/                  Anchor workspace and real settlement program
crates/accounting/       deterministic reference accounting engine
packages/payment-sdk/    typed encoders, caller signing, RPC wrappers
services/operator/       sequencing, batch building, publication, outbox
circuits/                proof implementation chosen after feasibility
proof-artifacts/         ignored local proofs and setup artifacts
```

Keep the existing node under `src/`. Preserve the generated Anchor manifests and client conventions. Configure package/workspace tooling deliberately if you want a monorepo; creating directories does not establish workspace imports automatically.

Create `docs/protocol-v1.md` for exact schemas, transitions, signed bytes, roots, nonces, and deadline rules. Resolve these before the circuit uses them. The older interfaces in the monetization guide are sketches, not a finalized protocol.

**Checkpoint:** the accounting crate and untouched Anchor scaffold build independently.

## 9. Define wire encodings and signatures

Implement in the payment SDK: decimal-string lamport parsing, u64 bounds, fixed 32-byte IDs, typed invocation hashing, domain-separated signed messages, and signature verification. Specify field order, byte lengths, endianness, timestamp units, nonce scopes, and exclusions for `signature`/derived hashes in `protocol-v1.md`.

Generate IDs with a cryptographic random generator. Use the scope `(deployment, payer, requestId, invocationId)` for replay keys. Match Solana raw public keys to Node's key representations through an explicit conversion; existing `src/crypto/utils.ts` uses DER keys and `JSON.stringify` and is not a canonical payment protocol encoder.

Create shared golden vectors containing message bytes, expected hashes, public keys, signatures, and decoded fields. Rust and TypeScript must produce identical results. Include mismatched recipients, amounts, domains, deadlines, unknown fields, and malformed encodings.

**Checkpoint:** every alteration to an authorized field fails verification. No payment amount passes through a floating-point or unrestricted JavaScript-number path.

## 10. Implement the reference accounting engine

Build pure functions in `crates/accounting/`; they take previous state and an operation and return new state or an error. No RPC, HTTP, real clock reads, or database access inside transition logic.

| Operation          | Required effect                                                       |
| ------------------ | --------------------------------------------------------------------- |
| Credit deposit     | Consume one authenticated inbox entry exactly once; credit payer.     |
| Open request       | Move payer funds into a bounded request allocation.                   |
| Reserve invocation | Verify voucher; move availability to reservation exactly once.        |
| Consume receipt    | Verify provider signature; consume reservation and credit provider.   |
| Expire reservation | Release unused reservation only after its signed deadline.            |
| Expire request     | Release available allocation; do not release live reservations early. |
| Create withdrawal  | Debit balance and create an immutable unique ticket.                  |

Start with this reproducible scenario in lamports:

```text
Deposit payer:                   1,000,000
Allocate request:                 600,000
Reserve and consume one call:     100,000
Provider balance after receipt:   100,000
Payer balance outside request:    400,000
Request availability:             500,000
Expire request: payer balance ->  900,000
Create provider withdrawal:       100,000 ticket; provider balance -> 0
```

Assert conservation after every operation. A receipt with a different hash must not create a second payment for the same invocation. Test receipt versus expiry ordering and a withdrawal whose recipient is altered. Keep accepted/pending/paid statuses separate from execution status in the provider database.

**Checkpoint:** valid sequences preserve assets; randomized invalid sequences fail without mutating state.

## 11. Build and learn authenticated state commitments

Learn a Merkle tree: leaves commit to entries, the root commits to all entries, and a path proves membership. Specify deterministic key ordering, leaf/internal-node domain separation, empty nodes, tree depth, and non-membership proofs. Fix these rules before comparing roots across languages.

Implement a small tree with an established hash in the reference engine first. Test insert/update, membership/non-membership, malformed paths, and deterministic root reconstruction. Do not treat an inclusion proof as proof that a charge was authorized. The ZK circuit must validate the state transition as well.

Represent a 256-bit digest with unambiguous limbs/bytes when entering a proof system; reducing it modulo a field can lose information. Final hash/tree choices depend on the proof benchmark, so retain versioned test vectors.

**Checkpoint:** an independent process rebuilds the same root from serialized operations and cannot prove a different balance with a modified path.

## 12. Learn ZK proofs with a disposable circuit

Use the [Circom/snarkjs tutorial and installation instructions](https://github.com/iden3/snarkjs) for a small arithmetic proof. Record compiler/prover versions and pin them in a separate learning directory. This is a teaching stack, not yet the rollup-stack decision.

Create a circuit that constrains private factors `a` and `b` to multiply to public `c`. Prove `a = 3`, `b = 4`, `c = 12`; change public `c` to 13 and verify rejection. Follow the official tutorial for compiling, witness generation, a local development setup, proof creation, and verification. Its Solidity-verifier export is for Ethereum, not a Solana verifier.

Save the circuit, witness input, verification key, proof, and public inputs under ignored development artifacts. Explain the difference between computing a witness and constraining it: assigning a value without constraints does not establish correctness.

**Checkpoint:** you can generate a real proof, explain its public inputs, and make verification fail by altering a public input. Tutorial setup keys are development-only.

## 13. Run the critical proof/Solana feasibility spike

Before building the operator service, prove one real signed accounting transition and verify it on local Solana. Compare a native accounting circuit and a zkVM only if each has a demonstrable path to a Solana-verifiable proof.

The candidate BN254/Groth16 route uses documented [Solana group/pairing syscalls](https://solana.com/docs/core/programs/syscall-reference). Select a maintained verifier implementation, inspect its dependencies and field/point encodings, and implement an isolated Anchor verification instruction. Do not handwrite pairing cryptography as a beginner exercise.

Your witness must include actual payer and provider signatures, valid Merkle updates, bounded lamport arithmetic, and replay checks. Public inputs bind domain, parent/new roots, inbox prefix, data commitment, withdrawal commitment, and validity interval. Measure Ed25519 and hash cost inside the proof; off-chain signature validation alone is not enough.

Record proof size, public-input size, witness/proving time, peak memory, verification compute, transaction bytes, and setup requirements in `docs/proof-benchmark.md`. Verify a valid proof, then reject changed public inputs, corrupted proof points, a wrong verifying key, forged signatures, and out-of-range amounts. Generate a new witness/proof for invalid operations to test circuit constraints, not just proof-byte corruption.

**Checkpoint:** a real signature-checking proof verifies on local Solana within measured limits. If it does not, revise the proof stack now. Do not continue with an operator-approved root as a substitute.

## 14. Build real Solana deposits and the inbox

In the settlement program, create deployment configuration, a program-owned vault, and an authenticated monotonically ordered deposit inbox. Require the funding signer and actual SOL transfer. Bind deposit IDs, payer, amount, deployment, and cursor.

Expose finalized deposits through a TypeScript client. Persist the consumed cursor in rollup state. Anchor the canonical inbox prefixes used by proofs on-chain; do not create deposits from unverified HTTP responses or transaction logs alone. Deposits during proof generation must not invalidate a previously valid prefix.

Handle incidental vault deposits as uncredited funds, separate from accounted deposits and storage funding. Specify their recovery destination. There is no production direct-refund instruction borrowed from Step 7.

**Checkpoint:** a deposit credits once, cannot be invented by the operator, and remains correctly ordered across RPC restart and new concurrent deposits.

## 15. Build immutable batch-data publication

Define exactly which public bytes reconstruct the accounting transitions, including canonical authorizations/signatures and receipts. Keep API inputs/results off-chain.

Implement operator-authorized chunk upload, ordered data commitment verification, and sealing. Use deterministic chunk addresses and explicit lengths/indexes. A sealed batch cannot be edited. Use bounded hashing or incremental verification so sealing does not require unbounded compute; prove that the circuit's data commitment binds those exact published bytes.

Build an independent downloader that reconstructs the batch from Solana accounts. Retain data accounts in the prototype; no pruning yet.

**Checkpoint:** missing, reordered, duplicate, modified, or unsealed chunks prevent acceptance. A fresh observer can reconstruct state without the operator database.

## 16. Implement atomic batch acceptance and withdrawals

Acceptance requires the registered operator signer AND a valid proof. Validate parent root, batch sequence, verifier version, canonical inbox prefix/cursors, complete data commitment, withdrawal commitment, and chain-clock validity interval. Advance state atomically. A stale competing batch must fail after another batch advances the root.

Implement withdrawal-ticket inclusion against accepted commitments. Require exact ticket recipient/amount and a persistent claim ID that does not depend on which batch root is supplied. Mark claimed and transfer atomically; preserve storage funding correctly. Retain sufficient accepted commitments for old unpaid tickets to remain claimable.

Test wrong operator, wrong domain, old parent, wrong deposit prefix, wrong data, expired interval, changed recipient, duplicate withdrawal, and account substitution. Even the operator must fail to withdraw without a proven ticket.

**Checkpoint:** deposit -> proven accounting -> ticket -> actual SOL transfer works, and invalid attempts never release funds.

## 17. Build the centralized operator service

Use a single durable ordering service, shared transactional storage, and prover workers. No validator committee is needed. Define a batch lifecycle: `collecting -> sealed -> proving -> published -> submitted -> finalized`, with retry/failure states tracked separately.

Atomically reserve nonces and budget before returning provisional acceptance. Persist ordered operations, batch parents, proof artifacts, publication progress, transaction signatures, and an outbox. On restart, reconcile with Solana before assigning a new parent or resubmitting. Never treat provisional balances as finalized.

Persist blockhash lifetimes. Resubmit unchanged transactions while valid; reconcile before rebuilding. Configure fee caps, prover/storage exposure limits, maximum batch size, and maximum wait from measured results. Stop admission when proving or settlement is unhealthy.

**Checkpoint:** kill/restart the operator and prover during each lifecycle state; neither duplicate credits nor incompatible finalized history appear.

## 18. Integrate paid and free provider calls

Update discovery to retain optional per-function `paymentManifest`. Use operator-approved endpoint/resource/recipient mappings initially. Add a structured invocation endpoint and caller-side invoker instead of forwarding generated scripts for paid functions.

- No manifest: direct execution; no escrow, voucher, reservation, receipt, operator, or proof required.
- Manifest present: verify signed invocation, current accepted price, and chosen reservation assurance before work. Missing authorization is rejected before execution.
- Mixed script: charge only paid invocations and retain one overall caller budget.

Persist provider invocation state under `(deployment, payer, requestId, invocationId)`, with shared uniqueness constraints and fenced execution ownership. Return stored status/results on matching retries. Expose an explicit `indeterminate` state for uncertain external effects and reconcile rather than rerun blindly.

For private result recovery, authenticate a fresh payer-signed challenge binding provider, namespace, operation, nonce, and deadline; a public voucher or ID alone is not result-access authority. Guard every route that can execute a paid function, including older `/v1/run` routes.

**Checkpoint:** run an all-free script with the operator and Solana RPC offline. Run a mixed script and observe only the paid calls in accounting. Repeated paid calls with the same ID execute and charge once.

## 19. Make reservation latency and repricing explicit

Support two provider policies: provisional reservation acceptance with operator availability/history risk, or execution only after the reservation's batch finalizes on Solana. Show these as different assurance levels, not interchangeable statuses.

Reject stale prices before execution and return current pricing. Reuse the same logical invocation ID for a rejected repricing attempt; once accepted, freeze its voucher. Reprice only before a reservation is accepted or after a proven release under explicit rules. Do not create another invocation ID to bypass uncertain execution.

For the safe end-to-end demo, prove a reservation batch before execution, then prove the receipt batch afterward. Record that this introduces two settlement stages. Implement batch validity intervals and signed deadlines with room for measured execution, proving, publication, and landing latency.

**Checkpoint:** a provider waiting for a proven reservation cannot be promised the same allocated funds through another accepted history. Late proofs fail without silently extending signed deadlines.

## 20. Implement operator-independent recovery

This step is mandatory before real funds. Write the forced-inbox and escape state machine before coding its instructions. Specify progress/forced-operation timeouts, trigger conditions, snapshot cursors, nullifiers, and signer requirements.

Users can enqueue authenticated forced operations on Solana. Proofs must consume the required prefix; they cannot skip overdue operations. On defined failure timeout, anyone can freeze the last accepted state. Normal batches then stop.

Build exit proofs for three disjoint categories: frozen available/request funds, already proven unpaid withdrawal tickets, and deposits never consumed into L2. Reserved funds follow the signed settlement deadline before payer recovery. Exclude pending tickets from balance exits and enforce one-time claims across all exit paths. Copied exit proofs cannot redirect funds.

Publish recovery CLI commands only after implementation defines their real arguments. Test with the operator off and an independent observer reconstructing all evidence from Solana data. Include both directions of every race: normal claim then escape, escape then normal claim, final batch then freeze, freeze then final batch.

**Checkpoint:** operator outage cannot cause unauthorized refunds, double exits, or permanent dependence on the operator's private database. Unproven provider receipts retain the explicitly documented outage risk.

## 21. Run local end-to-end tests, then deploy to devnet

Create one reproducible scenario script that starts from a clean development deployment and covers deposit, allocation, proven reservation, paid execution, receipt, batch publication/proof acceptance, withdrawal, free calls, refunds, and operator shutdown recovery. Print public IDs, transaction signatures, and roots; never keys or private API results.

After local checks pass, create separate devnet-only identities. Configure the CLI and Anchor wallet deliberately. Typical CLI/build commands are:

```sh
solana config set --url devnet
solana airdrop 2 --url devnet
solana balance --url devnet
```

From the real Anchor workspace:

```sh
anchor build
anchor deploy --provider.cluster devnet
```

The faucet may be rate-limited and deployment/storage may require more test SOL; confirm balances before retrying. Record program ID, operator key, domain/genesis hash, verifier key hash, tool versions, and RPC endpoint. Use a new rollup domain when moving networks. Current deployment/configuration commands are documented in the [Anchor CLI](https://www.anchor-lang.com/docs/references/cli).

**Checkpoint:** an independent machine reproduces the complete demo against devnet using only documented configuration and public state.

## 22. Measure, review, and decide on mainnet

Measure each layer separately: HTTP execution, provisional acceptance, reservation proof acceptance, receipt proof acceptance, Solana finality, and withdrawal. Compare one call, mixed resources, low traffic, larger batches, and operator outages.

Report proof generation/memory, upload/storage capital, verification fees, failed-attempt costs, permanent replay state, withdrawal costs, and recovery costs. Do not label a system cheaper because it moved expense from transaction fees to prover hardware or retained account storage.

Freeze protocol vectors and obtain independent program AND circuit reviews, including data availability and escape accounting. For Groth16, production setup/ceremony and versioned verifier keys are separate from tutorial artifacts. Document centralized publisher rotation and immutable versus delayed-upgrade governance before users fund escrow.

**Checkpoint:** mainnet is an explicit release decision backed by measured economics, resolved security findings, reproducible builds, and exercised exits. Finishing the devnet demo does not automatically satisfy this step.

## Troubleshooting while you build

| Symptom                                      | First thing to inspect                                                                                     |
| -------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| Command not found                            | Fresh terminal PATH and recorded toolchain versions.                                                       |
| RPC connection refused                       | Local server running, correct port, correct CLI/Anchor endpoint.                                           |
| Tests cannot reach validator                 | Whether your template uses in-process tests or starts a background validator.                              |
| Program ID mismatch                          | Generated deployment key, `declare_id!`, Anchor cluster config, and IDL.                                   |
| Account constraint failure                   | Actual address, owner, signer flag, seed bytes, and canonical bump.                                        |
| Insufficient lamports                        | Fee payer balance, account storage funding, and payment principal separately.                              |
| Proof verifies off-chain but fails on Solana | Public-input order, curve encoding, limb bounds, verifying key, and syscall behavior.                      |
| Changed input still proves                   | Circuit constraints; computing a witness is not sufficient.                                                |
| Funds appear stuck                           | Finalized state, pending withdrawal tickets, deadlines, operator progress, then the defined recovery path. |

For each checkpoint, keep a small commit and a note with the command/scenario you ran and its output. Begin with Step 1; your first target is a working local counter, not the complete rollup.
