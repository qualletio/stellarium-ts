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
 * Key order is part of the signed bytes.
 */
export function voucherPayload(voucher: Voucher): object {
    if (isInferenceVoucher(voucher)) {
        const {
            kind, requestId, invocationId, maxAmount, inputCostMicroUsdPerMillionTokens, outputCostMicroUsdPerMillionTokens,
            maxTokens, recipientOrganizationId, expiresAt, invocationHash, publicKey,
        } = voucher;
        return {
            kind, requestId, invocationId, maxAmount, inputCostMicroUsdPerMillionTokens, outputCostMicroUsdPerMillionTokens,
            maxTokens, recipientOrganizationId, expiresAt, invocationHash, publicKey,
        };
    }
    const { requestId, invocationId, amount, recipientOrganizationId, expiresAt, invocationHash, publicKey } = voucher;
    return { requestId, invocationId, amount, recipientOrganizationId, expiresAt, invocationHash, publicKey };
}
