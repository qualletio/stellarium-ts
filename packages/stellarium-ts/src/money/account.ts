import { randomUUID } from "node:crypto";
import type { CallAttachment, Resource, ResourceFunctionCallParameter } from "requestscript";
import type { AttachmentRead, MoneyContractRef, MoneyReadRequest, MoneyStageRequest, OperatorClient } from "../client/operatorClient.js";
import type { InvokeResult } from "../resource/settlement.js";

/** Resources under this path are built into stellarium-ts, and never learned from peers or deployed (docs/money.md, Trust). */
export const MONEY_PATH = 'sh.stellarium.money';
export const ACCOUNT_NAME = 'Account';
/** Marks the built-in `Account` resource, so the invoker serves it rather than forwarding or running it. */
export const ACCOUNT_BUILTIN = 'sh.stellarium.money.Account';

export const RANDOM_PATH = 'sh.stellarium.random';
export const RANDOM_NAME = 'Random';
/** Marks the built-in `Random` resource, which the invoker serves like `Account`. */
export const RANDOM_BUILTIN = 'sh.stellarium.random.Random';

/**
 * Whether `path` is reserved for stellarium-ts's built-in resources: `sh.stellarium.money` or
 * `sh.stellarium.random`, or below either.
 */
export function isMoneyPath(path: string): boolean {
    return [MONEY_PATH, RANDOM_PATH].some(reserved => path === reserved || path.startsWith(`${reserved}.`));
}

const neverRun = async () => {
    throw new Error('sh.stellarium.money.Account is served by the invoker');
};

/**
 * `sh.stellarium.money.Account` (docs/money.md, Spending money): the balance of the contract that calls it,
 * kept by the operator. Every function evaluates to `{ value, error }`, and a call that fails fails the contract's run.
 */
export const ACCOUNT_RESOURCE: Resource = {
    path: MONEY_PATH,
    name: ACCOUNT_NAME,
    metadata: { builtin: ACCOUNT_BUILTIN },
    functions: [
        { name: 'balance', parameters: [], returnType: 'int64', exec: neverRun },
        { name: 'earmark', parameters: [{ name: 'key', type: 'string' }], returnType: 'void', exec: neverRun },
        { name: 'fundingOf', parameters: [{ name: 'org', type: 'string' }, { name: 'key', type: 'string' }], returnType: 'int64', exec: neverRun },
        { name: 'canReceive', parameters: [{ name: 'org', type: 'string' }], returnType: 'boolean', exec: neverRun },
        { name: 'pay', parameters: [{ name: 'to', type: 'string' }, { name: 'amount', type: 'int64' }, { name: 'from', type: 'string' }, { name: 'key', type: 'string' }], returnType: 'int64', exec: neverRun },
        { name: 'tryPay', parameters: [{ name: 'to', type: 'string' }, { name: 'amount', type: 'int64' }, { name: 'from', type: 'string' }, { name: 'key', type: 'string' }], returnType: 'boolean', exec: neverRun },
        { name: 'refund', parameters: [{ name: 'to', type: 'string' }, { name: 'amount', type: 'int64' }, { name: 'key', type: 'string' }], returnType: 'int64', exec: neverRun },
    ],
};

/**
 * `sh.stellarium.random.Random` (docs/money.md, Time and randomness): randomness in two steps. `requestValue(key)`
 * asks for a value; the operator draws it only once the run's money tree applies, so a run can't be retried
 * until it draws a value it likes. A later run reads it with `value(key)`, which fails until it's drawn. Each
 * contract requests a key once. Its calls stage and read on the operator like `Account`'s.
 */
export const RANDOM_RESOURCE: Resource = {
    path: RANDOM_PATH,
    name: RANDOM_NAME,
    metadata: { builtin: RANDOM_BUILTIN },
    functions: [
        { name: 'requestValue', parameters: [{ name: 'key', type: 'string' }], returnType: 'void', exec: neverRun },
        { name: 'value', parameters: [{ name: 'key', type: 'string' }], returnType: 'string', exec: neverRun },
    ],
};

/**
 * The operator run that `Account` calls stage on, shared by every contract that stages on it, since a run's
 * call indexes count every call made on it. A contract run that isn't billed has none, so the outermost
 * contract of such a chain on this node opens one the first time a contract in the chain calls `Account`,
 * and settles it when it finishes.
 */
export class MoneyRun {
    private nextCallIndex = 0;
    private openedId?: string;
    private opening?: Promise<string | { error: string }>;
    /** Set when a change was staged on the run. */
    staged = false;
    /**
     * Set when a request script's attempt to attach money failed: the script then fails, as a contract whose
     * `Account` call failed does, so nothing moves because a payment was refused.
     */
    failure?: string;
    /**
     * Set when a contract that shares the run failed after money was staged on it. Its changes can't be dropped
     * apart from the others', so the whole run fails.
     */
    poisoned?: string;

