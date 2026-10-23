import { randomBytes } from "node:crypto";
import { and, eq, gt, isNull } from "drizzle-orm";
import type { Database } from "./db/database.js";
import { enrollmentTokensTable, nodesTable, organizationsTable } from "./db/schema.js";
import { newId, sha256Hex } from "./crypto.js";
import { OperationError } from "./errors.js";
import { accounts, adjustOrganization, lockOrganizations, type Organization, postLedgerTransaction } from "./ledger.js";

export type Node = typeof nodesTable.$inferSelect;

export const ENROLLMENT_TOKEN_LIFETIME_MS = 1000 * 60 * 60 * 24;

/** Organizations, the node keys enrolled in them, and enrollment. */
export class OrganizationService {
    constructor(private readonly db: Database) {}

    /** `id` defaults to a new random one. Returns undefined, creating nothing, if an organization with `id` exists. */
    async create(name: string, options: { id?: string, clerkOrgId?: string } = {}): Promise<Organization | undefined> {
        const [organization] = await this.db.insert(organizationsTable)
            .values({ id: options.id ?? newId('org'), name, clerkOrgId: options.clerkOrgId })
            .onConflictDoNothing({ target: organizationsTable.id })
            .returning();
        return organization;
    }

    async get(id: string): Promise<Organization | undefined> {
        const [organization] = await this.db.select().from(organizationsTable).where(eq(organizationsTable.id, id)).limit(1);
        return organization;
    }

    async getNode(publicKey: string): Promise<Node | undefined> {
        const [node] = await this.db.select().from(nodesTable).where(eq(nodesTable.publicKey, publicKey)).limit(1);
        return node;
    }

    async setPayoutsEnabled(id: string, payoutsEnabled: boolean): Promise<void> {
        await this.db.update(organizationsTable).set({ payoutsEnabled, updatedAt: new Date() }).where(eq(organizationsTable.id, id));
    }

    /** Returns a new one-time token. Only its hash is stored, so this is the only time it can be read. */
    async createEnrollmentToken(organizationId: string, options: { label?: string, createdBy?: string, lifetimeMs?: number } = {}): Promise<{ token: string, expiresAt: Date }> {
        const token = `enr_${randomBytes(24).toString('base64url')}`;
        const expiresAt = new Date(Date.now() + (options.lifetimeMs ?? ENROLLMENT_TOKEN_LIFETIME_MS));
        await this.db.insert(enrollmentTokensTable).values({
            tokenHash: sha256Hex(token), organizationId, label: options.label, createdBy: options.createdBy, expiresAt,
        });
        return { token, expiresAt };
    }

    /**
     * Returns the organization a node is enrolled in, first enrolling it with `enrollmentToken` if it
     * isn't enrolled yet. An enrolled node's token is ignored, so a node may keep it configured.
     */
    async session(publicKey: string, enrollmentToken?: string): Promise<{ organizationId: string }> {
        const node = await this.getNode(publicKey);
        if (node) {
            if (node.revokedAt) throw new OperationError(403, 'Node has been revoked');
            return { organizationId: node.organizationId };
        }
        if (!enrollmentToken) {
            throw new OperationError(403, 'Node is not enrolled in an organization');
        }
        return this.db.transaction(async (tx) => {
            // Claiming the token and adding the node commit together, so a token enrolls exactly one node.
            const [claimed] = await tx.update(enrollmentTokensTable)
                .set({ usedAt: new Date() })
                .where(and(
                    eq(enrollmentTokensTable.tokenHash, sha256Hex(enrollmentToken)),
                    isNull(enrollmentTokensTable.usedAt),
                    gt(enrollmentTokensTable.expiresAt, new Date()),
                ))
                .returning();
            if (!claimed) {
                throw new OperationError(403, 'Enrollment token is invalid, used or expired');
            }
            await tx.insert(nodesTable).values({ publicKey, organizationId: claimed.organizationId, label: claimed.label });
            return { organizationId: claimed.organizationId };
        });
    }

    /** Adds a node directly, without a token. For trusted callers such as the development seed. */
    async enroll(organizationId: string, publicKey: string, label?: string): Promise<void> {
        await this.db.insert(nodesTable).values({ publicKey, organizationId, label }).onConflictDoNothing();
    }

    /** Credits an organization's balance without a payment. */
    async grantPromotion(organizationId: string, amountMicroUsd: number): Promise<void> {
        await this.db.transaction(async (tx) => {
            await lockOrganizations(tx, [organizationId]);
            await postLedgerTransaction(tx, 'promotion', [
                { account: accounts.promotions, amountMicroUsd: -amountMicroUsd },
                { account: accounts.balance(organizationId), amountMicroUsd },
            ]);
            await adjustOrganization(tx, organizationId, { balance: amountMicroUsd });
        });
    }
}
