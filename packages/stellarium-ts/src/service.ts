import { ResourceInvoker, ResourceResolver } from "requestscript";
import type { Database } from "sqlite";
import { PeerRepository } from "./peer/repository.js";
import { CombinationResourceResolver } from "./resource/resolver.js";
import { ResourceRepository, type StellariumResource } from "./resource/repository.js";
import { CombinationResourceInvoker } from "./resource/invoker.js";
import { OperatorClient } from "./client/operatorClient.js";

/** Settings a node runs with. `StellariumNode.start` fills these from its options, then the environment. */
export interface NodeConfig {
    /** URL peers use to reach this node. Also its peer name. */
    baseUrl: string;
    /** Ed25519 SPKI DER, base64url. */
    publicKey: string;
    /** Ed25519 PKCS#8 DER, base64url. */
    privateKey: string;
    /** Bearer token for `POST /v1/run`. When unset, `/v1/run` rejects every request. */
    apiKey?: string;
    /** Operator base URL, including `/v1`. Required when the node hosts paid functions. */
    operatorUrl?: string;
    /** Most this node will pay for one remote call. */
    costLimitLamports: number;
}

export interface Service {
    config: NodeConfig;
    peerRepository: PeerRepository;
    resourceRepository: ResourceRepository;
    resourceResolver: ResourceResolver;
    resourceInvoker: ResourceInvoker;
    operatorClient: OperatorClient;
}

export function createService(db: Database, resources: StellariumResource[], config: NodeConfig): Service {
    const resourceRepository = new ResourceRepository(db, resources, config.baseUrl);

    const resourceResolver = new CombinationResourceResolver(resourceRepository);

    const resourceInvoker = new CombinationResourceInvoker(resourceRepository, config.costLimitLamports, config.publicKey, config.privateKey);

    const operatorClient = new OperatorClient(config.operatorUrl);

    return {
        config,
        peerRepository: new PeerRepository(db),
        resourceRepository,
        resourceResolver,
        resourceInvoker,
        operatorClient,
    };
}
