import { describe, it, expect } from "vitest";
import {
    createEvidenceKeys,
    encryptEvidence,
    decryptEvidence,
} from "../evidence/encryption.js";
import {
    createBrowserEvidenceKeys,
    decryptArbitratorEvidence,
    encryptForArbitrator,
} from "./evidence.js";
describe("browser evidence interoperability", () => {
    it("decrypts node evidence and rejects ciphertext tampering", async () => {
        const keys = await createBrowserEvidenceKeys();
        const envelope = encryptEvidence(
            { privateInput: "secret" },
            keys.publicKey,
        );
        expect(
            await decryptArbitratorEvidence(envelope, keys.privateKey),
        ).toEqual({ privateInput: "secret" });
        await expect(
            decryptArbitratorEvidence(
                { ...envelope, tag: Buffer.alloc(16).toString("base64") },
                keys.privateKey,
            ),
        ).rejects.toThrow();
    });
    it("produces browser evidence that the node can decrypt", async () => {
        const keys = createEvidenceKeys();
        const envelope = await encryptForArbitrator(
            { value: 12 },
            keys.publicKey,
        );
        expect(decryptEvidence(envelope, keys.privateKey)).toEqual({
            value: 12,
        });
    });
});
