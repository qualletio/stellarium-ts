// Adapter for the operator's existing web3.js dependency. Builds instructions;
// signing and transaction submission stay with the caller's wallet.
import { PublicKey, SystemProgram, TransactionInstruction } from '@solana/web3.js';
import type { AccountInfo } from '@solana/web3.js';

const ESCROW_SEED = Buffer.from('escrow');
const DISCRIMINATOR = Buffer.from('ESCROW01');
export const ESCROW_ACCOUNT_SIZE = 73;

export function getEscrowAddress(programId: PublicKey, authority: PublicKey, user: PublicKey): PublicKey {
    return PublicKey.findProgramAddressSync(
        [ESCROW_SEED, authority.toBuffer(), user.toBuffer()], programId,
    )[0];
}

/** Authority must equal the program's configured ESCROW_AUTHORITY. */
export function createEscrowInstruction(input: {
    programId: PublicKey;
    authority: PublicKey;
    user: PublicKey;
    payer?: PublicKey;
}): { escrowAddress: PublicKey; instruction: TransactionInstruction } {
    const { programId, authority, user, payer = authority } = input;
    const escrowAddress = getEscrowAddress(programId, authority, user);
    return {
        escrowAddress,
        instruction: new TransactionInstruction({
            programId,
            keys: [
                { pubkey: payer, isSigner: true, isWritable: true },
                { pubkey: user, isSigner: false, isWritable: false },
                { pubkey: authority, isSigner: true, isWritable: false },
                { pubkey: escrowAddress, isSigner: false, isWritable: true },
                { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
            ],
            data: Buffer.from([0]),
        }),
    };
}

/** Must match the program's PROTOCOL_FEE_BPS (2000 = 20%). */
export const PROTOCOL_FEE_BPS = 2_000n;

/** Protocol fee the program takes from a withdrawal, rounded down. */
export function protocolFeeLamports(amountLamports: bigint): bigint {
    return amountLamports * PROTOCOL_FEE_BPS / 10_000n;
}

// TODO: Make this a reasonable max value for the platform to protect against abuse.
const AMOUNT_WITHDRAW_MAX = 18_446_744_073_709_551_615n;

/**
 * Build a SOL withdrawal authorized by the configured controlling wallet.
 * The escrow is debited `amountLamports`; `feeRecipient` (the program's
 * PROTOCOL_FEE_RECIPIENT) receives protocolFeeLamports(amountLamports) and
 * `recipient` the rest, unless the recipient is the fee recipient.
 */
export function createWithdrawEscrowInstruction(input: {
    programId: PublicKey;
    authority: PublicKey;
    user: PublicKey;
    recipient: PublicKey;
    feeRecipient: PublicKey;
    amountLamports: bigint;
}): { escrowAddress: PublicKey; instruction: TransactionInstruction } {
    const { programId, authority, user, recipient, feeRecipient, amountLamports } = input;
    if (typeof amountLamports !== 'bigint' || amountLamports <= 0n ||
        amountLamports > AMOUNT_WITHDRAW_MAX) {
        throw new RangeError('amountLamports must be a positive bigint in the u64 range');
    }
    const escrowAddress = getEscrowAddress(programId, authority, user);
    if (recipient.equals(escrowAddress) || feeRecipient.equals(escrowAddress)) {
        throw new Error('Withdrawal recipient and fee recipient must differ from the escrow');
    }
    const data = Buffer.alloc(9);
    data[0] = 1;
    data.writeBigUInt64LE(amountLamports, 1);
    return {
        escrowAddress,
        instruction: new TransactionInstruction({
            programId,
            keys: [
                { pubkey: authority, isSigner: true, isWritable: false },
                { pubkey: escrowAddress, isSigner: false, isWritable: true },
                { pubkey: recipient, isSigner: false, isWritable: true },
                { pubkey: feeRecipient, isSigner: false, isWritable: true },
            ],
            data,
        }),
    };
}

/** Validate a fetched account before treating it as initialized escrow state. */
export function decodeEscrowAccount(
    programId: PublicKey,
    address: PublicKey,
    account: AccountInfo<Buffer>,
): { user: PublicKey; authority: PublicKey; bump: number } {
    if (!account.owner.equals(programId) || account.executable ||
        account.data.length !== ESCROW_ACCOUNT_SIZE ||
        !account.data.subarray(0, 8).equals(DISCRIMINATOR)) {
        throw new Error('Invalid escrow account');
    }
    const user = new PublicKey(account.data.subarray(8, 40));
    const authority = new PublicKey(account.data.subarray(40, 72));
    const [expectedAddress, bump] = PublicKey.findProgramAddressSync(
        [ESCROW_SEED, authority.toBuffer(), user.toBuffer()], programId,
    );
    if (!address.equals(expectedAddress) || account.data[72] !== bump) {
        throw new Error('Invalid escrow PDA or bump');
    }
    return { user, authority, bump };
}
