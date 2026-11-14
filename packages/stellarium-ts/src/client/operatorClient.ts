import type { ContractPaymentVoucher } from "../resource/invoker.js";
import { operatorAuthorization } from "./operatorAuth.js";

// Wire formats match PaymentVoucher and InferencePaymentVoucher in resource/invoker.ts,
// and the voucher types in apps/operator/src/payments/types.ts.
export type PaymentSubmission = FixedPaymentSubmission | InferencePaymentSubmission;

export interface FixedPaymentVoucher {
    kind?: undefined;
    requestId: string;
    invocationId: string;
    amount: number;
    recipientOrganizationId: string;
    signature: string;
    expiresAt: string;
    invocationHash: string;
    publicKey: string;
    runId?: string;
}

export interface InferenceVoucher {
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
    runId?: string;
}

export interface FixedPaymentSubmission {
    voucher: FixedPaymentVoucher;
}

/** The provider reports the call's usage; the operator charges it at the voucher's rates, up to the held `maxAmount`. */
export interface InferencePaymentSubmission {
    voucher: InferenceVoucher;
    usage: {
        inputTokens: number;
        outputTokens: number;
    };
}

/** Whether the operator placed a hold for a voucher. A refusal carries the operator's status and error. */
export type AuthorizeResult = { ok: true } | { ok: false, status: number, error: string };

/** What a node sends to authorize a script run billed to an API client. Matches apps/operator/src/runs/runService.ts. */
export interface RunAuthorizationRequest {
    /** The run token the caller presented. */
    token: string;
    runId: string;
    source: string;
}

/** What a node sends to authorize a call to one of its contracts. Matches apps/operator/src/runs/runService.ts. */
export interface ContractRunAuthorizationRequest {
    /** The caller's voucher. Its `invocationId` is the run's id. */
    voucher: ContractPaymentVoucher;
    /** The contract's source, which the operator prices. */
    source: string;
    /** The calling contract, when a contract made the call: the operator answers with its registered owner as `sender`. */
    senderContract?: { name: string, version: string };
}

/** Who made a contract call, as a payable contract reads it (docs/money.md, Who is calling). */
export interface CallSender {
    /** The run's organization for a request script, or the calling contract's registered owner, null when it has none. */
    org: string | null;
    node: string;
    /** The calling contract as `path.Name@version`, or null for a request script. */
    contract: string | null;
}

/**
 * The operator's answer to a contract call: a hold for the run named by the voucher's `invocationId`, or
 * `free` when the caller is in this node's organization, which doesn't pay itself. `payerOrganizationId` is
 * the organization paying for the call, which the contract sees as `caller.org`. Older operators omit it.
 */
/** `now` is the time the run's tree started, from the operator's stamp, when the run has a tree. */
export type ContractRunAuthorizeResult = { ok: true, free: boolean, payerOrganizationId?: string, now?: number, sender?: Omit<CallSender, 'node'> } | { ok: false, status: number, error: string };

/** What the operator knows of this node. */
export interface OperatorSession {
    organizationId: string;
    /** The node's listed price per million script tokens. Absent from older operators. */
    priceMicroUsdPerMillionTokens?: number;
    /**
     * The operator's signed statement that this node belongs to its organization, which it attaches to the events
     * it publishes. Absent from operators without run tokens, and from older ones.
     */
    membershipToken?: string;
}

/** What a node sends to run an event contract for another organization. Matches apps/operator/src/runs/runService.ts. */
export interface EventRunAuthorizationRequest {
    /** From `createEventMandate`, when the contract was deployed. */
    mandateId: string;
    runId: string;
    /** The event contract's source, which the operator prices. */
    source: string;
}

/** The operator's hold for a run: up to `heldMicroUsd` for the script's tokens and its paid calls together. */
export type RunAuthorizeResult = { ok: true, heldMicroUsd: number, maxTokens: number, now?: number } | { ok: false, status: number, error: string };

/** The sender the operator vouched for, when it answered with one. */
function senderOf(body: unknown): { sender?: Omit<CallSender, 'node'> } {
    const sender = (body as { sender?: { org?: unknown, contract?: unknown } } | undefined)?.sender;
    if (!sender || (sender.org !== null && typeof sender.org !== 'string') || (sender.contract !== null && typeof sender.contract !== 'string')) return {};
    return { sender: { org: sender.org as string | null, contract: sender.contract as string | null } };
}

/** The operator's stamp for a run's tree, when it answered with one. */
function stampOf(body: unknown): { now?: number } {
    const now = (body as { now?: unknown } | undefined)?.now;
    return typeof now === 'number' && Number.isSafeInteger(now) ? { now } : {};
}

