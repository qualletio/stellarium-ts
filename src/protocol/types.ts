import type { Address, Hex } from "viem";
export type { Address, Hex } from "viem";
export interface Domain {
    name: "Stellarium";
    version: "1";
    chainId: 8453 | 84532;
    verifyingContract: Address;
}
export interface Signed<T> {
    domain: Domain;
    message: T;
    signature: Hex;
}
export interface RequestAuthorization {
    protocolVersion: 1;
    requestId: Hex;
    caller: Address;
    budgetUsdc: bigint;
    requestHash: Hex;
    executionAuthority: Address;
    issuedAt: bigint;
    expiresAt: bigint;
    nonce: bigint;
}
export interface InvocationGrant {
    protocolVersion: 1;
    requestId: Hex;
    authorizationHash: Hex;
    invocationNonce: Hex;
    providerPaymentIdentity: Address;
    resourceId: Hex;
    manifestRevision: bigint;
    functionNameHash: Hex;
    parametersHash: Hex;
    quoteId: Hex;
    grossPriceUsdc: bigint;
    issuedAt: bigint;
    expiresAt: bigint;
}
export interface ExecutionReceipt {
    protocolVersion: 1;
    receiptId: Hex;
    requestId: Hex;
    authorizationHash: Hex;
    invocationId: Hex;
    invocationGrantHash: Hex;
    manifestRevision: bigint;
    providerPaymentIdentity: Address;
    paymentRecipient: Address;
    receiptSigner: Address;
    resourceId: Hex;
    functionNameHash: Hex;
    parametersHash: Hex;
    responseHash: Hex;
    quoteId: Hex;
    grossPriceUsdc: bigint;
    relay: Address;
    relayFeeUsdc: bigint;
    executedAt: bigint;
    issuedAt: bigint;
}
export interface FunctionQuote {
    name: string;
    grossPriceUsdc: bigint;
    quoteId: Hex;
}
export interface MonetizationManifest {
    protocolVersion: 1;
    resourceId: Hex;
    manifestRevision: bigint;
    paymentIdentity: Address;
    paymentRecipient: Address;
    receiptSigner: Address;
    evidenceEncryptionPublicKey: string;
    usdc: Address;
    quoteRegistryId: Hex;
    functions: FunctionQuote[];
    issuedAt: bigint;
}
export interface RelayAdvertisement {
    protocolVersion: 1;
    relay: Address;
    endpoint: string;
    receiptVersion: 1;
    relayFeeUsdc: bigint;
    available: boolean;
    issuedAt: bigint;
    expiresAt: bigint;
    nonce: bigint;
}
export interface Acceptance {
    protocolVersion: 1;
    receiptHash: Hex;
    issuedAt: bigint;
}
export interface Claim {
    authorization: Signed<RequestAuthorization>;
    grant: Signed<InvocationGrant>;
    receipt: Signed<ExecutionReceipt>;
    acceptance?: Signed<Acceptance>;
}
export interface InvocationParameter {
    name: string;
    value: unknown;
}
export interface RunAccess {
    protocolVersion: 1;
    payloadHash: Hex;
    endpointHash: Hex;
    issuedAt: bigint;
    expiresAt: bigint;
    nonce: Hex;
}
export interface RunRequest {
    version: 1;
    kind: "request";
    source: string;
    accessProof?: Signed<RunAccess>;
    payment?: { authorization: Signed<RequestAuthorization> };
}
export interface RunInvocation {
    version: 1;
    kind: "invocation";
    resourceId: Hex;
    resourceKey: string;
    functionName: string;
    parameters: InvocationParameter[];
    accessProof?: Signed<RunAccess>;
    payment?: {
        authorization: Signed<RequestAuthorization>;
        grant: Signed<InvocationGrant>;
    };
}
export type RunBody = RunRequest | RunInvocation;
export interface ChainReference {
    blockNumber: bigint;
    blockHash: Hex;
}
export interface DispatchAcknowledgement {
    protocolVersion: 1;
    invocationId: Hex;
    providerPaymentIdentity: Address;
    receiptSigner: Address;
    receivedAt: bigint;
    chainBlockNumber: bigint;
    chainBlockHash: Hex;
}
export interface ExecutionRecord {
    acceptanceDeliveryError?: string;
    dispatchAcknowledgement?: Signed<DispatchAcknowledgement>;
    claim: Claim;
    evidenceId: Hex;
    providerEndpoint: string;
    returnValue: unknown;
}
export interface RunResult {
    evidenceId?: Hex;
    returnValue: unknown;
    executions: ExecutionRecord[];
}
export interface ManifestRevision {
    manifest: Signed<MonetizationManifest>;
    activatedAt: bigint;
    retiredAt: bigint;
}
export interface RequestBudget {
    caller: Address;
    authorizationHash: Hex;
    remainingUsdc: bigint;
    expiresAt: bigint;
    open: boolean;
}
export interface ProtocolSigner {
    address: Address;
    sign<
        T extends
            | RequestAuthorization
            | InvocationGrant
            | ExecutionReceipt
            | MonetizationManifest
            | RelayAdvertisement
            | Acceptance
            | EvidenceRelease
            | EvidenceDelivery
            | RunAccess
            | DispatchAcknowledgement,
    >(
        primaryType: string,
        domain: Domain,
        message: T,
    ): Promise<Signed<T>>;
}
export interface ArbitrationPanel {
    caller: Address;
    provider: Address;
    round: number;
    evidenceUntil: bigint;
    arbitrators: { address: Address; encryptionPublicKey: string }[];
}
export interface EvidenceRelease {
    protocolVersion: 1;
    receiptId: Hex;
    evidenceId: Hex;
    arbitrator: Address;
    round: number;
    issuedAt: bigint;
    expiresAt: bigint;
    nonce: Hex;
}
export interface EvidenceDelivery {
    protocolVersion: 1;
    receiptId: Hex;
    arbitrator: Address;
    round: number;
    encryptedHash: Hex;
    issuedAt: bigint;
    expiresAt: bigint;
    nonce: Hex;
}
export interface ChainAccess {
    domain: Domain;
    registryDomain: Domain;
    relayDomain: Domain;
    usdc: Address;
    getChainReference(): Promise<ChainReference>;
    getArbitrationPanel(receiptId: Hex): Promise<ArbitrationPanel | undefined>;
    getBudget(requestId: Hex): Promise<RequestBudget | undefined>;
    getRevision(
        resourceId: Hex,
        revision?: bigint,
    ): Promise<ManifestRevision | undefined>;
    publishManifest(manifest: Signed<MonetizationManifest>): Promise<void>;
    isEligibleRelay(relay: Address): Promise<boolean>;
    relayScore(relay: Address): Promise<bigint>;
    submitClaims(claims: Claim[]): Promise<Hex>;
    getClaimState(
        receiptId: Hex,
    ): Promise<"unclaimed" | "pending" | "disputed" | "paid" | "refunded">;
    transactionStatus(hash: Hex): Promise<"pending" | "confirmed" | "failed">;
}
