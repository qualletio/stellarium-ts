import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { ContractRepository, type StoredContract } from "../../contract/repository.js";
import type { NodeDatabase } from "../../db/database.js";
import { DIALECTS, openTestDatabase } from "../helpers.js";

function contract(version: string, overrides: Partial<StoredContract> = {}): Omit<StoredContract, "createdAt"> {
    return {
        path: "com.example",
        name: "Sum",
        version,
        source: `contract com.example.Sum@${version}(a: int32): int32 { return a }`,
        parameters: [{ name: "a", type: "int32" }],
        returnType: "int32",
        ownerOrganizationId: "org_a",
        description: null,
        ...overrides,
    };
}

describe.each(DIALECTS)("ContractRepository (%s)", (dialect) => {
    let db: NodeDatabase;
    let repository: ContractRepository;

    beforeEach(async () => {
        db = await openTestDatabase(dialect);
        repository = new ContractRepository(db);
    });

    afterEach(async () => {
        await db.close();
    });

    test("finds the latest version by comparing versions numerically", async () => {
        for (const version of ["1", "1.10", "1.9"]) {
            expect(await repository.save(contract(version))).toEqual({ ok: true });
        }

        expect(await repository.latest("com.example", "Sum")).toMatchObject({ version: "1.10", parameters: [{ name: "a", type: "int32" }], returnType: "int32" });
        expect(await repository.latest("com.example", "Other")).toBeUndefined();
        expect((await repository.allLatest()).map(c => c.version)).toEqual(["1.10"]);
    });

    test("keeps versions immutable", async () => {
        await repository.save(contract("1"));

        expect(await repository.save(contract("1", { source: "changed" }))).toEqual({ ok: false, refused: "version_exists" });
        expect((await repository.latest("com.example", "Sum"))?.source).toContain("@1(");
    });

    test("gives every version to the first deployer's organization, and lets the admin add versions", async () => {
        await repository.save(contract("1"));

        expect(await repository.save(contract("2", { ownerOrganizationId: "org_b" }))).toEqual({ ok: false, refused: "owned_by_another" });
        expect(await repository.save(contract("2", { ownerOrganizationId: null }))).toEqual({ ok: true });
        expect(await repository.owner("com.example", "Sum")).toBe("org_a");
        expect((await repository.latest("com.example", "Sum"))?.ownerOrganizationId).toBe("org_a");
    });

    test("an admin's contract belongs to no organization", async () => {
        await repository.save(contract("1", { ownerOrganizationId: null }));

        expect(await repository.owner("com.example", "Sum")).toBeNull();
        expect(await repository.save(contract("2", { ownerOrganizationId: "org_b" }))).toEqual({ ok: false, refused: "owned_by_another" });
    });

    test("deletes one version or all of them", async () => {
        await repository.save(contract("1"));
        await repository.save(contract("2"));

        expect(await repository.delete("com.example", "Sum", "2")).toBe(true);
        expect((await repository.latest("com.example", "Sum"))?.version).toBe("1");
        expect(await repository.delete("com.example", "Sum")).toBe(true);
        expect(await repository.owner("com.example", "Sum")).toBeUndefined();
        expect(await repository.delete("com.example", "Sum")).toBe(false);
    });

    test("lists every version a page at a time", async () => {
        await repository.save(contract("1"));
        await repository.save(contract("2"));
        await repository.save(contract("1", { name: "Product" }));

        expect((await repository.list(0, 2)).map(c => `${c.name}@${c.version}`)).toEqual(["Product@1", "Sum@1"]);
        expect((await repository.list(2, 2)).map(c => `${c.name}@${c.version}`)).toEqual(["Sum@2"]);
    });
});
