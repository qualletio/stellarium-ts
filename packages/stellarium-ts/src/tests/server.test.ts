import { afterEach, describe, expect, test, vi } from "vitest";
import { DEFAULT_COST_LIMIT_MICRO_USD, resolveConfig } from "../server.js";
import { modelResource, weatherResource } from "./helpers.js";

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
        vi.stubEnv("COST_LIMIT_MICRO_USD", "500");

        expect(resolveConfig({})).toMatchObject({ baseUrl: "http://env.example", publicKey: "env-public", privateKey: "env-private", costLimitMicroUsd: 500 });
    });

    test("defaults the cost limit", () => {
        vi.stubEnv("COST_LIMIT_MICRO_USD", undefined);

        expect(resolveConfig(keys).costLimitMicroUsd).toBe(DEFAULT_COST_LIMIT_MICRO_USD);
    });

    test.each([-1, 1.5, Number.NaN])("rejects a cost limit of %s", (costLimitMicroUsd) => {
        expect(() => resolveConfig({ ...keys, costLimitMicroUsd })).toThrow("costLimitMicroUsd");
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

    test("defaults the inference cost limit to the cost limit, and reads its own option or environment variable", () => {
        vi.stubEnv("INFERENCE_COST_LIMIT_MICRO_USD", undefined);
        expect(resolveConfig({ ...keys, costLimitMicroUsd: 700 }).inferenceCostLimitMicroUsd).toBe(700);

        vi.stubEnv("INFERENCE_COST_LIMIT_MICRO_USD", "900");
        expect(resolveConfig({ ...keys, costLimitMicroUsd: 700 }).inferenceCostLimitMicroUsd).toBe(900);
        expect(resolveConfig({ ...keys, inferenceCostLimitMicroUsd: 1_000 }).inferenceCostLimitMicroUsd).toBe(1_000);
        expect(() => resolveConfig({ ...keys, inferenceCostLimitMicroUsd: -1 })).toThrow("inferenceCostLimitMicroUsd");
    });

    test("accepts well-declared inference functions", () => {
        expect(() => resolveConfig({ ...keys, operatorUrl: "http://operator.example" }, [modelResource()])).not.toThrow();
    });

    test.each([
        ["without a maxTokens parameter", { parameters: [{ name: "prompt", type: "string" }] }, "maxTokens: int32"],
        ["whose maxTokens isn't an int32", { parameters: [{ name: "maxTokens", type: "int64" }] }, "maxTokens: int32"],
        ["that is paid but has no estimator", { estimateInputTokens: undefined }, "estimateInputTokens"],
        ["priced with a flat cost", { paymentManifest: { costMicroUsd: 5, recipientOrganizationId: "r" } }, "per million tokens"],
        ["with a negative rate", { paymentManifest: { inputCostMicroUsdPerMillionTokens: -1, outputCostMicroUsdPerMillionTokens: 0, recipientOrganizationId: "r" } }, "per million tokens"],
    ])("rejects an inference function %s", (_, overrides, message) => {
        const model = modelResource();
        model.functions = [{ ...model.functions[0]!, ...overrides }];

        expect(() => resolveConfig({ ...keys, operatorUrl: "http://operator.example" }, [model])).toThrow(message);
    });

    test("rejects per-token pricing on a function not declared as inference", () => {
        const model = modelResource();
        model.functions = [{ ...model.functions[0]!, kind: undefined }];

        expect(() => resolveConfig({ ...keys, operatorUrl: "http://operator.example" }, [model])).toThrow("kind 'inference'");
    });
});
