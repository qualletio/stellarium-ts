import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { interpretParsed, parseScript, RequestScriptError, type Resource, type ResourceFunctionCallParameter, type ResourceResolver, type Script, type StateScope, type Statement, structReferences, TokenMeter, typeToString } from "requestscript";
import type { AttachmentRead, CallSender, MoneyContractRef, OperatorClient } from "../client/operatorClient.js";
import { hashData, signData } from "../crypto/utils.js";
import { encodeHostValue, type MoneyCallRef, ReceiptRecorder, receiptsPayload } from "./receipt.js";
import type { EventConsumer } from "../event/repository.js";
import type { EventContractHost, EventService } from "../event/service.js";
import { type EventEnvelope, type EventLineage, qualifiedName } from "../event/types.js";
import type { AccountSession } from "../money/account.js";
import { type CallerIdentity, type CombinationResourceInvoker, type ContractHost, type ContractPaymentVoucher, MAX_CONTRACT_DEPTH, pinnedVersion, type ScriptContext } from "../resource/invoker.js";
import { CONTRACT_FUNCTION, type ResourceRepository } from "../resource/repository.js";
import { type InvokeResult, settlePaidCall } from "../resource/settlement.js";
import type { SettlementOutbox } from "../resource/outbox.js";
import type { NodeConfig } from "../service.js";
import type { ContractRepository, StoredContract } from "./repository.js";
import type { StructService } from "../struct/service.js";
import { isMoneyPath, MoneyRun } from "../money/account.js";
import { type ContractStateRepository, type ContractStateRow, DEFAULT_MAX_CONTRACT_STATE_BYTES } from "./state.js";
import { Frame, StateBusy, StateCoordinator, StateTransaction } from "./pending.js";

export const DEFAULT_MAX_CONTRACT_SOURCE_BYTES = 64 * 1024;
/** The longest a call waits for earlier calls of the same stateful contract on this node. */
export const CONTRACT_LOCK_TIMEOUT_MS = 30_000;

/** What a contract runs with: its built-ins, its depth, the contracts it runs inside, and the run that pays. */
interface RunContext {
    jwt: unknown;
    caller: CallerIdentity;
    depth: number;
    contracts?: string[];
    runId?: string;
    /** The chain of events the contract runs in, when an event started it. */
    event?: EventLineage;
    /** The free run, shared down a chain of unbilled contract calls, that `Account` changes are staged on. */
    moneyRun?: MoneyRun;
    /** The chain of contract calls on this node the contract runs in, and its caller's place in it. */
    state?: { tx: StateTransaction, frame: Frame };
    /** Money attached to the call, staged by the caller: the contract reads it as `payment`. */
    attachmentId?: string;
    /** The run's time in milliseconds, which a payable contract reads as `now`. */
    now?: number;
    /** Who made the call, which a payable contract reads as `sender`. */
    sender?: CallSender;
    /** For an event contract: the event, which it reads as the built-in `event`, and its type at the version it consumes. */
    consuming?: { event: Record<string, unknown>, data: Record<string, unknown>, type: { path: string, name: string, version: string } };
}

/** Who deploys or deletes a contract: the node's admin with its API key, or an organization's API client with a run token. */
export type ContractCaller = { kind: 'apiKey' } | { kind: 'client', token: string, organizationId: string };

/** A refusal, with the HTTP status a route answers. */
export type ContractRefusal = { ok: false, status: number, error: string };

export interface DeployedContract {
    path: string;
    name: string;
    version: string;
    /** What the deploy cost the caller's organization, in micro-USD. */
    feeMicroUsd: number;
}

const refuse = (status: number, error: string): ContractRefusal => ({ ok: false, status, error });

/** The RequestScript version this node runs contracts with, which the operator records to replay them. */
export const REQUESTSCRIPT_VERSION: string = createRequire(import.meta.url)('requestscript/package.json').version;

/** The `path.Name` and version of every contract the statements bind by version, `const r: path.Name@version`, in order. */
function pinnedResources(statements: Statement[]): { key: string, version: string }[] {
    return statements.flatMap((statement): { key: string, version: string }[] => {
        switch (statement.kind) {
            case 'resourceDecl': {
                const version = (statement as { version?: string }).version;
                return version === undefined ? [] : [{ key: [...statement.resourcePath, statement.resourceName].join('.'), version }];
            }
            case 'if':
                return [...statement.branches.flatMap(branch => pinnedResources(branch.body)), ...pinnedResources(statement.elseBody ?? [])];
            default:
                return [];
        }
    });
}

/** The `path.Name` of every resource the statements bind without a version, `const r: path.Name`, in order. */
function unpinnedResources(statements: Statement[]): string[] {
    return statements.flatMap((statement): string[] => {
        switch (statement.kind) {
            case 'resourceDecl':
                // `version` is set by requestscript 1.8.0's parser, for `const r: path.Name@version`.
                return (statement as { version?: string }).version === undefined ? [[...statement.resourcePath, statement.resourceName].join('.')] : [];
            case 'if':
                return [...statement.branches.flatMap(branch => unpinnedResources(branch.body)), ...unpinnedResources(statement.elseBody ?? [])];
            default:
                return [];
        }
    });
}

