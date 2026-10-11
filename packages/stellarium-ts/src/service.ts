import { Resource, ResourceInvoker, ResourceResolver } from "requestscript";
import db from "./db/db.js";
import { PeerRepository } from "./peer/repository.js";
import { CombinationResourceResolver } from "./resource/resolver.js";
import { ResourceRepository, type StellariumResource } from "./resource/repository.js";
import { CombinationResourceInvoker } from "./resource/invoker.js";
import { OperatorClient } from "./client/operatorClient.js";

export interface Service {
    peerRepository: PeerRepository;
    resourceRepository: ResourceRepository;
    resourceResolver: ResourceResolver;
    resourceInvoker: ResourceInvoker;
    operatorClient: OperatorClient;
}

export function createService(resources: StellariumResource[]): Service {
    const resourceRepository = new ResourceRepository(db, resources);

    const resourceResolver = new CombinationResourceResolver(resourceRepository);
    
    // TODO: Replace with actual values.
    const resourceInvoker = new CombinationResourceInvoker(resourceRepository, 10000, "TODO", "TODO");

    const operatorClient = new OperatorClient(process.env.OPERATOR_URL!);

    return {
        peerRepository: new PeerRepository(db),
        resourceRepository,
        resourceResolver,
        resourceInvoker,
        operatorClient,
    };
}
