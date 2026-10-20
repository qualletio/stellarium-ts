import { Resource, ResourceFunctionCallParameter, ResourceInvoker } from "requestscript";
import { hashData, signData } from "../crypto/utils.js";
import type { GrantService } from "../grant/service.js";
import { inferenceCharge, type InferenceUsage, isInferenceFunction, isInferenceManifest, parseInferenceResult, parseMaxTokens } from "./inference.js";
import { ResourceRepository, type StellariumInferencePaymentManifest, type StellariumResourceFunction } from "./repository.js";

export interface PaymentVoucher {
    requestId: string;
    invocationId: string;
    amount: number;
    recipientAddress: string;
    signature: string;
    expiresAt: string;
    invocationHash: string;
    publicKey: string;
}

/**
 * A voucher for an inference function. It signs the provider's per-million-token rates and the call's
 * `maxTokens` instead of an amount: the operator charges the usage the provider reports at those rates,
 * up to `maxAmount`.
 */
export interface InferencePaymentVoucher {
    kind: 'inference';
    requestId: string;
    invocationId: string;
    maxAmount: number;
    inputCostMicroUsdcPerMillionTokens: number;
    outputCostMicroUsdcPerMillionTokens: number;
    maxTokens: number;
    recipientAddress: string;
    signature: string;
    expiresAt: string;
    invocationHash: string;
    publicKey: string;
}

/** What a provider's `POST /v1/run/resource/estimate` answers. */
export interface InferenceEstimate {
    inputTokens: number;
    maxAmount: number;
}

/**
 * Hash binding a voucher to one function call. Providers recompute it from the
 * request they receive and compare it to `voucher.invocationHash`.
 * Key order is part of the hashed bytes.
 */
export function invocationHash(
    resourcePath: string,
    resourceName: string,
    functionName: string,
    parameters: ResourceFunctionCallParameter[],
): string {
    return hashData({ resourcePath, resourceName, functionName, parameters });
}

/**
 * The object `createPaymentVoucher` signs: every voucher field except `signature`.
 * Key order is part of the signed bytes.
 */
export function paymentVoucherPayload(voucher: Omit<PaymentVoucher, "signature">) {
    const { requestId, invocationId, amount, recipientAddress, expiresAt, invocationHash, publicKey } = voucher;
    return { requestId, invocationId, amount, recipientAddress, expiresAt, invocationHash, publicKey };
}

/**
 * The object `createInferenceVoucher` signs: every inference voucher field except `signature`.
 * Key order is part of the signed bytes.
 */
export function inferenceVoucherPayload(voucher: Omit<InferencePaymentVoucher, "signature">) {
    const { kind, requestId, invocationId, maxAmount, inputCostMicroUsdcPerMillionTokens, outputCostMicroUsdcPerMillionTokens, maxTokens, recipientAddress, expiresAt, invocationHash, publicKey } = voucher;
    return { kind, requestId, invocationId, maxAmount, inputCostMicroUsdcPerMillionTokens, outputCostMicroUsdcPerMillionTokens, maxTokens, recipientAddress, expiresAt, invocationHash, publicKey };
}

export function isInferenceVoucher(voucher: PaymentVoucher | InferencePaymentVoucher): voucher is InferencePaymentVoucher {
    return (voucher as InferencePaymentVoucher).kind === 'inference';
}

export const PAYMENT_VOUCHER_LIFETIME_MS = 1000 * 60 * 2;
/** Inference can run for minutes, and the operator refuses a voucher that expired before the provider settled it. */
export const INFERENCE_VOUCHER_LIFETIME_MS = 1000 * 60 * 10;

export const EXTERNAL_INVOKE_MAX_RETRIES = 3;
export const EXTERNAL_INVOKE_BASE_DELAY_MS = 500;
/** Per attempt. A timed-out attempt is retried like a network error. */
export const EXTERNAL_INVOKE_TIMEOUT_MS = 30_000;
/** Per attempt, for calls to inference functions. Every attempt fits within `INFERENCE_VOUCHER_LIFETIME_MS`. */
export const INFERENCE_INVOKE_TIMEOUT_MS = 120_000;

