import type { FastifyRequest } from "fastify";
import { hashData, verifySignature } from "../crypto.js";
import { OperationError } from "../errors.js";

export const NODE_AUTH_SCHEME = 'Stellarium';

/** How far a request's timestamp may be from the operator's clock. Node requests are idempotent, so replays within it are harmless. */
export const NODE_AUTH_MAX_SKEW_MS = 1000 * 60 * 5;

declare module 'fastify' {
    interface FastifyRequest {
        /** The SPKI public key that signed this request. Set by `authenticateNode`. */
        nodePublicKey?: string;
    }
}

/**
 * The object a node signs to authenticate one request. Copied from `operatorRequestPayload` in
 * stellarium-ts's client/operatorAuth.ts; the two must stay in sync. Key order is part of the signed bytes.
 */
export function operatorRequestPayload(method: string, path: string, body: unknown, timestamp: string) {
    return { method: method.toUpperCase(), path, bodyHash: hashData(body ?? {}), timestamp };
}

/**
 * A preValidation hook: checks the `Authorization: Stellarium <base64url JSON { publicKey, timestamp, signature }>`
 * header and records the signer on `request.nodePublicKey`. It runs before schema validation, so the body
 * it hashes is the one the node sent, before any type coercion.
 */
export async function authenticateNode(request: FastifyRequest): Promise<void> {
    const [scheme, encoded] = (request.headers.authorization ?? '').split(' ');
    if (scheme !== NODE_AUTH_SCHEME || !encoded) {
        throw new OperationError(401, 'Missing node signature');
    }
    let credentials: { publicKey?: unknown, timestamp?: unknown, signature?: unknown };
    try {
        credentials = JSON.parse(Buffer.from(encoded, 'base64url').toString());
    } catch {
        throw new OperationError(401, 'Malformed node signature');
    }
    const { publicKey, timestamp, signature } = credentials ?? {};
    if (typeof publicKey !== 'string' || typeof timestamp !== 'string' || typeof signature !== 'string') {
        throw new OperationError(401, 'Malformed node signature');
    }
    const signedAt = Date.parse(timestamp);
    if (!Number.isFinite(signedAt) || Math.abs(Date.now() - signedAt) > NODE_AUTH_MAX_SKEW_MS) {
        throw new OperationError(401, 'Node signature timestamp is too far from the operator\'s clock');
    }
    const path = request.url.split('?')[0]!;
    if (!verifySignature(operatorRequestPayload(request.method, path, request.body, timestamp), publicKey, signature, 'node')) {
        throw new OperationError(401, 'Invalid node signature');
    }
    request.nodePublicKey = publicKey;
}
