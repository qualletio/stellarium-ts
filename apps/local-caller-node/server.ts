import Fastify from "fastify";
import { StellariumNode } from "stellarium-ts";

const node = new StellariumNode();

const fastify = Fastify({ logger: true });
await node.start(fastify, {
  port: process.env.PORT ? parseInt(process.env.PORT) : 3001,
  // Omit this to run standalone. Set it to copy peers and resources
  // from a node that is already up.
  startingPeer: process.env.STARTING_PEER ?? "http://127.0.0.1:3002",
});
