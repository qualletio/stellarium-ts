import type { Signer } from "@solana/web3.js";
import { Connection, PublicKey, TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import { NodePgDatabase } from "drizzle-orm/node-postgres";
import { receiptsTable } from "../db/schema.js";
import { OperationError } from "../errors.js";
import type { PaymentSubmission } from "../routes.js";
import { getEscrowBudget } from "../solana/escrow-budget.js";
import { createEscrowInstruction, createWithdrawEscrowInstruction, decodeEscrowAccount } from "../solana/escrow.js";

export interface OperationResult {
    escrowAddress: string;
    status: 'confirmed' | 'unconfirmed' | 'existing';
    signature?: string;
    blockhash?: string;
    lastValidBlockHeight?: number;
}

/**
 * The EscrowService is responsible for communicating with Solana to initiate and withdraw from an escrow account.
 */
export class EscrowService {
    constructor(private readonly db: NodePgDatabase, private readonly escrowProgramId: PublicKey, private readonly authority: Signer, private readonly connection: Connection) {}

    async initiateEscrow(user: PublicKey): Promise<OperationResult> {
        const instruction = createEscrowInstruction({
            programId: this.escrowProgramId,
            authority: this.authority.publicKey,
            user,
        });

        const snapshot = await this.connection.getAccountInfoAndContext(instruction.escrowAddress, 'confirmed');
        if (snapshot.value !== null && snapshot.value.owner.equals(this.escrowProgramId)) {
            try {
                const state = decodeEscrowAccount(this.escrowProgramId, instruction.escrowAddress, snapshot.value);
                if (!state.user.equals(user) || !state.authority.equals(this.authority.publicKey)) throw new Error('State mismatch');
            } catch {
                throw new OperationError(409, 'Existing escrow account has invalid state');
            }
            return { escrowAddress: instruction.escrowAddress.toBase58(), status: 'existing' };
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
        const signature = this.signatureAddress(transaction.signatures[0]!);
        const result = { escrowAddress: instruction.escrowAddress.toBase58(), signature, ...lifetime };

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
        const { voucher, resourcePath, resourceName, parameters } = submission;
        const { requestId, invocationId, amount, recipientAddress, signature: voucherSignature, expiresAt, publicKey } = voucher;
        const user = new PublicKey(voucher.publicKey);
        const recipient = new PublicKey(recipientAddress);
        const amountLamports = BigInt(amount);

        const instruction = createWithdrawEscrowInstruction({
            programId: this.escrowProgramId,
            authority: this.authority.publicKey,
            user,
            recipient,
            amountLamports,
        });

        const budget = await getEscrowBudget({ connection: this.connection, programId: this.escrowProgramId, authority: this.authority.publicKey, user, requestedWithdrawalLamports: amountLamports });
        if (!budget.isInitialized) throw new OperationError(404, 'Escrow account does not exist');
        if (!budget.hasEnoughBudget) throw new OperationError(409, 'Insufficient escrow budget after reserving rent');

        const snapshot = await this.connection.getAccountInfoAndContext(instruction.escrowAddress, 'confirmed');
        if (snapshot.value !== null && snapshot.value.owner.equals(this.escrowProgramId)) {
            try {
                const state = decodeEscrowAccount(this.escrowProgramId, instruction.escrowAddress, snapshot.value);
                if (!state.user.equals(user) || !state.authority.equals(this.authority.publicKey)) throw new Error('State mismatch');
            } catch {
                throw new OperationError(409, 'Existing escrow account has invalid state');
            }
            return { escrowAddress: instruction.escrowAddress.toBase58(), status: 'existing' };
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
            throw new OperationError(422, 'Transaction simulation failed');
        }

        transaction.sign([this.authority]);
        const signature = this.signatureAddress(transaction.signatures[0]!);
        const result = { escrowAddress: instruction.escrowAddress.toBase58(), signature, ...lifetime };

        await this.db.insert(receiptsTable).values({
            requestId,
            invocationId,
            amount,
            recipientAddress: recipient.toBase58(),
            voucherSignature,
            transactionSignature: signature,
            expiresAt: new Date(expiresAt),
            publicKey,
            resourcePath,
            resourceName,
            parameters,
        });

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

    // Encode the public transaction signature without adding another SDK dependency.
    private signatureAddress(signature: Uint8Array): string {
        const alphabet = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
        let value = BigInt(`0x${Buffer.from(signature).toString('hex')}`);
        let encoded = '';
        while (value > 0n) {
            encoded = alphabet[Number(value % 58n)] + encoded;
            value /= 58n;
        }
        for (const byte of signature) {
            if (byte !== 0) break;
            encoded = '1' + encoded;
        }
        return encoded;
    }
}
