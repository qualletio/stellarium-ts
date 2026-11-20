import { type CallAttachment, Resource, ResourceFunctionCallParameter, ResourceInvoker } from "requestscript";
import type { Frame, StateTransaction } from "../contract/pending.js";
import { ACCOUNT_BUILTIN, type AccountService, type AccountSession, isMoneyPath, type MoneyRun, RANDOM_BUILTIN } from "../money/account.js";
import type { OperatorClient } from "../client/operatorClient.js";
import { hashData, signData } from "../crypto/utils.js";
import type { GrantService } from "../grant/service.js";
import type { EventLineage } from "../event/types.js";
import { estimateInputTokens, inferenceCharge, type InferenceUsage, isInferenceFunction, isInferenceManifest, parseInferenceResult, parseMaxTokens } from "./inference.js";
import { isContractFunction, isContractManifest, ResourceRepository, type StellariumFixedPaymentManifest, type StellariumInferencePaymentManifest, type StellariumResourceFunction } from "./repository.js";
import { type InvokeResult, settlePaidCall } from "./settlement.js";
import type { SettlementOutbox } from "./outbox.js";

export interface PaymentVoucher {
    requestId: string;
    invocationId: string;
    amount: number;
    recipientOrganizationId: string;
    signature: string;
    expiresAt: string;
    invocationHash: string;
    publicKey: string;
    /** Set for a call made by a script run billed to an API client: the run's hold pays instead of this node's organization. */
    runId?: string;
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
    inputCostMicroUsdPerMillionTokens: number;
    outputCostMicroUsdPerMillionTokens: number;
    maxTokens: number;
    recipientOrganizationId: string;
    signature: string;
    expiresAt: string;
    invocationHash: string;
    publicKey: string;
    /** Set for a call made by a script run billed to an API client: the run's hold pays instead of this node's organization. */
    runId?: string;
}

/**
 * A voucher for a call to a contract on another node. It signs the provider's price per million tokens and
 * the most the caller will pay, `maxAmount`: the provider authorizes a run with it, which holds up to
 * `maxAmount` for the contract's tokens and for the paid calls the contract makes.
 */
export interface ContractPaymentVoucher {
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
    /** Set for a call made by a billed run: that run's hold pays, and the contract's run is held from it. */
    runId?: string;
}

/** What a provider's `POST /v1/run/resource/estimate` answers. */
export interface InferenceEstimate {
    inputTokens: number;
    maxAmount: number;
}

/**
 * Hash binding a voucher to one function call. Providers recompute it from the
 * request they receive and compare it to `voucher.invocationHash`.
 * Key order is part of the hashed bytes. `resourceVersion`, the contract version a script pinned, is hashed
 * last and only when set, so a call that pins no version hashes the same bytes as before it existed.
 */
export function invocationHash(
    resourcePath: string,
    resourceName: string,
    functionName: string,
    parameters: ResourceFunctionCallParameter[],
    resourceVersion?: string,
): string {
    return hashData({ resourcePath, resourceName, functionName, parameters, ...(resourceVersion === undefined ? {} : { resourceVersion }) });
}

/**
 * The version a script bound `resource` by, `path.Name@version`, or undefined when it named none. A call to a
 * pinned contract runs that version, here or on its node, rather than whichever is latest when it's called.
 */
export function pinnedVersion(resource: Resource): string | undefined {
    const pinned = resource.metadata?.pinnedVersion;
    return typeof pinned === 'string' ? pinned : undefined;
}

/**
 * The object `createPaymentVoucher` signs: every voucher field except `signature`.
 * Key order is part of the signed bytes.
 */
export function paymentVoucherPayload(voucher: Omit<PaymentVoucher, "signature">) {
    const { requestId, invocationId, amount, recipientOrganizationId, expiresAt, invocationHash, publicKey } = voucher;
    return { requestId, invocationId, amount, recipientOrganizationId, expiresAt, invocationHash, publicKey, ...runPayload(voucher.runId) };
}

