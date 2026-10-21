import { createAssociatedTokenAccountIdempotentInstruction, TOKEN_PROGRAM_ID, unpackAccount } from "@solana/spl-token";
import type { AccountInfo, Signer } from "@solana/web3.js";
import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import { OperationError } from "../errors.js";
import type { AccruedGroup, ReceiptRepository } from "../repository.js";
import { inferenceAmount, isInferenceSubmission } from "../inference.js";
import type { PaymentSubmission } from "../routes.js";
import { encodeBase58 } from "../solana/base58.js";
import { getEscrowBudget } from "../solana/escrow-budget.js";
import { createEscrowInstruction, createWithdrawEscrowInstruction, decodeEscrowAccount, protocolFee } from "../solana/escrow.js";
import { solanaUserFromSpki } from "../solana/userAddress.js";

/** The Connection methods the service uses, so tests can supply a fake. */
export type EscrowConnection = Pick<Connection,
    'getAccountInfoAndContext' | 'getLatestBlockhash' | 'simulateTransaction' | 'getFeeForMessage' |
    'sendTransaction' | 'confirmTransaction' | 'getSignatureStatuses' | 'getBlockHeight'>;

/**
 * Settlements are left to the in-flight withdrawal for this long before reconciliation checks them.
 * Longer than a blockhash lifetime (~60-90s), so a pending transaction has either landed or expired.
 */
export const RECONCILE_MIN_AGE_MS = 1000 * 60 * 2;

/**
 * How far an escrow balance read may lag a settlement the operator has already recorded as confirmed,
 * for example when the RPC node serving the read is behind. Such settlements still count as owed.
 */
export const BALANCE_LAG_MS = 1000 * 60;

/** When accrued receipts are worth paying out on-chain. */
export interface SettlementPolicy {
    /** Micro-USDC per SOL, used to price transaction fees. */
    solPriceMicroUsdc: bigint;
    /**
     * A payer's receipts for one recipient are settled only once the protocol fee on their total is at
     * least this many estimated transaction costs. Until then they stay accrued, however old.
     */
    feeMultiple: bigint;
}

export const DEFAULT_SETTLEMENT_FEE_MULTIPLE = 10n;

export interface SettleSummary {
    /** Payer and recipient pairs with accrued receipts. */
    groups: number;
    /** Groups that met the policy and were sent. */
    sent: number;
    confirmed: number;
    unconfirmed: number;
    /** Groups that met the policy but could not be settled; their receipts stay accrued. */
    failures: { publicKey: string; recipientAddress: string; reason: string }[];
}

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
    status: 'confirmed' | 'unconfirmed' | 'existing' | 'accrued' | 'unsigned';
    /** A base64 v0 transaction the user signs as fee payer and submits to create their escrow. */
    transaction?: string;
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
 * Vouchers are accrued as receipts and paid out in batches by `settleDue`, so a call can cost less than a transaction.
 */
export class EscrowService {
    constructor(private readonly receipts: ReceiptRepository, private readonly escrowProgramId: PublicKey, private readonly authority: Signer, private readonly feeRecipient: PublicKey, private readonly mint: PublicKey, private readonly connection: EscrowConnection, private readonly policy: SettlementPolicy) {}

