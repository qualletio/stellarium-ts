import { and, asc, desc, eq, isNotNull, isNull, lt, or } from "drizzle-orm";
import { hashData } from "../crypto.js";
import type { Database } from "../db/database.js";
import {
    alertsTable, authMembersTable, authOrganizationsTable, authUsersTable, banAppealsTable, checkpointsTable, pausedUsersTable, paymentFlagsTable, contractFundingTable, contractMoneyLogTable, contractStateChainTable, contractVersionsTable,
    fraudCasesTable, nodesTable, organizationsTable, runsTable, staffActionsTable, type StaffActionKind, verificationReviewsTable,
} from "../db/schema.js";
import { OperationError } from "../errors.js";
import type { OrganizationService } from "../organizations.js";
import type { RunTokenSigner } from "../runs/tokens.js";
import type { Mailer } from "../auth/email.js";
import type { FraudService } from "../verification/fraudService.js";
import type { MoneyService } from "../money/moneyService.js";
import type { AuditLog } from "./audit.js";

export type StaffAction = typeof staffActionsTable.$inferSelect;
export type BanAppeal = typeof banAppealsTable.$inferSelect;

/** Staff members by API key, from `STAFF_API_KEYS` (`name:key,name:key`). */
export function parseStaffKeys(value: string | undefined): Map<string, string> {
    const staff = new Map<string, string>();
    for (const entry of (value ?? '').split(',').map(part => part.trim()).filter(Boolean)) {
        const at = entry.indexOf(':');
        if (at <= 0 || at === entry.length - 1) throw new Error('STAFF_API_KEYS is name:key pairs, separated by commas');
        staff.set(entry.slice(at + 1), entry.slice(0, at));
    }
    return staff;
}

/**
 * Checks an organization against sanctions lists (docs/money.md, Stripe's conditions). The operator has no
 * provider of its own: one plugs in through `ServiceConfig.sanctionsScreener`. `unknown` leaves it for next time.
 */
export interface SanctionsScreener {
    screen(organization: typeof organizationsTable.$inferSelect): Promise<'clear' | 'match' | 'unknown'>;
}

export interface CheckpointSummary {
    contracts: { id: number, balanceMicroUsd: number }[];
    fundingHash: string;
    moneyLog: { entries: number, hash: string };
    stateChainHash: string;
    at: string;
}

/**
 * Staff governance (docs/money.md, Trust and Appeals): staff actions, two-person approval for the sensitive ones,
 * bans and their one appeal, review decisions, and signed checkpoints. Every action is in the audit log.
 */
export class GovernanceService {
    constructor(
        private readonly db: Database,
        private readonly organizations: OrganizationService,
        private readonly fraud: FraudService,
        private readonly audit: AuditLog,
        private readonly money: MoneyService,
        private readonly signer?: RunTokenSigner,
        private readonly mailer?: Mailer,
        private readonly screener?: SanctionsScreener,
    ) {}

    /** How many distinct staff members must approve an action, its proposer included. */
    private async approvalsNeeded(kind: StaffActionKind, payload: Record<string, unknown>): Promise<number> {
        switch (kind) {
            case 'ban':
            case 'uphold_appeal':
                return 2;
            case 'decide_review':
                return payload.decision === 'host_fault' ? 2 : 1;
            case 'close_organization':
            case 'clear_sanctions':
                return 2;
            case 'set_node_limits': {
                const [node] = await this.db.select().from(nodesTable).where(eq(nodesTable.publicKey, String(payload.publicKey))).limit(1);
                const raised = Number((payload.limits as Record<string, unknown> | undefined)?.maxContractBalanceMicroUsd ?? -1);
                return node && raised > node.maxContractBalanceMicroUsd ? 2 : 1;
            }
            default:
                return 1;
        }
    }

