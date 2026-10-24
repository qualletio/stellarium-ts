# Auth 2.0

Today, running a requestscript script requires running a node, or knowing the secret API_KEY for a node.

However, this should change.

## New Direction

Node providers bind their own api client ids and secrets to specific nodes in their organization.

Node providers can list any of their nodes on the platform dashboard with a token price or free.

The token price is the fee per requestscript script token (tokens are derived by the requestscript interpreter. The user only pays for tokens their code executed--for example, they would not pay for the else branch of an if statement if the if branch was accepted.) in micro USD.

Any user can generate API client id and secret by binding to a specific listed node.
A user can have any number of client ids and secrets at any number of nodes.

Just like today, users have to pre-charge a balance on their account. The operator pays the node that was used for the request if a price was specified by the node.

Auth takes the form of JWTs. Users first `/auth/token` with the operator to get a JWT. The node they call verifies the JWT.

## As built

Shipped in requestscript 1.2.0 (qualletio/requestscript-js#5), stellarium-ts #61 and #62, and stellarium-explorer #8 (v0.1.6). Where it differs from the direction above, the decisions were:

- **Clients belong to organizations**, not users, because balances are per organization. Owners and admins create them, change their limits and revoke them on the dashboard's API clients page. A client is bound to one node: one of the organization's own nodes, which run free, or another organization's listed node.
- **Tokens come from `POST /v1/oauth/token`**, the OAuth 2.0 client credentials grant, because Better Auth already serves `/v1/auth/*`. They are EdDSA JWTs signed with `RUN_TOKEN_PRIVATE_KEY`, last 15 minutes, and name the node's public key as `aud`, so no other node accepts them. Nodes verify them against `/v1/.well-known/jwks.json`. There are no refresh tokens: clients exchange their credentials again.
- **Prices are micro-USD per million script tokens**, like inference rates. A run is charged `ceil(tokens × price / 1,000,000)`.
- **Executed tokens** are lexer tokens of the statements and expressions that ran: conditions evaluated and the branch taken, not operands a short circuit skips. The declaration is free. Because scripts have no loops, the most a script can execute is known up front, and the operator computes it from the source itself, so a node can't charge for more.
- **A run holds up to the client's maximum per run** (default $1), less if the balance or monthly cap leaves less. The script's paid calls, remote or to the node's own paid functions, carry the run's id and draw on that hold at their manifest prices. After the script, the node captures the tokens it executed.
- **`API_KEY` stays** for `/v1/admin` and as a free path on `/v1/run`.
- **Listing** needs the node's URL, which it reports in its operator session. The operator lists it only if `{baseUrl}/v1/self` answers with the node's key.

The full design is on [API clients and listings](https://docs.stellarium.sh/concepts/api-clients) and [Token metering](https://requestscript.mintlify.app/reference/token-metering).
