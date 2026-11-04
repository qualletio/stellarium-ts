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
import { ContractStateRepository } from "./contract/state.js";
import { EventRepository } from "./event/repository.js";
import { EventService } from "./event/service.js";
import { StructRepository } from "./struct/repository.js";
import { StructService } from "./struct/service.js";

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
    /** Most one contract's state may hold in one scope, its variables' encoded values together. Defaults to 64 KiB. */
    maxContractStateBytes?: number;
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
    /**
     * The operator's statement that this node belongs to `organizationId`, attached to the events it publishes.
     * `StellariumNode.start` gets it with the node's session. Without it, the node can't publish events.
     */
    membershipToken?: string;
    /** The most events one run may emit. Defaults to 16. */
    maxEventsPerRun?: number;
    /** The most one event's data may take, as JSON, in bytes. Defaults to 32 KiB. */
    maxEventDataBytes?: number;
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
    contractStateRepository: ContractStateRepository;
    eventService: EventService;
    structService: StructService;
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

    const contractStateRepository = new ContractStateRepository(db);
    const contractService = new ContractService(contractRepository, contractStateRepository, resourceRepository, resourceResolver, resourceInvoker, operatorClient, config);
    resourceInvoker.contracts = { costLimitMicroUsd: config.contractCostLimitMicroUsd ?? config.costLimitMicroUsd, host: contractService };

    const runTokenVerifier = config.operatorUrl ? new RunTokenVerifier(config.operatorUrl, config.publicKey, options.runTokenKeys) : undefined;
    const eventService = new EventService(new EventRepository(db), config, runTokenVerifier);
    contractService.events = eventService;
    eventService.contracts = contractService;
    const structService = new StructService(new StructRepository(db), config, runTokenVerifier);
    contractService.structs = structService;
    eventService.structs = structService;

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
        contractStateRepository,
        eventService,
        structService,
        runTokenVerifier,
    };
}
