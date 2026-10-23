import { generateKeyPairSync } from "node:crypto";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { verifyData } from "../../crypto/utils.js";
import { CombinationResourceInvoker, EXTERNAL_INVOKE_MAX_RETRIES, inferenceVoucherPayload, invocationHash, paymentVoucherPayload } from "../../resource/invoker.js";
import { inferenceCharge } from "../../resource/inference.js";
import type { ResourceRepository } from "../../resource/repository.js";
import type { Resource } from "requestscript";
import type { Grant, InvocationAuthorization } from "../../grant/grant.js";
import type { GrantService } from "../../grant/service.js";

function generateBase64KeyPair() {
    const { publicKey, privateKey } = generateKeyPairSync("ed25519", {
        publicKeyEncoding: { type: "spki", format: "der" },
        privateKeyEncoding: { type: "pkcs8", format: "der" },
    });
    return {
        publicKey: publicKey.toString("base64url"),
        privateKey: privateKey.toString("base64url"),
    };
}

describe("payment voucher", () => {
    test("signs the voucher fields, binding the call through invocationHash", () => {
        const { publicKey, privateKey } = generateBase64KeyPair();
        const invoker = new CombinationResourceInvoker({} as ResourceRepository, 100_000, publicKey, privateKey);
        const parameters = [{ name: "city", value: "Oslo" }];
        const voucher = invoker.createPaymentVoucher(
            "org_provider",
            10000,
            "com.example",
            "Weather",
            "forecast",
            parameters,
        );

        expect(voucher.invocationHash).toBe(invocationHash("com.example", "Weather", "forecast", parameters));
        expect(verifyData(paymentVoucherPayload(voucher), voucher.publicKey, voucher.signature)).toBe(true);
        expect(verifyData(voucher, voucher.publicKey, voucher.signature)).toBe(false);
    });

    test("invocationHash changes with the function name or parameters", () => {
        const parameters = [{ name: "city", value: "Oslo" }];
        const hash = invocationHash("com.example", "Weather", "forecast", parameters);

        expect(invocationHash("com.example", "Weather", "history", parameters)).not.toBe(hash);
        expect(invocationHash("com.example", "Weather", "forecast", [{ name: "city", value: "Bergen" }])).not.toBe(hash);
    });
});

