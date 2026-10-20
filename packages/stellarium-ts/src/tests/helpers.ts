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

export const RECIPIENT = "4HkmXgXCJ8tw1ih5VFHetRt4kWdo1VLBVmV7B5p6ctK2";
export const COST = 10000;

export function testConfig(overrides: Partial<NodeConfig> = {}): NodeConfig {
    return {
        baseUrl: "http://127.0.0.1:3002",
        ...generateBase64KeyPair(),
        apiKey: "secret",
        operatorUrl: "http://operator.invalid/v1",
        costLimitMicroUsdc: 100_000,
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
                paymentManifest: { costMicroUsdc: COST, recipientAddress: RECIPIENT },
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

export const temperatureSource = 'request GetTemperature {\n  const weather: com.example.Weather\n\n  return weather.temperature(city: "Oslo")\n}';
