import { and, asc, eq, inArray, isNotNull, isNull, or } from "drizzle-orm";
import { hashData, verifySignature } from "../crypto.js";
import type { Database } from "../db/database.js";
import {
    type ContractFlag, contractStateChainTable, contractVersionsTable, moneyChangesTable, nodesTable, randomRequestsTable, runReceiptsTable, runsTable, verificationReviewsTable,
} from "../db/schema.js";
import { OperationError } from "../errors.js";
import type { AuditLog } from "../governance/audit.js";
import type { FraudService } from "./fraudService.js";
import type { MoneyService } from "../money/moneyService.js";
import { runConformance } from "requestscript/conformance";
import { canReplay, REPLAY_REQUESTSCRIPT_VERSION, receiptsPayload, replay, resourceResponsePayload, type ReceiptCall, type RunReceipt } from "./replay.js";

type Run = typeof runsTable.$inferSelect;
type MoneyChange = typeof moneyChangesTable.$inferSelect;

/** How long after a tree is applied its receipts may still arrive, before a gap goes to review. */
export const DEFAULT_RECEIPT_DEADLINE_MS = 10 * 60 * 1000;

const ACCOUNT = 'sh.stellarium.money.Account';
const RANDOM = 'sh.stellarium.random.Random';

/** Asks a provider whether it answered a call. Undefined when it can't be reached. */
async function askProvider(baseUrl: string, runTag: string, callIndex: number): Promise<boolean | undefined> {
    try {
        const response = await fetch(`${baseUrl}/v1/served-calls/${encodeURIComponent(runTag)}/${callIndex}`, { signal: AbortSignal.timeout(5_000) });
        if (response.status === 404) return false;
        return response.ok ? true : undefined;
    } catch {
        return undefined;
    }
}

/** How a state variable is stored on a node: `''` for the shared copy, else its kind and key. Copied from stellarium-ts. */
function scopeKey(scope: { kind: string, key: string } | null): string {
    return scope === null ? '' : `${scope.kind === 'string' ? 's' : 'i'}:${scope.key}`;
}

const stateHash = (value: unknown, type: string) => hashData({ value, type });

/** A recorded int64 or number argument as a number. */
function numberOf(value: unknown): number | undefined {
    if (typeof value === 'number') return value;
    const int64 = (value as { $int64?: unknown } | null)?.$int64;
    return typeof int64 === 'string' ? Number(int64) : undefined;
}

const argument = (call: ReceiptCall, name: string) => call.parameters.find(parameter => parameter.name === name)?.value;

type Finding = { kind: 'proof' | 'review' | 'wait', reason: string };

/**
 * Verifies applied trees from their hosts' receipts (docs/money.md, Verified runs): replays every contract run,
 * checks that each money change a contract staged is one its replay asked for, and that state reads agree with
 * the operator's state hash chains. A verified tree's payments may be paid out. A proven inconsistency is
 * fraud; a disagreement that proves nothing goes to staff review, with the host's hosting suspended.
 */
export class VerificationService {
    constructor(
        private readonly db: Database,
        private readonly fraud: FraudService,
        private readonly audit: AuditLog,
        private readonly money: MoneyService,
        private readonly receiptDeadlineMs = DEFAULT_RECEIPT_DEADLINE_MS,
        /** Whether a provider answered a call, from its served-call log. Undefined when it can't be asked. */
        private readonly servedCall: (baseUrl: string, runTag: string, callIndex: number) => Promise<boolean | undefined> = askProvider,
    ) {}

    /** Flags found for each contract version while checking a tree, recorded once the tree is decided. */
    private flags = new Map<string, Set<ContractFlag>>();

    /** Keeps a node's receipts for a tree, after checking the node signed them. Idempotent per submission. */
    async submit(nodePublicKey: string, request: { runId: string, receipts: RunReceipt[], signature: string }): Promise<{ accepted: number }> {
        if (!verifySignature(receiptsPayload(request.runId, request.receipts), nodePublicKey, request.signature, 'receipts')) {
            throw new OperationError(401, 'Invalid receipts signature');
        }
        const [run] = await this.db.select().from(runsTable).where(eq(runsTable.runId, request.runId)).limit(1);
        if (!run) throw new OperationError(404, 'Run was never authorized');
        const rootId = run.rootRunId ?? run.id;
        await this.db.insert(runReceiptsTable).values(request.receipts.map((receipt, position) => ({
            rootRunId: rootId,
            nodePublicKey,
            signature: request.signature,
            position,
            receipt,
        }))).onConflictDoNothing();
        // A tree whose contracts ran is verified, whether or not it paid anyone, so its state hash chains stay whole.
        await this.db.update(runsTable).set({ verification: 'pending', updatedAt: new Date() })
            .where(and(eq(runsTable.id, rootId), eq(runsTable.treeOutcome, 'applied'), isNull(runsTable.verification)));
        return { accepted: request.receipts.length };
    }

