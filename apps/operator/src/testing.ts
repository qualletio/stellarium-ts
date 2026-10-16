// Shared fixtures for the operator's tests. Not imported by production code.
import { generateKeyPairSync, sign } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { type AccountInfo, Keypair, PublicKey } from '@solana/web3.js';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import type { Database } from './db/database.js';
import type { EscrowConnection } from './escrow/escrowService.js';
import type { PaymentSubmission } from './routes.js';
import { ESCROW_ACCOUNT_SIZE, getEscrowAddress } from './solana/escrow.js';
import { solanaUserFromSpki } from './solana/userAddress.js';

const migrationsFolder = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../drizzle');

/** An in-memory Postgres with the committed migrations applied. */
export async function createTestDatabase(): Promise<{ db: Database; close: () => Promise<void> }> {
    const client = new PGlite();
    const db = drizzle({ client });
    await migrate(db, { migrationsFolder });
    return { db: db as unknown as Database, close: () => client.close() };
}

/** A node signing key, as base64url SPKI / PKCS#8 DER. */
export function generateNodeKeys() {
    const { publicKey, privateKey } = generateKeyPairSync('ed25519', {
        publicKeyEncoding: { type: 'spki', format: 'der' },
        privateKeyEncoding: { type: 'pkcs8', format: 'der' },
    });
    return { publicKey: publicKey.toString('base64url'), privateKey: privateKey.toString('base64url') };
}

export const RECIPIENT = Keypair.generate().publicKey;

/** A voucher signed the way stellarium-ts's paymentVoucherPayload does. */
export function signedVoucher(keys = generateNodeKeys(), overrides: Partial<Omit<PaymentSubmission['voucher'], 'signature'>> = {}): PaymentSubmission {
    const unsigned = {
        requestId: crypto.randomUUID(),
        invocationId: crypto.randomUUID(),
        amount: 10_000,
        recipientAddress: RECIPIENT.toBase58(),
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        invocationHash: 'hash',
        publicKey: keys.publicKey,
        ...overrides,
    };
    const { requestId, invocationId, amount, recipientAddress, expiresAt, invocationHash, publicKey } = unsigned;
    const payload = Buffer.from(JSON.stringify({ requestId, invocationId, amount, recipientAddress, expiresAt, invocationHash, publicKey }));
    const signature = sign(null, payload, { key: Buffer.from(keys.privateKey, 'base64url'), format: 'der', type: 'pkcs8' }).toString('base64url');
    return { voucher: { ...unsigned, signature } };
}

/** Escrow account data as the program writes it: discriminator, user, authority, bump. */
export function escrowAccount(programId: PublicKey, authority: PublicKey, user: PublicKey, lamports: number): AccountInfo<Buffer> {
    const [, bump] = PublicKey.findProgramAddressSync([Buffer.from('escrow'), authority.toBuffer(), user.toBuffer()], programId);
    const data = Buffer.concat([Buffer.from('ESCROW01'), user.toBuffer(), authority.toBuffer(), Buffer.from([bump])]);
    if (data.length !== ESCROW_ACCOUNT_SIZE) throw new Error('bad fixture');
    return { owner: programId, executable: false, lamports, data, rentEpoch: 0 };
}

export const RENT_MINIMUM = 1_000_000;

/**
 * A Connection fake with one funded escrow per user. Each RPC method is a plain function
 * a test can replace to simulate failures.
 */
export class FakeConnection implements EscrowConnection {
    readonly accounts = new Map<string, AccountInfo<Buffer>>();
    readonly sent: string[] = [];
    blockHeight = 50;
    lastValidBlockHeight = 100;
    readonly statuses = new Map<string, { err: unknown; confirmationStatus: 'processed' | 'confirmed' | 'finalized' }>();

    constructor(readonly programId: PublicKey, readonly authority: PublicKey) {}

    fund(userSpki: string, lamports: number) {
        const user = solanaUserFromSpki(userSpki);
        this.accounts.set(getEscrowAddress(this.programId, this.authority, user).toBase58(), escrowAccount(this.programId, this.authority, user, lamports));
    }

    getAccountInfoAndContext: EscrowConnection['getAccountInfoAndContext'] = async (address) =>
        ({ context: { slot: 1 }, value: this.accounts.get(address.toBase58()) ?? null });

    getMinimumBalanceForRentExemption: EscrowConnection['getMinimumBalanceForRentExemption'] = async () => RENT_MINIMUM;

    getLatestBlockhash: EscrowConnection['getLatestBlockhash'] = async () =>
        ({ blockhash: Keypair.generate().publicKey.toBase58(), lastValidBlockHeight: this.lastValidBlockHeight });

    simulateTransaction = (async () => ({ context: { slot: 2 }, value: { err: null, logs: [] } })) as unknown as EscrowConnection['simulateTransaction'];

    sendTransaction = (async (transaction: { signatures: Uint8Array[] }) => {
        const signature = Buffer.from(transaction.signatures[0]!).toString('hex');
        this.sent.push(signature);
        return signature;
    }) as unknown as EscrowConnection['sendTransaction'];

    confirmTransaction = (async () => ({ context: { slot: 3 }, value: { err: null } })) as unknown as EscrowConnection['confirmTransaction'];

    getSignatureStatuses = (async (signatures: string[]) =>
        ({ context: { slot: 4 }, value: signatures.map(signature => this.statuses.get(signature) ?? null) })) as unknown as EscrowConnection['getSignatureStatuses'];

    getBlockHeight: EscrowConnection['getBlockHeight'] = async () => this.blockHeight;
}
