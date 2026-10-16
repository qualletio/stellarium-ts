import type { Database } from "sqlite";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { signData } from "../../crypto/utils.js";
import { openDatabase } from "../../db/db.js";
import { type Peer, PeerRepository, peerAnnouncementPayload } from "../../peer/repository.js";
import { generateBase64KeyPair } from "../helpers.js";

describe("PeerRepository", () => {
    const keys = generateBase64KeyPair();
    const peer: Peer = { baseUrl: "http://peer.example", name: "peer", publicKey: keys.publicKey };
    const expiry = () => new Date(Date.now() + 60_000).toISOString();

    let db: Database;
    let repository: PeerRepository;

    beforeEach(async () => {
        db = await openDatabase(":memory:");
        repository = new PeerRepository(db);
    });

    afterEach(async () => {
        await db.close();
    });

    function announce(announced: Peer, privateKey = keys.privateKey) {
        const at = expiry();
        return repository.announce(announced, signData(peerAnnouncementPayload(announced, at), privateKey), at);
    }

    test("getPeerByPublicKey maps columns to camel case", async () => {
        await repository.create(peer);

        expect(await repository.getPeerByPublicKey(peer.publicKey)).toEqual({ id: expect.any(Number), ...peer });
        expect(await repository.getPeerByPublicKey("unknown")).toBeUndefined();
    });

    test("create ignores a peer that is already known", async () => {
        await repository.create(peer);
        await repository.create(peer);
        await repository.create({ ...peer, publicKey: "other-key" });

        expect(await repository.getPeerList()).toEqual([peer]);
    });

    test("announce inserts, then updates the same key in place", async () => {
        expect(await announce(peer)).toEqual({ ok: true });
        const { id } = (await repository.getPeerByPublicKey(peer.publicKey))!;

        const renamed = { ...peer, name: "renamed" };
        expect(await announce(renamed)).toEqual({ ok: true });

        expect(await repository.getPeerByPublicKey(peer.publicKey)).toEqual({ id, ...renamed });
    });

    test("announce rejects a name held by another peer", async () => {
        await announce(peer);
        const other = generateBase64KeyPair();

        expect(await announce({ baseUrl: "http://other.example", name: peer.name, publicKey: other.publicKey }, other.privateKey))
            .toEqual({ ok: false, error: "conflict" });
    });

    test("announce rejects a malformed public key instead of throwing", async () => {
        expect(await announce({ ...peer, publicKey: "not-a-key" })).toEqual({ ok: false, error: "invalid_signature" });
    });
});