    /**
     * Whether the installed RequestScript passes its deterministic conformance suite, which every release must.
     * Checked once: a runtime that fails it can't be trusted to replay what another version ran.
     */
    private conformant?: Promise<boolean>;

    private async runtimeConformant(): Promise<boolean> {
        this.conformant ??= runConformance().then(({ failures }) => {
            if (failures.length > 0) {
                console.error(`RequestScript ${REPLAY_REQUESTSCRIPT_VERSION} fails ${failures.length} conformance case(s), so no tree is verified`, failures);
            }
            return failures.length === 0;
        });
        return this.conformant;
    }

    /** Verifies the trees waiting, oldest first. Returns how many it decided. */
    async verifyTrees(now: Date = new Date()): Promise<number> {
        // Their payouts stay held until a conformant runtime replays them.
        if (!await this.runtimeConformant()) return 0;
        const roots = await this.db.select().from(runsTable)
            .where(and(eq(runsTable.verification, 'pending'), inArray(runsTable.treeOutcome, ['applied', 'verifying'])))
            .orderBy(asc(runsTable.id)).limit(100);
        let decided = 0;
        for (const root of roots) {
            if (await this.verifyTree(root, now)) decided++;
        }
        return decided;
    }

    /** True once the tree is verified, failed or under review; false while it waits for receipts. */
    async verifyTree(root: Run, now: Date = new Date()): Promise<boolean> {
        const finding = await this.check(root);
        if (finding?.kind === 'wait') {
            const appliedAt = root.capturedAt ?? root.releasedAt ?? root.updatedAt;
            if (now.getTime() - appliedAt.getTime() < this.receiptDeadlineMs) return false;
            return this.review(root, `${finding.reason}, past the receipt deadline`);
        }
        await this.recordFlags();
        const host = finding?.node ?? root.nodePublicKey;
        if (finding?.kind === 'proof') {
            await this.fraud.recordFraud(root.id, host, finding.reason, 'proof', 'operator');
            return true;
        }
        if (finding?.kind === 'review') return this.review(root, finding.reason, host);
        // Verified before its money moved: it moves now.
        if (root.treeOutcome === 'verifying') await this.money.applyVerified(root.id);
        await this.commitChains(root);
        await this.db.update(runsTable).set({ verification: 'verified', verifiedAt: now, updatedAt: now }).where(eq(runsTable.id, root.id));
        return true;
    }

    /** Holds the tree's money, suspends its host's contract hosting, and asks staff to decide. */
    private async review(root: Run, reason: string, host = root.nodePublicKey): Promise<boolean> {
        await this.db.transaction(async (tx) => {
            await tx.update(runsTable).set({ verification: 'review', updatedAt: new Date() }).where(eq(runsTable.id, root.id));
            await tx.insert(verificationReviewsTable).values({ rootRunId: root.id, nodePublicKey: host, reason: reason.slice(0, 4096) });
            await tx.update(nodesTable).set({ suspendedAt: new Date() }).where(and(eq(nodesTable.publicKey, host), isNull(nodesTable.suspendedAt)));
        });
        const [node] = await this.db.select().from(nodesTable).where(eq(nodesTable.publicKey, host)).limit(1);
        await this.audit.record('operator', 'verification_review_opened', node?.organizationId ?? null, { rootRunId: root.id, nodePublicKey: host, reason });
        return true;
    }

