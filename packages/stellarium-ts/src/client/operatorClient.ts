import type { ContractPaymentVoucher } from "../resource/invoker.js";
import { operatorAuthorization } from "./operatorAuth.js";

// Wire formats match PaymentVoucher and InferencePaymentVoucher in resource/invoker.ts,
// and the voucher types in apps/operator/src/payments/types.ts.
export type PaymentSubmission = FixedPaymentSubmission | InferencePaymentSubmission;

export interface FixedPaymentVoucher {
    kind?: undefined;
    requestId: string;
    invocationId: string;
    amount: number;
    recipientOrganizationId: string;
    signature: string;
    expiresAt: string;
    invocationHash: string;
    publicKey: string;
    runId?: string;
}

export interface InferenceVoucher {
    kind: 'inference';
    requestId: string;
    invocationId: string;
    maxAmount: number;
    inputCostMicroUsdPerMillionTokens: number;
    outputCostMicroUsdPerMillionTokens: number;
    maxTokens: number;
    recipientOrganizationId: string;
    signature: string;
    expiresAt: string;
    invocationHash: string;
    publicKey: string;
    runId?: string;
}

export interface FixedPaymentSubmission {
    voucher: FixedPaymentVoucher;
}

/** The provider reports the call's usage; the operator charges it at the voucher's rates, up to the held `maxAmount`. */
export interface InferencePaymentSubmission {
    voucher: InferenceVoucher;
    usage: {
        inputTokens: number;
        outputTokens: number;
    };
}

/** Whether the operator placed a hold for a voucher. A refusal carries the operator's status and error. */
export type AuthorizeResult = { ok: true } | { ok: false, status: number, error: string };

/** What a node sends to authorize a script run billed to an API client. Matches apps/operator/src/runs/runService.ts. */
export interface RunAuthorizationRequest {
    /** The run token the caller presented. */
    token: string;
    runId: string;
    source: string;
}

/** What a node sends to authorize a call to one of its contracts. Matches apps/operator/src/runs/runService.ts. */
export interface ContractRunAuthorizationRequest {
    /** The caller's voucher. Its `invocationId` is the run's id. */
    voucher: ContractPaymentVoucher;
    /** The contract's source, which the operator prices. */
    source: string;
}

/**
 * The operator's answer to a contract call: a hold for the run named by the voucher's `invocationId`, or
 * `free` when the caller is in this node's organization, which doesn't pay itself. `payerOrganizationId` is
 * the organization paying for the call, which the contract sees as `caller.org`. Older operators omit it.
 */
export type ContractRunAuthorizeResult = { ok: true, free: boolean, payerOrganizationId?: string } | { ok: false, status: number, error: string };

/** What the operator knows of this node. */
export interface OperatorSession {
    organizationId: string;
    /** The node's listed price per million script tokens. Absent from older operators. */
    priceMicroUsdPerMillionTokens?: number;
}

/** The operator's hold for a run: up to `heldMicroUsd` for the script's tokens and its paid calls together. */
export type RunAuthorizeResult = { ok: true, heldMicroUsd: number, maxTokens: number } | { ok: false, status: number, error: string };

export const OPERATOR_MAX_RETRIES = 5;
/** Authorization runs while the caller waits, so it gives up much sooner than capture and release. */
export const AUTHORIZE_MAX_RETRIES = 2;
export const OPERATOR_BASE_DELAY_MS = 1000;
export const AUTHORIZE_BASE_DELAY_MS = 200;
/** Per attempt. A timed-out attempt is retried like a network error. */
export const OPERATOR_TIMEOUT_MS = 10_000;

/**
 * Transient failures. Resending is safe even if an earlier attempt reached the operator: every payment
 * request is idempotent per voucher (requestId, invocationId).
 * Rejections (400, 401, 402, 403, 404, 409, 422) are not retried because they won't change.
 */
const RETRYABLE_STATUSES = new Set([408, 429, 500, 502, 503, 504]);

/**
 * Delay before retry `attempt` (0-based): exponential backoff from `baseDelayMs`,
 * or the operator's `Retry-After` seconds when that is longer.
 */
function retryDelayMs(response: Response | undefined, attempt: number, baseDelayMs: number): number {
    const backoff = baseDelayMs * 2 ** attempt;
    const retryAfterSeconds = Number(response?.headers.get('retry-after') ?? NaN);
    return Number.isFinite(retryAfterSeconds) ? Math.max(backoff, retryAfterSeconds * 1000) : backoff;
}

async function errorMessage(response: Response): Promise<string> {
    const body = await response.json().catch(() => undefined) as { error?: unknown } | undefined;
    return typeof body?.error === 'string' ? body.error : `${response.status} ${response.statusText}`.trim();
}

/** Talks to the operator as this node. Every request is signed with the node's key. */
export class OperatorClient {
    constructor(private readonly url: string | undefined, private readonly publicKey: string, private readonly privateKey: string) {}

