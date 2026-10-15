import type { Connection, PublicKey, Signer } from '@solana/web3.js';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { EscrowService } from './escrow/escrowService.js';
import { PaymentService } from './paymentService.js';

export interface Service {
    escrowService: EscrowService;
    paymentService: PaymentService;
}

export function createService(db: NodePgDatabase, escrowProgramId: PublicKey, authority: Signer, feeRecipient: PublicKey, connection: Connection): Service {
    return {
        escrowService: new EscrowService(db, escrowProgramId, authority, feeRecipient, connection),
        paymentService: new PaymentService(db),
    };
}