export const OPERATOR_MAX_RETRIES = 5;
/** Authorization runs while the caller waits, so it gives up much sooner than capture and release. */
export const AUTHORIZE_MAX_RETRIES = 2;
export const OPERATOR_BASE_DELAY_MS = 1000;
export const AUTHORIZE_BASE_DELAY_MS = 200;
/** Per attempt. A timed-out attempt is retried like a network error. */
export const OPERATOR_TIMEOUT_MS = 10_000;

/**
 * Transient failures. Resending is safe even if an earlier attempt reached the operator: every payment
 * request is idempotent per voucher (requestId, invocationId).
 * Rejections (400, 401, 402, 403, 404, 409, 422) are not retried because they won't change.
 */
const RETRYABLE_STATUSES = new Set([408, 429, 500, 502, 503, 504]);

/**
 * Delay before retry `attempt` (0-based): exponential backoff from `baseDelayMs`,
 * or the operator's `Retry-After` seconds when that is longer.
 */
function retryDelayMs(response: Response | undefined, attempt: number, baseDelayMs: number): number {
    const backoff = baseDelayMs * 2 ** attempt;
    const retryAfterSeconds = Number(response?.headers.get('retry-after') ?? NaN);
    return Number.isFinite(retryAfterSeconds) ? Math.max(backoff, retryAfterSeconds * 1000) : backoff;
}

async function errorMessage(response: Response): Promise<string> {
    const body = await response.json().catch(() => undefined) as { error?: unknown } | undefined;
    return typeof body?.error === 'string' ? body.error : `${response.status} ${response.statusText}`.trim();
}

/** A contract version on a node (docs/money.md). Copied as `ContractRef` in the operator's money/moneyService.ts. */
export interface MoneyContractRef {
    nodePublicKey: string;
    /** path.Name */
    name: string;
    version: string;
}

/** A contract version this node registers with the operator. Copied as `ContractRegistration` in the operator. */
export interface ContractRegistrationRequest {
    name: string;
    version: string;
    payable: boolean;
    source: string;
    requestscriptVersion: string;
    dependencies: MoneyContractRef[];
    /** The deploying API client's run token, whose organization owns the contract. Omitted for an API-key deploy. */
    token?: string;
}

/**
 * One money change staged on a run (docs/money.md, How a node serves Account): money attached to a call, or an
 * `Account` call. `contract` is the contract on this node whose account it changes, omitted only for money a
 * request script attaches. Copied as `StageRequest` in the operator's money/moneyService.ts.
 */
export type MoneyStageRequest = { runId: string, callIndex: number, contract?: { name: string, version: string } } & (
    | { function: 'attach', parameters: { to: MoneyContractRef, amount: number, attachmentId: string, payees?: string[], from?: string, key?: string | null } }
    | { function: 'earmark', parameters: { attachmentId: string, key: string } }
    | { function: 'pay', parameters: { to: string, amount: number, from: string, key?: string | null, try?: boolean } }
    | { function: 'refund', parameters: { to: string, amount: number, key?: string | null } }
    | { function: 'random_request', parameters: { key: string } }
);

/** An `Account` read. Copied as `MoneyReadRequest` in the operator. */
export type MoneyReadRequest = { runId: string, callIndex: number, contract: { name: string, version: string } } & (
    | { function: 'balance', parameters: Record<string, never> }
    | { function: 'fundingOf', parameters: { org: string, key?: string | null } }
    | { function: 'canReceive', parameters: { org: string } }
    | { function: 'attachment', parameters: { attachmentId: string } }
    | { function: 'random', parameters: { key: string } }
);

/** Money attached to a call, as the operator staged it: what the receiving contract reads as `payment`. */
export interface AttachmentRead {
    amount: number;
    from: string;
    payees: string[];
}

/** The operator's signed answer to a read, signed over `moneyReadPayload` with its run token key. */
export interface SignedMoneyRead {
    response: number | boolean | AttachmentRead;
    signedAt: string;
    signature: string;
    publicKey: string;
}

/** The signed fields of an `Account` read, in order. Copied from the operator's money/moneyService.ts. */
export function moneyReadPayload(read: { runId: string, callIndex: number, function: string, parameters: object, response: unknown, signedAt: string }) {
    const { runId, callIndex, function: fn, parameters, response, signedAt } = read;
    return { runId, callIndex, function: fn, parameters, response, signedAt };
}

/** What happened to the money changes in a run's tree: still undecided, applied, or dropped. */
export type TreeOutcome = 'pending' | 'applied' | 'dropped';

type Refusal = { ok: false, status: number, error: string };

/** Whether the operator accepted a capture or release. A `retryable` refusal was transient. */
export type SettleResult = { ok: true } | { ok: false, status: number, error: string, retryable: boolean };

/** Talks to the operator as this node. Every request is signed with the node's key. */
export class OperatorClient {
    constructor(private readonly url: string | undefined, private readonly publicKey: string, private readonly privateKey: string) {}

