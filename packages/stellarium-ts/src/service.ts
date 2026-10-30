import type { JWTVerifyGetKey } from "jose";
import { ResourceResolver } from "requestscript";
import type { NodeDatabase } from "./db/database.js";
import { PeerRepository } from "./peer/repository.js";
import { CombinationResourceResolver } from "./resource/resolver.js";
import { ResourceRepository, type StellariumResource } from "./resource/repository.js";
import { CombinationResourceInvoker } from "./resource/invoker.js";
import { OperatorClient } from "./client/operatorClient.js";
import { RunTokenVerifier } from "./client/runTokens.js";
import { GrantRepository } from "./grant/repository.js";
import { type ApproveGrant, GrantService } from "./grant/service.js";
import { ContractRepository } from "./contract/repository.js";
import { ContractService } from "./contract/service.js";

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
    /** Most one call to a contract on another node may hold: its voucher's `maxAmount`. Defaults to `costLimitMicroUsd`. */
    contractCostLimitMicroUsd?: number;
    /** What another organization pays to deploy a contract to this node. 0 or unset is free. */
    contractDeployFeeMicroUsd?: number;
    /** Largest contract source this node accepts. Defaults to 64 KiB. */
    maxContractSourceBytes?: number;
    /**
     * This node's listed price per million script tokens, which its contracts are charged at. `StellariumNode.start`
     * learns it from the operator.
     */
    priceMicroUsdPerMillionTokens?: number;
    /** SQLite file the node opens, when it has no `databaseUrl`. */
    databasePath?: string;
    /** Postgres URL. When set, the node uses Postgres instead of SQLite. */
    databaseUrl?: string;
    /** Postgres schema the node's tables live in. */
    databaseSchema?: string;
}

export interface Service {
    config: NodeConfig;
    peerRepository: PeerRepository;
    resourceRepository: ResourceRepository;
    resourceResolver: ResourceResolver;
    resourceInvoker: CombinationResourceInvoker;
    operatorClient: OperatorClient;
    grantService: GrantService;
    contractRepository: ContractRepository;
    contractService: ContractService;
    /** Verifies the run tokens `POST /v1/run` accepts. Set when the node has an operator URL. */
    runTokenVerifier?: RunTokenVerifier;
}

export interface ServiceOptions {
    /** Decides `POST /v1/grants/request`. Without it, every request is refused. */
    approveGrant?: ApproveGrant;
    /** Replaces the operator's published keys for verifying run tokens, in tests. */
    runTokenKeys?: JWTVerifyGetKey;
}

export function createService(db: NodeDatabase, resources: StellariumResource[], config: NodeConfig, options: ServiceOptions = {}): Service {
    const contractRepository = new ContractRepository(db);
    // Read from the config on each use, since the node may learn its organization and price after it starts.
    const resourceRepository = new ResourceRepository(db, resources, config.baseUrl, config.organizationId, {
        repository: contractRepository,
        price: () => config.priceMicroUsdPerMillionTokens ?? 0,
        organizationId: () => config.organizationId,
    });

    const resourceResolver = new CombinationResourceResolver(resourceRepository);

    const grantService = new GrantService(new GrantRepository(db), config, options.approveGrant);

    const operatorClient = new OperatorClient(config.operatorUrl, config.publicKey, config.privateKey);

    const resourceInvoker = new CombinationResourceInvoker(resourceRepository, config.costLimitMicroUsd, config.publicKey, config.privateKey, grantService, config.inferenceCostLimitMicroUsd, {
        operatorClient,
        organizationId: config.organizationId,
    });

    const contractService = new ContractService(contractRepository, resourceRepository, resourceResolver, resourceInvoker, operatorClient, config);
    resourceInvoker.contracts = { costLimitMicroUsd: config.contractCostLimitMicroUsd ?? config.costLimitMicroUsd, host: contractService };

    return {
        config,
        peerRepository: new PeerRepository(db),
        resourceRepository,
        resourceResolver,
        resourceInvoker,
        operatorClient,
        grantService,
        contractRepository,
        contractService,
        runTokenVerifier: config.operatorUrl ? new RunTokenVerifier(config.operatorUrl, config.publicKey, options.runTokenKeys) : undefined,
    };
}
