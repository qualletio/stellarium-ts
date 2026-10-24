import type { OperatorClient, PaymentSubmission } from "../client/operatorClient.js";
import { inferenceCharge, type InferenceUsage } from "./inference.js";
import { type InferencePaymentVoucher, isInferenceVoucher, type PaymentVoucher } from "./invoker.js";

/** What a resource function call evaluates to, with an inference function's usage. */
export interface InvokeResult {
    value: unknown;
    error: { message: string } | null;
    usage?: InferenceUsage;
}

/** The operator refused to hold the voucher, so the call didn't run. */
export interface PaymentRefusal {
    refused: { status: number, error: string };
}

/** What the operator will capture for `usage`: its charge at the voucher's rates, capped at `maxAmount`. */
function cappedInferenceCharge(voucher: InferencePaymentVoucher, usage: InferenceUsage): number {
    try {
        return Math.min(inferenceCharge(voucher, usage.inputTokens, usage.outputTokens), voucher.maxAmount);
    } catch {
        // The charge isn't a safe integer, so it is over any maxAmount.
        return voucher.maxAmount;
    }
}

/**
 * Runs a paid call: holds the voucher's amount with the operator first, so a paid function never runs
 * unpaid, then runs `call` and captures the voucher, or releases it for a failed or free call. Settlement is
 * scheduled after returning, so it doesn't delay the caller, and failures go to `onSettleError`.
 */
export async function settlePaidCall(
    operatorClient: OperatorClient,
    voucher: PaymentVoucher | InferencePaymentVoucher,
    call: () => Promise<InvokeResult>,
    onSettleError: (error: unknown, message: string) => void,
): Promise<InvokeResult | PaymentRefusal> {
    const authorization = await operatorClient.authorize(voucher);
    if (!authorization.ok) {
        return { refused: { status: authorization.status, error: authorization.error } };
    }

    let capture: PaymentSubmission | undefined;
    const settle = () => setTimeout(async () => {
        try {
            if (capture) {
                await operatorClient.capture(capture);
            } else {
                await operatorClient.release(voucher);
            }
        } catch (error) {
            onSettleError(error, capture ? 'Failed to capture payment' : 'Failed to release payment');
        }
    }, 0);

    let result: InvokeResult;
    try {
        result = await call();
    } catch (error) {
        settle();
        throw error;
    }
    if (!result.error && !isInferenceVoucher(voucher)) {
        capture = { voucher };
    } else if (!result.error && result.usage && isInferenceVoucher(voucher)) {
        // The function may report more output than it was allowed; the caller only signed for maxTokens.
        const usage = { inputTokens: result.usage.inputTokens, outputTokens: Math.min(result.usage.outputTokens, voucher.maxTokens) };
        result.usage = usage;
        // A free call has nothing to charge, so its hold is released instead.
        if (cappedInferenceCharge(voucher, usage) > 0) {
            capture = { voucher, usage };
        }
    }
    settle();
    return result;
}