    /**
     * Returns an existing escrow, or an unsigned transaction that creates it. The user is its fee payer and
     * pays the rent, so creating escrows costs the operator nothing.
     */
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
            payerKey: user,
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
            throw new OperationError(422, `Transaction simulation failed: ${user.toBase58()} must hold enough SOL for the escrow's rent and fees`);
        }

        const serialized = Buffer.from(transaction.serialize()).toString('base64');
        return { ...addresses, status: 'unsigned', transaction: serialized, ...lifetime };
    }

    /**
     * Accepts a verified voucher as an accrued receipt, without sending a transaction. Refuses it when
     * the payer's escrow can't cover it on top of what the payer already owes, or when the recipient
     * has no USDC token account to be paid into.
     */
    async accruePayment(submission: PaymentSubmission): Promise<OperationResult> {
        const { voucher } = submission;
        const { requestId, invocationId, recipientAddress, signature: voucherSignature, expiresAt, invocationHash, publicKey } = voucher;
        // An inference voucher is charged for the reported usage, never more than the maxAmount it signed.
        const inference = isInferenceSubmission(submission) ? submission : undefined;
        const amount = isInferenceSubmission(submission) ? inferenceAmount(submission) : submission.voucher.amount;
        if (amount < 1) throw new OperationError(422, 'Voucher charges nothing');
        let user: PublicKey, recipient: PublicKey;
        try {
            user = solanaUserFromSpki(voucher.publicKey);
            recipient = new PublicKey(recipientAddress);
        } catch {
            throw new OperationError(400, 'Invalid voucher public key or recipient address');
        }

        // Settlements confirmed after this may be missing from the balance read below.
        const confirmedSince = new Date(Date.now() - BALANCE_LAG_MS);
        let budget;
        try {
            budget = await getEscrowBudget({ connection: this.connection, programId: this.escrowProgramId, authority: this.authority.publicKey, user, mint: this.mint });
        } catch {
            throw new OperationError(409, 'Existing escrow account has invalid state');
        }
        if (!budget.isInitialized) throw new OperationError(404, 'Escrow account does not exist');

        // Providers create their own USDC token account; the operator doesn't pay for it.
        const { recipientTokenAddress } = this.withdrawInstruction(user, recipient, 1n);
        const recipientToken = await this.connection.getAccountInfoAndContext(recipientTokenAddress, 'confirmed');
        if (!isUsableTokenAccount(recipientToken.value, recipientTokenAddress, recipient, this.mint)) {
            throw new OperationError(422, `Recipient ${recipient.toBase58()} has no usable USDC token account at ${recipientTokenAddress.toBase58()}`);
        }

        const result = await this.receipts.accrue({
            requestId,
            invocationId,
            amount,
            recipientAddress: recipient.toBase58(),
            voucherSignature,
            expiresAt: new Date(expiresAt),
            publicKey,
            invocationHash,
            maxAmount: inference?.voucher.maxAmount ?? null,
            inputTokens: inference?.usage.inputTokens ?? null,
            outputTokens: inference?.usage.outputTokens ?? null,
        }, budget.availableBudgetMicroUsdc, confirmedSince);
        if (result === 'duplicate') throw new OperationError(409, 'Voucher has already been accepted');
        if (result === 'insufficient') throw new OperationError(409, 'Insufficient escrow balance');

        return { escrowAddress: budget.escrowAddress.toBase58(), status: 'accrued' };
    }

    /**
     * Pays out accrued receipts that meet the settlement policy: one withdrawal per payer and recipient,
     * for the sum of their receipts. A group whose transaction can't be simulated or fails stays accrued
     * and is tried again on the next pass.
     */
    async settleDue(): Promise<SettleSummary> {
        const groups = await this.receipts.findAccruedGroups();
        const summary: SettleSummary = { groups: groups.length, sent: 0, confirmed: 0, unconfirmed: 0, failures: [] };
        if (groups.length === 0) {
            return summary;
        }

        const minimum = await this.estimateTransactionCostMicroUsdc() * this.policy.feeMultiple;
        for (const group of groups) {
            if (protocolFee(group.amount) < minimum) continue;

            try {
                const status = await this.settleGroup(group);
                if (status === null) continue;
                summary.sent++;
                summary[status]++;
            } catch (error) {
                summary.failures.push({ publicKey: group.publicKey, recipientAddress: group.recipientAddress, reason: error instanceof Error ? error.message : String(error) });
            }
        }
        return summary;
    }

    /** The fee of one settlement transaction, in micro-USDC, rounded up. */
    async estimateTransactionCostMicroUsdc(): Promise<bigint> {
        // Every settlement has the same signers and instructions, so placeholder accounts price it exactly.
        const placeholder = Keypair.generate().publicKey;
        const { blockhash } = await this.connection.getLatestBlockhash('confirmed');
        const message = this.withdrawTransaction(placeholder, placeholder, 1n, blockhash).message;
        const { value: lamports } = await this.connection.getFeeForMessage(message, 'confirmed');
        if (lamports === null) throw new Error('Could not estimate the settlement transaction fee');
        const lamportsPerSol = BigInt(LAMPORTS_PER_SOL);
        return (BigInt(lamports) * this.policy.solPriceMicroUsdc + lamportsPerSol - 1n) / lamportsPerSol;
    }

    /** Returns null when another pass claimed the receipts first. */
    private async settleGroup(group: AccruedGroup): Promise<'confirmed' | 'unconfirmed' | null> {
        const user = solanaUserFromSpki(group.publicKey);
        const recipient = new PublicKey(group.recipientAddress);
        const lifetime = await this.connection.getLatestBlockhash('confirmed');
        const transaction = this.withdrawTransaction(user, recipient, group.amount, lifetime.blockhash);

        const simulation = await this.connection.simulateTransaction(transaction, { commitment: 'confirmed', sigVerify: false });
        if (simulation.value.err !== null) {
            throw new Error(`Transaction simulation failed: ${JSON.stringify(simulation.value.err)}`);
        }

        transaction.sign([this.authority]);
        const signature = encodeBase58(transaction.signatures[0]!);

        // The receipts are claimed before sending, so a concurrent pass can't pay them twice.
        const claimed = await this.receipts.claimSettlement({
            publicKey: group.publicKey,
            recipientAddress: group.recipientAddress,
            amount: Number(group.amount),
            transactionSignature: signature,
            lastValidBlockHeight: lifetime.lastValidBlockHeight,
        }, group.receiptIds);
        if (!claimed) return null;

        try {
            await this.connection.sendTransaction(transaction, {
                skipPreflight: false, preflightCommitment: 'confirmed',
                minContextSlot: simulation.context.slot, maxRetries: 3,
            });
        } catch {
            // The RPC may have accepted the transaction before a transport error.
            // Preserve its signature instead of inviting a duplicate payment; reconcile() resolves it later.
            await this.receipts.setSettlementStatus(signature, 'unconfirmed');
            return 'unconfirmed';
        }

        let confirmation;
        try {
            confirmation = await this.connection.confirmTransaction({ signature, ...lifetime }, 'confirmed');
        } catch {
            await this.receipts.setSettlementStatus(signature, 'unconfirmed');
            return 'unconfirmed';
        }

        if (confirmation.value.err !== null) {
            // Nothing was paid, so the receipts are accrued again.
            await this.receipts.setSettlementStatus(signature, 'failed');
            throw new Error(`Transaction failed: ${signature}`);
        }

        await this.receipts.setSettlementStatus(signature, 'confirmed');
        return 'confirmed';
    }

    private withdrawInstruction(user: PublicKey, recipient: PublicKey, amountMicroUsdc: bigint) {
        return createWithdrawEscrowInstruction({
            programId: this.escrowProgramId,
            authority: this.authority.publicKey,
            user,
            recipient,
            feeRecipient: this.feeRecipient,
            mint: this.mint,
            amountMicroUsdc,
        });
    }

    private withdrawTransaction(user: PublicKey, recipient: PublicKey, amountMicroUsdc: bigint, recentBlockhash: string): VersionedTransaction {
        const instruction = this.withdrawInstruction(user, recipient, amountMicroUsdc);
        return new VersionedTransaction(new TransactionMessage({
            payerKey: this.authority.publicKey,
            recentBlockhash,
            instructions: [
                // The protocol fee wallet's token account is created once, at the operator's expense.
                createAssociatedTokenAccountIdempotentInstruction(this.authority.publicKey, instruction.feeTokenAddress, this.feeRecipient, this.mint),
                instruction.instruction,
            ],
        }).compileToV0Message());
    }

    /**
     * Resolves settlements left `pending` or `unconfirmed` (by a crash, an RPC error or a confirmation
     * timeout) from the chain: a landed transaction becomes `confirmed` or `failed`, and one whose
     * blockhash expired without landing becomes `expired`. Failed and expired settlements release
     * their receipts to be paid by a later one.
     * Settlements with no recorded block height stay unconfirmed for manual review.
     */
    async reconcile(now: Date = new Date()): Promise<ReconcileSummary> {
        const settlements = await this.receipts.findUnsettled(new Date(now.getTime() - RECONCILE_MIN_AGE_MS));
        const summary: ReconcileSummary = { checked: settlements.length, confirmed: 0, failed: 0, expired: 0 };
        if (settlements.length === 0) {
            return summary;
        }

        // Read the block height first: a transaction not found after it can't land once the height passes its limit.
        const blockHeight = await this.connection.getBlockHeight('confirmed');
        // getSignatureStatuses accepts at most 256 signatures per call.
        for (let start = 0; start < settlements.length; start += 256) {
            const batch = settlements.slice(start, start + 256);
            const { value: statuses } = await this.connection.getSignatureStatuses(
                batch.map(settlement => settlement.transactionSignature),
                { searchTransactionHistory: true },
            );

            for (const [index, settlement] of batch.entries()) {
                const status = statuses[index];
                if (status && (status.confirmationStatus === 'confirmed' || status.confirmationStatus === 'finalized')) {
                    const outcome = status.err === null ? 'confirmed' : 'failed';
                    await this.receipts.setSettlementStatus(settlement.transactionSignature, outcome);
                    summary[outcome]++;
                } else if (!status && settlement.lastValidBlockHeight !== null && blockHeight > settlement.lastValidBlockHeight) {
                    await this.receipts.setSettlementStatus(settlement.transactionSignature, 'expired');
                    summary.expired++;
                }
            }
        }
        return summary;
    }

}