describe("external invoke retries", () => {
    const resource = { path: "com.example", name: "Weather", metadata: { baseUrl: "https://remote.example" }, functions: [] } as unknown as Resource;
    const parameters = [{ name: "city", value: "Oslo" }];

    function createInvoker(paymentManifest?: { costMicroUsd: number; recipientOrganizationId?: string }) {
        const { publicKey, privateKey } = generateBase64KeyPair();
        const repository = { getResourceFunction: async () => ({ paymentManifest }) } as unknown as ResourceRepository;
        return new CombinationResourceInvoker(repository, 100_000, publicKey, privateKey);
    }

    const ok = () => new Response(JSON.stringify({ value: 42, error: null }), { status: 200 });
    const status = (code: number) => new Response(null, { status: code });

    let fetchMock: ReturnType<typeof vi.fn>;
    beforeEach(() => {
        vi.useFakeTimers();
        fetchMock = vi.fn();
        vi.stubGlobal("fetch", fetchMock);
    });
    afterEach(() => {
        vi.useRealTimers();
        vi.unstubAllGlobals();
    });

    test("retries 5xx and network errors with exponential backoff, then succeeds", async () => {
        fetchMock
            .mockResolvedValueOnce(status(503))
            .mockRejectedValueOnce(new TypeError("fetch failed"))
            .mockResolvedValueOnce(status(500))
            .mockResolvedValueOnce(ok());

        const pending = createInvoker().invoke(resource, "forecast", parameters);

        await vi.advanceTimersByTimeAsync(0);
        expect(fetchMock).toHaveBeenCalledTimes(1);
        await vi.advanceTimersByTimeAsync(500);
        expect(fetchMock).toHaveBeenCalledTimes(2);
        await vi.advanceTimersByTimeAsync(999);
        expect(fetchMock).toHaveBeenCalledTimes(2);
        await vi.advanceTimersByTimeAsync(1);
        expect(fetchMock).toHaveBeenCalledTimes(3);
        await vi.advanceTimersByTimeAsync(2000);
        expect(fetchMock).toHaveBeenCalledTimes(4);

        await expect(pending).resolves.toEqual({ value: 42, error: null });
    });

    test("does not retry 4xx responses other than 429", async () => {
        fetchMock.mockResolvedValue(status(400));

        const result = await createInvoker().invoke(resource, "forecast", parameters);

        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(result.error).not.toBeNull();
    });

    test("gives up after the maximum number of retries", async () => {
        fetchMock.mockResolvedValue(status(502));

        const pending = createInvoker().invoke(resource, "forecast", parameters);
        await vi.runAllTimersAsync();
        const result = await pending;

        expect(fetchMock).toHaveBeenCalledTimes(1 + EXTERNAL_INVOKE_MAX_RETRIES);
        expect(result.value).toBeNull();
        expect(result.error).not.toBeNull();
    });

    test("rethrows the last network error once retries are exhausted", async () => {
        fetchMock.mockRejectedValue(new TypeError("fetch failed"));

        const pending = createInvoker().invoke(resource, "forecast", parameters);
        const assertion = expect(pending).rejects.toThrow("fetch failed");
        await vi.runAllTimersAsync();
        await assertion;

        expect(fetchMock).toHaveBeenCalledTimes(1 + EXTERNAL_INVOKE_MAX_RETRIES);
    });

    test("reuses the same payment voucher on every attempt", async () => {
        fetchMock.mockResolvedValueOnce(status(503)).mockResolvedValueOnce(status(503)).mockResolvedValueOnce(ok());

        const invoker = createInvoker({ costMicroUsd: 10000, recipientOrganizationId: "org_provider" });
        const pending = invoker.invoke(resource, "forecast", parameters);
        await vi.runAllTimersAsync();
        await pending;

        const bodies = fetchMock.mock.calls.map(([, init]) => init.body);
        expect(bodies).toHaveLength(3);
        expect(new Set(bodies).size).toBe(1);
        expect(JSON.parse(bodies[0]).paymentVoucher.requestId).toBeDefined();
        expect(JSON.parse(bodies[0]).paymentVoucher.invocationHash).toBe(invocationHash("com.example", "Weather", "forecast", parameters));
    });

    test("refuses a paid function whose manifest names no recipient organization, without signing a voucher", async () => {
        const result = await createInvoker({ costMicroUsd: 10000 }).invoke(resource, "forecast", parameters);

        expect(fetchMock).not.toHaveBeenCalled();
        expect(result.error?.message).toContain("names no recipient organization");
    });
});

