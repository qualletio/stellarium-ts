import { and, eq, gte, inArray, isNotNull, isNull, lt, sql } from "drizzle-orm";
import type { Database } from "../db/database.js";
import { alertsTable, contractVersionsTable, moneyChangesTable, nodesTable, runsTable } from "../db/schema.js";
import type { AuditLog } from "./audit.js";

export type Alert = typeof alertsTable.$inferSelect;

export interface AlertPolicy {
    /** A node's contracts paying its own organization more than this in a day. */
    selfPaymentMicroUsd: number;
    /** A day's outflows from a node's contracts above this, and `outflowJumpFactor` times its daily average over the week before. */
    outflowJumpMinMicroUsd: number;
    outflowJumpFactor: number;
    /** More than this share of a node's money-moving trees dropped in a week, of at least `releaseRateMinTrees`. */
    releaseRate: number;
    releaseRateMinTrees: number;
}

export const DEFAULT_ALERT_POLICY: AlertPolicy = {
    selfPaymentMicroUsd: 1_000 * 1_000_000,
    outflowJumpMinMicroUsd: 1_000 * 1_000_000,
    outflowJumpFactor: 5,
    releaseRate: 0.5,
    releaseRateMinTrees: 10,
};

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Watches what nodes' contracts do with money (docs/money.md, Trust): paying their own organization, outflows that
 * jump, and hosts that drop an unusual share of their money-moving runs, as one that retried runs until it liked
 * them would. Each becomes an alert for staff, one open at a time per kind and node.
 */
export class AlertService {
    constructor(private readonly db: Database, private readonly audit: AuditLog, private readonly policy: AlertPolicy = DEFAULT_ALERT_POLICY) {}

    /** Checks every node with contracts. Returns the alerts it raised. */
    async check(now: Date = new Date()): Promise<Alert[]> {
        const hosts = await this.db.selectDistinct({ publicKey: contractVersionsTable.nodePublicKey, organizationId: nodesTable.organizationId })
            .from(contractVersionsTable).innerJoin(nodesTable, eq(nodesTable.publicKey, contractVersionsTable.nodePublicKey));
        const raised: Alert[] = [];
        const dayAgo = new Date(now.getTime() - DAY_MS);
        const weekAgo = new Date(now.getTime() - 7 * DAY_MS);
        for (const host of hosts) {
            const outflows = (from: Date, to: Date, payee?: string) => this.db.select({ total: sql<string>`coalesce(sum(${moneyChangesTable.amountMicroUsd}), 0)` })
                .from(moneyChangesTable)
                .innerJoin(contractVersionsTable, eq(contractVersionsTable.id, moneyChangesTable.contractId))
                .where(and(
                    eq(contractVersionsTable.nodePublicKey, host.publicKey),
                    eq(moneyChangesTable.status, 'applied'),
                    inArray(moneyChangesTable.function, payee ? ['pay'] : ['pay', 'refund', 'attach']),
                    gte(moneyChangesTable.settledAt, from),
                    lt(moneyChangesTable.settledAt, to),
                    ...(payee ? [eq(moneyChangesTable.recipientOrganizationId, payee)] : []),
                )).then(([row]) => Number(row!.total));

            const selfPaid = await outflows(dayAgo, now, host.organizationId);
            if (selfPaid > this.policy.selfPaymentMicroUsd) {
                raised.push(...await this.raise('self_payment', host, { paidMicroUsd: selfPaid, sinceHours: 24 }));
            }
            const today = await outflows(dayAgo, now);
            const before = await outflows(weekAgo, dayAgo) / 6;
            if (today > this.policy.outflowJumpMinMicroUsd && today > this.policy.outflowJumpFactor * before) {
                raised.push(...await this.raise('outflow_jump', host, { todayMicroUsd: today, dailyAverageMicroUsd: Math.round(before) }));
            }
            // Trees rooted at the host that staged money, settled this week: how many were dropped.
            const trees = await this.db.selectDistinct({ id: runsTable.id, outcome: runsTable.treeOutcome }).from(runsTable)
                .innerJoin(moneyChangesTable, eq(moneyChangesTable.rootRunId, runsTable.id))
                .where(and(eq(runsTable.nodePublicKey, host.publicKey), isNull(runsTable.rootRunId), isNotNull(runsTable.treeOutcome), gte(runsTable.updatedAt, weekAgo)));
            const settled = trees.filter(tree => tree.outcome === 'applied' || tree.outcome === 'dropped');
            const dropped = settled.filter(tree => tree.outcome === 'dropped').length;
            if (settled.length >= this.policy.releaseRateMinTrees && dropped / settled.length > this.policy.releaseRate) {
                raised.push(...await this.raise('release_rate', host, { dropped, settled: settled.length }));
            }
        }
        return raised;
    }

    private async raise(kind: Alert['kind'], host: { publicKey: string, organizationId: string }, details: Record<string, unknown>): Promise<Alert[]> {
        const [open] = await this.db.select().from(alertsTable)
            .where(and(eq(alertsTable.kind, kind), eq(alertsTable.nodePublicKey, host.publicKey), isNull(alertsTable.acknowledgedAt))).limit(1);
        if (open) return [];
        const [alert] = await this.db.insert(alertsTable).values({ kind, nodePublicKey: host.publicKey, organizationId: host.organizationId, details }).returning();
        await this.audit.record('operator', `alert_${kind}`, host.organizationId, { alertId: alert!.id, nodePublicKey: host.publicKey, ...details });
        return [alert!];
    }

    async open(): Promise<Alert[]> {
        return this.db.select().from(alertsTable).where(isNull(alertsTable.acknowledgedAt));
    }
}
