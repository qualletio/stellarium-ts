import { FastifyBaseLogger } from "fastify";
import { signData } from "./crypto/utils.js";
import { Peer, peerAnnouncementPayload } from "./peer/repository.js";
import { resourceAnnouncementPayload, StellariumResource } from "./resource/repository.js";
import { Service } from "./service.js";

/** Per request to a peer during startup. */
export const STARTUP_REQUEST_TIMEOUT_MS = 10_000;

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

    // If the peer list is empty, populate it using the peer start parameter.
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

    private isSelf(peer: Peer): boolean {
        return peer.publicKey === this.publicKey || peer.baseUrl === this.baseUrl;
    }

    async populatePeers(): Promise<void> {
        this.log.info(`Populating peers from ${this.startingPeer}`);

        const peerList = await this.service.peerRepository.getPeerList();
        if (peerList.length > 0) {
            return;
        }

        const data = await this.getFromStartingPeer<{ peers?: Peer[] }>('/peers');
        if (!Array.isArray(data.peers)) {
            throw new Error('Invalid response from peer');
        }

        // Save the starting peer to the database.
        const startingPeerData = await this.getFromStartingPeer<Peer>('/self');

        const peers = [...data.peers, startingPeerData].filter(peer => !this.isSelf(peer));
        for (const peer of peers) {
            await this.service.peerRepository.create(peer);
        }

        this.log.info(`Populated ${peers.length} peers`);
    }

    async populateResources(): Promise<void> {
        this.log.info(`Populating resources from ${this.startingPeer}`);

        const data = await this.getFromStartingPeer<{ resources?: StellariumResource[] }>('/resources');
        if (!Array.isArray(data.resources)) {
            throw new Error('Invalid response from peer');
        }

        // Known resources are skipped, so this is safe to repeat on every restart.
        for (const resource of data.resources) {
            await this.service.resourceRepository.learn(resource);
        }

        this.log.info(`Learned up to ${data.resources.length} resources`);
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
