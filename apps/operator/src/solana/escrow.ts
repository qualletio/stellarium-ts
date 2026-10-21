// Adapter for the operator's existing web3.js dependency. Builds instructions;
// signing and transaction submission stay with the caller's wallet.
import { ASSOCIATED_TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID } from '@solana/spl-token';
import { PublicKey, SystemProgram, TransactionInstruction } from '@solana/web3.js';
import type { AccountInfo } from '@solana/web3.js';

const ESCROW_SEED = Buffer.from('escrow');
const DISCRIMINATOR = Buffer.from('ESCROW02');
export const ESCROW_ACCOUNT_SIZE = 73;

export function getEscrowAddress(programId: PublicKey, authority: PublicKey, user: PublicKey): PublicKey {
    return PublicKey.findProgramAddressSync(
        [ESCROW_SEED, authority.toBuffer(), user.toBuffer()], programId,
    )[0];
}

/** The escrow's USDC token account: the escrow PDA's associated token account. Users deposit here. */
export function getEscrowTokenAddress(programId: PublicKey, authority: PublicKey, user: PublicKey, mint: PublicKey): PublicKey {
    return getAssociatedTokenAddressSync(mint, getEscrowAddress(programId, authority, user), true);
}

/**
 * Authority must equal the program's configured ESCROW_AUTHORITY, and mint its USDC_MINT.
 * The user signs and pays rent for the escrow and its token account; the authority doesn't sign.
 */
export function createEscrowInstruction(input: {
    programId: PublicKey;
    authority: PublicKey;
    user: PublicKey;
    mint: PublicKey;
}): { escrowAddress: PublicKey; escrowTokenAddress: PublicKey; instruction: TransactionInstruction } {
    const { programId, authority, user, mint } = input;
    const escrowAddress = getEscrowAddress(programId, authority, user);
    const escrowTokenAddress = getAssociatedTokenAddressSync(mint, escrowAddress, true);
    return {
        escrowAddress,
        escrowTokenAddress,
        instruction: new TransactionInstruction({
            programId,
            keys: [
                { pubkey: user, isSigner: true, isWritable: true },
                { pubkey: authority, isSigner: false, isWritable: false },
                { pubkey: escrowAddress, isSigner: false, isWritable: true },
                { pubkey: escrowTokenAddress, isSigner: false, isWritable: true },
                { pubkey: mint, isSigner: false, isWritable: false },
                { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
                { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
                { pubkey: ASSOCIATED_TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
            ],
            data: Buffer.from([0]),
        }),
    };
}

/** Must match the program's PROTOCOL_FEE_BPS (2000 = 20%). */
export const PROTOCOL_FEE_BPS = 2_000n;

/** Protocol fee the program takes from a withdrawal, rounded down. */
export function protocolFee(amountMicroUsdc: bigint): bigint {
    return amountMicroUsdc * PROTOCOL_FEE_BPS / 10_000n;
}

// TODO: Make this a reasonable max value for the platform to protect against abuse.
const AMOUNT_WITHDRAW_MAX = 18_446_744_073_709_551_615n;

/**
 * Build a USDC withdrawal authorized by the configured controlling wallet.
 * The escrow token account is debited `amountMicroUsdc`; the associated token account of
 * `feeRecipient` (the program's PROTOCOL_FEE_RECIPIENT) receives protocolFee(amountMicroUsdc)
 * and the associated token account of `recipient` the rest, unless the recipient is the fee recipient.
 * Both destination token accounts must exist: see createAssociatedTokenAccountIdempotentInstruction.
 */
export function createWithdrawEscrowInstruction(input: {
    programId: PublicKey;
    authority: PublicKey;
    user: PublicKey;
    recipient: PublicKey;
    feeRecipient: PublicKey;
    mint: PublicKey;
    amountMicroUsdc: bigint;
}): { escrowAddress: PublicKey; escrowTokenAddress: PublicKey; recipientTokenAddress: PublicKey; feeTokenAddress: PublicKey; instruction: TransactionInstruction } {
    const { programId, authority, user, recipient, feeRecipient, mint, amountMicroUsdc } = input;
    if (typeof amountMicroUsdc !== 'bigint' || amountMicroUsdc <= 0n ||
        amountMicroUsdc > AMOUNT_WITHDRAW_MAX) {
        throw new RangeError('amountMicroUsdc must be a positive bigint in the u64 range');
    }
    const escrowAddress = getEscrowAddress(programId, authority, user);
    if (recipient.equals(escrowAddress) || feeRecipient.equals(escrowAddress)) {
        throw new Error('Withdrawal recipient and fee recipient must differ from the escrow');
    }
    const escrowTokenAddress = getAssociatedTokenAddressSync(mint, escrowAddress, true);
    // Recipients may be PDAs, so allow off-curve owners.
    const recipientTokenAddress = getAssociatedTokenAddressSync(mint, recipient, true);
    const feeTokenAddress = getAssociatedTokenAddressSync(mint, feeRecipient, true);
    const data = Buffer.alloc(9);
    data[0] = 1;
    data.writeBigUInt64LE(amountMicroUsdc, 1);
    return {
        escrowAddress,
        escrowTokenAddress,
        recipientTokenAddress,
        feeTokenAddress,
        instruction: new TransactionInstruction({
            programId,
            keys: [
                { pubkey: authority, isSigner: true, isWritable: false },
                { pubkey: escrowAddress, isSigner: false, isWritable: false },
                { pubkey: escrowTokenAddress, isSigner: false, isWritable: true },
                { pubkey: recipientTokenAddress, isSigner: false, isWritable: true },
                { pubkey: feeTokenAddress, isSigner: false, isWritable: true },
                { pubkey: mint, isSigner: false, isWritable: false },
                { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
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
