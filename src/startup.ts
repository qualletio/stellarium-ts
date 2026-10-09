import type { FastifyBaseLogger } from "fastify";
import type { Service } from "./service.js";
import { z } from "zod";
import {
    peerPublication,
    resourcePublication,
    savePublication,
} from "./peer/publications.js";
import { advertisementSchema } from "./protocol/schema.js";
import { wireJson } from "./protocol/canonical.js";
const selfSchema = z.strictObject({
    baseUrl: z.url(),
    name: z.string(),
    publicKey: z.string(),
    expiry: z.iso.datetime(),
    signature: z.string(),
});
export class StartupService {
    constructor(
        private readonly log: FastifyBaseLogger,
        private readonly service: Service,
        private readonly startingPeer: string,
        private readonly baseUrl: string,
        private readonly publicKey: string,
        private readonly privateKey: string,
    ) {}
    private async get(endpoint: string, path: string): Promise<unknown> {
        const response = await fetch(
            `${endpoint.replace(/\/$/, "")}/v1/${path}`,
            { signal: AbortSignal.timeout(10_000) },
        );
        if (!response.ok)
            throw new Error(`Peer ${path} returned ${response.status}`);
        return response.json();
    }
    async seedFromPeer(): Promise<void> {
        const data = (await this.get(this.startingPeer, "peers")) as {
            self: unknown;
            peers: { baseUrl: string }[];
        };
        await this.admit(data.self, this.startingPeer);
        for (const hint of data.peers ?? []) {
            if (hint.baseUrl === this.baseUrl) continue;
            try {
                const response = (await this.get(hint.baseUrl, "peers")) as {
                    self: unknown;
                };
                await this.admit(response.self, hint.baseUrl);
            } catch (error) {
                this.log.warn(error, "Could not authenticate discovered peer");
            }
        }
        await this.synchronize();
    }
    private async admit(input: unknown, endpoint: string): Promise<void> {
        const peer = selfSchema.parse(input);
        if (
            peer.baseUrl !== endpoint ||
            !(await this.service.peerRepository.createIfNotExists(
                peer,
                peer.signature,
                peer.expiry,
            ))
        )
            throw new Error("Invalid peer identity publication");
    }
    async synchronize(): Promise<void> {
        const ownPeer = peerPublication(
            this.baseUrl,
            this.publicKey,
            this.privateKey,
        );
        const publication = await resourcePublication(
            this.service,
            this.publicKey,
            this.privateKey,
        );
        for (const peer of await this.service.peerRepository.getPeerList()) {
            if (peer.baseUrl === this.baseUrl) continue;
            try {
                const hints = (await this.get(peer.baseUrl, "peers")) as {
                    peers: { baseUrl: string }[];
                };
                const known = new Set(
                    (await this.service.peerRepository.getPeerList()).map(
                        (item) => item.baseUrl,
                    ),
                );
                for (const hint of (hints.peers ?? []).slice(0, 100)) {
                    if (
                        hint.baseUrl === this.baseUrl ||
                        known.has(hint.baseUrl)
                    )
                        continue;
                    try {
                        const descriptor = (await this.get(
                            hint.baseUrl,
                            "peers",
                        )) as { self: unknown };
                        await this.admit(descriptor.self, hint.baseUrl);
                        known.add(hint.baseUrl);
                    } catch (error) {
                        this.log.warn(
                            error,
                            "Could not authenticate discovered peer",
                        );
                    }
                }
                await savePublication(
                    this.service,
                    await this.get(peer.baseUrl, "publications"),
                );
                if (this.service.relays) {
                    const data = (await this.get(peer.baseUrl, "relays")) as {
                        relays: unknown[];
                    };
                    for (const ad of data.relays ?? []) {
                        try {
                            await this.service.relays.save(
                                advertisementSchema.parse(ad),
                            );
                        } catch (error) {
                            this.log.warn(
                                error,
                                "Ignoring invalid relay advertisement",
                            );
                        }
                    }
                }
                await this.put(peer.baseUrl, "peers", ownPeer);
                await this.put(peer.baseUrl, "all-resources", publication);
                if (this.service.relay) {
                    const advertisement = (
                        await this.service.relays!.list()
                    ).find(
                        (ad) =>
                            ad.message.relay.toLowerCase() ===
                            this.service.relay!.options.signer.address.toLowerCase(),
                    );
                    if (advertisement)
                        await this.put(peer.baseUrl, "relays", advertisement);
                }
            } catch (error) {
                this.log.warn(
                    error,
                    `Discovery refresh failed for ${peer.baseUrl}`,
                );
            }
        }
    }
    private async put(
        endpoint: string,
        path: string,
        body: unknown,
    ): Promise<void> {
        const response = await fetch(
            `${endpoint.replace(/\/$/, "")}/v1/${path}`,
            {
                method: "PUT",
                headers: { "content-type": "application/json" },
                body: wireJson(body),
                signal: AbortSignal.timeout(10_000),
            },
        );
        if (!response.ok)
            throw new Error(
                `Peer ${path} publication returned ${response.status}`,
            );
    }
}