/**
 * Deploys, deletes and runs the contracts on this node. A contract's latest version is one of the node's
 * resources, with one function, `run`. Calls to it are billed by the tokens it executes, through a run the
 * operator holds on the caller's organization or on the caller's own run, which also pays for the paid calls
 * the contract makes.
 */
export class ContractService implements ContractHost, EventContractHost {
    /** Tells peers about this node's resources again, after a contract is deployed or deleted. Set once the node listens. */
    announce?: () => void;
    /** Publishes the events contracts emit, and knows the event types they consume. Without it, contracts can't emit or consume events. */
    events?: EventService;
    /** Resolves the structs contracts' types name. Without it, a contract that names a struct can't be deployed. */
    structs?: StructService;
    /**
     * The public key of the peer serving from a base URL, which names the node hosting a contract a new
     * contract depends on. Without it, only this node's contracts can be named as dependencies.
     */
    peerKey?: (baseUrl: string) => Promise<string | undefined>;
    /** The latest call holding each stateful contract (`path.Name`) on this node. */
    private readonly locks = new Map<string, Promise<void>>();
    /** How long a call waits for earlier calls of the same stateful contract. */
    lockTimeoutMs = CONTRACT_LOCK_TIMEOUT_MS;

    constructor(
        private readonly contracts: ContractRepository,
        private readonly state: ContractStateRepository,
        private readonly resources: ResourceRepository,
        private readonly resolver: ResourceResolver,
        private readonly invoker: CombinationResourceInvoker,
        private readonly operatorClient: OperatorClient,
        private readonly config: NodeConfig,
        private readonly outbox: SettlementOutbox,
        private readonly log: (error: unknown, message: string) => void = (error, message) => console.error(message, error),
    ) {
        this.pending = new StateCoordinator(state, operatorClient, () => config.maxContractStateBytes ?? DEFAULT_MAX_CONTRACT_STATE_BYTES, log);
    }

    /** Holds the state of contract chains that move money until the operator settles it (docs/money.md, Settlement). */
    readonly pending: StateCoordinator;

