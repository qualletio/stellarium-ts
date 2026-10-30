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

/**
 * A voucher for a call to a contract on another node. It doesn't pay a fixed amount: the provider authorizes
 * a run with it (`RunService.authorizeContract`), holding up to `maxAmount` for the contract's tokens at
 * `priceMicroUsdPerMillionTokens` and for the paid calls the contract makes. Matches ContractPaymentVoucher
 * in stellarium-ts/resource/invoker.ts.
 */
export interface ContractVoucher {
    kind: 'contract';
    requestId: string;
    invocationId: string;
    maxAmount: number;
    priceMicroUsdPerMillionTokens: number;
    recipientOrganizationId: string;
    signature: string;
    expiresAt: string;
    invocationHash: string;
    publicKey: string;
    /** Set when a billed run made the call: that run's hold pays, and the contract's run is held from it. */
    runId?: string;
}

/** The bytes the caller signed: stellarium-ts's contractVoucherPayload. Key order is part of the signed bytes. */
export function contractVoucherPayload(voucher: ContractVoucher): object {
    const { kind, requestId, invocationId, maxAmount, priceMicroUsdPerMillionTokens, recipientOrganizationId, expiresAt, invocationHash, publicKey } = voucher;
    return {
        kind, requestId, invocationId, maxAmount, priceMicroUsdPerMillionTokens, recipientOrganizationId, expiresAt, invocationHash, publicKey,
        ...(voucher.runId === undefined ? {} : { runId: voucher.runId }),
    };
}
