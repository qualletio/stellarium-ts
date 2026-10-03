import { Database } from "sqlite";

export interface Peer {
    baseUrl: string;
    name: string;
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
            'INSERT INTO peer (base_url, name, created_at, updated_at) VALUES (?, ?, ?, ?)',
            [peer.baseUrl, peer.name, createdAt, createdAt]
        );
    }

    async deleteAll(): Promise<void> {
        await this.db.run('DELETE FROM peer');
    }

    async getPeerList(): Promise<Peer[]> {
        const results = await this.db.all('SELECT * FROM peer');
        return results.map(result => ({
            baseUrl: result.base_url,
            name: result.name,
        }));
    }
}
