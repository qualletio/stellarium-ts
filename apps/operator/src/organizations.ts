import { randomBytes } from "node:crypto";
import { and, desc, eq, gt, isNull, lt, ne, type SQL, sql } from "drizzle-orm";
import type { Database } from "./db/database.js";
import { enrollmentTokensTable, nodesTable, organizationsTable, payoutsTable, receiptsTable, runsTable, topUpsTable } from "./db/schema.js";
import { newId, sha256Hex } from "./crypto.js";
import { OperationError } from "./errors.js";
import { accounts, adjustOrganization, lockOrganizations, type Organization, postLedgerTransaction } from "./ledger.js";

export type Node = typeof nodesTable.$inferSelect;

export const ENROLLMENT_TOKEN_LIFETIME_MS = 1000 * 60 * 60 * 24;

/** Returns the public key `{baseUrl}/v1/self` answers with, or undefined if it can't be reached. Tests replace it. */
export type NodeVerifier = (baseUrl: string) => Promise<string | undefined>;

export const NODE_VERIFY_TIMEOUT_MS = 5_000;

export const fetchNodePublicKey: NodeVerifier = async (baseUrl) => {
    try {
        const response = await fetch(`${baseUrl}/v1/self`, { signal: AbortSignal.timeout(NODE_VERIFY_TIMEOUT_MS), redirect: 'error' });
        if (!response.ok) return undefined;
        const { publicKey } = await response.json() as { publicKey?: unknown };
        return typeof publicKey === 'string' ? publicKey : undefined;
    } catch {
        return undefined;
    }
};

/** What an organization admin may change about a node's listing. */
export interface ListingUpdate {
    name?: string;
    description?: string | null;
    priceMicroUsdPerMillionTokens?: number;
    listed?: boolean;
}

/** Newest first. `before` is the last id of the previous page. */
export interface Page {
    limit: number;
    before?: number;
}

/**
 * When an organization's prepaid balance is large and idle enough to warn it. Stripe's risk checks flag card
 * top-ups that sit unspent: a dispute on one long after it was paid may come after its money has moved on.
 */
export interface IdleBalancePolicy {
    /** Top-ups older than this that are still unspent are idle. */
    ageMs: number;
    /** Organizations with at least this much idle are warned. */
    warningMicroUsd: number;
}

export const DEFAULT_IDLE_BALANCE_POLICY: IdleBalancePolicy = { ageMs: 30 * 24 * 60 * 60 * 1000, warningMicroUsd: 500 * 1_000_000 };

/** How much of an organization's balance is idle, and what "idle" means, in days. */
export interface IdleBalance {
    amountMicroUsd: number;
    days: number;
}

/** Organizations, the node keys enrolled in them, and enrollment. */
export class OrganizationService {
    constructor(
        private readonly db: Database,
        private readonly verifyNode: NodeVerifier = fetchNodePublicKey,
        private readonly idleBalancePolicy: IdleBalancePolicy = DEFAULT_IDLE_BALANCE_POLICY,
    ) {}

    /** `id` defaults to a new random one. Returns undefined, creating nothing, if an organization with `id` exists. */
    async create(name: string, options: { id?: string, authOrganizationId?: string } = {}): Promise<Organization | undefined> {
        const [organization] = await this.db.insert(organizationsTable)
            .values({ id: options.id ?? newId('org'), name, authOrganizationId: options.authOrganizationId })
            .onConflictDoNothing({ target: organizationsTable.id })
            .returning();
        return organization;
    }

    async get(id: string): Promise<Organization | undefined> {
        const [organization] = await this.db.select().from(organizationsTable).where(eq(organizationsTable.id, id)).limit(1);
        return organization;
    }

    /** The organization for a dashboard organization, created on first use with its `name`. */
    async forAuthOrganization(authOrganizationId: string, name: string): Promise<Organization> {
        const existing = async () => (await this.db.select().from(organizationsTable).where(eq(organizationsTable.authOrganizationId, authOrganizationId)).limit(1))[0];
        const found = await existing();
        // Follows renames in the dashboard.
        if (found && found.name !== name) {
            const [renamed] = await this.db.update(organizationsTable).set({ name, updatedAt: new Date() }).where(eq(organizationsTable.id, found.id)).returning();
            return renamed;
        }
        if (found) return found;
        await this.db.insert(organizationsTable).values({ id: newId('org'), name, authOrganizationId })
            .onConflictDoNothing({ target: organizationsTable.authOrganizationId });
        // Another request may have created it first.
        return (await existing())!;
    }

    async getNode(publicKey: string): Promise<Node | undefined> {
        const [node] = await this.db.select().from(nodesTable).where(eq(nodesTable.publicKey, publicKey)).limit(1);
        return node;
    }

