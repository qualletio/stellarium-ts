import { Resource } from "requestscript";
import { Peer, PeerRepository } from "./peer/repository.js";
import { Service } from "./service.js";
import { ResourceWithBaseUrl } from "./resource/resource.js";

export class StartupService {
    constructor(private readonly service: Service, private readonly startingPeer: string) {}

    // If the peer list is empty, populate it using the peer start parameter.
    async loadFromPeer(): Promise<void> {
        await this.populatePeers();
        await this.populateResources();
    }

    async populatePeers(): Promise<void> {
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
    }

    async populateResources(): Promise<void> {
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
    }
}
