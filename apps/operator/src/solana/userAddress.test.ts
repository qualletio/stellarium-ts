import { generateKeyPairSync } from 'node:crypto';
import { PublicKey } from '@solana/web3.js';
import { describe, expect, it } from 'vitest';
import { solanaUserFromSpki } from './userAddress.js';

describe('solanaUserFromSpki', () => {
    it('uses the raw Ed25519 key inside an SPKI public key', () => {
        const { publicKey } = generateKeyPairSync('ed25519');
        const spki = Buffer.from(publicKey.export({ format: 'der', type: 'spki' })).toString('base64url');
        const raw = Buffer.from(publicKey.export({ format: 'jwk' }).x!, 'base64url');

        expect(solanaUserFromSpki(spki).equals(new PublicKey(raw))).toBe(true);
    });

    it('rejects a base58 address and other non-SPKI strings', () => {
        expect(() => solanaUserFromSpki(new PublicKey(new Uint8Array(32)).toBase58())).toThrow('Invalid public key');
        expect(() => solanaUserFromSpki('not-a-key')).toThrow('Invalid public key');
    });
});
