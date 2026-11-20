import { and, asc, desc, eq, isNotNull, isNull, lte } from "drizzle-orm";
import type { Mailer } from "../auth/email.js";
import type { Database } from "../db/database.js";
import { authMembersTable, authUsersTable, notificationsTable, organizationsTable } from "../db/schema.js";
import type { RunTokenSigner } from "../runs/tokens.js";

export type Notification = typeof notificationsTable.$inferSelect;

/** What a notification is about, in a sentence for the email's subject. */
const SUBJECTS: Record<string, string> = {
    funding_returned: 'Stellarium returned contract funding to you',
    payment_reversed: 'Stellarium reversed a contract payment to you',
    dispute_recovered: 'Stellarium recovered a card dispute from your contract funding',
    organization_closed: 'Your Stellarium organization was closed',
};

/** The fields of a webhook delivery the operator signs, in order. */
export function notificationPayload(notification: Pick<Notification, 'id' | 'kind' | 'organizationId' | 'details' | 'createdAt'>) {
    const { id, kind, organizationId, details } = notification;
    return { id, kind, organizationId, details, createdAt: notification.createdAt.toISOString() };
}

const RETRY_INITIAL_MS = 30_000;
const RETRY_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/**
 * Tells organizations what the operator did to their money on its own (docs/money.md, Money log): it emails their
 * owners, and posts to their webhook, signed with the operator's key, retrying for a day. Contracts aren't told,
 * so the people behind them are.
 */
export class NotificationService {
    constructor(
        private readonly db: Database,
        private readonly mailer?: Mailer,
        private readonly signer?: RunTokenSigner,
        private readonly post: (url: string, body: string, headers: Record<string, string>) => Promise<boolean> = postJson,
    ) {}

    async notify(organizationId: string, kind: string, details: Record<string, unknown>): Promise<void> {
        const [notification] = await this.db.insert(notificationsTable).values({ organizationId, kind, details, nextAttemptAt: new Date() }).returning();
        await this.email(notification!);
        void this.deliver(notification!).catch(() => undefined);
    }

    private async email(notification: Notification): Promise<void> {
        if (!this.mailer) return;
        const [organization] = await this.db.select().from(organizationsTable).where(eq(organizationsTable.id, notification.organizationId)).limit(1);
        if (!organization?.authOrganizationId) return;
        const owners = await this.db.select({ email: authUsersTable.email }).from(authMembersTable)
            .innerJoin(authUsersTable, eq(authUsersTable.id, authMembersTable.userId))
            .where(and(eq(authMembersTable.organizationId, organization.authOrganizationId), eq(authMembersTable.role, 'owner')));
        for (const { email } of owners) {
            await this.mailer.send({
                to: email,
                subject: SUBJECTS[notification.kind] ?? 'A notice from Stellarium',
                text: `${SUBJECTS[notification.kind] ?? notification.kind} (${organization.name}):\n\n${JSON.stringify(notification.details, null, 2)}`,
            });
        }
    }

    /** Posts one notification to its organization's webhook. True once it's delivered or there's nowhere to deliver it. */
    private async deliver(notification: Notification): Promise<boolean> {
        const [organization] = await this.db.select().from(organizationsTable).where(eq(organizationsTable.id, notification.organizationId)).limit(1);
        if (!organization?.webhookUrl || !this.signer) {
            await this.db.update(notificationsTable).set({ nextAttemptAt: null }).where(eq(notificationsTable.id, notification.id));
            return true;
        }
        const payload = notificationPayload(notification);
        const delivered = await this.post(organization.webhookUrl, JSON.stringify(payload), {
            'Stellarium-Signature': this.signer.signPayload(payload),
            'Stellarium-Key': this.signer.publicKeySpki,
        }).catch(() => false);
        const attempts = notification.webhookAttempts + 1;
        const giveUp = Date.now() - notification.createdAt.getTime() > RETRY_MAX_AGE_MS;
        await this.db.update(notificationsTable).set(delivered
            ? { webhookAttempts: attempts, webhookDeliveredAt: new Date(), nextAttemptAt: null }
            : { webhookAttempts: attempts, nextAttemptAt: giveUp ? null : new Date(Date.now() + Math.min(RETRY_INITIAL_MS * 2 ** attempts, 60 * 60 * 1000)) })
            .where(eq(notificationsTable.id, notification.id));
        return delivered;
    }

    /** Retries webhook deliveries that are due. Returns how many were delivered. */
    async deliverDue(now: Date = new Date()): Promise<number> {
        const due = await this.db.select().from(notificationsTable)
            .where(and(isNull(notificationsTable.webhookDeliveredAt), isNotNull(notificationsTable.nextAttemptAt), lte(notificationsTable.nextAttemptAt, now)))
            .orderBy(asc(notificationsTable.id)).limit(100);
        let delivered = 0;
        for (const notification of due) if (await this.deliver(notification)) delivered++;
        return delivered;
    }

    async forOrganization(organizationId: string, limit = 100): Promise<Notification[]> {
        return this.db.select().from(notificationsTable).where(eq(notificationsTable.organizationId, organizationId)).orderBy(desc(notificationsTable.id)).limit(limit);
    }

    /** Sets or clears where the organization's notifications are posted. */
    async setWebhook(organizationId: string, url: string | null): Promise<void> {
        await this.db.update(organizationsTable).set({ webhookUrl: url, updatedAt: new Date() }).where(eq(organizationsTable.id, organizationId));
    }
}

async function postJson(url: string, body: string, headers: Record<string, string>): Promise<boolean> {
    const response = await fetch(url, { method: 'POST', body, headers: { 'Content-Type': 'application/json', ...headers }, signal: AbortSignal.timeout(10_000) });
    return response.ok;
}

