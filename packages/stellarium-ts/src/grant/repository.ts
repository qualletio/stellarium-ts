import type { Database } from "sqlite";
import type { Capability, Grant } from "./grant.js";

export interface IssuedGrant {
    id: string;
    audience: string;
    capabilities: Capability[];
    /** The held grant this one was delegated from, or null for a root grant. */
    parentGrantId: string | null;
    lifetimeMs: number;
    renewableUntil: string | null;
}

interface IssuedGrantRow {
    id: string;
    audience: string;
    capabilities: string;
    parent_grant_id: string | null;
    lifetime_ms: number;
    renewable_until: string | null;
}

export interface BlockedCaller {
    publicKey: string;
    reason: string | null;
    blockedAt: string;
}

interface BlockedCallerRow {
    public_key: string;
    reason: string | null;
    blocked_at: string;
}

interface HeldGrantRow {
    chain: string;
}

/** Grants this node issued, grants it holds, grant ids it revoked, and caller keys it blocked. */
export class GrantRepository {
    constructor(private readonly db: Database) {}

    async saveIssued(grant: IssuedGrant): Promise<void> {
        await this.db.run(
            'INSERT INTO issued_grant (id, audience, capabilities, parent_grant_id, lifetime_ms, renewable_until, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
            [grant.id, grant.audience, JSON.stringify(grant.capabilities), grant.parentGrantId, grant.lifetimeMs, grant.renewableUntil, new Date().toISOString()]
        );
    }

    async getIssued(id: string): Promise<IssuedGrant | undefined> {
        const row = await this.db.get<IssuedGrantRow>('SELECT * FROM issued_grant WHERE id = ?', [id]);
        if (!row) {
            return undefined;
        }
        return {
            id: row.id,
            audience: row.audience,
            capabilities: JSON.parse(row.capabilities),
            parentGrantId: row.parent_grant_id,
            lifetimeMs: row.lifetime_ms,
            renewableUntil: row.renewable_until,
        };
    }

    /** Saves a chain this node holds, replacing an earlier copy of the same leaf grant. */
    async saveHeld(chain: Grant[]): Promise<void> {
        const leaf = chain[chain.length - 1];
        await this.db.run(
            `INSERT INTO held_grant (id, root_issuer_base_url, chain, issued_at, expires_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)
             ON CONFLICT (id) DO UPDATE SET root_issuer_base_url = excluded.root_issuer_base_url, chain = excluded.chain,
                issued_at = excluded.issued_at, expires_at = excluded.expires_at, updated_at = excluded.updated_at`,
            [leaf.id, chain[0].issuerBaseUrl, JSON.stringify(chain), leaf.issuedAt, leaf.expiresAt, new Date().toISOString()]
        );
    }

    async getHeld(id: string): Promise<Grant[] | undefined> {
        const row = await this.db.get<HeldGrantRow>('SELECT chain FROM held_grant WHERE id = ?', [id]);
        return row ? JSON.parse(row.chain) : undefined;
    }

    /** Chains rooted at the node serving `rootIssuerBaseUrl`, latest expiry first. Expired chains included. */
    async getHeldByRoot(rootIssuerBaseUrl: string): Promise<Grant[][]> {
        const rows = await this.db.all<HeldGrantRow[]>('SELECT chain FROM held_grant WHERE root_issuer_base_url = ? ORDER BY expires_at DESC', [rootIssuerBaseUrl]);
        return rows.map(row => JSON.parse(row.chain));
    }

    async getAllHeld(): Promise<Grant[][]> {
        const rows = await this.db.all<HeldGrantRow[]>('SELECT chain FROM held_grant ORDER BY id');
        return rows.map(row => JSON.parse(row.chain));
    }

    async revoke(grantId: string): Promise<void> {
        await this.db.run('INSERT INTO revoked_grant (grant_id, revoked_at) VALUES (?, ?) ON CONFLICT (grant_id) DO NOTHING', [grantId, new Date().toISOString()]);
    }

    async anyRevoked(grantIds: string[]): Promise<boolean> {
        if (grantIds.length === 0) {
            return false;
        }
        const placeholders = grantIds.map(() => '?').join(', ');
        const row = await this.db.get(`SELECT 1 FROM revoked_grant WHERE grant_id IN (${placeholders}) LIMIT 1`, grantIds);
        return row !== undefined;
    }

    /** Blocking a blocked key again updates its reason and keeps the original time. */
    async block(publicKey: string, reason: string | null): Promise<void> {
        await this.db.run(
            'INSERT INTO blocked_caller (public_key, reason, blocked_at) VALUES (?, ?, ?) ON CONFLICT (public_key) DO UPDATE SET reason = excluded.reason',
            [publicKey, reason, new Date().toISOString()]
        );
    }

    /** False when the key wasn't blocked. */
    async unblock(publicKey: string): Promise<boolean> {
        const result = await this.db.run('DELETE FROM blocked_caller WHERE public_key = ?', [publicKey]);
        return (result.changes ?? 0) > 0;
    }

    async anyBlocked(publicKeys: string[]): Promise<boolean> {
        if (publicKeys.length === 0) {
            return false;
        }
        const placeholders = publicKeys.map(() => '?').join(', ');
        const row = await this.db.get(`SELECT 1 FROM blocked_caller WHERE public_key IN (${placeholders}) LIMIT 1`, publicKeys);
        return row !== undefined;
    }

    /** In the order they were blocked. */
    async getBlocked(offset: number, limit: number): Promise<BlockedCaller[]> {
        const rows = await this.db.all<BlockedCallerRow[]>('SELECT * FROM blocked_caller ORDER BY blocked_at, public_key LIMIT ? OFFSET ?', [limit, offset]);
        return rows.map(row => ({ publicKey: row.public_key, reason: row.reason, blockedAt: row.blocked_at }));
    }
}
