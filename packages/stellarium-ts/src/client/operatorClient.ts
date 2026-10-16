export interface PaymentSubmission {
    voucher: {
        requestId: string; 
        invocationId: string; 
        amount: number;
        recipientAddress: string; 
        signature: string; 
        expiresAt: string; 
        invocationHash: string;
        publicKey: string;
    }
}

export const SETTLE_PAYMENT_MAX_RETRIES = 5;
export const SETTLE_PAYMENT_BASE_DELAY_MS = 1000;

/**
 * Transient failures. Resending is safe even if an earlier attempt reached the operator: it stores a
 * unique receipt per (requestId, invocationId) before paying, so a repeat is rejected with 409.
 * Rejections (400, 401, 404, 409, 422) are not retried because they won't change.
 */
const RETRYABLE_STATUSES = new Set([408, 429, 500, 502, 503, 504]);

/**
 * Delay before retry `attempt` (0-based): exponential backoff (1s, 2s, 4s, 8s, 16s),
 * or the operator's `Retry-After` seconds when that is longer.
 */
function retryDelayMs(response: Response | undefined, attempt: number): number {
    const backoff = SETTLE_PAYMENT_BASE_DELAY_MS * 2 ** attempt;
    const retryAfterSeconds = Number(response?.headers.get('retry-after') ?? NaN);
    return Number.isFinite(retryAfterSeconds) ? Math.max(backoff, retryAfterSeconds * 1000) : backoff;
}

export class OperatorClient {
    constructor(private readonly url: string) {}

    /**
     * Retries `RETRYABLE_STATUSES` and network errors up to `SETTLE_PAYMENT_MAX_RETRIES` times.
     * Throws the last network error if the operator could not be reached.
     */
    async settlePayment(payment: PaymentSubmission): Promise<void> {
        const body = JSON.stringify(payment);
        let response: Response;
        for (let attempt = 0; ; attempt++) {
            let retryable: Response | undefined;
            try {
                response = await fetch(`${this.url}/payment`, {
                    method: 'POST',
                    body,
                    headers: {
                        'Content-Type': 'application/json',
                    },
                });
                if (!RETRYABLE_STATUSES.has(response.status) || attempt >= SETTLE_PAYMENT_MAX_RETRIES) {
                    break;
                }
                retryable = response;
            } catch (error) {
                if (attempt >= SETTLE_PAYMENT_MAX_RETRIES) {
                    throw error;
                }
            }
            await new Promise(resolve => setTimeout(resolve, retryDelayMs(retryable, attempt)));
        }
        if (!response.ok) {
            console.error(`Failed to settle payment: ${response.statusText} body: ${await response.text()}`);
        }
    }
}