    /**
     * Saves a new version of a contract. A deploy by another organization's API client pays this node's
     * deploy fee from the client's run hold, and is charged only if the contract is saved.
     */
    async deploy(source: string, description: string | undefined, caller: ContractCaller): Promise<{ ok: true, contract: DeployedContract } | ContractRefusal> {
        const maxBytes = this.config.maxContractSourceBytes ?? DEFAULT_MAX_CONTRACT_SOURCE_BYTES;
        if (Buffer.byteLength(source) > maxBytes) {
            return refuse(413, `Contracts may be at most ${maxBytes} bytes`);
        }
        let script: Script;
        try {
            script = parseScript(source);
        } catch (error) {
            return refuse(400, `Invalid contract: ${error instanceof Error ? error.message : String(error)}`);
        }
        const declaration = script.declaration;
        if (declaration.kind !== 'contract') {
            return refuse(400, 'Invalid contract: deploy a contract script, not a request');
        }
        if (declaration.path.length === 0) {
            return refuse(400, 'Invalid contract: give it a path, such as com.example.Name');
        }
        if (isMoneyPath(declaration.path.join('.'))) {
            return refuse(400, 'Invalid contract: sh.stellarium.money and sh.stellarium.random are reserved for stellarium-ts\'s built-in resources');
        }
        if (!declaration.returnType && !declaration.consumes) {
            return refuse(400, 'Invalid contract: declare its return type, such as contract com.example.Name(...): string');
        }
        const path = declaration.path.join('.');
        const { name, version } = declaration;
        const structs = this.structs
            ? await this.structs.checkScript(script, 'contract')
            : structReferences(script).length > 0 ? refuse(400, 'Invalid contract: this node doesn\'t know any structs') : undefined;
        if (structs) {
            return structs;
        }
        // A contract runs the versions it was deployed against, so the code it calls can't change under it.
        // The interpreter refuses the binding when it runs, too; this catches it before anyone depends on it.
        for (const key of unpinnedResources(script.body)) {
            const current = key === `${path}.${name}` ? version : (await this.resolver.resolve(key) as { version?: string } | undefined)?.version;
            if (current !== undefined) {
                return refuse(400, `Invalid contract: ${key} is a contract, so bind it by its version, e.g. 'const ref: ${key}@${current}'`);
            }
        }

        if (this.resources.isRegistered({ path, name }) || await this.resources.isLearned(path, name)) {
            return refuse(409, `${path}.${name} is already a resource on the network`);
        }
        const ownerOrganizationId = caller.kind === 'client' ? caller.organizationId : null;
        const owner = await this.contracts.owner(path, name);
        if (owner !== undefined && ownerOrganizationId !== null && owner !== ownerOrganizationId) {
            return refuse(409, `${path}.${name} belongs to another organization`);
        }

        // Events: what an event contract consumes, and what any contract emits, are checked before anything is saved.
        const existingConsumer = owner === undefined ? undefined : await this.events?.repository.consumer(path, name);
        if (owner !== undefined && (existingConsumer !== undefined) !== (declaration.consumes !== undefined)) {
            return refuse(409, declaration.consumes
                ? `${path}.${name} is a contract callers call, so a new version can't be an event contract`
                : `${path}.${name} is an event contract, so every version must consume an event`);
        }
        let consumer: EventConsumer | undefined;
        if (declaration.consumes) {
            if (!this.events) {
                return refuse(400, 'Invalid contract: this node doesn\'t run event contracts');
            }
            // The organization a contract runs for: its owner's, or this node's for its admin's.
            const deployer = owner ?? ownerOrganizationId ?? this.config.organizationId ?? null;
            const consumed = await this.events.consumedType(declaration.consumes, deployer);
            if (!consumed.ok) {
                return consumed;
            }
            consumer = {
                path,
                name,
                eventPath: consumed.eventType.path,
                eventName: consumed.eventType.name,
                eventVersion: consumed.eventType.version,
                ownerOrganizationId: owner ?? ownerOrganizationId,
                mandateId: existingConsumer?.mandateId ?? null,
            };
        }
        const emits = this.events ? await this.events.checkEmits(script, owner ?? ownerOrganizationId) : undefined;
        if (emits) {
            return emits;
        }
        if (!this.events && script.body.some(function emits(statement): boolean {
            return statement.kind === 'emit' || (statement.kind === 'if' && [...statement.branches.flatMap(branch => branch.body), ...statement.elseBody ?? []].some(emits));
        })) {
            return refuse(400, 'Invalid contract: this node doesn\'t publish events');
        }
        // The operator keeps the contract's owner, source and dependencies, which buyers read before funding a
        // payable contract (docs/money.md, Registration). A payable contract can't hold money until it's
        // registered, so its deploy waits for it; any other contract is registered after it's saved.
        const payable = (declaration as { payable?: boolean }).payable === true;
        const registration = async (): Promise<{ ok: true } | ContractRefusal> => {
            const dependencies = await this.dependencies(script, path, name, version);
            if (!dependencies.ok) return dependencies;
            const registered = await this.operatorClient.registerContract({
                name: `${path}.${name}`,
                version,
                payable,
                source,
                requestscriptVersion: REQUESTSCRIPT_VERSION,
                dependencies: dependencies.dependencies,
                ...(caller.kind === 'client' ? { token: caller.token } : {}),
            });
            return registered.ok ? registered : refuse(registered.status, `The operator refused to register the contract: ${registered.error}`);
        };
        if (payable) {
            if (!this.config.operatorUrl) {
                return refuse(400, 'Invalid contract: a payable contract needs a node with an operator, which keeps its balance');
            }
            const registered = await registration();
            if (!registered.ok) {
                return registered;
            }
        }

        // Another organization's event contract is billed to it under a mandate its API client grants now.
        if (consumer && caller.kind === 'client' && caller.organizationId !== this.config.organizationId) {
            const mandate = await this.operatorClient.createEventMandate({ token: caller.token, consumer: `${path}.${name}` });
            if (!mandate.ok) {
                return refuse(mandate.status, mandate.error);
            }
            consumer.mandateId = mandate.mandateId;
        }

        const save = async () => {
            const result = await this.contracts.save({
                path,
                name,
                version,
                source,
                parameters: declaration.parameters.map(parameter => ({ name: parameter.name, type: typeToString(parameter.type) })),
                // An event contract returns nothing.
                returnType: declaration.returnType ? typeToString(declaration.returnType) : '',
                ownerOrganizationId,
                description: description ?? null,
            });
            if (result.ok && consumer) {
                await this.events!.repository.saveConsumer(consumer);
            }
            return result;
        };
        const saved = (feeMicroUsd: number) => {
            if (!payable && this.config.operatorUrl) {
                // Nothing waits on it: a contract that isn't payable never holds money.
                setTimeout(() => {
                    registration().then(
                        result => { if (!result.ok) this.log(result.error, `Failed to register ${path}.${name}@${version} with the operator`); },
                        error => this.log(error, `Failed to register ${path}.${name}@${version} with the operator`),
                    );
                }, 0);
            }
            this.announce?.();
            if (consumer) {
                this.events?.announce?.();
            }
            return { ok: true as const, contract: { path, name, version, feeMicroUsd } };
        };
        const versionExists = () => refuse(409, `${path}.${name}@${version} already exists: contracts are immutable, so deploy a new version`);

        const fee = this.config.contractDeployFeeMicroUsd ?? 0;
        const billed = caller.kind === 'client' && caller.organizationId !== this.config.organizationId && fee > 0;
        if (!billed) {
            const result = await save();
            return result.ok ? saved(0) : result.refused === 'version_exists' ? versionExists() : refuse(409, `${path}.${name} belongs to another organization`);
        }

        const organizationId = this.config.organizationId;
        if (!organizationId) {
            return refuse(503, 'This node isn\'t enrolled in an organization, so it can\'t charge the deploy fee');
        }
        const runId = randomUUID();
        const authorization = await this.operatorClient.authorizeRun({ token: caller.token, runId, source });
        if (!authorization.ok) {
            return refuse(authorization.status, authorization.error);
        }
        const voucher = this.invoker.createPaymentVoucher(organizationId, fee, path, name, 'deploy', [{ name: 'version', value: version }], runId);
        let refusal: ContractRefusal | undefined;
        const result = await settlePaidCall(this.operatorClient, this.outbox, voucher, async () => {
            const result = await save();
            if (result.ok) {
                return { value: true, error: null };
            }
            refusal = result.refused === 'version_exists' ? versionExists() : refuse(409, `${path}.${name} belongs to another organization`);
            return { value: null, error: { message: refusal.error } };
        });
        // The deploy ran no script, so the run is charged nothing beyond the fee's receipt.
        await this.settleRun(runId, 'capture', 0);
        if ('refused' in result) {
            return refuse(result.refused.status, result.refused.error);
        }
        return refusal ?? saved(fee);
    }