    /** What's wrong with the tree, if anything: a proof, something for review, or receipts still to come. */
    private async check(root: Run): Promise<(Finding & { node?: string }) | undefined> {
        const runs = await this.db.select().from(runsTable).where(or(eq(runsTable.id, root.id), eq(runsTable.rootRunId, root.id)));
        const runIdOf = new Map(runs.map(run => [run.runId, run.id]));
        // A tree verified before its money moves has its changes still staged.
        const changes = await this.db.select().from(moneyChangesTable)
            .where(and(eq(moneyChangesTable.rootRunId, root.id), eq(moneyChangesTable.status, root.treeOutcome === 'verifying' ? 'staged' : 'applied'), isNotNull(moneyChangesTable.contractId)));
        const changeAt = new Map(changes.map(change => [`${change.runId}:${change.callIndex}`, change]));
        const receipts = await this.db.select().from(runReceiptsTable).where(eq(runReceiptsTable.rootRunId, root.id))
            .orderBy(asc(runReceiptsTable.id), asc(runReceiptsTable.position));
        const claimed = new Set<number>();
        this.flags = new Map();
        const tags = new Set<string>();
        // Every state each key may be read in: as the chain had it before the tree, or as a run in the tree wrote it.
        const allowed = new Map<string, Set<string>>();
        const chainKey = (node: string, name: string, variable: string, scope: string) => JSON.stringify([node, name, variable, scope]);
        for (const { nodePublicKey, receipt: raw } of receipts) {
            const receipt = raw as RunReceipt;
            for (const write of receipt.outputs.state) {
                const key = chainKey(nodePublicKey, receipt.contract.name, write.name, scopeKey(write.scope));
                const states = allowed.get(key) ?? new Set();
                states.add(`${Number(write.version ?? 0) + 1}:${stateHash(write.value, write.type)}`);
                allowed.set(key, states);
            }
        }

        for (const { nodePublicKey, receipt: raw } of receipts) {
            const receipt = raw as RunReceipt;
            const label = `${receipt.contract.name}@${receipt.contract.version}`;
            const [registration] = await this.db.select().from(contractVersionsTable).where(and(
                eq(contractVersionsTable.nodePublicKey, nodePublicKey),
                eq(contractVersionsTable.name, receipt.contract.name),
                eq(contractVersionsTable.version, receipt.contract.version),
            )).limit(1);
            if (!registration) return { kind: 'review', reason: `${label} isn't registered, so its run can't be replayed`, node: nodePublicKey };
            if (registration.sourceHash !== receipt.contract.sourceHash) {
                return { kind: 'proof', reason: `the receipt of ${label} names other source than its registration`, node: nodePublicKey };
            }
            if (!canReplay(registration.requestscriptVersion)) {
                return { kind: 'review', reason: `${label} runs on RequestScript ${registration.requestscriptVersion}, which the operator doesn't replay`, node: nodePublicKey };
            }

            // State reads must agree with what the operator knows, so a host can't rewind or fork a contract's state.
            for (const read of receipt.stateReads) {
                const key = chainKey(nodePublicKey, receipt.contract.name, read.name, scopeKey(read.scope));
                const [entry] = await this.db.select().from(contractStateChainTable).where(and(
                    eq(contractStateChainTable.nodePublicKey, nodePublicKey),
                    eq(contractStateChainTable.name, receipt.contract.name),
                    eq(contractStateChainTable.variable, read.name),
                    eq(contractStateChainTable.scopeKey, scopeKey(read.scope)),
                )).limit(1);
                if (!entry) {
                    // State the operator never saw written: the host vouched for it alone, up to here.
                    if (read.stored !== null) {
                        const key = JSON.stringify([nodePublicKey, receipt.contract.name, receipt.contract.version]);
                        this.flags.set(key, (this.flags.get(key) ?? new Set()).add('unverifiedHistory'));
                    }
                    continue;
                }
                if (read.stored === null) {
                    return { kind: 'review', reason: `${label} read no ${read.name}, which the operator last saw at version ${entry.version}`, node: nodePublicKey };
                }
                const version = Number(read.stored.version ?? 0);
                const state = `${version}:${stateHash(read.stored.value, read.stored.type)}`;
                if (state === `${entry.version}:${entry.valueHash}` || allowed.get(key)?.has(state)) continue;
                if (version < entry.version || (version === entry.version)) {
                    return { kind: 'proof', reason: `${label} read ${read.name} at version ${version}, which contradicts the version ${entry.version} the operator verified`, node: nodePublicKey };
                }
                // Written since the operator last saw it, by a run that moved no money: only a payable contract's
                // every run is verified, so for it that's a gap.
                if (registration.payable) {
                    return { kind: 'wait', reason: `${label} read ${read.name} at version ${version}, past the verified ${entry.version}` };
                }
            }

            // Every money change the run made must be one it asked for.
            const expected = (call: ReceiptCall): Record<string, unknown> | 'read' | undefined => {
                if (call.resource === ACCOUNT) {
                    const key = argument(call, 'key') ?? null;
                    switch (call.function) {
                        case 'pay': case 'tryPay':
                            return { function: 'pay', to: argument(call, 'to'), amount: numberOf(argument(call, 'amount')), from: argument(call, 'from'), key, try: call.function === 'tryPay' };
                        case 'refund':
                            return { function: 'refund', to: argument(call, 'to'), amount: numberOf(argument(call, 'amount')), key };
                        case 'earmark':
                            return { function: 'earmark', attachmentId: receipt.inputs.payment?.attachmentId, key };
                        default:
                            return 'read';
                    }
                }
                if (call.resource === RANDOM) {
                    return call.function === 'requestValue' ? { function: 'random_request', key: argument(call, 'key') } : 'read';
                }
                if (call.attachment) {
                    return { function: 'attach', to: call.version === undefined ? call.resource : `${call.resource}@${call.version}`, amount: call.attachment.amount, payees: call.attachment.payees ?? null, from: call.attachment.from ?? null, key: call.attachment.key ?? null };
                }
                return undefined;
            };
            const moneyCalls: { ref: { runId: string, callIndex: number }, expect: Record<string, unknown> | 'read' }[] = [];
            if (receipt.inputs.payment) moneyCalls.push({ ref: receipt.inputs.payment.money, expect: 'read' });
            for (const call of receipt.calls) {
                const expect = expected(call);
                if (expect !== undefined && call.money) moneyCalls.push({ ref: call.money, expect });
            }
            for (const { ref, expect } of moneyCalls) {
                const runRowId = runIdOf.get(ref.runId);
                const change = runRowId === undefined ? undefined : changeAt.get(`${runRowId}:${ref.callIndex}`);
                if (expect === 'read') {
                    if (change) return { kind: 'proof', reason: `call ${ref.callIndex} of run ${ref.runId} staged a ${change.function}, but ${label} only read there`, node: nodePublicKey };
                    continue;
                }
                // A refused call staged nothing, and the run failed, so no applied tree has one: a missing change is a lie too.
                if (!change) return { kind: 'proof', reason: `${label}'s ${expect.function} at call ${ref.callIndex} has no change staged`, node: nodePublicKey };
                if (JSON.stringify(normalized(change)) !== JSON.stringify(expect)) {
                    return { kind: 'proof', reason: `call ${ref.callIndex} of run ${ref.runId} staged ${JSON.stringify(normalized(change))}, but ${label} asked for ${JSON.stringify(expect)}`, node: nodePublicKey };
                }
                claimed.add(change.id);
            }

            // A random value the run read must be the one the operator drew for the contract and key.
            for (const call of receipt.calls) {
                if (call.resource !== RANDOM || call.function !== 'value' || call.response.error) continue;
                const [drawn] = await this.db.select().from(randomRequestsTable).where(and(
                    eq(randomRequestsTable.contractId, registration.id), eq(randomRequestsTable.key, String(argument(call, 'key'))), eq(randomRequestsTable.status, 'requested'),
                )).limit(1);
                if (drawn?.value !== call.response.value) {
                    return { kind: 'proof', reason: `${label} read a random value under ${String(argument(call, 'key'))} the operator never drew`, node: nodePublicKey };
                }
            }

            // Answers from other nodes must be what they signed, and a failure one they never answered.
            const [hostNode] = await this.db.select().from(nodesTable).where(eq(nodesTable.publicKey, nodePublicKey)).limit(1);
            const flag = (value: ContractFlag) => {
                const key = JSON.stringify([nodePublicKey, receipt.contract.name, receipt.contract.version]);
                this.flags.set(key, (this.flags.get(key) ?? new Set()).add(value));
            };
            for (const call of receipt.calls) {
                // The operator's own answers, and contracts on the host, which their own receipts account for.
                if (call.resource === ACCOUNT || call.resource === RANDOM || call.localContract) continue;
                const attestation = call.attestation;
                if (!attestation) {
                    flag(call.local ? 'hostResources' : 'unsignedProviders');
                    continue;
                }
                if (attestation.runTag !== hashData({ nonce: receipt.nonce, provider: attestation.publicKey })) {
                    return { kind: 'proof', reason: `${label}'s call to ${call.resource}.${call.function} carries a tag its run never made`, node: nodePublicKey };
                }
                const tag = `${attestation.publicKey}:${attestation.runTag}:${attestation.callIndex}`;
                if (tags.has(tag)) return { kind: 'proof', reason: `${label} recorded two calls with the same tag and index`, node: nodePublicKey };
                tags.add(tag);
                const [provider] = await this.db.select().from(nodesTable).where(eq(nodesTable.publicKey, attestation.publicKey)).limit(1);
                if (!provider) {
                    flag('unsignedProviders');
                    continue;
                }
                if (provider.organizationId === hostNode?.organizationId) flag('hostResources');
                if (attestation.failed) {
                    const answered = provider.baseUrl ? await this.servedCall(provider.baseUrl, attestation.runTag, attestation.callIndex) : undefined;
                    if (answered) {
                        return { kind: 'proof', reason: `${label} recorded its call to ${call.resource}.${call.function} as failed, but the provider answered it`, node: nodePublicKey };
                    }
                    continue;
                }
                const signed = resourceResponsePayload({
                    runTag: attestation.runTag, callIndex: attestation.callIndex, invocationHash: attestation.invocationHash ?? '',
                    response: call.response, publicKey: attestation.publicKey, signedAt: attestation.signedAt ?? '',
                });
                if (!attestation.signature || !verifySignature(signed, attestation.publicKey, attestation.signature, 'provider')) {
                    return { kind: 'proof', reason: `${label} recorded an answer to ${call.resource}.${call.function} its provider didn't sign`, node: nodePublicKey };
                }
            }

            const replayed = await replay(receipt, registration.source);
            if (!replayed.ok) return { kind: 'review', reason: `${label}: ${replayed.reason}`, node: nodePublicKey };
        }
        const unclaimed = changes.filter(change => !claimed.has(change.id));
        if (unclaimed.length > 0) {
            return { kind: 'wait', reason: `${unclaimed.length} money change(s) a contract staged have no receipt` };
        }
        return undefined;
    }

