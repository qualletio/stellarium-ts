import Fastify from "fastify";
import { StellariumNode } from "stellarium-ts";
import type { StellariumResource } from "stellarium-ts";

const port = process.env.PORT ? parseInt(process.env.PORT) : 3002;

const weather: StellariumResource = {
  id: 1,
  baseUrl: process.env.BASE_URL ?? `http://127.0.0.1:${port}`,
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
      paymentManifest: {
        costMicroUsdc: 10000,
        recipientAddress: process.env.RECIPIENT_ADDRESS ?? process.env.RECEIPIENT_ADDRESS!,
      },
    },
  ],
};

const node = new StellariumNode();
await node.register(weather);

const fastify = Fastify({ logger: true });
await node.start(fastify, {
  port,
});
