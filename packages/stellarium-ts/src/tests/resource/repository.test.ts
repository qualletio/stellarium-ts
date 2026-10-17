import type { Database } from "sqlite";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { signData } from "../../crypto/utils.js";
import { openDatabase } from "../../db/db.js";
import { PeerRepository, type StoredPeer } from "../../peer/repository.js";
import { resourceAnnouncementPayload, ResourceRepository, type StellariumResource, type StellariumResourceFunction } from "../../resource/repository.js";
import { generateBase64KeyPair, RECIPIENT, weatherResource } from "../helpers.js";

const SELF = "http://self.example";
const PROVIDER = "http://provider.example";

function resource(name: string, functions: Partial<StellariumResourceFunction>[], baseUrl = PROVIDER): StellariumResource {
    return {
        id: 0,
        baseUrl,
        metadata: {},
        path: "com.provider",
        name,
        functions: functions.map(fn => ({ name: "fn", parameters: [], returnType: "string", exec: async () => undefined, ...fn })),
    };
}

describe("ResourceRepository", () => {
    let db: Database;
    let repository: ResourceRepository;

    beforeEach(async () => {
        db = await openDatabase(":memory:");
        repository = new ResourceRepository(db, [weatherResource(SELF)], SELF);
    });

    afterEach(async () => {
        await db.close();
    });

    describe("learn", () => {
        test("keeps which functions are restricted", async () => {
            await repository.learn(resource("Vault", [{ name: "open", restricted: true }, { name: "peek" }]));

            const functions = (await repository.getResource("com.provider.Vault"))?.functions as StellariumResourceFunction[];
            expect(functions.map(fn => [fn.name, fn.restricted])).toEqual([["open", true], ["peek", undefined]]);
            expect((await repository.getResourceFunction("com.provider", "Vault", "open"))?.restricted).toBe(true);
        });

        test("is idempotent, so startup can run on every boot", async () => {
            const learned = resource("Forecast", [{ name: "tomorrow" }]);

            await repository.learn(learned);
            await repository.learn(learned);

            expect(await repository.getExternalResources()).toHaveLength(1);
        });

        test("stores several resources served from the same base URL", async () => {
            await repository.learn(resource("Forecast", [{ name: "tomorrow" }]));
            await repository.learn(resource("Radar", [{ name: "image" }]));

            expect((await repository.getExternalResources()).map(r => r.name)).toEqual(["Forecast", "Radar"]);
        });

        test("skips resources hosted by this node", async () => {
            await repository.learn(weatherResource(PROVIDER));
            await repository.learn(resource("Echo", [{ name: "fn" }], SELF));

            expect(await repository.getExternalResources()).toEqual([]);
        });
    });

    describe("getResources", () => {
        beforeEach(async () => {
            for (const name of ["A", "B", "C"]) {
                await repository.learn(resource(name, []));
            }
        });

        const names = async (offset: number, limit: number) => (await repository.getResources(offset, limit)).map(r => r.name);

        test("pages across hosted and learned resources", async () => {
            expect(await names(0, 2)).toEqual(["Weather", "A"]);
            expect(await names(2, 2)).toEqual(["B", "C"]);
            expect(await names(4, 2)).toEqual([]);
        });

        test("pages within the hosted resources alone", async () => {
            expect(await names(0, 1)).toEqual(["Weather"]);
        });
    });

    describe("getResource", () => {
        test("returns each function's own payment manifest", async () => {
            await repository.learn(resource("Forecast", [
                { name: "free" },
                { name: "paid", paymentManifest: { costLamports: 250, recipientAddress: RECIPIENT } },
            ]));

            const found = await repository.getResource("com.provider.Forecast") as StellariumResource;

            expect(found.metadata).toEqual({ baseUrl: PROVIDER });
            expect(found.functions.find(f => f.name === "free")?.paymentManifest).toBeUndefined();
            expect(found.functions.find(f => f.name === "paid")?.paymentManifest).toMatchObject({ costLamports: 250, recipientAddress: RECIPIENT });
        });

        test("prefers the internal resource", async () => {
            const found = await repository.getResource("com.example.Weather");

            expect(found?.metadata).toEqual({});
        });

        test("returns undefined for an unknown key", async () => {
            expect(await repository.getResource("com.provider.Missing")).toBeUndefined();
        });
    });

    describe("saveAll", () => {
        const keys = generateBase64KeyPair();
        let peer: StoredPeer;

        beforeEach(async () => {
            const peers = new PeerRepository(db);
            await peers.create({ baseUrl: PROVIDER, name: PROVIDER, publicKey: keys.publicKey });
            peer = (await peers.getPeerByPublicKey(keys.publicKey))!;
        });

        function save(resources: StellariumResource[], as = peer, privateKey = keys.privateKey) {
            const expiry = new Date(Date.now() + 60_000).toISOString();
            const sent = JSON.parse(JSON.stringify(resources));
            return repository.saveAll(sent, as, signData(resourceAnnouncementPayload(sent, expiry), privateKey), expiry);
        }

        test("adds new functions, parameters and payment manifests to a known resource", async () => {
            await save([resource("Forecast", [{ name: "today" }])]);
            const result = await save([resource("Forecast", [
                { name: "today", parameters: [{ name: "city", type: "string" }], paymentManifest: { costLamports: 100, recipientAddress: RECIPIENT } },
                { name: "tomorrow" },
            ])]);

            expect(result).toEqual({ ok: true, rejected: [] });
            const today = await repository.getResourceFunction("com.provider", "Forecast", "today");
            expect(today?.parameters).toEqual([{ name: "city", type: "string" }]);
            expect(today?.paymentManifest).toMatchObject({ costLamports: 100 });
            expect(await repository.getResourceFunction("com.provider", "Forecast", "tomorrow")).toBeDefined();
        });

        test("removes functions and payment manifests the peer no longer advertises", async () => {
            await save([resource("Forecast", [{ name: "today", paymentManifest: { costLamports: 100, recipientAddress: RECIPIENT } }, { name: "old" }])]);
            await save([resource("Forecast", [{ name: "today" }])]);

            expect((await repository.getResourceFunction("com.provider", "Forecast", "today"))?.paymentManifest).toBeUndefined();
            expect(await repository.getResourceFunction("com.provider", "Forecast", "old")).toBeUndefined();
        });

        test("claims a resource learned at startup that points at the peer", async () => {
            await repository.learn(resource("Forecast", [{ name: "today" }]));

            expect(await save([resource("Forecast", [{ name: "tomorrow" }])])).toEqual({ ok: true, rejected: [] });
            expect(await repository.getResourceFunction("com.provider", "Forecast", "tomorrow")).toBeDefined();
        });

        test("will not let one peer take over another peer's resource", async () => {
            await save([resource("Forecast", [{ name: "today" }])]);

            const other = generateBase64KeyPair();
            const peers = new PeerRepository(db);
            await peers.create({ baseUrl: "http://other.example", name: "other", publicKey: other.publicKey });
            const otherPeer = (await peers.getPeerByPublicKey(other.publicKey))!;

            const result = await save([resource("Forecast", [{ name: "hijacked" }], "http://other.example")], otherPeer, other.privateKey);

            expect(result).toEqual({ ok: true, rejected: ["com.provider.Forecast"] });
            expect((await repository.getResource("com.provider.Forecast"))?.metadata).toEqual({ baseUrl: PROVIDER });
        });

        test("rejects a bad signature, an expired broadcast and a malformed key without throwing", async () => {
            const sent = [resource("Forecast", [])];
            const past = new Date(Date.now() - 1000).toISOString();

            expect(await save(sent, peer, generateBase64KeyPair().privateKey)).toEqual({ ok: false });
            expect(await repository.saveAll(sent, peer, signData(resourceAnnouncementPayload(sent, past), keys.privateKey), past)).toEqual({ ok: false });
            expect(await save(sent, { ...peer, publicKey: "not-a-key" })).toEqual({ ok: false });
        });

        test("rolls back the whole broadcast when a write fails", async () => {
            const result = save([
                resource("Forecast", [{ name: "today" }]),
                // Duplicate function names violate UNIQUE (resource_id, name).
                resource("Radar", [{ name: "image" }, { name: "image" }]),
            ]);

            await expect(result).rejects.toThrow();
            expect(await repository.getExternalResources()).toEqual([]);
        });
    });
});