    /**
     * Throws (403) unless the node may authorize or move anything: enrolled, not revoked or suspended, and its
     * organization not banned. A suspended node may still settle what it started.
     */
    async requireActiveNode(publicKey: string): Promise<Node> {
        const [row] = await this.db.select({ node: nodesTable, organization: organizationsTable }).from(nodesTable)
            .innerJoin(organizationsTable, eq(organizationsTable.id, nodesTable.organizationId))
            .where(eq(nodesTable.publicKey, publicKey)).limit(1);
        if (!row || row.node.revokedAt) throw new OperationError(403, 'Node has been revoked');
        if (row.organization.bannedAt) throw new OperationError(403, 'The node\'s organization is banned');
        if (row.organization.closedAt) throw new OperationError(403, 'The node\'s organization is closed');
        if (row.node.suspendedAt) throw new OperationError(403, 'The node is suspended while its verification is reviewed');
        return row.node;
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
     * Records the `baseUrl` the node reports. A listed node that reports a new one is unlisted until verified again.
     */
    async session(publicKey: string, enrollmentToken?: string, baseUrl?: string): Promise<{ organizationId: string, priceMicroUsdPerMillionTokens: number }> {
        const node = await this.getNode(publicKey);
        if (node) {
            if (node.revokedAt) throw new OperationError(403, 'Node has been revoked');
            if (baseUrl !== undefined && baseUrl !== node.baseUrl) {
                await this.db.update(nodesTable).set({ baseUrl, listed: false, verifiedAt: null }).where(eq(nodesTable.publicKey, publicKey));
            }
            return { organizationId: node.organizationId, priceMicroUsdPerMillionTokens: node.priceMicroUsdPerMillionTokens };
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
            await tx.insert(nodesTable).values({ publicKey, organizationId: claimed.organizationId, label: claimed.label, baseUrl });
            // A new node's price starts at the default, 0, until it is listed.
            return { organizationId: claimed.organizationId, priceMicroUsdPerMillionTokens: 0 };
        });
    }

    /** Adds a node directly, without a token. For trusted callers such as the development seed. */
    async enroll(organizationId: string, publicKey: string, label?: string): Promise<void> {
        await this.db.insert(nodesTable).values({ publicKey, organizationId, label }).onConflictDoNothing();
    }

    async listNodes(organizationId: string): Promise<Node[]> {
        return this.db.select().from(nodesTable).where(eq(nodesTable.organizationId, organizationId)).orderBy(desc(nodesTable.createdAt));
    }

    /** Revokes one of the organization's nodes. Its key stays taken, so it can't be enrolled again. */
    async revokeNode(organizationId: string, publicKey: string): Promise<void> {
        const [revoked] = await this.db.update(nodesTable).set({ revokedAt: new Date() })
            .where(and(eq(nodesTable.publicKey, publicKey), eq(nodesTable.organizationId, organizationId), isNull(nodesTable.revokedAt)))
            .returning();
        if (!revoked && !(await this.getNode(publicKey))?.revokedAt) {
            throw new OperationError(404, 'Node not found');
        }
    }

    /**
     * Changes one of the organization's nodes' listing. Listing requires a name and a base URL whose
     * `/v1/self` answers with the node's key, checked each time the node is listed.
     */
    async updateListing(organizationId: string, publicKey: string, update: ListingUpdate): Promise<Node> {
        const node = await this.getNode(publicKey);
        if (!node || node.organizationId !== organizationId) {
            throw new OperationError(404, 'Node not found');
        }
        if (node.revokedAt) {
            throw new OperationError(409, 'Node has been revoked');
        }
        const changes: Partial<Node> = {};
        if (update.name !== undefined) changes.name = update.name;
        if (update.description !== undefined) changes.description = update.description;
        if (update.priceMicroUsdPerMillionTokens !== undefined) changes.priceMicroUsdPerMillionTokens = update.priceMicroUsdPerMillionTokens;
        if (update.listed === false) changes.listed = false;
        if (update.listed === true) {
            if (!(changes.name ?? node.name)) {
                throw new OperationError(400, 'A listed node needs a name');
            }
            if (!node.baseUrl) {
                throw new OperationError(409, 'The node hasn\'t reported its URL yet. Restart it with OPERATOR_URL set');
            }
            if (await this.verifyNode(node.baseUrl) !== publicKey) {
                throw new OperationError(422, `${node.baseUrl}/v1/self didn't answer with this node's key`);
            }
            changes.listed = true;
            changes.verifiedAt = new Date();
        }
        const [updated] = await this.db.update(nodesTable).set(changes).where(eq(nodesTable.publicKey, publicKey)).returning();
        return updated!;
    }

