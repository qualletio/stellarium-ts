import { randomBytes } from "node:crypto";
import { and, asc, desc, eq, getTableColumns, gte, inArray, isNotNull, isNull, lt, or, type SQL, sql } from "drizzle-orm";
import { hashData } from "../crypto.js";
import type { Database, Transaction } from "../db/database.js";
import {
    apiClientsTable, authMembersTable, authUsersTable, randomRequestsTable, type ContractDependency, type ContractFlag, paymentFlagsTable, contractFundingTable, contractMoneyLogTable, contractVersionsTable, type FundingAllocation,
    type MoneyFunction, type MoneyLogKind, moneyChangesTable, nodesTable, organizationsTable, runReceiptsTable, runsTable, topUpsTable, type TreeOutcome,
} from "../db/schema.js";
import { OperationError } from "../errors.js";
import { accounts, adjustOrganization, lockOrganizations, type Organization, postLedgerTransaction } from "../ledger.js";
import { clientSpend, monthStart } from "../runs/clients.js";
import type { RunTokenSigner } from "../runs/tokens.js";

export type ContractVersion = typeof contractVersionsTable.$inferSelect;
export type Funding = typeof contractFundingTable.$inferSelect;
export type MoneyChange = typeof moneyChangesTable.$inferSelect;
type Run = typeof runsTable.$inferSelect;

const DAY_MS = 24 * 60 * 60 * 1000;

/** Thrown inside `apply`'s transaction to roll it back and try again. */
class TreeChanged extends Error {}

/** A request script names 1 to this many payees when it attaches money. */
export const MAX_PAYEES = 16;
/** `MAX_CONTRACT_HOLD_DAYS` can't be set above 30 (docs/money.md, Stripe's conditions). */
export const MAX_CONTRACT_HOLD_LIMIT_MS = 30 * DAY_MS;
/** One funder may use at most this share of a node's `maxContractBalanceMicroUsd`, in basis points. */
export const MAX_FUNDER_SHARE_OF_NODE_CAP_BPS = 2_500;

export interface MoneyPolicy {
    /** The platform's share of every `pay`, in basis points, rounded up. */
    platformFeeBps: number;
    /** Money a request script attaches spends only top-up credit charged at most this long ago. */
    maxFundingSourceAgeMs: number;
    /** Funding older than this is refunded to the organization that sent it. At most 30 days. */
    maxContractHoldMs: number;
    /** How long a root run's tree waits for runs on other nodes to settle before dropping their changes. */
    childReceiptDeadlineMs: number;
    /**
     * A tree whose contracts move less than this in total is applied before it's verified, and verified within the
     * payout hold (docs/money.md, When the operator verifies). 0, the default, verifies every tree first.
     */
    optimisticVerifyLimitMicroUsd: number;
    /** The most a node's trees applied before verification may move together. Past it, its trees are verified first. */
    maxUnverifiedMicroUsdPerNode: number;
    /** The most run trees with changes staged on one contract at a time, so slow runs can't tie up its money and scopes. */
    maxPendingMoneyRunsPerContract: number;
    /** The most run trees holding one payer's attached money at a time, so one payer can't use up a contract's. */
    maxPendingMoneyRunsPerPayer: number;
    /**
     * What a payer may attach to contracts in `attachWindowMs`: this much, plus its net top-ups older than the window,
     * so the limit rises with its payment history (docs/money.md, Card fraud).
     */
    attachLimitBaseMicroUsd: number;
    attachWindowMs: number;
    /** Attaching more than this in a calendar month needs the payer's identity verified. */
    payerKycThresholdMicroUsd: number;
}

export const DEFAULT_MONEY_POLICY: Omit<MoneyPolicy, 'platformFeeBps'> = {
    maxFundingSourceAgeMs: 7 * DAY_MS,
    maxContractHoldMs: 14 * DAY_MS,
    childReceiptDeadlineMs: 5 * 60 * 1000,
    optimisticVerifyLimitMicroUsd: 0,
    maxUnverifiedMicroUsdPerNode: 0,
    maxPendingMoneyRunsPerContract: 100,
    maxPendingMoneyRunsPerPayer: 20,
    attachLimitBaseMicroUsd: 100 * 1_000_000,
    attachWindowMs: 30 * DAY_MS,
    payerKycThresholdMicroUsd: 1_000 * 1_000_000,
};

/** Free email providers, whose shared domain says nothing about who an organization is. */
const SHARED_EMAIL_DOMAINS = new Set(['gmail.com', 'googlemail.com', 'outlook.com', 'hotmail.com', 'live.com', 'yahoo.com', 'icloud.com', 'me.com', 'proton.me', 'protonmail.com', 'aol.com', 'gmx.com', 'fastmail.com', 'example.com']);

/** A contract version on the staging node: `path.Name` and its version. */
export interface LocalContractRef {
    name: string;
    version: string;
}

/** A contract version on any node. */
export interface ContractRef extends LocalContractRef {
    nodePublicKey: string;
}

export interface ContractRegistration {
    name: string;
    version: string;
    payable: boolean;
    source: string;
    requestscriptVersion: string;
    dependencies: ContractDependency[];
    /** The run token of the API client that deployed it, whose organization owns it. Without one, the node's organization does. */
    token?: string;
}

export interface AttachParameters {
    to: ContractRef;
    amount: number;
    /** Chosen by the attaching node. The receiving contract's `earmark` names it. */
    attachmentId: string;
    /** Required from a request script; a contract may narrow its funding's payees. */
    payees?: string[];
    /** A contract's funder, whose funding it spends. Required from a contract, refused from a request script. */
    from?: string;
    key?: string | null;
}
export interface EarmarkParameters { attachmentId: string, key: string }
export interface PayParameters { to: string, amount: number, from: string, key?: string | null, try?: boolean }
export interface RefundParameters { to: string, amount: number, key?: string | null }

export type StageRequest = {
    /** The run making the call: a run id as the node authorized or opened it. */
    runId: string;
    /** The call's position in the run. A change is staged at most once per run and call index. */
    callIndex: number;
    /** The contract on the staging node whose account the change spends. Omitted only for money a request script attaches. */
    contract?: LocalContractRef;
} & (
    | { function: 'attach', parameters: AttachParameters }
    | { function: 'earmark', parameters: EarmarkParameters }
    | { function: 'pay', parameters: PayParameters }
    | { function: 'refund', parameters: RefundParameters }
    | { function: 'random_request', parameters: { key: string } }
);

/**
 * attach and earmark return null, pay and refund the funding left under the named funder and key, and a
 * `try` pay whether it paid.
 */
export type StageResult = { result: number | boolean | null };

export type MoneyReadRequest = {
    runId: string;
    callIndex: number;
    contract: LocalContractRef;
} & (
    | { function: 'balance', parameters: Record<string, never> }
    | { function: 'fundingOf', parameters: { org: string, key?: string | null } }
    | { function: 'canReceive', parameters: { org: string } }
    | { function: 'attachment', parameters: { attachmentId: string } }
    | { function: 'random', parameters: { key: string } }
);

/** An answer the operator signs, so a transcript can carry it (docs/money.md, How a node serves Account). */
/** Money attached to a call, as the contract that receives it reads it. */
export interface AttachmentRead {
    amount: number;
    from: string;
    /** The organizations every part of it may be paid to. */
    payees: string[];
}

/** A random value the operator drew for a contract's request, signed over `randomValuePayload`. */
export interface RandomRead {
    value: string;
    signature: string;
}

/** The fields of a drawn random value the operator signs, in order: bound to the contract and its key. */
export function randomValuePayload(draw: { nodePublicKey: string, name: string, version: string, key: string, value: string }) {
    const { nodePublicKey, name, version, key, value } = draw;
    return { nodePublicKey, name, version, key, value };
}

export interface SignedMoneyRead {
    response: number | boolean | AttachmentRead | RandomRead;
    signedAt: string;
    signature: string;
    publicKey: string;
}

/** The signed fields of an `Account` read, in order. Copied wherever a transcript is checked. */
export function moneyReadPayload(read: { runId: string, callIndex: number, function: string, parameters: object, response: unknown, signedAt: string }) {
    const { runId, callIndex, function: fn, parameters, response, signedAt } = read;
    return { runId, callIndex, function: fn, parameters, response, signedAt };
}

/** A contract version as the operator publishes it to buyers. Funders aren't named. */
export interface PublicContract {
    nodePublicKey: string;
    name: string;
    version: string;
    payable: boolean;
    source: string;
    sourceHash: string;
    ownerOrganizationId: string;
    hostOrganizationId: string;
    requestscriptVersion: string;
    dependencies: ContractDependency[];
    balanceMicroUsd: number;
    refundAllAt: Date | null;
    /** What buyers should know from its verified runs. */
    flags: ContractFlag[];
    log: { kind: MoneyLogKind, amountMicroUsd: number, createdAt: Date }[];
}

/** The platform's share of a `pay`, rounded up, so splitting a payment can't avoid it. */
export function payFee(amount: number, platformFeeBps: number): number {
    return Number((BigInt(amount) * BigInt(platformFeeBps) + 9_999n) / 10_000n);
}

const NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)+$/;
const VERSION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
/** Stripe's conditions: a reminder only, since it's easy to get around (docs/money.md). */
const ESCROW_NAME = /escrow|deposit/i;

function amountRefusal(amount: unknown, minimum: number): string | undefined {
    if (typeof amount !== 'number' || !Number.isSafeInteger(amount) || amount < minimum) {
        return `Amounts are whole micro-USD of at least ${minimum}, at most ${Number.MAX_SAFE_INTEGER}`;
    }
    return undefined;
}

function requireAmount(amount: unknown, minimum: number): void {
    const refusal = amountRefusal(amount, minimum);
    if (refusal) throw new OperationError(422, refusal);
}

/** The value with object keys sorted, since jsonb doesn't keep their order. */
function canonical(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(canonical);
    if (value !== null && typeof value === 'object') {
        return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical((value as Record<string, unknown>)[key])]));
    }
    return value;
}

function sameKey(column: typeof contractFundingTable.key, key: string | null | undefined): SQL {
    return key == null ? isNull(column) : eq(column, key);
}

/**
 * Contract accounts (docs/money.md): registration, funding, the changes runs stage on them, and applying or
 * dropping those changes when a run tree settles.
 *
 * Locks are always taken in this order, so concurrent transactions can't deadlock: organizations (in id order),
 * then the root run, then the staging run, then contract versions (in id order), then their funding rows.
 */
export class MoneyService {
    /** Throws unless the node may move money: set from `OrganizationService.requireActiveNode`. */
    activeNode?: (nodePublicKey: string) => Promise<unknown>;
    /** Tells an organization what a safety net did to its funding. Set from `NotificationService.notify`. */
    notify?: (organizationId: string, kind: string, details: Record<string, unknown>) => Promise<void>;

