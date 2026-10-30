import { and, desc, eq, lt } from "drizzle-orm";
import { maxTokens, parseScript } from "requestscript";
import { verifySignature } from "../crypto.js";
import type { Database, Transaction } from "../db/database.js";
import { runsTable } from "../db/schema.js";
import { OperationError } from "../errors.js";
import { accounts, adjustOrganization, lockOrganizations, postLedgerTransaction } from "../ledger.js";
import type { OrganizationService } from "../organizations.js";
import { HOLD_GRACE_MS, type PaymentService, TOP_UP_URL } from "../payments/paymentService.js";
import { type ContractVoucher, contractVoucherPayload } from "../payments/types.js";
import { type ApiClientService, clientSpend, monthStart } from "./clients.js";
import type { RunTokenSigner } from "./tokens.js";

export type Run = typeof runsTable.$inferSelect;

/** How long a run's hold lasts before maintenance releases it. Long enough for a script making several inference calls. */
export const RUN_LIFETIME_MS = 1000 * 60 * 15;

export interface RunAuthorizationRequest {
    /** The run token the caller presented to the node. */
    token: string;
    /** Chosen by the node, so a retried authorization finds the same run. */
    runId: string;
    /** The script, from which the operator computes the most tokens it can execute. */
    source: string;
}

export type RunAuthorization = { status: 'held', heldMicroUsd: number, maxTokens: number, tokenBudgetMicroUsd: number };

export interface ContractRunAuthorizationRequest {
    /** Signed by the calling node. Its `invocationId` is the run's id, so a retried call finds the same run. */
    voucher: ContractVoucher;
    /** The contract's source, from which the operator computes the most tokens it can execute. */
    source: string;
}

/** A contract call by the node's own organization isn't billed, and gets no run. */
export type ContractRunAuthorization = RunAuthorization | { status: 'free' };
export type RunCaptureResult = { status: 'captured', amountMicroUsd: number } | { status: 'released' };

/** Micro-USD for `tokens` script tokens at `price` per million, rounded up. */
export function tokenCharge(tokens: number, priceMicroUsdPerMillionTokens: number): number {
    return Number((BigInt(tokens) * BigInt(priceMicroUsdPerMillionTokens) + 999_999n) / 1_000_000n);
}

function parse(source: string): ReturnType<typeof parseScript> {
    try {
        return parseScript(source);
    } catch (error) {
        throw new OperationError(400, `Invalid script: ${error instanceof Error ? error.message : String(error)}`);
    }
}

/**
 * The most tokens any run of `source` can execute. A contract source is a deploy, which the node pays for
 * with a voucher on the run and doesn't run, so it has no tokens.
 */
export function scriptMaxTokens(source: string): number {
    const script = parse(source);
    return script.declaration.kind === 'request' ? maxTokens(script) : 0;
}

/** The most tokens one call to the contract in `source` can execute. Throws 400 unless it is a contract. */
export function contractMaxTokens(source: string): number {
    const script = parse(source);
    if (script.declaration.kind !== 'contract') {
        throw new OperationError(400, 'Invalid script: a contract call needs the contract\'s source');
    }
    return maxTokens(script);
}

// Postgres unique_violation. Drizzle wraps the pg error in DrizzleQueryError.cause.
function isUniqueViolation(error: unknown): boolean {
    const pgError = error as { code?: unknown; cause?: { code?: unknown } } | undefined;
    return pgError?.code === '23505' || pgError?.cause?.code === '23505';
}

/**
 * Bills scripts that API clients run on other organizations' listed nodes. The node authorizes a run before
 * running the script, which holds up to the client's maximum run cost on the client organization's balance.
 * Paid calls the script makes draw on that hold (see `PaymentService.authorize`). After the script, the node
 * captures the run with the tokens it executed, charged at the node's price, and the rest of the run's own
 * hold is released. Every step is idempotent per run.
 */