describe("restricted functions", () => {
    const resource = { path: "com.example", name: "Weather", metadata: { baseUrl: "https://remote.example" }, functions: [] } as unknown as Resource;
    const parameters = [{ name: "city", value: "Oslo" }];
    const chain = [{ id: "grant" }] as unknown as Grant[];

    function createInvoker(grantService: Partial<GrantService> | undefined, paymentManifest?: { costMicroUsd: number; recipientOrganizationId: string }) {
        const { publicKey, privateKey } = generateBase64KeyPair();
        const repository = { getResourceFunction: async () => ({ restricted: true, paymentManifest }) } as unknown as ResourceRepository;
        return new CombinationResourceInvoker(repository, 100_000, publicKey, privateKey, grantService as GrantService | undefined);
    }

    let fetchMock: ReturnType<typeof vi.fn>;
    beforeEach(() => {
        vi.useFakeTimers();
        fetchMock = vi.fn();
        vi.stubGlobal("fetch", fetchMock);
    });
    afterEach(() => {
        vi.useRealTimers();
        vi.unstubAllGlobals();
    });

    test("fails without a network call when no held grant covers the call", async () => {
        const chainFor = vi.fn(async () => undefined);

        const result = await createInvoker({ chainFor }).invoke(resource, "forecast", parameters);

        expect(chainFor).toHaveBeenCalledWith("https://remote.example", { resourcePath: "com.example", resourceName: "Weather", functionName: "forecast", parameters });
        expect(result).toEqual({ value: null, error: { message: expect.stringContaining("requires a grant from https://remote.example") } });
        expect(fetchMock).not.toHaveBeenCalled();
    });

    test("fails without a network call when the node has no grant service", async () => {
        const result = await createInvoker(undefined).invoke(resource, "forecast", parameters);

        expect(result.error).not.toBeNull();
        expect(fetchMock).not.toHaveBeenCalled();
    });

    test("signs a new authorization per attempt and keeps the voucher", async () => {
        fetchMock.mockResolvedValueOnce(new Response(null, { status: 503 })).mockResolvedValueOnce(new Response(JSON.stringify({ value: 42, error: null }), { status: 200 }));
        let nonce = 0;
        const authorize = vi.fn(() => ({ nonce: `nonce-${nonce++}` }) as unknown as InvocationAuthorization);

        const invoker = createInvoker({ chainFor: async () => chain, authorize }, { costMicroUsd: 10000, recipientOrganizationId: "org_provider" });
        const pending = invoker.invoke(resource, "forecast", parameters);
        await vi.runAllTimersAsync();

        await expect(pending).resolves.toEqual({ value: 42, error: null });
        const bodies = fetchMock.mock.calls.map(([, init]) => JSON.parse(init.body));
        expect(bodies.map(body => body.authorization.nonce)).toEqual(["nonce-0", "nonce-1"]);
        expect(bodies[0].paymentVoucher).toEqual(bodies[1].paymentVoucher);
        expect(authorize).toHaveBeenCalledWith(chain, { resourcePath: "com.example", resourceName: "Weather", functionName: "forecast", parameters });
    });
});