    /**
     * Every contract version the script binds, with the node hosting it. Refuses (400) one whose host this node
     * doesn't know, since a buyer must be able to read every contract a payable contract calls.
     */
    private async dependencies(script: Script, path: string, name: string, version: string): Promise<{ ok: true, dependencies: MoneyContractRef[] } | ContractRefusal> {
        const dependencies: MoneyContractRef[] = [];
        for (const pinned of pinnedResources(script.body)) {
            const key = `${pinned.key}@${pinned.version}`;
            if (dependencies.some(dependency => `${dependency.name}@${dependency.version}` === key)) continue;
            if (pinned.key === `${path}.${name}` && pinned.version === version) {
                dependencies.push({ nodePublicKey: this.config.publicKey, name: pinned.key, version: pinned.version });
                continue;
            }
            // requestscript 1.8.0's resolver takes the pinned version; this node's always has.
            const resolve = this.resolver.resolve.bind(this.resolver) as (key: string, version?: string) => Promise<Resource | undefined>;
            const resource = await resolve(pinned.key, pinned.version);
            const baseUrl = resource?.metadata.baseUrl as string | undefined;
            const nodePublicKey = resource === undefined ? undefined : baseUrl === undefined ? this.config.publicKey : await this.peerKey?.(baseUrl);
            if (!nodePublicKey) {
                return refuse(400, `Invalid contract: the node hosting ${key} isn't known, so it can't be named as a dependency`);
            }
            dependencies.push({ nodePublicKey, name: pinned.key, version: pinned.version });
        }
        return { ok: true, dependencies };
    }

    /** Deletes a version, or every version, of a contract. Its owner or the node's admin may. */
    async delete(path: string, name: string, version: string | undefined, caller: ContractCaller): Promise<{ ok: true } | ContractRefusal> {
        const owner = await this.contracts.owner(path, name);
        if (owner === undefined) {
            return refuse(404, `No contract ${path}.${name}`);
        }
        if (caller.kind === 'client' && owner !== caller.organizationId) {
            return refuse(403, `${path}.${name} belongs to another organization`);
        }
        if (!await this.contracts.delete(path, name, version)) {
            return refuse(404, `No contract ${path}.${name}@${version}`);
        }
        // State outlives a version, so a new one keeps it, but not the contract.
        if (await this.contracts.owner(path, name) === undefined) {
            await this.state.deleteContract(path, name);
            if (await this.events?.repository.consumer(path, name)) {
                await this.events!.repository.deleteConsumer(path, name);
                this.events!.announce?.();
            }
        }
        this.announce?.();
        return { ok: true };
    }

    /** The contract's state variables and their scopes, for its owner and the node's admin. */
    async readState(path: string, name: string, caller: ContractCaller): Promise<{ ok: true, variables: ContractStateRow[] } | ContractRefusal> {
        const owner = await this.contracts.owner(path, name);
        if (owner === undefined) {
            return refuse(404, `No contract ${path}.${name}`);
        }
        if (caller.kind === 'client' && owner !== caller.organizationId) {
            return refuse(403, `${path}.${name} belongs to another organization`);
        }
        return { ok: true, variables: await this.state.list(path, name) };
    }