    constructor(
        private readonly db: Database,
        private readonly policy: MoneyPolicy,
        private readonly signer?: RunTokenSigner,
    ) {
        if (policy.maxContractHoldMs > MAX_CONTRACT_HOLD_LIMIT_MS) {
            throw new Error('MAX_CONTRACT_HOLD_DAYS can\'t be more than 30');
        }
    }

    // ---- Registration ----

    /**
     * Registers a contract version the node hosts, with its owner: the organization of the API client whose
     * run token deployed it, or the node's own. Idempotent: registering the same version with the same source
     * and owner again returns it, and anything else is refused (409), since versions never change.
     */
    async register(nodePublicKey: string, registration: ContractRegistration): Promise<ContractVersion> {
        await this.activeNode?.(nodePublicKey);
        const [node] = await this.db.select().from(nodesTable).where(eq(nodesTable.publicKey, nodePublicKey)).limit(1);
        if (!node || node.revokedAt) throw new OperationError(403, 'Node has been revoked');
        if (!NAME_PATTERN.test(registration.name)) throw new OperationError(400, 'A contract\'s name is path.Name');
        if (!VERSION_PATTERN.test(registration.version)) throw new OperationError(400, 'Invalid contract version');
        if (registration.payable && ESCROW_NAME.test(registration.name.slice(registration.name.lastIndexOf('.') + 1))) {
            throw new OperationError(422, 'Payable contracts route payments: they can\'t be named as escrow or deposit accounts');
        }
        for (const dependency of registration.dependencies) {
            if (!NAME_PATTERN.test(dependency.name) || !VERSION_PATTERN.test(dependency.version)) {
                throw new OperationError(400, 'Every dependency is a pinned contract version');
            }
        }
        let owner = node.organizationId;
        if (registration.token !== undefined) {
            if (!this.signer) throw new OperationError(503, 'Run tokens are not configured on this operator');
            owner = (await this.signer.verify(registration.token, nodePublicKey)).organizationId;
        }
        const sourceHash = hashData(registration.source);
        await this.db.insert(contractVersionsTable).values({
            nodePublicKey,
            name: registration.name,
            version: registration.version,
            payable: registration.payable,
            source: registration.source,
            sourceHash,
            ownerOrganizationId: owner,
            requestscriptVersion: registration.requestscriptVersion,
            dependencies: registration.dependencies.map(({ nodePublicKey, name, version }) => ({ nodePublicKey, name, version })),
        }).onConflictDoNothing();
        const contract = (await this.find(this.db, { nodePublicKey, name: registration.name, version: registration.version }))!;
        if (contract.sourceHash !== sourceHash || contract.ownerOrganizationId !== owner || contract.payable !== registration.payable) {
            throw new OperationError(409, `${registration.name}@${registration.version} is already registered with different source or owner`);
        }
        return contract;
    }

    private async find(db: Database | Transaction, ref: ContractRef): Promise<ContractVersion | undefined> {
        const [contract] = await db.select().from(contractVersionsTable).where(and(
            eq(contractVersionsTable.nodePublicKey, ref.nodePublicKey),
            eq(contractVersionsTable.name, ref.name),
            eq(contractVersionsTable.version, ref.version),
        )).limit(1);
        return contract;
    }

    /** A registered contract version, its balance and its money log, without naming funders. */
    async publicContract(ref: ContractRef): Promise<PublicContract | undefined> {
        const [row] = await this.db.select({ contract: contractVersionsTable, hostOrganizationId: nodesTable.organizationId })
            .from(contractVersionsTable)
            .innerJoin(nodesTable, eq(nodesTable.publicKey, contractVersionsTable.nodePublicKey))
            .where(and(
                eq(contractVersionsTable.nodePublicKey, ref.nodePublicKey),
                eq(contractVersionsTable.name, ref.name),
                eq(contractVersionsTable.version, ref.version),
            )).limit(1);
        if (!row) return undefined;
        const { contract } = row;
        const log = await this.db.select({ kind: contractMoneyLogTable.kind, amountMicroUsd: contractMoneyLogTable.amountMicroUsd, createdAt: contractMoneyLogTable.createdAt })
            .from(contractMoneyLogTable).where(eq(contractMoneyLogTable.contractId, contract.id)).orderBy(asc(contractMoneyLogTable.id));
        return {
            nodePublicKey: contract.nodePublicKey,
            name: contract.name,
            version: contract.version,
            payable: contract.payable,
            source: contract.source,
            sourceHash: contract.sourceHash,
            ownerOrganizationId: contract.ownerOrganizationId,
            hostOrganizationId: row.hostOrganizationId,
            requestscriptVersion: contract.requestscriptVersion,
            dependencies: contract.dependencies,
            balanceMicroUsd: contract.balanceMicroUsd,
            refundAllAt: contract.refundAllAt,
            flags: contract.flags,
            log,
        };
    }

    /** The contract versions the organization owns, newest first. */
    async ownedContracts(organizationId: string): Promise<Omit<ContractVersion, 'source'>[]> {
        const { source: _, ...columns } = getTableColumns(contractVersionsTable);
        return this.db.select(columns).from(contractVersionsTable)
            .where(eq(contractVersionsTable.ownerOrganizationId, organizationId))
            .orderBy(desc(contractVersionsTable.id));
    }

    /** The contract's money log. Its owner sees every entry; any other organization the entries that involve it. */
    async moneyLog(organizationId: string, contractId: number) {
        const [contract] = await this.db.select().from(contractVersionsTable).where(eq(contractVersionsTable.id, contractId)).limit(1);
        if (!contract) throw new OperationError(404, 'Contract not found');
        const involved = or(
            eq(contractMoneyLogTable.funderOrganizationId, organizationId),
            eq(contractMoneyLogTable.counterpartyOrganizationId, organizationId),
        );
        return this.db.select().from(contractMoneyLogTable).where(contract.ownerOrganizationId === organizationId
            ? eq(contractMoneyLogTable.contractId, contractId)
            : and(eq(contractMoneyLogTable.contractId, contractId), involved))
            .orderBy(asc(contractMoneyLogTable.id));
    }

    // ---- Staging ----

    /**
     * Stages one money change on a run (docs/money.md, How a node serves Account). Nothing moves until the run's
     * tree is applied. Refuses (422) a change the funding, its payees or the limits don't allow, which fails the
     * run. Idempotent per run and call index.
     */
    async stage(nodePublicKey: string, request: StageRequest): Promise<StageResult> {
        await this.activeNode?.(nodePublicKey);
        const run = await this.stagingRun(this.db, nodePublicKey, request.runId);
        const existing = await this.existingChange(run, request);
        if (existing) return existing;
        this.validate(request);

        // Organizations are locked before runs and contracts. Only money a request script attaches touches one.
        const lockOrgs = request.function === 'attach' && !request.contract ? [run.payerOrganizationId] : [];
        try {
            return await this.db.transaction(async (tx) => {
                const organizations = await lockOrganizations(tx, lockOrgs);
                const { root, run: locked } = await this.lockTree(tx, run);
                const again = await this.existingChange(locked, request, tx);
                if (again) return again;
                switch (request.function) {
                    case 'attach': return request.contract
                        ? this.stageContractAttach(tx, root, locked, request.callIndex, request.contract, request.parameters)
                        : this.stageScriptAttach(tx, root, locked, request.callIndex, request.parameters, organizations.get(run.payerOrganizationId)!);
                    case 'earmark': return this.stageEarmark(tx, root, locked, request.callIndex, request.contract!, request.parameters);
                    case 'pay': return this.stagePay(tx, root, locked, request.callIndex, request.contract!, request.parameters);
                    case 'refund': return this.stageRefund(tx, root, locked, request.callIndex, request.contract!, request.parameters);
                    case 'random_request': return this.stageRandomRequest(tx, root, locked, request.callIndex, request.contract!, request.parameters);
                }
            });
        } catch (error) {
            // A concurrent retry of the same call staged it first.
            const pgError = error as { code?: unknown; cause?: { code?: unknown } };
            if (pgError?.code === '23505' || pgError?.cause?.code === '23505') {
                const raced = await this.existingChange(run, request);
                if (raced) return raced;
            }
            throw error;
        }
    }

    /** The run a node stages on or reads for. Throws unless it is the node's. */
    private async stagingRun(db: Database | Transaction, nodePublicKey: string, runId: string): Promise<Run> {
        const [run] = await db.select().from(runsTable).where(eq(runsTable.runId, runId)).limit(1);
        if (!run) throw new OperationError(404, 'Run was never authorized');
        if (run.nodePublicKey !== nodePublicKey) throw new OperationError(403, 'Only the node running a run can stage changes on it');
        return run;
    }

    /** The result of the same call staged before, or undefined. Throws 409 for a different call with its index. */
    private async existingChange(run: Run, request: StageRequest, db: Database | Transaction = this.db): Promise<StageResult | undefined> {
        const [change] = await db.select().from(moneyChangesTable)
            .where(and(eq(moneyChangesTable.runId, run.id), eq(moneyChangesTable.callIndex, request.callIndex))).limit(1);
        if (!change) return undefined;
        if (hashData(canonical(change.parameters)) !== hashData(canonical(this.recorded(request)))) {
            throw new OperationError(409, `Call ${request.callIndex} of this run staged a different change`);
        }
        return { result: change.result as StageResult['result'] };
    }

    private recorded(request: StageRequest): object {
        return { function: request.function, contract: request.contract ?? null, parameters: request.parameters };
    }

    private validate(request: StageRequest): void {
        if (!Number.isSafeInteger(request.callIndex) || request.callIndex < 0) throw new OperationError(400, 'Invalid call index');
        if (request.function !== 'attach' && !request.contract) throw new OperationError(400, `${request.function} needs the contract whose account it changes`);
        const p = request.parameters as unknown as Record<string, unknown>;
        switch (request.function) {
            case 'attach': requireAmount(p.amount, 1); break;
            case 'earmark':
                if (typeof p.key !== 'string' || p.key.length === 0) throw new OperationError(422, 'An earmark needs a key');
                break;
            case 'pay': case 'refund': requireAmount(p.amount, 1); break;
            case 'random_request':
                if (typeof p.key !== 'string' || p.key.length === 0 || p.key.length > 255) throw new OperationError(422, 'A random request needs a key');
                break;
        }
    }

    /**
     * Locks the run's root, then the run, and checks the tree still takes changes: the root hasn't settled and
     * the run is still held.
     */
    private async lockTree(tx: Transaction, run: Run): Promise<{ root: Run, run: Run }> {
        const rootId = run.rootRunId ?? run.id;
        const [root] = await tx.select().from(runsTable).where(eq(runsTable.id, rootId)).for('update');
        const [locked] = rootId === run.id ? [root] : await tx.select().from(runsTable).where(eq(runsTable.id, run.id)).for('update');
        if (root!.treeOutcome !== null) throw new OperationError(409, 'The run\'s tree has already settled');
        if (locked!.status !== 'held') throw new OperationError(409, 'The run has already settled');
        return { root: root!, run: locked! };
    }

