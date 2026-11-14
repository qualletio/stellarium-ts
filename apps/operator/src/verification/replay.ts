import {
    type CallAttachment, createStructResolver, Decimal, interpretParsed, parseScript, RequestScriptError, type Resource,
    type ResourceFunctionCallParameter, type StateScope, TokenMeter,
} from "requestscript";
import requestscriptPackage from "requestscript/package.json" with { type: "json" };

/**
 * What one contract run did, as its host recorded it. A copy of stellarium-ts's `RunReceipt`
 * (packages/stellarium-ts/src/contract/receipt.ts): keep them in sync. Host values are in `encodeHostValue`'s
 * form there: an int64 as `{ "$int64": "..." }`, a decimal as `{ "$decimal": "..." }`.
 */
export interface RunReceipt {
    contract: { name: string, version: string, sourceHash: string };
    nonce: string;
    inputs: {
        parameters: Record<string, unknown>;
        payment: { amount: number, from: string, payees: string[], attachmentId: string, money: MoneyCallRef } | null;
        now: number | null;
        sender: { org: string | null, node: string, contract: string | null } | null;
        caller: unknown;
        jwt: unknown;
        event: unknown;
    };
    stateReads: { name: string, scope: StateScope, stored: { value: unknown, type: string, version?: unknown } | null }[];
    calls: ReceiptCall[];
    structs: { path: string, name: string, version: string, fields: { name: string, type: string }[] }[];
    outputs: { returnValue: unknown, state: { name: string, scope: StateScope, value: unknown, type: string, version?: unknown }[], events: unknown[], tokens: number };
}

export interface MoneyCallRef {
    runId: string;
    callIndex: number;
}

export interface ReceiptCall {
    resource: string;
    version?: string;
    function: string;
    signature: { parameters: { name: string, type: string }[], returnType: string };
    parameters: ResourceFunctionCallParameter[];
    attachment?: CallAttachment;
    response: { value: unknown, error: { message: string } | null };
    money?: MoneyCallRef;
    attestation?: CallAttestation;
    local?: true;
    localContract?: true;
}

/** A provider's signed answer to a call in a contract run, or for a call that failed, where it went. */
export interface CallAttestation {
    runTag: string;
    callIndex: number;
    publicKey: string;
    invocationHash?: string;
    signedAt?: string;
    signature?: string;
    failed?: true;
}

/** The fields of a provider's signed answer, in order: stellarium-ts's `resourceResponsePayload` (resource/served.ts). */
export function resourceResponsePayload(answer: { runTag: string, callIndex: number, invocationHash: string, response: unknown, publicKey: string, signedAt: string }) {
    const { runTag, callIndex, invocationHash, response, publicKey, signedAt } = answer;
    return { runTag, callIndex, invocationHash, response, publicKey, signedAt };
}

/** The fields of a receipts submission a node signs, in order: stellarium-ts's `receiptsPayload`. */
export function receiptsPayload(runId: string, receipts: unknown[]) {
    return { runId, receipts };
}

/** The RequestScript version the operator replays with. */
export const REPLAY_REQUESTSCRIPT_VERSION: string = requestscriptPackage.version;

/**
 * Whether the operator can replay a contract registered as running on `version`: the same major and minor
 * version, from 1.8, whose releases all pass the same deterministic conformance suite.
 */
export function canReplay(version: string): boolean {
    const [major, minor] = version.split('.').map(Number);
    const [ownMajor, ownMinor] = REPLAY_REQUESTSCRIPT_VERSION.split('.').map(Number);
    return major === ownMajor && minor === ownMinor && (major! > 1 || minor! >= 8);
}

/** JSON with every host value written exactly, as `encodeHostValue` writes them. */
function encoded(value: unknown): string {
    return JSON.stringify(value, function (key, raw: unknown) {
        const original = (this as Record<string, unknown>)[key];
        if (typeof original === 'bigint') return { $int64: original.toString() };
        if (original instanceof Decimal) return { $decimal: original.toString() };
        return raw;
    }) ?? 'undefined';
}

/** A recorded host value back as the host gave it. */
function decodeHostValue(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(decodeHostValue);
    if (value !== null && typeof value === 'object') {
        const record = value as Record<string, unknown>;
        const keys = Object.keys(record);
        if (keys.length === 1 && typeof record.$int64 === 'string') return BigInt(record.$int64);
        if (keys.length === 1 && typeof record.$decimal === 'string') return Decimal.fromString(record.$decimal);
        return Object.fromEntries(keys.map(key => [key, decodeHostValue(record[key])]));
    }
    return value;
}

/** Recorded contract parameters as JSON, which takes an int64 or a decimal as a string. */
function parametersAsJson(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(parametersAsJson);
    if (value !== null && typeof value === 'object') {
        const record = value as Record<string, unknown>;
        const keys = Object.keys(record);
        if (keys.length === 1 && typeof record.$int64 === 'string') return record.$int64;
        if (keys.length === 1 && typeof record.$decimal === 'string') return record.$decimal;
        return Object.fromEntries(keys.map(key => [key, parametersAsJson(record[key])]));
    }
    return value;
}

