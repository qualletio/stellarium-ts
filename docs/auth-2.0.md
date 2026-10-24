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