    private async lockContracts(tx: Transaction, ids: number[]): Promise<Map<number, ContractVersion>> {
        if (ids.length === 0) return new Map();
        const rows = await tx.select().from(contractVersionsTable)
            .where(inArray(contractVersionsTable.id, [...new Set(ids)]))
            .orderBy(contractVersionsTable.id)
            .for('update');
        return new Map(rows.map(row => [row.id, row]));
    }

    /** A contract the staging node hosts. */
    private async hosted(tx: Transaction, nodePublicKey: string, ref: LocalContractRef): Promise<ContractVersion> {
        const contract = await this.find(tx, { nodePublicKey, ...ref });
        if (!contract) throw new OperationError(404, `${ref.name}@${ref.version} isn't registered for this node`);
        return contract;
    }

    /** A contract that can receive money attached to a call. */
    private async receiver(tx: Transaction, ref: ContractRef): Promise<ContractVersion> {
        const contract = await this.find(tx, ref);
        if (!contract) throw new OperationError(404, `${ref.name}@${ref.version} isn't registered`);
        if (!contract.payable) throw new OperationError(422, `${ref.name}@${ref.version} isn't payable`);
        if (contract.refundAllAt) throw new OperationError(422, `${ref.name}@${ref.version} was refunded by its owner and refuses money`);
        return contract;
    }

    private validPayees(payees: unknown): payees is string[] {
        return Array.isArray(payees) && payees.length >= 1 && payees.length <= MAX_PAYEES
            && payees.every(payee => typeof payee === 'string' && payee.length > 0 && payee.length <= 64)
            && new Set(payees).size === payees.length;
    }

    /** Money a request script attaches, from its run's organization's balance, held until the tree settles. */
    private async stageScriptAttach(tx: Transaction, root: Run, run: Run, callIndex: number, p: AttachParameters, payer: Organization): Promise<StageResult> {
        if (run.rootRunId !== null || (run.kind !== 'script' && run.kind !== 'free')) {
            throw new OperationError(422, 'Only a request script\'s run attaches money from its organization: a contract names the funding it spends');
        }
        if (p.from !== undefined || p.key != null) throw new OperationError(422, 'A request script\'s money comes from its run\'s organization');
        if (!this.validPayees(p.payees)) throw new OperationError(422, `Money a request script attaches names 1 to ${MAX_PAYEES} distinct payees`);
        if (payer.frozenAt || payer.bannedAt) throw new OperationError(403, 'Payer organization is frozen or banned');
        if (payer.sanctionsBlockedAt || payer.closedAt) throw new OperationError(403, 'Payer organization can\'t pay: it is blocked or closed');
        await this.checkRunValueLimits(tx, run, p.amount);
        await this.checkPayerLimits(tx, root, payer, p.amount);
        const fresh = await this.freshCredit(tx, payer);
        if (fresh.amountMicroUsd < p.amount) {
            throw new OperationError(402, `Money attached to a contract spends only credit topped up in the last ${Math.round(this.policy.maxFundingSourceAgeMs / DAY_MS)} days, and only ${fresh.amountMicroUsd} micro-USD is available`);
        }
        const contracts = await this.lockContracts(tx, [(await this.receiver(tx, p.to)).id]);
        const to = [...contracts.values()][0]!;
        await this.checkPendingRuns(tx, root, to.id);
        await this.checkNodeCap(tx, to, payer.id, p.amount);
        await this.requireNewAttachment(tx, p.attachmentId);

        const [funding] = await tx.insert(contractFundingTable).values({
            contractId: to.id,
            funderOrganizationId: payer.id,
            payees: p.payees,
            status: 'staged',
            rootRunId: root.id,
            attachmentId: p.attachmentId,
            amountMicroUsd: p.amount,
            fundedAt: new Date(),
            chargedAt: fresh.chargedAt,
        }).returning({ id: contractFundingTable.id });
        await adjustOrganization(tx, payer.id, { held: p.amount });
        return this.record(tx, root, run, callIndex, { function: 'attach', parameters: p }, {
            payerOrganizationId: payer.id, amountMicroUsd: p.amount, fundingIds: [funding!.id], result: null,
        });
    }

    /** Money a contract attaches to a call, from one funder's funding under one key, keeping its payees or fewer. */
    private async stageContractAttach(tx: Transaction, root: Run, run: Run, callIndex: number, ref: LocalContractRef, p: AttachParameters): Promise<StageResult> {
        if (typeof p.from !== 'string') throw new OperationError(422, 'A contract names whose funding it attaches');
        if (p.payees !== undefined && !this.validPayees(p.payees)) throw new OperationError(422, `Payees are 1 to ${MAX_PAYEES} distinct organizations`);
        const sender = await this.hosted(tx, run.nodePublicKey, ref);
        const receiver = await this.receiver(tx, p.to);
        if (sender.id === receiver.id) throw new OperationError(422, 'A contract can\'t attach money to a call to itself');
        const contracts = await this.lockContracts(tx, [sender.id, receiver.id]);
        await this.checkPendingRuns(tx, root, receiver.id);
        await this.checkNodeCap(tx, contracts.get(receiver.id)!, p.from, p.amount);
        await this.requireNewAttachment(tx, p.attachmentId);

        const narrowed = p.payees;
        const allocations = await this.allocate(tx, root, sender.id, p.from, p.key ?? null, p.amount,
            narrowed ? (lot) => narrowed.every(payee => lot.payees.includes(payee)) : () => true,
            narrowed ? 'Payees can only narrow the funding\'s own' : undefined);
        const lots = await this.fundingRows(tx, allocations.map(a => a.fundingId));
        const fundingIds: number[] = [];
        for (const allocation of allocations) {
            const lot = lots.get(allocation.fundingId)!;
            const [created] = await tx.insert(contractFundingTable).values({
                contractId: receiver.id,
                funderOrganizationId: lot.funderOrganizationId,
                payees: narrowed ?? lot.payees,
                status: 'staged',
                rootRunId: root.id,
                attachmentId: p.attachmentId,
                amountMicroUsd: allocation.amountMicroUsd,
                sourceFundingId: lot.id,
                // The clock starts once: passing money on never resets it.
                fundedAt: lot.fundedAt,
                chargedAt: lot.chargedAt,
            }).returning({ id: contractFundingTable.id });
            fundingIds.push(created!.id);
        }
        return this.record(tx, root, run, callIndex, { function: 'attach', contract: ref, parameters: p }, {
            contractId: sender.id, amountMicroUsd: p.amount, allocations, fundingIds, result: null,
        });
    }

    /**
     * Refuses (429) a change to a contract that already has `maxPendingMoneyRunsPerContract` other unsettled trees
     * staging on it.
     */
    private async checkPendingRuns(tx: Transaction, root: Run, contractId: number): Promise<void> {
        const roots = await tx.selectDistinct({ rootRunId: contractFundingTable.rootRunId }).from(contractFundingTable).where(and(
            eq(contractFundingTable.contractId, contractId), eq(contractFundingTable.status, 'staged'),
        ));
        const changing = await tx.selectDistinct({ rootRunId: moneyChangesTable.rootRunId }).from(moneyChangesTable).where(and(
            eq(moneyChangesTable.contractId, contractId), eq(moneyChangesTable.status, 'staged'),
        ));
        const others = new Set([...roots.map(row => row.rootRunId), ...changing.map(row => row.rootRunId)].filter(id => id !== null && id !== root.id));
        if (others.size >= this.policy.maxPendingMoneyRunsPerContract) {
            throw new OperationError(429, `The contract has ${others.size} runs whose money hasn't settled; try again shortly`);
        }
    }

    /**
     * Refuses (402, or 429 for too many pending runs) money a payer attaches beyond what it may: its pending runs,
     * its rolling attach limit, which grows with its payment history, and, without a verified identity, its monthly
     * threshold (docs/money.md, Card fraud).
     */
    private async checkPayerLimits(tx: Transaction, root: Run, payer: Organization, amount: number): Promise<void> {
        const attached = (since: Date) => tx.select({ total: sql<string>`coalesce(sum(${moneyChangesTable.amountMicroUsd}), 0)` }).from(moneyChangesTable).where(and(
            eq(moneyChangesTable.payerOrganizationId, payer.id), eq(moneyChangesTable.function, 'attach'),
            inArray(moneyChangesTable.status, ['staged', 'applied']), gte(moneyChangesTable.createdAt, since),
        )).then(([row]) => Number(row!.total));
        const pending = await tx.selectDistinct({ rootRunId: moneyChangesTable.rootRunId }).from(moneyChangesTable).where(and(
            eq(moneyChangesTable.payerOrganizationId, payer.id), eq(moneyChangesTable.status, 'staged'),
        ));
        if (pending.filter(row => row.rootRunId !== root.id).length >= this.policy.maxPendingMoneyRunsPerPayer) {
            throw new OperationError(429, 'The organization has too many runs whose money hasn\'t settled; try again shortly');
        }
        const windowStart = new Date(Date.now() - this.policy.attachWindowMs);
        const [history] = await tx.select({ total: sql<string>`coalesce(sum(${topUpsTable.amountMicroUsd} - ${topUpsTable.refundedMicroUsd} - ${topUpsTable.disputedMicroUsd}), 0)` })
            .from(topUpsTable).where(and(eq(topUpsTable.organizationId, payer.id), eq(topUpsTable.status, 'succeeded'), lt(topUpsTable.createdAt, windowStart)));
        const limit = this.policy.attachLimitBaseMicroUsd + Math.max(0, Number(history!.total));
        if (await attached(windowStart) + amount > limit) {
            throw new OperationError(402, `The organization may attach at most ${limit} micro-USD to contracts in ${Math.round(this.policy.attachWindowMs / DAY_MS)} days; it rises with its payment history`);
        }
        if (!payer.identityVerifiedAt && await attached(monthStart()) + amount > this.policy.payerKycThresholdMicroUsd) {
            throw new OperationError(402, `Attaching more than ${this.policy.payerKycThresholdMicroUsd} micro-USD a month needs the organization's identity verified; contact support`);
        }
    }

    /**
     * Flags payments from a tree where a funder and its payee share a dashboard user or an owner's email domain, which
     * holds payouts to the payee until staff clear them (docs/money.md, Card fraud).
     */
    private async flagLinkedPayments(rootId: number): Promise<void> {
        const pays = await this.db.select().from(moneyChangesTable).where(and(
            eq(moneyChangesTable.rootRunId, rootId), eq(moneyChangesTable.function, 'pay'), eq(moneyChangesTable.status, 'applied'),
        ));
        for (const pay of pays.filter(change => change.amountMicroUsd > 0)) {
            const lots = await this.fundingRows(this.db, pay.allocations.map(a => a.fundingId));
            for (const funder of new Set([...lots.values()].map(lot => lot.funderOrganizationId))) {
                if (funder === pay.recipientOrganizationId) continue;
                const reason = await this.linkBetween(funder, pay.recipientOrganizationId!);
                if (reason) {
                    await this.db.insert(paymentFlagsTable).values({ payeeOrganizationId: pay.recipientOrganizationId!, funderOrganizationId: funder, rootRunId: rootId, reason });
                }
            }
        }
    }

