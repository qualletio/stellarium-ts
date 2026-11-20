import { hashData, signData } from "../crypto/utils.js";
import type { NodeDatabase } from "../db/database.js";
import type { InvokeResult } from "./settlement.js";

/** How long this node remembers what it answered, longer than the operator takes to verify a run. */
export const SERVED_CALL_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

/** The fields of a signed answer, in order. Copied as `resourceResponsePayload` in the operator's verification/replay.ts. */
export function resourceResponsePayload(answer: { runTag: string, callIndex: number, invocationHash: string, response: { value: unknown, error: { message: string } | null }, publicKey: string, signedAt: string }) {
    const { runTag, callIndex, invocationHash, response, publicKey, signedAt } = answer;
    return { runTag, callIndex, invocationHash, response, publicKey, signedAt };
}

/** A signed answer: the call's result, and the signature over it a host can't forge. */
export interface SignedAnswer {
    value: unknown;
    error: { message: string } | null;
    usage?: unknown;
    attestation: { runTag: string, callIndex: number, invocationHash: string, publicKey: string, signedAt: string, signature: string };
}

interface ServedRow {
    invocation_hash: string;
    answer: string;
    response_hash: string;
}

/**
 * The answers this node gave to calls that named their place in a run (docs/money.md, Signed responses). Each is
 * signed, given again to the same call, and remembered for `SERVED_CALL_RETENTION_MS`, so the operator can tell
 * when a host claims a call failed that this node answered.
 */
export class ServedCallLog {
    constructor(private readonly db: NodeDatabase, private readonly publicKey: string, private readonly privateKey: string) {}

    async get(runTag: string, callIndex: number): Promise<{ invocationHash: string, answer: SignedAnswer, responseHash: string } | undefined> {
        const row = await this.db.get<ServedRow>('SELECT invocation_hash, answer, response_hash FROM served_call WHERE run_tag = ? AND call_index = ?', [runTag, callIndex]);
        return row && { invocationHash: row.invocation_hash, answer: JSON.parse(row.answer) as SignedAnswer, responseHash: row.response_hash };
    }

    /** Signs and remembers an answer. A concurrent call that answered first wins, and its answer is returned. */
    async answer(runTag: string, callIndex: number, invocationHash: string, result: InvokeResult): Promise<SignedAnswer> {
        const response = { value: result.value ?? null, error: result.error ? { message: result.error.message } : null };
        const signedAt = new Date().toISOString();
        const fields = { runTag, callIndex, invocationHash, response, publicKey: this.publicKey, signedAt };
        const answer: SignedAnswer = {
            ...response,
            ...(result.usage === undefined ? {} : { usage: result.usage }),
            attestation: { runTag, callIndex, invocationHash, publicKey: this.publicKey, signedAt, signature: signData(resourceResponsePayload(fields), this.privateKey) },
        };
        await this.db.run(
            'INSERT INTO served_call (run_tag, call_index, invocation_hash, answer, response_hash, created_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (run_tag, call_index) DO NOTHING',
            [runTag, callIndex, invocationHash, JSON.stringify(answer), hashData(response), signedAt],
        );
        return (await this.get(runTag, callIndex))?.answer ?? answer;
    }

    /** Forgets answers older than the retention. Returns how many. */
    async prune(now: Date = new Date()): Promise<number> {
        const result = await this.db.run('DELETE FROM served_call WHERE created_at < ?', [new Date(now.getTime() - SERVED_CALL_RETENTION_MS).toISOString()]);
        return result.changes;
    }
}
