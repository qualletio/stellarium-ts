# Money

> **Status: built, with the gaps listed under [As built](#as-built).** RequestScript 1.8.1 has pinned versions, `payable`, call options, `payment`, `now`, `fail` and the conformance suite. Contracts move money end to end and read `sender` and the operator's `now`; the operator replays every contract run in a tree that moved money, holds payouts until it has, handles fraud and mismatches, and has a staff API with two-person approval, an audit log and signed checkpoints; the dashboard shows contracts, money logs, refund-all, held payouts, the audit log and bans with appeals.

Money lets RequestScript contracts hold and move real micro-USD, in the way Ethereum contracts hold ETH:

- Every contract version has a **balance**, kept by the operator, made of **funding** from the organizations that paid into it.
- A **`payable`** contract accepts money attached to a call, and reads it as `payment.amount`. Whoever attaches money names the organizations it may pay, its **payees**.
- Contract code spends its balance through **`sh.stellarium.money.Account`**, a resource built into every node ([stellarium-money](https://github.com/qualletio/stellarium-money) specifies it). It pays the payees and refunds the organizations that funded the contract. Contracts send money to other contracts by attaching it to a call.
- A payable contract's **state and money commit together**, when the run that started everything succeeds, as a reverted Ethereum transaction undoes both.
- The operator **replays** every run of a payable contract, so the node hosting a contract can't move its money by lying about what it did (see [Verified runs](#verified-runs)).

The money is still the same fiat money as the rest of Stellarium. An organization tops up its prepaid balance through Stripe, the operator keeps the ledger, and providers are paid out through Stripe Connect. Contracts only decide where money already in the system goes, among destinations its funder chose (see [Where money can go](#where-money-can-go)).

## Stripe's conditions

Stripe reviewed this design in November 2026. It fits Stripe Connect as **conditional payout orchestration**: software decides when marketplace revenue is paid out, and to which verified provider. These conditions keep it there:

- **Not escrow.** Stripe doesn't provide escrow services. Contract balances are entries in the operator's ledger, and the money itself stays in the platform's Stripe balance.
  - Never describe contracts as escrow, deposits or holding accounts in the product, the docs or marketing. Say *conditional payouts*, *payment on delivery* or *revenue splits*.
  - Contract authors agree to the same in the terms, which are the real control.
  - The operator also refuses payable contracts whose name contains `Escrow` or `Deposit`, as a reminder. That check is easy to get around.
- **Separate charges and transfers.** Top-ups are charges to the platform's balance, through Checkout. `pay` credits a provider's payable balance in the ledger, and `PayoutService` transfers it to the provider's Connect account after `PAYOUT_HOLD_DAYS` (default 7). A refund returns money to the payer's prepaid balance. Nothing in Money creates its own charges or transfers.
- **Resolve quickly, counted from the charge.** Stripe's risk checks look at the time from a charge to the transfer that pays it out. Holding funds for more than 14 to 30 days can make them pause the platform's payouts. So:
  - a payment into a contract spends only top-up credit charged within `MAX_FUNDING_SOURCE_AGE_DAYS` (default 7), taking the oldest credit first, as the dashboard's idle-balance warning assumes;
  - every payment into a contract has a [time limit](#time-limit): 14 days by default, and never more than 30.

  With the defaults, a transfer leaves at most 35 days after the charge that funded it: 7 in the prepaid balance, 14 in the contract, then `PAYOUT_HOLD_DAYS` and the payout interval. Most payments resolve much sooner. Lower `MAX_FUNDING_SOURCE_AGE_DAYS` or `MAX_CONTRACT_HOLD_DAYS` if Stripe asks. Money a contract refunds goes back to the prepaid balance with its original charge date, so it can't be used to fund a contract again once it's too old.
- **Verified recipients only.** `pay` reaches only organizations with `payoutsEnabled`. The operator sets it from Stripe's `account.updated` webhook, when the Connect account has `payouts_enabled` and an active `transfers` capability.
- **No transfers between users, crypto or lending.** `pay` reaches only the payees the funder named, so a contract can't forward money to whoever its caller picks (see [Payees](#payees) and [Not supported](#not-supported)).
- **Compliance is checked on substance, not names.** Prepaid balances that code routes to other organizations look like money transmission to regulators, whatever the product calls them. Before launch:
  - counsel reviews money-transmitter and e-money licensing in each market;
  - payers above `PAYER_KYC_THRESHOLD_MICRO_USD` a month complete identity checks, as payees already do through Connect;
  - payers and payees are screened against sanctions lists.

## Coming from Ethereum

| Ethereum | Stellarium |
|---|---|
| Contract address | A contract version on a node: `path.Name@version` and the node's public key |
| Immutable code at an address | Contracts call contract versions, `const job: com.example.Job@3`, never "the latest" |
| Proxy upgrades | Not supported. A new version is a new contract that callers choose to pin |
| `payable` function | `payable contract` |
| `msg.value` | `payment.amount` |
| `msg.sender` | `sender` (`{ org, node, contract }`), with `org` never `null` |
| `tx.origin` | `caller` (`{ org, node }`) |
| `address(this).balance` | `account.balance().value` |
| `recipient.transfer(x)` | `account.pay(to: org, amount: x, from: payer)`, only to the payer's named payees |
| Withdrawal pattern | `account.canReceive(...)` and `account.tryPay(...)`, so one recipient can't block the others |
| `other.f{value: x}(...)` | `other.run{amount: x, from: payer}(...)` |
| Refunding `msg.sender` | `account.refund(...)`, one step back to whoever sent the money (see [Funding](#funding)) |
| `revert` | A failed run: no state changes and no money move |
| Checked arithmetic (Solidity 0.8) | Checked `int64` arithmetic in the [deterministic profile](#deterministic-contracts) |
| A deterministic EVM | The [deterministic profile](#deterministic-contracts) for payable contracts |
| `block.timestamp` | [`now`](#time-and-randomness), stamped by the operator |
| VRF and commit-reveal randomness | [Two-step `Random`](#time-and-randomness) |
| Gas | Script tokens, charged separately from `payment.amount` |
| Externally owned account | Organization |
| ERC-20 tokens | Not supported |
| Validators re-executing every block | The operator replaying [verified runs](#verified-runs) |
| Block producers ordering transactions (MEV) | Host nodes ordering runs (see [What verification doesn't cover](#what-verification-doesnt-cover)) |
| `Transfer` logs and block explorers | The operator's [money log](#money-log) |
| Slashing | Refunds from the organization that committed [fraud](#fraud), and a ban |

Unlike ETH, a contract's money isn't one pool: every amount belongs to the organization that funded it, optionally under a key the contract chooses, and carries the payees its funder named. Every outflow names whose funding it spends (see [Funding](#funding)).

## Payable contracts

`payable` goes before `contract`, as `restricted` goes before `event`:

```
payable contract com.example.Tip(note: string): int64 {
    return payment.amount
}
```

- **`payment`** is a built-in object, like `caller`, and is never `null`:
  - `payment.amount`: the amount attached to this call, an `int64`. It is `0` when nothing was attached.
  - `payment.from`: the organization whose funding the amount carries, or `null` when nothing was attached. A request script's money comes from its run's organization. A contract's money comes from the funder it names (see [Sending money](#sending-money)).
  - `payment.payees`: the organizations the amount may be paid to, a `[]string`, empty when nothing was attached.
- **`payment.from` isn't `sender`.** On Ethereum, `msg.value` always comes from `msg.sender`. Here, a marketplace contract can attach a buyer's money, so `payment.from` is the buyer and `sender` is the marketplace. Authorize on `sender`, and attribute money with `payment.from`.
- **Refusals:** a call that attaches money to a contract that isn't `payable` is refused before the contract runs. A non-payable contract still reads `payment.amount`, which is always `0`.
- **Event contracts** can't be `payable`, because nobody calls them. A deploy of `payable contract X consumes ...` is refused.
- **Versions:** a contract keeps the same payability across versions, as it keeps its kind.
- **Pinned dependencies.** Every contract binds the contracts it calls by version, so the code it depends on can't change after it's deployed (`const job: com.example.Job@3`). Nodes refuse to deploy a contract that binds another contract by name alone. Host resources, such as `sh.stellarium.stdlib.Uuid`, have no versions.
- **Deterministic.** A payable contract must follow the [deterministic profile](#deterministic-contracts). Nodes refuse to deploy one that doesn't.
- **Registered at deploy.** The node registers each payable contract version with the operator before it can receive money (see [Registration](#registration)), so buyers can read its source and dependencies before they fund it.
- **Public source.** The operator publishes a payable contract's source, so it must never contain secrets. Nodes warn about this when a payable contract is deployed.

## Who is calling

A contract reads two built-ins about who called it. Money decisions use **`sender`**.

| Built-in | Meaning | Like |
|---|---|---|
| `caller` | Who the whole run is for. It is the same in every contract the run reaches, however deep. | `tx.origin` |
| `sender` | Who made this call: the script or contract one level up. | `msg.sender` |

`sender` is `{ org, node, contract }`:

- **`contract`:** the calling contract's `path.Name@version`, or `null` when a request script made the call.
- **`node`:** the node the call came from.
- **`org`:** who answers for the call, never `null`:
  - when a request script made it, the run's organization, as in `caller.org`;
  - when a contract made it, that contract's **registered owner** (see below).
- **Contracts without an owner can't call payable contracts.** A contract deployed before owners were registered has none. Its calls to payable contracts are refused, so `sender.org == judge` can never match a `null` that a contract stored by mistake. On Ethereum, the same class of bug let `ecrecover`'s zero address pass checks.
- **Event contracts:** an event contract's own `sender` is the same as its `caller`, the event's owner and publisher. Contracts it calls see the event contract as their `sender`.

**Contract owners are registered with the operator.** When a contract version is deployed, its node registers it with the operator (see [Registration](#registration)), with its owner: the organization whose API client deployed it, proven by that client's run token, or the node's own organization for a deploy with the node's API key. For a call from another node, the operator looks up the calling contract's owner when it authorizes the contract run (`authorizeContract`, which already returns the payer). It returns the owner with the authorization, and the callee uses that as `sender.org`. A node therefore can't claim its tenants' contracts as its own, or the reverse: a tenant's contract on node N calls other nodes as its owner, never as N.

**The calling contract is public.** Like `msg.sender` on Ethereum, the calling contract is visible to every contract and resource a contract calls, through `sender` and [caller attestations](#knowing-the-caller). Nothing more about the run is revealed to them.

**Why not `caller`:** `caller` passes unchanged through every contract a run calls (`ScriptContext.caller`). A contract that authorizes on `caller.org` trusts every contract in between. A provider could deploy a harmless-looking contract, get a buyer to call it, and have it call `release` on the buyer's job. The same applies to event contracts, which anyone can deploy and which run with the event owner as `caller`. Authorize money on `sender`, never on `caller`.

**Running a script on a node lets that node act for you.** The node signs vouchers and attestations for your run, and contracts on other nodes see your organization as `sender.org` for the calls your script makes. Run scripts that move money only on nodes you trust.

## Amounts

Amounts are `int64` micro-USD (1 USD = 1,000,000), at most `Number.MAX_SAFE_INTEGER`, the largest amount the operator stores exactly.

- `pay` and `refund` take amounts greater than 0.
- An attached amount is 0 or more, and 0 means nothing is attached.
- **Checked arithmetic.** In a payable contract, `int64` arithmetic that overflows fails the run, and `/` on integers truncates toward zero (see [Deterministic contracts](#deterministic-contracts)). An amount can't wrap around into a small or negative number.
- **Fees round up.** The platform fee on a `pay` is `ceil(amount × PLATFORM_FEE_BPS / 10,000)`, so splitting a payment into tiny ones can't avoid it.
- The interpreter, the calling node, the provider node and the operator each check these rules on their own. Any of them refuses a negative, fractional or oversized amount, so a bug in one layer can't turn a payment into a withdrawal.

## Sending money

Money is attached to a call as call options, in braces between `run` and its arguments:

```
request Hire {
    const job: com.example.Job@1
    return job.run{amount: 20000000, payees: ["org_courier"]}(action: "fund", jobId: "", provider: "org_courier", arbiter: "org_arbiter").value
}
```

- **`amount`:** the micro-USD to attach.
- **`payees`:** the organizations the money may be paid to (see [Payees](#payees)).
- **`from` and `key`:** in a contract, whose funding to spend (see below).
- **A pinned version.** A call that attaches money must bind its contract by version, in a request script too. The buyer funds the code it read, not whatever the contract's owner deploys next.

Where the money comes from depends on who makes the call:

- **A request script run with a run token:** from the run's hold, on the API client's organization.
  - An API client has a `maxRunValueMicroUsd`, separate from `maxRunCostMicroUsd`, which **defaults to 0**: an existing client can't send money until an admin raises the limit.
  - Money a client attaches counts toward its `monthlyCapMicroUsd` along with its run costs, so a stolen token can't send the per-run limit again and again.
- **A request script run with the node's API key:** from the node's organization, up to the node's `maxApiKeyRunValueMicroUsd` per run and `monthlyApiKeyValueCapMicroUsd` per month. An admin sets both on the operator, and **both default to 0**.
- **A contract:** from its own balance. A contract names whose funding it spends, and optionally its key: `other.run{amount: x, from: payer, key: k}(...)`. `from` is required in contracts. The receiving contract sees `payment.from`, and the funding moves with the money.
- **A contract on another node:** the caller's `ContractPaymentVoucher` carries the amount and its payees (see [Vouchers](#vouchers)). The provider node asks the operator to hold the amount along with the run.

A request script's money is new funding, so it spends only top-up credit younger than `MAX_FUNDING_SOURCE_AGE_DAYS` (see [Stripe's conditions](#stripes-conditions)).

The script tokens a call executes are paid for as they are today, out of the caller's run or voucher `maxAmount`. They are never taken out of `payment.amount`.

Attaching money is part of the language and of stellarium-ts: it works on every node, and the money moves when the run settles (see [Settlement](#settlement)).

### Payees

Whoever attaches money decides who it can be paid to. This keeps contracts to conditional payouts between parties the buyer chose, and stops a contract from forwarding money to anyone its caller names.

- **A request script must name payees** when it attaches money: 1 to `MAX_PAYEES` (16) organizations.
- **A contract passing money on** names payees too, and they must be a subset of the funding's own. Without `payees`, the money keeps the funding's payees. A marketplace can narrow a buyer's payees to one job's provider, but can never add one.
- **`pay` reaches only the payees** of the funding it spends. Paying anyone else fails the run.
- **Refunds ignore payees.** Money can always go back to its funder.
- **Payees are signed.** A remote call's voucher carries them (see [Vouchers](#vouchers)), and the operator stores them with the funding.

The dashboard shows a buyer the payees, and the contract's source and dependencies, before it funds a contract.

## Spending money

Contracts spend their balance through `sh.stellarium.money.Account`. stellarium-ts serves it on every node as a built-in resource, and stages its changes directly on the operator. Nodes never learn it from peers.

```
const account: sh.stellarium.money.Account
```

| Function | What it does |
|---|---|
| `account.balance(): int64` | Returns this contract's balance, including what this run has received and spent so far. |
| `account.earmark(key: string)` | Labels the money attached to this call with `key`, so it can be spent separately from the same funder's other money. Call it at most once per call, and only when `payment.amount` is more than 0. |
| `account.fundingOf(org: string, key: string): int64` | Returns how much of the balance is `org`'s unspent funding under `key`, including this run's changes. A `null` key means funding that was never earmarked. |
| `account.canReceive(org: string): boolean` | Whether `org` can be paid now: it has `payoutsEnabled` and isn't frozen or banned. |
| `account.pay(to: string, amount: int64, from: string, key: string): int64` | Pays a payee out of `from`'s funding under `key`. The amount, less the platform fee, goes to its payable balance and is paid out through Stripe Connect. Returns that funding after the payment. |
| `account.tryPay(to: string, amount: int64, from: string, key: string): boolean` | Like `pay`, but when `to` can't receive payouts it pays nothing and returns `false`, so the run carries on. |
| `account.refund(to: string, amount: int64, key: string): int64` | Returns `to`'s funding under `key`, with no fee, one step back to whoever sent it: `to`'s prepaid balance if a script sent it, or the sending contract's balance if a contract did (see [Funding](#funding)). Returns that funding after the refund. |

`key` defaults to `null` wherever it's optional. Like every resource call, each function evaluates to `{ value, error }`, so read results with `.value`.

- **Free to call.** The functions have no payment manifest. The operator takes the platform fee from `pay` itself.
- **Only the calling contract's balance.** A node serves `Account` only to contracts it runs, for the contract that made the call. A request script's calls fail: it has no balance.
- **A failed call fails the run.** A script can't carry on after a refused `pay` by ignoring its `error`: if any `Account` call returns an error, the run fails when it ends, its state changes are dropped and no money moves. Calls fail when they would:
  - spend more than the named funding;
  - pay an organization that isn't one of the funding's payees;
  - pay an organization that can't receive payouts, except through `tryPay`;
  - use an amount that breaks the [amount rules](#amounts).
- **One recipient can't block the others.** A payee can lose `payoutsEnabled` at any time. A contract that pays several organizations in one run should use `tryPay` and keep what it couldn't pay for later, as Ethereum contracts let recipients withdraw instead of pushing payments to them. A contract can also check `canReceive` before accepting money for a payee.
- **Nothing moves while the contract runs.** The functions stage changes on the run, and the changes apply only when the whole run succeeds (see [Settlement](#settlement)). A payment can't run the recipient's code part-way through yours, because `pay` reaches only organizations. Calling another contract with money attached does run its code, but every change in the run's tree is checked against the same funding and commits or drops together, so a re-entering call can't spend money twice (see [Reentrancy](#reentrancy)).

To move money to another contract, call it with `{amount: ..., from: ...}`.

### How a node serves Account

`Account` is part of stellarium-ts, not a separate node, so there's no extra hop, no single point of failure besides the operator, and no peer that could answer with made-up balances.

1. **Staging.** For `earmark`, `pay`, `tryPay` and `refund`, the host node sends the change to the operator (`POST /v1/money/stage`), signed like every node request, with the contract's run id, the contract version, the call's `callIndex` and the function and parameters. The operator accepts it only from the node registered as the contract version's host, and stages it at most once per run and `callIndex`.
2. **Reads.** `balance`, `fundingOf` and `canReceive` are answered by the operator, which signs each answer over `{ runId, callIndex, function, parameters, response, signedAt }` with its signing key. The transcript records the signed answer, so replay can check it.
3. **Trust.** The host could stage a change its contract never asked for. Replay catches that: the staged changes must match what the replayed run asks for, and a change with no matching call is [fraud](#fraud). This is the same trust as before. With a separate money node, the host signed the caller attestations that the money node acted on.

## Knowing the caller

A resource function's `exec` receives only its parameters, and a call from another node doesn't say which contract made it. `sender` and verified runs need both, so stellarium-ts gains **caller attestations**:

1. **When they're attached:**
   - to calls to functions that declare `callerAttestation: true`, a declaration announced with the resource;
   - to every call to a contract on another node;
   - to every call made from a [verified run](#verified-runs), so each response can be tied to its place in the run.

   Other functions never learn which contract called them.
2. **Signing.** The calling node's invoker attaches a `CallerAttestation`, signed by the node's key over `callerAttestationPayload`, in this order:
   - `publicKey`: the calling node;
   - `contract`: the calling contract's `{ path, name, version }` (`ScriptContext` gains the running contract's version);
   - `runTag`: `hash(runId, providerPublicKey)`, where `runId` is the calling contract's run on the operator (see [Settlement](#settlement)). Each provider sees a different tag for the same run, so providers can't match their logs to reconstruct a run. The operator recomputes the tag to check signatures;
   - `callIndex`: the call's position in the run, counting from 0;
   - `invocationHash`: the same hash a voucher carries, which binds the attestation to this function, these parameters and, for a contract, the pinned version;
   - `attestationId`, `expiresAt`.

   A request script's calls carry no attestation unless they're part of a verified run. Retries reuse the attestation, as they reuse the voucher.
3. **Verifying.** The provider checks the signature, the expiry and the invocation hash against the incoming call. It then calls `exec(parameters, { caller })`. The second argument is new, so existing resources don't change.

## Where money can go

The balance of a contract, and money attached to a call, can only go to:

1. **A payee's payable balance**, through `pay` or `tryPay`. The payee must be one the funder named, and have `payoutsEnabled`, so it has completed Stripe Connect onboarding.
2. **Back to whoever sent the money**, through `refund`, up to the funder's unspent funding: the funder's prepaid balance, or the balance of the contract that sent it.
3. **Another contract's balance**, through a call with `{amount: ..., from: ...}`, keeping the funding's payees or fewer.

Nothing in Money pays a public key, pays an organization's prepaid balance it didn't fund, pays an organization its funder didn't name, or pays out to anyone outside Stripe Connect. Contracts are for conditional payouts such as payment on delivery, milestones and revenue splits that resolve within the [time limit](#time-limit). They are not general transfers between users.

## Contract accounts

The operator keeps one account per contract version, keyed by the node's public key, the contract's `path.Name` and its version.

- **Hosting:** a node can hold contract money only up to its `maxContractBalanceMicroUsd`, the total balance of all the contracts it hosts. The operator sets it per node, and **it defaults to 0** for every node. Stellarium raises it for its own nodes, and for other organizations' nodes after reviewing them. The cap bounds how much a fraudulent host could take before replay catches it (see [Fraud](#fraud)). Calls that would take a node past its cap are refused.
- **No one funder fills a node.** One organization's funding may use at most `MAX_FUNDER_SHARE_OF_NODE_CAP` (25%) of a node's cap. Otherwise an attacker could fund a node's contracts up to its cap, block everyone else's payments for the time limit, and get every cent back.
- **Versions:** money belongs to the version that received it. Deploying a new version is always allowed. A version that still has a balance stays callable under its full name, `com.example.Job@3`, until it's empty, and so does a deleted contract. Calls that attach money, and calls from contracts, always name their version, so an old version can't take a new version's money, and a new version can't take an old one's. The [time limit](#time-limit) empties every version within 30 days. There's no way to move a version's money to a new version: funders fund the new one themselves, after reading its source.
- **Refund all.** A contract's registered owner can refund all of a version's remaining funding to its funders at any time, from the dashboard or the operator's API. The version then refuses incoming money. This is the emergency stop for a version found to have a bug, since an old version stays callable until it's empty. It's safe to give to owners because money only goes back to its funders.
- **One node:** only the node that hosts a contract can stage changes on its account. A contract's balance stays with that node.

### Registration

When a payable contract version is deployed, its node registers it with the operator before it can receive money, as Ethereum puts a contract's code on chain before anyone can send it value. The registration holds:

- the source and its hash;
- the registered owner;
- the RequestScript version the contract runs on, which replay uses (see [Replay](#replay));
- its **dependencies**: every contract version it binds, with the node hosting each, and, transitively, theirs.

Registering a payable contract makes every contract version it depends on [verified from then on](#which-runs-are-verified).

**Visibility.** Buyers read about a contract from the operator, never from its host, which could lie. The operator serves (`GET /v1/contracts/{node}/{path.Name}@{version}`):

- the registration: source, owner, RequestScript version and dependencies;
- the balance;
- the host node's organization;
- flags, such as calling the host's own resources, or depending on a contract whose state was unverified before (see [What verification doesn't cover](#what-verification-doesnt-cover)).

Funding by organization is shown to the contract's owner, and each funder sees its own. The dashboard shows all of this to buyers before they fund a contract.

### Funding

The operator tracks where each contract's money came from: how much each organization put in, under which key, with which payees, through which contract, and how much of it is still unspent. A contract's balance is the sum of its funding, and every outflow spends one named organization's funding under one key:

- Money a contract receives is added to `payment.from`'s funding, with its payees and no key until the contract earmarks it. The funding record also notes the **path**: the contract that sent the money, if one did, and the key that contract spent it from.
- **Earmarking** keeps one funder's payments apart. A contract that holds several jobs for the same buyer earmarks each payment with its job id, and then each job can spend only its own money.
- `pay(from: payer, key: k)` and `other.run{amount: x, from: payer, key: k}` spend only `payer`'s funding under `k`. The receiving contract's funding is recorded under `payer` too, without a key. One payer's money can never pay for another's, and an earmarked payment can never pay for a different key.
- `refund(to: org, key: k)` spends only `org`'s funding under `k`.
- **Refunds go one step back,** as Ethereum refunds go to `msg.sender`. A buyer's script that funds a `Job` gets a cancelled job's money back in its prepaid balance. When a marketplace contract funded the `Job`, the money goes back into the marketplace's balance, under the same funder, key and payees the marketplace spent it from. The marketplace then decides what happens next, for example refunding the buyer itself.
  - **No code runs on the way back.** Like a forced send on Ethereum, the money reaches the marketplace's balance without running it, so refunds can't cause reentrancy. The marketplace sees the money through `fundingOf`.
  - **Safety nets skip the path.** The time limit, dispute recovery and the closing of contracts after [fraud](#fraud) return money straight to the original organization. They are the operator recovering money, not a contract refunding it, and they must work even when a contract in the middle is broken or its host is down.
- **Unverified funding is locked.** Funding that a tree [verified afterwards](#when-the-operator-verifies) created can't be spent until that tree is verified. Otherwise a second tree could pay out money that the first tree's reversal makes disappear, as a rollup's soft-confirmed state isn't final.
- **Disputes:** when a Stripe dispute or refund leaves an organization owing money, the operator can recover it from that organization's unspent funding in contracts before taking it from anywhere else. Like the time limit, this changes the funding behind a contract's back, so contracts should read `fundingOf` rather than trust their own records (see [Payment on delivery](#payment-on-delivery)).
- **Funding isn't final.** Card payments can be disputed for up to 120 days. A provider can't tell from `fundingOf` whether a buyer will dispute the card behind a job. The dashboard shows each payee how much of the funding it may be paid still comes from card charges inside their dispute window, so it can decide when to start work.
- **Deleted funders:** before an organization is deleted, the operator refunds its contract funding to its prepaid balance, so refunds always have somewhere to go.

### Time limit

Every payment into a contract has to be paid out or refunded within `MAX_CONTRACT_HOLD_DAYS`, which defaults to 14 and can't be set above 30. The operator refunds any funding older than that to the organization that sent it.

- **The clock starts once.** When a contract sends money on to another contract, the funding keeps its original time. Passing money between contracts never resets the clock.
- **Oldest first.** Within one payer's funding under one key, outflows spend the oldest payments first, so the money closest to its limit is spent first.
- **Locked funding waits.** Funding locked by a run that hasn't settled is refunded after that run settles.
- **Design for the limit.** A contract that waits for something, such as a delivery, should resolve well within it. If it doesn't, the payer gets the money back automatically. Longer arrangements, such as bonds or retainers, are out of scope: split them into milestones that each resolve in time.

From the time a payment enters a contract until the provider's transfer, money waits at most `MAX_CONTRACT_HOLD_DAYS`, plus `PAYOUT_HOLD_DAYS`, plus the payout interval (7 days by default).

### Money log

Ethereum's `Transfer` logs let anyone follow money. The operator keeps an append-only **money log** per contract version: every inflow, `pay`, refund, time-limit refund, dispute recovery, refund-all and fraud reversal, each naming the run or the operator action behind it.

- The public contract route shows the log's entries with amounts, without naming funders.
- The contract's owner sees every entry. Each funder and payee sees the entries that involve it.
- **Notifications.** The operator notifies an organization, by email and webhook, when a safety net moves its funding: a time-limit refund, a dispute recovery, a refund-all or a fraud reversal. Contracts aren't told, so the people behind them are.

## Settlement

A contract's state is saved on its node, and its money is kept by the operator. Money changes and a payable contract's state changes are staged, and both apply only when the run that started everything succeeds.

1. **Runs.**
   - **Root runs:** every run of a payable contract, and every script run that moves money, has a root run on the operator. Billed runs already have one. A free run (the node's API key, or the node's own organization) opens one with no hold the first time it runs a payable contract, attaches an amount, or signs a caller attestation. Runs of payable contracts that move no money still get one, so their state changes are recorded (see [State hash chains](#state-hash-chains)).
   - **Event runs get one id:** an event contract's run id is `hash(eventId, consumer)`, and the operator authorizes exactly one root run per event and consumer. The event is signed by its publisher, so a host can't start a second run for it to try for a different outcome.
   - **Child runs:** a contract called with its own run is a child run of its caller's run. That's either a billed local contract, or a contract on another node through its voucher's `runId`.
   - A free local contract stages on the nearest run above it.
2. **Staging money.** `Account`'s changes are staged on the contract's run (see [How a node serves Account](#how-a-node-serves-account)), and the calling node stages attached amounts on the caller's run.
   - The operator checks each change against the named funding and its payees, counting every change already staged in the root run's tree, and locks the funds it needs. If it refuses, the function fails, and so does the run.
   - `balance()` and `fundingOf()` read the funding with the tree's staged changes applied.
3. **Staging state.** A contract in a verified tree doesn't save its state when it finishes. Its node keeps the writes **pending**: it checks each row's `version` as today, and holds the contract's lock for the state scopes the run wrote (`state(id)`), so other calls can't change them. Calls that touch other scopes, such as another job, carry on.
4. **A contract run that succeeds** is captured with its [run receipt](#transcripts). Its tokens are charged, and its staged money and state changes **pass up** to its parent run instead of applying. A capture without a valid receipt is refused.
5. **A contract run that fails** has its tokens charged and its staged changes **dropped**, along with those its children passed up: its pending state too.
6. **The root run's capture** applies every money change in the tree in one transaction: balanced `ledger_entries`, funding records and platform fees.
   - The operator first [verifies](#verified-runs) the tree's runs, unless the tree is small enough to verify afterwards.
   - If the root fails, is released or expires, or fails verification, every change in the tree is dropped and the locked funds are unlocked.
   - A root run waiting for verification doesn't expire.
7. **State follows the root.** Each node with pending state in the tree asks the operator for the root's outcome (`POST /v1/runs/outcome`, signed like every node request), retrying until it's decided. When the root applied, the node saves the pending writes and releases their scopes' locks. When it dropped, the node discards them. State and money therefore succeed or fail together, as Ethereum's `revert` undoes both.
8. **Child receipts have a deadline.** A root run waits at most `CHILD_RECEIPT_DEADLINE_MS` for the receipts of child runs on other nodes. After that, a missing child's changes are dropped, so another node's host can't hold the caller's money changes hostage.
9. **Delivery.** Nodes keep every capture, release and pending state write in an outbox, written in the same database transaction as the run's result, and retry until the operator accepts it. A crash can't lose a receipt the hash chain needs.

Contracts outside verified trees save their state as each one finishes, as today.

These changes to the code before Money are made: contract runs and request scripts that fail are captured as failed; captures and releases go through a persisted outbox (`settlement_outbox`) that retries until the operator takes them, instead of being sent once; and a chain of contract calls that moves money keeps its state pending, holding its scopes, until the operator settles its money.

Staging, capture, release and the outcome check are idempotent per run and `callIndex`, because the operator has no nonce store.

**Throughput.** A payable contract's scopes stay locked until its root run settles, including verification before money moves. Calls to a busy scope wait `CONTRACT_LOCK_TIMEOUT_MS` and then fail. Contracts should keep state in narrow scopes, one per job or order, so unrelated calls don't wait for each other.

### Reentrancy

Ethereum's best-known contract bug, The DAO, came from reentrancy: a contract sent money before updating its records, and the recipient called back in to withdraw again. Stellarium contracts can call each other with money attached, and a call may re-enter a contract already in its chain (`ScriptContext.contracts`). That's still safe:

- **Money:** every change in a tree is checked against the same funding, counting what's already staged, so a re-entering call can't spend funding the outer call already spent.
- **State:** the inner call's pending writes hold the scopes it wrote. The outer call's writes to the same scope then fail their version check, so the outer run fails, and the whole tree drops.

The cost is that re-entering a contract and writing the same scope always fails the run. Contracts that call out with money attached should finish their own writes to that scope first, as Ethereum's checks-effects-interactions pattern advises.

## Deterministic contracts

Ethereum contracts can't make two validators disagree: the EVM has no floating point, no clock, no randomness and no undefined ordering. A formal spec and a shared test suite keep every client producing the same result. Stellarium needs the same guarantee for [replay](#verified-runs) to mean anything. A replay that disagrees should only ever mean the host lied or the runtime has a bug, never that a contract author found an edge case.

Ethereum gets there by allowing no outside calls at all. Stellarium contracts do make outside calls, so it separates the two the same way Ethereum separates running a contract from the data it reads:

- **Outside data enters only through resource calls,** which the transcript records and replay feeds back. A `Uuid` or `Datetime` response is recorded data, like a transaction's input, and doesn't make the run nondeterministic.
- **The interpreter itself is deterministic.** RequestScript 1.8.0's **deterministic profile** defines exact behavior for everything that could differ between environments:
  - object key order;
  - number formatting and parsing;
  - `int64` overflow, which fails the run, and integer division, which truncates toward zero;
  - `decimal` arithmetic;
  - string comparison and case mapping, without the host's locale or `Intl`;
  - date parsing and formatting.

  The interpreter never reads the clock or generates randomness itself, and nothing in the profile depends on the Node.js version that runs it.
- **Payable contracts must follow the profile.** Nodes refuse to deploy a payable contract that uses anything the profile leaves undefined.
- **One runtime per contract version.** A version runs on the RequestScript version recorded at [registration](#registration) for its whole life, as an Ethereum contract's bytecode keeps its meaning across clients.
- **A shared test suite.** Every `requestscript` release must pass a deterministic test suite, like Ethereum's consensus tests, before the operator adds it to its [supported versions](#replay).

## Time and randomness

A contract that reads the time or a random value has two questions to answer, as on Ethereum: who chose the value, and can anyone choose again until they get one they like? Replay isn't the problem, because recorded responses replay the same way every time.

**Time: `now`.** The operator stamps each root run's start time when it authorizes the run, and every contract in the run's tree reads it as the built-in `now`, like Ethereum's `block.timestamp`.
- It's the same for the whole tree, the host can't forge it, and it needs no remote call.
- A run with no operator run, such as a free request script that moves no money, reads the node's clock instead.
- Contracts that hold money should read `now`.

**`Datetime.now` and other time resources** still work. `sh.stellarium.stdlib.Datetime.now` returns the stdlib node's clock, signed with its response. In a verified run, the operator checks that time responses fall between the root run's start and its capture, as Ethereum checks a block's timestamp against its parent's. Like a block producer choosing when to include a transaction, a host can still choose when to run a contract.

**Unique ids: `Uuid`.** Recorded and signed like any response, and choosing again gains nothing, so ids need no extra care. `Job` uses one for its job ids.

**Randomness for money decisions** (a draw, a random winner, a tiebreak) takes two steps, like a VRF or commit-reveal on Ethereum. A value a run sees as soon as it starts can be tried again: a host can open runs with its own API key until it likes the value, as a block producer can bias `prevrandao`. So:

1. **Request.** A run calls `sh.stellarium.random.Random.requestValue(key)` (`request` is a RequestScript keyword). The request is staged on the operator like a money change, so it stands or falls with the run's tree, and a contract can request each key once.
2. **Value.** Once the operator has applied the requesting run's root, it draws the value (32 random bytes, base64url), signed and bound to the contract's node, name, version and key (`randomValuePayload`).
3. **Use.** A later run reads the value with `Random.value(key)`, which fails until the value exists.

`Random` is built into stellarium-ts like `Account`, and served by the operator rather than a stdlib node, so no peer can answer for it. A request in a run that fails or is dropped is dropped too, and its key can be requested again.

By the time anyone knows the value, the request can't be retried.

**Providers that don't sign.** Signed, cached responses need a stellarium-ts upgrade on every provider, including stellarium-stdlib and stellarium-inference. A payable contract that calls a provider without it is flagged to buyers, like one that calls its host's own resources, and its trees are always verified before money moves.

## Verified runs

A host node runs its contracts alone, so without checks it could claim a contract paid it and move the contract's money. Ethereum prevents this by having every validator re-run every transaction. Stellarium has a party everyone already trusts with the money, the operator, so the operator re-runs the contract runs that move money. In rollup terms, the operator plays Ethereum's role and the host nodes play the rollups.

Contracts call resources on other nodes, so they aren't deterministic the way Ethereum contracts are. The operator replays each run from a recording of it, a **transcript**, instead of running it live.

### Which runs are verified

- every run of a `payable` contract, from its first run;
- every contract run in the same tree as one;
- **every run of a contract version a payable contract depends on**, from the moment that payable contract is registered. Verification is sticky: once a version is verified, its runs send receipts for good, including runs outside any payable tree. Otherwise its state would change between verified runs on the host's word alone, and its hash chain would have gaps.

A version that ran unverified before it became a dependency has state its host vouched for alone up to that point. The operator flags payable contracts that depend on one (see [What verification doesn't cover](#what-verification-doesnt-cover)).

### Transcripts

With each capture, the node sends a **run receipt**, signed by its key over `runReceiptPayload`. The receipt holds the run's transcript:

- **The contract:** its path, name, version and source hash, which must match its [registration](#registration).
- **The runtime:** the stellarium-ts contract runtime version and the definitions of the structs it used. The RequestScript version comes from the registration, not from the receipt.
- **The call:** the parameters, with the voucher or attestation that signed them; `payment` (with its payees), `sender`, `caller`, `jwt`; and, for an event contract, the signed event envelope.
- **State:** every state variable the run read, with its scope, value and version, and every variable it wrote.
- **Resource calls,** in order of `callIndex`. Each records the function, the parameters, the pinned version for a contract, and either the provider's signed response, the operator's signed answer for `Account`, or an unsigned failure (see [Signed responses](#signed-responses)). A call to a contract on the same node also has the callee's receipt nested in the tree.
- **Results:** the return value, the events emitted (by type and data), the money changes staged and the tokens metered.
- **`now`,** as stamped by the operator, which replay checks against its own record.

A receipt can be at most `MAX_TRANSCRIPT_BYTES`. A capture whose receipt is larger is refused, so the run fails.

### Signed responses

A host could make up the responses other nodes gave it. To prevent that, providers sign every `/v1/run/resource` response, including contract calls, over `resourceResponsePayload`: `{ invocationHash, runTag, callIndex, response, publicKey, signedAt }`.

- **One answer per call.** A provider caches its response per `(runTag, callIndex)` for `RESPONSE_CACHE_MS`, and answers a repeated call with the same signed response. A host therefore can't call a provider again and again and keep the answer it likes, even from a provider whose answers vary, such as inference or `Uuid`.
- **No gaps.** The operator checks that a transcript's call indexes run from 0 without gaps, and that each signature matches the node that answered and the recorded call.
- **Failures can't be signed, but answers are remembered.** When a provider can't be reached, nothing signs the failure, so a host could claim a call failed that actually succeeded. Providers keep a **served-call log** of `(runTag, callIndex, response hash)` for `SERVED_CALL_RETENTION_DAYS`, longer than verification can take. When a transcript records a call as failed, the operator asks the provider whether it answered. A provider that did turns the claimed failure into proven [fraud](#fraud). A provider that's down or colluding still can't be checked, so contracts must never move money on an error path that favors whoever hosts them.

### State hash chains

The operator keeps a hash of every state variable of every verified contract, by scope: its value and version as of the last applied receipt. A receipt's reads must match these hashes. Its writes replace them when its root applies, as its node saves them.

- A host therefore can't rewind a contract's state, fork it, or show the replay different state from what earlier runs left.
- **Every write is recorded.** Every verified run sends a receipt (see [Settlement](#settlement)). Receipts whose root was dropped are kept as evidence, but don't change the chain, since their writes were never saved.
- **Order.** The operator checks receipts in state-version order, since optimistic verification finishes out of order.
- **Gaps have a deadline.** If a receipt for a state version doesn't arrive within `RECEIPT_GAP_DEADLINE_MS`, verification of every later run of that contract would wait forever. The operator suspends the host's contract hosting and treats the gap like a [mismatch](#when-replay-disagrees).
- **A new payable version starts from empty state,** so its chain is complete from its first run.

### Replay

The operator parses the contract's source and runs it with the RequestScript version from its registration and the recorded stellarium-ts contract runtime, using a replay invoker:

- each resource call the contract makes must be the transcript's next call, with the same function, parameters and pinned version, and it gets the recorded response;
- the built-ins come from the transcript, and the operator checks them against what it knows: the run token, the voucher, the attestation, the event envelope, the registered owners;
- the state reads come from the transcript, checked against the hash chains;
- structs resolve from the recorded definitions.

The replay must produce the same state writes, events, staged money changes, return value and token count. Since the token count is checked too, replay verifies the run's token charge as well as its money.

**Supported versions.** The operator keeps every RequestScript version a registered contract runs on, and publishes the list. A deploy that names an unsupported version is refused, so no contract can depend on a runtime the operator can't replay.

**Cost.** Replay doubles the tokens a verified run executes.
- Holds for billed runs that include a payable contract cover twice the script tokens, and the replayed tokens are charged to the root run at the node's listed price, as platform revenue.
- A free run's replay is charged to the node's organization.

**Capacity.** Each node gets a replay quota (`REPLAY_QUOTA_TOKENS_PER_HOUR`). Runs past it are refused, so one node's transcripts can't hold up every other node's money.

### When replay disagrees

Replay can fail in two different ways, and only one of them proves anything:

- **Proof.** The receipt is cryptographically inconsistent:
  - a signature doesn't verify;
  - a read doesn't match its state hash;
  - the source hash doesn't match the registration;
  - the call indexes have gaps;
  - a response contradicts the provider's signature;
  - a call recorded as failed appears in the provider's served-call log;
  - a staged money change has no matching call in the replay.

  An honest host can't produce any of these, so they are proven [fraud](#fraud).
- **Mismatch.** The receipt is consistent, but the replay came out differently. Payable contracts are [deterministic](#deterministic-contracts), so a contract author can't cause this. Either the host ran something other than what it recorded, or the runtime has a bug that the shared test suite missed. A mismatch:
  - drops the tree's money and state changes, or holds the money if it was applied optimistically;
  - suspends the node's contract hosting;
  - goes to manual review, with the receipt and the recorded versions.

  The review decides:
  - **The host is at fault:** the mismatch is treated as fraud.
  - **The runtime is at fault:** Stellarium fixes the bug, adds a case to the test suite, restores hosting, and lets the dropped changes be retried.

### When the operator verifies

- **Before money moves** (the default). The root run's capture waits for replay. A tree that fails replay has its changes dropped, so no money moves.
- **Afterwards,** for trees whose money changes total less than `OPTIMISTIC_VERIFY_LIMIT_MICRO_USD`. Changes apply at capture, and the operator replays the tree within `PAYOUT_HOLD_DAYS`, so the payout hold works like a rollup's challenge window.
  - Payable balances credited by a tree aren't paid out until it's verified, so whatever a fraudulent tree paid is usually still in the ledger when replay catches it.
  - Funding the tree created stays locked until it's verified (see [Funding](#funding)).
  - A node's trees awaiting verification may total at most `MAX_UNVERIFIED_MICRO_USD_PER_NODE`. Past that, its trees are verified before money moves, so fraud can't be split into many trees that each stay under the limit.
  - Trees whose contracts are flagged for calling their host's own resources are always verified before money moves.

### Fraud

Fraud is proven by a cryptographically inconsistent receipt, or found by a review of a mismatch. The fraudulent organization is the host node's. The operator:

1. **Reverses what it can.** It undoes the fraudulent tree's changes that haven't left the ledger, such as payable credits not yet paid out.
2. **Refunds the defrauded organizations from the organization that committed the fraud.** Each funder whose contract funding the fraud took gets it back in its prepaid balance. The money comes from the fraudulent organization's payable balance first, including amounts waiting for payout, then from its prepaid balance. Each refund is a balanced ledger transaction that names the fraudulent run.
3. **Bans the organization.** It sets `bannedAt` on the organization:
   - its nodes and API clients are **suspended**, which can be undone, and revoked only if the ban is upheld (`revokeNode` is permanent);
   - its pending payouts are cancelled;
   - its Connect account and Stripe customer can't be attached to another organization;
   - its owners' and admins' dashboard accounts are paused (see [Appeals](#appeals)).

   A banned organization can't be unfrozen from the dashboard.
4. **Closes the contracts its nodes hosted.** A suspended node can't run them, so the operator refunds all their remaining funding to its funders at once, without waiting for the time limit.
5. **Keeps the receipts as evidence.**

**A stolen node key is still the organization's responsibility.** Fraud signed with an organization's node key is refunded from that organization even if the key was stolen. On appeal, Stellarium may lift the ban once the organization has revoked the key and secured its nodes, but the refunds stand.

**Payers are made whole.** If the fraudulent organization's balances don't cover every refund, the platform pays the shortfall from its own revenue account. The shortfall becomes a debt the fraudulent organization owes Stellarium, which Stellarium pursues outside the platform. Every organization that can be paid has completed Stripe Connect identity verification, so that debt has a legal remedy. Two things keep this cost small: verifying before money moves stops fraud before it moves anything, and payouts from unverified trees are held.
- This is Stellarium's internal policy, not a guarantee. The product, the docs and marketing must not present it as protection of deposits or held funds, which would contradict [Stripe's conditions](#stripes-conditions). Have counsel and Stripe review any customer-facing wording.

**Ban evasion.** A banned person can sign up again with new emails and a new Connect account. Stripe's identity checks catch some of this, and Stellarium reviews new organizations whose details match a banned one, but nothing prevents it fully. The hosting cap starts at 0 for every new node, which limits what a returning fraudster could do.

### Appeals

A ban pauses the dashboard accounts of the organization's owners and admins; it doesn't suspend them. A paused account:

- **can** sign in and see the banned organization, read-only: its runs, the fraudulent run's receipt, and the refunds taken from it;
- **can't** act for the banned organization or create new organizations until the appeal is decided.

In other organizations, a paused account keeps its role, and Stellarium notifies those organizations' owners of the ban so they can decide for themselves.

The organization's owner can appeal the ban once, from the dashboard, with a statement. Stellarium reviews the appeal against the run receipts.

- **Upheld:** the ban stays, the organization's nodes and API clients are revoked, and the paused accounts stay paused.
- **Overturned,** for example because review finds a runtime bug: Stellarium lifts the ban, unpauses the accounts, and lifts the suspension on the organization's nodes and clients. It returns what the refunds took from the organization out of the platform's revenue account. Refunds already made to payers stay where they are.

### What verification doesn't cover

- **The host's own resources.** A response from a function on the host's own node is signed by the host, so the host can make it up. A payable contract that calls its host's resources trusts its host for those answers, as an Ethereum contract trusts an oracle. The operator spots these calls in transcripts and flags the contract to buyers.
- **Failures from providers that can't be checked.** A host can still claim a call failed when the provider is down or colludes, since the served-call log can't be read. A contract whose error path moves money toward its host, or toward anyone the host could be, can be steered that way.
- **Order and censorship.** The host decides the order in which runs reach its contracts, and can serve some callers and not others, as a block producer orders and censors transactions. It can also run its own API-key calls first. State hash chains fix the order once it's chosen, but not who chose it. Contracts where order decides money, such as first-come sales or auctions, should use commit-reveal or batch rounds that resolve after a deadline set with `now`.
- **Runs the host starts with its own API key.** A host can open runs with its own API key, look at the outcome, and release the ones it doesn't like, as an Ethereum user can simulate a transaction before sending it. That's the host acting for itself. It can't use this to choose a random value, because [randomness for money decisions](#time-and-randomness) takes two steps. Runs started by other nodes' calls or by events can't be repeated: their run id comes from the caller's voucher or the event. The operator records every released run of a payable contract, and flags hosts that release an unusual share.
- **History before verification.** A contract version that ran unverified before a payable contract depended on it has state its host vouched for alone up to that point. Payable contracts that depend on one are flagged, like those that call the host's own resources.
- **Refusing to run.** A host can stop running a contract, and verification can't make it. The time limit returns the money within 30 days, like a rollup's forced exit.
- **Privacy.** The operator sees each verified run's parameters, state and resource responses. It keeps transcripts for `RUN_RECEIPT_RETENTION_DAYS`, at least 180 days so that they outlast card dispute windows and appeals. Transcripts are kept as fraud evidence even when someone asks for their data to be deleted, then deleted when the retention period ends. The terms must say so.

## Vouchers

> **As built:** the voucher carries no value fields. The calling node stages the attached money on its run (`attach` on `POST /v1/money/stage`) under an `attachmentId` it picks, and sends the id with the call (`attachmentId` on `POST /v1/run/resource`), whose voucher names the caller's run as `runId`, so the contract joins the caller's tree. The receiving node refuses the call unless the contract is payable, and reads the attachment from the operator (`attachment` on `POST /v1/money/read`, signed), which answers only for money staged for that contract in the same tree. That gives the same assurance as signed voucher fields, since the money is real only once the operator staged it, without changing the voucher's signed bytes. A call from a free run is held on the payer's balance rather than the free run's, which holds nothing. The design below is kept for reference.

A remote call that attaches money carries it in its `ContractPaymentVoucher`:

- `value` is set only when it's greater than 0. It is signed after `priceMicroUsdPerMillionTokens` and before `runId`, so a voucher that sends nothing signs the same bytes as before.
- A voucher from a contract also carries the funder, `valueFrom`, and its key, `valueKey`, signed right after `value`, each only when set.
- `valuePayees`, the payees, is signed after `valueKey` whenever `value` is set.
- The voucher's `invocationHash` covers the contract version the caller pinned (`resourceVersion`, built). A call that attaches money is always pinned, so its voucher pays for that version only.
- The provider checks that the contract is `payable`, then asks the operator to hold `value` along with the run's `maxAmount`. When the voucher carries a `runId`, the value comes out of the parent run's tree.
- Like the other voucher fields, these must be kept in sync everywhere the voucher's wire format is copied (see `CLAUDE.md`). `CallerAttestation`, `callerAttestationPayload`, `resourceResponsePayload`, the operator's `Account` answers, `runReceiptPayload` and `invocationHash` join that list, because the operator verifies them itself.

## Trust

Stellarium has no consensus: one node runs a contract, and the operator checks its account of what the contract did.

**Host nodes.** A host can't move money by lying about what a contract did: the operator replays every run of a payable contract (see [Verified runs](#verified-runs)). What it still controls is listed under [What verification doesn't cover](#what-verification-doesnt-cover). These limits cover the rest:

- `maxContractBalanceMicroUsd` is 0 until Stellarium sets it, and caps what a fraudulent host could take, which bounds what the platform might have to cover.
- The operator alerts when a node's contracts pay the node's own organization more than a set amount, or when outflows from a node jump.
- Money can only go where [Where money can go](#where-money-can-go) allows, so a lying node can't send money to an arbitrary account, or to anyone a funder didn't name.
- `PAYOUT_HOLD_DAYS` leaves time to finish verifying before a payout leaves Stripe.

**Tenants.** Other organizations deploy contracts to listed nodes. A tenant's contract calls other nodes as its registered owner, never as the host (see [Who is calling](#who-is-calling)). Payable contracts are deterministic, so a tenant can't write one that replays differently and gets its host banned.

**Contract owners.** An owner can deploy new versions, but can't change what an existing version does or what a contract depending on it calls, since callers pin versions. Its only lever over funded money is refund-all, which returns money to its funders.

**Reserved paths.** Resources are learned from peers, and the first peer to publish a path keeps it. A node that published `sh.stellarium.stdlib.Random` first could answer contracts with values it chose. So:
- `sh.stellarium.money` and `sh.stellarium.random` are built into stellarium-ts, and nodes never learn any resource under them from peers;
- nodes learn other resources under `sh.stellarium` only from peers whose membership token names the Stellarium organization, and drop any they already learned from other peers;
- Stellarium declares the `sh.stellarium` structs before anyone else can.

**The operator.** The operator holds the ledger and decides fraud, so it is the one party everyone must trust, and the one single point of failure: while it's down, no money moves, and payable contracts' pending state waits. To make that trust checkable:
- every manual action is written to an append-only audit log, naming who did it and why: bans, appeal decisions, shortfall payments, raising a node's `maxContractBalanceMicroUsd`, mismatch reviews and refund-alls;
- bans, upheld appeals, shortfall payments and raising a node's `maxContractBalanceMicroUsd` need a second staff member's approval;
- an organization can read the audit entries about itself;
- **signed checkpoints:** every `CHECKPOINT_INTERVAL`, the operator publishes a signed hash of every contract account's balance and funding, its money log and the state hash chains. Funders and payees can check their own entries against it, and anyone holding a contract's receipts can replay its runs and compare. On Ethereum anyone can verify the chain; here anyone can at least verify that the operator didn't rewrite what it published.

**Card fraud.** A stolen card could top up an organization, fund a contract, and pay an organization the fraudster controls. The payout would leave after 7 days, and the chargeback arrive up to 120 days later. Paid resources allow this today, and contracts make it one step for any amount. Stripe's guidance rules out a longer payout hold, so the defenses are elsewhere:
- a limit on how much an organization can attach in a rolling window, starting low and rising with its payment history;
- Stripe Radar on top-ups;
- flagging payments where the payer and payee share a user, an email domain or a card;
- payer identity checks above `PAYER_KYC_THRESHOLD_MICRO_USD` a month.

**Griefing.** Each staged change locks funds, and each pending state write locks its scope, until the root run settles. Many slow runs could make a contract's balance look spent or its scopes busy. The operator limits each contract to `MAX_PENDING_MONEY_RUNS_PER_CONTRACT` root runs with staged changes at a time, and each payer to `MAX_PENDING_MONEY_RUNS_PER_PAYER` of those, so one payer can't use up a contract's slots.

## Examples

### Payment on delivery

A buyer funds a job. The provider is paid when the buyer or the arbiter confirms delivery. The buyer gets the money back if the provider or the arbiter cancels.

```
payable contract com.example.Job(action: string, jobId: string, provider: string, arbiter: string): string {
    const account: sh.stellarium.money.Account
    const uuid: sh.stellarium.stdlib.Uuid

    var id: string = jobId
    if (action == "fund") {
        const created = uuid.new()
        if (created.error != null) {
            fail "couldn't create a job id"
        }
        id = created.value
    }
    var state(id) payer: string = null
    var state(id) payee: string = null
    var state(id) judge: string = null

    if (action == "fund") {
        if (payment.amount == 0) {
            fail "fund needs money attached"
        }
        if (provider == arbiter || provider == payment.from) {
            fail "the arbiter must be a third party"
        }
        if (account.canReceive(org: provider).value == false) {
            fail "the provider can't receive payouts"
        }
        account.earmark(key: id)
        payer = payment.from
        payee = provider
        judge = arbiter
        return id
    }
    if (payer == null) {
        fail "no such job"
    }

    // The job's own money, after anything the time limit or a dispute already returned.
    const due = account.fundingOf(org: payer, key: id).value

    if (action == "release" && (sender.org == payer || sender.org == judge)) {
        if (due > 0) {
            account.pay(to: payee, amount: due, from: payer, key: id)
        }
        return id
    }
    if (action == "cancel" && (sender.org == payee || sender.org == judge)) {
        if (due > 0) {
            account.refund(to: payer, amount: due, key: id)
        }
        return id
    }
    fail "not allowed"
}
```

The buyer funds it with a pinned version, naming the provider as the only payee and a third party as the arbiter:

```
request Hire {
    const job: com.example.Job@1
    return job.run{amount: 20000000, payees: ["org_courier"]}(action: "fund", jobId: "", provider: "org_courier", arbiter: "org_arbiter").value
}
```

- **The contract chooses job ids,** so nobody can claim a job id before the buyer funds it.
- **Each job's money is earmarked with its id.** The operator's funding records are the job's balance, so the contract needs no `held` variable, and a release can only pay out its own job's money, even when the same buyer funds several jobs.
- **Each job is its own state scope,** so jobs don't wait for each other while a run settles (see [Settlement](#settlement)).
- **The arbiter is a third party.** A provider who could also arbitrate could release the job to itself.
- **Either side can be unblocked.** The arbiter can release to the provider or cancel back to the buyer, so a vanished provider doesn't leave the buyer waiting for the time limit.
- **Payees back up the code.** Even a buggy `Job` can only pay `org_courier` with this buyer's money.
- **Authorization uses `sender`.** A contract that the buyer called on its way here can't release the job in the buyer's name, and `sender.org` is a registered owner, never `null`, so a contract can't claim to be the arbiter.
- **Results are read with `.value`, and errors are checked.** A failed `uuid.new()` fails the run before any money is earmarked, and a failed `Account` call fails the run even if the contract ignored it. Nothing pays out because a call failed.
- **`Uuid` needs no second step.** A job id is unpredictable, but nobody gains anything by choosing it again, unlike a [random value that decides money](#time-and-randomness).
- **`fail`** is the planned statement that fails the run on purpose (its syntax isn't final). A failed `fund` returns the attached money to the buyer, and saves no state.

The arbiter can confirm through an event. The arbiter deploys this event contract with its own API client, so its registered owner is the arbiter. `Job` sees the arbiter's contract as `sender`, and `sender.org` is the arbiter. A contract anyone else deploys to consume the same event has its own owner as `sender.org`, so `Job` refuses it:

```
contract org.arbiter.ReleaseOnDelivery consumes org.arbiter.JobDelivered@1 {
    const job: com.example.Job@1
    job.run(action: "release", jobId: jobId, provider: "", arbiter: "")
}
```

### Splitting a payment

```
payable contract com.example.Split: int64 {
    const account: sh.stellarium.money.Account
    const author = payment.amount * 70 / 100
    account.pay(to: "org_author", amount: author, from: payment.from)
    account.pay(to: "org_data", amount: payment.amount - author, from: payment.from)
    return payment.amount
}
```

The buyer names both organizations as payees: `split.run{amount: 1000000, payees: ["org_author", "org_data"]}()`.

- **Both payments settle together, or neither does.** A call without enough money attached fails, because `pay` refuses an amount of 0.
- **Integer division truncates,** so `org_data` gets the remainder, and nothing is lost to rounding.
- **One payee can block the other.** If `org_data` loses `payoutsEnabled`, every call fails until it's restored. A split that must keep paying the author would use `tryPay` for each payee, and refund what it couldn't pay.

## Not supported

- **Paying public keys or arbitrary accounts.** Money reaches organizations only through `pay`, to payees its funder named, and `refund`.
- **Upgradeable contracts.** Contracts call pinned versions, and there's no proxy pattern or way to move a version's money to a new version.
- **Tokens.** Nothing that works as a transferable dollar, such as an ERC-20 token, can be created. Contracts may track rights such as credits or seats in their state.
- **Interest, lending or yield** on balances.
- **Arrangements longer than the time limit,** such as bonds or retainers.
- **Self-destruct.** Contract accounts close only when their balance reaches zero, through their own code, a refund-all or the time limit.
- **Escrow or deposit accounts.** Contracts route marketplace revenue. They don't hold money for safekeeping (see [Stripe's conditions](#stripes-conditions)).

## Rollout

Ethereum's main lesson for contracts that hold money is process, not mechanism. Before any node's `maxContractBalanceMicroUsd` is raised above 0:

- **An executable spec of the ledger's invariants,** checked after every operator transaction in tests and nightly in production: a contract's balance is the sum of its funding, the ledger balances, every outflow goes to a payee or back to a funder, and no funding outlives the time limit.
- **Property-based and fault-injection tests** of settlement: crashes between staging, capture, the outcome check and the state save; roots that fail, expire or fail verification; out-of-order receipts.
- **An external audit** of the operator's money code and the deterministic profile, and a **bug bounty**.
- **A staged launch:**
  - payable contracts on Stellarium's own nodes first, with an allowlist of contracts;
  - every tree verified before money moves (`OPTIMISTIC_VERIFY_LIMIT_MICRO_USD` 0);
  - caps raised slowly, per node, after review.

## As built

Where the build differs from the design above, or leaves part of it out:

- **When the operator verifies:** before money moves, by default. A tree whose contracts staged changes waits as `verifying`, its funding locked and its nodes' state pending, until its receipts replay; then it applies, or is dropped. Trees below `OPTIMISTIC_VERIFY_LIMIT_MICRO_USD` (default 0) apply first, while each host's applied unverified money stays within `MAX_UNVERIFIED_MICRO_USD_PER_NODE`, and their payments are held from payouts until verified. Request scripts aren't replayed.
- **Signed responses:** a contract run tags each remote call with `hash(nonce, provider)` and an index; the provider signs its answer, gives the same one to a repeated call, refuses another call at the same index, and keeps a served-call log (`GET /v1/served-calls/{runTag}/{callIndex}`) for 30 days. The signature covers the tag, the index, the call's invocation hash as the provider computed it, the response, the key and the time; the operator checks the response and tag, not the invocation hash against the receipt's arguments.
- **Proof** is what an honest host can't produce: a receipt naming other source than the registration; a staged change that differs from the call its receipt says made it, or one staged at a read; a state read that rewinds or forks the operator's state hash chain; an answer its provider didn't sign; a tag its run never made, or used twice; or a call recorded as failed that its provider's log shows it answered. A replay that disagrees, receipts missing past `RECEIPT_DEADLINE_MS`, an unregistered contract or an unsupported runtime goes to staff review and suspends the host.
- **Flags** shown to buyers, from verified runs: calls to the host's own resources, calls to providers that don't sign, and state read before the operator verified it.
- **Fraud** drops a tree caught before its money moved. For one applied first, the payments go back to their funders, from the payee's held credit, then the fraudulent organization's payable and prepaid balances, with the platform's revenue covering the rest as the fraudster's recorded debt (`fraud_cases.shortfallMicroUsd`). The host's nodes are suspended, its contracts closed, and a ban proposed for two staff members.
- **Bans** pause the banned organization's owners' and admins' dashboard accounts: they can't create organizations until the ban is lifted, keep their roles elsewhere, and the owners of their other organizations are emailed. The banned organization itself can read and appeal, but change nothing.
- **Staff** use the console at `/staff` in the dashboard, signed in with their own key from `STAFF_API_KEYS`, or the staff API (`/v1/staff/*`). Bans, upheld appeals, raising a node's contract balance limit and finding a host at fault need two staff members; the operator's own proposals need two.
- **Runtime:** the operator replays a contract registered on RequestScript of its own major and minor version, from 1.8, and only once its installed version passes the conformance suite.
- **`sender` and `now` are given to payable contracts only,** like `payment`, so older contracts may still use the names. `now` is the operator's stamp on the tree's root, or for a free run, the time its node started the script, which the operator accepts within a run's lifetime.
- **`Random`** is `sh.stellarium.random.Random` (`requestValue`, `value`), built into stellarium-ts and drawn by the operator (table `random_requests`), not a stdlib resource. Verification checks each request against its staged change, and each value a run read against the one drawn.
- **Notifications:** when a safety net moves an organization's funding (time limit, refund-all, fraud reversal, closing) or a dispute is recovered from it, the operator emails its owners and, if it set one in the dashboard, posts to its webhook, signed with the operator's key (`Stellarium-Signature`, `Stellarium-Key`), retrying with backoff.
- **Disputes and refunds** that leave a prepaid balance negative are recovered from the organization's unspent contract funding, which goes back to its balance first.
- **Closing** an organization takes two staff members: its contract funding goes back to its balance, and its nodes and API clients are refused from then on. Organizations aren't deleted.
- **Card fraud:** an organization may attach `ATTACH_LIMIT_BASE_MICRO_USD` (default $100) in `ATTACH_WINDOW_DAYS` (30), plus its net top-ups older than the window, and more than `PAYER_KYC_THRESHOLD_MICRO_USD` (default $1,000) a month only once staff record its identity as verified. Payments between organizations that share a dashboard user or an owner's email domain (not a public mail provider) are flagged, and payouts hold the payee until staff clear the flag. Sanctions screening runs through a `SanctionsScreener` the deployment provides; a blocked organization can't be paid or receive payouts. Stripe Radar runs on top-ups as Stripe's default.
- **Alerts** for staff: a node's contracts paying its own organization more than `SELF_PAYMENT_ALERT_MICRO_USD` in a day, a day's outflows above `OUTFLOW_JUMP_ALERT_MICRO_USD` and five times the week's daily average, and more than half of a node's money trees dropped in a week. Alerts stop nothing.
- **Pending runs:** each contract may have `MAX_PENDING_MONEY_RUNS_PER_CONTRACT` (100) root runs with staged changes at a time, and each payer `MAX_PENDING_MONEY_RUNS_PER_PAYER` (20).
- **Not built:** linking payments by card fingerprint, a sanctions screening provider (none ships; without one nobody is screened), and identity verification itself, which staff do outside Stellarium and record.

## Implementation outline

- **RequestScript 1.8.0:**
  - pinned resource versions, `const r: path.Name@version`, required in contracts for versioned resources (**built**);
  - the `payable` modifier, `{amount, payees, from, key}` call options, the `payment` (with `payees`) and `now` built-ins, and a statement that fails a run on purpose, `fail "reason"` (**built**; `payment` and `now` are declared only for payable contracts, or when a host passes them, so older scripts may still use the names);
  - the deterministic profile, with checked `int64` arithmetic and truncating integer division (**built**: the language has nothing whose behavior varies between machines, so no deploy check is needed), and the shared deterministic test suite every release must pass (**built**: `requestscript/conformance`, run before every publish; first released after 1.8.0);
  - the interpreter reports each call's amount, payees, funder and key to the resource invoker, and refuses invalid amounts (**built**).
- **stellarium-stdlib:** signed, cached responses with a served-call log (the stellarium-ts upgrade). The two-step `Random` resource is built into stellarium-ts instead, with the operator drawing values (**built**: see [As built](#as-built)).
- **[stellarium-money](https://github.com/qualletio/stellarium-money):** the specification of `sh.stellarium.money.Account` and its conformance tests, which stellarium-ts runs against its built-in implementation.
- **stellarium-ts:**
  - pinned contract versions: versioned contract resources, `resourceVersion` on remote calls and in `invocationHash`, `GET /v1/contracts/:ref`, and refusing unpinned contract bindings at deploy (**built**);
  - requiring pinned versions on calls that attach money (**built**, in the interpreter and the invoker);
  - `sh.stellarium.money.Account` as a built-in resource (`balance`, `earmark`, `fundingOf`, `canReceive`, `pay`, `tryPay`, `refund`), staging on the operator and failing the run at its end when any of its calls failed (**built**: `src/money/account.ts`; `earmark` waits for attached money), and recording the operator's signed answers in transcripts;
  - the `sender` built-in, and the running contract's version and owner in `ScriptContext`; refusing calls to payable contracts from contracts without an owner;
  - registering contract versions with the operator at deploy: source, owner, RequestScript version and dependencies (**built**: a payable contract before it's saved, refusing the deploy if the operator refuses; any other contract after, in the background);
  - caller attestations:
    - `callerAttestation` on resource functions;
    - `CallerAttestation` with `runTag` and `callIndex`, signed in the invoker and checked in `/v1/run/resource`;
    - `exec`'s second argument;
    - attestations on every remote contract call, and on every call from a verified run;
  - signed resource responses bound to `(runTag, callIndex)`, cached per pair for `RESPONSE_CACHE_MS`, and a served-call log kept for `SERVED_CALL_RETENTION_DAYS` that the operator can query;
  - run receipts with transcripts, sent with every capture of a verified run, within `MAX_TRANSCRIPT_BYTES`;
  - a root run for every run of a payable contract, and for free runs that move money, with event runs' ids derived from `hash(eventId, consumer)`;
  - the `now` built-in, from the operator's stamp on the root run (built from the node's clock instead, taken once per chain on a node: the operator doesn't stamp runs yet);
  - refusing to deploy payable contracts outside the deterministic profile;
  - staging attached amounts with their payees, and passing a child run's changes up to its parent (**built**);
  - pending state for verified runs: locks per state scope, the outcome check, and saving or discarding the writes when the root settles (**built** for chains that stage a money change or run a payable contract on a node: `src/contract/pending.ts`, kept in `contract_pending_state` across restarts; a chain's runs that finish before its first money change still save at once, and other nodes' runs in the tree decide for themselves);
  - capturing failed contract runs, and failed request scripts, as failed (**built**), and an outbox for captures, releases and pending state, written with the run's result, replacing `settleRunLater` (**built**: `settlement_outbox`, `src/resource/outbox.ts`, also for paid calls' vouchers; a run's capture is written after its state is saved or kept pending, rather than in the same transaction, which keeps the same guarantee);
  - a deploy warning that payable contract source is public;
  - never learning `sh.stellarium.money` from peers (**built**), learning other `sh.stellarium` paths only from the Stellarium organization, and dropping impostors already learned;
  - the voucher's `value`, `valueFrom`, `valueKey` and `valuePayees` (replaced by an `attachmentId` the receiving node reads from the operator: see [Vouchers](#vouchers));
  - amount checks at every boundary.
- **Operator:**
  - accounts and funding:
    - `contract_versions` (registration and balance), `contract_funding` (by organization and key, with each funding record's payees, path and source charge date) and `money_changes` (**built**);
    - payee checks on every `pay`, and payee narrowing on every contract-to-contract transfer (**built**);
    - spending only top-up credit younger than `MAX_FUNDING_SOURCE_AGE_DAYS`, oldest first (**built**);
    - refunds that go one step back along the path, and safety nets that return money straight to the original organization (**built**);
    - ledger accounts for contract balances, and fees rounded up (**built**);
    - `POST /v1/money/stage`, which accepts changes only from a contract version's registered host and stages each at most once per run and `callIndex`, plus signed answers for `balance`, `fundingOf` and `canReceive` at `POST /v1/money/read` (**built**);
    - passing staged changes up on child capture, applying them on root capture, and dropping them on failure (`failed` on `POST /v1/runs/capture`), release and expiry (**built**);
    - `POST /v1/runs/outcome`, so nodes save or discard pending state, and `POST /v1/runs/open` for free root runs (**built**);
    - the child receipt deadline (**built**), and keeping roots that wait for verification from expiring;
    - locking funding created by unverified trees until they're verified;
  - the public contract route: registration, balance and host organization (**built**), and flags;
  - the money log per contract version (**built**), and notifications when safety nets move an organization's funding (**built**: email and a signed webhook);
  - refund-all for contract owners (**built**);
  - limits:
    - `maxRunValueMicroUsd` on API clients, with attached money counted toward `monthlyCapMicroUsd` (**built**);
    - `maxApiKeyRunValueMicroUsd`, `monthlyApiKeyValueCapMicroUsd` and `maxContractBalanceMicroUsd` on nodes, all defaulting to 0, and `MAX_FUNDER_SHARE_OF_NODE_CAP` (**built**; staff set node limits with `OrganizationService.setNodeMoneyLimits`, which has no route yet);
    - per-organization attach limits, payer and payee link checks, outflow alerts, payer KYC above `PAYER_KYC_THRESHOLD_MICRO_USD` and sanctions screening (**built**, except card-fingerprint links and a screening provider: see [As built](#as-built));
    - `MAX_PENDING_MONEY_RUNS_PER_CONTRACT` and `MAX_PENDING_MONEY_RUNS_PER_PAYER` (**built**), and per-node replay quotas;
  - verified runs:
    - storing run receipts, checked against each version's registration;
    - sticky verification for every contract version a payable contract depends on;
    - state hash chains checked in version order, updated only by applied roots, with `RECEIPT_GAP_DEADLINE_MS`;
    - a replay worker that runs transcripts with each version's registered RequestScript version, before capture or within `PAYOUT_HOLD_DAYS`, and the published list of supported versions;
    - holds that cover replay, and charging replay to the root run or the node's organization;
    - separating proof from mismatches, and the mismatch review queue;
    - stamping each root run's start time for `now`, and checking time responses fall between a root run's start and its capture;
    - recomputing `runTag`s to check signed responses, and querying providers' served-call logs for calls recorded as failed;
    - authorizing one root run per event and consumer, and recording every released run of a payable contract;
    - holding payouts from unverified trees (**built**: `runs.verification`, `PayoutService` holds a tree's payments until `MoneyService.recordVerification` marks it verified, and for `PAYOUT_HOLD_DAYS`; nothing verifies trees until the replay worker exists), `MAX_UNVERIFIED_MICRO_USD_PER_NODE`, and reversing trees that fail;
    - flags for calls to the host's own resources, calls to providers that don't sign responses, dependencies with unverified history, and unusual release rates;
  - fraud handling:
    - reversing fraudulent trees;
    - refunding funders from the fraudulent organization's payable and prepaid balances, with the platform's revenue account covering any shortfall and recording it as a debt;
    - banning it (`bannedAt` on `organizations`, suspending its nodes and clients and revoking them if the ban is upheld, cancelling its payouts, pausing its owners' and admins' accounts, notifying their other organizations);
    - closing its nodes' contracts;
    - appeals: a read-only dashboard view for paused accounts, one appeal per ban from the owner, and lifting a ban;
  - governance: the append-only audit log, a second approval for bans, upheld appeals, shortfall payments and cap raises, organizations reading their own entries, and signed checkpoints every `CHECKPOINT_INTERVAL`;
  - the interval that refunds funding past `MAX_CONTRACT_HOLD_DAYS` once its runs settle (**built**), dispute recovery from funding (**built**), and refunding a closed organization's funding (**built**: organizations are closed, not deleted);
  - `RUN_RECEIPT_RETENTION_DAYS`, at least 180.
- **Dashboard:** before funding, a contract's registration, dependencies, flags and payees; for payees, how much of their funding is still inside card dispute windows; the money log.