    /** What links two organizations' people, if anything. */
    private async linkBetween(a: string, b: string): Promise<string | undefined> {
        const people = async (organizationId: string) => {
            const [organization] = await this.db.select().from(organizationsTable).where(eq(organizationsTable.id, organizationId)).limit(1);
            if (!organization?.authOrganizationId) return [];
            return this.db.select({ userId: authMembersTable.userId, role: authMembersTable.role, email: authUsersTable.email }).from(authMembersTable)
                .innerJoin(authUsersTable, eq(authUsersTable.id, authMembersTable.userId))
                .where(eq(authMembersTable.organizationId, organization.authOrganizationId));
        };
        const [first, second] = await Promise.all([people(a), people(b)]);
        const shared = first.find(person => second.some(other => other.userId === person.userId));
        if (shared) return `They share a member, ${shared.email}`;
        const domain = (email: string) => email.slice(email.lastIndexOf('@') + 1).toLowerCase();
        const ownerDomains = (members: typeof first) => new Set(members.filter(member => member.role.includes('owner')).map(member => domain(member.email)).filter(d => !SHARED_EMAIL_DOMAINS.has(d)));
        const common = [...ownerDomains(first)].find(d => ownerDomains(second).has(d));
        return common ? `Their owners share the email domain ${common}` : undefined;
    }

    private async requireNewAttachment(tx: Transaction, attachmentId: string): Promise<void> {
        const [used] = await tx.select({ id: contractFundingTable.id }).from(contractFundingTable).where(eq(contractFundingTable.attachmentId, attachmentId)).limit(1);
        if (used) throw new OperationError(409, 'The attachment id has already been used');
    }

    private async stageEarmark(tx: Transaction, root: Run, run: Run, callIndex: number, ref: LocalContractRef, p: EarmarkParameters): Promise<StageResult> {
        const contract = await this.hosted(tx, run.nodePublicKey, ref);
        await this.lockContracts(tx, [contract.id]);
        const lots = await tx.select().from(contractFundingTable).where(and(
            eq(contractFundingTable.contractId, contract.id),
            eq(contractFundingTable.attachmentId, p.attachmentId),
            eq(contractFundingTable.rootRunId, root.id),
            eq(contractFundingTable.status, 'staged'),
        )).for('update');
        if (lots.length === 0) throw new OperationError(422, 'Nothing was attached to this call');
        if (lots.some(lot => lot.key !== null)) throw new OperationError(422, 'The money attached to a call is earmarked at most once');
        if (lots.some(lot => lot.lockedMicroUsd > 0)) throw new OperationError(422, 'Earmark the money attached to a call before spending it');
        await tx.update(contractFundingTable).set({ key: p.key }).where(inArray(contractFundingTable.id, lots.map(lot => lot.id)));
        return this.record(tx, root, run, callIndex, { function: 'earmark', contract: ref, parameters: p }, { contractId: contract.id, result: null });
    }

    private async stagePay(tx: Transaction, root: Run, run: Run, callIndex: number, ref: LocalContractRef, p: PayParameters): Promise<StageResult> {
        if (typeof p.to !== 'string' || typeof p.from !== 'string') throw new OperationError(422, 'pay names a payee and whose funding it spends');
        const contract = await this.hosted(tx, run.nodePublicKey, ref);
        const recorded = { function: 'pay' as const, contract: ref, parameters: p };
        if (!await this.canReceive(tx, p.to)) {
            if (p.try) return this.record(tx, root, run, callIndex, recorded, { contractId: contract.id, recipientOrganizationId: null, result: false });
            throw new OperationError(422, `Organization ${p.to} can't receive payouts`);
        }
        await this.lockContracts(tx, [contract.id]);
        const key = p.key ?? null;
        const allocations = await this.allocate(tx, root, contract.id, p.from, key, p.amount, (lot) => lot.payees.includes(p.to), `${p.to} isn't one of the funding's payees`);
        const remaining = await this.available(tx, root, contract.id, { funder: p.from, key });
        return this.record(tx, root, run, callIndex, recorded, {
            contractId: contract.id, recipientOrganizationId: p.to, amountMicroUsd: p.amount, allocations, result: p.try ? true : remaining,
        });
    }

    private async stageRefund(tx: Transaction, root: Run, run: Run, callIndex: number, ref: LocalContractRef, p: RefundParameters): Promise<StageResult> {
        if (typeof p.to !== 'string') throw new OperationError(422, 'refund names whose funding it returns');
        const contract = await this.hosted(tx, run.nodePublicKey, ref);
        await this.lockContracts(tx, [contract.id]);
        const key = p.key ?? null;
        // Refunds ignore payees: money can always go back to its funder.
        const allocations = await this.allocate(tx, root, contract.id, p.to, key, p.amount, () => true);
        const remaining = await this.available(tx, root, contract.id, { funder: p.to, key });
        return this.record(tx, root, run, callIndex, { function: 'refund', contract: ref, parameters: p }, {
            contractId: contract.id, recipientOrganizationId: p.to, amountMicroUsd: p.amount, allocations, result: remaining,
        });
    }

    /**
     * Stages a contract's request for a random value under a key (docs/money.md, Time and randomness). The value is
     * drawn only once the request's tree applies, so nobody can retry the run until they like it. Each key is
     * requested once, ever.
     */
    private async stageRandomRequest(tx: Transaction, root: Run, run: Run, callIndex: number, ref: LocalContractRef, p: { key: string }): Promise<StageResult> {
        const contract = await this.hosted(tx, run.nodePublicKey, ref);
        await this.lockContracts(tx, [contract.id]);
        const [existing] = await tx.select().from(randomRequestsTable).where(and(
            eq(randomRequestsTable.contractId, contract.id), eq(randomRequestsTable.key, p.key), inArray(randomRequestsTable.status, ['staged', 'requested']),
        )).limit(1);
        if (existing) throw new OperationError(409, `A random value under ${p.key} was already requested`);
        await tx.insert(randomRequestsTable).values({ contractId: contract.id, key: p.key, rootRunId: root.id });
        return this.record(tx, root, run, callIndex, { function: 'random_request', contract: ref, parameters: p }, { contractId: contract.id, result: null });
    }

    /** The value drawn for a contract's request under `key`, or a refusal (404) until it's drawn. */
    private async randomValue(contract: ContractVersion, key: string): Promise<RandomRead> {
        const [request] = await this.db.select().from(randomRequestsTable).where(and(
            eq(randomRequestsTable.contractId, contract.id), eq(randomRequestsTable.key, key), eq(randomRequestsTable.status, 'requested'),
        )).limit(1);
        if (!request?.value || !request.signature) throw new OperationError(404, `No random value under ${key} has been drawn yet`);
        return { value: request.value, signature: request.signature };
    }

    /** Draws the values for a tree's applied requests, signed and bound to their contract and key. */
    private async drawRandom(tx: Transaction, change: MoneyChange): Promise<void> {
        const key = (change.parameters as { parameters: { key: string } }).parameters.key;
        const [contract] = await tx.select().from(contractVersionsTable).where(eq(contractVersionsTable.id, change.contractId!)).limit(1);
        const value = randomBytes(32).toString('base64url');
        const signature = this.signer?.signPayload(randomValuePayload({ nodePublicKey: contract!.nodePublicKey, name: contract!.name, version: contract!.version, key, value })) ?? '';
        await tx.update(randomRequestsTable).set({ status: 'requested', value, signature, drawnAt: new Date() }).where(and(
            eq(randomRequestsTable.contractId, change.contractId!), eq(randomRequestsTable.key, key), eq(randomRequestsTable.status, 'staged'),
        ));
    }

    private async record(
        tx: Transaction, root: Run, run: Run, callIndex: number,
        request: { function: MoneyFunction, contract?: LocalContractRef, parameters: object },
        change: Partial<Pick<MoneyChange, 'contractId' | 'payerOrganizationId' | 'recipientOrganizationId' | 'amountMicroUsd' | 'allocations' | 'fundingIds'>> & { result: StageResult['result'] },
    ): Promise<StageResult> {
        await tx.insert(moneyChangesTable).values({
            runId: run.id,
            rootRunId: root.id,
            callIndex,
            function: request.function,
            parameters: this.recorded(request as StageRequest),
            ...change,
        });
        return { result: change.result };
    }

    /**
     * Locks `amount` of one funder's funding under one key in the contract, oldest first, from the funding the
     * tree can see: active, or staged by the same tree. Throws 422 when there isn't enough.
     */
    private async allocate(
        tx: Transaction, root: Run, contractId: number, funder: string, key: string | null, amount: number,
        eligible: (lot: Funding) => boolean, ineligible?: string,
    ): Promise<FundingAllocation[]> {
        const lots = await tx.select().from(contractFundingTable).where(and(
            eq(contractFundingTable.contractId, contractId),
            eq(contractFundingTable.funderOrganizationId, funder),
            sameKey(contractFundingTable.key, key),
            this.visible(root),
        )).orderBy(asc(contractFundingTable.fundedAt), asc(contractFundingTable.id)).for('update');
        const usable = lots.filter(eligible);
        if (usable.length === 0 && lots.length > 0 && ineligible) throw new OperationError(422, ineligible);
        const allocations: FundingAllocation[] = [];
        let left = amount;
        for (const lot of usable) {
            if (left === 0) break;
            const take = Math.min(left, lot.amountMicroUsd - lot.lockedMicroUsd);
            if (take <= 0) continue;
            allocations.push({ fundingId: lot.id, amountMicroUsd: take });
            left -= take;
        }
        if (left > 0) {
            throw new OperationError(422, `${funder}'s funding${key === null ? '' : ` under ${key}`} is ${amount - left} micro-USD, less than ${amount}`);
        }
        for (const allocation of allocations) {
            await tx.update(contractFundingTable)
                .set({ lockedMicroUsd: sql`${contractFundingTable.lockedMicroUsd} + ${allocation.amountMicroUsd}` })
                .where(eq(contractFundingTable.id, allocation.fundingId));
        }
        return allocations;
    }

    /** Funding a tree can see: active, or staged by the tree itself. */
    private visible(root: Run): SQL {
        return or(
            eq(contractFundingTable.status, 'active'),
            and(eq(contractFundingTable.status, 'staged'), eq(contractFundingTable.rootRunId, root.id)),
        )!;
    }