export type ReplayResult = { ok: true } | { ok: false, reason: string };

/**
 * Replays a receipt with the contract's registered source: every resource call answers with what the receipt
 * recorded, and must be the receipt's next call, with the same function, arguments and attached money. The run
 * must then produce the receipt's outputs exactly. A replay that disagrees proves nothing on its own: the host
 * ran something else, or the runtime has a bug (docs/money.md, When replay disagrees).
 */
export async function replay(receipt: RunReceipt, source: string): Promise<ReplayResult> {
    const script = parseScript(source);
    if (script.declaration.kind !== 'contract') return { ok: false, reason: 'the registered source is not a contract' };
    const payable = script.declaration.payable === true;
    let divergence: string | undefined;
    let next = 0;

    const resources = new Map<string, Resource>();
    for (const call of receipt.calls) {
        const key = call.version === undefined ? call.resource : `${call.resource}@${call.version}`;
        const at = call.resource.lastIndexOf('.');
        const resource = resources.get(key) ?? { path: call.resource.slice(0, at), name: call.resource.slice(at + 1), ...(call.version === undefined ? {} : { version: call.version }), metadata: {}, functions: [] };
        if (!resource.functions.some(fn => fn.name === call.function)) {
            resource.functions.push({ name: call.function, ...call.signature, exec: async () => null });
        }
        resources.set(key, resource);
    }
    const reads = new Map(receipt.stateReads.map(read => [JSON.stringify([read.name, read.scope]), read.stored]));
    const replayedReads: string[] = [];
    const meter = new TokenMeter();
    let result;
    try {
        result = await interpretParsed(script, {
            resourceResolver: {
                // A resource the script binds but never called has no recorded functions; it can't be called in the replay either.
                resolve: async (key, version) => resources.get(version === undefined ? key : `${key}@${version}`)
                    ?? (() => { const at = key.lastIndexOf('.'); return { path: key.slice(0, at), name: key.slice(at + 1), ...(version === undefined ? {} : { version }), metadata: {}, functions: [] }; })(),
            },
            resourceInvoker: {
                invoke: async (resource, functionName, parameters, attachment) => {
                    const recorded = receipt.calls[next++];
                    const actual = { resource: `${resource.path}.${resource.name}`, function: functionName, parameters: JSON.parse(encoded(parameters)), attachment: attachment ?? null };
                    const expected = recorded && { resource: recorded.resource, function: recorded.function, parameters: recorded.parameters, attachment: recorded.attachment ?? null };
                    if (!recorded || encoded(actual) !== encoded(expected)) {
                        divergence ??= `call ${next - 1} was ${encoded(actual)}, but the receipt recorded ${recorded ? encoded(expected) : 'no more calls'}`;
                        return { value: null, error: { message: 'diverged' } };
                    }
                    return { value: decodeHostValue(recorded.response.value), error: recorded.response.error };
                },
            },
            meter,
            parameters: parametersAsJson(receipt.inputs.parameters) as Record<string, unknown>,
            builtins: {
                jwt: receipt.inputs.jwt,
                caller: receipt.inputs.caller,
                ...(receipt.inputs.event ? { event: receipt.inputs.event } : {}),
                ...(payable && receipt.inputs.sender ? { sender: receipt.inputs.sender } : {}),
            },
            ...(payable && receipt.inputs.payment ? { payment: { amount: receipt.inputs.payment.amount, from: receipt.inputs.payment.from, payees: receipt.inputs.payment.payees } } : {}),
            ...(payable && receipt.inputs.now !== null ? { now: receipt.inputs.now } : {}),
            state: {
                get: async (name, scope) => {
                    const key = JSON.stringify([name, scope]);
                    replayedReads.push(key);
                    return (reads.get(key) ?? undefined) as never;
                },
            },
            structs: createStructResolver(receipt.structs),
        });
    } catch (error) {
        // The host recorded a successful run, so a replay that fails disagrees with it.
        if (error instanceof RequestScriptError) return { ok: false, reason: `the replay failed: ${error.message}` };
        throw error;
    }
    if (divergence) return { ok: false, reason: divergence };
    if (next !== receipt.calls.length) return { ok: false, reason: `the replay made ${next} calls, but the receipt recorded ${receipt.calls.length}` };
    if (encoded(replayedReads) !== encoded(receipt.stateReads.map(read => JSON.stringify([read.name, read.scope])))) {
        return { ok: false, reason: 'the replay read other state than the receipt recorded' };
    }
    const outputs = { returnValue: result.returnValue, state: result.state, events: result.events, tokens: meter.tokens };
    for (const field of ['returnValue', 'state', 'events', 'tokens'] as const) {
        if (encoded(outputs[field]) !== encoded(receipt.outputs[field])) {
            return { ok: false, reason: `the replay's ${field} was ${encoded(outputs[field])}, but the receipt recorded ${encoded(receipt.outputs[field])}` };
        }
    }
    return { ok: true };
}