    /** With `runId`, the run is a billed contract's own. Without, `open` opens one when it is first needed. */
    constructor(private readonly runId?: string, private readonly open?: (runId: string) => Promise<{ ok: true } | { ok: false, error: string }>) {}

    /** The run's id, opening it first if needed. */
    async id(): Promise<string | { error: string }> {
        if (this.runId !== undefined) return this.runId;
        if (this.openedId !== undefined) return this.openedId;
        if (!this.open) return { error: 'the contract runs without an operator run' };
        this.opening ??= (async () => {
            const runId = randomUUID();
            const opened = await this.open!(runId);
            if (!opened.ok) {
                this.opening = undefined;
                return { error: opened.error };
            }
            this.openedId = runId;
            return runId;
        })();
        return this.opening;
    }

    /** The id of a run this opened, which its opener settles. */
    get opened(): string | undefined {
        return this.openedId;
    }

    callIndex(): number {
        return this.nextCallIndex++;
    }
}

/** One contract run's use of `Account`. */
export interface AccountSession {
    run: MoneyRun;
    /** The contract making the calls: `path.Name` and its version. */
    contract: { name: string, version: string };
    /** The money attached to this call, which `earmark` labels. Nothing can be attached until RequestScript 1.8.0. */
    attachmentId?: string;
    /** Set by the first call that failed. The contract's run then fails when it ends. */
    failure?: string;
    /** Called when a change is staged: the contract's chain then moves money, and its state waits for it. */
    onStaged?: () => void;
    /** Every operator call the session made, in order, for the run's receipt. */
    ledger?: { runId: string, callIndex: number }[];
}