    /** What the tree can still spend of the contract's funding, all of it or one funder's under one key. */
    private async available(db: Database | Transaction, root: Run, contractId: number, of?: { funder: string, key: string | null }): Promise<number> {
        const [row] = await db.select({ total: sql<string>`coalesce(sum(${contractFundingTable.amountMicroUsd} - ${contractFundingTable.lockedMicroUsd}), 0)` })
            .from(contractFundingTable)
            .where(and(
                eq(contractFundingTable.contractId, contractId),
                this.visible(root),
                ...(of ? [eq(contractFundingTable.funderOrganizationId, of.funder), sameKey(contractFundingTable.key, of.key)] : []),
            ));
        return Number(row!.total);
    }

    private async fundingRows(db: Database | Transaction, ids: number[]): Promise<Map<number, Funding>> {
        if (ids.length === 0) return new Map();
        const rows = await db.select().from(contractFundingTable).where(inArray(contractFundingTable.id, ids));
        return new Map(rows.map(row => [row.id, row]));
    }

    /** Whether the organization can be paid now: it can receive payouts and isn't frozen. */
    private async canReceive(db: Database | Transaction, organizationId: string): Promise<boolean> {
        const [organization] = await db.select().from(organizationsTable).where(eq(organizationsTable.id, organizationId)).limit(1);
        return organization !== undefined && organization.payoutsEnabled && organization.frozenAt === null && organization.bannedAt === null
            && organization.sanctionsBlockedAt === null && organization.closedAt === null;
    }

    /**
     * The part of the organization's balance it may attach to a contract call: top-up credit charged within
     * `maxFundingSourceAgeMs`, assuming spending used promotional credit and then the oldest top-ups first (as the
     * idle-balance warning does), less what staged attachments already hold, and no more than its available
     * balance. Also returns the oldest such charge.
     */
    async freshCredit(db: Database | Transaction, organization: Organization, now: Date = new Date()): Promise<{ amountMicroUsd: number, chargedAt: Date | null }> {
        const cutoff = now.getTime() - this.policy.maxFundingSourceAgeMs;
        const topUps = await db.select().from(topUpsTable)
            .where(and(eq(topUpsTable.organizationId, organization.id), eq(topUpsTable.status, 'succeeded')))
            .orderBy(desc(topUpsTable.createdAt), desc(topUpsTable.id));
        // What is left of the balance sits in the newest top-ups.
        let left = Math.max(0, organization.balanceMicroUsd);
        let fresh = 0;
        let chargedAt: Date | null = null;
        for (const topUp of topUps) {
            if (left === 0) break;
            const remaining = Math.min(left, topUp.amountMicroUsd - topUp.refundedMicroUsd - topUp.disputedMicroUsd);
            if (remaining <= 0) continue;
            left -= remaining;
            if (topUp.createdAt.getTime() < cutoff) break;
            fresh += remaining;
            chargedAt = topUp.createdAt;
        }
        const [staged] = await db.select({ total: sql<string>`coalesce(sum(${moneyChangesTable.amountMicroUsd}), 0)` }).from(moneyChangesTable).where(and(
            eq(moneyChangesTable.payerOrganizationId, organization.id),
            eq(moneyChangesTable.function, 'attach'),
            eq(moneyChangesTable.status, 'staged'),
        ));
        fresh -= Number(staged!.total);
        return { amountMicroUsd: Math.max(0, Math.min(fresh, organization.balanceMicroUsd - organization.heldMicroUsd)), chargedAt };
    }

    /**
     * Refuses (402) money a request script attaches beyond its limits: the API client's `maxRunValueMicroUsd`
     * for a run token's run, whose monthly cap counts attached money with run costs, or the node's API-key
     * limits for a free run.
     */
    private async checkRunValueLimits(tx: Transaction, run: Run, amount: number): Promise<void> {
        const attachedInRun = await this.attachedSince(tx, eq(moneyChangesTable.runId, run.id));
        if (run.kind === 'script') {
            const [client] = await tx.select().from(apiClientsTable).where(eq(apiClientsTable.id, run.clientId!)).limit(1);
            if (attachedInRun + amount > client!.maxRunValueMicroUsd) {
                throw new OperationError(402, `The API client may attach at most ${client!.maxRunValueMicroUsd} micro-USD per run`);
            }
            if (client!.monthlyCapMicroUsd !== null) {
                // The run's own hold and the money its runs attached already count toward the cap.
                if (await clientSpend(tx, client!.id, monthStart()) + amount > client!.monthlyCapMicroUsd) {
                    throw new OperationError(402, 'The API client has reached its monthly cap');
                }
            }
            return;
        }
        const [node] = await tx.select().from(nodesTable).where(eq(nodesTable.publicKey, run.nodePublicKey)).limit(1);
        if (attachedInRun + amount > node!.maxApiKeyRunValueMicroUsd) {
            throw new OperationError(402, `The node's API-key runs may attach at most ${node!.maxApiKeyRunValueMicroUsd} micro-USD per run`);
        }
        const thisMonth = await this.attachedSince(tx, and(
            eq(runsTable.nodePublicKey, run.nodePublicKey),
            eq(runsTable.kind, 'free'),
            gte(runsTable.createdAt, monthStart()),
        )!);
        if (thisMonth + amount > node!.monthlyApiKeyValueCapMicroUsd) {
            throw new OperationError(402, 'The node\'s API-key runs have reached their monthly limit for attached money');
        }
    }

    /** Money request scripts attached in the runs matching `where`, staged or applied. */
    private async attachedSince(tx: Transaction, where: SQL): Promise<number> {
        const [row] = await tx.select({ total: sql<string>`coalesce(sum(${moneyChangesTable.amountMicroUsd}), 0)` })
            .from(moneyChangesTable)
            .innerJoin(runsTable, eq(runsTable.id, moneyChangesTable.runId))
            .where(and(
                where,
                eq(moneyChangesTable.function, 'attach'),
                isNotNull(moneyChangesTable.payerOrganizationId),
                inArray(moneyChangesTable.status, ['staged', 'applied']),
            ));
        return Number(row!.total);
    }

    /**
     * Refuses (402) money that would take the receiving contract's host past its `maxContractBalanceMicroUsd`, or
     * one funder past its share of it. Staged funding counts, and money moving between two contracts on the same
     * node counts twice until it settles, so the cap is never overstated.
     */
    private async checkNodeCap(tx: Transaction, receiver: ContractVersion, funder: string, amount: number): Promise<void> {
        const [node] = await tx.select().from(nodesTable).where(eq(nodesTable.publicKey, receiver.nodePublicKey)).limit(1);
        const cap = node!.maxContractBalanceMicroUsd;
        const [held] = await tx.select({
            total: sql<string>`coalesce(sum(${contractFundingTable.amountMicroUsd}), 0)`,
            funder: sql<string>`coalesce(sum(case when ${contractFundingTable.funderOrganizationId} = ${funder} then ${contractFundingTable.amountMicroUsd} else 0 end), 0)`,
        }).from(contractFundingTable)
            .innerJoin(contractVersionsTable, eq(contractVersionsTable.id, contractFundingTable.contractId))
            .where(and(eq(contractVersionsTable.nodePublicKey, receiver.nodePublicKey), inArray(contractFundingTable.status, ['staged', 'active'])));
        if (Number(held!.total) + amount > cap) {
            throw new OperationError(402, `The contract's node can hold at most ${cap} micro-USD in contracts`);
        }
        if (Number(held!.funder) + amount > Math.floor(cap * MAX_FUNDER_SHARE_OF_NODE_CAP_BPS / 10_000)) {
            throw new OperationError(402, 'One organization\'s funding can use at most a quarter of a node\'s contract balance limit');
        }
    }

    // ---- Reads ----

    /**
     * Answers `balance`, `fundingOf` or `canReceive` for a contract the node hosts, with the run's tree's staged
     * changes applied, signed by the operator so a transcript can carry it.
     */
    async read(nodePublicKey: string, request: MoneyReadRequest): Promise<SignedMoneyRead> {
        await this.activeNode?.(nodePublicKey);
        if (!this.signer) throw new OperationError(503, 'The operator has no signing key configured');
        const run = await this.stagingRun(this.db, nodePublicKey, request.runId);
        const [root] = run.rootRunId === null ? [run] : await this.db.select().from(runsTable).where(eq(runsTable.id, run.rootRunId)).limit(1);
        if (run.status !== 'held' || root!.treeOutcome !== null) throw new OperationError(409, 'The run has already settled');
        const contract = await this.find(this.db, { nodePublicKey, ...request.contract });
        if (!contract) throw new OperationError(404, `${request.contract.name}@${request.contract.version} isn't registered for this node`);
        let response: number | boolean | AttachmentRead | RandomRead;
        switch (request.function) {
            case 'balance': response = await this.available(this.db, root!, contract.id); break;
            case 'fundingOf': response = await this.available(this.db, root!, contract.id, { funder: request.parameters.org, key: request.parameters.key ?? null }); break;
            case 'canReceive': response = await this.canReceive(this.db, request.parameters.org); break;
            case 'attachment': response = await this.attachment(root!, contract.id, request.parameters.attachmentId); break;
            case 'random': response = await this.randomValue(contract, request.parameters.key); break;
        }
        const signedAt = new Date().toISOString();
        const signature = this.signer.signPayload(moneyReadPayload({ ...request, response, signedAt }));
        return { response, signedAt, signature, publicKey: this.signer.publicKeySpki };
    }

    /**
     * The money attached to a call to the contract, staged in the same tree, which the contract reads as `payment`.
     * Refuses (404) an attachment the tree didn't stage for this contract, so a node can't make one up.
     */
    private async attachment(root: Run, contractId: number, attachmentId: string): Promise<AttachmentRead> {
        const lots = await this.db.select().from(contractFundingTable).where(and(
            eq(contractFundingTable.contractId, contractId),
            eq(contractFundingTable.attachmentId, attachmentId),
            eq(contractFundingTable.rootRunId, root.id),
            eq(contractFundingTable.status, 'staged'),
        )).orderBy(asc(contractFundingTable.id));
        if (lots.length === 0) throw new OperationError(404, 'No money was attached to this contract with that attachment in this run');
        const [first] = lots;
        return {
            amount: lots.reduce((sum, lot) => sum + lot.amountMicroUsd, 0),
            from: first!.funderOrganizationId,
            payees: first!.payees.filter(payee => lots.every(lot => lot.payees.includes(payee))),
        };
    }

    // ---- Settlement ----

    /**
     * Called whenever a run settles: drops the changes of a run that failed or was released, and of every run
     * below it, and settles its root's tree when the root has succeeded. Idempotent, and run again by
     * `settleTrees`, so a crash between a capture and this loses nothing.
     */
    async onRunSettled(runId: number): Promise<void> {
        const [run] = await this.db.select().from(runsTable).where(eq(runsTable.id, runId)).limit(1);
        if (!run || run.status === 'held') return;
        const rootId = run.rootRunId ?? run.id;
        if (run.outcome !== 'succeeded') {
            await this.dropSubtree(rootId, run.id);
        }
        await this.settleTree(rootId);
    }

