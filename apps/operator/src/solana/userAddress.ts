import { createPublicKey } from 'node:crypto';
import { PublicKey } from '@solana/web3.js';
import { OperationError } from '../errors.js';

/** Solana user address is the raw 32-byte Ed25519 key inside the voucher SPKI. */
export function solanaUserFromSpki(spkiBase64Url: string): PublicKey {
    try {
        const key = createPublicKey({
            key: Buffer.from(spkiBase64Url, 'base64url'),
            format: 'der',
            type: 'spki',
        });
        if (key.asymmetricKeyType !== 'ed25519') {
            throw new Error('not ed25519');
        }
        const jwk = key.export({ format: 'jwk' });
        if (jwk.kty !== 'OKP' || jwk.crv !== 'Ed25519' || typeof jwk.x !== 'string') {
            throw new Error('unexpected jwk');
        }
        const raw = Buffer.from(jwk.x, 'base64url');
        if (raw.length !== 32) {
            throw new Error('unexpected length');
        }
        return new PublicKey(raw);
    } catch (error) {
        if (error instanceof OperationError) throw error;
        throw new OperationError(400, 'Invalid public key');
    }
}