/**
 * POST to a remote resource, retrying network errors, 429s, and 5xx responses up to
 * `EXTERNAL_INVOKE_MAX_RETRIES` times with exponential backoff (500ms, 1s, 2s).
 * Other 4xx responses are returned immediately since retrying won't change them.
 * Throws the last network error if every attempt fails to connect.
 */
async function fetchWithRetry(url: string, init: () => RequestInit, timeoutMs = EXTERNAL_INVOKE_TIMEOUT_MS): Promise<Response> {
    for (let attempt = 0; ; attempt++) {
        try {
            const response = await fetch(url, { ...init(), signal: AbortSignal.timeout(timeoutMs) });
            if (response.status !== 429 && response.status < 500) {
                return response;
            }
            if (attempt >= EXTERNAL_INVOKE_MAX_RETRIES) {
                return response;
            }
        } catch (error) {
            if (attempt >= EXTERNAL_INVOKE_MAX_RETRIES) {
                throw error;
            }
        }
        await new Promise(resolve => setTimeout(resolve, EXTERNAL_INVOKE_BASE_DELAY_MS * 2 ** attempt));
    }
}

export class CombinationResourceInvoker implements ResourceInvoker {

    /**
     * Without a `grantService`, calls to restricted remote functions fail.
     * `inferenceCostLimitMicroUsdc` caps an inference voucher's `maxAmount`, and defaults to `costLimitMicroUsdc`.
     */
    constructor(
        private readonly resourceRepository: ResourceRepository,
        private readonly costLimitMicroUsdc: number,
        private readonly publicKey: string,
        private readonly privateKey: string,
        private readonly grantService?: GrantService,
        private readonly inferenceCostLimitMicroUsdc: number = costLimitMicroUsdc,
    ) {}
    /**
     * Invoke a function on a resource.
     * If the resource has a baseUrl, it will be invoked as a remote function.
     * If the function is restricted, it attaches an authorization from a held grant.
     * If the resource has a paymentManifest, it will create a payment voucher and pass it to the resource.
     * A paid inference function is first priced by the provider's estimate endpoint.
     * Otherwise, it will be invoked as a local function. A local inference function's usage is returned beside its value.
     * 
     * @param resource - The resource to invoke
     * @param functionName - The name of the function to invoke
     * @param parameters - The parameters to pass to the function
     * @returns The return value of the function
     */
    async invoke(resource: Resource, functionName: string, parameters: ResourceFunctionCallParameter[]): Promise<{ value: any, error: { message: string } | null, usage?: InferenceUsage }> {
        if (resource.metadata.baseUrl) {
            let requestBody: Record<string, any> = {
                resourcePath: resource.path,
                resourceName: resource.name,
                functionName,
                parameters,
            };
            const url = resource.metadata.baseUrl as string | undefined;
            if (!url) {
                throw new Error(`Resource ${resource.name} does not have a url`);
            }

            const resourceFunction = await this.resourceRepository.getResourceFunction(resource.path, resource.name, functionName);
            if (!resourceFunction) {
                throw new Error(`Function ${functionName} not found in resource ${resource.name}`);
            }

            const target = { resourcePath: resource.path, resourceName: resource.name, functionName, parameters };
            // Checked before the voucher, so a call this node can't make never signs one.
            const chain = resourceFunction.restricted ? await this.grantService?.chainFor(url, target) : undefined;
            if (resourceFunction.restricted && !chain) {
                return { value: null, error: { message: `Failed to invoke ${resource.name}.${functionName}: it requires a grant from ${url}, and this node holds none that covers the call` } };
            }

            const manifest = resourceFunction.paymentManifest;
            const inference = isInferenceFunction(resourceFunction);
            if (manifest && inference) {
                console.log(`Resource function ${resource.name}.${functionName} is a paid inference function, creating payment voucher...`);
                // Peers' manifests aren't validated on receipt.
                if (!isInferenceManifest(manifest) || !Number.isSafeInteger(manifest.inputCostMicroUsdcPerMillionTokens) || manifest.inputCostMicroUsdcPerMillionTokens < 0
                    || !Number.isSafeInteger(manifest.outputCostMicroUsdcPerMillionTokens) || manifest.outputCostMicroUsdcPerMillionTokens < 0) {
                    return { value: null, error: { message: `Failed to invoke ${resource.name}.${functionName}: its payment manifest has no valid per-token pricing` } };
                }
                const maxTokens = parseMaxTokens(parameters);
                if (maxTokens === undefined) {
                    return { value: null, error: { message: `Failed to invoke ${resource.name}.${functionName}: maxTokens must be a positive int32` } };
                }
                const estimate = await this.estimate(url, target, chain);
                if ('error' in estimate) {
                    return { value: null, error: { message: `Failed to invoke ${resource.name}.${functionName}: ${estimate.error}` } };
                }
                // The provider may pick the input estimate, but maxAmount must follow from it at the advertised rates.
                if (inferenceCharge(manifest, estimate.inputTokens, maxTokens) !== estimate.maxAmount) {
                    return { value: null, error: { message: `Failed to invoke ${resource.name}.${functionName}: the provider's estimate doesn't match its advertised rates` } };
                }
                if (estimate.maxAmount > this.inferenceCostLimitMicroUsdc) {
                    throw new Error(`Function ${functionName} may cost up to ${estimate.maxAmount} micro-USDC, which exceeds the inference cost limit of ${this.inferenceCostLimitMicroUsdc} micro-USDC`);
                }
                requestBody.paymentVoucher = this.createInferenceVoucher(manifest, estimate.maxAmount, maxTokens, resource.path, resource.name, functionName, parameters);
            } else if (manifest) {
                console.log(`Resource function ${resource.name}.${functionName} has a payment manifest, creating payment voucher...`);
                if (isInferenceManifest(manifest)) {
                    return { value: null, error: { message: `Failed to invoke ${resource.name}.${functionName}: it has per-token pricing but isn't an inference function` } };
                }
                if (manifest.costMicroUsdc > this.costLimitMicroUsdc) {
                    throw new Error(`Function ${functionName} cost ${manifest.costMicroUsdc} micro-USDC, which exceeds the cost limit of ${this.costLimitMicroUsdc} micro-USDC`);
                }
                requestBody.paymentVoucher = this.createPaymentVoucher(manifest.recipientAddress, manifest.costMicroUsdc, resource.path, resource.name, functionName, parameters);
            }

            // The voucher is created once and reused on every attempt, so the operator's
            // requestId/invocationId check prevents a retried call from being settled twice.
            // The authorization is signed per attempt, since the provider refuses a reused nonce.
            const result = await fetchWithRetry(`${url}/v1/run/resource`, () => ({
                method: 'POST',
                body: JSON.stringify(chain && this.grantService ? { ...requestBody, authorization: this.grantService.authorize(chain, target) } : requestBody),
                headers: {
                    'Content-Type': 'application/json',
                },
            }), inference ? INFERENCE_INVOKE_TIMEOUT_MS : EXTERNAL_INVOKE_TIMEOUT_MS);

            if (!result.ok) {
                // The provider's JSON error is more useful than the status text, which can be empty.
                const detail = await result.json().then((body) => (body as { error?: unknown } | null)?.error, () => undefined);
                const reason = typeof detail === 'string' ? detail : `${result.status} ${result.statusText}`.trim();
                return { value: null, error: { message: `Failed to invoke ${resource.name}.${functionName}: ${reason}` } };
            }

            const data = await result.json() as { value: any, error: { message: string } | null };
            return { value: data.value, error: data.error };
        } else {
            const fn = resource.functions.find(f => f.name === functionName) as StellariumResourceFunction | undefined;
            if (!fn) {
                return { value: null, error: { message: `Function ${functionName} not found in resource ${resource.name}` } };
            }

            const result = await fn.exec(parameters);
            if (isInferenceFunction(fn)) {
                const inferenceResult = parseInferenceResult(result);
                if (!inferenceResult) {
                    return { value: null, error: { message: `Inference function ${functionName} must return { value, usage: { inputTokens, outputTokens } }` } };
                }
                return { value: inferenceResult.value, error: null, usage: inferenceResult.usage };
            }
            return { value: result, error: null };
        }
    }

