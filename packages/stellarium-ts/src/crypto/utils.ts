import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign,
  verify,
} from "node:crypto";

export function signData(data: Object, privateKey: string): string {
    const key = createPrivateKey({
        key: Buffer.from(privateKey, "base64url"),
        format: "der",
        type: "pkcs8",
    });
    const bytes = Buffer.from(JSON.stringify(data));
    return sign(null, bytes, key).toString('base64url');
}

export function hashData(data: Object): string {
    return createHash('sha256').update(JSON.stringify(data)).digest('base64url');
}

export function verifyData(data: Object, publicKey: string, signature: string): boolean {
    const key = createPublicKey({
        key: Buffer.from(publicKey, "base64url"),
        format: "der",
        type: "spki",
    });
    const bytes = Buffer.from(JSON.stringify(data));
    return verify(null, bytes, key, Buffer.from(signature, 'base64url'));
}

/** Longest lifetime accepted for a signed peer or resource broadcast, so a captured one can't be replayed indefinitely. */
export const MAX_SIGNATURE_LIFETIME_MS = 1000 * 60 * 60;

/** True when `expiry` is a valid date in the future, no more than `maxLifetimeMs` away. */
export function isFreshExpiry(expiry: string, maxLifetimeMs: number = MAX_SIGNATURE_LIFETIME_MS): boolean {
    const expiresAt = Date.parse(expiry);
    const now = Date.now();
    return Number.isFinite(expiresAt) && expiresAt > now && expiresAt <= now + maxLifetimeMs;
}

/** verifyData that treats a malformed key or signature as an invalid signature instead of throwing. */
export function safeVerifyData(data: Object, publicKey: string, signature: string): boolean {
    try {
        return verifyData(data, publicKey, signature);
    } catch {
        return false;
    }
}
