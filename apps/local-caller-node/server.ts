import Fastify from "fastify";
import { StellariumNode } from "stellarium-ts";

const node = new StellariumNode();

const fastify = Fastify({ logger: true });
await node.start(fastify, {
  port: process.env.PORT ? parseInt(process.env.PORT) : 3003,
  startingPeer: process.env.STARTING_PEER ?? "http://localhost:3002",
});
