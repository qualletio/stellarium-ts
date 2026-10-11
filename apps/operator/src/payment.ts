import { createHash, createPublicKey, verify } from 'node:crypto';
import { PublicKey } from '@solana/web3.js';
import { OperationError } from './errors.js';

// Wire formats match PaymentVoucher in stellarium-ts/resource/invoker.ts and
// StellariumResourceFunctionPaymentManifest in resource/repository.ts.
export interface PaymentSubmission {
    manifest: { 
        id: number; 
        costLamports: bigint; 
        recipientAddress: string
    };
    voucher: {
        requestId: string; 
        invocationId: string; 
        amount: number;
        recipientAddress: string; 
        signature: string; 
        expiresAt: string; 
        publicKey: string;
    };
    // These fields are signed by createPaymentVoucher but absent from its result.
    resourcePath: string;
    resourceName: string;
    parameters: unknown[];
}

export function verifyPayment(input: PaymentSubmission, now = Date.now()) {
    const { manifest, voucher, resourcePath, resourceName, parameters } = input;
    const text = (value: unknown) => typeof value === 'string' && value.length > 0 && value.length <= 4096;
    if (!manifest || !voucher || !text(resourcePath) || !text(resourceName) || !Array.isArray(parameters) ||
        !text(voucher.requestId) || !text(voucher.invocationId) || !text(voucher.recipientAddress) ||
        !text(voucher.publicKey) || !text(voucher.signature) || !text(voucher.expiresAt) ||
        !Number.isSafeInteger(manifest.id) || manifest.id < 0 ||
        !Number.isSafeInteger(manifest.costLamports) || manifest.costLamports <= 0 ||
        !Number.isSafeInteger(voucher.amount) || voucher.amount <= 0) {
        throw new OperationError(400, 'Invalid payment manifest, voucher, or invocation context');
    }
    const expiry = Date.parse(voucher.expiresAt);
    if (!Number.isFinite(expiry)) throw new OperationError(400, 'Invalid voucher expiry');
    if (expiry <= now) throw new OperationError(410, 'Payment voucher has expired');
    if (manifest.costLamports !== voucher.amount || manifest.recipientAddress !== voucher.recipientAddress) {
        throw new OperationError(400, 'Manifest does not match the voucher amount and recipient');
    }
    // Match signData's exact field order, including the invocation context.
    const payload = JSON.stringify({
        requestId: voucher.requestId, invocationId: voucher.invocationId,
        amount: voucher.amount, recipientAddress: voucher.recipientAddress,
        expiresAt: voucher.expiresAt, resourcePath, resourceName, parameters,
        publicKey: voucher.publicKey,
    });
    let user: PublicKey;
    let recipient: PublicKey;
    try {
        const publicKey = createPublicKey({ key: Buffer.from(voucher.publicKey, 'base64url'), format: 'der', type: 'spki' });
        if (publicKey.asymmetricKeyType !== 'ed25519' ||
            !verify(null, Buffer.from(payload), publicKey, Buffer.from(voucher.signature, 'base64url'))) {
            throw new Error('Invalid signature');
        }
        // Node's SPKI signing key and Solana user address represent the same
        // Ed25519 public key in different encodings. Never trust a caller-supplied user.
        const rawKey = Buffer.from(publicKey.export({ format: 'jwk' }).x!, 'base64url');
        user = new PublicKey(rawKey);
    } catch {
        throw new OperationError(401, 'Invalid payment voucher signature');
    }
    try { recipient = new PublicKey(voucher.recipientAddress); }
    catch { throw new OperationError(400, 'Invalid payment recipient address'); }
    const voucherId = createHash('sha256').update(JSON.stringify([
        user.toBase58(), voucher.requestId, voucher.invocationId,
    ])).digest('hex');
    const fingerprint = createHash('sha256').update(payload).digest('hex');
    return { user, recipient, amountLamports: BigInt(voucher.amount), voucherId, fingerprint };
}