    /** What happened to the money changes in the tree of the run the node ran. */
    async outcome(nodePublicKey: string, runId: string): Promise<{ outcome: TreeOutcome }> {
        const run = await this.stagingRun(this.db, nodePublicKey, runId);
        const [root] = run.rootRunId === null ? [run] : await this.db.select().from(runsTable).where(eq(runsTable.id, run.rootRunId)).limit(1);
        // A tree being verified hasn't moved its money yet.
        return { outcome: root!.treeOutcome === 'applied' || root!.treeOutcome === 'dropped' ? root!.treeOutcome : 'pending' };
    }

    /** The runs in a tree, by id. */
    private async treeRuns(db: Database | Transaction, rootId: number): Promise<Map<number, Run>> {
        const runs = await db.select().from(runsTable).where(or(eq(runsTable.id, rootId), eq(runsTable.rootRunId, rootId)));
        return new Map(runs.map(run => [run.id, run]));
    }

    /** The run and every run below it. */
    private subtree(runs: Map<number, Run>, top: number): Set<number> {
        const below = new Set([top]);
        let grew = true;
        while (grew) {
            grew = false;
            for (const run of runs.values()) {
                if (run.parentRunId !== null && below.has(run.parentRunId) && !below.has(run.id)) {
                    below.add(run.id);
                    grew = true;
                }
            }
        }
        return below;
    }

    /**
     * Drops the staged changes of a run and the runs below it. When other runs in the tree already spent
     * funding those changes created, the whole tree is dropped: it spent money that never arrived.
     */
    private async dropSubtree(rootId: number, top: number): Promise<void> {
        const staged = await this.db.select().from(moneyChangesTable)
            .where(and(eq(moneyChangesTable.rootRunId, rootId), eq(moneyChangesTable.status, 'staged')));
        if (staged.length === 0) return;
        const runs = await this.treeRuns(this.db, rootId);
        const below = this.subtree(runs, top);
        const dropping = staged.filter(change => below.has(change.runId));
        if (dropping.length === 0) return;
        const created = new Set(dropping.flatMap(change => change.fundingIds));
        const doomed = staged.some(change => !below.has(change.runId) && change.allocations.some(a => created.has(a.fundingId)));
        await this.dropChanges(rootId, doomed ? undefined : new Set(dropping.map(change => change.id)), doomed);
    }

    /**
     * Drops staged changes of a tree, all of them when `ids` is undefined, in one transaction. With `final`,
     * the tree is marked dropped.
     */
    private async dropChanges(rootId: number, ids: Set<number> | undefined, final: boolean): Promise<void> {
        const payers = (await this.db.select({ payer: moneyChangesTable.payerOrganizationId }).from(moneyChangesTable)
            .where(and(eq(moneyChangesTable.rootRunId, rootId), eq(moneyChangesTable.status, 'staged'), isNotNull(moneyChangesTable.payerOrganizationId))))
            .map(row => row.payer!);
        await this.db.transaction(async (tx) => {
            await lockOrganizations(tx, payers);
            const [root] = await tx.select().from(runsTable).where(eq(runsTable.id, rootId)).for('update');
            if (root!.treeOutcome === 'applied' || root!.treeOutcome === 'dropped') return;
            const changes = (await tx.select().from(moneyChangesTable)
                .where(and(eq(moneyChangesTable.rootRunId, rootId), eq(moneyChangesTable.status, 'staged')))
                .orderBy(desc(moneyChangesTable.id)))
                .filter(change => ids === undefined || ids.has(change.id));
            await this.lockContracts(tx, await this.touchedContracts(tx, changes));
            for (const change of changes) {
                for (const allocation of change.allocations) {
                    await tx.update(contractFundingTable)
                        .set({ lockedMicroUsd: sql`${contractFundingTable.lockedMicroUsd} - ${allocation.amountMicroUsd}` })
                        .where(eq(contractFundingTable.id, allocation.fundingId));
                }
                if (change.fundingIds.length > 0) {
                    await tx.update(contractFundingTable).set({ status: 'dropped', lockedMicroUsd: 0 }).where(inArray(contractFundingTable.id, change.fundingIds));
                }
                if (change.payerOrganizationId) {
                    await adjustOrganization(tx, change.payerOrganizationId, { held: -change.amountMicroUsd });
                }
                if (change.function === 'random_request') {
                    // A dropped request was never made, so the key can be requested again.
                    await tx.update(randomRequestsTable).set({ status: 'dropped' }).where(and(
                        eq(randomRequestsTable.contractId, change.contractId!), eq(randomRequestsTable.rootRunId, rootId), eq(randomRequestsTable.status, 'staged'),
                    ));
                }
                await tx.update(moneyChangesTable).set({ status: 'dropped', settledAt: new Date() }).where(eq(moneyChangesTable.id, change.id));
            }
            if (final) {
                await tx.update(runsTable).set({ treeOutcome: 'dropped', updatedAt: new Date() }).where(eq(runsTable.id, rootId));
            }
        });
    }

    /** Every contract a set of changes moves money in or out of. */
    private async touchedContracts(tx: Transaction, changes: MoneyChange[]): Promise<number[]> {
        const fundingIds = changes.flatMap(change => [...change.fundingIds, ...change.allocations.map(a => a.fundingId)]);
        const lots = await this.fundingRows(tx, fundingIds);
        const sources = await this.fundingRows(tx, [...lots.values()].map(lot => lot.sourceFundingId).filter((id): id is number => id !== null));
        return [
            ...changes.map(change => change.contractId).filter((id): id is number => id !== null),
            ...[...lots.values()].map(lot => lot.contractId),
            ...[...sources.values()].map(lot => lot.contractId),
        ];
    }

    /**
     * Applies a root run's tree once it has succeeded: every staged change from a run that succeeded along
     * with all its ancestors, in the order they were staged, in one transaction. Waits while a run that staged
     * changes hasn't settled, until `childReceiptDeadlineMs`, and then drops that run's changes. A root that
     * failed or was released drops everything.
     */
    async settleTree(rootId: number, now: Date = new Date()): Promise<TreeOutcome | null> {
        const [root] = await this.db.select().from(runsTable).where(eq(runsTable.id, rootId)).limit(1);
        if (!root || root.status === 'held') return null;
        if (root.treeOutcome === 'applied' || root.treeOutcome === 'dropped') return root.treeOutcome;
        // Its verification decides it now.
        if (root.treeOutcome === 'verifying') return 'verifying';
        if (root.outcome !== 'succeeded') {
            await this.dropChanges(rootId, undefined, true);
            return 'dropped';
        }

        const runs = await this.treeRuns(this.db, rootId);
        const staged = await this.db.select().from(moneyChangesTable)
            .where(and(eq(moneyChangesTable.rootRunId, rootId), eq(moneyChangesTable.status, 'staged')));
        // A run whose own chain to the root has a run that's still held can still fail.
        const unsettled = (runId: number): number | undefined => {
            for (let run = runs.get(runId); run; run = run.parentRunId === null ? undefined : runs.get(run.parentRunId)) {
                if (run.status === 'held') return run.id;
            }
            return undefined;
        };
        const waitingOn = new Set(staged.map(change => unsettled(change.runId)).filter((id): id is number => id !== undefined));
        if (waitingOn.size > 0) {
            const deadline = root.treeDeadlineAt ?? new Date(now.getTime() + this.policy.childReceiptDeadlineMs);
            if (now < deadline) {
                await this.db.update(runsTable).set({ treeOutcome: 'pending', treeDeadlineAt: deadline, updatedAt: new Date() })
                    .where(and(eq(runsTable.id, rootId), or(isNull(runsTable.treeOutcome), eq(runsTable.treeOutcome, 'pending'))));
                return 'pending';
            }
            // Another node's host can't hold the caller's money changes hostage.
            for (const runId of waitingOn) await this.dropSubtree(rootId, runId);
            const [after] = await this.db.select().from(runsTable).where(eq(runsTable.id, rootId)).limit(1);
            if (after!.treeOutcome === 'dropped') return 'dropped';
        }
        if (await this.verifyFirst(rootId)) {
            await this.db.update(runsTable).set({ treeOutcome: 'verifying', verification: 'pending', updatedAt: new Date() })
                .where(and(eq(runsTable.id, rootId), or(isNull(runsTable.treeOutcome), eq(runsTable.treeOutcome, 'pending'))));
            return 'verifying';
        }
        return this.apply(rootId);
    }

    /**
     * Whether the tree's money waits for the operator to replay it: it has changes contracts staged, which only a
     * replay can vouch for, and it's too large to apply first, or its hosts already have enough applied unverified.
     */
    private async verifyFirst(rootId: number): Promise<boolean> {
        const staged = await this.db.select({ change: moneyChangesTable, host: contractVersionsTable.nodePublicKey })
            .from(moneyChangesTable)
            .innerJoin(contractVersionsTable, eq(contractVersionsTable.id, moneyChangesTable.contractId))
            .where(and(eq(moneyChangesTable.rootRunId, rootId), eq(moneyChangesTable.status, 'staged')));
        if (staged.length === 0) return false;
        const total = staged.reduce((sum, { change }) => sum + change.amountMicroUsd, 0);
        if (total >= this.policy.optimisticVerifyLimitMicroUsd) return true;
        const byHost = new Map<string, number>();
        for (const { change, host } of staged) byHost.set(host, (byHost.get(host) ?? 0) + change.amountMicroUsd);
        for (const [host, amount] of byHost) {
            if (await this.unverifiedForHost(host) + amount > this.policy.maxUnverifiedMicroUsdPerNode) return true;
        }
        return false;
    }

    /** What the node's contracts moved in trees applied but not yet verified. */
    private async unverifiedForHost(nodePublicKey: string): Promise<number> {
        const [row] = await this.db.select({ total: sql<string>`coalesce(sum(${moneyChangesTable.amountMicroUsd}), 0)` })
            .from(moneyChangesTable)
            .innerJoin(contractVersionsTable, eq(contractVersionsTable.id, moneyChangesTable.contractId))
            .innerJoin(runsTable, eq(runsTable.id, moneyChangesTable.rootRunId))
            .where(and(
                eq(contractVersionsTable.nodePublicKey, nodePublicKey),
                eq(moneyChangesTable.status, 'applied'),
                inArray(runsTable.verification, ['pending', 'review']),
            ));
        return Number(row!.total);
    }

    /** Applies a tree the operator verified before its money moved. */
    async applyVerified(rootId: number): Promise<TreeOutcome> {
        return this.apply(rootId);
    }

    /** Drops a tree whose verification found its host lied, before its money moved. */
    async dropUnverified(rootId: number): Promise<void> {
        await this.dropChanges(rootId, undefined, true);
    }

