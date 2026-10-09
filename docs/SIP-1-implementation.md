# SIP-1 implementation decisions

This document records the implementation of `SIP-1_monetization.md` and the decisions approved during implementation. The node, SDK, relay, contracts, arbitration, reputation, governance, tests, and deployment tooling live in this repository. Validation and deployment preparation are local; no network deployment is performed by the verification commands.

## Architecture

A `StellariumNode` may host resources, interpret caller requests, run a relay, or combine those roles. Relay mode shares discovery and SQLite with the node, but keeps its own signing EOA, durable queue, submission state, and stake. Execution authority, payment identity, receipt signer, and relay keys have distinct responsibilities even when an operator chooses to reuse an EOA. Applications explicitly configure the Base chain, USDC and contract addresses, and execution authority. There is no endpoint that automatically chooses payment trust settings for a caller.

Only the top-level RequestScript interpreter issues invocation grants. Each direct paid call gets a fresh grant bound to its exact arguments, function, resource, revision, price, and caller authorization. Forwarding uses that same grant. Nested Stellarium calls are unsupported, including free calls; the host invoker enforces this across asynchronous execution. Ordinary HTTP in a resource implementation remains possible. An arbitrary HTTP request from a malicious provider to another server cannot be distinguished universally from an independent caller request; signatures restrict claims to authority-issued grants, and disputed control flow is decided by arbitration.

The contracts enforce authorization and accounting, not output semantics or truthful provider timestamps. A budget bounds total spending but does not constrain a malicious execution authority to honest script control flow. Applications display the selected authority and total budget before signing and trust that authority to interpret the script correctly.

## Wire API

All `/v1/run` requests require `application/json` objects. The former raw-text format is removed.

```json
{
    "version": 1,
    "kind": "request",
    "source": "request Forecast { const weather: example.Weather return weather.forecast(city: \"Oslo\") }"
}
```

For a paid request, add `payment.authorization` and `accessProof`, both signed objects containing `domain`, `message`, and `signature`. All EIP-712 `uint64` and `uint256` message fields use unsigned decimal strings in JSON. `protocolVersion`, envelope `version`, and arbitration `round` are JSON numbers. Addresses and hashes use hexadecimal strings.

Forwarded invocations use `{version:1,kind:"invocation",resourceId,resourceKey,functionName,parameters,payment:{authorization,grant},accessProof}`. `parameters` is an array of `{name,value}`. Arguments are normalized using declared RequestScript types, then encoded as JSON without source interpolation. `int64` and decimal values travel as strings. A successful response is `{returnValue,executions}`, where each execution includes the claim, encrypted evidence ID, provider endpoint, and that invocation's return value, and a signed dispatch acknowledgement with its observed block reference. A paid top-level response also supplies an encrypted request evidence ID for the full interpreter trace. An execution failure can return previously successful executions, which remain independently payable.

Request authorization becomes public at settlement. It must not act as a credential for reading cached private results. A separate five-minute, one-use `RunAccess` signature binds the exact wire payload, destination `/v1/run` URL, and a random nonce. The caller signs top-level access; the execution authority signs forwarded access. Retries require a fresh access proof and return the saved result without executing again. These proofs are never submitted to settlement.

| Endpoint                        | Behavior                                                                           |
| ------------------------------- | ---------------------------------------------------------------------------------- |
| `GET /v1/resources`             | Public resource descriptions and signed payment manifests                          |
| `GET /v1/peers`                 | Discovery hints and the node's current signed identity, when configured            |
| `PUT /v1/peers`                 | Verify and cache a peer's own identity publication                                 |
| `GET /v1/publications`          | Signed local resource publication                                                  |
| `PUT /v1/all-resources`         | Verify publisher, endpoint ownership, and on-chain payment manifest before caching |
| `GET, PUT /v1/relays`           | Discover or verify signed relay advertisements                                     |
| `POST /v1/relay/claims`         | Durably accept an assigned relay's claim; returns 202                              |
| `GET /v1/relay/claims/:id`      | Queue and transaction status                                                       |
| `POST /v1/payments/acceptances` | Verify caller acceptance and update durable delivery                               |
| `GET /v1/evidence/:id`          | Encrypted envelope only                                                            |
| `POST /v1/evidence/:id/release` | Party-authorized encryption for a selected arbitrator                              |
| `POST /v1/evidence/deliver`     | Verify and store a party's arbitrator-encrypted evidence                           |

