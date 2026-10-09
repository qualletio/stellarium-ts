import { it, expect } from "vitest";
import { generateKeyPairSync } from "node:crypto";
import { openDatabase } from "../db/db.js";
import { createService } from "../service.js";
import {
    resourcePublication,
    savePublication,
    peerPublication,
} from "./publications.js";
it("authenticates resource ownership before caching peer publications", async () => {
    const db = await openDatabase(":memory:");
    try {
        const pair = generateKeyPairSync("ed25519");
        const publicKey = pair.publicKey
            .export({ type: "spki", format: "der" })
            .toString("base64url");
        const privateKey = pair.privateKey
            .export({ type: "pkcs8", format: "der" })
            .toString("base64url");
        const local = createService(
            [
                {
                    path: "example",
                    name: "Weather",
                    metadata: {},
                    functions: [
                        {
                            name: "forecast",
                            returnType: "int32",
                            parameters: [],
                            exec: async () => 12,
                        },
                    ],
                },
            ],
            db,
            "https://peer.example",
        );
        const remote = createService([], db, "https://remote.example");
        const peer = peerPublication(
            "https://peer.example",
            publicKey,
            privateKey,
        );
        await remote.peerRepository.createIfNotExists(
            peer,
            peer.signature,
            peer.expiry,
        );
        const publication = await resourcePublication(
            local,
            publicKey,
            privateKey,
        );
        await savePublication(remote, publication);
        expect(
            (await remote.resourceRepository.getResource("example.Weather"))
                ?.metadata.baseUrl,
        ).toBe("https://peer.example");
        publication.resources[0].baseUrl = "https://attacker.example";
        await expect(savePublication(remote, publication)).rejects.toThrow(
            "signature",
        );
    } finally {
        await db.close();
    }
});
