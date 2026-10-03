import { Resource, ResourceInvoker, ResourceResolver } from "requestscript";
import db from "./db/db.js";
import { PeerRepository } from "./peer/repository.js";
import { CombinationResourceResolver } from "./resource/resolver.js";
import { ResourceRepository } from "./resource/resource.js";
import { CombinationResourceInvoker } from "./resource/invoker.js";

export interface Service {
    peerRepository: PeerRepository;
    resourceRepository: ResourceRepository;
    resourceResolver: ResourceResolver;
    resourceInvoker: ResourceInvoker;
}

export function createService(resources: Resource[]): Service {
    const resourceRepository = new ResourceRepository(db, resources);
    const resourceResolver = new CombinationResourceResolver(resourceRepository);
    const resourceInvoker = new CombinationResourceInvoker();

    return {
        peerRepository: new PeerRepository(db),
        resourceRepository,
        resourceResolver,
        resourceInvoker,
    };
}