    /**
     * Runs a contract for another node's call, paid by its voucher, which the route has checked. The operator
     * holds the call's cost as a run named by the voucher's `invocationId`, unless the caller is in this
     * node's organization. `depth` is how many contracts deep the call is. The contract sees the payer the
     * operator authorized, and the voucher's key, as `caller`.
     */
    async serve(voucher: ContractPaymentVoucher, contract: StoredContract, parameters: ResourceFunctionCallParameter[], depth: number, event?: EventLineage, attachmentId?: string, senderContract?: { name: string, version: string }): Promise<InvokeResult | { refused: { status: number, error: string } }> {
        if (event?.contracts.includes(`${contract.path}.${contract.name}`)) {
            return { refused: { status: 400, error: `${contract.path}.${contract.name} is earlier in this chain of events, so it can't be called` } };
        }
        const authorization = await this.operatorClient.authorizeContractRun({ voucher, source: contract.source, ...(senderContract ? { senderContract } : {}) });
        if (!authorization.ok) {
            return { refused: { status: authorization.status, error: authorization.error } };
        }
        // Without the operator's word, a call from a contract has no owner it can vouch for.
        const sender: CallSender = {
            org: authorization.sender ? authorization.sender.org : senderContract ? null : authorization.payerOrganizationId ?? null,
            node: voucher.publicKey,
            contract: authorization.sender ? authorization.sender.contract : senderContract ? `${senderContract.name}@${senderContract.version}` : null,
        };
        // The tree's time is the operator's stamp when the call is part of a tree; otherwise it starts here.
        const context = { jwt: null, depth, caller: { org: authorization.payerOrganizationId ?? null, node: voucher.publicKey }, event, attachmentId, now: authorization.now ?? Date.now(), sender };
        // A free call from a run is still part of the run's tree: the operator gives it a run, at no price, for
        // its Account changes, which this node settles like a billed one.
        if (authorization.free && voucher.runId === undefined) {
            return this.run(contract, parameters, context);
        }
        return this.runBilled(voucher.invocationId, contract, parameters, context);
    }

    async invokeLocal(resource: Resource, parameters: ResourceFunctionCallParameter[], context: ScriptContext, attachmentId?: string): Promise<InvokeResult> {
        const failed = (reason: string) => ({ value: null, error: { message: `Failed to invoke ${resource.name}.${CONTRACT_FUNCTION}: ${reason}` } });
        const depth = (context.depth ?? 0) + 1;
        if (depth > MAX_CONTRACT_DEPTH) {
            return failed(`contracts may call each other at most ${MAX_CONTRACT_DEPTH} deep`);
        }
        // A contract binds the version it calls; a request script that named none gets the latest.
        const version = pinnedVersion(resource);
        const contract = version === undefined
            ? await this.contracts.latest(resource.path, resource.name)
            : await this.contracts.callable(resource.path, resource.name, version);
        if (!contract) {
            return failed(version === undefined ? 'the contract was deleted' : `version ${version} was deleted`);
        }
        // A script that doesn't say who it runs for is this node's own.
        const caller = context.caller ?? { org: this.config.organizationId ?? null, node: this.config.publicKey };
        // A contract here called it as its registered owner, or else a request script for its run's organization.
        const sender: CallSender = context.self
            ? { org: context.self.owner, node: this.config.publicKey, contract: context.self.contract }
            : { org: caller.org, node: this.config.publicKey, contract: null };
        const runContext = { jwt: context.jwt ?? null, depth, caller, contracts: context.contracts, event: context.event, moneyRun: context.moneyRun, state: context.state, attachmentId, now: context.now ?? Date.now(), sender };
        if (context.runId === undefined) {
            return this.run(contract, parameters, runContext);
        }
        // A billed script pays for the contract as another node's script would, from its run's hold.
        const organizationId = this.config.organizationId;
        if (!organizationId) {
            return failed('this node is not enrolled in an organization that can be paid');
        }
        const costLimit = this.config.contractCostLimitMicroUsd ?? this.config.costLimitMicroUsd;
        const voucher = this.invoker.createContractVoucher(organizationId, this.config.priceMicroUsdPerMillionTokens ?? 0, costLimit, resource.path, resource.name, CONTRACT_FUNCTION, parameters, context.runId, version);
        const authorization = await this.operatorClient.authorizeContractRun({ voucher, source: contract.source });
        if (!authorization.ok) {
            return failed(authorization.error);
        }
        return this.runBilled(voucher.invocationId, contract, parameters, runContext);
    }

