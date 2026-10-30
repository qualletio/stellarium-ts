import { randomUUID } from "node:crypto";
import { interpretParsed, parseScript, RequestScriptError, type Resource, type ResourceFunctionCallParameter, type ResourceResolver, type Script, TokenMeter, typeToString } from "requestscript";
import type { OperatorClient } from "../client/operatorClient.js";
import { type CallerIdentity, type CombinationResourceInvoker, type ContractHost, type ContractPaymentVoucher, MAX_CONTRACT_DEPTH, type ScriptContext } from "../resource/invoker.js";
import { CONTRACT_FUNCTION, type ResourceRepository } from "../resource/repository.js";
import { type InvokeResult, settlePaidCall, settleRunLater } from "../resource/settlement.js";
import type { NodeConfig } from "../service.js";
import type { ContractRepository, StoredContract } from "./repository.js";
import { type ContractStateRepository, type ContractStateRow, DEFAULT_MAX_CONTRACT_STATE_BYTES } from "./state.js";

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

/**
 * Deploys, deletes and runs the contracts on this node. A contract's latest version is one of the node's
 * resources, with one function, `run`. Calls to it are billed by the tokens it executes, through a run the
 * operator holds on the caller's organization or on the caller's own run, which also pays for the paid calls
 * the contract makes.
 */
export class ContractService implements ContractHost {
    /** Tells peers about this node's resources again, after a contract is deployed or deleted. Set once the node listens. */
    announce?: () => void;
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
        private readonly log: (error: unknown, message: string) => void = (error, message) => console.error(message, error),
    ) {}

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
        if (!declaration.returnType) {
            return refuse(400, 'Invalid contract: declare its return type, such as contract com.example.Name(...): string');
        }
        const path = declaration.path.join('.');
        const { name, version } = declaration;

        if (this.resources.isRegistered({ path, name }) || await this.resources.isLearned(path, name)) {
            return refuse(409, `${path}.${name} is already a resource on the network`);
        }
        const ownerOrganizationId = caller.kind === 'client' ? caller.organizationId : null;
        const owner = await this.contracts.owner(path, name);
        if (owner !== undefined && ownerOrganizationId !== null && owner !== ownerOrganizationId) {
            return refuse(409, `${path}.${name} belongs to another organization`);
        }

        const save = () => this.contracts.save({
            path,
            name,
            version,
            source,
            parameters: declaration.parameters.map(parameter => ({ name: parameter.name, type: typeToString(parameter.type) })),
            returnType: typeToString(declaration.returnType!),
            ownerOrganizationId,
            description: description ?? null,
        });
        const saved = (feeMicroUsd: number) => {
            this.announce?.();
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
        const result = await settlePaidCall(this.operatorClient, voucher, async () => {
            const result = await save();
            if (result.ok) {
                return { value: true, error: null };
            }
            refusal = result.refused === 'version_exists' ? versionExists() : refuse(409, `${path}.${name} belongs to another organization`);
            return { value: null, error: { message: refusal.error } };
        }, this.log);
        // The deploy ran no script, so the run is charged nothing beyond the fee's receipt.
        settleRunLater(this.operatorClient, runId, 'capture', 0, this.log);
        if ('refused' in result) {
            return refuse(result.refused.status, result.refused.error);
        }
        return refusal ?? saved(fee);
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
    async serve(voucher: ContractPaymentVoucher, contract: StoredContract, parameters: ResourceFunctionCallParameter[], depth: number): Promise<InvokeResult | { refused: { status: number, error: string } }> {
        const authorization = await this.operatorClient.authorizeContractRun({ voucher, source: contract.source });
        if (!authorization.ok) {
            return { refused: { status: authorization.status, error: authorization.error } };
        }
        const context = { jwt: null, depth, caller: { org: authorization.payerOrganizationId ?? null, node: voucher.publicKey } };
        if (authorization.free) {
            return this.run(contract, parameters, context);
        }
        return this.runBilled(voucher.invocationId, contract, parameters, context);
    }

    async invokeLocal(resource: Resource, parameters: ResourceFunctionCallParameter[], context: ScriptContext): Promise<InvokeResult> {
        const failed = (reason: string) => ({ value: null, error: { message: `Failed to invoke ${resource.name}.${CONTRACT_FUNCTION}: ${reason}` } });
        const depth = (context.depth ?? 0) + 1;
        if (depth > MAX_CONTRACT_DEPTH) {
            return failed(`contracts may call each other at most ${MAX_CONTRACT_DEPTH} deep`);
        }
        const contract = await this.contracts.latest(resource.path, resource.name);
        if (!contract) {
            return failed('the contract was deleted');
        }
        // A script that doesn't say who it runs for is this node's own.
        const caller = context.caller ?? { org: this.config.organizationId ?? null, node: this.config.publicKey };
        const runContext = { jwt: context.jwt ?? null, depth, caller, contracts: context.contracts };
        if (context.runId === undefined) {
            return this.run(contract, parameters, runContext);
        }
        // A billed script pays for the contract as another node's script would, from its run's hold.
        const organizationId = this.config.organizationId;
        if (!organizationId) {
            return failed('this node is not enrolled in an organization that can be paid');
        }
        const costLimit = this.config.contractCostLimitMicroUsd ?? this.config.costLimitMicroUsd;
        const voucher = this.invoker.createContractVoucher(organizationId, this.config.priceMicroUsdPerMillionTokens ?? 0, costLimit, resource.path, resource.name, CONTRACT_FUNCTION, parameters, context.runId);
        const authorization = await this.operatorClient.authorizeContractRun({ voucher, source: contract.source });
        if (!authorization.ok) {
            return failed(authorization.error);
        }
        return this.runBilled(voucher.invocationId, contract, parameters, runContext);
    }

    /** Runs a contract under a held run, then captures the tokens it executed, or releases the run if it couldn't run. */
    private async runBilled(runId: string, contract: StoredContract, parameters: ResourceFunctionCallParameter[], context: RunContext): Promise<InvokeResult> {
        const meter = new TokenMeter();
        try {
            const result = await this.run(contract, parameters, { ...context, runId }, meter);
            settleRunLater(this.operatorClient, runId, 'capture', meter.tokens, this.log);
            return result;
        } catch (error) {
            settleRunLater(this.operatorClient, runId, 'release', meter.tokens, this.log);
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
        try {
            const result = await interpretParsed(script, {
                resourceResolver: this.resolver,
                resourceInvoker: this.invoker.forScript({ ...context, contracts: [...context.contracts ?? [], label] }),
                parameters: Object.fromEntries(parameters.map(parameter => [parameter.name, parameter.value])),
                meter,
                builtins: { jwt: context.jwt, caller: context.caller },
                state: stateful ? { get: (variable, scope) => this.state.get(contract.path, contract.name, variable, scope) } : undefined,
            });
            if (result.state.length > 0) {
                const maxBytes = this.config.maxContractStateBytes ?? DEFAULT_MAX_CONTRACT_STATE_BYTES;
                const committed = await this.state.commit(contract.path, contract.name, result.state, maxBytes);
                if (!committed.ok) {
                    return failed(committed.reason === 'conflict'
                        ? 'its state changed during the call, so nothing was saved; try again'
                        : `its state would be ${committed.bytes} bytes, more than this node's ${maxBytes}, so nothing was saved`);
                }
            }
            return { value: result.returnValue, error: null };
        } catch (error) {
            if (error instanceof RequestScriptError) {
                return failed(error.message);
            }
            throw error;
        } finally {
            release?.();
        }
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