    /** Asks the provider what a call to a paid inference function will cost at most. */
    private async estimate(url: string, target: { resourcePath: string, resourceName: string, functionName: string, parameters: ResourceFunctionCallParameter[] }, chain: Awaited<ReturnType<GrantService['chainFor']>> | undefined): Promise<InferenceEstimate | { error: string }> {
        let response: Response;
        try {
            // The authorization is signed per attempt, since the provider refuses a reused nonce.
            response = await fetchWithRetry(`${url}/v1/run/resource/estimate`, () => ({
                method: 'POST',
                body: JSON.stringify(chain && this.grantService ? { ...target, authorization: this.grantService.authorize(chain, target) } : target),
                headers: { 'Content-Type': 'application/json' },
            }));
        } catch (error) {
            return { error: `estimate failed: ${error instanceof Error ? error.message : String(error)}` };
        }
        const body = await response.json().catch(() => undefined) as Partial<InferenceEstimate> & { error?: unknown } | undefined;
        if (!response.ok) {
            return { error: `estimate failed: ${typeof body?.error === 'string' ? body.error : `${response.status} ${response.statusText}`.trim()}` };
        }
        const { inputTokens, maxAmount } = body ?? {};
        if (!Number.isSafeInteger(inputTokens) || inputTokens! < 0 || !Number.isSafeInteger(maxAmount) || maxAmount! < 0) {
            return { error: 'the provider returned an invalid estimate' };
        }
        return { inputTokens: inputTokens!, maxAmount: maxAmount! };
    }