    private async apply(rootId: number): Promise<TreeOutcome> {
        for (;;) {
            try {
                return await this.applyOnce(rootId);
            } catch (error) {
                if (!(error instanceof TreeChanged)) throw error;
            }
        }
    }

    private async applyOnce(rootId: number): Promise<TreeOutcome> {
        const preview = await this.db.select().from(moneyChangesTable)
            .where(and(eq(moneyChangesTable.rootRunId, rootId), eq(moneyChangesTable.status, 'staged')));
        const orgs = await this.organizationsTouched(preview);
        return this.db.transaction(async (tx) => {
            await lockOrganizations(tx, orgs);
            const [root] = await tx.select().from(runsTable).where(eq(runsTable.id, rootId)).for('update');
            if (root!.treeOutcome === 'applied' || root!.treeOutcome === 'dropped') return root!.treeOutcome;
            const changes = await tx.select().from(moneyChangesTable)
                .where(and(eq(moneyChangesTable.rootRunId, rootId), eq(moneyChangesTable.status, 'staged')))
                .orderBy(asc(moneyChangesTable.id));
            if (changes.some(change => !preview.some(seen => seen.id === change.id))) {
                // A change staged since the preview could need an organization that isn't locked. Staging is
                // refused from now on, since the root is locked, so the next attempt sees every change.
                throw new TreeChanged();
            }
            await this.lockContracts(tx, await this.touchedContracts(tx, changes));
            for (const change of changes) {
                await this.applyChange(tx, change);
            }
            // What a tree paid out isn't paid out to its payees until the operator has verified the tree, and a tree whose
            // contracts sent receipts is verified too, so their state hash chains stay whole.
            const paid = changes.some(change => change.function === 'pay' && change.amountMicroUsd > 0);
            const fromContracts = changes.some(change => change.contractId !== null);
            const [receipt] = await tx.select({ id: runReceiptsTable.id }).from(runReceiptsTable).where(eq(runReceiptsTable.rootRunId, rootId)).limit(1);
            // A tree verified before it applied keeps its verification as it is.
            const verification = root!.treeOutcome === 'verifying' ? {} : paid || fromContracts || receipt ? { verification: 'pending' as const } : {};
            await tx.update(runsTable).set({ treeOutcome: 'applied', ...verification, updatedAt: new Date() }).where(eq(runsTable.id, rootId));
            return 'applied' as const;
        }).then(async (outcome) => {
            if (outcome === 'applied') await this.flagLinkedPayments(rootId).catch(() => undefined);
            return outcome;
        });
    }

    /** Every organization whose balances applying the changes touches. */
    private async organizationsTouched(changes: MoneyChange[]): Promise<string[]> {
        const ids = new Set<string>();
        for (const change of changes) {
            if (change.payerOrganizationId) ids.add(change.payerOrganizationId);
            if (change.function === 'pay' && change.recipientOrganizationId) ids.add(change.recipientOrganizationId);
        }
        // A refund to an organization, rather than to the contract that sent the money, credits its balance.
        const lots = await this.fundingRows(this.db, changes.filter(change => change.function === 'refund').flatMap(change => change.allocations.map(a => a.fundingId)));
        for (const lot of lots.values()) if (lot.sourceFundingId === null) ids.add(lot.funderOrganizationId);
        return [...ids];
    }

    private async applyChange(tx: Transaction, change: MoneyChange): Promise<void> {
        const reference = { runId: change.runId };
        switch (change.function) {
            case 'earmark':
                break;
            case 'random_request':
                await this.drawRandom(tx, change);
                break;
            case 'attach': {
                const created = [...(await this.fundingRows(tx, change.fundingIds)).values()];
                if (change.payerOrganizationId) {
                    const lot = created[0]!;
                    await postLedgerTransaction(tx, 'contract_inflow', [
                        { account: accounts.balance(change.payerOrganizationId), amountMicroUsd: -lot.amountMicroUsd },
                        { account: accounts.contract(lot.contractId), amountMicroUsd: lot.amountMicroUsd },
                    ], { ...reference, contractId: lot.contractId });
                    await adjustOrganization(tx, change.payerOrganizationId, { balance: -lot.amountMicroUsd, held: -lot.amountMicroUsd });
                    await this.adjustContract(tx, lot.contractId, lot.amountMicroUsd);
                    await this.log(tx, lot.contractId, 'inflow', lot.amountMicroUsd, lot.funderOrganizationId, { organization: change.payerOrganizationId }, change.runId);
                } else {
                    for (const lot of created) {
                        const allocation = change.allocations.find(a => a.fundingId === lot.sourceFundingId)!;
                        await this.spend(tx, allocation);
                        await postLedgerTransaction(tx, 'contract_transfer', [
                            { account: accounts.contract(change.contractId!), amountMicroUsd: -lot.amountMicroUsd },
                            { account: accounts.contract(lot.contractId), amountMicroUsd: lot.amountMicroUsd },
                        ], { ...reference, contractId: lot.contractId });
                        await this.adjustContract(tx, change.contractId!, -lot.amountMicroUsd);
                        await this.adjustContract(tx, lot.contractId, lot.amountMicroUsd);
                        await this.log(tx, change.contractId!, 'outflow', lot.amountMicroUsd, lot.funderOrganizationId, { contract: lot.contractId }, change.runId);
                        await this.log(tx, lot.contractId, 'inflow', lot.amountMicroUsd, lot.funderOrganizationId, { contract: change.contractId! }, change.runId);
                    }
                }
                await tx.update(contractFundingTable).set({ status: 'active', rootRunId: null }).where(inArray(contractFundingTable.id, change.fundingIds));
                break;
            }
            case 'pay': {
                if (change.amountMicroUsd === 0) break;
                const fee = payFee(change.amountMicroUsd, this.policy.platformFeeBps);
                const lots = await this.fundingRows(tx, change.allocations.map(a => a.fundingId));
                for (const allocation of change.allocations) await this.spend(tx, allocation);
                await postLedgerTransaction(tx, 'contract_pay', [
                    { account: accounts.contract(change.contractId!), amountMicroUsd: -change.amountMicroUsd },
                    { account: accounts.payable(change.recipientOrganizationId!), amountMicroUsd: change.amountMicroUsd - fee },
                    { account: accounts.revenue, amountMicroUsd: fee },
                ], { ...reference, contractId: change.contractId! });
                await this.adjustContract(tx, change.contractId!, -change.amountMicroUsd);
                await adjustOrganization(tx, change.recipientOrganizationId!, { payable: change.amountMicroUsd - fee });
                await tx.update(moneyChangesTable).set({ feeMicroUsd: fee }).where(eq(moneyChangesTable.id, change.id));
                for (const allocation of change.allocations) {
                    await this.log(tx, change.contractId!, 'pay', allocation.amountMicroUsd, lots.get(allocation.fundingId)!.funderOrganizationId, { organization: change.recipientOrganizationId! }, change.runId);
                }
                break;
            }
            case 'refund': {
                const lots = await this.fundingRows(tx, change.allocations.map(a => a.fundingId));
                for (const allocation of change.allocations) {
                    await this.spend(tx, allocation);
                    await this.returnFunding(tx, lots.get(allocation.fundingId)!, allocation.amountMicroUsd, 'contract_refund', 'refund', change.runId, true);
                }
                break;
            }
        }
        await tx.update(moneyChangesTable).set({ status: 'applied', settledAt: new Date() }).where(eq(moneyChangesTable.id, change.id));
    }

    /** Subtracts an allocation from its funding row, which it had locked. */
    private async spend(tx: Transaction, allocation: FundingAllocation): Promise<void> {
        await tx.update(contractFundingTable).set({
            amountMicroUsd: sql`${contractFundingTable.amountMicroUsd} - ${allocation.amountMicroUsd}`,
            lockedMicroUsd: sql`${contractFundingTable.lockedMicroUsd} - ${allocation.amountMicroUsd}`,
        }).where(eq(contractFundingTable.id, allocation.fundingId));
    }

    /**
     * Returns `amount` of a funding row, already taken out of it, out of its contract: one step back along
     * its path when `oneStepBack` (to the contract that sent it, or to the organization's balance), and
     * straight to the organization that funded it otherwise. Lock the organization receiving it first.
     */
    private async returnFunding(tx: Transaction, lot: Funding, amount: number, kind: 'contract_refund' | 'contract_expiry', logKind: MoneyLogKind, runId: number | null, oneStepBack: boolean): Promise<void> {
        const reference = { runId: runId ?? undefined, contractId: lot.contractId };
        await this.adjustContract(tx, lot.contractId, -amount);
        const [source] = oneStepBack && lot.sourceFundingId !== null
            ? await tx.select().from(contractFundingTable).where(eq(contractFundingTable.id, lot.sourceFundingId)).limit(1)
            : [];
        if (source) {
            // No code runs on the way back: the sending contract sees the money through fundingOf.
            await tx.insert(contractFundingTable).values({
                contractId: source.contractId,
                funderOrganizationId: source.funderOrganizationId,
                key: source.key,
                payees: source.payees,
                status: 'active',
                amountMicroUsd: amount,
                sourceFundingId: source.sourceFundingId,
                fundedAt: source.fundedAt,
                chargedAt: source.chargedAt,
            });
            await postLedgerTransaction(tx, kind, [
                { account: accounts.contract(lot.contractId), amountMicroUsd: -amount },
                { account: accounts.contract(source.contractId), amountMicroUsd: amount },
            ], reference);
            await this.adjustContract(tx, source.contractId, amount);
            await this.log(tx, lot.contractId, logKind, amount, lot.funderOrganizationId, { contract: source.contractId }, runId);
            await this.log(tx, source.contractId, 'inflow', amount, lot.funderOrganizationId, { contract: lot.contractId }, runId);
            return;
        }
        await postLedgerTransaction(tx, kind, [
            { account: accounts.contract(lot.contractId), amountMicroUsd: -amount },
            { account: accounts.balance(lot.funderOrganizationId), amountMicroUsd: amount },
        ], reference);
        await adjustOrganization(tx, lot.funderOrganizationId, { balance: amount });
        await this.log(tx, lot.contractId, logKind, amount, lot.funderOrganizationId, { organization: lot.funderOrganizationId }, runId);
    }

    private async adjustContract(tx: Transaction, contractId: number, delta: number): Promise<void> {
        await tx.update(contractVersionsTable)
            .set({ balanceMicroUsd: sql`${contractVersionsTable.balanceMicroUsd} + ${delta}` })
            .where(eq(contractVersionsTable.id, contractId));
    }

    private async log(tx: Transaction, contractId: number, kind: MoneyLogKind, amount: number, funder: string, counterparty: { organization?: string, contract?: number }, runId: number | null): Promise<void> {
        await tx.insert(contractMoneyLogTable).values({
            contractId,
            kind,
            amountMicroUsd: amount,
            funderOrganizationId: funder,
            counterpartyOrganizationId: counterparty.organization,
            counterpartyContractId: counterparty.contract,
            runId,
        });
    }

