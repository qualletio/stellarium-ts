import {
    createCipheriv,
    createDecipheriv,
    createPublicKey,
    createPrivateKey,
    diffieHellman,
    generateKeyPairSync,
    hkdfSync,
    randomBytes,
    createHash,
} from "node:crypto";
import type { Database } from "sqlite";
import { wireJson } from "../protocol/canonical.js";
import type { Hex } from "../protocol/types.js";
export interface EncryptedEvidence {
    version: 1;
    ephemeralPublicKey: string;
    salt: string;
    iv: string;
    ciphertext: string;
    tag: string;
}
export function createEvidenceKeys(): {
    publicKey: string;
    privateKey: string;
} {
    const pair = generateKeyPairSync("x25519");
    return {
        publicKey: pair.publicKey
            .export({ type: "spki", format: "der" })
            .toString("base64"),
        privateKey: pair.privateKey
            .export({ type: "pkcs8", format: "der" })
            .toString("base64"),
    };
}
function publicKey(encoded: string) {
    return createPublicKey({
        key: Buffer.from(encoded, "base64"),
        type: "spki",
        format: "der",
    });
}
function privateKey(encoded: string) {
    return createPrivateKey({
        key: Buffer.from(encoded, "base64"),
        type: "pkcs8",
        format: "der",
    });
}
export function encryptEvidence(
    value: unknown,
    recipientPublicKey: string,
): EncryptedEvidence {
    const ephemeral = generateKeyPairSync("x25519");
    const recipient = publicKey(recipientPublicKey);
    if (recipient.asymmetricKeyType !== "x25519")
        throw new Error("Evidence key must be X25519");
    const salt = randomBytes(32);
    const iv = randomBytes(12);
    const key = hkdfSync(
        "sha256",
        diffieHellman({
            privateKey: ephemeral.privateKey,
            publicKey: recipient,
        }),
        salt,
        "Stellarium evidence v1",
        32,
    );
    const cipher = createCipheriv("aes-256-gcm", Buffer.from(key), iv);
    cipher.setAAD(Buffer.from("Stellarium evidence v1"));
    const ciphertext = Buffer.concat([
        cipher.update(wireJson(value), "utf8"),
        cipher.final(),
    ]);
    return {
        version: 1,
        ephemeralPublicKey: ephemeral.publicKey
            .export({ type: "spki", format: "der" })
            .toString("base64"),
        salt: salt.toString("base64"),
        iv: iv.toString("base64"),
        ciphertext: ciphertext.toString("base64"),
        tag: cipher.getAuthTag().toString("base64"),
    };
}
export function decryptEvidence(
    envelope: EncryptedEvidence,
    recipientPrivateKey: string,
): unknown {
    if (envelope.version !== 1) throw new Error("Unknown evidence version");
    const key = hkdfSync(
        "sha256",
        diffieHellman({
            privateKey: privateKey(recipientPrivateKey),
            publicKey: publicKey(envelope.ephemeralPublicKey),
        }),
        Buffer.from(envelope.salt, "base64"),
        "Stellarium evidence v1",
        32,
    );
    const decipher = createDecipheriv(
        "aes-256-gcm",
        Buffer.from(key),
        Buffer.from(envelope.iv, "base64"),
    );
    decipher.setAAD(Buffer.from("Stellarium evidence v1"));
    decipher.setAuthTag(Buffer.from(envelope.tag, "base64"));
    return JSON.parse(
        Buffer.concat([
            decipher.update(Buffer.from(envelope.ciphertext, "base64")),
            decipher.final(),
        ]).toString("utf8"),
    );
}
export class EvidenceStore {
    constructor(
        private readonly db: Database,
        readonly publicKey: string,
        private readonly privateKey: string,
    ) {}
    async put(value: unknown): Promise<Hex> {
        const envelope = encryptEvidence(value, this.publicKey);
        const id =
            `0x${createHash("sha256").update(JSON.stringify(envelope)).digest("hex")}` as Hex;
        await this.db.run(
            "INSERT INTO evidence(id,encrypted_json,created_at) VALUES(?,?,?)",
            id,
            JSON.stringify(envelope),
            Date.now(),
        );
        return id;
    }
    async get(id: Hex): Promise<EncryptedEvidence | undefined> {
        const row = await this.db.get(
            "SELECT encrypted_json FROM evidence WHERE id=?",
            id,
        );
        return row ? JSON.parse(row.encrypted_json) : undefined;
    }
    async release(
        id: Hex,
        arbitratorPublicKey: string,
    ): Promise<EncryptedEvidence> {
        const envelope = await this.get(id);
        if (!envelope) throw new Error("Evidence not found");
        return encryptEvidence(
            decryptEvidence(envelope, this.privateKey),
            arbitratorPublicKey,
        );
    }
}