    /**
     * POSTs `body`, retrying `RETRYABLE_STATUSES` and network errors up to `retries` times.
     * Each attempt is signed afresh, since the operator only accepts recent timestamps.
     * Throws the last network error if the operator could not be reached, or if no operator URL is configured.
     */
    private async post(path: string, body: unknown, retries: number, baseDelayMs: number): Promise<Response> {
        if (!this.url) {
            throw new Error('No operator URL is configured');
        }
        const url = `${this.url}${path}`;
        const serialized = JSON.stringify(body);
        for (let attempt = 0; ; attempt++) {
            let retryable: Response | undefined;
            try {
                const response = await fetch(url, {
                    method: 'POST',
                    body: serialized,
                    headers: {
                        'Content-Type': 'application/json',
                        Authorization: operatorAuthorization('POST', url, body, this.publicKey, this.privateKey),
                    },
                    signal: AbortSignal.timeout(OPERATOR_TIMEOUT_MS),
                });
                if (!RETRYABLE_STATUSES.has(response.status) || attempt >= retries) {
                    return response;
                }
                retryable = response;
            } catch (error) {
                if (attempt >= retries) {
                    throw error;
                }
            }
            await new Promise(resolve => setTimeout(resolve, retryDelayMs(retryable, attempt, baseDelayMs)));
        }
    }

    /**
     * Returns the organization this node is enrolled in. With an `enrollmentToken` from the dashboard,
     * enrolls the node first; a node that is already enrolled ignores the token. Throws if the node is
     * not enrolled or the operator refuses.
     */
    async session(enrollmentToken?: string, baseUrl?: string): Promise<OperatorSession> {
        const body = { ...(enrollmentToken ? { enrollmentToken } : {}), ...(baseUrl ? { baseUrl } : {}) };
        const response = await this.post('/nodes/session', body, OPERATOR_MAX_RETRIES, OPERATOR_BASE_DELAY_MS);
        if (!response.ok) {
            throw new Error(`Operator refused this node's session: ${await errorMessage(response)}`);
        }
        return await response.json() as OperatorSession;
    }

    /**
     * Asks the operator to hold the voucher's amount (or `maxAmount`) on the payer's balance, before
     * running the paid function. An unreachable operator is reported as a 503 refusal.
     */
    async authorize(voucher: FixedPaymentVoucher | InferenceVoucher): Promise<AuthorizeResult> {
        const result = await this.hold('/payments/authorize', { voucher });
        return result.ok ? { ok: true } : result;
    }

    /**
     * Asks the operator to hold a script run's cost on the paying API client's organization, before running
     * it. An unreachable operator is reported as a 503 refusal.
     */
    async authorizeRun(request: RunAuthorizationRequest): Promise<RunAuthorizeResult> {
        const result = await this.hold('/runs/authorize', request);
        if (!result.ok) return result;
        const { heldMicroUsd, maxTokens } = result.body as { heldMicroUsd: number, maxTokens: number };
        return { ok: true, heldMicroUsd, maxTokens, ...stampOf(result.body) };
    }

    /**
     * Asks the operator to hold a contract call's cost on the caller's organization, or on the caller's run,
     * before running the contract. An unreachable operator is reported as a 503 refusal.
     */
    async authorizeContractRun(request: ContractRunAuthorizationRequest): Promise<ContractRunAuthorizeResult> {
        const result = await this.hold('/runs/contract/authorize', request);
        if (!result.ok) return result;
        const body = result.body as { status?: unknown, payerOrganizationId?: unknown } | undefined;
        return {
            ok: true,
            free: body?.status === 'free',
            ...(typeof body?.payerOrganizationId === 'string' ? { payerOrganizationId: body.payerOrganizationId } : {}),
            ...stampOf(result.body),
            ...senderOf(result.body),
        };
    }

    /**
     * Asks the operator to let this node run an event contract that another organization's API client is
     * deploying, billed to that organization. `token` is the client's run token. Returns the mandate's id, or
     * the operator's refusal.
     */
    async createEventMandate(request: { token: string, consumer: string }): Promise<{ ok: true, mandateId: string } | { ok: false, status: number, error: string }> {
        const result = await this.hold('/runs/event/mandates', request);
        if (!result.ok) return result;
        const mandateId = (result.body as { mandateId?: unknown } | undefined)?.mandateId;
        return typeof mandateId === 'string' ? { ok: true, mandateId } : { ok: false, status: 502, error: 'The operator answered without a mandate' };
    }

