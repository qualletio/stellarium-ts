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
        costMicroUsd: 10000,
      },
    },
  ],
};

const prompt = (args: { name: string; value: unknown }[]) => String(args.find((arg) => arg.name === "prompt")?.value ?? "");
// A stand-in for a model: about four characters per token, as a real estimator might count.
const countTokens = (text: string) => Math.ceil(text.length / 4);

const echo: StellariumResource = {
  id: 2,
  baseUrl: process.env.BASE_URL ?? `http://127.0.0.1:${port}`,
  metadata: {},
  path: "com.example",
  name: "Echo",
  functions: [
    {
      name: "complete",
      kind: "inference",
      parameters: [{ name: "prompt", type: "string" }, { name: "maxTokens", type: "int32" }],
      returnType: "string",
      estimateInputTokens: async (args) => countTokens(prompt(args)),
      exec: async (args) => {
        const maxTokens = Number(args.find((arg) => arg.name === "maxTokens")?.value);
        const value = `echo: ${prompt(args)}`.slice(0, maxTokens * 4);
        return { value, usage: { inputTokens: countTokens(prompt(args)), outputTokens: countTokens(value) } };
      },
      paymentManifest: {
        inputCostMicroUsdPerMillionTokens: 3_000_000,
        outputCostMicroUsdPerMillionTokens: 15_000_000,
      },
    },
  ],
};

const node = new StellariumNode();
await node.register(weather);
await node.register(echo);

const fastify = Fastify({ logger: true });
await node.start(fastify, {
  port,
});
