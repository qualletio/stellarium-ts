import type { Commitment, Connection, PublicKey } from '@solana/web3.js';
import { decodeEscrowAccount, ESCROW_ACCOUNT_SIZE, getEscrowAddress } from './escrow.js';

export interface EscrowBudget {
    escrowAddress: PublicKey;
    slot: number;
    isInitialized: boolean;
    isRentExempt: boolean;
    totalBalanceLamports: bigint;
    rentReserveLamports: bigint;
    availableBudgetLamports: bigint;
    requestedWithdrawalLamports: bigint;
    shortfallLamports: bigint;
    hasEnoughBudget: boolean;
}

function exactLamports(value: number, label: string): bigint {
    // web3.js exposes RPC u64 values as numbers. Reject precision loss rather
    // than overestimating a provider's budget.
    if (!Number.isSafeInteger(value) || value < 0) {
        throw new Error(`${label} must be a nonnegative safe integer`);
    }
    return BigInt(value);
}

/** Read-only SOL budget snapshot; does not reserve funds or authorize withdrawals. */
export async function getEscrowBudget(input: {
    connection: Pick<Connection, 'getAccountInfoAndContext' | 'getMinimumBalanceForRentExemption'>;
    programId: PublicKey;
    authority: PublicKey;
    user: PublicKey;
    requestedWithdrawalLamports?: bigint;
    commitment?: Commitment;
}): Promise<EscrowBudget> {
    const { connection, programId, authority, user, commitment = 'confirmed',
        requestedWithdrawalLamports = 0n } = input;
    if (typeof requestedWithdrawalLamports !== 'bigint' || requestedWithdrawalLamports < 0n ||
        requestedWithdrawalLamports > 18_446_744_073_709_551_615n) {
        throw new RangeError('requestedWithdrawalLamports must be a bigint in the u64 range');
    }
    const escrowAddress = getEscrowAddress(programId, authority, user);
    const [snapshot, rentMinimum] = await Promise.all([
        connection.getAccountInfoAndContext(escrowAddress, commitment),
        connection.getMinimumBalanceForRentExemption(ESCROW_ACCOUNT_SIZE, commitment),
    ]);
    const rentReserveLamports = exactLamports(rentMinimum, 'Rent reserve');
    // This web3.js method returns zero on some RPC errors. Fail closed.
    if (rentReserveLamports === 0n) {
        throw new Error('Unable to establish a positive escrow rent reserve');
    }
    const account = snapshot.value;
    if (account !== null) {
        const state = decodeEscrowAccount(programId, escrowAddress, account);
        if (!state.authority.equals(authority) || !state.user.equals(user)) {
            throw new Error('Escrow user or authority does not match the request');
        }
    }
    const totalBalanceLamports = account === null ? 0n : exactLamports(account.lamports, 'Escrow balance');
    const isInitialized = account !== null;
    const isRentExempt = isInitialized && totalBalanceLamports >= rentReserveLamports;
    const availableBudgetLamports = isRentExempt ? totalBalanceLamports - rentReserveLamports : 0n;
    const shortfallLamports = requestedWithdrawalLamports > availableBudgetLamports
        ? requestedWithdrawalLamports - availableBudgetLamports : 0n;
    return {
        escrowAddress, slot: snapshot.context.slot, isInitialized, isRentExempt,
        totalBalanceLamports, rentReserveLamports, availableBudgetLamports,
        requestedWithdrawalLamports, shortfallLamports,
        hasEnoughBudget: isRentExempt && shortfallLamports === 0n,
    };
}