    createPaymentVoucher(recipientAddress: string, amount: number, resourcePath: string, resourceName: string, functionName: string, parameters: ResourceFunctionCallParameter[]): PaymentVoucher {
        const requestId = crypto.randomUUID();
        const invocationId = crypto.randomUUID();
        const expiresAt = new Date(Date.now() + PAYMENT_VOUCHER_LIFETIME_MS).toISOString();
        const hash = invocationHash(resourcePath, resourceName, functionName, parameters);
        const signature = signData(paymentVoucherPayload({ requestId, invocationId, amount, recipientAddress, expiresAt, invocationHash: hash, publicKey: this.publicKey }), this.privateKey);
        return { requestId, invocationId, amount, recipientAddress, signature, expiresAt, invocationHash: hash, publicKey: this.publicKey };
    }

    createInferenceVoucher(manifest: StellariumInferencePaymentManifest, maxAmount: number, maxTokens: number, resourcePath: string, resourceName: string, functionName: string, parameters: ResourceFunctionCallParameter[]): InferencePaymentVoucher {
        const unsigned: Omit<InferencePaymentVoucher, "signature"> = {
            kind: 'inference',
            requestId: crypto.randomUUID(),
            invocationId: crypto.randomUUID(),
            maxAmount,
            inputCostMicroUsdcPerMillionTokens: manifest.inputCostMicroUsdcPerMillionTokens,
            outputCostMicroUsdcPerMillionTokens: manifest.outputCostMicroUsdcPerMillionTokens,
            maxTokens,
            recipientAddress: manifest.recipientAddress,
            expiresAt: new Date(Date.now() + INFERENCE_VOUCHER_LIFETIME_MS).toISOString(),
            invocationHash: invocationHash(resourcePath, resourceName, functionName, parameters),
            publicKey: this.publicKey,
        };
        return { ...unsigned, signature: signData(inferenceVoucherPayload(unsigned), this.privateKey) };
    }
}
