import { and, eq, inArray, isNull } from "drizzle-orm";
import type { Database } from "../db/database.js";
import {
    contractFundingTable, contractMoneyLogTable, contractVersionsTable, fraudCasesTable, moneyChangesTable, nodesTable, runsTable,
} from "../db/schema.js";
import type { AuditLog } from "../governance/audit.js";
import { accounts, adjustOrganization, lockOrganizations, postLedgerTransaction } from "../ledger.js";
import type { MoneyService } from "../money/moneyService.js";

/** Proposes a ban for staff to approve. Set once governance exists, which depends on fraud handling. */
export interface BanProposer {
    proposeBan(organizationId: string, reason: string, proposedBy: string): Promise<void>;
}

/**
 * Handles a tree found fraudulent (docs/money.md, Fraud): reverses its payments, which are still held since no
 * unverified tree is paid out, straight back to the organizations that funded them; suspends its host
 * organization's nodes; closes every contract they host, refunding their funding to its original funders; and
 * proposes a ban, which needs two staff members' approval. Receipts stay as evidence.
 */
export class FraudService {
    bans?: BanProposer;

    constructor(private readonly db: Database, private readonly money: MoneyService, private readonly audit: AuditLog) {}

    async recordFraud(rootRunId: number, nodePublicKey: string, reason: string, kind: 'proof' | 'review', actor: string): Promise<void> {
        const [node] = await this.db.select().from(nodesTable).where(eq(nodesTable.publicKey, nodePublicKey)).limit(1);
        const organizationId = node!.organizationId;
        // A tree caught before its money moved is dropped, and there's nothing to reverse.
        const [root] = await this.db.select().from(runsTable).where(eq(runsTable.id, rootRunId)).limit(1);
        if (root?.treeOutcome === 'verifying') await this.money.dropUnverified(rootRunId);
        const { reversed, recovered, shortfall } = await this.reverse(rootRunId, organizationId);
        await this.db.transaction(async (tx) => {
            await tx.update(runsTable).set({ verification: 'failed', updatedAt: new Date() }).where(eq(runsTable.id, rootRunId));
            await tx.insert(fraudCasesTable).values({
                rootRunId, organizationId, nodePublicKey, kind, reason: reason.slice(0, 4096),
                reversedMicroUsd: reversed, recoveredMicroUsd: recovered, shortfallMicroUsd: shortfall,
            });
            await tx.update(nodesTable).set({ suspendedAt: new Date() }).where(and(eq(nodesTable.organizationId, organizationId), isNull(nodesTable.suspendedAt)));
        });
        await this.audit.record(actor, 'fraud_found', organizationId, { rootRunId, nodePublicKey, kind, reason, reversedMicroUsd: reversed, recoveredMicroUsd: recovered, shortfallMicroUsd: shortfall });
        await this.closeContracts(organizationId, actor);
        await this.bans?.proposeBan(organizationId, `Fraud (${kind}): ${reason}`, actor);
    }