    /**
     * Proposes an action. A staff member's proposal counts as their approval, so an action that needs one approval
     * runs at once. The operator's own proposals need every approval from staff.
     */
    async propose(proposedBy: string, kind: StaffActionKind, payload: Record<string, unknown>, reason: string, organization: string | null = null): Promise<StaffAction> {
        // The organization an action is about is in its audit entries, so the organization can read them.
        const organizationId = organization ?? (typeof payload.organizationId === 'string' ? payload.organizationId : null);
        const [action] = await this.db.insert(staffActionsTable).values({
            kind, payload, reason: reason.slice(0, 4096), organizationId, proposedBy,
            approvedBy: proposedBy === 'operator' ? null : proposedBy,
        }).returning();
        await this.audit.record(proposedBy, `propose_${kind}`, organizationId, { actionId: action!.id, payload, reason });
        return this.maybeExecute(action!);
    }

    /** The operator found fraud: a ban, for two staff members to approve. */
    async proposeBan(organizationId: string, reason: string, proposedBy: string): Promise<void> {
        const [pending] = await this.db.select().from(staffActionsTable).where(and(
            eq(staffActionsTable.kind, 'ban'), eq(staffActionsTable.organizationId, organizationId), eq(staffActionsTable.status, 'proposed'),
        )).limit(1);
        if (pending) return;
        await this.propose(proposedBy, 'ban', { organizationId }, reason, organizationId);
    }

    /** Approves a proposed action as another staff member. Runs it once enough have. */
    async approve(id: number, staff: string): Promise<StaffAction> {
        const action = await this.proposed(id);
        const approvers = this.approvers(action);
        if (approvers.includes(staff)) throw new OperationError(409, 'You have already approved this action; another staff member must');
        const [updated] = await this.db.update(staffActionsTable)
            .set({ approvedBy: [...approvers, staff].join(',') })
            .where(and(eq(staffActionsTable.id, id), eq(staffActionsTable.status, 'proposed')))
            .returning();
        await this.audit.record(staff, `approve_${action.kind}`, action.organizationId, { actionId: id });
        return this.maybeExecute(updated!);
    }

    async reject(id: number, staff: string): Promise<StaffAction> {
        const action = await this.proposed(id);
        const [updated] = await this.db.update(staffActionsTable).set({ status: 'rejected', decidedAt: new Date() })
            .where(and(eq(staffActionsTable.id, id), eq(staffActionsTable.status, 'proposed'))).returning();
        await this.audit.record(staff, `reject_${action.kind}`, action.organizationId, { actionId: id });
        return updated!;
    }

    private approvers(action: StaffAction): string[] {
        return action.approvedBy ? action.approvedBy.split(',') : [];
    }

    private async proposed(id: number): Promise<StaffAction> {
        const [action] = await this.db.select().from(staffActionsTable).where(eq(staffActionsTable.id, id)).limit(1);
        if (!action) throw new OperationError(404, 'No such staff action');
        if (action.status !== 'proposed') throw new OperationError(409, `The action was already ${action.status}`);
        return action;
    }

    private async maybeExecute(action: StaffAction): Promise<StaffAction> {
        const payload = action.payload as Record<string, unknown>;
        if (this.approvers(action).length < await this.approvalsNeeded(action.kind, payload)) return action;
        await this.execute(action, payload);
        const [done] = await this.db.update(staffActionsTable).set({ status: 'executed', decidedAt: new Date() })
            .where(eq(staffActionsTable.id, action.id)).returning();
        await this.audit.record(this.approvers(action).join(','), `execute_${action.kind}`, action.organizationId, { actionId: action.id, payload, reason: action.reason });
        return done!;
    }

