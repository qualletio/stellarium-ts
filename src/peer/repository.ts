import { verifyData } from "@/crypto/utils.js";
import { Database } from "sqlite";

export interface Peer {
    baseUrl: string;
    name: string;
    publicKey: string;
}

export class PeerRepository {
    constructor(private readonly db: Database) {}

    async create(peer: Peer): Promise<void> {

        // Check if the peer already exists
        const existingPeer = await this.db.get(
            'SELECT * FROM peer WHERE base_url = ?',
            [peer.baseUrl, peer.name]
        );

        if (existingPeer) {
            return;
        }

        const createdAt = new Date().toISOString();
        await this.db.run(
            'INSERT INTO peer (base_url, name, public_key, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
            [peer.baseUrl, peer.name, createdAt, createdAt]
        );
    }

    async createIfNotExists(peer: Peer, signature: string): Promise<void> {

        const existingPeer = await this.db.get(
            'SELECT * FROM peer WHERE base_url = ?',
            [peer.baseUrl, peer.name]
        );

        // If the peer already exists, verify the signature before updating.
        if (existingPeer) {
            if (verifyData(peer, existingPeer.publicKey, signature)) {
                await this.db.run('UPDATE peer SET base_url = ?, name = ?, updated_at = ? WHERE public_key = ?', [peer.baseUrl, peer.name, new Date().toISOString(), peer.publicKey]);
                return;
            }
            return;
        }

        await this.create(peer);
    }

    async deleteAll(): Promise<void> {
        await this.db.run('DELETE FROM peer');
    }

    async getPeerList(): Promise<Peer[]> {
        const results = await this.db.all('SELECT * FROM peer');

        return results.map(result => ({
            baseUrl: result.base_url,
            name: result.name,
            publicKey: result.public_key,
        }));
    }

    async getPeerByPublicKey(publicKey: string): Promise<Peer | undefined> {
        const result = await this.db.get('SELECT * FROM peer WHERE public_key = ?', [publicKey]);

        if (result) {
            return result;
        }

        return undefined;
    }
}
