import { verifyData } from "../crypto/utils.js";
import type { Resource } from "requestscript";
import type { Database } from "sqlite";
import type { Peer } from "../peer/repository.js";
import type { MonetizationManifest, Signed } from "../protocol/types.js";
import { wireJson } from "../protocol/canonical.js";
import { manifestSchema } from "../protocol/schema.js";
export interface ResourceWithBaseUrl extends Resource {
    baseUrl: string;
    monetization?: Signed<MonetizationManifest>;
}
export class ResourceRepository {
    constructor(
        private readonly db: Database,
        private resources: Resource[] = [],
        private readonly baseUrl = "",
    ) {}
    async create(
        resource: ResourceWithBaseUrl,
        baseUrl: string,
        ownerKey?: string,
    ): Promise<void> {
        const now = new Date().toISOString();
        const existing = await this.db.get(
            "SELECT owner_key FROM resources WHERE path = ? AND name = ?",
            resource.path,
            resource.name,
        );
        if (existing?.owner_key && existing.owner_key !== ownerKey)
            throw new Error("Resource owner mismatch");
        const functions = resource.functions.map((fn) => ({
            name: fn.name,
            returnType: fn.returnType,
            parameters: fn.parameters,
        }));
        await this.db.run(
            `INSERT INTO resources (path,name,base_url,owner_key,functions_json,monetization_json,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(path,name) DO UPDATE SET base_url=excluded.base_url,
      owner_key=COALESCE(resources.owner_key,excluded.owner_key),functions_json=excluded.functions_json,
      monetization_json=excluded.monetization_json,updated_at=excluded.updated_at`,
            resource.path,
            resource.name,
            baseUrl,
            ownerKey ?? null,
            JSON.stringify(functions),
            resource.monetization ? wireJson(resource.monetization) : null,
            now,
            now,
        );
    }
    async saveAll(
        resources: ResourceWithBaseUrl[],
        peer: Peer,
        signature: string,
    ): Promise<boolean> {
        if (!verifyData({ resources }, peer.publicKey, signature)) return false;
        for (const resource of resources)
            await this.create(resource, resource.baseUrl, peer.publicKey);
        return true;
    }
    async getResource(key: string): Promise<Resource | undefined> {
        const local = this.resources.find((r) => `${r.path}.${r.name}` === key);
        if (local) return local;
        const parts = key.split(".");
        const name = parts.pop();
        const row = await this.db.get(
            "SELECT * FROM resources WHERE path=? AND name=?",
            parts.join("."),
            name,
        );
        return row ? this.decode(row) : undefined;
    }
    private decode(row: Record<string, string>): ResourceWithBaseUrl {
        const monetization = row.monetization_json
            ? manifestSchema.parse(JSON.parse(row.monetization_json))
            : undefined;
        return {
            path: row.path,
            name: row.name,
            baseUrl: row.base_url,
            monetization,
            functions: JSON.parse(row.functions_json).map((fn: object) => ({
                ...fn,
                exec: async () => {
                    throw new Error("Remote resource must be forwarded");
                },
            })),
            metadata: { baseUrl: row.base_url, monetization },
        };
    }
    async getInternalResources(): Promise<ResourceWithBaseUrl[]> {
        return this.resources.map((r) => ({
            ...r,
            baseUrl: this.baseUrl,
            monetization: r.metadata.monetization as
                Signed<MonetizationManifest> | undefined,
        }));
    }
    async getExternalResources(): Promise<ResourceWithBaseUrl[]> {
        return (await this.db.all("SELECT * FROM resources")).map((row) =>
            this.decode(row),
        );
    }
    async getAllResources(): Promise<ResourceWithBaseUrl[]> {
        const local = await this.getInternalResources();
        const keys = new Set(local.map((r) => `${r.path}.${r.name}`));
        return [
            ...local,
            ...(await this.getExternalResources()).filter(
                (r) => !keys.has(`${r.path}.${r.name}`),
            ),
        ];
    }
}