    /** Every listed node, with its organization's name, for callers choosing a node. */
    async listings() {
        return this.db.select({
            publicKey: nodesTable.publicKey,
            name: nodesTable.name,
            description: nodesTable.description,
            baseUrl: nodesTable.baseUrl,
            priceMicroUsdPerMillionTokens: nodesTable.priceMicroUsdPerMillionTokens,
            organizationId: nodesTable.organizationId,
            organizationName: organizationsTable.name,
            verifiedAt: nodesTable.verifiedAt,
        })
            .from(nodesTable)
            .innerJoin(organizationsTable, eq(organizationsTable.id, nodesTable.organizationId))
            .where(and(eq(nodesTable.listed, true), isNull(nodesTable.revokedAt)))
            .orderBy(nodesTable.name);
    }

    /**
     * A node's money limits (docs/money.md), all 0 until the operator's staff raise them after reviewing the node.
     * Not exposed to organizations.
     */
    async setNodeMoneyLimits(publicKey: string, limits: { maxApiKeyRunValueMicroUsd?: number, monthlyApiKeyValueCapMicroUsd?: number, maxContractBalanceMicroUsd?: number }): Promise<void> {
        for (const value of Object.values(limits)) {
            if (!Number.isSafeInteger(value) || value < 0) throw new OperationError(400, 'Limits are whole micro-USD, at least 0');
        }
        const updated = await this.db.update(nodesTable).set(limits).where(eq(nodesTable.publicKey, publicKey)).returning({ publicKey: nodesTable.publicKey });
        if (updated.length === 0) throw new OperationError(404, 'Node not found');
    }

    /** Runs the organization paid for (`payer`) or was paid for (`provider`). Runs a node opened for itself, which cost nothing, aren't listed. */
    async listRuns(organizationId: string, as: 'payer' | 'provider', page: Page) {
        const owner = and(
            as === 'payer' ? eq(runsTable.payerOrganizationId, organizationId) : eq(runsTable.recipientOrganizationId, organizationId),
            ne(runsTable.kind, 'free'),
        )!;
        return this.db.select().from(runsTable).where(page.before === undefined ? owner : and(owner, lt(runsTable.id, page.before)))
            .orderBy(desc(runsTable.id)).limit(page.limit);
    }

    /** Receipts the organization paid (`payer`) or was paid (`provider`). */
    async listReceipts(organizationId: string, as: 'payer' | 'provider', page: Page) {
        const owner = as === 'payer' ? eq(receiptsTable.payerOrganizationId, organizationId) : eq(receiptsTable.recipientOrganizationId, organizationId);
        return this.db.select().from(receiptsTable).where(this.paged(owner, receiptsTable.id, page)).orderBy(desc(receiptsTable.id)).limit(page.limit);
    }

    async listTopUps(organizationId: string, page: Page) {
        return this.db.select().from(topUpsTable).where(this.paged(eq(topUpsTable.organizationId, organizationId), topUpsTable.id, page))
            .orderBy(desc(topUpsTable.id)).limit(page.limit);
    }

    async listPayouts(organizationId: string, page: Page) {
        return this.db.select().from(payoutsTable).where(this.paged(eq(payoutsTable.organizationId, organizationId), payoutsTable.id, page))
            .orderBy(desc(payoutsTable.id)).limit(page.limit);
    }

    private paged(owner: SQL, idColumn: typeof receiptsTable.id | typeof topUpsTable.id | typeof payoutsTable.id, page: Page): SQL | undefined {
        return page.before === undefined ? owner : and(owner, lt(idColumn, page.before));
    }

    /**
     * The part of the organization's available balance that came from card top-ups older than the policy's age,
     * when it is at least the policy's warning amount, or null. Spending is assumed to use the oldest credit first,
     * and promotional credit before top-ups, so this never overstates what is idle.
     */
    async idleBalance(organization: Organization, now: Date = new Date()): Promise<IdleBalance | null> {
        const cutoff = new Date(now.getTime() - this.idleBalancePolicy.ageMs);
        const net = sql`${topUpsTable.amountMicroUsd} - ${topUpsTable.refundedMicroUsd} - ${topUpsTable.disputedMicroUsd}`;
        // A succeeded top-up was paid within a day of its Checkout Session, so its creation time stands in for when it was paid.
        const [totals] = await this.db.select({
            old: sql`coalesce(sum(case when ${topUpsTable.createdAt} < ${cutoff} then ${net} else 0 end), 0)`.mapWith(Number),
            recent: sql`coalesce(sum(case when ${topUpsTable.createdAt} >= ${cutoff} then ${net} else 0 end), 0)`.mapWith(Number),
        }).from(topUpsTable).where(and(eq(topUpsTable.organizationId, organization.id), eq(topUpsTable.status, 'succeeded')));
        const available = organization.balanceMicroUsd - organization.heldMicroUsd;
        const idle = Math.max(0, Math.min(totals!.old, available - totals!.recent));
        if (idle === 0 || idle < this.idleBalancePolicy.warningMicroUsd) return null;
        return { amountMicroUsd: idle, days: Math.round(this.idleBalancePolicy.ageMs / (24 * 60 * 60 * 1000)) };
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