Peer bootstrap authenticates each discovered identity using its own signed descriptor. Nodes refresh signed local publications and relay advertisements every minute. Reputation is read from the configured registry; advertisements never substitute for on-chain eligibility. Relay selection sorts eligible available advertisements by descending reputation, ascending fee, then address. The receipt fixes the selected relay and fee.

## Quotes and durable execution

Startup compares each configured resource's price schedule, payment identity, recipient, receipt signer, encryption key, and USDC against the current registered manifest. Unchanged settings reuse the revision and quote IDs. Changed settings publish a new signed revision and retire only that resource's previous quotes before listening. Quotes have no age-based expiry. To make a formerly paid resource free, configure its prices as zero and start the node to publish the revision.

Historical revisions remain available for receipt validation, including rotated signers and recipients. A receipt executed before retirement may settle within its submission deadline. Updating a manifest is not a mechanism for cancelling already completed work. The registry's publisher can technically submit updates independently of node startup; startup reconciliation is the reference node's publication policy, rather than a provable on-chain process boundary.

SQLite stores invocation and request outcomes, encrypted evidence, relay advertisements, relay queues, and delivery attempts. Completion and its relay outbox record commit in one SQLite statement using a trigger. Duplicate grants reuse saved results. On restart, unfinished executions become `indeterminate` and are not automatically re-executed, since an external side effect may already have occurred. Keep the database and evidence private key across restarts; do not share one database between simultaneously running nodes. Legacy discovery tables are preserved and copied when their full schema is present.

A relay batches at most 100 claims, isolates individually invalid claims on-chain, follows finalized transaction status, and verifies individual claim acceptance. A known preflight failure returns the batch to the queue for retry; an ambiguous broadcast remains `submitting` rather than being automatically broadcast twice. Operators reconcile the recorded batch ID with its transaction hash using `RelayService.reconcile`. Claims cannot first be submitted more than 30 minutes after execution; the provider outbox stops retrying expired deliveries so old entries cannot starve newer claims.

## Accounting and arbitration

USDC amounts use six decimal places. Callers deposit once into the balance vault and reserve a budget per request. Caller nonces cannot be reused. Closing a request releases unused funds while preserving already locked claims. Both accepted and fallback claims have a one-hour challenge period. Transfers are pull withdrawals; finalization credits balances.

The deterministic protocol fee uses measured batch settlement gas, a governed gas overhead, capped transaction gas price, Base's L1 data-fee upper bound, and a fresh Chainlink ETH/USD value. It divides the batch estimate among valid claims, distributes rounding remainder deterministically, rejects a relay fee above gross, and caps the protocol fee at `gross - relayFee`. Provider, relay, and protocol payouts always sum to gross. Treasury accounting assigns 80% of protocol fees to operations and 20% to DAO funds.

A challenge freezes the claim immediately. Selection waits when the arbitrator pool is insufficient; anyone can call `requestPanel` after the pool recovers. The initial pool must contain 15 eligible participants after excluding the receipt's caller, provider, recipient, receipt signer, and relay so fresh 3/5/7 panels are possible. The court supports up to 256 registered arbitrator identities. Selection weights are snapshotted before Chainlink VRF v2.5 randomness is requested. Stake and keys remain locked while a draw or active panel depends on them. VRF callbacks persist randomness; permissionless `deliver` processes it and can be retried if delivery fails. The implementation has no timeout that rerolls an unfulfilled VRF request.

Each selected round gives parties 24 hours for evidence and initial fee deposits, followed by a 24-hour voting period. Missing evidence or a missing deposit causes a default loss. If both parties default, the claim refunds the caller. A provider win requires a majority of the full panel; insufficient votes refund the caller. Parties have 24 hours to appeal, with at most two appeals and no additional fee deposit. The final winner recovers its deposit, and the loser pays the arbitration fee, distributed among participating voters with remainder assigned to the reserve. If the loser refused to deposit, the operations reserve supplies the missing fee and the loser incurs debt. Debt must be cleared before opening a new paid budget or registering a paid role.

Reserve exhaustion cannot prevent a timely challenge. An obligation is recorded and default finalization waits for replenishment if the reserve cannot cover a missing deposit. Operations spending cannot consume committed reserve. Operators must fund and monitor the reserve to avoid delayed dispute finalization.