export class RunService {
    constructor(
        private readonly db: Database,
        private readonly organizations: OrganizationService,
        private readonly clients: ApiClientService,
        private readonly payments: PaymentService,
        private readonly tokens?: RunTokenSigner,
    ) {}

    async authorize(nodePublicKey: string, request: RunAuthorizationRequest): Promise<RunAuthorization> {
        if (!this.tokens) throw new OperationError(503, 'Run tokens are not configured on this operator');
        const claims = await this.tokens.verify(request.token, nodePublicKey);
        const client = await this.clients.get(claims.clientId);
        if (!client || client.organizationId !== claims.organizationId || client.nodePublicKey !== nodePublicKey) {
            throw new OperationError(401, 'Invalid run token');
        }
        if (client.revokedAt) {
            throw new OperationError(401, 'API client has been revoked');
        }
        const node = await this.organizations.getNode(nodePublicKey);
        if (!node || node.revokedAt) {
            throw new OperationError(403, 'Node has been revoked');
        }
        if (node.organizationId === client.organizationId) {
            throw new OperationError(422, 'Runs by the node\'s own organization are free and aren\'t authorized');
        }
        if (!node.listed) {
            throw new OperationError(403, 'Node is not listed');
        }

        const scriptTokens = scriptMaxTokens(request.source);
        const price = node.priceMicroUsdPerMillionTokens;
        const tokenBudget = tokenCharge(scriptTokens, price);
        if (tokenBudget > client.maxRunCostMicroUsd) {
            throw new OperationError(402, `The script may cost up to ${tokenBudget} micro-USD, more than the API client's maximum run cost of ${client.maxRunCostMicroUsd}`);
        }

        try {
            return await this.db.transaction(async (tx) => {
                const organizations = await lockOrganizations(tx, [client.organizationId, node.organizationId]);
                const payer = organizations.get(client.organizationId)!;
                const recipient = organizations.get(node.organizationId)!;
                if (payer.frozenAt) {
                    throw new OperationError(403, 'Payer organization is frozen');
                }
                if (price > 0 && !recipient.payoutsEnabled) {
                    throw new OperationError(422, `Organization ${recipient.id} can't receive payouts yet`);
                }

                const [existing] = await tx.select().from(runsTable).where(eq(runsTable.runId, request.runId)).limit(1);
                if (existing) {
                    // A retried authorization of the same run gets the same hold.
                    if (existing.clientId === client.id && existing.status === 'held') {
                        return { status: 'held' as const, heldMicroUsd: existing.holdMicroUsd, maxTokens: existing.maxTokens, tokenBudgetMicroUsd: existing.tokenBudgetMicroUsd };
                    }
                    throw new OperationError(409, 'Run has already been authorized');
                }

                // Holds what the client allows per run, or less when the balance or monthly cap is lower, as long as the script's tokens fit.
                const available = payer.balanceMicroUsd - payer.heldMicroUsd;
                const capRemaining = client.monthlyCapMicroUsd === null
                    ? Number.POSITIVE_INFINITY
                    : client.monthlyCapMicroUsd - await clientSpend(tx, client.id, monthStart());
                const hold = Math.max(0, Math.min(client.maxRunCostMicroUsd, available, capRemaining));
                if (hold < tokenBudget) {
                    throw new OperationError(402, capRemaining < tokenBudget
                        ? 'The API client has reached its monthly cap'
                        : `Insufficient balance: top up at ${TOP_UP_URL}`);
                }

                await tx.insert(runsTable).values({
                    runId: request.runId,
                    clientId: client.id,
                    payerOrganizationId: payer.id,
                    recipientOrganizationId: recipient.id,
                    nodePublicKey,
                    priceMicroUsdPerMillionTokens: price,
                    maxTokens: scriptTokens,
                    holdMicroUsd: hold,
                    heldMicroUsd: hold,
                    tokenBudgetMicroUsd: tokenBudget,
                    expiresAt: new Date(Date.now() + RUN_LIFETIME_MS),
                });
                await adjustOrganization(tx, payer.id, { held: hold });
                return { status: 'held' as const, heldMicroUsd: hold, maxTokens: scriptTokens, tokenBudgetMicroUsd: tokenBudget };
            });
        } catch (error) {
            // Another client's run used the same id.
            if (isUniqueViolation(error)) throw new OperationError(409, 'Run has already been authorized');
            throw error;
        }
    }

