// Wire formats match PaymentVoucher and InferencePaymentVoucher in stellarium-ts/resource/invoker.ts,
// and PaymentSubmission in stellarium-ts/client/operatorClient.ts.
export type Voucher = FixedPaymentSubmission['voucher'] | InferencePaymentSubmission['voucher'];
export type PaymentSubmission = FixedPaymentSubmission | InferencePaymentSubmission;

export interface FixedPaymentSubmission {
    voucher: {
        kind?: undefined;
        requestId: string;
        invocationId: string;
        amount: number;
        recipientOrganizationId: string;
        signature: string;
        expiresAt: string;
        invocationHash: string;
        publicKey: string;
        /** Set by a node calling a paid function from a script run: the run's hold pays, not the signer's organization. */
        runId?: string;
    };
}

/** An inference voucher signs rates instead of an amount. The provider reports the call's usage beside it on capture. */
export interface InferencePaymentSubmission {
    voucher: {
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
        /** Set by a node calling a paid function from a script run: the run's hold pays, not the signer's organization. */
        runId?: string;
    };
    usage: {
        inputTokens: number;
        outputTokens: number;
    };
}

export function isInferenceVoucher(voucher: Voucher): voucher is InferencePaymentSubmission['voucher'] {
    return voucher.kind === 'inference';
}

/**
 * The bytes the caller signed: stellarium-ts's paymentVoucherPayload or inferenceVoucherPayload.
 * Key order is part of the signed bytes. `runId` comes last and only when set, so vouchers without one
 * sign the same bytes as before it existed.
 */
export function voucherPayload(voucher: Voucher): object {
    const run = voucher.runId === undefined ? {} : { runId: voucher.runId };
    if (isInferenceVoucher(voucher)) {
        const {
            kind, requestId, invocationId, maxAmount, inputCostMicroUsdPerMillionTokens, outputCostMicroUsdPerMillionTokens,
            maxTokens, recipientOrganizationId, expiresAt, invocationHash, publicKey,
        } = voucher;
        return {
            kind, requestId, invocationId, maxAmount, inputCostMicroUsdPerMillionTokens, outputCostMicroUsdPerMillionTokens,
            maxTokens, recipientOrganizationId, expiresAt, invocationHash, publicKey, ...run,
        };
    }
    const { requestId, invocationId, amount, recipientOrganizationId, expiresAt, invocationHash, publicKey } = voucher;
    return { requestId, invocationId, amount, recipientOrganizationId, expiresAt, invocationHash, publicKey, ...run };
}
