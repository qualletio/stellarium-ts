# stellarium-ts

TypeScript implementation of a Stellarium node.

## What is Stellarium?

Stellarium is a decentralized API platform built on the [RequestScript](https://github.com/qualletio/requestscript-js) programming language. Users run their own node(s) and share `Resources` and `Contracts` with peers.

This package is the node. You embed it in a Fastify server, register the RequestScript resources that live on this process, and optionally bootstrap peer and resource lists from a node that is already running.

## Running a node

### Prerequisites

- Node.js 20+
- [Fastify](https://fastify.dev/) 5, which you create and pass to the node
- [RequestScript](https://www.npmjs.com/package/requestscript), which supplies the `Resource` type your node registers

Install the node and the packages your application imports directly:

```sh
npm install stellarium-ts fastify requestscript
```

### Register resources and start

A resource is a host object scripts can call. `path` and `name` form its fully qualified name (`com.example.Weather`). Each function declares RequestScript parameter and return types, and `exec` runs in this process.

Call `register` before `start`. `start` creates the SQLite database, mounts the HTTP API, and listens.

```typescript
import Fastify from "fastify";
import { StellariumNode } from "stellarium-ts";
import type { Resource } from "requestscript";

const weather: Resource = {
  metadata: {},
  path: "com.example",
  name: "Weather",
  functions: [
    {
      name: "temperature",
      parameters: [{ name: "city", type: "string" }],
      returnType: "int32",
      exec: async (args) => {
        const city = args.find((arg) => arg.name === "city")?.value;
        return city === "Oslo" ? 12 : 20;
      },
    },
  ],
};

const node = new StellariumNode();
await node.register(weather);

const fastify = Fastify({ logger: true });
await node.start(fastify, {
  port: 3000,
  // Omit this to run standalone. Set it to copy peers and resources
  // from a node that is already up.
  startingPeer: "http://127.0.0.1:3001",
});
```

`StellariumNodeOptions`:

| Option         | Default | Purpose                                                  |
| -------------- | ------- | -------------------------------------------------------- |
| `port`         | `3000`  | Port Fastify listens on                                  |
| `startingPeer` | none    | Origin of a peer to bootstrap from, with no `/v1` suffix |

Importing `StellariumNode` loads [dotenv](https://github.com/motdotla/dotenv), so a `.env` file in the working directory is applied automatically.

| Variable   | Purpose                                                                                                                                                       |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `BASE_URL` | Public URL prefix stored on resources this node hosts. Peers call `{BASE_URL}/run`. Set it to this node's API prefix, for example `http://127.0.0.1:3000/v1`. |

The node stores peers and resources it learns from other nodes in `requestscript.db` in the current working directory. That file is created on startup.

### Joining a network

When `startingPeer` is set, the node waits until it is listening, then:

1. `GET {startingPeer}/v1/peers`. If this node has no peers yet, it stores the returned list. An existing list is left as-is.
2. `GET {startingPeer}/v1/resources`. Each resource is stored with the `baseUrl` that peer advertised.

A script that names a resource registered on this process runs `exec` locally. A script that names a resource learned from a peer is forwarded: this node posts a RequestScript request to `{baseUrl}/run` and returns that peer's `returnValue`.

## HTTP API

Routes are mounted at `/v1`.

| Method and path     | Body        | Purpose                                                           |
| ------------------- | ----------- | ----------------------------------------------------------------- |
| `GET /v1/`          | —           | Liveness check. Responds `{ "hello": "world" }`                   |
| `GET /v1/peers`     | —           | Peers stored on this node: `{ "peers": [{ "baseUrl", "name" }] }` |
| `GET /v1/resources` | —           | Resources registered here and resources learned from peers        |
| `POST /v1/run`      | JSON string | Run one `request` script                                          |

`GET /v1/resources` returns each resource's `path`, `name`, `baseUrl`, and functions (`name`, `returnType`, `parameters`). Function implementations stay on the node that hosts them.

`POST /v1/run` accepts the script source as a JSON string (`Content-Type: application/json`). The declaration must be a `request`. A successful run responds `200` with `{ "returnValue": ... }`. A script that is not a request responds `400` with `{ "error": "Invalid script" }`. Any other failure responds `500` with `{ "error": "Internal server error" }`.

```sh
curl -X POST http://127.0.0.1:3000/v1/run \
  -H 'Content-Type: application/json' \
  -d '"request GetTemperature {\n  const weather: com.example.Weather\n\n  return weather.temperature(city: \"Oslo\")\n}"'
```

```json
{ "returnValue": 12 }
```

Resources are bound with `const <name>: <path>.<ResourceName>` and called with named arguments. See the [RequestScript readme](https://www.npmjs.com/package/requestscript) for the language.

## Developing

This repository uses `pnpm`.

```sh
pnpm install
pnpm build   # tsc to dist/; also runs before pack
pnpm dev     # reload src/server.ts when it changes
```

`pnpm build` emits `dist/`, which is what the package exports. Start a node from your own process with `StellariumNode`, as shown above.

### Contributing

Stellarium has a backlog [here](https://github.com/orgs/qualletio/projects/7/views/1)