    /**
     * POSTs `body`, retrying `RETRYABLE_STATUSES` and network errors up to `retries` times.
     * Each attempt is signed afresh, since the operator only accepts recent timestamps.
     * Throws the last network error if the operator could not be reached, or if no operator URL is configured.
     */
    private async post(path: string, body: unknown, retries: number, baseDelayMs: number): Promise<Response> {
        if (!this.url) {
            throw new Error('No operator URL is configured');
        }
        const url = `${this.url}${path}`;
        const serialized = JSON.stringify(body);
        for (let attempt = 0; ; attempt++) {
            let retryable: Response | undefined;
            try {
                const response = await fetch(url, {
                    method: 'POST',
                    body: serialized,
                    headers: {
                        'Content-Type': 'application/json',
                        Authorization: operatorAuthorization('POST', url, body, this.publicKey, this.privateKey),
                    },
                    signal: AbortSignal.timeout(OPERATOR_TIMEOUT_MS),
                });
                if (!RETRYABLE_STATUSES.has(response.status) || attempt >= retries) {
                    return response;
                }
                retryable = response;
            } catch (error) {
                if (attempt >= retries) {
                    throw error;
                }
            }
            await new Promise(resolve => setTimeout(resolve, retryDelayMs(retryable, attempt, baseDelayMs)));
        }
    }

    /**
     * Returns the organization this node is enrolled in. With an `enrollmentToken` from the dashboard,
     * enrolls the node first; a node that is already enrolled ignores the token. Throws if the node is
     * not enrolled or the operator refuses.
     */
    async session(enrollmentToken?: string, baseUrl?: string): Promise<OperatorSession> {
        const body = { ...(enrollmentToken ? { enrollmentToken } : {}), ...(baseUrl ? { baseUrl } : {}) };
        const response = await this.post('/nodes/session', body, OPERATOR_MAX_RETRIES, OPERATOR_BASE_DELAY_MS);
        if (!response.ok) {
            throw new Error(`Operator refused this node's session: ${await errorMessage(response)}`);
        }
        return await response.json() as OperatorSession;
    }

    /**
     * Asks the operator to hold the voucher's amount (or `maxAmount`) on the payer's balance, before
     * running the paid function. An unreachable operator is reported as a 503 refusal.
     */
    async authorize(voucher: FixedPaymentVoucher | InferenceVoucher): Promise<AuthorizeResult> {
        const result = await this.hold('/payments/authorize', { voucher });
        return result.ok ? { ok: true } : result;
    }

    /**
     * Asks the operator to hold a script run's cost on the paying API client's organization, before running
     * it. An unreachable operator is reported as a 503 refusal.
     */
    async authorizeRun(request: RunAuthorizationRequest): Promise<RunAuthorizeResult> {
        const result = await this.hold('/runs/authorize', request);
        if (!result.ok) return result;
        const { heldMicroUsd, maxTokens } = result.body as { heldMicroUsd: number, maxTokens: number };
        return { ok: true, heldMicroUsd, maxTokens };
    }

    /**
     * Asks the operator to hold a contract call's cost on the caller's organization, or on the caller's run,
     * before running the contract. An unreachable operator is reported as a 503 refusal.
     */
    async authorizeContractRun(request: ContractRunAuthorizationRequest): Promise<ContractRunAuthorizeResult> {
        const result = await this.hold('/runs/contract/authorize', request);
        if (!result.ok) return result;
        const body = result.body as { status?: unknown, payerOrganizationId?: unknown } | undefined;
        return {
            ok: true,
            free: body?.status === 'free',
            ...(typeof body?.payerOrganizationId === 'string' ? { payerOrganizationId: body.payerOrganizationId } : {}),
        };
    }

    /** Charges a held run for the tokens its script executed, and releases the rest of its hold. */
    async captureRun(request: { runId: string, tokens: number }): Promise<void> {
        await this.settle('/runs/capture', request);
    }

    /** Releases a held run without charging it, for a script this node failed to run. */
    async releaseRun(request: { runId: string }): Promise<void> {
        await this.settle('/runs/release', request);
    }

    /** Authorization runs while the caller waits, so it retries briefly and reports an unreachable operator as 503. */
    private async hold(path: string, body: unknown): Promise<{ ok: true, body: unknown } | { ok: false, status: number, error: string }> {
        let response: Response;
        try {
            response = await this.post(path, body, AUTHORIZE_MAX_RETRIES, AUTHORIZE_BASE_DELAY_MS);
        } catch (error) {
            console.error(`Failed to reach the operator for ${path}`, error);
            return { ok: false, status: 503, error: 'Payment operator is unavailable' };
        }
        if (response.ok) {
            return { ok: true, body: await response.json().catch(() => undefined) };
        }
        // Retries ran out on a transient failure: the caller may try again later.
        const status = RETRYABLE_STATUSES.has(response.status) ? 503 : response.status;
        return { ok: false, status, error: await errorMessage(response) };
    }

    /** Charges a held voucher: its amount, or for inference the reported usage capped at the hold. */
    async capture(payment: PaymentSubmission): Promise<void> {
        await this.settle('/payments/capture', payment);
    }

    /** Releases a held voucher without charging it, for a call that failed or cost nothing. */
    async release(voucher: FixedPaymentVoucher | InferenceVoucher): Promise<void> {
        await this.settle('/payments/release', { voucher });
    }

    /** Logs a refusal instead of throwing: nothing waits on capture or release. Throws only if the operator can't be reached. */
    private async settle(path: string, body: unknown): Promise<void> {
        const response = await this.post(path, body, OPERATOR_MAX_RETRIES, OPERATOR_BASE_DELAY_MS);
        if (!response.ok) {
            console.error(`Operator refused ${path}: ${await errorMessage(response)}`);
        }
    }
}
