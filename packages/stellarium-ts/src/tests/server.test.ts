import { afterEach, describe, expect, test, vi } from "vitest";
import { DEFAULT_COST_LIMIT_MICRO_USDC, resolveConfig } from "../server.js";
import { weatherResource } from "./helpers.js";

describe("resolveConfig", () => {
    const keys = { baseUrl: "http://node.example", publicKey: "public", privateKey: "private" };

    afterEach(() => {
        vi.unstubAllEnvs();
    });

    test("prefers options over the environment", () => {
        vi.stubEnv("BASE_URL", "http://env.example");
        vi.stubEnv("API_KEY", "env-key");

        expect(resolveConfig({ ...keys, apiKey: "option-key" })).toMatchObject({ baseUrl: keys.baseUrl, apiKey: "option-key" });
    });

    test("falls back to the environment", () => {
        vi.stubEnv("BASE_URL", "http://env.example");
        vi.stubEnv("SIGNING_PUBLIC_KEY", "env-public");
        vi.stubEnv("SIGNING_PRIVATE_KEY", "env-private");
        vi.stubEnv("COST_LIMIT_MICRO_USDC", "500");

        expect(resolveConfig({})).toMatchObject({ baseUrl: "http://env.example", publicKey: "env-public", privateKey: "env-private", costLimitMicroUsdc: 500 });
    });

    test("defaults the cost limit", () => {
        vi.stubEnv("COST_LIMIT_MICRO_USDC", undefined);

        expect(resolveConfig(keys).costLimitMicroUsdc).toBe(DEFAULT_COST_LIMIT_MICRO_USDC);
    });

    test.each([-1, 1.5, Number.NaN])("rejects a cost limit of %s", (costLimitMicroUsdc) => {
        expect(() => resolveConfig({ ...keys, costLimitMicroUsdc })).toThrow("costLimitMicroUsdc");
    });

    test("requires the signing keys and base URL", () => {
        vi.stubEnv("SIGNING_PRIVATE_KEY", undefined);

        expect(() => resolveConfig({ baseUrl: keys.baseUrl, publicKey: keys.publicKey })).toThrow("SIGNING_PRIVATE_KEY is required");
    });

    test("requires an operator URL only when hosting paid functions", () => {
        vi.stubEnv("OPERATOR_URL", undefined);

        expect(resolveConfig(keys, []).operatorUrl).toBeUndefined();
        expect(() => resolveConfig(keys, [weatherResource()])).toThrow("OPERATOR_URL is required");
    });
});
