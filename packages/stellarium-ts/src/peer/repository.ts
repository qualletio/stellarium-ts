import { isFreshExpiry, safeVerifyData } from "../crypto/utils.js";
import { Database } from "sqlite";

export interface Peer {
    baseUrl: string;
    name: string;
    publicKey: string;
}

export interface StoredPeer extends Peer {
    id: number;
}

/** Why `announce` rejected a peer. */
export type PeerAnnouncementError = 'invalid_signature' | 'conflict';

/**
 * The object a node signs to announce itself. Including `publicKey` binds the
 * announcement to the key that signed it. Key order is part of the signed bytes.
 */
export function peerAnnouncementPayload(peer: Peer, expiry: string) {
    const { baseUrl, name, publicKey } = peer;
    return { baseUrl, name, publicKey, expiry };
}

interface PeerRow {
    id: number;
    base_url: string;
    name: string;
    public_key: string;
}

function toPeer(row: PeerRow): StoredPeer {
    return { id: row.id, baseUrl: row.base_url, name: row.name, publicKey: row.public_key };
}

export class PeerRepository {
    constructor(private readonly db: Database) {}

    /**
     * Saves a peer learned from a trusted source (the starting peer) without a signature.
     * Does nothing if a peer with the same public key, base URL or name already exists.
     */
    async create(peer: Peer): Promise<void> {
        const createdAt = new Date().toISOString();
        await this.db.run(
            'INSERT OR IGNORE INTO peer (base_url, name, public_key, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
            [peer.baseUrl, peer.name, peer.publicKey, createdAt, createdAt]
        );
    }

    /**
     * Saves a peer that announced itself. The announcement must be signed by `peer.publicKey`.
     * A known peer (same public key) may change its base URL and name; a new peer may not
     * take a base URL or name that another peer already holds.
     */
    async announce(peer: Peer, signature: string, expiry: string): Promise<{ ok: true } | { ok: false, error: PeerAnnouncementError }> {
        if (!isFreshExpiry(expiry) || !safeVerifyData(peerAnnouncementPayload(peer, expiry), peer.publicKey, signature)) {
            return { ok: false, error: 'invalid_signature' };
        }

        const holder = await this.db.get<PeerRow>(
            'SELECT * FROM peer WHERE (base_url = ? OR name = ?) AND public_key != ?',
            [peer.baseUrl, peer.name, peer.publicKey]
        );
        if (holder) {
            return { ok: false, error: 'conflict' };
        }

        const now = new Date().toISOString();
        await this.db.run(
            `INSERT INTO peer (base_url, name, public_key, created_at, updated_at) VALUES (?, ?, ?, ?, ?)
             ON CONFLICT (public_key) DO UPDATE SET base_url = excluded.base_url, name = excluded.name, updated_at = excluded.updated_at`,
            [peer.baseUrl, peer.name, peer.publicKey, now, now]
        );
        return { ok: true };
    }

    async deleteAll(): Promise<void> {
        await this.db.run('DELETE FROM peer');
    }

    async getPeerList(): Promise<Peer[]> {
        const results = await this.db.all<PeerRow[]>('SELECT * FROM peer');

        return results.map(result => ({
            baseUrl: result.base_url,
            name: result.name,
            publicKey: result.public_key,
        }));
    }

    /** One page of peers, in insertion order so offsets stay stable as peers are added. */
    async getPeers(offset: number, limit: number): Promise<Peer[]> {
        const results = await this.db.all<PeerRow[]>('SELECT * FROM peer ORDER BY id LIMIT ? OFFSET ?', [limit, offset]);

        return results.map(result => ({
            baseUrl: result.base_url,
            name: result.name,
            publicKey: result.public_key,
        }));
    }

    async getPeerByPublicKey(publicKey: string): Promise<StoredPeer | undefined> {
        const result = await this.db.get<PeerRow>('SELECT * FROM peer WHERE public_key = ?', [publicKey]);
        return result ? toPeer(result) : undefined;
    }
}