    private async execute(action: StaffAction, payload: Record<string, unknown>): Promise<void> {
        switch (action.kind) {
            case 'ban':
                return this.ban(String(payload.organizationId), action.reason);
            case 'lift_ban':
            case 'overturn_appeal':
                return this.liftBan(String(payload.organizationId), action.kind === 'overturn_appeal' ? 'overturned' : undefined);
            case 'uphold_appeal':
                return this.upholdAppeal(String(payload.organizationId));
            case 'set_node_limits':
                return this.organizations.setNodeMoneyLimits(String(payload.publicKey), payload.limits as Parameters<OrganizationService['setNodeMoneyLimits']>[1]);
            case 'decide_review':
                return this.decideReview(Number(payload.reviewId), payload.decision === 'host_fault' ? 'host_fault' : 'runtime_fault', this.approvers(action).join(','));
            case 'verify_identity':
                await this.db.update(organizationsTable).set({ identityVerifiedAt: new Date() }).where(eq(organizationsTable.id, String(payload.organizationId)));
                return;
            case 'block_sanctions':
                await this.db.update(organizationsTable).set({ sanctionsBlockedAt: new Date() }).where(eq(organizationsTable.id, String(payload.organizationId)));
                return;
            case 'clear_sanctions':
                await this.db.update(organizationsTable).set({ sanctionsBlockedAt: null }).where(eq(organizationsTable.id, String(payload.organizationId)));
                return;
            case 'close_organization':
                return this.close(String(payload.organizationId));
            case 'clear_payment_flag':
                await this.db.update(paymentFlagsTable).set({ status: 'cleared', clearedBy: this.approvers(action).join(',') }).where(eq(paymentFlagsTable.id, Number(payload.flagId)));
                return;
            case 'acknowledge_alert':
                await this.db.update(alertsTable).set({ acknowledgedAt: new Date(), acknowledgedBy: this.approvers(action).join(',') }).where(eq(alertsTable.id, Number(payload.alertId)));
                return;
        }
    }

    /**
     * Closes an organization, the operator's version of deleting it (docs/money.md, Funding): its unspent contract
     * funding goes back to its prepaid balance first, so refunds always have somewhere to go, then its nodes are
     * suspended and it can't run, pay or be paid.
     */
    private async close(organizationId: string): Promise<void> {
        const refunded = await this.money.recoverFromFunding(organizationId, Number.MAX_SAFE_INTEGER, 'funding_returned');
        await this.db.transaction(async (tx) => {
            await tx.update(organizationsTable).set({ closedAt: new Date(), updatedAt: new Date() }).where(eq(organizationsTable.id, organizationId));
            await tx.update(nodesTable).set({ suspendedAt: new Date() }).where(and(eq(nodesTable.organizationId, organizationId), isNull(nodesTable.suspendedAt)));
        });
        await this.money.notify?.(organizationId, 'organization_closed', { refundedMicroUsd: refunded }).catch(() => undefined);
    }

    /**
     * Screens organizations that haven't been for 30 days with the configured screener: a match blocks them until
     * staff clear it. Returns how many matched.
     */
    async screenSanctions(now: Date = new Date()): Promise<number> {
        if (!this.screener) return 0;
        const stale = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
        const due = await this.db.select().from(organizationsTable)
            .where(and(isNull(organizationsTable.sanctionsBlockedAt), or(isNull(organizationsTable.sanctionsScreenedAt), lt(organizationsTable.sanctionsScreenedAt, stale))))
            .limit(100);
        let matched = 0;
        for (const organization of due) {
            const result = await this.screener.screen(organization).catch(() => 'unknown' as const);
            if (result === 'unknown') continue;
            await this.db.update(organizationsTable).set({ sanctionsScreenedAt: now, ...(result === 'match' ? { sanctionsBlockedAt: now } : {}) }).where(eq(organizationsTable.id, organization.id));
            if (result === 'match') {
                matched++;
                await this.audit.record('operator', 'sanctions_match', organization.id, { name: organization.name });
            }
        }
        return matched;
    }

    /**
     * Bans an organization: its nodes are suspended, its clients can't get tokens, and it isn't paid out. Its owners'
     * and admins' accounts are paused, and the owners of their other organizations are told, to decide for themselves.
     */
    private async ban(organizationId: string, reason: string): Promise<void> {
        const leaders = await this.leaders(organizationId);
        await this.db.transaction(async (tx) => {
            await tx.update(organizationsTable).set({ bannedAt: new Date(), banReason: reason.slice(0, 2048), updatedAt: new Date() })
                .where(eq(organizationsTable.id, organizationId));
            await tx.update(nodesTable).set({ suspendedAt: new Date() }).where(and(eq(nodesTable.organizationId, organizationId), isNull(nodesTable.suspendedAt)));
            if (leaders.length > 0) {
                await tx.insert(pausedUsersTable).values(leaders.map(leader => ({ userId: leader.userId, organizationId })));
            }
        });
        await this.notifyOtherOrganizations(organizationId, leaders);
    }