/** `runId` is signed last, and only when set, so a voucher without one signs the same bytes as before it existed. */
function runPayload(runId: string | undefined): { runId?: string } {
    return runId === undefined ? {} : { runId };
}

/**
 * The object `createInferenceVoucher` signs: every inference voucher field except `signature`.
 * Key order is part of the signed bytes.
 */
export function inferenceVoucherPayload(voucher: Omit<InferencePaymentVoucher, "signature">) {
    const { kind, requestId, invocationId, maxAmount, inputCostMicroUsdPerMillionTokens, outputCostMicroUsdPerMillionTokens, maxTokens, recipientOrganizationId, expiresAt, invocationHash, publicKey } = voucher;
    return { kind, requestId, invocationId, maxAmount, inputCostMicroUsdPerMillionTokens, outputCostMicroUsdPerMillionTokens, maxTokens, recipientOrganizationId, expiresAt, invocationHash, publicKey, ...runPayload(voucher.runId) };
}

/**
 * The object `createContractVoucher` signs: every contract voucher field except `signature`.
 * Key order is part of the signed bytes.
 */
export function contractVoucherPayload(voucher: Omit<ContractPaymentVoucher, "signature">) {
    const { kind, requestId, invocationId, maxAmount, priceMicroUsdPerMillionTokens, recipientOrganizationId, expiresAt, invocationHash, publicKey } = voucher;
    return { kind, requestId, invocationId, maxAmount, priceMicroUsdPerMillionTokens, recipientOrganizationId, expiresAt, invocationHash, publicKey, ...runPayload(voucher.runId) };
}

export function isContractVoucher(voucher: unknown): voucher is ContractPaymentVoucher {
    return (voucher as ContractPaymentVoucher | undefined)?.kind === 'contract';
}

export function isInferenceVoucher(voucher: PaymentVoucher | InferencePaymentVoucher): voucher is InferencePaymentVoucher {
    return (voucher as InferencePaymentVoucher).kind === 'inference';
}

export const PAYMENT_VOUCHER_LIFETIME_MS = 1000 * 60 * 2;
/** Inference can run for minutes, and the operator refuses a voucher that expired before the provider settled it. */
export const INFERENCE_VOUCHER_LIFETIME_MS = 1000 * 60 * 10;
/** A contract may make inference calls of its own. */
export const CONTRACT_VOUCHER_LIFETIME_MS = INFERENCE_VOUCHER_LIFETIME_MS;

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

/** A script run billed to another organization's API client. Its paid calls draw on the run's hold. */
export interface RunContext {
    runId: string;
}

/** Who a contract is running for, which it reads as the built-in `caller`. */
export interface CallerIdentity {
    /** The organization paying for the call, or null when that isn't known (a node not enrolled in one). */
    org: string | null;
    /** The public key of the node that made the call. */
    node: string;
}

/** The script, request or contract, that calls are made from. */
export interface ScriptContext {
    /** A billed run's id: the run's hold pays the script's paid calls. */
    runId?: string;
    /** What the script reads as `jwt`, which contracts it calls on this node read too. Null when absent. */
    jwt?: unknown;
    /** How many contracts deep the script is: 0 for a request script. */
    depth?: number;
    /** Who the script runs for. Contracts it calls on this node see it as `caller`. */
    caller?: CallerIdentity;
    /** The contracts (`path.Name`) this script runs inside on this node, outermost first. */
    contracts?: string[];
    /**
     * The chain of events the script runs in, when an event started it. It can't call a contract in the chain,
     * here or on another node, which is sent the chain with the call.
     */
    event?: EventLineage;
    /** The running contract's use of `sh.stellarium.money.Account`. A request script has none, and no balance. */
    account?: AccountSession;
    /**
     * The operator run contracts on this node stage `Account` changes on when they aren't billed, shared down a
     * chain of free contract calls so their changes settle together (docs/money.md, Settlement).
     */
    moneyRun?: MoneyRun;
    /**
     * The run's time, in milliseconds, which payable contracts read as `now`. Taken once by the outermost script
     * or contract on this node, so every contract it calls here reads the same.
     */
    now?: number;
    /** For a contract run: the nonce its calls' run tags are made from, and the next call's index, for signed answers. */
    attest?: { nonce: string, next: () => number };
    /** The contract the script is, when it's one: `path.Name@version` and its registered owner. Calls it makes have it as `sender`. */
    self?: { contract: string, owner: string | null };
    /** The chain of contract calls on this node the script runs in, whose state writes wait for its money. */
    state?: { tx: StateTransaction, frame: Frame };
}

