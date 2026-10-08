import { Resource } from "requestscript";
import { Peer, PeerRepository } from "./peer/repository.js";
import { Service } from "./service.js";
import { ResourceWithBaseUrl } from "./resource/repository.js";
import { FastifyBaseLogger } from "fastify";
import { signData } from "./crypto/utils.js";

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

    async populatePeers(): Promise<void> {
        this.log.info(`Populating peers from ${this.startingPeer}`);

        const peerList = await this.service.peerRepository.getPeerList();
        if (peerList.length > 0) {
            return;
        }

        const response = await fetch(`${this.startingPeer}/v1/peers`);
        const data = await response.json() as { peers: Peer[] };
        if (!data.peers) {
            throw new Error('Invalid response from peer');
        }

        if (data.peers) {
            for (const peer of data.peers) {
                await this.service.peerRepository.create(peer);
            }
        }

        this.log.info(`Populated ${data.peers.length} peers`);
    }

    async populateResources(): Promise<void> {
        this.log.info(`Populating resources from ${this.startingPeer}`);
        
        const response = await fetch(`${this.startingPeer}/v1/resources`);
        const data = await response.json() as { resources: ResourceWithBaseUrl[] };
        if (!data.resources) {
            throw new Error('Invalid response from peer');
        }

        if (data.resources) {
            for (const resource of data.resources as ResourceWithBaseUrl[]) {
                await this.service.resourceRepository.create(resource, resource.baseUrl);
            }
        }

        this.log.info(`Populated ${data.resources.length} resources`);
    }

    async broadcastSelf(): Promise<void> {
        this.log.info(`Broadcasting self to peers`);
        
        // Let the peers know about this node.
        const peers = await this.service.peerRepository.getPeerList();

        // 10 minutes
        const peerSignatureExpiry = new Date(Date.now() + 1000 * 60 * 10).toISOString();

        const peerSignature = signData({
            baseUrl: this.baseUrl,
            name: this.baseUrl,
            expiry: peerSignatureExpiry,
        }, this.privateKey);

        for (const peer of peers) {
            const response = await fetch(`${peer.baseUrl}/v1/peers`, {
                method: 'PUT',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    baseUrl: this.baseUrl,
                    name: this.baseUrl,
                    publicKey: this.publicKey,
                    signature: peerSignature,
                    expiry: peerSignatureExpiry,
                }),
            });

            if (!response.ok) {
                this.log.warn(`Failed to broadcast self to node ${peer.baseUrl}: ${response.statusText}`);
            }
        }

        this.log.info(`Broadcasted self to ${peers.length} peers`);

        this.log.info(`Broadcasting resources to peers`);

        // Let the peers know about the resources available on this node.
        const resources = await this.service.resourceRepository.getInternalResources();

        // 10 minutes
        const resourceSignatureExpiry = new Date(Date.now() + 1000 * 60 * 10).toISOString();

        const resourceSignature = signData({
            resources,
            expiry: resourceSignatureExpiry,
        }, this.privateKey);

        for (const peer of peers) {
            const response = await fetch(`${peer.baseUrl}/v1/all-resources`, {
                method: 'PUT',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    resources,
                    expiry: resourceSignatureExpiry,
                    signature: resourceSignature,
                }),
            });

            if (!response.ok) {
                this.log.warn(`Failed to broadcast resources to node ${peer.baseUrl}: ${response.statusText}`);
            }
        }

        this.log.info(`Broadcasted ${resources.length} resources to ${peers.length} peers`);
    }
}