    /** The banned organization's owners and admins in the dashboard, with their names. */
    private async leaders(organizationId: string): Promise<{ userId: string, name: string, email: string }[]> {
        const [organization] = await this.db.select().from(organizationsTable).where(eq(organizationsTable.id, organizationId)).limit(1);
        if (!organization?.authOrganizationId) return [];
        const members = await this.db.select({ userId: authMembersTable.userId, role: authMembersTable.role, name: authUsersTable.name, email: authUsersTable.email })
            .from(authMembersTable).innerJoin(authUsersTable, eq(authUsersTable.id, authMembersTable.userId))
            .where(eq(authMembersTable.organizationId, organization.authOrganizationId));
        return members.filter(member => member.role.split(',').some(role => role.trim() === 'owner' || role.trim() === 'admin'));
    }

    private async notifyOtherOrganizations(organizationId: string, leaders: { userId: string, name: string, email: string }[]): Promise<void> {
        if (!this.mailer || leaders.length === 0) return;
        const [banned] = await this.db.select().from(organizationsTable).where(eq(organizationsTable.id, organizationId)).limit(1);
        for (const leader of leaders) {
            const memberships = await this.db.select({ organizationId: authMembersTable.organizationId, name: authOrganizationsTable.name })
                .from(authMembersTable).innerJoin(authOrganizationsTable, eq(authOrganizationsTable.id, authMembersTable.organizationId))
                .where(eq(authMembersTable.userId, leader.userId));
            for (const membership of memberships.filter(entry => entry.organizationId !== banned?.authOrganizationId)) {
                const owners = await this.db.select({ email: authUsersTable.email }).from(authMembersTable)
                    .innerJoin(authUsersTable, eq(authUsersTable.id, authMembersTable.userId))
                    .where(and(eq(authMembersTable.organizationId, membership.organizationId), eq(authMembersTable.role, 'owner')));
                for (const owner of owners.filter(entry => entry.email !== leader.email)) {
                    await this.mailer.send({
                        to: owner.email,
                        subject: `A member of ${membership.name} was in an organization banned on Stellarium`,
                        text: `${leader.name} (${leader.email}), a member of ${membership.name}, is an owner or admin of ${banned?.name ?? 'an organization'}, which Stellarium banned after finding fraud in a contract run its node hosted. ${leader.name} keeps their role in ${membership.name}; decide for yourselves whether to change it.`,
                    });
                }
            }
        }
    }

    /** Whether a dashboard user's account is paused by a ban, so they can't create organizations. */
    async isPaused(userId: string): Promise<boolean> {
        const [paused] = await this.db.select({ id: pausedUsersTable.id }).from(pausedUsersTable)
            .where(and(eq(pausedUsersTable.userId, userId), isNull(pausedUsersTable.liftedAt))).limit(1);
        return paused !== undefined;
    }

    /** Lifts a ban and the suspension of the organization's nodes. Refunds already made to payers stand. */
    private async liftBan(organizationId: string, appeal?: 'overturned'): Promise<void> {
        await this.db.transaction(async (tx) => {
            await tx.update(organizationsTable).set({ bannedAt: null, banReason: null, updatedAt: new Date() }).where(eq(organizationsTable.id, organizationId));
            await tx.update(pausedUsersTable).set({ liftedAt: new Date() }).where(and(eq(pausedUsersTable.organizationId, organizationId), isNull(pausedUsersTable.liftedAt)));
            await tx.update(nodesTable).set({ suspendedAt: null }).where(and(eq(nodesTable.organizationId, organizationId), isNull(nodesTable.revokedAt)));
            if (appeal) {
                await tx.update(banAppealsTable).set({ status: appeal, decidedAt: new Date() })
                    .where(and(eq(banAppealsTable.organizationId, organizationId), eq(banAppealsTable.status, 'open')));
            }
        });
    }