/** Contracts may call each other, so each call goes one deeper, and a call past this depth fails. */
export const MAX_CONTRACT_DEPTH = 8;

/** Runs the contracts deployed to this node, for scripts on this node. */
export interface ContractHost {
    /**
     * Runs the contract served as `resource`, one level deeper than `context`. A billed script's call is held
     * from its run's hold, as a call from another node is held from the caller's balance.
     */
    invokeLocal(resource: Resource, parameters: ResourceFunctionCallParameter[], context: ScriptContext, attachmentId?: string): Promise<InvokeResult>;
}

/** How this node calls contracts. */
export interface ContractInvocation {
    /** The most a call to a contract on another node may hold: its voucher's `maxAmount`. */
    costLimitMicroUsd: number;
    /** Runs contracts on this node. Without one, calls to them fail. */
    host?: ContractHost;
}

/** How a node settles its own paid functions when a billed run calls them. */
export interface LocalSettlement {
    operatorClient: OperatorClient;
    /** Keeps the call's capture or release until the operator takes it. */
    outbox: SettlementOutbox;
    /** The organization this node's functions pay. */
    organizationId?: string;
}

export class CombinationResourceInvoker implements ResourceInvoker {

    /**
     * Without a `grantService`, calls to restricted remote functions fail.
     * `inferenceCostLimitMicroUsd` caps an inference voucher's `maxAmount`, and defaults to `costLimitMicroUsd`.
     * Without `localSettlement`, a billed run can't call this node's own paid functions.
     */
    constructor(
        private readonly resourceRepository: ResourceRepository,
        private readonly costLimitMicroUsd: number,
        private readonly publicKey: string,
        private readonly privateKey: string,
        private readonly grantService?: GrantService,
        private readonly inferenceCostLimitMicroUsd: number = costLimitMicroUsd,
        private readonly localSettlement?: LocalSettlement,
    ) {}

    /** Set once the node's contract host exists, since the host calls back into this invoker. */
    contracts?: ContractInvocation;
    /** Serves `sh.stellarium.money.Account`. Without it, its calls fail. */
    money?: AccountService;

    /**
     * An invoker for one billed run. Its paid calls, remote or to this node's own paid functions, carry
     * the run's id, so the run's hold pays for them. The run's hold limits what they cost, in place of the
     * cost limits.
     */
    forRun(run: RunContext): ResourceInvoker {
        return this.forScript(run);
    }