    /**
     * Runs an event contract with one event. It runs free for this node's organization and its admin, and
     * otherwise under the mandate its deployer's API client granted, held and charged like the client's runs.
     * The contract sees the event's owner and publisher as `caller`, and the event as `event`.
     */
    async runEvent(consumer: EventConsumer, envelope: EventEnvelope): Promise<{ ok: true } | { ok: false, error: string, retry: boolean }> {
        const contract = await this.contracts.latest(consumer.path, consumer.name);
        if (!contract) {
            return { ok: false, error: 'The event contract was deleted', retry: false };
        }
        const label = qualifiedName(consumer.path, consumer.name);
        const context: RunContext = {
            jwt: null,
            depth: 1,
            now: Date.now(),
            // Nobody calls an event contract: its sender is the event's owner and publisher, as its caller is.
            sender: { org: envelope.ownerOrganizationId, node: envelope.publisherPublicKey, contract: null },
            caller: { org: envelope.ownerOrganizationId, node: envelope.publisherPublicKey },
            event: {
                depth: envelope.depth,
                types: [...envelope.lineage.types, envelope.type],
                contracts: envelope.lineage.contracts.includes(label) ? [...envelope.lineage.contracts] : [...envelope.lineage.contracts, label],
            },
            consuming: {
                event: { id: envelope.id, type: envelope.type, version: envelope.version, publishedAt: envelope.publishedAt, depth: envelope.depth },
                data: envelope.data,
                type: { path: consumer.eventPath, name: consumer.eventName, version: consumer.eventVersion },
            },
        };
        let result: InvokeResult;
        if (consumer.ownerOrganizationId === null || consumer.ownerOrganizationId === this.config.organizationId) {
            result = await this.run(contract, [], context);
        } else {
            if (!consumer.mandateId) {
                return { ok: false, error: 'The event contract has no mandate to bill its owner with', retry: false };
            }
            const runId = randomUUID();
            const authorization = await this.operatorClient.authorizeEventRun({ mandateId: consumer.mandateId, runId, source: contract.source });
            if (!authorization.ok) {
                // A balance may be topped up, or the operator come back, but a revoked mandate stays revoked.
                return { ok: false, error: authorization.error, retry: authorization.status === 402 || authorization.status >= 500 };
            }
            result = await this.runBilled(runId, contract, [], { ...context, now: authorization.now ?? context.now });
        }
        return result.error ? { ok: false, error: result.error.message, retry: true } : { ok: true };
    }

    /** Runs a contract under a held run, then captures the tokens it executed, or releases the run if it couldn't run. */
    private async runBilled(runId: string, contract: StoredContract, parameters: ResourceFunctionCallParameter[], context: RunContext): Promise<InvokeResult> {
        const meter = new TokenMeter();
        try {
            // A billed contract stages its Account changes on its own run, not a free chain's.
            const result = await this.run(contract, parameters, { ...context, runId, moneyRun: undefined }, meter);
            // A failed contract's tokens are charged, and its money changes dropped.
            await this.settleRun(runId, 'capture', meter.tokens, result.error !== null);
            return result;
        } catch (error) {
            await this.settleRun(runId, 'release', meter.tokens);
            throw error;
        }
    }

