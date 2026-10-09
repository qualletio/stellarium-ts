import type { Database } from "sqlite";
import type {
    ChainAccess,
    ProtocolSigner,
    Claim,
    Signed,
    RelayAdvertisement,
    Hex,
} from "../protocol/types.js";
import { wireJson } from "../protocol/canonical.js";
import { advertisementSchema, claimSchema } from "../protocol/schema.js";
import {
    validateClaim,
    sameAddress,
    nowSeconds,
    ProtocolError,
    TransactionNotBroadcastError,
} from "../payment/validation.js";
import type { RelayDiscovery } from "./discovery.js";
export interface RelayOptions {
    signer: ProtocolSigner;
    endpoint: string;
    relayFeeUsdc: bigint;
    maxBatchSize?: number;
    maxBatchDelayMs?: number;
    advertisementLifetimeSeconds?: number;
}
export class RelayService {
    private running = false;
    private timer?: ReturnType<typeof setInterval>;
    constructor(
        private readonly db: Database,
        private readonly chain: ChainAccess,
        readonly options: RelayOptions,
        private readonly discovery: RelayDiscovery,
    ) {
        if (
            (options.maxBatchSize ?? 100) < 1 ||
            (options.maxBatchSize ?? 100) > 100 ||
            (options.maxBatchDelayMs ?? 5000) < 10 ||
            (options.maxBatchDelayMs ?? 5000) > 60_000 ||
            options.relayFeeUsdc < 0n
        )
            throw new Error("Invalid relay configuration");
    }
    async advertise(): Promise<Signed<RelayAdvertisement>> {
        if (!(await this.chain.isEligibleRelay(this.options.signer.address)))
            throw new Error("Relay must be registered and staked");
        const row = await this.db.get(
            "SELECT advertisement_json FROM relay_advertisement WHERE relay=?",
            this.options.signer.address.toLowerCase(),
        );
        const existing = row
            ? advertisementSchema.parse(JSON.parse(row.advertisement_json))
            : undefined;
        const now = nowSeconds();
        const ad = await this.options.signer.sign(
            "RelayAdvertisement",
            this.chain.relayDomain,
            {
                protocolVersion: 1,
                relay: this.options.signer.address,
                endpoint: this.options.endpoint,
                receiptVersion: 1,
                relayFeeUsdc: this.options.relayFeeUsdc,
                available: true,
                issuedAt: now,
                expiresAt:
                    now +
                    BigInt(this.options.advertisementLifetimeSeconds ?? 600),
                nonce: existing
                    ? existing.message.nonce + 1n
                    : BigInt(Date.now()),
            },
        );
        await this.discovery.save(ad);
        return ad;
    }
    async accept(claim: Claim): Promise<void> {
        if (
            !sameAddress(
                claim.receipt.message.relay,
                this.options.signer.address,
            )
        )
            throw new ProtocolError("Receipt belongs to another relay", 403);
        const id = claim.receipt.message.receiptId;
        const existing = await this.db.get(
            "SELECT claim_json FROM relay_queue WHERE id=?",
            id,
        );
        if (existing) {
            const old = claimSchema.parse(JSON.parse(existing.claim_json));
            if (
                wireJson(old.receipt) !== wireJson(claim.receipt) ||
                wireJson(old.grant) !== wireJson(claim.grant) ||
                wireJson(old.authorization) !== wireJson(claim.authorization)
            )
                throw new ProtocolError("Conflicting receipt", 409);
            if (claim.acceptance && !old.acceptance) {
                await validateClaim(this.chain, claim);
                await this.db.run(
                    "UPDATE relay_queue SET claim_json=? WHERE id=? AND state='queued'",
                    wireJson(claim),
                    id,
                );
            }
            return;
        }
        await validateClaim(this.chain, claim);
        await this.db.run(
            "INSERT OR IGNORE INTO relay_queue(id,claim_json,received_at,deadline) VALUES(?,?,?,?)",
            id,
            wireJson(claim),
            Number(nowSeconds()),
            Number(claim.receipt.message.executedAt + 1800n),
        );
    }
    async tick(): Promise<void> {
        if (this.running) return;
        this.running = true;
        try {
            const pending = await this.db.all(
                "SELECT DISTINCT transaction_hash FROM relay_queue WHERE state='submitted'",
            );
            for (const row of pending) {
                const state = await this.chain.transactionStatus(
                    row.transaction_hash as Hex,
                );
                if (state === "confirmed") {
                    const receipts = await this.db.all(
                        "SELECT id FROM relay_queue WHERE state='submitted' AND transaction_hash=?",
                        row.transaction_hash,
                    );
                    for (const receipt of receipts) {
                        const result = await this.chain.getClaimState(
                            receipt.id,
                        );
                        await this.db.run(
                            "UPDATE relay_queue SET state=?,last_error=? WHERE id=?",
                            result === "unclaimed" ? "rejected" : "confirmed",
                            result === "unclaimed"
                                ? "Claim rejected by settlement"
                                : null,
                            receipt.id,
                        );
                    }
                } else if (state === "failed")
                    await this.db.run(
                        "UPDATE relay_queue SET state='queued',transaction_hash=NULL,batch_id=NULL WHERE transaction_hash=?",
                        row.transaction_hash,
                    );
            }
            const uncertain = await this.db.get(
                "SELECT id FROM relay_queue WHERE state='submitting' LIMIT 1",
            );
            // A crash between network submission and persisting the hash must not blindly spend gas twice.
            if (uncertain) return;
            const rows = await this.db.all(
                "SELECT * FROM relay_queue WHERE state='queued' ORDER BY deadline,id LIMIT ?",
                this.options.maxBatchSize ?? 100,
            );
            const valid: Claim[] = [];
            for (const row of rows) {
                try {
                    const claim = claimSchema.parse(JSON.parse(row.claim_json));
                    await validateClaim(this.chain, claim);
                    valid.push(claim);
                } catch (error) {
                    await this.db.run(
                        "UPDATE relay_queue SET state='rejected',last_error=? WHERE id=?",
                        error instanceof Error
                            ? error.message
                            : "Invalid claim",
                        row.id,
                    );
                }
            }
            if (!valid.length) return;
            const batchId = valid
                .map((c) => c.receipt.message.receiptId)
                .join(":");
            for (const claim of valid)
                await this.db.run(
                    "UPDATE relay_queue SET state='submitting',batch_id=?,attempts=attempts+1 WHERE id=?",
                    batchId,
                    claim.receipt.message.receiptId,
                );
            try {
                const hash = await this.chain.submitClaims(valid);
                await this.db.run(
                    "UPDATE relay_queue SET state='submitted',transaction_hash=? WHERE batch_id=?",
                    hash,
                    batchId,
                );
            } catch (error) {
                if (error instanceof TransactionNotBroadcastError)
                    await this.db.run(
                        "UPDATE relay_queue SET state='queued' WHERE batch_id=? AND state='submitting'",
                        batchId,
                    );
                // Transaction errors can be ambiguous; keep state for explicit reconciliation rather than resubmission.
                await this.db.run(
                    "UPDATE relay_queue SET last_error=? WHERE batch_id=?",
                    error instanceof Error
                        ? error.message
                        : "Submission failed",
                    batchId,
                );
            }
        } finally {
            this.running = false;
        }
    }
    async reconcile(batchId: string, transactionHash: Hex): Promise<void> {
        await this.db.run(
            "UPDATE relay_queue SET state='submitted',transaction_hash=? WHERE batch_id=? AND state='submitting'",
            transactionHash,
            batchId,
        );
    }
    start(onError: (error: unknown) => void): void {
        this.timer = setInterval(() => {
            void this.tick().catch(onError);
        }, this.options.maxBatchDelayMs ?? 5000);
        this.timer.unref();
    }
    stop(): void {
        if (this.timer) clearInterval(this.timer);
    }
}
