# Events

Events let RequestScript contracts react to each other. An organization declares an **event type** on one of its nodes. Its scripts `emit` events of that type, and **event contracts**, deployed by anyone on any node, run with each event they consume.

- Only the organization that owns an event type may emit it, and only from scripts running on its own nodes.
- Anyone may consume an event type, unless it is `restricted`. A restricted event type is consumed only by contracts its owner deployed.
- Event contracts are paid for by whoever deployed them.

Events need RequestScript 1.6.0, which adds event declarations, `consumes` and `emit`.

## Declaring an event type

An event type is a script of its own. It declares the fields its events carry, and has no body:

```
event com.example.OrderPlaced@1(orderId: string, total: decimal)
restricted event com.example.AuditEntry(entry: object)
```

Names, paths and versions work as they do for contracts. Fields are `name: type` pairs, and a type without fields omits the parentheses. Versions are immutable.

Declare it on a node of your organization:

```sh
curl -X POST $NODE/v1/events -H "Authorization: Bearer $API_KEY" \
  -d '{"source": "event com.example.OrderPlaced(orderId: string, total: decimal)"}'
```

The node's API key or a run token from an API client of the node's own organization may declare one, and the node's organization owns it. A client of another organization is refused, because an event type belongs to the organization whose nodes may emit it. `GET /v1/events` lists the event types a node knows: its own, then those it learned from peers. `DELETE /v1/events/path.Name[@version]` deletes them.

## Emitting events

A request or a contract emits an event with `emit`, naming every field:

```
contract com.example.Checkout(orderId: string, total: decimal): string {
    emit com.example.OrderPlaced(orderId: orderId, total: total)
    return orderId
}
```

- Each field is converted to its declared type. A missing or unknown field is a runtime error.
- A run publishes its events only if it succeeds, just as a contract saves its state only when it succeeds. A run that fails publishes nothing.
- A script may emit an event type only when three things hold:
  - its organization owns the type;
  - the script belongs to that organization: a run with the node's API key or by one of its API clients, or a contract it owns;
  - the node can prove its organization with the operator's membership token.

  Other organizations still get to emit through your contracts: anyone may call your `Checkout`, which emits as your organization.
- A run may emit at most 16 events (`MAX_EVENTS_PER_RUN`), each with at most 32 KiB of data as JSON (`MAX_EVENT_DATA_BYTES`).

## Consuming events

An event contract names the event type it `consumes`. It declares no parameters, because the event's fields are its parameters, and no return type. It can't return a value; a bare `return` ends it.

```
contract com.example.OnOrderPlaced consumes com.example.OrderPlaced@1 {
    var state(orderId) seen: int32 = 0
    seen = seen + 1

    const logger: com.example.Logger
    logger.info(message: "Order ${orderId}: ${total}, from ${caller.org}")
}
```

- **Version:** the contract consumes the version it names, or the latest one its node knows when it is deployed.
- **Restricted types:** the contract is refused if the type is restricted and its deployer isn't the type's owner.
- **Built-ins:** besides its fields, the contract reads:
  - `event`: `{ id, type, version, publishedAt, depth }`
  - `caller`: `{ org, node }`, the event's owner and the node that published it
- **Not a resource:** an event contract runs only with events, so nobody can call it with made-up data. A contract keeps its kind across versions: an event contract can't get a callable version, or the other way around.
- **State:** event contracts may keep state like any contract.

## How events travel

1. **Announcing.** Each node announces its event types and event contracts to its peers. It signs the announcement with its key and attaches its membership token (`PUT /v1/all-events`). It announces again whenever one of them is deployed or deleted. A starting node fetches every peer's announcement from `GET /v1/events/announcement`.
   - A peer learns an event type only if the token says the announcing node belongs to the type's owner.
   - The first node to declare a path keeps it.
2. **Publishing.** When a run succeeds, the publishing node signs each event and queues it:
   - for its own event contracts;
   - once for each peer with event contracts subscribed to it.

   Restricted events go only to contracts deployed by their owner.
3. **Delivering.** A worker POSTs each queued event to `{peer}/v1/events/deliver`. It retries with exponential backoff, from 30 seconds up to an hour, until the peer accepts the event or the event is a day old. It gives up at once on a 400, 401, 403 or 413.
4. **Receiving.** The receiving node checks the event before queuing it:
   - the signature, by the publisher's key;
   - the membership token, which must say the publisher belongs to the event's owner, as of the time the event was published;
   - that the event was published within the last day and is at most 4 deep;
   - that the event type is one the node knows, with that owner.

   It then queues the event once per local event contract (`event_inbox`, keyed by event id) and answers 202.
5. **Running.** A worker runs each queued event contract:
   - It retries a failure up to 3 times in all, with backoff.
   - If the operator refuses for the balance or is unavailable, it retries. A revoked mandate isn't retried.

Delivery is at least once, and each event contract runs once per event id. Events may arrive in any order. Admins can follow deliveries at `GET /v1/admin/events/outbox` and runs at `GET /v1/admin/events/inbox`, each with `?status=failed` and so on. Settled rows are kept for three days.

## Who pays

- **Emitting** costs only the publishing run's tokens.
- **Free event contracts:** one deployed with the node's API key, or by the node's own organization, runs free.
- **Mandates:** when another organization's API client deploys an event contract, the node asks the operator for an **event mandate** with the client's run token (`POST /v1/runs/event/mandates`). Before each event, the node asks the operator to hold a run under that mandate (`POST /v1/runs/event/authorize`). The operator holds it and charges it like the client's own runs: at most the client's maximum run cost, within its monthly cap, at the node's listed price per million tokens.
- **Stopping the charges:** the organization sees its mandates under **API clients** on the dashboard (`GET /v1/org/event-mandates`). It stops one by revoking the mandate (`DELETE /v1/org/event-mandates/:id`) or the API client. Deploying the contract again renews the mandate.

Publishers never pay for consumers, so anyone may subscribe without costing the publisher.

## Chains

An event contract may emit events of its own, and each event carries its chain (`lineage`): the event types before it and the contracts that emitted or consumed them.

- **Depth:** chains are at most 4 events deep (`MAX_EVENT_DEPTH`).
- **No repeated types:** a contract can't emit an event type that is already in its chain.
- **No calls back into the chain:** a contract can't call a contract that is already in the chain, on its own node or another. Remote contract calls carry the chain in `eventLineage`.
- **No self-consumption:** an event contract can't emit the type it consumes. This is refused when it is deployed.

For example, contract A emits Event1, and event contract B consumes Event1. B can't emit Event1. If B emits Event2, event contract C may consume it, but C can't emit Event1 or Event2, or call A or B.

## Trust

- **Membership tokens.** In the session it gives a node, the operator includes a membership token: an EdDSA JWT with `aud: "stellarium:membership"`, `sub` set to the node's key, `org` its organization and `use: "membership"`. It is signed with the run token key and lasts an hour, and the node refreshes it with its session every five minutes. Its audience can never be a node key, so it can't pass as a run token, and a run token can't pass as one.
- **What receivers trust.** They trust the operator for which organization a node belongs to, and the publisher's key for the event. They don't have to trust the publisher's claims.
- **Removed nodes.** A node removed from its organization can keep publishing on its last token until the token expires. It could also backdate events into that token's validity window, up to the one-day age limit.
- **What publishers trust.** A publisher trusts the consumer node's announcement of who deployed each event contract. That claim decides whether the node gets restricted events.
- **Event chains.** The chain is signed by each publisher, but a node could start a fresh chain. Billing is the backstop: the owner of every event contract in a loop pays for each of its runs.
