// Shared fixtures for the operator's tests. Not imported by production code.
import { generateKeyPairSync, sign } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { NODE_AUTH_SCHEME, operatorRequestPayload } from './auth/nodeAuth.js';
import type { Database } from './db/database.js';
import { OrganizationService } from './organizations.js';
import type { FixedPaymentSubmission, InferencePaymentSubmission } from './payments/types.js';

const migrationsFolder = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../drizzle');

/** An in-memory Postgres with the committed migrations applied. */
export async function createTestDatabase(): Promise<{ db: Database; close: () => Promise<void> }> {
    const client = new PGlite();
    const db = drizzle({ client });
    await migrate(db, { migrationsFolder });
    return { db: db as unknown as Database, close: () => client.close() };
}

export type NodeKeys = { publicKey: string; privateKey: string };

/** A node signing key, as base64url SPKI / PKCS#8 DER. */
export function generateNodeKeys(): NodeKeys {
    const { publicKey, privateKey } = generateKeyPairSync('ed25519', {
        publicKeyEncoding: { type: 'spki', format: 'der' },
        privateKeyEncoding: { type: 'pkcs8', format: 'der' },
    });
    return { publicKey: publicKey.toString('base64url'), privateKey: privateKey.toString('base64url') };
}

function signJson(payload: object, privateKey: string): string {
    return sign(null, Buffer.from(JSON.stringify(payload)), { key: Buffer.from(privateKey, 'base64url'), format: 'der', type: 'pkcs8' }).toString('base64url');
}

export const PROVIDER_ORGANIZATION = 'org_provider';
export const PAYER_ORGANIZATION = 'org_payer';

/**
 * A provider organization that can be paid, with one node, and a payer organization holding
 * `balance` micro-USD of promotional credit, with one node.
 */
export async function seedOrganizations(db: Database, balance = 1_000_000) {
    const organizations = new OrganizationService(db);
    const provider = generateNodeKeys();
    const payer = generateNodeKeys();
    await organizations.create('Provider', { id: PROVIDER_ORGANIZATION });
    await organizations.setPayoutsEnabled(PROVIDER_ORGANIZATION, true);
    await organizations.enroll(PROVIDER_ORGANIZATION, provider.publicKey);
    await organizations.create('Payer', { id: PAYER_ORGANIZATION });
    await organizations.enroll(PAYER_ORGANIZATION, payer.publicKey);
    if (balance > 0) await organizations.grantPromotion(PAYER_ORGANIZATION, balance);
    return { organizations, provider, payer };
}

/** A voucher signed the way stellarium-ts's paymentVoucherPayload does. */
export function signedVoucher(keys = generateNodeKeys(), overrides: Partial<Omit<FixedPaymentSubmission['voucher'], 'signature' | 'kind'>> = {}): FixedPaymentSubmission {
    const unsigned = {
        requestId: crypto.randomUUID(),
        invocationId: crypto.randomUUID(),
        amount: 10_000,
        recipientOrganizationId: PROVIDER_ORGANIZATION,
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        invocationHash: 'hash',
        publicKey: keys.publicKey,
        ...overrides,
    };
    const { requestId, invocationId, amount, recipientOrganizationId, expiresAt, invocationHash, publicKey } = unsigned;
    const signature = signJson({ requestId, invocationId, amount, recipientOrganizationId, expiresAt, invocationHash, publicKey }, keys.privateKey);
    return { voucher: { ...unsigned, signature } };
}

/** An inference voucher signed the way stellarium-ts's inferenceVoucherPayload does, with the usage a provider reports. */
export function signedInferenceVoucher(
    keys = generateNodeKeys(),
    overrides: Partial<Omit<InferencePaymentSubmission['voucher'], 'signature' | 'kind'>> = {},
    usage: InferencePaymentSubmission['usage'] = { inputTokens: 1_000, outputTokens: 500 },
): InferencePaymentSubmission {
    const unsigned = {
        kind: 'inference' as const,
        requestId: crypto.randomUUID(),
        invocationId: crypto.randomUUID(),
        maxAmount: 20_000,
        inputCostMicroUsdPerMillionTokens: 3_000_000,
        outputCostMicroUsdPerMillionTokens: 15_000_000,
        maxTokens: 1_000,
        recipientOrganizationId: PROVIDER_ORGANIZATION,
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        invocationHash: 'hash',
        publicKey: keys.publicKey,
        ...overrides,
    };
    const {
        kind, requestId, invocationId, maxAmount, inputCostMicroUsdPerMillionTokens, outputCostMicroUsdPerMillionTokens,
        maxTokens, recipientOrganizationId, expiresAt, invocationHash, publicKey,
    } = unsigned;
    const signature = signJson({
        kind, requestId, invocationId, maxAmount, inputCostMicroUsdPerMillionTokens, outputCostMicroUsdPerMillionTokens,
        maxTokens, recipientOrganizationId, expiresAt, invocationHash, publicKey,
    }, keys.privateKey);
    return { voucher: { ...unsigned, signature }, usage };
}

/** The `Authorization` header a node sends, as stellarium-ts's operatorAuthorization builds it. */
export function nodeAuthorization(keys: NodeKeys, method: string, path: string, body: unknown, timestamp = new Date().toISOString()): string {
    const signature = signJson(operatorRequestPayload(method, path, body, timestamp), keys.privateKey);
    return `${NODE_AUTH_SCHEME} ${Buffer.from(JSON.stringify({ publicKey: keys.publicKey, timestamp, signature })).toString('base64url')}`;
}
