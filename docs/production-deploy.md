# Deploying the escrow program and operator to production

This guide deploys the escrow program to Solana mainnet and runs the operator
against it. It uses [Alchemy](https://www.alchemy.com/) for Solana RPC and a
software keypair (not a hardware wallet) as the program's upgrade authority.

Do the whole procedure on devnet first (step 4). A mistake on mainnet costs real
USDC and is hard to undo. For a local run, see [local-e2e.md](local-e2e.md).

## 1. What each key controls

| Key | Where it lives | What it can do |
| --- | --- | --- |
| **Upgrade authority** | Offline, encrypted, backed up. Never on a server. | Replaces the program's code. It can therefore drain every escrow, so it is the most sensitive key. |
| **Operator authority** (`ESCROW_AUTHORITY` / `PRIVATE_KEY`) | The operator's secret store (hot). | Signs every withdrawal and pays its fees. Users sign and pay for their own escrow setup. |
| **Program keypair** | Only needed for the first deploy. | Sets the program ID (`ESCROW_PROGRAM_ID`). |
| **Protocol fee wallet** | Wherever you keep treasury funds. | Receives 20% of each withdrawal. Never signs. |

The upgrade authority must be a keypair you hold. If you set it to an address
nobody has the secret for, the program can never be upgraded again. The program
README suggests using the operator wallet as the upgrade authority. That isn't
required, and a separate key is safer: a compromised operator server then can't
replace the program.

The escrow PDA seeds include `ESCROW_AUTHORITY`, and every withdrawal checks the
authority stored in the escrow. Rotating the operator key later means a program
upgrade and orphans existing escrows, so treat that key as long-lived.

## 2. Generate keys

Do this on an offline machine if you can.

```sh
umask 077
mkdir -p ~/stellarium-prod-keys && cd ~/stellarium-prod-keys
# Upgrade authority: set a BIP39 passphrase and write down the seed phrase.
solana-keygen new --outfile upgrade-authority.json
solana-keygen new --outfile operator.json
solana-keygen new --outfile program.json
solana-keygen new --outfile protocol-fee.json   # or use an existing treasury wallet's address

for k in upgrade-authority operator program protocol-fee; do echo "$k: $(solana-keygen pubkey $k.json)"; done
```

Back up `upgrade-authority.json` and its seed phrase, encrypted, in two places.
`program.json` isn't secret after the deploy, but keep it until the first deploy
succeeds.

## 3. Set up Alchemy

In the Alchemy dashboard, create these apps on the Solana chain:

- **`stellarium-operator`** (mainnet): the operator's `SOLANA_RPC_URL`. In the
  app's security settings, add an IP allowlist with the operator's outbound IP.
- **`stellarium-deploy`** (mainnet), plus a devnet app for the dry run: used from
  your deploy machine for CLI work. Keeping it separate means the operator's key
  stays locked to the server's IP.

Endpoints look like this:

```
https://solana-mainnet.g.alchemy.com/v2/<API_KEY>
https://solana-devnet.g.alchemy.com/v2/<API_KEY>
```

**The API key is part of the URL, so treat the whole URL as a secret.** Load it
without leaving it in shell history, and don't save it in global CLI config on a
shared machine:

```sh
read -rs "RPC?Alchemy URL: "; export RPC   # zsh; in bash: read -rsp 'Alchemy URL: ' RPC; export RPC
solana cluster-version --url "$RPC"        # sanity check
```

The operator needs nothing Alchemy-specific beyond the URL. Every RPC method it
uses is standard and available on Alchemy, including the transaction-history
lookup (`getSignatureStatuses` with `searchTransactionHistory`) used during
reconciliation.

`@solana/web3.js` builds its websocket URL from the HTTP one
(`wss://solana-mainnet.g.alchemy.com/v2/<API_KEY>`) and uses it to confirm
transactions. Allow outbound `wss` from the operator host. Without websockets
nothing breaks outright, but confirmations get slow: each waits about a minute for
its blockhash to expire, comes back `unconfirmed`, and is resolved later by the
reconciliation pass. Step 10 checks for this.

## 4. Configure and build the program

In `programs/escrow_program/src/lib.rs`, set the three constants. Only public keys
belong here.

```rust
pub const ESCROW_AUTHORITY: Option<Pubkey> =
    Some(solana_program::pubkey!("<operator address>"));
pub const USDC_MINT: Option<Pubkey> =
    Some(solana_program::pubkey!("EPjFWdd5AufqSSqeM2qZzJpgyyhwJaZgw7tFFtbs2Mn")); // mainnet USDC
pub const PROTOCOL_FEE_RECIPIENT: Option<Pubkey> =
    Some(solana_program::pubkey!("<protocol fee address>"));
```

Test and build with a current Solana toolchain. The program README notes that the
3.1.10 builder produced syscall warnings and that runtime execution wasn't
verified with it.

```sh
agave-install update   # or solana-install update, depending on your installation
NO_DNA=1 cargo test --manifest-path programs/escrow_program/Cargo.toml --locked
NO_DNA=1 cargo build-sbf --manifest-path programs/escrow_program/Cargo.toml \
  --sbf-out-dir programs/escrow_program/target/deploy
```

Optional: build with `solana-verify build` instead, so the on-chain binary can be
verified against the source.

## 5. Dry run on devnet

Build a second binary with devnet USDC
(`4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU`) as `USDC_MINT`. Then run steps 6–10
with your devnet Alchemy URL, and point a devnet operator's `SOLANA_RPC_URL` at the
same devnet app. You can use a separate devnet program keypair or reuse
`program.json`: the program has no `declare_id!`, so either works.

Alchemy doesn't airdrop. Use the public faucet:

```sh
solana airdrop 2 <upgrade-authority address> --url devnet
```

Remember to rebuild with the mainnet mint before step 6 on mainnet.

## 6. Deploy to mainnet

```sh
read -rs "RPC?Alchemy mainnet URL (deploy app): "; export RPC
SO=programs/escrow_program/target/deploy/escrow_program.so

# The deployer pays rent for the program, and briefly for a buffer of the same size.
solana rent --url "$RPC" $(wc -c < $SO)
solana balance --url "$RPC" <upgrade-authority address>   # fund with ~2x the rent plus margin

solana program deploy --url "$RPC" \
  --keypair ~/stellarium-prod-keys/upgrade-authority.json \
  --upgrade-authority ~/stellarium-prod-keys/upgrade-authority.json \
  --program-id ~/stellarium-prod-keys/program.json \
  --with-compute-unit-price 50000 --max-sign-attempts 50 --use-rpc \
  $SO

solana program show --url "$RPC" <program address>
```

Check that `Authority` equals the upgrade-authority address. **Never pass
`--final`**, which makes the program permanently immutable.

- The first deploy must be signed by the upgrade authority. Run it on the secure
  machine, then return the key to cold storage.
- The binary is about 93 KB, so the deploy sends roughly 100 write transactions
  through Alchemy. If you see `429 Too Many Requests`, rerun the same command: it
  resumes from the existing buffer. A paid Alchemy plan avoids this.
- If transactions keep getting dropped, try once without `--use-rpc`. The CLI then
  sends directly to block leaders and uses Alchemy only for reads.
- After a failed deploy, reclaim the buffer's rent:
  ```sh
  solana program show --buffers --url "$RPC" --keypair ~/stellarium-prod-keys/upgrade-authority.json
  solana program close --buffers --url "$RPC" --keypair ~/stellarium-prod-keys/upgrade-authority.json
  ```
- To upgrade later, run the same deploy command with `--program-id <program address>`.
  If the new binary is larger, run `solana program extend` first.

## 7. Fund the operator wallet

The operator wallet pays every withdrawal's transaction fee and the protocol fee
wallet's USDC account once. It pays nothing for escrows: each user pays its own
escrow's rent (about 0.0035 SOL for the state and token account) and setup fee.
Start with 1–2 SOL and alert on its balance.

```sh
solana transfer --url "$RPC" \
  --keypair ~/stellarium-prod-keys/upgrade-authority.json \
  <operator address> 2 --allow-unfunded-recipient
```

Any funded wallet can send this. The upgrade authority is shown only because it is
already funded.

## 8. Database

Use a managed PostgreSQL 16 (RDS, Neon, Supabase and so on) with a dedicated user
and **backups turned on**. The `receipts` table records what payers owe providers.
The operator applies the migrations in `apps/operator/drizzle/` itself at startup.

## 9. Run the operator

Build the image from the repository root:

```sh
docker build --target operator -t stellarium-operator .
```

Configure it through environment variables. Keep `PRIVATE_KEY` and `SOLANA_RPC_URL`
in a secrets manager, not in a plain env file or compose
YAML.

| Variable | Value |
| --- | --- |
| `DATABASE_URL` | Managed PostgreSQL URL (add `?sslmode=require` if your provider needs it). |
| `ESCROW_PROGRAM_ID` | Program address. |
| `USDC_MINT` | `EPjFWdd5AufqSSqeM2qZzJpgyyhwJaZgw7tFFtbs2Mn`. Must equal the compiled value. |
| `PROTOCOL_FEE_RECIPIENT` | Protocol fee address. Must equal the compiled value. |
| `PRIVATE_KEY` | Contents of `operator.json` (the JSON byte array). |
| `SOLANA_RPC_URL` | `https://solana-mainnet.g.alchemy.com/v2/<API_KEY>` from the **operator** app. |
| `SOL_PRICE_USDC` | Current SOL price in USDC, for example `150`. |
| `SETTLE_INTERVAL_MS` | Optional. Defaults to 30000. |

```sh
docker run -d --name operator --restart unless-stopped -p 127.0.0.1:3001:3001 \
  --env-file /secure/operator.env stellarium-operator
```

The operator serves plain HTTP on port 3001. Put it behind a TLS reverse proxy
(Caddy, nginx, or a cloud load balancer). If the host's outbound IP isn't fixed (as
on some container platforms), route egress through a static IP, or the Alchemy
allowlist will block it.

Before going live:

- **Rate limiting behind a proxy.** `apps/operator/src/server.ts` creates Fastify
  without `trustProxy`, so behind a proxy every request appears to come from the
  proxy. The per-IP limit (100 per minute by default) becomes a global one. Enable
  `trustProxy` or raise `RATE_LIMIT_MAX`.
- **`SOL_PRICE_USDC` is read once at startup.** Update it and restart when SOL moves
  a lot. A stale low price makes settlement fire too early. At $150, a
  (payer, recipient) group is settled once it totals about 0.0375 USDC.
- **Startup log.** The operator logs `Loaded authority account: …`. Check that it
  matches the compiled `ESCROW_AUTHORITY`.

## 10. Smoke test on mainnet

Use small amounts.

1. Liveness: `curl https://<operator host>/v1/` returns `{"hello":"world"}`.
2. Work out a node's escrow user address: the raw Ed25519 key inside its
   `SIGNING_PUBLIC_KEY`, converted to base58 (as `USER_ADDRESS` is derived in
   [local-e2e.md](local-e2e.md) section 4).
3. Send about 0.005 SOL to that address. It pays the escrow's rent and setup fee.
   Then create its escrow: `POST /v1/escrow` returns an unsigned transaction and an
   `escrowTokenAddress`. Sign the transaction with the node's key and submit it, as
   in [local-e2e.md](local-e2e.md) section 6. A 422 means the address holds too
   little SOL.
4. Send a small amount of USDC (for example 0.10) to `escrowTokenAddress`.
5. Make sure the provider's `recipientAddress` already has a USDC associated token
   account. Without one, the operator answers vouchers with 422.
6. Make paid calls. Provider nodes use `OPERATOR_URL=https://<operator host>/v1`.
   Watch the logs for `Settled accrued receipts`, and check the settlement
   transaction on an explorer for the 80/20 split.
7. In the Alchemy dashboard, the operator app should show steady traffic (several
   calls every settlement interval) and no 403s, which would mean the allowlist is
   blocking the server.

## 11. Ongoing operations

- Alert on the operator's SOL balance, on `Failed to settle accrued receipts`
  warnings, and on settlements stuck in `unconfirmed`.
- Keep the upgrade authority offline. Bring it out only for upgrades.
- For more protection later without a hardware wallet, move the upgrade authority
  to a multisig (for example Squads) with `solana program set-upgrade-authority`.