    /**
     * An invoker for one script. With a `runId`, its paid calls are billed to the run as `forRun`'s are.
     * Contracts it calls on this node see its `jwt`.
     */
    forScript(context: ScriptContext): ResourceInvoker {
        return { invoke: (resource, functionName, parameters, attachment) => this.invokeIn(resource, functionName, parameters, context, attachment) };
    }
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
        return this.invokeIn(resource, functionName, parameters, undefined);
    }

    /**
     * The public key of the peer serving from a base URL, which names the node hosting a contract money is
     * attached to. Without it, money can only be attached to this node's contracts.
     */
    peerKey?: (baseUrl: string) => Promise<string | undefined>;

    private async invokeIn(resource: Resource, functionName: string, parameters: ResourceFunctionCallParameter[], context: ScriptContext | undefined, attachment?: CallAttachment): Promise<{ value: any, error: { message: string } | null, usage?: InferenceUsage }> {
        if (resource.metadata.builtin === ACCOUNT_BUILTIN) {
            if (!this.money) {
                return { value: null, error: { message: `Failed to invoke ${resource.name}.${functionName}: this node has no operator to keep balances` } };
            }
            return this.money.invoke(context?.account, functionName, parameters);
        }
        if (resource.metadata.builtin === RANDOM_BUILTIN) {
            if (!this.money) {
                return { value: null, error: { message: `Failed to invoke ${resource.name}.${functionName}: this node has no operator to draw random values` } };
            }
            return this.money.invokeRandom(context?.account, functionName, parameters);
        }
        // Built into every node, so a resource under the path from anywhere else is an impostor.
        if (isMoneyPath(resource.path)) {
            return { value: null, error: { message: `Failed to invoke ${resource.name}.${functionName}: ${resource.path} is reserved for stellarium-ts's built-in resources` } };
        }
        // Money attached to the call is staged on the caller's run before the call is made.
        let attachmentId: string | undefined;
        if (attachment) {
            const staged = await this.stageAttachment(resource, functionName, attachment, context);
            if ('error' in staged) {
                return { value: null, error: { message: staged.error } };
            }
            attachmentId = staged.attachmentId;
        }
        // Only a billed run has a run id. Its hold limits what its calls cost, in place of the cost limits.
        const run = context?.runId === undefined ? undefined : { runId: context.runId };
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
            const contract = isContractFunction(resourceFunction);
            if (manifest && !manifest.recipientOrganizationId) {
                return { value: null, error: { message: `Failed to invoke ${resource.name}.${functionName}: its payment manifest names no recipient organization` } };
            }
            if (contract && context?.event?.contracts.includes(`${resource.path}.${resource.name}`)) {
                return { value: null, error: { message: `Failed to invoke ${resource.name}.${functionName}: it is earlier in this chain of events` } };
            }
            if (contract) {
                // A contract may make paid calls of its own, so a call always carries a voucher, even at a price of 0.
                if (!manifest || !isContractManifest(manifest) || !Number.isSafeInteger(manifest.priceMicroUsdPerMillionTokens) || manifest.priceMicroUsdPerMillionTokens < 0) {
                    return { value: null, error: { message: `Failed to invoke ${resource.name}.${functionName}: it is a contract without a valid price` } };
                }
                const depth = (context?.depth ?? 0) + 1;
                if (depth > MAX_CONTRACT_DEPTH) {
                    return { value: null, error: { message: `Failed to invoke ${resource.name}.${functionName}: contracts may call each other at most ${MAX_CONTRACT_DEPTH} deep` } };
                }
                const costLimit = this.contracts?.costLimitMicroUsd ?? this.costLimitMicroUsd;
                const version = pinnedVersion(resource);
                // A free chain's run, once opened, makes the contract part of its tree, so their money settles together.
                const treeRunId = run?.runId ?? context?.moneyRun?.opened;
                requestBody.paymentVoucher = this.createContractVoucher(manifest.recipientOrganizationId!, manifest.priceMicroUsdPerMillionTokens, costLimit, resource.path, resource.name, functionName, parameters, treeRunId, version);
                if (attachmentId !== undefined) {
                    requestBody.attachmentId = attachmentId;
                }
                // The operator vouches for the calling contract's owner, which the callee reads as `sender.org`.
                if (context?.account) {
                    requestBody.senderContract = context.account.contract;
                }
                if (version !== undefined) {
                    requestBody.resourceVersion = version;
                }
                requestBody.contractDepth = depth;
                if (context?.event) {
                    requestBody.eventLineage = context.event;
                }
            } else if (manifest && inference) {
                console.log(`Resource function ${resource.name}.${functionName} is a paid inference function, creating payment voucher...`);
                // Peers' manifests aren't validated on receipt.
                if (!isInferenceManifest(manifest) || !Number.isSafeInteger(manifest.inputCostMicroUsdPerMillionTokens) || manifest.inputCostMicroUsdPerMillionTokens < 0
                    || !Number.isSafeInteger(manifest.outputCostMicroUsdPerMillionTokens) || manifest.outputCostMicroUsdPerMillionTokens < 0) {
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
                if (!run && estimate.maxAmount > this.inferenceCostLimitMicroUsd) {
                    throw new Error(`Function ${functionName} may cost up to ${estimate.maxAmount} micro-USD, which exceeds the inference cost limit of ${this.inferenceCostLimitMicroUsd} micro-USD`);
                }
                requestBody.paymentVoucher = this.createInferenceVoucher(manifest, estimate.maxAmount, maxTokens, resource.path, resource.name, functionName, parameters, run?.runId);
            } else if (manifest) {
                console.log(`Resource function ${resource.name}.${functionName} has a payment manifest, creating payment voucher...`);
                if (isInferenceManifest(manifest) || isContractManifest(manifest)) {
                    return { value: null, error: { message: `Failed to invoke ${resource.name}.${functionName}: it has per-token pricing but isn't an inference function` } };
                }
                if (!run && manifest.costMicroUsd > this.costLimitMicroUsd) {
                    throw new Error(`Function ${functionName} cost ${manifest.costMicroUsd} micro-USD, which exceeds the cost limit of ${this.costLimitMicroUsd} micro-USD`);
                }
                requestBody.paymentVoucher = this.createPaymentVoucher(manifest.recipientOrganizationId!, manifest.costMicroUsd, resource.path, resource.name, functionName, parameters, run?.runId);
            }

            // A contract run asks for a signed answer, tagged for this provider alone (docs/money.md, Signed responses).
            // When the call fails, the receipt still names the provider and tag, so the operator can ask it.
            let tag: { runTag: string, callIndex: number, publicKey: string } | undefined;
            if (context?.attest) {
                const providerKey = await this.peerKey?.(url);
                if (providerKey) {
                    tag = { runTag: hashData({ nonce: context.attest.nonce, provider: providerKey }), callIndex: context.attest.next(), publicKey: providerKey };
                    requestBody.attestation = { runTag: tag.runTag, callIndex: tag.callIndex };
                }
            }
            const unanswered = (message: string) => ({ value: null, error: { message }, ...(tag ? { attestation: { ...tag, failed: true } } : {}) });

            // The voucher is created once and reused on every attempt, so the operator's
            // requestId/invocationId check prevents a retried call from being settled twice.
            // The authorization is signed per attempt, since the provider refuses a reused nonce.
            let result: Response;
            try {
                result = await fetchWithRetry(`${url}/v1/run/resource`, () => ({
                    method: 'POST',
                    body: JSON.stringify(chain && this.grantService ? { ...requestBody, authorization: this.grantService.authorize(chain, target) } : requestBody),
                    headers: {
                        'Content-Type': 'application/json',
                    },
                }), inference || contract ? INFERENCE_INVOKE_TIMEOUT_MS : EXTERNAL_INVOKE_TIMEOUT_MS);
            } catch (error) {
                if (!tag) throw error;
                return unanswered(`Failed to invoke ${resource.name}.${functionName}: ${error instanceof Error ? error.message : String(error)}`);
            }

            if (!result.ok) {
                // The provider's JSON error is more useful than the status text, which can be empty.
                const detail = await result.json().then((body) => (body as { error?: unknown } | null)?.error, () => undefined);
                const reason = typeof detail === 'string' ? detail : `${result.status} ${result.statusText}`.trim();
                return unanswered(`Failed to invoke ${resource.name}.${functionName}: ${reason}`);
            }

            const data = await result.json() as { value: any, error: { message: string } | null, attestation?: unknown };
            return { value: data.value, error: data.error, ...(data.attestation ? { attestation: data.attestation } : {}) };
        } else {
            const fn = resource.functions.find(f => f.name === functionName) as StellariumResourceFunction | undefined;
            if (!fn) {
                return { value: null, error: { message: `Function ${functionName} not found in resource ${resource.name}` } };
            }
            if (isContractFunction(fn)) {
                if (!this.contracts?.host) {
                    return { value: null, error: { message: `Failed to invoke ${resource.name}.${fn.name}: this node doesn't run contracts` } };
                }
                if (context?.event?.contracts.includes(`${resource.path}.${resource.name}`)) {
                    return { value: null, error: { message: `Failed to invoke ${resource.name}.${fn.name}: it is earlier in this chain of events` } };
                }
                return this.contracts.host.invokeLocal(resource, parameters, context ?? {}, attachmentId);
            }
            // A billed run pays for this node's own paid functions as a remote caller would.
            if (run && fn.paymentManifest) {
                return this.invokeLocalPaid(resource, fn, parameters, run);
            }
            return this.execLocal(fn, parameters);
        }
    }

    private async execLocal(fn: StellariumResourceFunction, parameters: ResourceFunctionCallParameter[]): Promise<InvokeResult> {
        const result = await fn.exec(parameters);
        if (isInferenceFunction(fn)) {
            const inferenceResult = parseInferenceResult(result);
            if (!inferenceResult) {
                return { value: null, error: { message: `Inference function ${fn.name} must return { value, usage: { inputTokens, outputTokens } }` } };
            }
            return { value: inferenceResult.value, error: null, usage: inferenceResult.usage };
        }
        return { value: result, error: null };
    }

    /**
     * Calls one of this node's paid functions for a billed run: signs a voucher with the run's id that pays
     * this node's organization, then authorizes, runs and settles it as `POST /v1/run/resource` would.
     */
    private async invokeLocalPaid(resource: Resource, fn: StellariumResourceFunction, parameters: ResourceFunctionCallParameter[], run: RunContext): Promise<InvokeResult> {
        const failed = (reason: string) => ({ value: null, error: { message: `Failed to invoke ${resource.name}.${fn.name}: ${reason}` } });
        const organizationId = this.localSettlement?.organizationId;
        if (!this.localSettlement || !organizationId) {
            return failed('this node is not enrolled in an organization that can be paid');
        }
        const manifest = fn.paymentManifest!;
        let voucher: PaymentVoucher | InferencePaymentVoucher;
        if (isInferenceFunction(fn) && isInferenceManifest(manifest)) {
            const maxTokens = parseMaxTokens(parameters);
            if (maxTokens === undefined) {
                return failed('maxTokens must be a positive int32');
            }
            const inputTokens = await estimateInputTokens(fn, parameters);
            if (inputTokens === undefined) {
                return failed('failed to estimate input tokens');
            }
            const maxAmount = inferenceCharge(manifest, inputTokens, maxTokens);
            voucher = this.createInferenceVoucher({ ...manifest, recipientOrganizationId: organizationId }, maxAmount, maxTokens, resource.path, resource.name, fn.name, parameters, run.runId);
        } else if (!isInferenceManifest(manifest) && !isContractManifest(manifest)) {
            voucher = this.createPaymentVoucher(organizationId, (manifest as StellariumFixedPaymentManifest).costMicroUsd, resource.path, resource.name, fn.name, parameters, run.runId);
        } else {
            return failed('it has per-token pricing but isn\'t an inference function');
        }
        const result = await settlePaidCall(this.localSettlement.operatorClient, this.localSettlement.outbox, voucher, () => this.execLocal(fn, parameters));
        return 'refused' in result ? failed(result.refused.error) : result;
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

    /**
     * Stages money attached to a call to a contract, on the caller's run. Only a pinned version of a contract
     * can be paid, which the interpreter has checked.
     */
    private async stageAttachment(resource: Resource, functionName: string, attachment: CallAttachment, context: ScriptContext | undefined): Promise<{ attachmentId: string } | { error: string }> {
        const failed = (reason: string) => {
            const error = `Failed to invoke ${resource.name}.${functionName}: ${reason}`;
            if (context?.account) context.account.failure ??= error;
            else if (context?.moneyRun) context.moneyRun.failure ??= error;
            return { error };
        };
        if (!this.money) return failed('this node has no operator to move money');
        const fn = resource.functions.find(candidate => candidate.name === functionName) as StellariumResourceFunction | undefined;
        const version = pinnedVersion(resource);
        if (!fn || !isContractFunction(fn) || version === undefined) return failed('money can only be attached to a call to a pinned contract version');
        const baseUrl = resource.metadata.baseUrl as string | undefined;
        const nodePublicKey = baseUrl ? await this.peerKey?.(baseUrl) : this.publicKey;
        if (!nodePublicKey) return failed('the node hosting the contract isn\'t known');
        return this.money.attach(context?.account, context?.moneyRun, { nodePublicKey, name: `${resource.path}.${resource.name}`, version }, attachment);
    }

    /** With `runId`, the voucher is paid from that run's hold. */
    createPaymentVoucher(recipientOrganizationId: string, amount: number, resourcePath: string, resourceName: string, functionName: string, parameters: ResourceFunctionCallParameter[], runId?: string): PaymentVoucher {
        const unsigned: Omit<PaymentVoucher, "signature"> = {
            requestId: crypto.randomUUID(),
            invocationId: crypto.randomUUID(),
            amount,
            recipientOrganizationId,
            expiresAt: new Date(Date.now() + PAYMENT_VOUCHER_LIFETIME_MS).toISOString(),
            invocationHash: invocationHash(resourcePath, resourceName, functionName, parameters),
            publicKey: this.publicKey,
            ...runPayload(runId),
        };
        return { ...unsigned, signature: signData(paymentVoucherPayload(unsigned), this.privateKey) };
    }

    /** With `runId`, the voucher is paid from that run's hold. */
    createInferenceVoucher(manifest: StellariumInferencePaymentManifest, maxAmount: number, maxTokens: number, resourcePath: string, resourceName: string, functionName: string, parameters: ResourceFunctionCallParameter[], runId?: string): InferencePaymentVoucher {
        const unsigned: Omit<InferencePaymentVoucher, "signature"> = {
            kind: 'inference',
            requestId: crypto.randomUUID(),
            invocationId: crypto.randomUUID(),
            maxAmount,
            inputCostMicroUsdPerMillionTokens: manifest.inputCostMicroUsdPerMillionTokens,
            outputCostMicroUsdPerMillionTokens: manifest.outputCostMicroUsdPerMillionTokens,
            maxTokens,
            recipientOrganizationId: manifest.recipientOrganizationId!,
            expiresAt: new Date(Date.now() + INFERENCE_VOUCHER_LIFETIME_MS).toISOString(),
            invocationHash: invocationHash(resourcePath, resourceName, functionName, parameters),
            publicKey: this.publicKey,
            ...runPayload(runId),
        };
        return { ...unsigned, signature: signData(inferenceVoucherPayload(unsigned), this.privateKey) };
    }

    /**
     * With `runId`, the run's hold pays, and the contract's run is held from it. With `resourceVersion`, the
     * voucher pays only for a call to that version.
     */
    createContractVoucher(recipientOrganizationId: string, priceMicroUsdPerMillionTokens: number, maxAmount: number, resourcePath: string, resourceName: string, functionName: string, parameters: ResourceFunctionCallParameter[], runId?: string, resourceVersion?: string): ContractPaymentVoucher {
        const unsigned: Omit<ContractPaymentVoucher, "signature"> = {
            kind: 'contract',
            requestId: crypto.randomUUID(),
            invocationId: crypto.randomUUID(),
            maxAmount,
            priceMicroUsdPerMillionTokens,
            recipientOrganizationId,
            expiresAt: new Date(Date.now() + CONTRACT_VOUCHER_LIFETIME_MS).toISOString(),
            invocationHash: invocationHash(resourcePath, resourceName, functionName, parameters, resourceVersion),
            publicKey: this.publicKey,
            ...runPayload(runId),
        };
        return { ...unsigned, signature: signData(contractVoucherPayload(unsigned), this.privateKey) };
    }
}
