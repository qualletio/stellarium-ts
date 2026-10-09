import { bytesToHex } from "viem";
import type { RunBody, ProtocolSigner, Domain, Address } from "./types.js";
import { hashValue, wireJson } from "./canonical.js";
import { hashName, typedHash, verifySigned } from "./typed-data.js";
export function runPayloadHash(body: RunBody) {
    const { accessProof: _proof, ...payload } = body;
    void _proof;
    return hashValue(JSON.parse(wireJson(payload)));
}
export async function proveRunAccess(
    body: RunBody,
    signer: ProtocolSigner,
    domain: Domain,
    endpoint: string,
): Promise<RunBody> {
    const now = BigInt(Math.floor(Date.now() / 1000));
    return {
        ...body,
        accessProof: await signer.sign("RunAccess", domain, {
            protocolVersion: 1,
            payloadHash: runPayloadHash(body),
            endpointHash: hashName(endpoint.replace(/\/$/, "") + "/v1/run"),
            issuedAt: now,
            expiresAt: now + 300n,
            nonce: bytesToHex(crypto.getRandomValues(new Uint8Array(32))),
        }),
    };
}
export async function verifyRunAccess(
    body: RunBody,
    expected: Address,
    domain: Domain,
    endpoint: string,
): Promise<string> {
    const proof = body.accessProof;
    const now = BigInt(Math.floor(Date.now() / 1000));
    if (
        !proof ||
        proof.message.issuedAt > now ||
        proof.message.expiresAt < now ||
        proof.message.expiresAt - proof.message.issuedAt > 300n ||
        proof.message.expiresAt <= proof.message.issuedAt ||
        proof.message.payloadHash !== runPayloadHash(body) ||
        proof.message.endpointHash !==
            hashName(endpoint.replace(/\/$/, "") + "/v1/run") ||
        !(await verifySigned("RunAccess", proof, expected, domain))
    )
        throw new Error("Invalid request access proof");
    return typedHash("RunAccess", proof);
}
