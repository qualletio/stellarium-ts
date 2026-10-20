import { createAssociatedTokenAccountIdempotentInstruction, TOKEN_PROGRAM_ID, unpackAccount } from "@solana/spl-token";
import type { AccountInfo, Signer } from "@solana/web3.js";
import { Connection, PublicKey, TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import { OperationError } from "../errors.js";
import type { ReceiptRepository } from "../repository.js";
import type { PaymentSubmission } from "../routes.js";
import { encodeBase58 } from "../solana/base58.js";
import { getEscrowBudget } from "../solana/escrow-budget.js";
import { createEscrowInstruction, createWithdrawEscrowInstruction, decodeEscrowAccount } from "../solana/escrow.js";
import { solanaUserFromSpki } from "../solana/userAddress.js";

/** The Connection methods the service uses, so tests can supply a fake. */
export type EscrowConnection = Pick<Connection,
    'getAccountInfoAndContext' | 'getLatestBlockhash' | 'simulateTransaction' |
    'sendTransaction' | 'confirmTransaction' | 'getSignatureStatuses' | 'getBlockHeight'>;

/**
 * Receipts are left to the in-flight settlement for this long before reconciliation checks them.
 * Longer than a blockhash lifetime (~60-90s), so a pending transaction has either landed or expired.
 */
export const RECONCILE_MIN_AGE_MS = 1000 * 60 * 2;

export interface ReconcileSummary {
    checked: number;
    confirmed: number;
    failed: number;
    expired: number;
}

export interface OperationResult {
    escrowAddress: string;
    /** The escrow's USDC token account. Users fund the escrow by transferring USDC here. */
    escrowTokenAddress?: string;
    status: 'confirmed' | 'unconfirmed' | 'existing';
    signature?: string;
    blockhash?: string;
    lastValidBlockHeight?: number;
}

/** An initialized, unfrozen token account of `mint` owned by `owner`. */
function isUsableTokenAccount(account: AccountInfo<Buffer> | null, address: PublicKey, owner: PublicKey, mint: PublicKey): boolean {
    if (account === null) return false;
    try {
        const token = unpackAccount(address, account, TOKEN_PROGRAM_ID);
        return token.mint.equals(mint) && token.owner.equals(owner) && token.isInitialized && !token.isFrozen;
    } catch {
        return false;
    }
}

/**
 * The EscrowService is responsible for communicating with Solana to initiate and withdraw from an escrow account.
 */
export class EscrowService {
    constructor(private readonly receipts: ReceiptRepository, private readonly escrowProgramId: PublicKey, private readonly authority: Signer, private readonly feeRecipient: PublicKey, private readonly mint: PublicKey, private readonly connection: EscrowConnection) {}

    async initiateEscrow(user: PublicKey): Promise<OperationResult> {
        const instruction = createEscrowInstruction({
            programId: this.escrowProgramId,
            authority: this.authority.publicKey,
            user,
            mint: this.mint,
        });
        const addresses = { escrowAddress: instruction.escrowAddress.toBase58(), escrowTokenAddress: instruction.escrowTokenAddress.toBase58() };

        const snapshot = await this.connection.getAccountInfoAndContext(instruction.escrowAddress, 'confirmed');
        if (snapshot.value !== null && snapshot.value.owner.equals(this.escrowProgramId)) {
            try {
                const state = decodeEscrowAccount(this.escrowProgramId, instruction.escrowAddress, snapshot.value);
                if (!state.user.equals(user) || !state.authority.equals(this.authority.publicKey)) throw new Error('State mismatch');
            } catch {
                throw new OperationError(409, 'Existing escrow account has invalid state');
            }
            return { ...addresses, status: 'existing' };
        }

        // Empty System-owned prefunded PDAs are accepted by initialization.
        const lifetime = await this.connection.getLatestBlockhash('confirmed');

        const transaction = new VersionedTransaction(new TransactionMessage({
            payerKey: this.authority.publicKey, 
            recentBlockhash: lifetime.blockhash, 
            instructions: [instruction.instruction],   
        }).compileToV0Message());

        const simulation = await this.connection.simulateTransaction(transaction, {
            commitment: 'confirmed', 
            sigVerify: false, 
            minContextSlot: snapshot.context.slot,
        });

        if (simulation.value.err !== null) {
            console.error(simulation.value.err);
            throw new OperationError(422, 'Transaction simulation failed');
        }

        transaction.sign([this.authority]);
        const signature = encodeBase58(transaction.signatures[0]!);
        const result = { ...addresses, signature, ...lifetime };

        try {
            await this.connection.sendTransaction(transaction, {
                skipPreflight: false, preflightCommitment: 'confirmed',
                minContextSlot: simulation.context.slot, maxRetries: 3,
            });
        } catch {
            // The RPC may have accepted the transaction before a transport error.
            // Preserve its signature instead of inviting a duplicate payment.
            return { ...result, status: 'unconfirmed' };
        }

        let confirmation;
        try {
            confirmation = await this.connection.confirmTransaction({ signature, ...lifetime }, 'confirmed');
        } catch {
            return { ...result, status: 'unconfirmed' };
        }

        if (confirmation.value.err !== null) {
            throw new OperationError(422, `Transaction failed: ${signature}`);
        }

        return { ...result, status: 'confirmed' };
    }

    async settlePayment(submission: PaymentSubmission): Promise<OperationResult> {
        const { voucher } = submission;
        const { requestId, invocationId, amount, recipientAddress, signature: voucherSignature, expiresAt, invocationHash, publicKey } = voucher;
        let user: PublicKey, recipient: PublicKey;
        try {
            user = solanaUserFromSpki(voucher.publicKey);
            recipient = new PublicKey(recipientAddress);
        } catch {
            throw new OperationError(400, 'Invalid voucher public key or recipient address');
        }
        const amountMicroUsdc = BigInt(amount);

        const instruction = createWithdrawEscrowInstruction({
            programId: this.escrowProgramId,
            authority: this.authority.publicKey,
            user,
            recipient,
            feeRecipient: this.feeRecipient,
            mint: this.mint,
            amountMicroUsdc,
        });

        const budget = await getEscrowBudget({ connection: this.connection, programId: this.escrowProgramId, authority: this.authority.publicKey, user, mint: this.mint, requestedWithdrawalMicroUsdc: amountMicroUsdc });
        if (!budget.isInitialized) throw new OperationError(404, 'Escrow account does not exist');
        if (!budget.hasEnoughBudget) throw new OperationError(409, 'Insufficient escrow balance');

        const snapshot = await this.connection.getAccountInfoAndContext(instruction.escrowAddress, 'confirmed');
        if (snapshot.value !== null && snapshot.value.owner.equals(this.escrowProgramId)) {
            try {
                const state = decodeEscrowAccount(this.escrowProgramId, instruction.escrowAddress, snapshot.value);
                if (!state.user.equals(user) || !state.authority.equals(this.authority.publicKey)) throw new Error('State mismatch');
            } catch {
                throw new OperationError(409, 'Existing escrow account has invalid state');
            }
        }

        // Providers create their own USDC token account; the operator doesn't pay for it.
        const recipientToken = await this.connection.getAccountInfoAndContext(instruction.recipientTokenAddress, 'confirmed');
        if (!isUsableTokenAccount(recipientToken.value, instruction.recipientTokenAddress, recipient, this.mint)) {
            throw new OperationError(422, `Recipient ${recipient.toBase58()} has no usable USDC token account at ${instruction.recipientTokenAddress.toBase58()}`);
        }

        const lifetime = await this.connection.getLatestBlockhash('confirmed');

        const transaction = new VersionedTransaction(new TransactionMessage({
            payerKey: this.authority.publicKey, 
            recentBlockhash: lifetime.blockhash, 
            instructions: [
                // The protocol fee wallet's token account is created once, at the operator's expense.
                createAssociatedTokenAccountIdempotentInstruction(this.authority.publicKey, instruction.feeTokenAddress, this.feeRecipient, this.mint),
                instruction.instruction,
            ],
        }).compileToV0Message());

        const simulation = await this.connection.simulateTransaction(transaction, {
            commitment: 'confirmed', 
            sigVerify: false, 
            minContextSlot: snapshot.context.slot,
        });

        if (simulation.value.err !== null) {
            throw new OperationError(422, 'Transaction simulation failed');
        }

        transaction.sign([this.authority]);
        const signature = encodeBase58(transaction.signatures[0]!);
        const result = { escrowAddress: instruction.escrowAddress.toBase58(), signature, ...lifetime };

        // The receipt is claimed before sending, so a duplicate submission fails here instead of paying twice.
        const claimed = await this.receipts.claim({
            requestId,
            invocationId,
            amount,
            recipientAddress: recipient.toBase58(),
            voucherSignature,
            transactionSignature: signature,
            expiresAt: new Date(expiresAt),
            publicKey,
            invocationHash,
            lastValidBlockHeight: lifetime.lastValidBlockHeight,
        });
        if (!claimed) throw new OperationError(409, 'Receipt has already been settled');

        try {
            await this.connection.sendTransaction(transaction, {
                skipPreflight: false, preflightCommitment: 'confirmed',
                minContextSlot: simulation.context.slot, maxRetries: 3,
            });
        } catch {
            // The RPC may have accepted the transaction before a transport error.
            // Preserve its signature instead of inviting a duplicate payment; reconcile() settles the receipt later.
            await this.receipts.setStatus(signature, 'unconfirmed');
            return { ...result, status: 'unconfirmed' };
        }

        let confirmation;
        try {
            confirmation = await this.connection.confirmTransaction({ signature, ...lifetime }, 'confirmed');
        } catch {
            await this.receipts.setStatus(signature, 'unconfirmed');
            return { ...result, status: 'unconfirmed' };
        }

        if (confirmation.value.err !== null) {
            // Nothing was paid, so the voucher may be settled again.
            await this.receipts.setStatus(signature, 'failed');
            throw new OperationError(422, `Transaction failed: ${signature}`);
        }

        await this.receipts.setStatus(signature, 'confirmed');
        return { ...result, status: 'confirmed' };
    }

    /**
     * Resolves receipts left `pending` or `unconfirmed` (by a crash, an RPC error or a confirmation
     * timeout) from the chain: a landed transaction becomes `confirmed` or `failed`, and one whose
     * blockhash expired without landing becomes `expired`, which frees the voucher to be settled again.
     * Receipts with no recorded block height stay unconfirmed for manual review.
     */
    async reconcile(now: Date = new Date()): Promise<ReconcileSummary> {
        const receipts = await this.receipts.findUnsettled(new Date(now.getTime() - RECONCILE_MIN_AGE_MS));
        const summary: ReconcileSummary = { checked: receipts.length, confirmed: 0, failed: 0, expired: 0 };
        if (receipts.length === 0) {
            return summary;
        }

        // Read the block height first: a transaction not found after it can't land once the height passes its limit.
        const blockHeight = await this.connection.getBlockHeight('confirmed');
        // getSignatureStatuses accepts at most 256 signatures per call.
        for (let start = 0; start < receipts.length; start += 256) {
            const batch = receipts.slice(start, start + 256);
            const { value: statuses } = await this.connection.getSignatureStatuses(
                batch.map(receipt => receipt.transactionSignature),
                { searchTransactionHistory: true },
            );

            for (const [index, receipt] of batch.entries()) {
                const status = statuses[index];
                if (status && (status.confirmationStatus === 'confirmed' || status.confirmationStatus === 'finalized')) {
                    const outcome = status.err === null ? 'confirmed' : 'failed';
                    await this.receipts.setStatus(receipt.transactionSignature, outcome);
                    summary[outcome]++;
                } else if (!status && receipt.lastValidBlockHeight !== null && blockHeight > receipt.lastValidBlockHeight) {
                    await this.receipts.setStatus(receipt.transactionSignature, 'expired');
                    summary.expired++;
                }
            }
        }
        return summary;
    }

}
