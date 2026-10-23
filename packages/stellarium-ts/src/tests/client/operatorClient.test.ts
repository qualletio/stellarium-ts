import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { AUTHORIZE_MAX_RETRIES, OPERATOR_MAX_RETRIES, OperatorClient, type PaymentSubmission } from "../../client/operatorClient.js";
import { OPERATOR_AUTH_SCHEME, operatorRequestPayload } from "../../client/operatorAuth.js";
import { verifyData } from "../../crypto/utils.js";
import { generateBase64KeyPair } from "../helpers.js";

const keys = generateBase64KeyPair();
const client = () => new OperatorClient("https://operator.example/v1", keys.publicKey, keys.privateKey);

const payment: PaymentSubmission = {
    voucher: {
        requestId: "request-1",
        invocationId: "invocation-1",
        amount: 10000,
        recipientOrganizationId: "org_provider",
        signature: "signature",
        expiresAt: "2030-01-01T00:00:00.000Z",
        invocationHash: "hash",
        publicKey: "public-key",
    },
};

const ok = (body: unknown = { success: true }) => new Response(JSON.stringify(body), { status: 200 });
const status = (code: number, headers?: Record<string, string>) => new Response(null, { status: code, headers });
const refusal = (code: number, error: string) => new Response(JSON.stringify({ error }), { status: code });
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

describe("request signing", () => {
    test("signs the method, path, body hash and timestamp with the node key", async () => {
        fetchMock.mockResolvedValue(ok());

        await client().capture(payment);

        const [url, init] = fetchMock.mock.calls[0]!;
        expect(url).toBe("https://operator.example/v1/payments/capture");
        const [scheme, encoded] = (init.headers.Authorization as string).split(" ");
        expect(scheme).toBe(OPERATOR_AUTH_SCHEME);
        const credentials = JSON.parse(Buffer.from(encoded!, "base64url").toString());
        expect(credentials.publicKey).toBe(keys.publicKey);
        const payload = operatorRequestPayload("POST", "/v1/payments/capture", JSON.parse(init.body), credentials.timestamp);
        expect(verifyData(payload, keys.publicKey, credentials.signature)).toBe(true);
    });
});

describe("session", () => {
    test("returns the node's organization, sending the enrollment token when given", async () => {
        fetchMock.mockResolvedValue(ok({ organizationId: "org_provider" }));

        await expect(client().session("enroll-1")).resolves.toEqual({ organizationId: "org_provider" });
        expect(JSON.parse(fetchMock.mock.calls[0]![1].body)).toEqual({ enrollmentToken: "enroll-1" });
    });

    test("throws the operator's refusal", async () => {
        fetchMock.mockResolvedValue(refusal(403, "Node is not enrolled in an organization"));

        await expect(client().session()).rejects.toThrow("Node is not enrolled in an organization");
    });
});

describe("authorize", () => {
    test("reports a hold as ok", async () => {
        fetchMock.mockResolvedValue(ok());

        await expect(client().authorize(payment.voucher)).resolves.toEqual({ ok: true });
    });

    test.each([[402, "Insufficient balance"], [403, "Payer organization is frozen"], [422, "Recipient organization can't receive payouts"]])(
        "passes a %i refusal through without retrying", async (code, error) => {
            fetchMock.mockResolvedValue(refusal(code, error));

            await expect(client().authorize(payment.voucher)).resolves.toEqual({ ok: false, status: code, error });
            expect(fetchMock).toHaveBeenCalledTimes(1);
        });

    test("reports a persistent server error as 503 after its few retries", async () => {
        fetchMock.mockResolvedValue(status(500));

        const pending = client().authorize(payment.voucher);
        await vi.runAllTimersAsync();

        await expect(pending).resolves.toMatchObject({ ok: false, status: 503 });
        expect(fetchMock).toHaveBeenCalledTimes(1 + AUTHORIZE_MAX_RETRIES);
    });

    test("reports an unreachable operator as 503", async () => {
        fetchMock.mockRejectedValue(networkError("ECONNREFUSED"));

        const pending = client().authorize(payment.voucher);
        await vi.runAllTimersAsync();

        await expect(pending).resolves.toEqual({ ok: false, status: 503, error: "Payment operator is unavailable" });
    });
});

describe("capture and release retries", () => {
    test("retries 429 responses with exponential backoff, then succeeds", async () => {
        fetchMock
            .mockResolvedValueOnce(status(429))
            .mockResolvedValueOnce(status(429))
            .mockResolvedValueOnce(ok());

        const pending = client().capture(payment);

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

        const pending = client().release(payment.voucher);

        await vi.advanceTimersByTimeAsync(29_999);
        expect(fetchMock).toHaveBeenCalledTimes(1);
        await vi.advanceTimersByTimeAsync(1);
        expect(fetchMock).toHaveBeenCalledTimes(2);

        await pending;
    });

    test.each([408, 500, 502, 503, 504])("retries %i responses", async (code) => {
        fetchMock.mockResolvedValueOnce(status(code)).mockResolvedValueOnce(ok());

        const pending = client().capture(payment);
        await vi.runAllTimersAsync();
        await pending;

        expect(fetchMock).toHaveBeenCalledTimes(2);
        expect(console.error).not.toHaveBeenCalled();
    });

    test.each([400, 401, 404, 409, 422])("does not retry %i responses", async (code) => {
        fetchMock.mockResolvedValue(status(code));

        await client().capture(payment);

        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(console.error).toHaveBeenCalledOnce();
    });

    test.each(["ECONNREFUSED", "ECONNRESET"])("retries %s network errors", async (code) => {
        fetchMock.mockRejectedValueOnce(networkError(code)).mockResolvedValueOnce(ok());

        const pending = client().capture(payment);
        await vi.runAllTimersAsync();
        await pending;

        expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    test("rethrows the last network error once retries are exhausted", async () => {
        fetchMock.mockRejectedValue(networkError("ECONNREFUSED"));

        const pending = client().capture(payment);
        const assertion = expect(pending).rejects.toThrow("fetch failed");
        await vi.runAllTimersAsync();
        await assertion;

        expect(fetchMock).toHaveBeenCalledTimes(1 + OPERATOR_MAX_RETRIES);
    });

    test("gives up after the maximum number of retries", async () => {
        fetchMock.mockResolvedValue(status(429));

        const pending = client().capture(payment);
        await vi.runAllTimersAsync();
        await pending;

        expect(fetchMock).toHaveBeenCalledTimes(1 + OPERATOR_MAX_RETRIES);
        expect(console.error).toHaveBeenCalledOnce();
    });

    test("throws when no operator URL is configured", async () => {
        await expect(new OperatorClient(undefined, keys.publicKey, keys.privateKey).capture(payment)).rejects.toThrow("No operator URL is configured");
    });
});
