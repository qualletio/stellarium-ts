import type { Resource, ResourceResolver } from "requestscript";
import type { Database } from "sqlite";
import { PeerRepository } from "./peer/repository.js";
import { CombinationResourceResolver } from "./resource/resolver.js";
import { ResourceRepository } from "./resource/repository.js";
import { CombinationResourceInvoker } from "./resource/invoker.js";
import type { PaymentRuntime } from "./payment/runtime.js";
import type { RelayDiscovery } from "./relay/discovery.js";
import type { RelayService } from "./relay/service.js";
export interface Service {
    db: Database;
    baseUrl: string;
    peerRepository: PeerRepository;
    resourceRepository: ResourceRepository;
    resourceResolver: ResourceResolver;
    resourceInvoker: CombinationResourceInvoker;
    payment?: PaymentRuntime;
    relays?: RelayDiscovery;
    relay?: RelayService;
}
export function createService(
    resources: Resource[],
    db: Database,
    baseUrl = "",
    payment?: PaymentRuntime,
    relays?: RelayDiscovery,
    relay?: RelayService,
): Service {
    const resourceRepository = new ResourceRepository(db, resources, baseUrl);
    return {
        db,
        baseUrl,
        peerRepository: new PeerRepository(db),
        resourceRepository,
        resourceResolver: new CombinationResourceResolver(resourceRepository),
        resourceInvoker: new CombinationResourceInvoker(payment),
        payment,
        relays,
        relay,
    };
}