    /**
     * Authorizes a call to a contract on the calling node, paid by the voucher's signer: its organization, or
     * the run named by `voucher.runId`. Holds up to `voucher.maxAmount` for the contract's tokens at the node's
     * price, or the voucher's if lower, and for the paid calls the contract makes, which name the new run. A run's hold comes out of the
     * parent run's hold, and goes back to it when settled. Idempotent per voucher.
     */
    async authorizeContract(nodePublicKey: string, request: ContractRunAuthorizationRequest): Promise<ContractRunAuthorization> {
        const { voucher } = request;
        if (!verifySignature(contractVoucherPayload(voucher), voucher.publicKey, voucher.signature, 'voucher')) {
            throw new OperationError(401, 'Invalid voucher signature');
        }
        const expiresAt = Date.parse(voucher.expiresAt);
        if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) {
            throw new OperationError(401, 'Voucher has expired');
        }
        const node = await this.organizations.getNode(nodePublicKey);
        if (!node || node.revokedAt || node.organizationId !== voucher.recipientOrganizationId) {
            throw new OperationError(403, `This node can't collect payments for organization ${voucher.recipientOrganizationId}`);
        }
        const signer = await this.organizations.getNode(voucher.publicKey);
        if (!signer) {
            throw new OperationError(402, `Payer node is not enrolled in an organization. Enroll it at ${TOP_UP_URL}`);
        }
        if (signer.revokedAt) {
            throw new OperationError(403, 'Payer node has been revoked');
        }
        let parent: Run | undefined;
        if (voucher.runId !== undefined) {
            [parent] = await this.db.select().from(runsTable).where(eq(runsTable.runId, voucher.runId)).limit(1);
            if (!parent) {
                throw new OperationError(404, 'Voucher\'s run was never authorized');
            }
            if (parent.nodePublicKey !== voucher.publicKey) {
                throw new OperationError(403, 'Only the node running a run can spend its hold');
            }
        }
        const payerOrganizationId = parent ? parent.payerOrganizationId : signer.organizationId;
        if (payerOrganizationId === node.organizationId) {
            return { status: 'free' };
        }
        if (!node.listed) {
            throw new OperationError(403, 'Node is not listed');
        }
        // The node advertises the price it last learned, so a caller may have signed an older one. It never pays more than it signed.
        const price = Math.min(node.priceMicroUsdPerMillionTokens, voucher.priceMicroUsdPerMillionTokens);
        const contractTokens = contractMaxTokens(request.source);
        const tokenBudget = tokenCharge(contractTokens, price);