    /** Adds the flags found while checking a tree to their contract versions. */
    private async recordFlags(): Promise<void> {
        for (const [key, flags] of this.flags) {
            const [nodePublicKey, name, version] = JSON.parse(key) as [string, string, string];
            const [registration] = await this.db.select().from(contractVersionsTable).where(and(
                eq(contractVersionsTable.nodePublicKey, nodePublicKey), eq(contractVersionsTable.name, name), eq(contractVersionsTable.version, version),
            )).limit(1);
            if (!registration) continue;
            const merged = [...new Set([...registration.flags, ...flags])].sort() as ContractFlag[];
            if (merged.length !== registration.flags.length) {
                await this.db.update(contractVersionsTable).set({ flags: merged }).where(eq(contractVersionsTable.id, registration.id));
            }
        }
        this.flags = new Map();
    }

    /** Records the tree's state writes in the chains, in the order they ran. */
    private async commitChains(root: Run): Promise<void> {
        const receipts = await this.db.select().from(runReceiptsTable).where(eq(runReceiptsTable.rootRunId, root.id))
            .orderBy(asc(runReceiptsTable.id), asc(runReceiptsTable.position));
        for (const { nodePublicKey, receipt: raw } of receipts) {
            const receipt = raw as RunReceipt;
            for (const write of receipt.outputs.state) {
                const values = {
                    nodePublicKey,
                    name: receipt.contract.name,
                    variable: write.name,
                    scopeKey: scopeKey(write.scope),
                    version: Number(write.version ?? 0) + 1,
                    valueHash: stateHash(write.value, write.type),
                    updatedAt: new Date(),
                };
                await this.db.insert(contractStateChainTable).values(values).onConflictDoUpdate({
                    target: [contractStateChainTable.nodePublicKey, contractStateChainTable.name, contractStateChainTable.variable, contractStateChainTable.scopeKey],
                    set: { version: values.version, valueHash: values.valueHash, updatedAt: values.updatedAt },
                });
            }
        }
    }
}

/** A staged change in the shape `expected` describes calls in. */
function normalized(change: MoneyChange): Record<string, unknown> {
    const p = (change.parameters as { parameters: Record<string, unknown> }).parameters;
    switch (change.function) {
        case 'pay': return { function: 'pay', to: p.to, amount: p.amount, from: p.from, key: p.key ?? null, try: p.try === true };
        case 'refund': return { function: 'refund', to: p.to, amount: p.amount, key: p.key ?? null };
        case 'earmark': return { function: 'earmark', attachmentId: p.attachmentId, key: p.key ?? null };
        case 'random_request': return { function: 'random_request', key: p.key };
        case 'attach': {
            const to = p.to as { name: string, version: string };
            return { function: 'attach', to: `${to.name}@${to.version}`, amount: p.amount, payees: p.payees ?? null, from: p.from ?? null, key: p.key ?? null };
        }
    }
}