    /**
     * Runs a contract's script. Its calls are made at `context.depth`, and billed to `context.runId` when set.
     * A script that fails is reported as the call's error, as a failing function is.
     *
     * A contract with state variables runs one call at a time on this node, and saves its state only if the
     * run succeeds. A call that re-enters a contract already running in its own chain skips the lock, and
     * whichever of the two saves second finds the state changed and fails, so no update is lost.
     */
    private async run(contract: StoredContract, parameters: ResourceFunctionCallParameter[], context: RunContext, meter?: TokenMeter): Promise<InvokeResult> {
        const label = `${contract.path}.${contract.name}`;
        const failed = (reason: string) => ({ value: null, error: { message: `Contract ${label}@${contract.version} failed: ${reason}` } });
        const script = parseScript(contract.source);
        const stateful = script.body.some(statement => statement.kind === 'varDecl' && statement.state !== undefined);
        let release: (() => void) | undefined;
        if (stateful && !context.contracts?.includes(label)) {
            release = await this.lock(label);
            if (!release) {
                return failed(`it is busy: other calls held it for ${this.lockTimeoutMs / 1000} seconds`);
            }
        }
        const emitter = this.events?.emitter({ scriptOwner: contract.ownerOrganizationId, lineage: context.event, consumes: context.consuming?.type, contract: label });
        // Account calls stage on the contract's own run when it's billed. Otherwise the outermost unbilled contract
        // of a chain opens a free run the first time one of them calls Account, and settles it when it ends.
        const ownsMoneyRun = context.runId === undefined && context.moneyRun === undefined;
        const moneyRun = context.runId !== undefined
            ? new MoneyRun(context.runId)
            : context.moneyRun ?? new MoneyRun(undefined, (runId) => this.operatorClient.openRun({ runId, ...(context.now === undefined ? {} : { now: context.now }) }));
        // The outermost contract on this node starts the chain whose state waits for its money.
        const ownsState = context.state === undefined;
        const tx = context.state?.tx ?? new StateTransaction();
        const frame = new Frame(context.state?.frame);
        // A payable contract's chain always moves money, so its state always waits (requestscript 1.8.0's `payable`).
        if ((script.declaration as { payable?: boolean }).payable === true) {
            tx.money = true;
        }
        const account: AccountSession = { run: moneyRun, contract: { name: label, version: contract.version }, onStaged: () => { tx.money = true; }, ledger: [] };
        const payable = (script.declaration as { payable?: boolean }).payable === true;
        // A read of a scope another chain holds waits for it, giving up the contract meanwhile, so calls that use
        // other scopes carry on.
        const waitForScope = async (scope: StateScope) => {
            if (!this.pending.heldByOther(tx, contract.path, contract.name, scope)) return;
            const hadLock = release !== undefined;
            release?.();
            release = undefined;
            const free = await this.pending.waitFor(tx, contract.path, contract.name, scope, this.lockTimeoutMs);
            if (hadLock) {
                release = await this.lock(label);
                if (!release) throw new StateBusy(`it is busy: other calls held it for ${this.lockTimeoutMs / 1000} seconds`);
            }
            if (!free) throw new StateBusy(`its state is held by a call whose money hasn't settled after ${this.lockTimeoutMs / 1000} seconds; try again`);
        };
        let outcome: InvokeResult | undefined;
        try {
            // Money attached to the call is real only once the operator says so, so the contract reads it from there.
            // A contract the operator has no owner for can't call a payable one, so a stored `null` never matches it.
            if (payable && context.sender && context.sender.org === null) {
                outcome = failed(`${context.sender.contract ?? 'its caller'} has no registered owner, so it can't call a payable contract`);
                return outcome;
            }
            let payment: (AttachmentRead & { money: MoneyCallRef }) | undefined;
            if (context.attachmentId !== undefined) {
                if (!payable) {
                    outcome = failed('it isn\'t payable, so money can\'t be attached to a call to it');
                    return outcome;
                }
                const read = this.invoker.money
                    ? await this.invoker.money.payment(moneyRun, account.contract, context.attachmentId)
                    : { error: 'this node has no operator to move money' };
                if ('error' in read) {
                    outcome = failed(`the money attached to the call can't be read: ${read.error}`);
                    return outcome;
                }
                payment = read;
                account.attachmentId = context.attachmentId;
                tx.money = true;
            }
            outcome = await this.runScript(script, contract, parameters, context, label, emitter, account, { tx, frame }, waitForScope, meter, payable ? { payment, now: context.now } : undefined);
            return outcome;
        } finally {
            release?.();
            if (outcome?.error !== null) {
                // Failed or thrown: its writes, and those of the runs it called, go with its money.
                this.pending.drop(tx, frame);
            }
            if (outcome?.error && !ownsMoneyRun && context.runId === undefined && moneyRun.staged) {
                // Its changes share the chain's run, so they can only be dropped with everyone else's.
                moneyRun.poisoned ??= outcome.error.message;
            }
            if (ownsState) {
                // A chain that moved no money but ran a payable contract still sends its receipts, so the operator's state
                // hash chains stay whole: it opens a run to send them in.
                // Whoever owns the run settles it once it's open: this contract, or the request script that called it.
                if (tx.money && context.runId === undefined && !moneyRun.opened && tx.receipts.length > 0) {
                    await moneyRun.id();
                }
                // The operator decides the chain's whole tree, so any run in it answers for the outcome.
                const runId = tx.money ? context.runId ?? moneyRun.opened : undefined;
                await this.pending.end(tx, runId).catch(error => this.log(error, `Failed to keep the state of ${label}@${contract.version} until its money settles`));
                // After the state, before the capture, so a run the operator settles has its receipts on the way.
                if (runId !== undefined && tx.receipts.length > 0) {
                    const receipts = tx.receipts.map(entry => entry.receipt);
                    await this.outbox.submitReceipts(runId, receipts, signData(receiptsPayload(runId, receipts), this.config.privateKey))
                        .catch(error => this.log(error, `Failed to keep the receipts of run ${runId}`));
                }
            }
            if (ownsMoneyRun && moneyRun.opened) {
                // Thrown (outcome undefined): nothing ran to completion, so the run is released.
                await this.settleRun(moneyRun.opened, outcome ? 'capture' : 'release', 0, outcome?.error != null);
            }
        }
    }

