import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { OperatorClient, SETTLE_PAYMENT_MAX_RETRIES, type PaymentSubmission } from "../../client/operatorClient.js";

describe("settle payment retries", () => {
    const payment: PaymentSubmission = {
        voucher: {
            requestId: "request-1",
            invocationId: "invocation-1",
            amount: 10000,
            recipientAddress: "4HkmXgXCJ8tw1ih5VFHetRt4kWdo1VLBVmV7B5p6ctK2",
            signature: "signature",
            expiresAt: "2030-01-01T00:00:00.000Z",
            invocationHash: "hash",
            publicKey: "public-key",
        },
    };

    const ok = () => new Response(JSON.stringify({ success: true }), { status: 200 });
    const status = (code: number, headers?: Record<string, string>) => new Response(null, { status: code, headers });
    const networkError = (code: string) => new TypeError("fetch failed", { cause: Object.assign(new Error(code), { code }) });

    let fetchMock: ReturnType<typeof vi.fn>;
    beforeEach(() => {
        vi.useFakeTimers();
        vi.spyOn(console, "error").mockImplementation(() => {});
        fetchMock = vi.fn();
        vi.stubGlobal("fetch", fetchMock);
    });
    afterEach(() => {
        vi.useRealTimers();
        vi.unstubAllGlobals();
        vi.restoreAllMocks();
    });

    test("retries 429 responses with exponential backoff, then succeeds", async () => {
        fetchMock
            .mockResolvedValueOnce(status(429))
            .mockResolvedValueOnce(status(429))
            .mockResolvedValueOnce(ok());

        const pending = new OperatorClient("https://operator.example/v1").settlePayment(payment);

        await vi.advanceTimersByTimeAsync(0);
        expect(fetchMock).toHaveBeenCalledTimes(1);
        await vi.advanceTimersByTimeAsync(999);
        expect(fetchMock).toHaveBeenCalledTimes(1);
        await vi.advanceTimersByTimeAsync(1);
        expect(fetchMock).toHaveBeenCalledTimes(2);
        await vi.advanceTimersByTimeAsync(2000);
        expect(fetchMock).toHaveBeenCalledTimes(3);

        await pending;
        expect(console.error).not.toHaveBeenCalled();
        const bodies = fetchMock.mock.calls.map(([, init]) => init.body);
        expect(new Set(bodies).size).toBe(1);
    });

    test("waits for Retry-After when it is longer than the backoff", async () => {
        fetchMock.mockResolvedValueOnce(status(429, { "retry-after": "30" })).mockResolvedValueOnce(ok());

        const pending = new OperatorClient("https://operator.example/v1").settlePayment(payment);

        await vi.advanceTimersByTimeAsync(29_999);
        expect(fetchMock).toHaveBeenCalledTimes(1);
        await vi.advanceTimersByTimeAsync(1);
        expect(fetchMock).toHaveBeenCalledTimes(2);

        await pending;
    });

    test.each([408, 500, 502, 503, 504])("retries %i responses", async (code) => {
        fetchMock.mockResolvedValueOnce(status(code)).mockResolvedValueOnce(ok());

        const pending = new OperatorClient("https://operator.example/v1").settlePayment(payment);
        await vi.runAllTimersAsync();
        await pending;

        expect(fetchMock).toHaveBeenCalledTimes(2);
        expect(console.error).not.toHaveBeenCalled();
    });

    test.each([400, 401, 404, 409, 422])("does not retry %i responses", async (code) => {
        fetchMock.mockResolvedValue(status(code));

        await new OperatorClient("https://operator.example/v1").settlePayment(payment);

        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(console.error).toHaveBeenCalledOnce();
    });

    test.each(["ECONNREFUSED", "ECONNRESET"])("retries %s network errors", async (code) => {
        fetchMock.mockRejectedValueOnce(networkError(code)).mockResolvedValueOnce(ok());

        const pending = new OperatorClient("https://operator.example/v1").settlePayment(payment);
        await vi.runAllTimersAsync();
        await pending;

        expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    test("rethrows the last network error once retries are exhausted", async () => {
        fetchMock.mockRejectedValue(networkError("ECONNREFUSED"));

        const pending = new OperatorClient("https://operator.example/v1").settlePayment(payment);
        const assertion = expect(pending).rejects.toThrow("fetch failed");
        await vi.runAllTimersAsync();
        await assertion;

        expect(fetchMock).toHaveBeenCalledTimes(1 + SETTLE_PAYMENT_MAX_RETRIES);
    });

    test("gives up after the maximum number of retries", async () => {
        fetchMock.mockResolvedValue(status(429));

        const pending = new OperatorClient("https://operator.example/v1").settlePayment(payment);
        await vi.runAllTimersAsync();
        await pending;

        expect(fetchMock).toHaveBeenCalledTimes(1 + SETTLE_PAYMENT_MAX_RETRIES);
        expect(console.error).toHaveBeenCalledOnce();
    });
});