/** A whole micro-USD amount greater than 0, as the interpreter passes an int64: a number, or a string when large. */
function amount(value: unknown): number | undefined {
    const parsed = typeof value === 'string' && /^-?\d+$/.test(value) ? Number(value) : typeof value === 'bigint' ? Number(value) : value;
    return typeof parsed === 'number' && Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function text(value: unknown): string | undefined {
    return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/** Serves `sh.stellarium.money.Account`, staging changes and reading the balance on the operator. */
export class AccountService {
    constructor(private readonly operatorClient: OperatorClient) {}

    /**
     * Stages money a script or contract attaches to a call to the contract `to`, on the caller's run, and returns
     * the attachment's id, which the call sends so the contract can read it as `payment`. A contract's money comes
     * from its own funding (`session`); a request script's from its run's organization. A failure fails the caller.
     */
    async attach(session: AccountSession | undefined, run: MoneyRun | undefined, to: MoneyContractRef, attachment: CallAttachment): Promise<{ attachmentId: string } | { error: string }> {
        const fail = (reason: string) => {
            const error = `Failed to attach money to ${to.name}@${to.version}: ${reason}`;
            if (session) session.failure ??= error;
            else if (run) run.failure ??= error;
            return { error };
        };
        const moneyRun = session?.run ?? run;
        if (!moneyRun) return fail('the call has no run to move money in');
        const runId = await moneyRun.id();
        if (typeof runId !== 'string') return fail(runId.error);
        const attachmentId = randomUUID();
        const callIndex = moneyRun.callIndex();
        session?.ledger?.push({ runId, callIndex });
        const staged = await this.operatorClient.stageMoney({
            runId,
            callIndex,
            ...(session ? { contract: session.contract } : {}),
            function: 'attach',
            parameters: {
                to,
                amount: attachment.amount,
                attachmentId,
                ...(attachment.payees ? { payees: attachment.payees } : {}),
                ...(attachment.from !== undefined ? { from: attachment.from } : {}),
                ...(attachment.key !== undefined ? { key: attachment.key } : {}),
            },
        });
        if (!staged.ok) return fail(staged.error);
        moneyRun.staged = true;
        session?.onStaged?.();
        return { attachmentId };
    }

    /** The money attached to a contract's call, read from the operator, which only it can vouch for. */
    async payment(run: MoneyRun, contract: { name: string, version: string }, attachmentId: string): Promise<(AttachmentRead & { money: { runId: string, callIndex: number } }) | { error: string }> {
        const runId = await run.id();
        if (typeof runId !== 'string') return { error: runId.error };
        const callIndex = run.callIndex();
        const answer = await this.operatorClient.readMoney({ runId, callIndex, contract, function: 'attachment', parameters: { attachmentId } });
        return answer.ok ? { ...answer.read.response as AttachmentRead, money: { runId, callIndex } } : { error: answer.error };
    }

    /** Serves `sh.stellarium.random.Random` for the running contract. */
    async invokeRandom(session: AccountSession | undefined, functionName: string, parameters: ResourceFunctionCallParameter[]): Promise<InvokeResult> {
        const fail = (reason: string): InvokeResult => {
            const message = `Failed to invoke ${RANDOM_NAME}.${functionName}: ${reason}`;
            if (session) session.failure ??= message;
            return { value: null, error: { message } };
        };
        if (!session) return fail('only a contract can request randomness');
        if (functionName !== 'requestValue' && functionName !== 'value') return fail(`${RANDOM_NAME} has no function ${functionName}`);
        const key = text(parameters.find(parameter => parameter.name === 'key')?.value);
        if (!key || key.length > 255) return fail('a key is a non-empty string of at most 255 characters');
        const runId = await session.run.id();
        if (typeof runId !== 'string') return fail(runId.error);
        const callIndex = session.run.callIndex();
        session.ledger?.push({ runId, callIndex });
        const contract = session.contract;
        if (functionName === 'requestValue') {
            return this.stage(session, fail, { runId, callIndex, contract, function: 'random_request', parameters: { key } }, () => null);
        }
        const answer = await this.operatorClient.readMoney({ runId, callIndex, contract, function: 'random', parameters: { key } });
        return answer.ok ? { value: (answer.read.response as unknown as { value: string }).value, error: null } : fail(answer.error);
    }

    async invoke(session: AccountSession | undefined, functionName: string, parameters: ResourceFunctionCallParameter[]): Promise<InvokeResult> {
        const fail = (reason: string): InvokeResult => {
            const message = `Failed to invoke ${ACCOUNT_NAME}.${functionName}: ${reason}`;
            if (session) session.failure ??= message;
            return { value: null, error: { message } };
        };
        if (!session) {
            return fail('only a contract has a balance');
        }
        const args = Object.fromEntries(parameters.map(parameter => [parameter.name, parameter.value]));
        const key = args.key === null || args.key === undefined ? null : text(args.key);
        if (args.key !== null && args.key !== undefined && key === null) {
            return fail('a key is a non-empty string, or null');
        }
        const runId = await session.run.id();
        if (typeof runId !== 'string') {
            return fail(runId.error);
        }
        const callIndex = session.run.callIndex();
        session.ledger?.push({ runId, callIndex });
        const contract = session.contract;

        switch (functionName) {
            case 'balance':
                return this.read(fail, { runId, callIndex, contract, function: 'balance', parameters: {} });
            case 'fundingOf': {
                const org = text(args.org);
                if (!org) return fail('org is required');
                return this.read(fail, { runId, callIndex, contract, function: 'fundingOf', parameters: { org, key } });
            }
            case 'canReceive': {
                const org = text(args.org);
                if (!org) return fail('org is required');
                return this.read(fail, { runId, callIndex, contract, function: 'canReceive', parameters: { org } });
            }
            case 'earmark': {
                if (!key) return fail('a key is required');
                if (!session.attachmentId) return fail('nothing was attached to this call');
                return this.stage(session, fail, { runId, callIndex, contract, function: 'earmark', parameters: { attachmentId: session.attachmentId, key } }, () => null);
            }
            case 'pay':
            case 'tryPay': {
                const to = text(args.to);
                const from = text(args.from);
                const value = amount(args.amount);
                if (!to || !from) return fail('to and from are required');
                if (value === undefined) return fail(`amounts are whole micro-USD greater than 0, at most ${Number.MAX_SAFE_INTEGER}`);
                const tryPay = functionName === 'tryPay';
                return this.stage(session, fail, {
                    runId, callIndex, contract, function: 'pay',
                    parameters: { to, amount: value, from, key, ...(tryPay ? { try: true } : {}) },
                }, result => tryPay ? result === true : result);
            }
            case 'refund': {
                const to = text(args.to);
                const value = amount(args.amount);
                if (!to) return fail('to is required');
                if (value === undefined) return fail(`amounts are whole micro-USD greater than 0, at most ${Number.MAX_SAFE_INTEGER}`);
                return this.stage(session, fail, { runId, callIndex, contract, function: 'refund', parameters: { to, amount: value, key } }, result => result);
            }
            default:
                return fail(`${ACCOUNT_NAME} has no function ${functionName}`);
        }
    }

    private async read(fail: (reason: string) => InvokeResult, request: MoneyReadRequest): Promise<InvokeResult> {
        const answer = await this.operatorClient.readMoney(request);
        return answer.ok ? { value: answer.read.response, error: null } : fail(answer.error);
    }

    private async stage(session: AccountSession, fail: (reason: string) => InvokeResult, request: MoneyStageRequest, value: (result: number | boolean | null) => unknown): Promise<InvokeResult> {
        const staged = await this.operatorClient.stageMoney(request);
        if (!staged.ok) return fail(staged.error);
        session.run.staged = true;
        session.onStaged?.();
        return { value: value(staged.result), error: null };
    }
}
