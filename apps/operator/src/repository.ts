import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { and, eq } from "drizzle-orm";
import { receiptsTable } from "./db/schema.js";

export type Receipt = typeof receiptsTable.$inferInsert;

export class ReceiptRepository {
    constructor(private readonly db: NodePgDatabase) {}

    async create(receipt: Receipt): Promise<void> {
        await this.db.insert(receiptsTable).values(receipt);
    }

    async getByRequestIdAndInvocationId(requestId: string, invocationId: string): Promise<Receipt | undefined> {
        const receipt = await this.db.select().from(receiptsTable).where(and(eq(receiptsTable.requestId, requestId), eq(receiptsTable.invocationId, invocationId))).limit(1).execute();
        return receipt.length > 0 ? receipt[0] : undefined;
    }
}
