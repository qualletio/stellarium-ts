import { desc, eq } from "drizzle-orm";
import type { Database, Transaction } from "../db/database.js";
import { auditLogTable } from "../db/schema.js";

export type AuditEntry = typeof auditLogTable.$inferSelect;

/**
 * The append-only audit log (docs/money.md, Trust): every staff action, and everything the operator does on its
 * own that affects an organization. Nothing updates or deletes an entry.
 */
export class AuditLog {
    constructor(private readonly db: Database) {}

    async record(actor: string, action: string, organizationId: string | null, details: Record<string, unknown>, tx: Database | Transaction = this.db): Promise<void> {
        await tx.insert(auditLogTable).values({ actor, action, organizationId, details });
    }

    /** The entries about an organization, newest first, which it can read itself. */
    async forOrganization(organizationId: string, limit = 200): Promise<AuditEntry[]> {
        return this.db.select().from(auditLogTable).where(eq(auditLogTable.organizationId, organizationId)).orderBy(desc(auditLogTable.id)).limit(limit);
    }

    async recent(limit = 200): Promise<AuditEntry[]> {
        return this.db.select().from(auditLogTable).orderBy(desc(auditLogTable.id)).limit(limit);
    }
}
