import type { InferencePaymentSubmission, PaymentSubmission } from './payments/types.js';

export function isInferenceSubmission(submission: PaymentSubmission): submission is InferencePaymentSubmission {
    return submission.voucher.kind === 'inference';
}

/**
 * Micro-USD owed for the reported usage at the voucher's per-million-token rates, rounded up and
 * capped at the voucher's `maxAmount`. Copied from `inferenceCharge` in stellarium-ts's
 * resource/inference.ts; the two must stay in sync.
 */
export function inferenceAmount({ voucher, usage }: InferencePaymentSubmission): number {
    const micros = BigInt(usage.inputTokens) * BigInt(voucher.inputCostMicroUsdPerMillionTokens)
        + BigInt(usage.outputTokens) * BigInt(voucher.outputCostMicroUsdPerMillionTokens);
    const charge = (micros + 999_999n) / 1_000_000n;
    return charge < BigInt(voucher.maxAmount) ? Number(charge) : voucher.maxAmount;
}