    /**
     * Returns everything the tree paid out to the organizations whose funding it was (docs/money.md, Fraud). The
     * money comes from the payee's credit, which payouts held, then from the fraudulent organization's payable and
     * prepaid balances, and the platform's revenue covers any shortfall, which becomes the fraudster's debt.
     */
    private async reverse(rootRunId: number, fraudulent: string): Promise<{ reversed: number, recovered: number, shortfall: number }> {
        const pays = await this.db.select().from(moneyChangesTable).where(and(
            eq(moneyChangesTable.rootRunId, rootRunId),
            eq(moneyChangesTable.status, 'applied'),
            eq(moneyChangesTable.function, 'pay'),
        ));
        const totals = { reversed: 0, recovered: 0, shortfall: 0 };
        const notices: { organizationId: string, kind: string, details: Record<string, unknown> }[] = [];
        for (const pay of pays.filter(change => change.amountMicroUsd > 0)) {
            const lots = await this.db.select().from(contractFundingTable).where(inArray(contractFundingTable.id, pay.allocations.map(a => a.fundingId)));
            const funderOf = new Map(lots.map(lot => [lot.id, lot.funderOrganizationId]));
            const payee = pay.recipientOrganizationId!;
            const fee = pay.feeMicroUsd ?? 0;
            const net = pay.amountMicroUsd - fee;
            await this.db.transaction(async (tx) => {
                const organizations = await lockOrganizations(tx, [payee, fraudulent, ...funderOf.values()]);
                // The payee's credit is held until the tree is verified, so it's normally all there.
                const fromPayee = Math.min(net, Math.max(0, organizations.get(payee)!.payableMicroUsd));
                let owed = net - fromPayee;
                const fraudster = organizations.get(fraudulent)!;
                // The payee and the fraudster may be the same organization, whose payable balance was just used.
                const fraudsterPayable = Math.max(0, fraudster.payableMicroUsd - (payee === fraudulent ? fromPayee : 0));
                const fromFraudsterPayable = Math.min(owed, fraudsterPayable);
                owed -= fromFraudsterPayable;
                const fromFraudsterBalance = Math.min(owed, Math.max(0, fraudster.balanceMicroUsd - fraudster.heldMicroUsd));
                owed -= fromFraudsterBalance;
                const shortfall = owed;
                await postLedgerTransaction(tx, 'fraud_reversal', [
                    { account: accounts.payable(payee), amountMicroUsd: -fromPayee },
                    { account: accounts.payable(fraudulent), amountMicroUsd: -fromFraudsterPayable },
                    { account: accounts.balance(fraudulent), amountMicroUsd: -fromFraudsterBalance },
                    // The platform gives back its fee, and covers what nobody else can.
                    { account: accounts.revenue, amountMicroUsd: -(fee + shortfall) },
                    ...pay.allocations.map(a => ({ account: accounts.balance(funderOf.get(a.fundingId)!), amountMicroUsd: a.amountMicroUsd })),
                ], { runId: pay.runId, contractId: pay.contractId! });
                await adjustOrganization(tx, payee, { payable: -fromPayee });
                await adjustOrganization(tx, fraudulent, { payable: -fromFraudsterPayable, balance: -fromFraudsterBalance });
                for (const a of pay.allocations) {
                    await adjustOrganization(tx, funderOf.get(a.fundingId)!, { balance: a.amountMicroUsd });
                    await tx.insert(contractMoneyLogTable).values({
                        contractId: pay.contractId!, kind: 'fraud_reversal', amountMicroUsd: a.amountMicroUsd,
                        funderOrganizationId: funderOf.get(a.fundingId)!, counterpartyOrganizationId: payee, runId: pay.runId,
                    });
                }
                totals.recovered += fromFraudsterPayable + fromFraudsterBalance;
                notices.push({ organizationId: payee, kind: 'payment_reversed', details: { rootRunId, amountMicroUsd: fromPayee } });
                for (const a of pay.allocations) notices.push({ organizationId: funderOf.get(a.fundingId)!, kind: 'funding_returned', details: { reason: 'fraud_reversal', rootRunId, amountMicroUsd: a.amountMicroUsd } });
                totals.shortfall += shortfall;
            });
            totals.reversed += pay.amountMicroUsd;
        }
        for (const notice of notices) await this.money.notify?.(notice.organizationId, notice.kind, notice.details).catch(() => undefined);
        return totals;
    }

    /** A suspended node can't run its contracts, so their funding goes straight back to the organizations that sent it. */
    private async closeContracts(organizationId: string, actor: string): Promise<void> {
        const hosted = await this.db.select({ id: contractVersionsTable.id }).from(contractVersionsTable)
            .innerJoin(nodesTable, eq(nodesTable.publicKey, contractVersionsTable.nodePublicKey))
            .where(eq(nodesTable.organizationId, organizationId));
        let refunded = 0;
        for (const { id } of hosted) refunded += await this.money.close(id);
        if (hosted.length > 0) await this.audit.record(actor, 'contracts_closed', organizationId, { contracts: hosted.length, refundedMicroUsd: refunded });
    }
}
