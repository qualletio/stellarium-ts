import { createHash, createPublicKey, randomBytes, verify } from "node:crypto";
import { OperationError } from "./errors.js";

/**
 * Verifies an Ed25519 signature over `JSON.stringify(payload)`, as stellarium-ts's `signData` makes it.
 * Key insertion order is part of the signed bytes. Throws 400 for a key that isn't a base64url Ed25519 SPKI key.
 */
export function verifySignature(payload: object, publicKey: string, signature: string, what: string): boolean {
    let key;
    try {
        key = createPublicKey({ key: Buffer.from(publicKey, "base64url"), format: "der", type: "spki" });
    } catch {
        throw new OperationError(400, `Invalid ${what} public key`);
    }
    try {
        return verify(null, Buffer.from(JSON.stringify(payload)), key, Buffer.from(signature, "base64url"));
    } catch {
        // Not an Ed25519 key.
        throw new OperationError(400, `Invalid ${what} public key`);
    }
}

/** stellarium-ts's `hashData`: SHA-256 of the JSON, base64url. */
export function hashData(data: unknown): string {
    return createHash('sha256').update(JSON.stringify(data)).digest('base64url');
}

/** SHA-256 hex, for storing secrets such as enrollment tokens. */
export function sha256Hex(value: string): string {
    return createHash('sha256').update(value).digest('hex');
}

/** A random id with a readable prefix, such as `org_3kTn…`. */
export function newId(prefix: string): string {
    return `${prefix}_${randomBytes(16).toString('base64url')}`;
}