    /** The ban stands, and the organization's nodes are revoked for good. */
    private async upholdAppeal(organizationId: string): Promise<void> {
        await this.db.transaction(async (tx) => {
            await tx.update(banAppealsTable).set({ status: 'upheld', decidedAt: new Date() })
                .where(and(eq(banAppealsTable.organizationId, organizationId), eq(banAppealsTable.status, 'open')));
            await tx.update(nodesTable).set({ revokedAt: new Date() }).where(and(eq(nodesTable.organizationId, organizationId), isNull(nodesTable.revokedAt)));
        });
    }

    /**
     * A review's decision. The host at fault: the tree is fraud. The runtime at fault: the tree is verified, so its
     * payments are released, and the node's hosting is restored.
     */
    private async decideReview(reviewId: number, decision: 'host_fault' | 'runtime_fault', staff: string): Promise<void> {
        const [review] = await this.db.select().from(verificationReviewsTable).where(eq(verificationReviewsTable.id, reviewId)).limit(1);
        if (!review || review.status !== 'open') throw new OperationError(409, 'The review is not open');
        await this.db.update(verificationReviewsTable).set({ status: decision, decidedBy: staff, decidedAt: new Date() }).where(eq(verificationReviewsTable.id, reviewId));
        if (decision === 'host_fault') {
            await this.fraud.recordFraud(review.rootRunId, review.nodePublicKey, `Review ${reviewId}: ${review.reason}`, 'review', staff);
            return;
        }
        // Held for review before its money moved: it moves now.
        const [root] = await this.db.select().from(runsTable).where(eq(runsTable.id, review.rootRunId)).limit(1);
        if (root?.treeOutcome === 'verifying') await this.money.applyVerified(review.rootRunId);
        await this.db.update(runsTable).set({ verification: 'verified', verifiedAt: new Date(), updatedAt: new Date() }).where(eq(runsTable.id, review.rootRunId));
        const [open] = await this.db.select().from(verificationReviewsTable).where(and(
            eq(verificationReviewsTable.nodePublicKey, review.nodePublicKey), eq(verificationReviewsTable.status, 'open'),
        )).limit(1);
        const [node] = await this.db.select().from(nodesTable).where(eq(nodesTable.publicKey, review.nodePublicKey)).limit(1);
        const [organization] = node ? await this.db.select().from(organizationsTable).where(eq(organizationsTable.id, node.organizationId)).limit(1) : [];
        // Still suspended while another review is open, or its organization is banned.
        if (!open && !organization?.bannedAt) {
            await this.db.update(nodesTable).set({ suspendedAt: null }).where(eq(nodesTable.publicKey, review.nodePublicKey));
        }
    }

    // ---- Appeals ----

    /** A banned organization's owner appeals its ban, once. */
    async appeal(organizationId: string, statement: string, createdBy: string): Promise<BanAppeal> {
        const [organization] = await this.db.select().from(organizationsTable).where(eq(organizationsTable.id, organizationId)).limit(1);
        if (!organization?.bannedAt) throw new OperationError(409, 'The organization is not banned');
        const [appeal] = await this.db.insert(banAppealsTable).values({
            organizationId, bannedAt: organization.bannedAt, statement: statement.slice(0, 8192), createdBy,
        }).onConflictDoNothing().returning();
        if (!appeal) throw new OperationError(409, 'The ban has already been appealed');
        await this.audit.record(createdBy, 'appeal', organizationId, { appealId: appeal.id });
        return appeal;
    }

    /** The organization's ban, its appeal, and what fraud was found, for its dashboard. */
    async banStatus(organizationId: string) {
        const [organization] = await this.db.select().from(organizationsTable).where(eq(organizationsTable.id, organizationId)).limit(1);
        if (!organization?.bannedAt) return { banned: false as const };
        const [appeal] = await this.db.select().from(banAppealsTable).where(and(
            eq(banAppealsTable.organizationId, organizationId), eq(banAppealsTable.bannedAt, organization.bannedAt),
        )).limit(1);
        const cases = await this.db.select().from(fraudCasesTable).where(eq(fraudCasesTable.organizationId, organizationId)).orderBy(desc(fraudCasesTable.id));
        return { banned: true as const, bannedAt: organization.bannedAt, reason: organization.banReason, appeal: appeal ?? null, fraudCases: cases };
    }

