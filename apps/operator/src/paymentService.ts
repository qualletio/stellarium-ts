import { createPublicKey, verify } from "node:crypto";
import { OperationError } from "./errors.js";
import type { ReceiptRepository } from "./repository.js";
import type { PaymentSubmission } from "./routes.js";

export class PaymentService {
    constructor(private readonly receipts: ReceiptRepository) {}

    /**
     * Checks the voucher's signature and expiry, then that it hasn't been accepted.
     * The receipt insert in `EscrowService.accruePayment` is the authoritative duplicate check;
     * this one rejects most repeats before any RPC calls.
     */
    async verifyPayment(submission: PaymentSubmission): Promise<void> {
        const { voucher } = submission;
        const { requestId, invocationId, amount, recipientAddress, signature: voucherSignature, expiresAt, invocationHash, publicKey } = voucher;

        // Same payload (paymentVoucherPayload) and SPKI key that signData used to create the voucher.
        const payload = JSON.stringify({
            requestId, invocationId, amount, recipientAddress,
            expiresAt, invocationHash, publicKey,
        });
        let key;
        try {
            key = createPublicKey({
                key: Buffer.from(publicKey, "base64url"),
                format: "der",
                type: "spki",
            });
        } catch {
            throw new OperationError(400, 'Invalid voucher public key');
        }
        let valid: boolean;
        try {
            valid = verify(null, Buffer.from(payload), key, Buffer.from(voucherSignature, "base64url"));
        } catch {
            // Not an Ed25519 key.
            throw new OperationError(400, 'Invalid voucher public key');
        }
        if (!valid) {
            throw new OperationError(401, 'Invalid voucher signature');
        }

        const expiry = Date.parse(expiresAt);
        if (!Number.isFinite(expiry) || expiry < Date.now()) {
            throw new OperationError(401, 'Voucher has expired');
        }

        const receipt = await this.receipts.getByRequestIdAndInvocationId(requestId, invocationId);
        if (receipt) {
            throw new OperationError(409, 'Voucher has already been accepted');
        }
    }
}
