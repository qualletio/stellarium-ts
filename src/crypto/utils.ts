import { createPrivateKey, createPublicKey, sign, verify } from "node:crypto";

export function signData(data: object, privateKey: string): string {
    const key = createPrivateKey({
        key: Buffer.from(privateKey, "base64url"),
        format: "der",
        type: "pkcs8",
    });
    const bytes = Buffer.from(JSON.stringify(data));
    return sign(null, bytes, key).toString("base64url");
}

export function verifyData(
    data: object,
    publicKey: string,
    signature: string,
): boolean {
    const key = createPublicKey({
        key: Buffer.from(publicKey, "base64url"),
        format: "der",
        type: "spki",
    });
    const bytes = Buffer.from(JSON.stringify(data));
    return verify(null, bytes, key, Buffer.from(signature, "base64url"));
}