describe("inference functions", () => {
    const ORGANIZATION = "org_provider";
    const resource = { path: "com.example", name: "Model", metadata: { baseUrl: "https://remote.example" }, functions: [] } as unknown as Resource;
    const parameters = [{ name: "prompt", value: "Hello" }, { name: "maxTokens", value: 1000 }];
    const manifest = { inputCostMicroUsdPerMillionTokens: 3_000_000, outputCostMicroUsdPerMillionTokens: 15_000_000, recipientOrganizationId: ORGANIZATION };
    // 2,000 input tokens and 1,000 output tokens: 6,000 + 15,000.
    const MAX_AMOUNT = 21_000;

    function createInvoker(inferenceCostLimit = 100_000, fn: Record<string, unknown> = { kind: "inference", paymentManifest: manifest }) {
        const { publicKey, privateKey } = generateBase64KeyPair();
        const repository = { getResourceFunction: async () => fn } as unknown as ResourceRepository;
        return { invoker: new CombinationResourceInvoker(repository, 100_000, publicKey, privateKey, undefined, inferenceCostLimit), publicKey };
    }

    const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

    let fetchMock: ReturnType<typeof vi.fn>;
    beforeEach(() => {
        fetchMock = vi.fn();
        vi.stubGlobal("fetch", fetchMock);
    });
    afterEach(() => {
        vi.unstubAllGlobals();
    });

    test("inferenceCharge rounds up per million tokens", () => {
        expect(inferenceCharge(manifest, 2_000, 1_000)).toBe(21_000);
        expect(inferenceCharge({ inputCostMicroUsdPerMillionTokens: 150_000, outputCostMicroUsdPerMillionTokens: 0 }, 1, 1_000_000)).toBe(1);
        expect(inferenceCharge({ inputCostMicroUsdPerMillionTokens: 0, outputCostMicroUsdPerMillionTokens: 0 }, 5, 5)).toBe(0);
        expect(() => inferenceCharge({ inputCostMicroUsdPerMillionTokens: Number.MAX_SAFE_INTEGER, outputCostMicroUsdPerMillionTokens: 0 }, Number.MAX_SAFE_INTEGER, 0)).toThrow();
    });

    test("asks the provider for an estimate, then signs a voucher for its maxAmount at the advertised rates", async () => {
        fetchMock.mockResolvedValueOnce(json({ inputTokens: 2_000, maxAmount: MAX_AMOUNT })).mockResolvedValueOnce(json({ value: "Hi", error: null, usage: { inputTokens: 1_500, outputTokens: 10 } }));
        const { invoker, publicKey } = createInvoker();

        const result = await invoker.invoke(resource, "complete", parameters);

        expect(result).toEqual({ value: "Hi", error: null });
        const [[estimateUrl, estimateInit], [runUrl, runInit]] = fetchMock.mock.calls;
        expect(estimateUrl).toBe("https://remote.example/v1/run/resource/estimate");
        expect(JSON.parse(estimateInit.body)).toEqual({ resourcePath: "com.example", resourceName: "Model", functionName: "complete", parameters });
        expect(runUrl).toBe("https://remote.example/v1/run/resource");
        const voucher = JSON.parse(runInit.body).paymentVoucher;
        expect(voucher).toMatchObject({ kind: "inference", maxAmount: MAX_AMOUNT, maxTokens: 1000, ...manifest, publicKey });
        expect(voucher.amount).toBeUndefined();
        expect(Object.keys(inferenceVoucherPayload(voucher))).toEqual(["kind", "requestId", "invocationId", "maxAmount", "inputCostMicroUsdPerMillionTokens", "outputCostMicroUsdPerMillionTokens", "maxTokens", "recipientOrganizationId", "expiresAt", "invocationHash", "publicKey"]);
        expect(verifyData(inferenceVoucherPayload(voucher), publicKey, voucher.signature)).toBe(true);
        expect(Date.parse(voucher.expiresAt) - Date.now()).toBeGreaterThan(1000 * 60 * 5);
    });

    test("refuses an estimate whose maxAmount doesn't follow from the advertised rates", async () => {
        fetchMock.mockResolvedValueOnce(json({ inputTokens: 2_000, maxAmount: MAX_AMOUNT + 1 }));

        const result = await createInvoker().invoker.invoke(resource, "complete", parameters);

        expect(result.error?.message).toContain("doesn't match its advertised rates");
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    test("refuses a maxAmount above the inference cost limit before signing", async () => {
        fetchMock.mockResolvedValueOnce(json({ inputTokens: 2_000, maxAmount: MAX_AMOUNT }));

        await expect(createInvoker(MAX_AMOUNT - 1).invoker.invoke(resource, "complete", parameters)).rejects.toThrow("inference cost limit");
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    test("fails before any network call without a positive int32 maxTokens", async () => {
        const { invoker } = createInvoker();

        for (const value of [undefined, 0, -1, 1.5, "10", 2 ** 31]) {
            const call = value === undefined ? [parameters[0]!] : [parameters[0]!, { name: "maxTokens", value }];
            const result = await invoker.invoke(resource, "complete", call);
            expect(result.error?.message).toContain("maxTokens");
        }
        expect(fetchMock).not.toHaveBeenCalled();
    });

    test("surfaces a failed estimate without signing a voucher", async () => {
        fetchMock.mockResolvedValueOnce(json({ error: "Function is not a paid inference function" }, 400));

        const result = await createInvoker().invoker.invoke(resource, "complete", parameters);

        expect(result.error?.message).toContain("Function is not a paid inference function");
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    test("refuses per-token pricing on a function not declared as inference", async () => {
        const result = await createInvoker(100_000, { paymentManifest: manifest }).invoker.invoke(resource, "complete", parameters);

        expect(result.error?.message).toContain("isn't an inference function");
        expect(fetchMock).not.toHaveBeenCalled();
    });

    test("returns a local inference function's value with its usage", async () => {
        const local = {
            path: "com.example", name: "Model", metadata: {},
            functions: [{ name: "complete", kind: "inference", parameters: [], returnType: "string", exec: async () => ({ value: "Hi", usage: { inputTokens: 3, outputTokens: 1 } }) }],
        } as unknown as Resource;
        const broken = { ...local, functions: [{ ...local.functions[0]!, exec: async () => "Hi" }] } as unknown as Resource;
        const { invoker } = createInvoker();

        expect(await invoker.invoke(local, "complete", parameters)).toEqual({ value: "Hi", error: null, usage: { inputTokens: 3, outputTokens: 1 } });
        expect((await invoker.invoke(broken, "complete", parameters)).error?.message).toContain("must return { value, usage");
    });
});
