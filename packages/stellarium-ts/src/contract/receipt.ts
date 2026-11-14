import { Decimal, type CallAttachment, type EmittedEvent, type InterpretResult, type Resource, type ResourceFunctionCallParameter, type ResourceInvoker, type StateScope, type StateStore, type StateWrite, type StoredState, type StructResolver, type StructType } from "requestscript";
import type { AttachmentRead, CallSender } from "../client/operatorClient.js";

/**
 * What one contract run did, for the operator to replay (docs/money.md, Transcripts). Copied as `RunReceipt` in
 * the operator's verification/receipt.ts. Host values are in `encodeHostValue`'s form.
 */
export interface RunReceipt {
    contract: { name: string, version: string, sourceHash: string };
    /** What the run's calls' tags were made from: each provider's is `hashData({ nonce, provider })`. */
    nonce: string;
    inputs: {
        parameters: Record<string, unknown>;
        /** The money attached to the call, as the operator answered for it, and the attachment it read. */
        payment: (AttachmentRead & { attachmentId: string, money: MoneyCallRef }) | null;
        now: number | null;
        sender: CallSender | null;
        caller: unknown;
        jwt: unknown;
        event: unknown;
    };
    /** Every state variable the run read, as it was given: stored, written earlier in its chain, or absent (null). */
    stateReads: { name: string, scope: StateScope, stored: StoredState | null }[];
    /** Every resource call, in order, with what it returned. */
    calls: ReceiptCall[];
    /** The definitions of the structs the run resolved, which the replay resolves the same way. */
    structs: StructType[];
    outputs: { returnValue: unknown, state: StateWrite[], events: EmittedEvent[], tokens: number };
}

/** The operator run and call index a money call used: where its change was staged, or its answer signed. */
export interface MoneyCallRef {
    runId: string;
    callIndex: number;
}

export interface ReceiptCall {
    /** `path.Name`, with the version the script bound, if any. */
    resource: string;
    version?: string;
    function: string;
    /** The function's signature as the run saw it, which the replay converts arguments and results with. */
    signature: { parameters: { name: string, type: string }[], returnType: string };
    parameters: ResourceFunctionCallParameter[];
    attachment?: CallAttachment;
    response: { value: unknown, error: { message: string } | null };
    /** For `sh.stellarium.money.Account` calls and attached money: the operator call it made. */
    money?: MoneyCallRef;
    /** A remote provider's signed answer, or for a call that failed, the provider and tag it went to. */
    attestation?: unknown;
    /** A resource on the host itself, whose answers only the host vouches for. */
    local?: true;
    /** A contract on the host itself, which its own receipt accounts for. */
    localContract?: true;
}

/** The fields of a receipts submission a node signs, in order. Copied in the operator. */
export function receiptsPayload(runId: string, receipts: RunReceipt[]) {
    return { runId, receipts };
}

/** A host value as exact JSON: an int64 (bigint) as `{ "$int64": "..." }`, a decimal as `{ "$decimal": "..." }`. */
export function encodeHostValue(value: unknown): unknown {
    if (typeof value === 'bigint') return { $int64: value.toString() };
    if (value instanceof Decimal) return { $decimal: value.toString() };
    if (Array.isArray(value)) return value.map(encodeHostValue);
    if (value !== null && typeof value === 'object') {
        return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, encodeHostValue(entry)]));
    }
    return value;
}

/**
 * Records a contract run as it happens: wraps the invoker and the state store the interpreter is given. A money
 * call's operator call index comes from `ledger`, which the run's `AccountSession` appends to.
 */
export class ReceiptRecorder {
    readonly stateReads: RunReceipt['stateReads'] = [];
    readonly calls: ReceiptCall[] = [];
    readonly structs: StructType[] = [];

    structResolver(inner: StructResolver): StructResolver {
        return {
            resolve: async (path, name, version) => {
                const struct = await inner.resolve(path, name, version);
                if (struct && !this.structs.some(known => known.path === struct.path && known.name === struct.name && known.version === struct.version)) {
                    this.structs.push({ path: struct.path, name: struct.name, version: struct.version, fields: struct.fields.map(({ name, type }) => ({ name, type })) });
                }
                return struct;
            },
        };
    }

    /** Random per run, so providers can't match their logs to piece a run together. */
    readonly nonce = crypto.randomUUID();
    private nextCall = 0;
    /** What the invoker tags this run's remote calls with. */
    readonly attest = { nonce: this.nonce, next: () => this.nextCall++ };

    constructor(private readonly ledger: MoneyCallRef[]) {}

    invoker(inner: ResourceInvoker): ResourceInvoker {
        return {
            invoke: async (resource: Resource, functionName: string, parameters: ResourceFunctionCallParameter[], attachment?: CallAttachment) => {
                const before = this.ledger.length;
                const response = attachment === undefined
                    ? await inner.invoke(resource, functionName, parameters)
                    : await inner.invoke(resource, functionName, parameters, attachment);
                const fn = resource.functions.find(candidate => candidate.name === functionName);
                const money = this.ledger[before];
                this.calls.push({
                    resource: `${resource.path}.${resource.name}`,
                    ...(typeof (resource.metadata as { pinnedVersion?: unknown }).pinnedVersion === 'string' ? { version: (resource.metadata as { pinnedVersion: string }).pinnedVersion } : {}),
                    function: functionName,
                    signature: { parameters: (fn?.parameters ?? []).map(({ name, type }) => ({ name, type })), returnType: fn?.returnType ?? 'void' },
                    parameters: encodeHostValue(parameters) as ResourceFunctionCallParameter[],
                    ...(attachment === undefined ? {} : { attachment }),
                    response: { value: encodeHostValue(response.value), error: response.error ? { message: response.error.message } : null },
                    ...(money ? { money } : {}),
                    ...(resource.metadata.baseUrl ? {} : (fn as { kind?: string } | undefined)?.kind === 'contract' ? { localContract: true as const } : { local: true as const }),
                    ...((response as { attestation?: unknown }).attestation ? { attestation: (response as { attestation?: unknown }).attestation } : {}),
                });
                return response;
            },
        };
    }

    stateStore(inner: StateStore): StateStore {
        return {
            get: async (name, scope) => {
                const stored = await inner.get(name, scope);
                this.stateReads.push({ name, scope, stored: stored ?? null });
                return stored;
            },
        };
    }

    receipt(contract: RunReceipt['contract'], inputs: RunReceipt['inputs'], result: InterpretResult, tokens: number): RunReceipt {
        return {
            contract,
            nonce: this.nonce,
            inputs,
            stateReads: this.stateReads,
            calls: this.calls,
            structs: this.structs,
            outputs: { returnValue: result.returnValue, state: result.state, events: result.events, tokens },
        };
    }
}
