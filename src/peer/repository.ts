import { verifyData } from "../crypto/utils.js";
import type { Database } from "sqlite";
export interface Peer {
    baseUrl: string;
    name: string;
    publicKey: string;
}
export class PeerRepository {
    constructor(private readonly db: Database) {}
    async create(peer: Peer): Promise<void> {
        const now = new Date().toISOString();
        await this.db.run(
            "INSERT OR IGNORE INTO peer(base_url,name,public_key,created_at,updated_at) VALUES(?,?,?,?,?)",
            peer.baseUrl,
            peer.name,
            peer.publicKey,
            now,
            now,
        );
    }
    async createIfNotExists(
        peer: Peer,
        signature: string,
        expiry: string,
    ): Promise<boolean> {
        const timestamp = Date.parse(expiry);
        if (!Number.isFinite(timestamp) || timestamp <= Date.now())
            return false;
        const existing = await this.getPeerByPublicKey(peer.publicKey);
        try {
            if (
                !verifyData(
                    {
                        baseUrl: peer.baseUrl,
                        name: peer.name,
                        publicKey: peer.publicKey,
                        expiry,
                    },
                    existing?.publicKey ?? peer.publicKey,
                    signature,
                )
            )
                return false;
        } catch {
            return false;
        }
        if (existing)
            await this.db.run(
                "UPDATE peer SET base_url=?,name=?,updated_at=? WHERE public_key=?",
                peer.baseUrl,
                peer.name,
                new Date().toISOString(),
                peer.publicKey,
            );
        else await this.create(peer);
        return true;
    }
    async deleteAll(): Promise<void> {
        await this.db.run("DELETE FROM peer");
    }
    async getPeerList(): Promise<Peer[]> {
        return this.db.all(
            "SELECT base_url AS baseUrl,name,public_key AS publicKey FROM peer",
        );
    }
    async getPeerByPublicKey(publicKey: string): Promise<Peer | undefined> {
        return this.db.get(
            "SELECT base_url AS baseUrl,name,public_key AS publicKey FROM peer WHERE public_key=?",
            publicKey,
        );
    }
}
