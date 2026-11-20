import type { OperatorClient, PaymentSubmission } from "../client/operatorClient.js";
import { inferenceCharge, type InferenceUsage } from "./inference.js";
import { type InferencePaymentVoucher, isInferenceVoucher, type PaymentVoucher } from "./invoker.js";
import type { SettlementOutbox } from "./outbox.js";

/** What a resource function call evaluates to, with an inference function's usage. */
export interface InvokeResult {
    value: unknown;
    error: { message: string } | null;
    usage?: InferenceUsage;
    /** A provider's signed answer to a call in a contract run, or which provider a failed one went to. */
    attestation?: unknown;
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
 * unpaid, then runs `call` and captures the voucher, or releases it for a failed or free call. The capture or
 * release is kept in the outbox before this returns, and sent from there.
 */
export async function settlePaidCall(
    operatorClient: OperatorClient,
    outbox: SettlementOutbox,
    voucher: PaymentVoucher | InferencePaymentVoucher,
    call: () => Promise<InvokeResult>,
): Promise<InvokeResult | PaymentRefusal> {
    const authorization = await operatorClient.authorize(voucher);
    if (!authorization.ok) {
        return { refused: { status: authorization.status, error: authorization.error } };
    }

    let result: InvokeResult;
    try {
        result = await call();
    } catch (error) {
        await outbox.releasePayment(voucher);
        throw error;
    }
    let capture: PaymentSubmission | undefined;
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
    if (capture) {
        await outbox.capturePayment(capture);
    } else {
        await outbox.releasePayment(voucher);
    }
    return result;
}
