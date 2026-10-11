import { createPublicKey, verify } from "node:crypto";
import { and, eq } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { receiptsTable } from "./db/schema.js";
import { OperationError } from "./errors.js";
import type { PaymentSubmission } from "./payment.js";

export class PaymentService {
    constructor(private readonly db: NodePgDatabase) {}

    async verifyPayment(submission: PaymentSubmission): Promise<void> {
        const { voucher, resourcePath, resourceName, parameters } = submission;
        const { requestId, invocationId, amount, recipientAddress, signature: voucherSignature, expiresAt, publicKey } = voucher;
        const receipt = await this.db.select().from(receiptsTable).where(and(eq(receiptsTable.requestId, requestId), eq(receiptsTable.invocationId, invocationId)));
        if (receipt.length > 0) {
            throw new OperationError(409, 'Receipt has already been settled');
        }

        // Same payload and SPKI key that signData used to create the voucher.
        const payload = JSON.stringify({
            requestId, invocationId, amount, recipientAddress,
            expiresAt, resourcePath, resourceName, parameters, publicKey,
        });
        const key = createPublicKey({
            key: Buffer.from(publicKey, "base64url"),
            format: "der",
            type: "spki",
        });
        const valid = verify(null, Buffer.from(payload), key, Buffer.from(voucherSignature, "base64url"));
        if (!valid) {
            throw new OperationError(401, 'Invalid voucher signature');
        }

        const expiry = Date.parse(expiresAt);
        if (!Number.isFinite(expiry) || expiry < Date.now()) {
            throw new OperationError(401, 'Voucher has expired');
        }
    }
}
