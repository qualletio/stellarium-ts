import { generateKeyPairSync, sign } from 'node:crypto';
import { PublicKey } from '@solana/web3.js';
export function paymentFixture() {
    const keys = generateKeyPairSync('ed25519');
    const publicKey = keys.publicKey.export({ type: 'spki', format: 'der' }).toString('base64url');
    const recipientAddress = new PublicKey(new Uint8Array(32).fill(4)).toBase58();
    const payload = { requestId: 'request-id', invocationId: 'invocation-id', amount: 500,
        recipientAddress, expiresAt: new Date(Date.now() + 120_000).toISOString(),
        resourcePath: 'com.example', resourceName: 'Weather', parameters: [{ name: 'city', value: 'Oslo' }], publicKey };
    const signature = sign(null, Buffer.from(JSON.stringify(payload)), keys.privateKey).toString('base64url');
    const voucher = { requestId: payload.requestId, invocationId: payload.invocationId,
        amount: payload.amount, recipientAddress, signature, expiresAt: payload.expiresAt, publicKey };
    return { input: { manifest: { id: 1, costLamports: 500, recipientAddress }, voucher,
        resourcePath: payload.resourcePath, resourceName: payload.resourceName, parameters: payload.parameters },
        user: new PublicKey(Buffer.from(keys.publicKey.export({ format: 'jwk' }).x, 'base64url')) };
}

