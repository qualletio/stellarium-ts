import { generateKeyPairSync } from "node:crypto";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { verifyData } from "../../crypto/utils.js";
import { CombinationResourceInvoker, EXTERNAL_INVOKE_MAX_RETRIES, paymentVoucherPayload } from "../../resource/invoker.js";
import type { ResourceRepository } from "../../resource/repository.js";
import type { Resource } from "requestscript";

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
    test("verifies the signed invocation payload, not the voucher object", () => {
        const { publicKey, privateKey } = generateBase64KeyPair();
        const invoker = new CombinationResourceInvoker({} as ResourceRepository, 100_000, publicKey, privateKey);
        const parameters = [{ name: "city", value: "Oslo" }];
        const voucher = invoker.createPaymentVoucher(
            "4HkmXgXCJ8tw1ih5VFHetRt4kWdo1VLBVmV7B5p6ctK2",
            10000,
            "com.example",
            "Weather",
            parameters,
        );

        expect(verifyData(
            paymentVoucherPayload(voucher, "com.example", "Weather", parameters),
            voucher.publicKey,
            voucher.signature,
        )).toBe(true);
        expect(verifyData(voucher, voucher.publicKey, voucher.signature)).toBe(false);
    });
});

describe("external invoke retries", () => {
    const resource = { path: "com.example", name: "Weather", metadata: { baseUrl: "https://remote.example" }, functions: [] } as unknown as Resource;
    const parameters = [{ name: "city", value: "Oslo" }];

    function createInvoker(paymentManifest?: { costLamports: number; recipientAddress: string }) {
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

        const invoker = createInvoker({ costLamports: 10000, recipientAddress: "4HkmXgXCJ8tw1ih5VFHetRt4kWdo1VLBVmV7B5p6ctK2" });
        const pending = invoker.invoke(resource, "forecast", parameters);
        await vi.runAllTimersAsync();
        await pending;

        const bodies = fetchMock.mock.calls.map(([, init]) => init.body);
        expect(bodies).toHaveLength(3);
        expect(new Set(bodies).size).toBe(1);
        expect(JSON.parse(bodies[0]).paymentVoucher.requestId).toBeDefined();
    });
});
