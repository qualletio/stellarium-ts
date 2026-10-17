import { FastifyBaseLogger } from "fastify";
import { signData } from "./crypto/utils.js";
import { Peer, peerAnnouncementPayload } from "./peer/repository.js";
import { resourceAnnouncementPayload, StellariumResource } from "./resource/repository.js";
import { Service } from "./service.js";

/** Per request to a peer during startup. */
export const STARTUP_REQUEST_TIMEOUT_MS = 10_000;

/** Peers and resources requested per page from the starting peer. It may return fewer. */
export const STARTUP_PAGE_SIZE = 100;

// 10 minutes
const SIGNATURE_LIFETIME_MS = 1000 * 60 * 10;

export class StartupService {
    constructor(
        private readonly log: FastifyBaseLogger,
        private readonly service: Service,
        private readonly startingPeer: string,
        private readonly baseUrl: string,
        private readonly publicKey: string,
        private readonly privateKey: string,
    ) {}

    // Learn peers and resources from the starting peer, then announce this node to every peer.
    async seedFromPeer(): Promise<void> {
        this.log.info(`Seeding from peer ${this.startingPeer}`);

        await this.populatePeers();
        await this.populateResources();

        // This must be the last step that only runs if the previous steps were successful.
        await this.broadcastSelf();

        this.log.info(`Finished seeding from peer ${this.startingPeer}`);
    }

    /** GET a JSON document from the starting peer, failing on a non-2xx response. */
    private async getFromStartingPeer<T>(path: string): Promise<T> {
        const response = await fetch(`${this.startingPeer}/v1${path}`, { signal: AbortSignal.timeout(STARTUP_REQUEST_TIMEOUT_MS) });
        if (!response.ok) {
            throw new Error(`Starting peer ${this.startingPeer} responded ${response.status} to GET /v1${path}`);
        }
        return await response.json() as T;
    }

    /**
     * Walks a paginated list on the starting peer, handing each page to `handlePage` before
     * fetching the next, so the whole list is never held at once. Returns the item count.
     */
    private async forEachPageFromStartingPeer<T>(path: string, key: string, handlePage: (items: T[]) => Promise<void>): Promise<number> {
        let offset = 0;
        let count = 0;
        while (true) {
            const data = await this.getFromStartingPeer<Record<string, unknown>>(`${path}?offset=${offset}&limit=${STARTUP_PAGE_SIZE}`);
            const items = data[key];
            const nextOffset = data.nextOffset ?? null;
            // The next offset must move forward, or a bad peer could keep startup looping forever.
            if (!Array.isArray(items) || (nextOffset !== null && (!Number.isInteger(nextOffset) || (nextOffset as number) <= offset))) {
                throw new Error('Invalid response from peer');
            }

            await handlePage(items as T[]);
            count += items.length;

            if (nextOffset === null) {
                return count;
            }
            offset = nextOffset as number;
        }
    }

    private isSelf(peer: Peer): boolean {
        return peer.publicKey === this.publicKey || peer.baseUrl === this.baseUrl;
    }

    async populatePeers(): Promise<void> {
        this.log.info(`Populating peers from ${this.startingPeer}`);

        // Known peers are skipped, so this is safe to repeat on every restart, and a run cut off
        // partway through the pages is completed on the next one.
        let count = 0;
        const savePeers = async (peers: Peer[]) => {
            for (const peer of peers.filter(peer => !this.isSelf(peer))) {
                await this.service.peerRepository.create(peer);
                count++;
            }
        };

        // Save the starting peer to the database.
        await savePeers([await this.getFromStartingPeer<Peer>('/self')]);
        await this.forEachPageFromStartingPeer('/peers', 'peers', savePeers);

        this.log.info(`Populated ${count} peers`);
    }

    async populateResources(): Promise<void> {
        this.log.info(`Populating resources from ${this.startingPeer}`);

        // Known resources are skipped, so this is safe to repeat on every restart.
        const count = await this.forEachPageFromStartingPeer<StellariumResource>('/resources', 'resources', async (resources) => {
            for (const resource of resources) {
                await this.service.resourceRepository.learn(resource);
            }
        });

        this.log.info(`Learned up to ${count} resources`);
    }

    /** PUT to every peer, logging failures instead of throwing so one bad peer doesn't stop the rest. */
    private async putToPeers(peers: Peer[], path: string, body: unknown, description: string): Promise<void> {
        for (const peer of peers) {
            try {
                const response = await fetch(`${peer.baseUrl}/v1${path}`, {
                    method: 'PUT',
                    headers: {
                        'Content-Type': 'application/json',
                    },
                    body: JSON.stringify(body),
                    signal: AbortSignal.timeout(STARTUP_REQUEST_TIMEOUT_MS),
                });

                if (!response.ok) {
                    this.log.warn(`Failed to broadcast ${description} to node ${peer.baseUrl}: ${response.status} ${await response.text()}`);
                }
            } catch (error) {
                this.log.warn(error, `Failed to broadcast ${description} to node ${peer.baseUrl}`);
            }
        }
    }

    async broadcastSelf(): Promise<void> {
        this.log.info(`Broadcasting self to peers`);

        // Let the peers know about this node.
        const peers = (await this.service.peerRepository.getPeerList()).filter(peer => !this.isSelf(peer));

        const self: Peer = { baseUrl: this.baseUrl, name: this.baseUrl, publicKey: this.publicKey };
        const peerSignatureExpiry = new Date(Date.now() + SIGNATURE_LIFETIME_MS).toISOString();
        const peerSignature = signData(peerAnnouncementPayload(self, peerSignatureExpiry), this.privateKey);

        await this.putToPeers(peers, '/peers', { ...self, signature: peerSignature, expiry: peerSignatureExpiry }, 'self');

        this.log.info(`Broadcasted self to ${peers.length} peers`);

        this.log.info(`Broadcasting resources to peers`);

        // Let the peers know about the resources available on this node.
        const resources = await this.service.resourceRepository.getInternalResources();

        const resourceSignatureExpiry = new Date(Date.now() + SIGNATURE_LIFETIME_MS).toISOString();
        const resourceSignature = signData(resourceAnnouncementPayload(resources, resourceSignatureExpiry), this.privateKey);

        await this.putToPeers(peers, '/all-resources', {
            publicKey: this.publicKey,
            resources,
            expiry: resourceSignatureExpiry,
            signature: resourceSignature,
        }, 'resources');

        this.log.info(`Broadcasted ${resources.length} resources to ${peers.length} peers`);
    }
}
