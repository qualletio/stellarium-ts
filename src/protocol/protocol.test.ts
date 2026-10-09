import { describe, expect, it } from "vitest";
import { hashParameters, hashRequest, wireJson } from "./canonical.js";
import {
    createPrivateKeySigner,
    typedHash,
    verifySigned,
} from "./typed-data.js";
import { authorizationSchema, runSchema } from "./schema.js";
import type { Domain, RequestAuthorization } from "./types.js";
const domain: Domain = {
    name: "Stellarium",
    version: "1",
    chainId: 84532,
    verifyingContract: "0x0000000000000000000000000000000000000001",
};
const signer = createPrivateKeySigner(`0x${"1".repeat(64)}`);
const auth: RequestAuthorization = {
    protocolVersion: 1,
    requestId: `0x${"1".repeat(64)}`,
    caller: signer.address,
    budgetUsdc: 10_000_000n,
    requestHash: hashRequest("request X { return 1 }"),
    executionAuthority: signer.address,
    issuedAt: 100n,
    expiresAt: 1000n,
    nonce: 0n,
};
describe("payment protocol", () => {
    it("hashes canonical ASTs independent of whitespace and comments", () => {
        expect(hashRequest("request X { return 1 }")).toBe(
            hashRequest("request X {\n //comment\n return 1\n}"),
        );
        expect(hashRequest("request X { return 1 }")).not.toBe(
            hashRequest("request X { return 2 }"),
        );
    });
    it("hashes named parameters deterministically and rejects duplicates", () => {
        expect(
            hashParameters([
                { name: "b", value: 1 },
                { name: "a", value: { z: 2, x: 1 } },
            ]),
        ).toBe(
            hashParameters([
                { name: "a", value: { x: 1, z: 2 } },
                { name: "b", value: 1 },
            ]),
        );
        expect(() =>
            hashParameters([
                { name: "a", value: 1 },
                { name: "a", value: 2 },
            ]),
        ).toThrow("Duplicate");
    });
    it("round-trips signed authorization without losing precision", async () => {
        const signed = await signer.sign("RequestAuthorization", domain, {
            ...auth,
            budgetUsdc: 2n ** 128n,
        });
        const decoded = authorizationSchema.parse(JSON.parse(wireJson(signed)));
        expect(decoded.message.budgetUsdc).toBe(2n ** 128n);
        expect(
            await verifySigned(
                "RequestAuthorization",
                decoded,
                signer.address,
                domain,
            ),
        ).toBe(true);
        expect(typedHash("RequestAuthorization", decoded)).toBe(
            typedHash("RequestAuthorization", signed),
        );
        expect(
            await verifySigned(
                "RequestAuthorization",
                decoded,
                signer.address,
                { ...domain, chainId: 8453 },
            ),
        ).toBe(false);
    });
    it("requires JSON envelopes and rejects removed delegation fields", async () => {
        expect(runSchema.safeParse("request X { return 1 }").success).toBe(
            false,
        );
        const signed = await signer.sign("RequestAuthorization", domain, auth);
        const body = JSON.parse(
            wireJson({
                version: 1,
                kind: "request",
                source: "request X { return 1 }",
                payment: { authorization: signed },
            }),
        );
        expect(runSchema.safeParse(body).success).toBe(true);
        body.payment.authorization.message.allowNestedCalls = true;
        expect(runSchema.safeParse(body).success).toBe(false);
    });
});