Evidence uses X25519 public keys encoded as base64 DER SPKI, private keys as base64 DER PKCS8, HKDF-SHA256, and AES-256-GCM. Each envelope has a fresh ephemeral key, salt, and IV. The provider's encrypted archive contains available source, invocation, output, signatures, manifest, a signed dispatch acknowledgement with a contemporaneous block hash and number, and dispatch/completion trace. The execution-authority node separately encrypts the full top-level interpreter trace and source. A remote provider does not receive the entire source by default; the caller can supply it during a dispute. Parties re-encrypt evidence for each panel member and commit a hash of the delivery list on-chain. Encrypted storage does not prove successful delivery or semantic correctness; arbitrators assess the evidence. Preserve evidence and keys through all challenge and appeal periods. No automatic deletion policy is enabled.

## Wallets and governance

Browser wallet support serves web callers who own USDC and must approve deposits and sign budgets and acceptance. Nodes and relays use configured EOA keys. The browser SDK accepts an application's viem wallet client backed by an EIP-1193 provider, including an injected wallet or an already connected WalletConnect session. The application owns wallet selection, pairing, network UI, and the budget approval screen. `autoAccept` defaults to true after cryptographic validation; turn it off when the application needs additional semantic validation before accepting a result. Failed automatic acceptance delivery returns the verified result with `acceptanceDeliveryError` on its execution record, leaving the provider's durable fallback claim available.

All protocol modules use UUPS proxies from the first deployment. `DeploymentFactory` creates and initializes the circular module graph atomically; a failed initializer rolls back all proxies. Implementations disable direct initialization. Owners are the timelock. Launch governance requires three distinct signatures from five steward EOAs. Steward execution may schedule timelock calls or request one emergency pause of at most 24 hours; withdrawal remains available. Ordinary timelock operations require at least 48 hours; upgrades, ownership transfer, randomness adapter replacement, and timelock-delay changes require seven days.

Sponsored identities require three distinct eligible sponsors. Each sponsor has at most three sponsorships per rolling 30 days. An explicit seed list is admitted only at initialization and seeds can sponsor during the first 30 days without prior activity. Reputation coefficients, eligibility thresholds, stakes, arbitration fees, fee overhead, and voting parameters are deployment settings. Facts come from approved settlement and arbitration reporters. Governance activation requires 100 active participants, governor proposer authority, and removal of the launch multisig's proposer and canceller roles. Active means nonzero score and a settled receipt within 90 days. Voting uses historical score checkpoints and the configured quorum.

## Local verification and deployment preparation

Run `pnpm check` with Foundry installed. Solidity compilation uses the pinned npm compiler through the included wrapper, so it does not need a downloaded native compiler. Generated ABIs match the contracts; build artifacts include storage layouts for upgrade review. `docs/protocol-vectors.json` specifies canonical hashes and EIP-712 vectors, and Solidity tests check their exact agreement with TypeScript. Canonicalization version 1 pins RequestScript 1.0.5: remove AST `line` fields, sort object keys, preserve array order, sort named parameters, reject duplicate parameters, and keccak256 UTF-8 canonical JSON. Finite safe JSON numbers are supported; bigint AST values use a `$int` tag. JSON outputs and parameters use the declared-type wire encoding before hashing.

`pnpm deploy:plan` makes no RPC requests and writes `build/deployment-plan.json`. The example includes placeholder external addresses and sample coefficients; replace them with reviewed network addresses and deployment choices. The deployment script requires explicit `--broadcast` and is restricted to Base Sepolia. No broadcast is part of the local checks. After deployment, schedule settlement/court reporter authorization through the steward multisig and timelock, authorize and fund the VRF consumer subscription, fund the reserve, sponsor participants, and register relay/arbitrator stakes. Resources publish their manifests at node startup.

For governance handover, schedule a timelock batch granting governor proposer/canceller roles, revoking both launch multisig roles, then invoking `Governor.activate`; publish that batch and its execution transaction in the deployment record. Future upgrade review must compare the emitted storage layouts and preserve namespaced OpenZeppelin storage and appended protocol storage.

The local suites use a mocked Chainlink feed, Base gas oracle, USDC, and VRF coordinator. They do not substitute for an independent contract audit or Base Sepolia integration with real infrastructure. Live deployment, network-specific verification, an independent audit, and Mainnet rollout remain outside the authorized local scope.