    // ---- Verification ----

    /** What contract payments credited the organization in trees the operator hasn't verified, net of fees. */
    async heldForVerification(organizationId: string): Promise<number> {
        const [row] = await this.db.select({ total: sql<string>`coalesce(sum(${moneyChangesTable.amountMicroUsd} - coalesce(${moneyChangesTable.feeMicroUsd}, 0)), 0)` })
            .from(moneyChangesTable)
            .innerJoin(runsTable, eq(runsTable.id, moneyChangesTable.rootRunId))
            .where(and(
                eq(moneyChangesTable.recipientOrganizationId, organizationId),
                eq(moneyChangesTable.function, 'pay'),
                eq(moneyChangesTable.status, 'applied'),
                inArray(runsTable.verification, ['pending', 'review']),
            ));
        return Number(row!.total);
    }

    /**
     * Applied trees that paid anyone and haven't been verified, oldest first: the work of the replay worker
     * (docs/money.md, Verified runs), which doesn't exist yet. Until a tree is verified, its payments' credits
     * aren't paid out (`PayoutService`).
     */
    async unverifiedTrees(limit = 100): Promise<{ runId: string, nodePublicKey: string, capturedAt: Date | null }[]> {
        return this.db.select({ runId: runsTable.runId, nodePublicKey: runsTable.nodePublicKey, capturedAt: runsTable.capturedAt })
            .from(runsTable)
            .where(eq(runsTable.verification, 'pending'))
            .orderBy(asc(runsTable.id))
            .limit(limit);
    }

    /**
     * Records whether a tree passed verification. A verified tree's credits become payable after the payout
     * hold. A failed one's stay held for review: reversing it is fraud handling. Any run in the tree names it.
     * Refuses (409) to change a recorded result.
     */
    async recordVerification(runId: string, result: 'verified' | 'failed'): Promise<void> {
        const [run] = await this.db.select().from(runsTable).where(eq(runsTable.runId, runId)).limit(1);
        if (!run) throw new OperationError(404, 'Run was never authorized');
        const rootId = run.rootRunId ?? run.id;
        const [root] = await this.db.select().from(runsTable).where(eq(runsTable.id, rootId)).limit(1);
        if (root!.verification === result) return;
        if (root!.verification !== 'pending') {
            throw new OperationError(409, root!.verification === null ? 'The run\'s tree paid nobody, so it has nothing to verify' : `The run's tree was already ${root!.verification}`);
        }
        await this.db.update(runsTable).set({ verification: result, verifiedAt: new Date(), updatedAt: new Date() })
            .where(and(eq(runsTable.id, rootId), eq(runsTable.verification, 'pending')));
    }

    // ---- Owners and maintenance ----

    /**
     * The owner's emergency stop: refunds the version's funding to its funders, one step back, and refuses
     * money from now on. Funding locked by a tree that hasn't settled is refunded by `refundExpired` after it
     * settles. Returns what was refunded now.
     */
    async refundAll(organizationId: string, contractId: number): Promise<{ refundedMicroUsd: number }> {
        const [contract] = await this.db.select().from(contractVersionsTable).where(eq(contractVersionsTable.id, contractId)).limit(1);
        if (!contract || contract.ownerOrganizationId !== organizationId) throw new OperationError(404, 'Contract not found');
        await this.db.update(contractVersionsTable).set({ refundAllAt: new Date() })
            .where(and(eq(contractVersionsTable.id, contractId), isNull(contractVersionsTable.refundAllAt)));
        return { refundedMicroUsd: await this.returnUnlocked(contractId, 'refund_all', true) };
    }

    /**
     * Recovers up to `amount` an organization owes after a card refund or dispute from its unspent funding in
     * contracts, before anything else (docs/money.md, Funding): oldest first, straight to its balance. Locked funding
     * is left alone. Returns what was recovered.
     */
    async recoverFromFunding(organizationId: string, amount: number, notice = 'dispute_recovered'): Promise<number> {
        if (amount <= 0) return 0;
        const lots = await this.db.select().from(contractFundingTable).where(and(
            eq(contractFundingTable.funderOrganizationId, organizationId),
            eq(contractFundingTable.status, 'active'),
            sql`${contractFundingTable.amountMicroUsd} > ${contractFundingTable.lockedMicroUsd}`,
        )).orderBy(asc(contractFundingTable.fundedAt), asc(contractFundingTable.id));
        let left = amount;
        const byContract = new Map<number, number>();
        for (const candidate of lots) {
            if (left === 0) break;
            const taken = await this.db.transaction(async (tx) => {
                await lockOrganizations(tx, [organizationId]);
                await this.lockContracts(tx, [candidate.contractId]);
                const [lot] = await tx.select().from(contractFundingTable).where(eq(contractFundingTable.id, candidate.id)).for('update');
                const take = Math.min(left, lot!.amountMicroUsd - lot!.lockedMicroUsd);
                if (lot!.status !== 'active' || take <= 0) return 0;
                await tx.update(contractFundingTable).set({ amountMicroUsd: lot!.amountMicroUsd - take }).where(eq(contractFundingTable.id, lot!.id));
                // Straight to the organization, past any contract in between: the operator recovering money, not a refund.
                await this.returnFunding(tx, lot!, take, 'contract_expiry', 'dispute_recovery', null, false);
                return take;
            });
            left -= taken;
            if (taken > 0) byContract.set(candidate.contractId, (byContract.get(candidate.contractId) ?? 0) + taken);
        }
        const recovered = amount - left;
        if (recovered > 0) {
            await this.notify?.(organizationId, notice, { amountMicroUsd: recovered, contracts: [...byContract.keys()] }).catch(() => undefined);
        }
        return recovered;
    }

    /**
     * Closes a contract version whose host was found fraudulent: it refuses money from now on, and its funding goes
     * straight back to the organizations that sent it, as the time limit's does. Locked funding follows once its tree
     * settles. Returns what was refunded now.
     */
    async close(contractId: number): Promise<number> {
        await this.db.update(contractVersionsTable).set({ refundAllAt: new Date() })
            .where(and(eq(contractVersionsTable.id, contractId), isNull(contractVersionsTable.refundAllAt)));
        return this.returnUnlocked(contractId, 'closed', false);
    }

    /**
     * The time limit: refunds funding older than `maxContractHoldMs` straight to the organization that sent it,
     * and finishes refund-alls. Locked funding waits for its tree. Returns how much was refunded.
     */
    async refundExpired(now: Date = new Date()): Promise<number> {
        const cutoff = new Date(now.getTime() - this.policy.maxContractHoldMs);
        const expired = await this.db.selectDistinct({ contractId: contractFundingTable.contractId }).from(contractFundingTable).where(and(
            eq(contractFundingTable.status, 'active'),
            lt(contractFundingTable.fundedAt, cutoff),
            sql`${contractFundingTable.amountMicroUsd} > ${contractFundingTable.lockedMicroUsd}`,
        ));
        const closing = await this.db.selectDistinct({ contractId: contractFundingTable.contractId }).from(contractFundingTable)
            .innerJoin(contractVersionsTable, eq(contractVersionsTable.id, contractFundingTable.contractId))
            .where(and(
                isNotNull(contractVersionsTable.refundAllAt),
                eq(contractFundingTable.status, 'active'),
                sql`${contractFundingTable.amountMicroUsd} > ${contractFundingTable.lockedMicroUsd}`,
            ));
        let refunded = 0;
        for (const { contractId } of expired) refunded += await this.returnUnlocked(contractId, 'expiry_refund', false, cutoff);
        for (const { contractId } of closing) refunded += await this.returnUnlocked(contractId, 'refund_all', true);
        return refunded;
    }

    /** Returns the unlocked part of a contract's active funding, or of the part funded before `fundedBefore`. */
    private async returnUnlocked(contractId: number, logKind: 'expiry_refund' | 'refund_all' | 'closed', oneStepBack: boolean, fundedBefore?: Date): Promise<number> {
        const where = and(
            eq(contractFundingTable.contractId, contractId),
            eq(contractFundingTable.status, 'active'),
            sql`${contractFundingTable.amountMicroUsd} > ${contractFundingTable.lockedMicroUsd}`,
            ...(fundedBefore ? [lt(contractFundingTable.fundedAt, fundedBefore)] : []),
        );
        const preview = await this.db.select().from(contractFundingTable).where(where);
        if (preview.length === 0) return 0;
        const sources = await this.fundingRows(this.db, preview.map(lot => lot.sourceFundingId).filter((id): id is number => id !== null));
        const returned = new Map<string, number>();
        const total = await this.db.transaction(async (tx) => {
            await lockOrganizations(tx, preview.map(lot => lot.funderOrganizationId));
            await this.lockContracts(tx, [contractId, ...[...sources.values()].map(lot => lot.contractId)]);
            const lots = await tx.select().from(contractFundingTable).where(where).orderBy(asc(contractFundingTable.id)).for('update');
            let sum = 0;
            for (const lot of lots) {
                const amount = lot.amountMicroUsd - lot.lockedMicroUsd;
                await tx.update(contractFundingTable).set({ amountMicroUsd: lot.lockedMicroUsd }).where(eq(contractFundingTable.id, lot.id));
                await this.returnFunding(tx, lot, amount, logKind === 'expiry_refund' ? 'contract_expiry' : 'contract_refund', logKind, null, oneStepBack);
                returned.set(lot.funderOrganizationId, (returned.get(lot.funderOrganizationId) ?? 0) + amount);
                sum += amount;
            }
            return sum;
        });
        // A safety net moved the funding behind the contract's back, so its funders are told.
        const [contract] = await this.db.select().from(contractVersionsTable).where(eq(contractVersionsTable.id, contractId)).limit(1);
        for (const [organizationId, amountMicroUsd] of returned) {
            await this.notify?.(organizationId, 'funding_returned', { reason: logKind, contract: `${contract!.name}@${contract!.version}`, nodePublicKey: contract!.nodePublicKey, amountMicroUsd })
                .catch(() => undefined);
        }
        return total;
    }

    /**
     * Settles trees a crash or a slow node left behind: roots that settled without their tree being decided,
     * and pending trees past their deadline. Returns how many trees it decided.
     */
    async settleTrees(now: Date = new Date()): Promise<number> {
        const roots = await this.db.select({ id: runsTable.id }).from(runsTable).where(and(
            isNull(runsTable.rootRunId),
            or(
                and(isNull(runsTable.treeOutcome), inArray(runsTable.status, ['captured', 'released'])),
                and(eq(runsTable.treeOutcome, 'pending'), lt(runsTable.treeDeadlineAt, now)),
            ),
        )).orderBy(asc(runsTable.id)).limit(500);
        let decided = 0;
        for (const { id } of roots) {
            const outcome = await this.settleTree(id, now);
            if (outcome === 'applied' || outcome === 'dropped') decided++;
        }
        return decided;
    }
}
