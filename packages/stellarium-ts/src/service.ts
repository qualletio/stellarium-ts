import type { JWTVerifyGetKey } from "jose";
import { ResourceResolver } from "requestscript";
import type { Database } from "sqlite";
import { PeerRepository } from "./peer/repository.js";
import { CombinationResourceResolver } from "./resource/resolver.js";
import { ResourceRepository, type StellariumResource } from "./resource/repository.js";
import { CombinationResourceInvoker } from "./resource/invoker.js";
import { OperatorClient } from "./client/operatorClient.js";
import { RunTokenVerifier } from "./client/runTokens.js";
import { GrantRepository } from "./grant/repository.js";
import { type ApproveGrant, GrantService } from "./grant/service.js";

/** Settings a node runs with. `StellariumNode.start` fills these from its options, then the environment. */
export interface NodeConfig {
    /** URL peers use to reach this node. Also its peer name. */
    baseUrl: string;
    /** Ed25519 SPKI DER, base64url. */
    publicKey: string;
    /** Ed25519 PKCS#8 DER, base64url. */
    privateKey: string;
    /** Bearer token for `POST /v1/run` and the admin routes. When unset, only run tokens are accepted, and the admin routes reject every request. */
    apiKey?: string;
    /** Operator base URL, including `/v1`. Required when the node hosts paid functions, and to accept run tokens. */
    operatorUrl?: string;
    /**
     * The operator organization this node is enrolled in, which is paid for its functions.
     * `StellariumNode.start` asks the operator for it when the node hosts paid functions.
     */
    organizationId?: string;
    /** Most this node will pay for one remote call. */
    costLimitMicroUsd: number;
    /** Most this node will sign for in one remote inference call. */
    inferenceCostLimitMicroUsd: number;
}

export interface Service {
    config: NodeConfig;
    peerRepository: PeerRepository;
    resourceRepository: ResourceRepository;
    resourceResolver: ResourceResolver;
    resourceInvoker: CombinationResourceInvoker;
    operatorClient: OperatorClient;
    grantService: GrantService;
    /** Verifies the run tokens `POST /v1/run` accepts. Set when the node has an operator URL. */
    runTokenVerifier?: RunTokenVerifier;
}

export interface ServiceOptions {
    /** Decides `POST /v1/grants/request`. Without it, every request is refused. */
    approveGrant?: ApproveGrant;
    /** Replaces the operator's published keys for verifying run tokens, in tests. */
    runTokenKeys?: JWTVerifyGetKey;
}

export function createService(db: Database, resources: StellariumResource[], config: NodeConfig, options: ServiceOptions = {}): Service {
    const resourceRepository = new ResourceRepository(db, resources, config.baseUrl, config.organizationId);

    const resourceResolver = new CombinationResourceResolver(resourceRepository);

    const grantService = new GrantService(new GrantRepository(db), config, options.approveGrant);

    const operatorClient = new OperatorClient(config.operatorUrl, config.publicKey, config.privateKey);

    const resourceInvoker = new CombinationResourceInvoker(resourceRepository, config.costLimitMicroUsd, config.publicKey, config.privateKey, grantService, config.inferenceCostLimitMicroUsd, {
        operatorClient,
        organizationId: config.organizationId,
    });

    return {
        config,
        peerRepository: new PeerRepository(db),
        resourceRepository,
        resourceResolver,
        resourceInvoker,
        operatorClient,
        grantService,
        runTokenVerifier: config.operatorUrl ? new RunTokenVerifier(config.operatorUrl, config.publicKey, options.runTokenKeys) : undefined,
    };
}
