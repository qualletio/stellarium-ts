import type { Database } from "sqlite";
import type { Capability, Grant } from "./grant.js";

export interface IssuedGrant {
    id: string;
    audience: string;
    capabilities: Capability[];
    /** The held grant this one was delegated from, or null for a root grant. */
    parent: GrantKey | null;
    lifetimeMs: number;
    renewableUntil: string | null;
}

interface IssuedGrantRow {
    id: string;
    audience: string;
    capabilities: string;
    parent_grant_issuer: string | null;
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

/**
 * Identifies a grant, such as a held chain's leaf or a revoked grant. Issuers choose their own
 * ids, so the id alone isn't enough.
 */
export interface GrantKey {
    issuer: string;
    id: string;
}

interface HeldGrantRow {
    chain: string;
}

/** Stored times are normalized so that SQL can order and compare them as text. */
const isoTime = (time: string | number) => new Date(typeof time === 'string' ? Date.parse(time) : time).toISOString();

/** Grants this node issued, grants it holds, grants it revoked, nonces it has seen, and caller keys it blocked. */
export class GrantRepository {
    constructor(private readonly db: Database) {}

    async saveIssued(grant: IssuedGrant): Promise<void> {
        await this.db.run(
            'INSERT INTO issued_grant (id, audience, capabilities, parent_grant_issuer, parent_grant_id, lifetime_ms, renewable_until, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
            [grant.id, grant.audience, JSON.stringify(grant.capabilities), grant.parent?.issuer ?? null, grant.parent?.id ?? null, grant.lifetimeMs, grant.renewableUntil, new Date().toISOString()]
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
            parent: row.parent_grant_issuer !== null && row.parent_grant_id !== null ? { issuer: row.parent_grant_issuer, id: row.parent_grant_id } : null,
            lifetimeMs: row.lifetime_ms,
            renewableUntil: row.renewable_until,
        };
    }

    /** Saves a chain this node holds, replacing an earlier copy of the same leaf grant. */
    async saveHeld(chain: Grant[]): Promise<void> {
        const leaf = chain[chain.length - 1];
        await this.db.run(
            `INSERT INTO held_grant (issuer, id, root_issuer_base_url, chain, issued_at, expires_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT (issuer, id) DO UPDATE SET root_issuer_base_url = excluded.root_issuer_base_url, chain = excluded.chain,
                issued_at = excluded.issued_at, expires_at = excluded.expires_at, updated_at = excluded.updated_at`,
            [leaf.issuer, leaf.id, chain[0].issuerBaseUrl, JSON.stringify(chain), isoTime(leaf.issuedAt), isoTime(leaf.expiresAt), new Date().toISOString()]
        );
    }

    async getHeld(key: GrantKey): Promise<Grant[] | undefined> {
        const row = await this.db.get<HeldGrantRow>('SELECT chain FROM held_grant WHERE issuer = ? AND id = ?', [key.issuer, key.id]);
        return row ? JSON.parse(row.chain) : undefined;
    }

    /** Every held chain whose leaf has this id, whoever issued it. */
    async getHeldById(id: string): Promise<Grant[][]> {
        const rows = await this.db.all<HeldGrantRow[]>('SELECT chain FROM held_grant WHERE id = ? ORDER BY issuer', [id]);
        return rows.map(row => JSON.parse(row.chain));
    }

    async deleteHeld(key: GrantKey): Promise<void> {
        await this.db.run('DELETE FROM held_grant WHERE issuer = ? AND id = ?', [key.issuer, key.id]);
    }

    /** Unexpired chains rooted at the node serving `rootIssuerBaseUrl`, latest expiry first. */
    async getUnexpiredHeldByRoot(rootIssuerBaseUrl: string, now: number): Promise<Grant[][]> {
        const rows = await this.db.all<HeldGrantRow[]>('SELECT chain FROM held_grant WHERE root_issuer_base_url = ? AND expires_at > ? ORDER BY expires_at DESC', [rootIssuerBaseUrl, isoTime(now)]);
        return rows.map(row => JSON.parse(row.chain));
    }

    /** Expired chains rooted at the node serving `rootIssuerBaseUrl`, latest expiry first. */
    async getExpiredHeldByRoot(rootIssuerBaseUrl: string, now: number): Promise<Grant[][]> {
        const rows = await this.db.all<HeldGrantRow[]>('SELECT chain FROM held_grant WHERE root_issuer_base_url = ? AND expires_at <= ? ORDER BY expires_at DESC', [rootIssuerBaseUrl, isoTime(now)]);
        return rows.map(row => JSON.parse(row.chain));
    }

    async getAllHeld(): Promise<Grant[][]> {
        const rows = await this.db.all<HeldGrantRow[]>('SELECT chain FROM held_grant ORDER BY issuer, id');
        return rows.map(row => JSON.parse(row.chain));
    }

    /** The key of the peer serving `baseUrl`, if this node knows it. */
    async getPeerKey(baseUrl: string): Promise<string | undefined> {
        const row = await this.db.get<{ public_key: string }>('SELECT public_key FROM peer WHERE base_url = ?', [baseUrl]);
        return row?.public_key;
    }

    async revoke(key: GrantKey): Promise<void> {
        await this.db.run('INSERT INTO revoked_grant (issuer, grant_id, revoked_at) VALUES (?, ?, ?) ON CONFLICT (issuer, grant_id) DO NOTHING', [key.issuer, key.id, new Date().toISOString()]);
    }

    async anyRevoked(keys: GrantKey[]): Promise<boolean> {
        if (keys.length === 0) {
            return false;
        }
        const conditions = keys.map(() => '(issuer = ? AND grant_id = ?)').join(' OR ');
        const row = await this.db.get(`SELECT 1 FROM revoked_grant WHERE ${conditions} LIMIT 1`, keys.flatMap(key => [key.issuer, key.id]));
        return row !== undefined;
    }

    /** False when `key` was already claimed. */
    async claimNonce(key: string, expiresAt: number): Promise<boolean> {
        const result = await this.db.run('INSERT INTO seen_nonce (key, expires_at) VALUES (?, ?) ON CONFLICT (key) DO NOTHING', [key, expiresAt]);
        return (result.changes ?? 0) > 0;
    }

    async deleteExpiredNonces(now: number): Promise<void> {
        await this.db.run('DELETE FROM seen_nonce WHERE expires_at <= ?', [now]);
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
