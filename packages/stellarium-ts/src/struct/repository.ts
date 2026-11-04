import { compareVersions } from "requestscript";
import type { NodeDatabase } from "../db/database.js";
import { type AnnouncedStruct, sameFields, type StructDefinition, structLabelOf } from "./types.js";

interface StructRow {
    path: string;
    name: string;
    version: string;
    fields: string;
    owner_organization_id: string;
    base_url: string;
    local: number;
    description: string | null;
    created_at: string;
}

function toStruct(row: StructRow): StructDefinition {
    return {
        path: row.path,
        name: row.name,
        version: row.version,
        fields: JSON.parse(row.fields),
        ownerOrganizationId: row.owner_organization_id,
        baseUrl: row.base_url,
        description: row.description,
        createdAt: row.created_at,
    };
}

/**
 * Why a struct version can't be saved: its path belongs to another organization, or this node already knows
 * the version with other fields.
 */
export type SaveStructRefusal = 'owned_elsewhere' | 'version_exists';

type Admission = { ok: true, saved: boolean } | { ok: false, refused: SaveStructRefusal };

/**
 * The structs this node knows: those it declared, and those it learned from its peers. A struct's path
 * belongs to the first organization that declared it, and a version never changes or goes away, so every
 * node that knows a version knows the same fields.
 */
export class StructRepository {
    constructor(private readonly db: NodeDatabase) {}

    /**
     * Saves a version this node declares for its organization. Saving the same fields again does nothing
     * (`saved: false`).
     */
    async saveLocal(struct: Omit<StructDefinition, 'createdAt'>, source: string): Promise<Admission> {
        return this.db.transaction(tx => this.admit(tx, struct, true, source));
    }

    /**
     * Learns the structs a peer announced, as `owner`'s, the organization the operator says the peer belongs
     * to: none when undefined. Structs it already knows are kept as they are. Returns those it refused, as
     * path.Name@version: another organization's, one whose path another organization owns, or a version this
     * node knows with other fields.
     */
    async learn(baseUrl: string, structs: AnnouncedStruct[], owner: string | undefined): Promise<string[]> {
        return this.db.transaction(async (tx) => {
            const rejected: string[] = [];
            for (const struct of structs) {
                if (owner === undefined || struct.ownerOrganizationId !== owner) {
                    rejected.push(structLabelOf(struct));
                    continue;
                }
                const admitted = await this.admit(tx, { ...struct, baseUrl }, false, null);
                if (!admitted.ok) {
                    rejected.push(structLabelOf(struct));
                }
            }
            return rejected;
        });
    }

    private async admit(tx: NodeDatabase, struct: Omit<StructDefinition, 'createdAt'>, local: boolean, source: string | null): Promise<Admission> {
        const existing = await tx.all<StructRow[]>('SELECT * FROM struct_type WHERE path = ? AND name = ?', [struct.path, struct.name]);
        if (existing.some(row => row.owner_organization_id !== struct.ownerOrganizationId)) {
            return { ok: false, refused: 'owned_elsewhere' };
        }
        const known = existing.find(row => row.version === struct.version);
        if (known) {
            return sameFields(JSON.parse(known.fields), struct.fields) ? { ok: true, saved: false } : { ok: false, refused: 'version_exists' };
        }
        await tx.run(
            'INSERT INTO struct_type (path, name, version, fields, owner_organization_id, base_url, local, source, description, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
            [struct.path, struct.name, struct.version, JSON.stringify(struct.fields), struct.ownerOrganizationId, struct.baseUrl, local ? 1 : 0, source, struct.description, new Date().toISOString()],
        );
        return { ok: true, saved: true };
    }

    /** The struct at exactly `version`. */
    async get(path: string, name: string, version: string): Promise<StructDefinition | undefined> {
        const row = await this.db.get<StructRow>('SELECT * FROM struct_type WHERE path = ? AND name = ? AND version = ?', [path, name, version]);
        return row && toStruct(row);
    }

    /** The struct's latest version, for looking one up by name. Types always name their version. */
    async latest(path: string, name: string): Promise<StructDefinition | undefined> {
        const rows = await this.db.all<StructRow[]>('SELECT * FROM struct_type WHERE path = ? AND name = ?', [path, name]);
        const latest = rows.sort((a, b) => compareVersions(b.version, a.version))[0];
        return latest && toStruct(latest);
    }

    /** One page of every struct this node knows, its own first. */
    async list(offset: number, limit: number): Promise<StructDefinition[]> {
        const rows = await this.db.all<StructRow[]>('SELECT * FROM struct_type ORDER BY local DESC, path, name, created_at, version LIMIT ? OFFSET ?', [limit, offset]);
        return rows.map(toStruct);
    }

    /** Every version this node declared for `organizationId`, for its announcement. */
    async localStructs(organizationId: string): Promise<AnnouncedStruct[]> {
        const rows = await this.db.all<StructRow[]>('SELECT * FROM struct_type WHERE local = 1 AND owner_organization_id = ? ORDER BY path, name, version', [organizationId]);
        return rows.map(row => {
            const { path, name, version, fields, ownerOrganizationId, description } = toStruct(row);
            return { path, name, version, fields, ownerOrganizationId, description };
        });
    }
}
