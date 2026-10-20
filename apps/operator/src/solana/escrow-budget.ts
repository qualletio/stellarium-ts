import { getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID, unpackAccount } from '@solana/spl-token';
import type { Commitment, Connection, PublicKey } from '@solana/web3.js';
import { decodeEscrowAccount, getEscrowAddress } from './escrow.js';

export interface EscrowBudget {
    escrowAddress: PublicKey;
    escrowTokenAddress: PublicKey;
    slot: number;
    /** Both the escrow state account and its USDC token account exist. */
    isInitialized: boolean;
    totalBalanceMicroUsdc: bigint;
    /** The full token balance, or zero while the token account is frozen. */
    availableBudgetMicroUsdc: bigint;
    requestedWithdrawalMicroUsdc: bigint;
    shortfallMicroUsdc: bigint;
    hasEnoughBudget: boolean;
}

/** Read-only USDC budget snapshot; does not reserve funds or authorize withdrawals. */
export async function getEscrowBudget(input: {
    connection: Pick<Connection, 'getAccountInfoAndContext'>;
    programId: PublicKey;
    authority: PublicKey;
    user: PublicKey;
    mint: PublicKey;
    requestedWithdrawalMicroUsdc?: bigint;
    commitment?: Commitment;
}): Promise<EscrowBudget> {
    const { connection, programId, authority, user, mint, commitment = 'confirmed',
        requestedWithdrawalMicroUsdc = 0n } = input;
    if (typeof requestedWithdrawalMicroUsdc !== 'bigint' || requestedWithdrawalMicroUsdc < 0n ||
        requestedWithdrawalMicroUsdc > 18_446_744_073_709_551_615n) {
        throw new RangeError('requestedWithdrawalMicroUsdc must be a bigint in the u64 range');
    }
    const escrowAddress = getEscrowAddress(programId, authority, user);
    const escrowTokenAddress = getAssociatedTokenAddressSync(mint, escrowAddress, true);
    const [snapshot, tokenSnapshot] = await Promise.all([
        connection.getAccountInfoAndContext(escrowAddress, commitment),
        connection.getAccountInfoAndContext(escrowTokenAddress, commitment),
    ]);
    const account = snapshot.value;
    if (account !== null) {
        const state = decodeEscrowAccount(programId, escrowAddress, account);
        if (!state.authority.equals(authority) || !state.user.equals(user)) {
            throw new Error('Escrow user or authority does not match the request');
        }
    }
    let totalBalanceMicroUsdc = 0n;
    let isFrozen = false;
    if (tokenSnapshot.value !== null) {
        // unpackAccount rejects accounts not owned by the token program.
        const token = unpackAccount(escrowTokenAddress, tokenSnapshot.value, TOKEN_PROGRAM_ID);
        if (!token.mint.equals(mint) || !token.owner.equals(escrowAddress)) {
            throw new Error('Escrow token account has the wrong mint or owner');
        }
        totalBalanceMicroUsdc = token.amount;
        isFrozen = token.isFrozen;
    }
    const isInitialized = account !== null && tokenSnapshot.value !== null;
    const availableBudgetMicroUsdc = isInitialized && !isFrozen ? totalBalanceMicroUsdc : 0n;
    const shortfallMicroUsdc = requestedWithdrawalMicroUsdc > availableBudgetMicroUsdc
        ? requestedWithdrawalMicroUsdc - availableBudgetMicroUsdc : 0n;
    return {
        escrowAddress, escrowTokenAddress, slot: snapshot.context.slot, isInitialized,
        totalBalanceMicroUsdc, availableBudgetMicroUsdc,
        requestedWithdrawalMicroUsdc, shortfallMicroUsdc,
        hasEnoughBudget: isInitialized && shortfallMicroUsdc === 0n,
    };
}