        try {
            return await this.db.transaction(async (tx) => {
                const organizations = await lockOrganizations(tx, [payerOrganizationId, node.organizationId]);
                const payer = organizations.get(payerOrganizationId)!;
                const recipient = organizations.get(node.organizationId)!;
                if (payer.frozenAt) {
                    throw new OperationError(403, 'Payer organization is frozen');
                }
                if (price > 0 && !recipient.payoutsEnabled) {
                    throw new OperationError(422, `Organization ${recipient.id} can't receive payouts yet`);
                }

                const [existing] = await tx.select().from(runsTable).where(eq(runsTable.runId, voucher.invocationId)).limit(1);
                if (existing) {
                    // A retried call with the same voucher gets the same hold.
                    if (existing.kind === 'contract' && existing.nodePublicKey === nodePublicKey && existing.status === 'held') {
                        return { status: 'held' as const, heldMicroUsd: existing.holdMicroUsd, maxTokens: existing.maxTokens, tokenBudgetMicroUsd: existing.tokenBudgetMicroUsd };
                    }
                    throw new OperationError(409, 'Voucher has already been used');
                }

                let hold: number;
                if (parent) {
                    const [locked] = await tx.select().from(runsTable).where(eq(runsTable.id, parent.id)).for('update');
                    if (locked!.status !== 'held') {
                        throw new OperationError(409, 'Voucher\'s run has already been settled');
                    }
                    // The parent's token budget stays held for its own script.
                    hold = Math.max(0, Math.min(voucher.maxAmount, locked!.heldMicroUsd - locked!.tokenBudgetMicroUsd));
                    if (hold < tokenBudget) {
                        throw new OperationError(402, 'The run\'s remaining budget can\'t cover this contract');
                    }
                    await tx.update(runsTable).set({ heldMicroUsd: locked!.heldMicroUsd - hold, updatedAt: new Date() }).where(eq(runsTable.id, parent.id));
                } else {
                    hold = Math.max(0, Math.min(voucher.maxAmount, payer.balanceMicroUsd - payer.heldMicroUsd));
                    if (hold < tokenBudget) {
                        throw new OperationError(402, `Insufficient balance: top up at ${TOP_UP_URL}`);
                    }
                    await adjustOrganization(tx, payer.id, { held: hold });
                }

                await tx.insert(runsTable).values({
                    runId: voucher.invocationId,
                    kind: 'contract',
                    parentRunId: parent?.id,
                    payerOrganizationId: payer.id,
                    recipientOrganizationId: recipient.id,
                    nodePublicKey,
                    priceMicroUsdPerMillionTokens: price,
                    maxTokens: contractTokens,
                    holdMicroUsd: hold,
                    heldMicroUsd: hold,
                    tokenBudgetMicroUsd: tokenBudget,
                    expiresAt: new Date(Math.max(expiresAt, Date.now() + RUN_LIFETIME_MS)),
                });
                return { status: 'held' as const, heldMicroUsd: hold, maxTokens: contractTokens, tokenBudgetMicroUsd: tokenBudget };
            });
        } catch (error) {
            // Another node's run used the same id.
            if (isUniqueViolation(error)) throw new OperationError(409, 'Voucher has already been used');
            throw error;
        }
    }

    /**
     * Charges the tokens the run executed, at most its `maxTokens`, at the price it was authorized at, and
     * releases the rest of its own hold. A charge of nothing releases the hold instead. Its calls' receipts
     * settle on their own.
     */
    async capture(nodePublicKey: string, request: { runId: string, tokens: number }): Promise<RunCaptureResult> {
        return this.db.transaction(async (tx) => {
            const run = await this.lockRun(tx, nodePublicKey, request.runId);
            if (run.status === 'captured') {
                return { status: 'captured' as const, amountMicroUsd: run.amountMicroUsd! };
            }
            if (run.status === 'released') {
                throw new OperationError(409, 'Run\'s hold was already released');
            }

            const tokens = Math.min(request.tokens, run.maxTokens);
            // At most the token budget, which the run's own hold always covers.
            const charge = tokenCharge(tokens, run.priceMicroUsdPerMillionTokens);
            if (charge <= 0) {
                await this.releaseHeld(tx, run, tokens);
                return { status: 'released' as const };
            }
            const fee = this.payments.fee(charge);

            await postLedgerTransaction(tx, 'run_capture', [
                { account: accounts.balance(run.payerOrganizationId), amountMicroUsd: -charge },
                { account: accounts.payable(run.recipientOrganizationId), amountMicroUsd: charge - fee },
                { account: accounts.revenue, amountMicroUsd: fee },
            ], { runId: run.id });
            await adjustOrganization(tx, run.payerOrganizationId, { balance: -charge, held: -charge });
            await this.returnHold(tx, run, run.heldMicroUsd - charge);
            await adjustOrganization(tx, run.recipientOrganizationId, { payable: charge - fee });
            await tx.update(runsTable).set({
                status: 'captured',
                heldMicroUsd: 0,
                tokens,
                amountMicroUsd: charge,
                feeMicroUsd: fee,
                capturedAt: new Date(),
                updatedAt: new Date(),
            }).where(eq(runsTable.id, run.id));
            return { status: 'captured' as const, amountMicroUsd: charge };
        });
    }

    /** Releases a held run's own hold without charging it, for a script the node failed to run. */
    async release(nodePublicKey: string, request: { runId: string }): Promise<{ status: 'released' }> {
        return this.db.transaction(async (tx) => {
            const run = await this.lockRun(tx, nodePublicKey, request.runId);
            if (run.status === 'captured') {
                throw new OperationError(409, 'Run was already captured');
            }
            if (run.status === 'held') {
                await this.releaseHeld(tx, run);
            }
            return { status: 'released' as const };
        });
    }

    /** Releases runs that expired more than `HOLD_GRACE_MS` before `now`. Returns how many. */
    async releaseExpiredRuns(now: Date = new Date()): Promise<number> {
        // Newest first, so a contract's run returns its hold to its parent before the parent is released.
        const expired = await this.db.select().from(runsTable).where(and(
            eq(runsTable.status, 'held'),
            lt(runsTable.expiresAt, new Date(now.getTime() - HOLD_GRACE_MS)),
        )).orderBy(desc(runsTable.id));
        let released = 0;
        for (const candidate of expired) {
            await this.db.transaction(async (tx) => {
                await lockOrganizations(tx, [candidate.payerOrganizationId, candidate.recipientOrganizationId]);
                const [run] = await tx.select().from(runsTable).where(eq(runsTable.id, candidate.id)).for('update');
                // Captured or released since the scan.
                if (run?.status !== 'held') return;
                await this.releaseHeld(tx, run);
                released++;
            });
        }
        return released;
    }

    /**
     * The run, with its organizations and then its own row locked, the order `authorize` and
     * `PaymentService.authorize` lock in. Throws unless the run is the signing node's.
     */
    private async lockRun(tx: Transaction, nodePublicKey: string, runId: string): Promise<Run> {
        const [found] = await tx.select().from(runsTable).where(eq(runsTable.runId, runId)).limit(1);
        if (!found) {
            throw new OperationError(404, 'Run was never authorized');
        }
        if (found.nodePublicKey !== nodePublicKey) {
            throw new OperationError(403, 'Only the node that authorized a run can settle it');
        }
        await lockOrganizations(tx, [found.payerOrganizationId, found.recipientOrganizationId]);
        const [run] = await tx.select().from(runsTable).where(eq(runsTable.id, found.id)).for('update');
        return run!;
    }

    /** Call with the run's organizations and row locked. */
    private async releaseHeld(tx: Transaction, run: Run, tokens?: number): Promise<void> {
        await this.returnHold(tx, run, run.heldMicroUsd);
        await tx.update(runsTable)
            .set({ status: 'released', heldMicroUsd: 0, tokens, releasedAt: new Date(), updatedAt: new Date() })
            .where(eq(runsTable.id, run.id));
    }

    /**
     * Gives back `amount` of a settled run's hold: to its parent run's hold while the parent is still held,
     * since it came from there, and otherwise to the payer's available balance.
     */
    private async returnHold(tx: Transaction, run: Run, amount: number): Promise<void> {
        if (run.parentRunId !== null) {
            const [parent] = await tx.select().from(runsTable).where(eq(runsTable.id, run.parentRunId)).for('update');
            if (parent?.status === 'held') {
                await tx.update(runsTable).set({ heldMicroUsd: parent.heldMicroUsd + amount, updatedAt: new Date() }).where(eq(runsTable.id, parent.id));
                return;
            }
        }
        await adjustOrganization(tx, run.payerOrganizationId, { held: -amount });
    }
}
