import { randomBytes, timingSafeEqual } from "node:crypto";
import { and, desc, eq, gte, sql } from "drizzle-orm";
import type { Database, Transaction } from "../db/database.js";
import { apiClientsTable, nodesTable, organizationsTable, receiptsTable, runsTable } from "../db/schema.js";
import { newId, sha256Hex } from "../crypto.js";
import { OperationError } from "../errors.js";
import type { RunTokenSigner } from "./tokens.js";

export type ApiClient = typeof apiClientsTable.$inferSelect;

/** A new client's per-run maximum when none is given: $1. */
export const DEFAULT_MAX_RUN_COST_MICRO_USD = 1_000_000;

export interface NewApiClient {
    nodePublicKey: string;
    label?: string;
    maxRunCostMicroUsd?: number;
    monthlyCapMicroUsd?: number | null;
    createdBy?: string;
}

/** A change to a client's limits. Omitted fields keep their value, and a null monthly cap removes it. */
export interface ApiClientLimits {
    maxRunCostMicroUsd?: number;
    monthlyCapMicroUsd?: number | null;
}

/** The start of the calendar month (UTC) that `now` falls in. Monthly caps reset then. */
export function monthStart(now: Date = new Date()): Date {
    return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

/**
 * What the client's runs authorized since `since` have cost or still hold: their script charges, their
 * calls' charges, and what is still held for both.
 */
export async function clientSpend(db: Database | Transaction, clientId: string, since: Date): Promise<number> {
    const [runs] = await db.select({ total: sql<string>`coalesce(sum(coalesce(${runsTable.amountMicroUsd}, 0) + ${runsTable.heldMicroUsd}), 0)` })
        .from(runsTable)
        .where(and(eq(runsTable.clientId, clientId), gte(runsTable.createdAt, since)));
    const [calls] = await db.select({
        total: sql<string>`coalesce(sum(case ${receiptsTable.status} when 'captured' then ${receiptsTable.amountMicroUsd} when 'held' then ${receiptsTable.heldMicroUsd} else 0 end), 0)`,
    })
        .from(receiptsTable)
        .innerJoin(runsTable, eq(receiptsTable.runId, runsTable.id))
        .where(and(eq(runsTable.clientId, clientId), gte(runsTable.createdAt, since)));
    return Number(runs!.total) + Number(calls!.total);
}

function secretsEqual(a: string, b: string): boolean {
    return timingSafeEqual(Buffer.from(sha256Hex(a)), Buffer.from(b));
}

/**
 * API clients: credentials an organization exchanges for run tokens on one node. A client may run on a
 * node of its own organization, for free, or on another organization's listed node, paying its price.
 */
export class ApiClientService {
    constructor(private readonly db: Database, private readonly tokens?: RunTokenSigner) {}

    /** Returns the client and its secret. Only the secret's hash is stored, so this is the only time it can be read. */
    async create(organizationId: string, options: NewApiClient): Promise<{ client: ApiClient, clientSecret: string }> {
        const [node] = await this.db.select().from(nodesTable).where(eq(nodesTable.publicKey, options.nodePublicKey)).limit(1);
        if (!node || node.revokedAt || (node.organizationId !== organizationId && !node.listed)) {
            throw new OperationError(404, 'Node not found or not listed');
        }
        const maxRunCostMicroUsd = options.maxRunCostMicroUsd ?? DEFAULT_MAX_RUN_COST_MICRO_USD;
        if (options.monthlyCapMicroUsd != null && options.monthlyCapMicroUsd < maxRunCostMicroUsd) {
            throw new OperationError(400, 'The monthly cap must be at least the maximum run cost');
        }
        const clientSecret = `cs_${randomBytes(32).toString('base64url')}`;
        const [client] = await this.db.insert(apiClientsTable).values({
            id: newId('cli'),
            secretHash: sha256Hex(clientSecret),
            organizationId,
            nodePublicKey: node.publicKey,
            label: options.label,
            maxRunCostMicroUsd,
            monthlyCapMicroUsd: options.monthlyCapMicroUsd ?? null,
            createdBy: options.createdBy,
        }).returning();
        return { client: client!, clientSecret };
    }

    async get(id: string): Promise<ApiClient | undefined> {
        const [client] = await this.db.select().from(apiClientsTable).where(eq(apiClientsTable.id, id)).limit(1);
        return client;
    }

    /** The organization's clients, newest first, each with what it has spent this month. Never includes secrets. */
    async list(organizationId: string, now: Date = new Date()) {
        const clients = await this.db.select().from(apiClientsTable).where(eq(apiClientsTable.organizationId, organizationId)).orderBy(desc(apiClientsTable.createdAt));
        return Promise.all(clients.map(async ({ secretHash: _, ...client }) => ({
            ...client,
            monthToDateMicroUsd: await clientSpend(this.db, client.id, monthStart(now)),
        })));
    }

    /**
     * Changes a client's per-run maximum and monthly cap. Runs already authorized keep their hold; the
     * new limits apply from the next run.
     */
    async updateLimits(organizationId: string, id: string, limits: ApiClientLimits): Promise<ApiClient> {
        return this.db.transaction(async (tx) => {
            const [client] = await tx.select().from(apiClientsTable)
                .where(and(eq(apiClientsTable.id, id), eq(apiClientsTable.organizationId, organizationId)))
                .for('update');
            if (!client) throw new OperationError(404, 'API client not found');
            if (client.revokedAt) throw new OperationError(409, 'API client has been revoked');
            const maxRunCostMicroUsd = limits.maxRunCostMicroUsd ?? client.maxRunCostMicroUsd;
            const monthlyCapMicroUsd = limits.monthlyCapMicroUsd === undefined ? client.monthlyCapMicroUsd : limits.monthlyCapMicroUsd;
            if (monthlyCapMicroUsd !== null && monthlyCapMicroUsd < maxRunCostMicroUsd) {
                throw new OperationError(400, 'The monthly cap must be at least the maximum run cost');
            }
            const [updated] = await tx.update(apiClientsTable).set({ maxRunCostMicroUsd, monthlyCapMicroUsd })
                .where(eq(apiClientsTable.id, id))
                .returning();
            return updated!;
        });
    }

    async revoke(organizationId: string, id: string): Promise<void> {
        const [client] = await this.db.update(apiClientsTable).set({ revokedAt: new Date() })
            .where(and(eq(apiClientsTable.id, id), eq(apiClientsTable.organizationId, organizationId)))
            .returning();
        if (!client) throw new OperationError(404, 'API client not found');
    }

    /**
     * The OAuth client credentials grant: a run token for the client's node. Refuses (401) unknown,
     * revoked or wrongly authenticated clients, and (403) a frozen organization or a node that is revoked
     * or, for another organization's client, unlisted.
     */
    async issueToken(clientId: string, clientSecret: string): Promise<{ token: string, expiresIn: number }> {
        const client = await this.get(clientId);
        if (!client || client.revokedAt || !secretsEqual(clientSecret, client.secretHash)) {
            throw new OperationError(401, 'Invalid client credentials');
        }
        return (await this.sign(client)).token;
    }

    /**
     * A run token for one of the organization's clients, without its secret, for the dashboard to run a
     * script for a signed-in admin. The same limits apply as to any of the client's runs. Also returns the
     * node's base URL.
     */
    async issueTokenForOrganization(organizationId: string, clientId: string): Promise<{ token: string, expiresIn: number, nodeBaseUrl: string | null }> {
        const client = await this.get(clientId);
        if (!client || client.organizationId !== organizationId) {
            throw new OperationError(404, 'API client not found');
        }
        if (client.revokedAt) {
            throw new OperationError(409, 'API client has been revoked');
        }
        const { token, nodeBaseUrl } = await this.sign(client);
        return { ...token, nodeBaseUrl };
    }

    /** Refuses (403) a frozen organization or a node that is revoked or, for another organization's client, unlisted. */
    private async sign(client: ApiClient): Promise<{ token: { token: string, expiresIn: number }, nodeBaseUrl: string | null }> {
        if (!this.tokens) throw new OperationError(503, 'Run tokens are not configured on this operator');
        const [row] = await this.db.select({ node: nodesTable, organization: organizationsTable })
            .from(nodesTable)
            .innerJoin(organizationsTable, eq(organizationsTable.id, client.organizationId))
            .where(eq(nodesTable.publicKey, client.nodePublicKey))
            .limit(1);
        if (row!.organization.frozenAt) {
            throw new OperationError(403, 'Organization is frozen');
        }
        if (row!.node.revokedAt || (row!.node.organizationId !== client.organizationId && !row!.node.listed)) {
            throw new OperationError(403, 'The client\'s node is no longer available');
        }
        const token = await this.tokens.sign({ clientId: client.id, organizationId: client.organizationId, nodePublicKey: client.nodePublicKey });
        return { token, nodeBaseUrl: row!.node.baseUrl };
    }
}
