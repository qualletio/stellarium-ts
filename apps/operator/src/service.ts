import type { PublicKey, Signer } from '@solana/web3.js';
import type { Database } from './db/database.js';
import { type EscrowConnection, EscrowService } from './escrow/escrowService.js';
import { PaymentService } from './paymentService.js';
import { ReceiptRepository } from './repository.js';

export interface Service {
    escrowService: EscrowService;
    paymentService: PaymentService;
}

export function createService(db: Database, escrowProgramId: PublicKey, authority: Signer, feeRecipient: PublicKey, mint: PublicKey, connection: EscrowConnection): Service {
    const receipts = new ReceiptRepository(db);
    return {
        escrowService: new EscrowService(receipts, escrowProgramId, authority, feeRecipient, mint, connection),
        paymentService: new PaymentService(receipts),
    };
}
