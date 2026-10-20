import type { ResourceFunctionCallParameter } from "requestscript";
import type { StellariumInferencePaymentManifest, StellariumResourceFunction, StellariumResourceFunctionPaymentManifest } from "./repository.js";

/** The parameter every inference function takes: the most output tokens the caller allows. */
export const MAX_TOKENS_PARAMETER = 'maxTokens';

const INT32_MAX = 2_147_483_647;

/** Token counts an inference function reports for one call. */
export interface InferenceUsage {
    inputTokens: number;
    outputTokens: number;
}

/** What an inference function's `exec` returns. Callers' scripts see only `value`. */
export interface InferenceResult {
    value: unknown;
    usage: InferenceUsage;
}

/** The per-million-token rates a charge is computed from. */
export interface InferenceRates {
    inputCostMicroUsdcPerMillionTokens: number;
    outputCostMicroUsdcPerMillionTokens: number;
}

export function isInferenceManifest(manifest: StellariumResourceFunctionPaymentManifest | undefined): manifest is StellariumInferencePaymentManifest {
    return typeof manifest === 'object' && manifest !== null && 'inputCostMicroUsdcPerMillionTokens' in manifest;
}

export function isInferenceFunction(fn: Pick<StellariumResourceFunction, 'kind'>): boolean {
    return fn.kind === 'inference';
}

function isNonnegativeSafeInteger(value: unknown): value is number {
    return Number.isSafeInteger(value) && (value as number) >= 0;
}

/**
 * Micro-USDC owed for `inputTokens` and `outputTokens` at `rates`, rounded up.
 * Computed exactly in BigInt. Throws if the charge isn't a safe integer.
 * The operator keeps a copy (apps/operator/src/inference.ts) that must stay in sync.
 */
export function inferenceCharge(rates: InferenceRates, inputTokens: number, outputTokens: number): number {
    const micros = BigInt(inputTokens) * BigInt(rates.inputCostMicroUsdcPerMillionTokens)
        + BigInt(outputTokens) * BigInt(rates.outputCostMicroUsdcPerMillionTokens);
    const charge = (micros + 999_999n) / 1_000_000n;
    if (charge > BigInt(Number.MAX_SAFE_INTEGER)) {
        throw new Error('Inference charge exceeds the largest safe integer');
    }
    return Number(charge);
}

/** The call's `maxTokens` value, or undefined unless it is a positive int32. */
export function parseMaxTokens(parameters: ResourceFunctionCallParameter[]): number | undefined {
    const value = parameters.find(parameter => parameter.name === MAX_TOKENS_PARAMETER)?.value;
    return Number.isInteger(value) && (value as number) > 0 && (value as number) <= INT32_MAX ? value as number : undefined;
}

/** The usage an inference `exec` reported, or undefined if it isn't two nonnegative safe integers. */
export function parseInferenceResult(result: unknown): InferenceResult | undefined {
    if (typeof result !== 'object' || result === null || !('usage' in result)) {
        return undefined;
    }
    const { value, usage } = result as { value?: unknown, usage: unknown };
    if (typeof usage !== 'object' || usage === null) {
        return undefined;
    }
    const { inputTokens, outputTokens } = usage as Partial<InferenceUsage>;
    if (!isNonnegativeSafeInteger(inputTokens) || !isNonnegativeSafeInteger(outputTokens)) {
        return undefined;
    }
    return { value, usage: { inputTokens, outputTokens } };
}

/**
 * Throws unless an inference function declares an int32 `maxTokens` parameter and, when paid,
 * an inference payment manifest with nonnegative integer rates and an `estimateInputTokens` function.
 * A function that isn't an inference function may not carry an inference manifest.
 */
export function validateInferenceFunction(fn: StellariumResourceFunction): void {
    if (!isInferenceFunction(fn)) {
        if (isInferenceManifest(fn.paymentManifest)) {
            throw new Error(`Function ${fn.name} has per-token pricing but is not declared with kind 'inference'`);
        }
        return;
    }
    const maxTokens = fn.parameters.find(parameter => parameter.name === MAX_TOKENS_PARAMETER);
    if (maxTokens?.type !== 'int32') {
        throw new Error(`Inference function ${fn.name} must take a '${MAX_TOKENS_PARAMETER}: int32' parameter`);
    }
    if (!fn.paymentManifest) {
        return;
    }
    if (!isInferenceManifest(fn.paymentManifest)
        || !isNonnegativeSafeInteger(fn.paymentManifest.inputCostMicroUsdcPerMillionTokens)
        || !isNonnegativeSafeInteger(fn.paymentManifest.outputCostMicroUsdcPerMillionTokens)) {
        throw new Error(`Inference function ${fn.name} must price input and output tokens as nonnegative integer micro-USDC per million tokens`);
    }
    if (typeof fn.estimateInputTokens !== 'function') {
        throw new Error(`Paid inference function ${fn.name} must declare estimateInputTokens`);
    }
}