    /** Asks the operator to hold a run of an event contract under its mandate, before running it with an event. */
    async authorizeEventRun(request: EventRunAuthorizationRequest): Promise<RunAuthorizeResult> {
        const result = await this.hold('/runs/event/authorize', request);
        if (!result.ok) return result;
        const { heldMicroUsd, maxTokens } = result.body as { heldMicroUsd: number, maxTokens: number };
        return { ok: true, heldMicroUsd, maxTokens, ...stampOf(result.body) };
    }

    /**
     * Charges a held run for the tokens its script executed, and releases the rest of its hold. With `failed`,
     * the money changes the run and the runs below it staged are dropped (docs/money.md, Settlement).
     */
    async captureRun(request: { runId: string, tokens: number, failed?: boolean }): Promise<SettleResult> {
        return this.settle('/runs/capture', request);
    }

    /**
     * Opens a run, holding nothing, for a script this node runs for itself, so it can move money. `now` is when the
     * node started the script, which becomes the tree's time.
     */
    async openRun(request: { runId: string, now?: number }): Promise<{ ok: true } | Refusal> {
        const result = await this.hold('/runs/open', request);
        return result.ok ? { ok: true } : result;
    }

    /** Registers a contract version this node hosts, with its owner, source and dependencies (docs/money.md, Registration). */
    async registerContract(request: ContractRegistrationRequest): Promise<{ ok: true } | Refusal> {
        const result = await this.hold('/money/contracts', request);
        return result.ok ? { ok: true } : result;
    }

    /** Stages a money change on a run. A refusal fails the run. Idempotent per run and call index. */
    async stageMoney(request: MoneyStageRequest): Promise<{ ok: true, result: number | boolean | null } | Refusal> {
        const result = await this.hold('/money/stage', request);
        if (!result.ok) return result;
        return { ok: true, result: (result.body as { result?: number | boolean | null } | undefined)?.result ?? null };
    }

    /** Reads a contract's account with the run's tree's staged changes applied, signed by the operator. */
    async readMoney(request: MoneyReadRequest): Promise<{ ok: true, read: SignedMoneyRead } | Refusal> {
        const result = await this.hold('/money/read', request);
        return result.ok ? { ok: true, read: result.body as SignedMoneyRead } : result;
    }

    /** Sends receipts of contract runs in the tree of `runId` for the operator to replay, signed by this node. */
    async submitReceipts(request: { runId: string, receipts: unknown[], signature: string }): Promise<SettleResult> {
        return this.settle('/runs/receipts', request);
    }

    /** Whether the money changes in the run's tree were applied, so this node saves or discards pending state. */
    async runOutcome(request: { runId: string }): Promise<{ ok: true, outcome: TreeOutcome } | Refusal> {
        const result = await this.hold('/runs/outcome', request);
        return result.ok ? { ok: true, outcome: (result.body as { outcome: TreeOutcome }).outcome } : result;
    }

    /** Releases a held run without charging it, for a script this node failed to run. */
    async releaseRun(request: { runId: string }): Promise<SettleResult> {
        return this.settle('/runs/release', request);
    }

    /** Authorization runs while the caller waits, so it retries briefly and reports an unreachable operator as 503. */
    private async hold(path: string, body: unknown): Promise<{ ok: true, body: unknown } | { ok: false, status: number, error: string }> {
        let response: Response;
        try {
            response = await this.post(path, body, AUTHORIZE_MAX_RETRIES, AUTHORIZE_BASE_DELAY_MS);
        } catch (error) {
            console.error(`Failed to reach the operator for ${path}`, error);
            return { ok: false, status: 503, error: 'Payment operator is unavailable' };
        }
        if (response.ok) {
            return { ok: true, body: await response.json().catch(() => undefined) };
        }
        // Retries ran out on a transient failure: the caller may try again later.
        const status = RETRYABLE_STATUSES.has(response.status) ? 503 : response.status;
        return { ok: false, status, error: await errorMessage(response) };
    }

    /** Charges a held voucher: its amount, or for inference the reported usage capped at the hold. */
    async capture(payment: PaymentSubmission): Promise<SettleResult> {
        return this.settle('/payments/capture', payment);
    }

    /** Releases a held voucher without charging it, for a call that failed or cost nothing. */
    async release(voucher: FixedPaymentVoucher | InferenceVoucher): Promise<SettleResult> {
        return this.settle('/payments/release', { voucher });
    }

    /**
     * Answers the operator's refusal, marked `retryable` when it was transient and the retries ran out. Throws
     * only if the operator can't be reached. The settlement outbox retries what this couldn't deliver.
     */
    private async settle(path: string, body: unknown): Promise<SettleResult> {
        const response = await this.post(path, body, OPERATOR_MAX_RETRIES, OPERATOR_BASE_DELAY_MS);
        if (response.ok) {
            return { ok: true };
        }
        return { ok: false, status: response.status, error: await errorMessage(response), retryable: RETRYABLE_STATUSES.has(response.status) };
    }
}
