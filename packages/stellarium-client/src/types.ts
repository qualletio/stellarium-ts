/** What a node's paged lists answer: one page, and the offset of the next, or null on the last page. */
export interface Page<T> {
    items: T[];
    nextOffset: number | null;
}

export interface PageOptions {
    /** Defaults to 0. */
    offset?: number;
    /** At most 100. The node's default applies when omitted. */
    limit?: number;
}

export interface RequestOptions {
    signal?: AbortSignal;
}

/** The node's own address and key, from `GET /v1/self`. */
export interface NodeIdentity {
    baseUrl: string;
    publicKey: string;
    name: string;
}

export interface Peer {
    baseUrl: string;
    name: string;
    publicKey: string;
}

/** A fixed price per call. */
export interface FixedPaymentManifest {
    costMicroUsd: number;
    recipientOrganizationId?: string;
}

/** An inference function's prices per million input and output tokens. */
export interface InferencePaymentManifest {
    inputCostMicroUsdPerMillionTokens: number;
    outputCostMicroUsdPerMillionTokens: number;
    recipientOrganizationId?: string;
}

/** A contract's price per million tokens it executes. */
export interface ContractPaymentManifest {
    priceMicroUsdPerMillionTokens: number;
    recipientOrganizationId?: string;
}

export type PaymentManifest = FixedPaymentManifest | InferencePaymentManifest | ContractPaymentManifest;

export interface ResourceFunctionParameter {
    name: string;
    /** A RequestScript type, such as `string`, `[]int32` or `com.example.Point@1`. */
    type: string;
    description?: string;
}

export interface ResourceFunction {
    name: string;
    returnType: string;
    description?: string;
    parameters: ResourceFunctionParameter[];
    /** Absent for a free function. */
    paymentManifest?: PaymentManifest;
    /** Only callers holding a grant from the provider may call it. */
    restricted?: boolean;
    kind?: 'inference' | 'contract';
}

/** A resource a node hosts, or learned from the peer at `baseUrl`. */
export interface Resource {
    path: string;
    name: string;
    website?: string;
    description?: string;
    functions: ResourceFunction[];
    baseUrl?: string;
}

/** What a successful `POST /v1/run` answers. */
export interface RunResult<T = unknown> {
    /** The script's return value as JSON, or null when it returns nothing. */
    returnValue: T;
    usage: Usage;
}

export interface Usage {
    /** The RequestScript tokens the script executed. A billed run is charged for these at the node's listed price. */
    tokens: number;
}

export interface ContractParameter {
    name: string;
    type: string;
}

/** A version of a contract deployed on a node. */
export interface Contract {
    path: string;
    name: string;
    version: string;
    parameters: ContractParameter[];
    returnType: string;
    /** The organization that deployed it, which owns every version. Null when the node's admin did. */
    ownerOrganizationId: string | null;
    description: string | null;
    source: string;
    createdAt: string;
}

export interface DeployedContract {
    path: string;
    name: string;
    version: string;
    /** What the deploy cost the caller's organization, in micro-USD. */
    feeMicroUsd: number;
}

/** A state variable's scope: null for the shared copy, else the key it was scoped by. */
export type StateScope = null | { kind: 'string' | 'integer', key: string };

export interface ContractStateVariable {
    name: string;
    scope: StateScope;
    value: unknown;
    updatedAt: string;
}

export interface Field {
    name: string;
    type: string;
}

export interface DeployedEventType {
    path: string;
    name: string;
    version: string;
    fields: Field[];
    /** Delivered only to event contracts deployed by its owner. */
    restricted: boolean;
    ownerOrganizationId: string;
}

/** An event type a node knows: declared there, or learned from the node at `baseUrl`. */
export interface EventType extends DeployedEventType {
    baseUrl: string;
    description: string | null;
    createdAt: string;
}

/** A struct a node knows: declared there, or learned from the node at `baseUrl`. */
export interface Struct {
    path: string;
    name: string;
    version: string;
    fields: Field[];
    /** The organization that owns the struct's path. Only its nodes may declare versions of it. */
    ownerOrganizationId: string;
    baseUrl: string;
    description: string | null;
    createdAt: string;
}
