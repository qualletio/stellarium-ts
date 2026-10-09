import { bytesToHex } from "viem";
import { wireJson, hashValue } from "../protocol/canonical.js";
import type {
    ChainAccess,
    ProtocolSigner,
    Hex,
    Address,
} from "../protocol/types.js";
import type { EncryptedEvidence } from "../evidence/encryption.js";
const decode = (value: string): Uint8Array<ArrayBuffer> =>
    Uint8Array.from(atob(value), (char) => char.charCodeAt(0));
const encode = (value: Uint8Array): string =>
    btoa(Array.from(value, (byte) => String.fromCharCode(byte)).join(""));
/** Browser-compatible X25519 / HKDF-SHA256 / AES-256-GCM, matching the node evidence format. */
export async function encryptForArbitrator(
    value: unknown,
    publicKey: string,
): Promise<EncryptedEvidence> {
    const subtle = crypto.subtle;
    const recipient = await subtle.importKey(
        "spki",
        decode(publicKey),
        { name: "X25519" },
        false,
        [],
    );
    const ephemeral = (await subtle.generateKey({ name: "X25519" }, true, [
        "deriveBits",
    ])) as unknown as { publicKey: CryptoKey; privateKey: CryptoKey };
    const shared = await subtle.deriveBits(
        { name: "X25519", public: recipient },
        ephemeral.privateKey,
        256,
    );
    const salt = crypto.getRandomValues(new Uint8Array(32));
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const info = new TextEncoder().encode("Stellarium evidence v1");
    const hkdf = await subtle.importKey("raw", shared, "HKDF", false, [
        "deriveKey",
    ]);
    const key = await subtle.deriveKey(
        { name: "HKDF", hash: "SHA-256", salt, info },
        hkdf,
        { name: "AES-GCM", length: 256 },
        false,
        ["encrypt"],
    );
    const ciphertext = new Uint8Array(
        await subtle.encrypt(
            { name: "AES-GCM", iv, additionalData: info, tagLength: 128 },
            key,
            new TextEncoder().encode(wireJson(value)),
        ),
    );
    return {
        version: 1,
        ephemeralPublicKey: encode(
            new Uint8Array(await subtle.exportKey("spki", ephemeral.publicKey)),
        ),
        salt: encode(salt),
        iv: encode(iv),
        ciphertext: encode(ciphertext.slice(0, -16)),
        tag: encode(ciphertext.slice(-16)),
    };
}
export async function deliverEvidence(
    chain: ChainAccess,
    signer: ProtocolSigner,
    receiptId: Hex,
    evidence: unknown,
    storageEndpoint: string,
    fetcher: typeof fetch = fetch,
): Promise<{
    commitment: Hex;
    deliveries: { arbitrator: Address; evidenceId: Hex; location: string }[];
}> {
    const panel = await chain.getArbitrationPanel(receiptId);
    if (
        !panel ||
        ![panel.caller.toLowerCase(), panel.provider.toLowerCase()].includes(
            signer.address.toLowerCase(),
        )
    )
        throw new Error("Not a party to an active evidence round");
    const deliveries = [];
    for (const arbitrator of panel.arbitrators) {
        const envelope = await encryptForArbitrator(
            evidence,
            arbitrator.encryptionPublicKey,
        );
        const now = BigInt(Math.floor(Date.now() / 1000));
        const proof = await signer.sign("EvidenceDelivery", chain.domain, {
            protocolVersion: 1,
            receiptId,
            arbitrator: arbitrator.address,
            round: panel.round,
            encryptedHash: hashValue(envelope),
            issuedAt: now,
            expiresAt: panel.evidenceUntil,
            nonce: bytesToHex(crypto.getRandomValues(new Uint8Array(32))),
        });
        const response = await fetcher(
            `${storageEndpoint.replace(/\/$/, "")}/v1/evidence/deliver`,
            {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: wireJson({ envelope, proof }),
            },
        );
        if (!response.ok) throw new Error("Encrypted evidence delivery failed");
        const data = (await response.json()) as { evidenceId: Hex };
        deliveries.push({
            arbitrator: arbitrator.address,
            evidenceId: data.evidenceId,
            location: `${storageEndpoint.replace(/\/$/, "")}/v1/evidence/${data.evidenceId}`,
        });
    }
    return { commitment: hashValue(deliveries), deliveries };
}

export async function createBrowserEvidenceKeys(): Promise<{
    publicKey: string;
    privateKey: string;
}> {
    const pair = (await crypto.subtle.generateKey({ name: "X25519" }, true, [
        "deriveBits",
    ])) as unknown as { publicKey: CryptoKey; privateKey: CryptoKey };
    return {
        publicKey: encode(
            new Uint8Array(
                await crypto.subtle.exportKey("spki", pair.publicKey),
            ),
        ),
        privateKey: encode(
            new Uint8Array(
                await crypto.subtle.exportKey("pkcs8", pair.privateKey),
            ),
        ),
    };
}
export async function decryptArbitratorEvidence(
    envelope: EncryptedEvidence,
    privateKey: string,
): Promise<unknown> {
    if (envelope.version !== 1) throw new Error("Unknown evidence version");
    const subtle = crypto.subtle;
    const recipient = await subtle.importKey(
        "pkcs8",
        decode(privateKey),
        { name: "X25519" },
        false,
        ["deriveBits"],
    );
    const ephemeral = await subtle.importKey(
        "spki",
        decode(envelope.ephemeralPublicKey),
        { name: "X25519" },
        false,
        [],
    );
    const shared = await subtle.deriveBits(
        { name: "X25519", public: ephemeral },
        recipient,
        256,
    );
    const hkdf = await subtle.importKey("raw", shared, "HKDF", false, [
        "deriveKey",
    ]);
    const info = new TextEncoder().encode("Stellarium evidence v1");
    const key = await subtle.deriveKey(
        { name: "HKDF", hash: "SHA-256", salt: decode(envelope.salt), info },
        hkdf,
        { name: "AES-GCM", length: 256 },
        false,
        ["decrypt"],
    );
    const ciphertext = decode(envelope.ciphertext),
        tag = decode(envelope.tag);
    const sealed = new Uint8Array(ciphertext.length + tag.length);
    sealed.set(ciphertext);
    sealed.set(tag, ciphertext.length);
    return JSON.parse(
        new TextDecoder().decode(
            await subtle.decrypt(
                {
                    name: "AES-GCM",
                    iv: decode(envelope.iv),
                    additionalData: info,
                    tagLength: 128,
                },
                key,
                sealed,
            ),
        ),
    );
}
