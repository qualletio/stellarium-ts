import { compareVersions } from "requestscript";
import type { NodeDatabase } from "../db/database.js";

export interface ContractParameter {
    name: string;
    /** A RequestScript type string, e.g. 'int32' or '[]string'. */
    type: string;
}

export interface StoredContract {
    path: string;
    name: string;
    version: string;
    source: string;
    parameters: ContractParameter[];
    returnType: string;
    /** The organization that deployed it, which owns every version. Null when the node's admin did. */
    ownerOrganizationId: string | null;
    description: string | null;
    createdAt: string;
}

interface ContractRow {
    path: string;
    name: string;
    version: string;
    source: string;
    parameters: string;
    return_type: string;
    owner_organization_id: string | null;
    description: string | null;
    created_at: string;
}

function toContract(row: ContractRow): StoredContract {
    return {
        path: row.path,
        name: row.name,
        version: row.version,
        source: row.source,
        parameters: JSON.parse(row.parameters),
        returnType: row.return_type,
        ownerOrganizationId: row.owner_organization_id,
        description: row.description,
        createdAt: row.created_at,
    };
}

/** The latest version of each contract in `rows`, ordered by path and name. */
function latestOf(rows: ContractRow[]): StoredContract[] {
    const latest = new Map<string, ContractRow>();
    for (const row of rows) {
        const key = `${row.path}.${row.name}`;
        const current = latest.get(key);
        if (!current || compareVersions(row.version, current.version) > 0) {
            latest.set(key, row);
        }
    }
    return [...latest.values()].map(toContract);
}

/** Why `save` refused a contract. */
export type SaveContractRefusal = 'version_exists' | 'owned_by_another';

/**
 * Contracts deployed to this node. Versions are immutable, and every version of a contract belongs to the
 * organization that deployed its first one.
 */
export class ContractRepository {
    constructor(private readonly db: NodeDatabase) {}

    /**
     * Saves a new version. `ownerOrganizationId` null is the node's admin, which may add versions to any
     * contract; they stay owned by the contract's owner.
     */
    async save(contract: Omit<StoredContract, 'createdAt'>): Promise<{ ok: true } | { ok: false, refused: SaveContractRefusal }> {
        return this.db.transaction(async (tx) => {
            const existing = await tx.all<ContractRow[]>('SELECT * FROM contract WHERE path = ? AND name = ?', [contract.path, contract.name]);
            const owner = existing.length > 0 ? existing[0]!.owner_organization_id : contract.ownerOrganizationId;
            if (contract.ownerOrganizationId !== null && owner !== contract.ownerOrganizationId) {
                return { ok: false as const, refused: 'owned_by_another' as const };
            }
            if (existing.some(row => row.version === contract.version)) {
                return { ok: false as const, refused: 'version_exists' as const };
            }
            await tx.run(
                'INSERT INTO contract (path, name, version, source, parameters, return_type, owner_organization_id, description, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
                [contract.path, contract.name, contract.version, contract.source, JSON.stringify(contract.parameters), contract.returnType, owner, contract.description, new Date().toISOString()],
            );
            return { ok: true as const };
        });
    }

    /** The contract's latest version. */
    async latest(path: string, name: string): Promise<StoredContract | undefined> {
        const rows = await this.db.all<ContractRow[]>('SELECT * FROM contract WHERE path = ? AND name = ?', [path, name]);
        return latestOf(rows)[0];
    }

    /** The owner of the contract at `path.name`: an organization, null for the node's admin, or undefined if there is none. */
    async owner(path: string, name: string): Promise<string | null | undefined> {
        const row = await this.db.get<{ owner_organization_id: string | null }>('SELECT owner_organization_id FROM contract WHERE path = ? AND name = ? LIMIT 1', [path, name]);
        return row ? row.owner_organization_id : undefined;
    }

    /** The latest version of every contract, ordered by path and name. */
    async allLatest(): Promise<StoredContract[]> {
        return latestOf(await this.db.all<ContractRow[]>('SELECT * FROM contract ORDER BY path, name'));
    }

    /** One page of every version, ordered by path, name and deploy time. */
    async list(offset: number, limit: number): Promise<StoredContract[]> {
        const rows = await this.db.all<ContractRow[]>('SELECT * FROM contract ORDER BY path, name, created_at, version LIMIT ? OFFSET ?', [limit, offset]);
        return rows.map(toContract);
    }

    /** Deletes one version, or every version when `version` is omitted. False when there was nothing to delete. */
    async delete(path: string, name: string, version?: string): Promise<boolean> {
        const result = version === undefined
            ? await this.db.run('DELETE FROM contract WHERE path = ? AND name = ?', [path, name])
            : await this.db.run('DELETE FROM contract WHERE path = ? AND name = ? AND version = ?', [path, name, version]);
        return result.changes > 0;
    }
}