    // ---- Staff views ----

    async openReviews() {
        return this.db.select().from(verificationReviewsTable).where(eq(verificationReviewsTable.status, 'open')).orderBy(asc(verificationReviewsTable.id));
    }

    async actions(status?: 'proposed' | 'executed' | 'rejected') {
        return this.db.select().from(staffActionsTable).where(status ? eq(staffActionsTable.status, status) : undefined).orderBy(desc(staffActionsTable.id)).limit(200);
    }

    async openAppeals() {
        return this.db.select().from(banAppealsTable).where(eq(banAppealsTable.status, 'open')).orderBy(asc(banAppealsTable.id));
    }

    async openPaymentFlags() {
        return this.db.select().from(paymentFlagsTable).where(eq(paymentFlagsTable.status, 'open')).orderBy(asc(paymentFlagsTable.id));
    }

    async fraudCases() {
        return this.db.select().from(fraudCasesTable).orderBy(desc(fraudCasesTable.id)).limit(200);
    }

    // ---- Checkpoints ----

    /**
     * Publishes a signed hash of every contract account's balance and funding, the money log and the state hash
     * chains (docs/money.md, Trust). Anyone holding entries can check them against it later.
     */
    async checkpoint(now: Date = new Date()): Promise<typeof checkpointsTable.$inferSelect> {
        if (!this.signer) throw new OperationError(503, 'The operator has no signing key configured');
        const contracts = await this.db.select({ id: contractVersionsTable.id, balanceMicroUsd: contractVersionsTable.balanceMicroUsd })
            .from(contractVersionsTable).orderBy(asc(contractVersionsTable.id));
        const funding = await this.db.select({ id: contractFundingTable.id, contractId: contractFundingTable.contractId, funder: contractFundingTable.funderOrganizationId, key: contractFundingTable.key, amount: contractFundingTable.amountMicroUsd })
            .from(contractFundingTable).where(eq(contractFundingTable.status, 'active')).orderBy(asc(contractFundingTable.id));
        const log = await this.db.select().from(contractMoneyLogTable).orderBy(asc(contractMoneyLogTable.id));
        const chains = await this.db.select().from(contractStateChainTable)
            .orderBy(asc(contractStateChainTable.nodePublicKey), asc(contractStateChainTable.name), asc(contractStateChainTable.variable), asc(contractStateChainTable.scopeKey));
        const summary: CheckpointSummary = {
            contracts,
            fundingHash: hashData(funding),
            moneyLog: { entries: log.length, hash: hashData(log.map(entry => [entry.id, entry.contractId, entry.kind, entry.amountMicroUsd, entry.funderOrganizationId, entry.counterpartyOrganizationId, entry.counterpartyContractId, entry.runId])) },
            stateChainHash: hashData(chains.map(chain => [chain.nodePublicKey, chain.name, chain.variable, chain.scopeKey, chain.version, chain.valueHash])),
            at: now.toISOString(),
        };
        const hash = hashData(summary);
        const [checkpoint] = await this.db.insert(checkpointsTable).values({
            hash, summary, signature: this.signer.signPayload({ hash }), publicKey: this.signer.publicKeySpki,
        }).returning();
        return checkpoint!;
    }

    async latestCheckpoint() {
        const [checkpoint] = await this.db.select().from(checkpointsTable).orderBy(desc(checkpointsTable.id)).limit(1);
        return checkpoint;
    }

    /** Whether a checkpoint is due: none yet, or the last is older than `intervalMs`. */
    async checkpointDue(intervalMs: number, now: Date = new Date()): Promise<boolean> {
        const latest = await this.latestCheckpoint();
        return !latest || now.getTime() - latest.createdAt.getTime() >= intervalMs;
    }

    /** Banned organizations, for staff. */
    async bannedOrganizations() {
        return this.db.select().from(organizationsTable).where(isNotNull(organizationsTable.bannedAt));
    }
}
