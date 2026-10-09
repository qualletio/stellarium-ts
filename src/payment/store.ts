import type { Database } from "sqlite";
import { wireJson } from "../protocol/canonical.js";
import {
    claimSchema,
    dispatchAcknowledgementSchema,
} from "../protocol/schema.js";
import type { RunResult, Claim, Hex } from "../protocol/types.js";
export class ExecutionStore {
    constructor(readonly db: Database) {}
    async recover(): Promise<void> {
        await this.db.run(
            "UPDATE invocation SET status='indeterminate' WHERE status='running'",
        );
        await this.db.run(
            "UPDATE request_execution SET status='indeterminate' WHERE status='running'",
        );
    }
    async begin(id: Hex, request = false): Promise<boolean> {
        const table = request ? "request_execution" : "invocation";
        const now = Date.now();
        const result = request
            ? await this.db.run(
                  `INSERT OR IGNORE INTO ${table}(id,status,updated_at) VALUES(?,'running',?)`,
                  id,
                  now,
              )
            : await this.db.run(
                  `INSERT OR IGNORE INTO ${table}(id,status,created_at,updated_at) VALUES(?,'running',?,?)`,
                  id,
                  now,
                  now,
              );
        return result.changes === 1;
    }
    async get(
        id: Hex,
        request = false,
    ): Promise<{ status: string; result?: RunResult } | undefined> {
        const row = await this.db.get(
            `SELECT * FROM ${request ? "request_execution" : "invocation"} WHERE id=?`,
            id,
        );
        if (!row) return undefined;
        const result = row.result_json
            ? (JSON.parse(row.result_json) as RunResult)
            : undefined;
        if (result)
            result.executions = result.executions.map((record) => ({
                ...record,
                claim: claimSchema.parse(record.claim),
                dispatchAcknowledgement: record.dispatchAcknowledgement
                    ? dispatchAcknowledgementSchema.parse(
                          record.dispatchAcknowledgement,
                      )
                    : undefined,
            }));
        return { status: row.status, result };
    }
    async complete(
        id: Hex,
        result: RunResult,
        request = false,
        relayEndpoint?: string,
    ): Promise<void> {
        if (!request && relayEndpoint) {
            await this.db.run(
                "UPDATE invocation SET status='completed',result_json=?,relay_endpoint=?,updated_at=? WHERE id=?",
                wireJson(result),
                relayEndpoint,
                Date.now(),
                id,
            );
            return;
        }
        await this.db.run(
            `UPDATE ${request ? "request_execution" : "invocation"} SET status='completed',result_json=?,updated_at=? WHERE id=?`,
            wireJson(result),
            Date.now(),
            id,
        );
    }
    async fail(id: Hex, request = false): Promise<void> {
        await this.db.run(
            `UPDATE ${request ? "request_execution" : "invocation"} SET status='failed',updated_at=? WHERE id=?`,
            Date.now(),
            id,
        );
    }
    async enqueue(endpoint: string, claim: Claim): Promise<void> {
        await this.db.run(
            "INSERT OR IGNORE INTO outbox(id,endpoint,claim_json) VALUES(?,?,?)",
            claim.receipt.message.receiptId,
            endpoint,
            wireJson(claim),
        );
    }
    async flush(fetcher: typeof fetch = fetch): Promise<void> {
        const rows = await this.db.all(
            "SELECT * FROM outbox WHERE delivered=0 ORDER BY rowid LIMIT 100",
        );
        for (const row of rows) {
            const claim = claimSchema.parse(JSON.parse(row.claim_json));
            if (
                BigInt(Math.floor(Date.now() / 1000)) >
                claim.receipt.message.executedAt + 1800n
            ) {
                await this.db.run(
                    "UPDATE outbox SET delivered=-1 WHERE id=? AND claim_json=?",
                    row.id,
                    row.claim_json,
                );
                continue;
            }
            try {
                const response = await fetcher(
                    `${row.endpoint.replace(/\/$/, "")}/v1/relay/claims`,
                    {
                        method: "POST",
                        headers: { "content-type": "application/json" },
                        body: row.claim_json,
                        signal: AbortSignal.timeout(10_000),
                    },
                );
                if (response.ok)
                    await this.db.run(
                        "UPDATE outbox SET delivered=1 WHERE id=? AND claim_json=?",
                        row.id,
                        row.claim_json,
                    );
                else
                    await this.db.run(
                        "UPDATE outbox SET attempts=attempts+1 WHERE id=?",
                        row.id,
                    );
            } catch {
                await this.db.run(
                    "UPDATE outbox SET attempts=attempts+1 WHERE id=?",
                    row.id,
                );
            }
        }
    }
}
