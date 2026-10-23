import { generateKeyPairSync } from "node:crypto";
import type { StellariumResource } from "../resource/repository.js";
import type { NodeConfig } from "../service.js";

export function generateBase64KeyPair() {
    const { publicKey, privateKey } = generateKeyPairSync("ed25519", {
        publicKeyEncoding: { type: "spki", format: "der" },
        privateKeyEncoding: { type: "pkcs8", format: "der" },
    });
    return {
        publicKey: publicKey.toString("base64url"),
        privateKey: privateKey.toString("base64url"),
    };
}

/** The operator organization the fixture provider is enrolled in. */
export const ORGANIZATION = "org_provider";
export const COST = 10000;

export function testConfig(overrides: Partial<NodeConfig> = {}): NodeConfig {
    return {
        baseUrl: "http://127.0.0.1:3002",
        ...generateBase64KeyPair(),
        apiKey: "secret",
        operatorUrl: "http://operator.invalid/v1",
        organizationId: ORGANIZATION,
        costLimitMicroUsd: 100_000,
        inferenceCostLimitMicroUsd: 100_000,
        ...overrides,
    };
}

/** The fixture provider's resource: paid `temperature` and free `humidity`. */
export function weatherResource(baseUrl = "http://127.0.0.1:3002"): StellariumResource {
    return {
        id: 1,
        baseUrl,
        metadata: {},
        path: "com.example",
        name: "Weather",
        functions: [
            {
                name: "temperature",
                parameters: [{ name: "city", type: "string" }],
                returnType: "int32",
                exec: async (args) => (args.find((arg) => arg.name === "city")?.value === "Oslo" ? 12 : 20),
                paymentManifest: { costMicroUsd: COST },
            },
            {
                name: "humidity",
                parameters: [{ name: "city", type: "string" }],
                returnType: "int32",
                exec: async () => 80,
            },
        ],
    };
}

export const INFERENCE_RATES = { inputCostMicroUsdPerMillionTokens: 3_000_000, outputCostMicroUsdPerMillionTokens: 15_000_000 };

/**
 * A fixture provider's model: paid inference `complete`, which counts one token per four prompt characters
 * and answers with `maxTokens` tokens, a restricted paid copy `completePrivate`, and free inference `draft`.
 */
export function modelResource(baseUrl = "http://127.0.0.1:3002"): StellariumResource {
    const prompt = (args: { name: string, value: unknown }[]) => String(args.find((arg) => arg.name === "prompt")?.value ?? "");
    const complete = {
        name: "complete",
        kind: "inference" as const,
        parameters: [{ name: "prompt", type: "string" }, { name: "maxTokens", type: "int32" }],
        returnType: "string",
        estimateInputTokens: async (args: { name: string, value: unknown }[]) => Math.ceil(prompt(args).length / 4),
        exec: async (args: { name: string, value: unknown }[]) => ({
            value: `echo: ${prompt(args)}`,
            usage: { inputTokens: Math.ceil(prompt(args).length / 4), outputTokens: Number(args.find((arg) => arg.name === "maxTokens")?.value) },
        }),
        paymentManifest: { ...INFERENCE_RATES },
    };
    return {
        id: 2,
        baseUrl,
        metadata: {},
        path: "com.example",
        name: "Model",
        functions: [
            complete,
            { ...complete, name: "completePrivate", restricted: true },
            { ...complete, name: "draft", paymentManifest: undefined, estimateInputTokens: undefined },
        ],
    };
}

export const temperatureSource = 'request GetTemperature {\n  const weather: com.example.Weather\n\n  return weather.temperature(city: "Oslo")\n}';