    private async runScript(
        script: Script, contract: StoredContract, parameters: ResourceFunctionCallParameter[], context: RunContext, label: string,
        emitter: ReturnType<EventService['emitter']> | undefined, account: AccountSession, state: { tx: StateTransaction, frame: Frame },
        waitForScope: (scope: StateScope) => Promise<void>, meter?: TokenMeter,
        // Only a payable contract reads `payment` and `now`, so an older contract's own variables of those names still work.
        money?: { payment: (AttachmentRead & { money: MoneyCallRef }) | undefined, now: number | undefined },
    ): Promise<InvokeResult> {
        const failed = (reason: string) => ({ value: null, error: { message: `Contract ${label}@${contract.version} failed: ${reason}` } });
        const stateful = script.body.some(statement => statement.kind === 'varDecl' && statement.state !== undefined);
        // Everything the run reads and calls, for the operator to replay once its chain moves money.
        const recorder = new ReceiptRecorder(account.ledger ?? []);
        try {
            const { jwt, caller, depth, runId, event } = context;
            const moneyRun = runId === undefined ? account.run : undefined;
            const scriptParameters = context.consuming ? context.consuming.data : Object.fromEntries(parameters.map(parameter => [parameter.name, parameter.value]));
            const result = await interpretParsed(script, {
                resourceResolver: this.resolver,
                resourceInvoker: recorder.invoker(this.invoker.forScript({
                    jwt, caller, depth, runId, event, contracts: [...context.contracts ?? [], label], account, moneyRun, state, attest: recorder.attest,
                    ...(context.now === undefined ? {} : { now: context.now }),
                    // The node's own organization owns what its API key deployed, as the operator registered it.
                    self: { contract: `${label}@${contract.version}`, owner: contract.ownerOrganizationId ?? this.config.organizationId ?? null },
                })),
                ...(money?.payment ? { payment: money.payment } : {}),
                ...(money?.now === undefined ? {} : { now: money.now }),
                parameters: scriptParameters,
                meter,
                builtins: { jwt, caller, ...(context.consuming ? { event: context.consuming.event } : {}), ...(money && context.sender ? { sender: context.sender } : {}) },
                state: stateful ? recorder.stateStore({
                    get: async (variable, scope) => {
                        // The chain sees its own writes before they're saved.
                        const own = this.pending.buffered(state.tx, contract.path, contract.name, variable, scope);
                        if (own) return own;
                        await waitForScope(scope);
                        return this.state.get(contract.path, contract.name, variable, scope);
                    },
                }) : undefined,
                events: emitter?.resolver,
                structs: this.structs ? recorder.structResolver(this.structs.resolver) : undefined,
            });
            // A failed Account call fails the run, even when the script carried on past its error, so nothing moves
            // because a payment was refused. Checked before anything is saved.
            if (account.failure) {
                return failed(`${account.failure}, so nothing was saved`);
            }
            if (account.run.poisoned) {
                return failed(`a contract it called failed after moving money (${account.run.poisoned}), so nothing was saved`);
            }
            const unpublishable = emitter?.check(result.events);
            if (unpublishable) {
                return failed(`${unpublishable}, so nothing was saved`);
            }
            if (result.state.length > 0) {
                const maxBytes = this.config.maxContractStateBytes ?? DEFAULT_MAX_CONTRACT_STATE_BYTES;
                // A chain that moves money keeps its writes until the money settles; any other saves them now.
                const committed = state.tx.money
                    ? await this.pending.buffer(state.tx, state.frame, contract.path, contract.name, result.state)
                    : await this.pending.commitNow(contract.path, contract.name, result.state);
                if (!committed.ok) {
                    return failed(committed.reason === 'conflict'
                        ? 'its state changed during the call, so nothing was saved; try again'
                        : `its state would be ${committed.bytes} bytes, more than this node's ${maxBytes}, so nothing was saved`);
                }
            }
            if (emitter && result.events.length > 0) {
                // The run has succeeded and saved its state, so a failure here loses its events but not the call.
                await emitter.publish(result.events).catch(error => this.log(error, `Failed to publish the events of ${label}@${contract.version}`));
            }
            state.tx.receipts.push({
                frame: state.frame,
                receipt: recorder.receipt(
                    { name: label, version: contract.version, sourceHash: hashData(contract.source) },
                    {
                        parameters: encodeHostValue(scriptParameters) as Record<string, unknown>,
                        payment: money?.payment && context.attachmentId ? { ...money.payment, attachmentId: context.attachmentId } : null,
                        now: money?.now ?? null,
                        sender: money && context.sender ? context.sender : null,
                        caller,
                        jwt,
                        event: context.consuming ? context.consuming.event : null,
                    },
                    result,
                    result.usage.tokens,
                ),
            });
            return { value: result.returnValue, error: null };
        } catch (error) {
            if (error instanceof RequestScriptError || error instanceof StateBusy) {
                return failed(error.message);
            }
            throw error;
        }
    }

    /**
     * Keeps a run's capture or release in the outbox, which sends it. Called after the run's state is saved or kept
     * pending, so a crash between the two leaves a run the operator expires and drops, never money applied
     * without its state.
     */
    private async settleRun(runId: string, outcome: 'capture' | 'release', tokens: number, failed = false): Promise<void> {
        await (outcome === 'capture' ? this.outbox.captureRun(runId, tokens, failed) : this.outbox.releaseRun(runId))
            .catch(error => this.log(error, `Failed to keep the ${outcome} of run ${runId}`));
    }

    /**
     * Waits for the contract's previous calls on this node, then holds it until the returned release is
     * called. Answers undefined if the wait passes `lockTimeoutMs`, which breaks a cycle of calls between
     * nodes that leads back here.
     */
    private async lock(label: string): Promise<(() => void) | undefined> {
        const previous = this.locks.get(label) ?? Promise.resolve();
        let release!: () => void;
        const held = new Promise<void>(resolve => {
            release = resolve;
        });
        const tail = previous.then(() => held);
        this.locks.set(label, tail);
        void tail.then(() => {
            if (this.locks.get(label) === tail) {
                this.locks.delete(label);
            }
        });
        let timer: NodeJS.Timeout | undefined;
        const acquired = await Promise.race([
            previous.then(() => true),
            new Promise<false>(resolve => {
                timer = setTimeout(() => resolve(false), this.lockTimeoutMs);
            }),
        ]);
        clearTimeout(timer);
        if (!acquired) {
            // Gives up its turn, so the calls behind it go on once the earlier ones finish.
            release();
            return undefined;
        }
        return release;
    }
}
