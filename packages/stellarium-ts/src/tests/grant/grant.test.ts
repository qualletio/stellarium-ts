import { describe, expect, test } from "vitest";
import {
    type Capability,
    capabilityCovers,
    capabilityMatches,
    type Grant,
    grantHash,
    grantPayload,
    MAX_GRANT_CHAIN_LENGTH,
    signGrant,
    verifyChain,
} from "../../grant/grant.js";
import { verifyData } from "../../crypto/utils.js";
import { generateBase64KeyPair } from "../helpers.js";

const inHours = (hours: number) => new Date(Date.now() + hours * 3_600_000).toISOString();
const weather: Capability = { resourcePath: "com.example", resourceName: "Weather" };
// Shared, so a child computed a millisecond later doesn't outlive its parent.
const expiresAt = inHours(1);

type Keys = ReturnType<typeof generateBase64KeyPair>;

function grantFrom(issuer: Keys, audience: Keys, capabilities: Capability[], parent: Grant | null = null, overrides: Partial<Omit<Grant, "signature">> = {}): Grant {
    return signGrant({
        id: crypto.randomUUID(),
        issuer: issuer.publicKey,
        issuerBaseUrl: "http://issuer",
        audience: audience.publicKey,
        capabilities,
        issuedAt: new Date().toISOString(),
        expiresAt,
        parent: parent ? grantHash(parent) : null,
        ...overrides,
    }, issuer.privateKey);
}

describe("verifyChain", () => {
    const provider = generateBase64KeyPair();
    const gateway = generateBase64KeyPair();
    const user = generateBase64KeyPair();
    const other = generateBase64KeyPair();

    test("accepts a root grant and returns it as the leaf", () => {
        const root = grantFrom(provider, gateway, [weather]);

        expect(verifyChain([root], provider.publicKey)).toEqual({ ok: true, leaf: root });
        expect(verifyData(grantPayload(root), provider.publicKey, root.signature)).toBe(true);
    });

    test("accepts a three-grant chain that narrows at each link", () => {
        const root = grantFrom(provider, gateway, [{ resourcePath: "com.*" }]);
        const middle = grantFrom(gateway, user, [weather], root);
        const leaf = grantFrom(user, other, [{ ...weather, functionName: "temperature", constraints: { city: "Oslo" } }], middle);

        expect(verifyChain([root, middle, leaf], provider.publicKey)).toEqual({ ok: true, leaf });
    });

    test.each([
        ["an empty chain", () => []],
        ["a non-array", () => "nope"],
        ["a malformed grant", () => [{ ...grantFrom(provider, gateway, [weather]), capabilities: [] }]],
    ])("rejects %s", (_, chain) => {
        expect(verifyChain(chain(), provider.publicKey).ok).toBe(false);
    });

    test("rejects a root issued by another key", () => {
        expect(verifyChain([grantFrom(other, gateway, [weather])], provider.publicKey).ok).toBe(false);
    });

    test("rejects a root that claims a parent", () => {
        const root = grantFrom(provider, gateway, [weather], null, { parent: "something" });
        expect(verifyChain([root], provider.publicKey).ok).toBe(false);
    });

    test("rejects a tampered grant", () => {
        const root = grantFrom(provider, gateway, [weather]);
        expect(verifyChain([{ ...root, capabilities: [{ resourcePath: "*" }] }], provider.publicKey).ok).toBe(false);
    });

    test("rejects an expired grant and one that lives too long", () => {
        expect(verifyChain([grantFrom(provider, gateway, [weather], null, { expiresAt: inHours(-1) })], provider.publicKey).ok).toBe(false);
        expect(verifyChain([grantFrom(provider, gateway, [weather], null, { expiresAt: inHours(24 * 31) })], provider.publicKey).ok).toBe(false);
    });

    test("rejects a link signed by someone other than the parent's audience", () => {
        const root = grantFrom(provider, gateway, [weather]);
        expect(verifyChain([root, grantFrom(other, user, [weather], root)], provider.publicKey).ok).toBe(false);
    });

    test("rejects a link naming a different parent", () => {
        const root = grantFrom(provider, gateway, [weather]);
        const sibling = grantFrom(provider, gateway, [weather]);
        expect(verifyChain([root, grantFrom(gateway, user, [weather], sibling)], provider.publicKey).ok).toBe(false);
    });

    test("rejects a link that outlives its parent", () => {
        const root = grantFrom(provider, gateway, [weather]);
        expect(verifyChain([root, grantFrom(gateway, user, [weather], root, { expiresAt: inHours(2) })], provider.publicKey).ok).toBe(false);
    });

    test.each([
        ["a wider path", { resourcePath: "com.*" }],
        ["another resource", { resourcePath: "com.example", resourceName: "Traffic" }],
    ])("rejects a link that widens to %s", (_, capability) => {
        const root = grantFrom(provider, gateway, [weather]);
        expect(verifyChain([root, grantFrom(gateway, user, [capability], root)], provider.publicKey).ok).toBe(false);
    });

    test("rejects a link that drops a constraint", () => {
        const root = grantFrom(provider, gateway, [{ ...weather, constraints: { city: "Oslo" } }]);
        expect(verifyChain([root, grantFrom(gateway, user, [weather], root)], provider.publicKey).ok).toBe(false);
    });

    test("rejects a chain longer than the limit", () => {
        const keys = Array.from({ length: MAX_GRANT_CHAIN_LENGTH + 1 }, () => generateBase64KeyPair());
        const chain: Grant[] = [grantFrom(provider, keys[0], [weather])];
        for (let i = 1; i <= MAX_GRANT_CHAIN_LENGTH; i++) {
            chain.push(grantFrom(keys[i - 1], keys[i], [weather], chain[i - 1]));
        }

        expect(verifyChain(chain.slice(0, MAX_GRANT_CHAIN_LENGTH), provider.publicKey).ok).toBe(true);
        expect(verifyChain(chain, provider.publicKey).ok).toBe(false);
    });
});

describe("capabilityMatches", () => {
    const oslo = [{ name: "city", value: "Oslo" }];

    test.each([
        [{ resourcePath: "com.example" }, "com.example", true],
        [{ resourcePath: "com.example.*" }, "com.example", true],
        [{ resourcePath: "com.example.*" }, "com.example.sub", true],
        [{ resourcePath: "com.example.*" }, "com.examplefoo", false],
        [{ resourcePath: "com.*" }, "com.example", true],
        [{ resourcePath: "*" }, "org.anything", true],
        [{ resourcePath: "com.example" }, "com.example.sub", false],
    ])("%o on path %s is %s", (capability, path, expected) => {
        expect(capabilityMatches(capability, path, "Weather", "temperature", oslo)).toBe(expected);
    });

    test("checks names and constraints", () => {
        expect(capabilityMatches({ ...weather, functionName: "temperature" }, "com.example", "Weather", "humidity", oslo)).toBe(false);
        expect(capabilityMatches({ ...weather, constraints: { city: "Oslo" } }, "com.example", "Weather", "temperature", oslo)).toBe(true);
        expect(capabilityMatches({ ...weather, constraints: { city: "Paris" } }, "com.example", "Weather", "temperature", oslo)).toBe(false);
        expect(capabilityMatches({ ...weather, constraints: { units: "C" } }, "com.example", "Weather", "temperature", oslo)).toBe(false);
    });
});

describe("capabilityCovers", () => {
    test.each([
        [{ resourcePath: "*" }, { resourcePath: "*" }, true],
        [{ resourcePath: "*" }, { resourcePath: "com.example" }, true],
        [{ resourcePath: "com.*" }, { resourcePath: "com.example.*" }, true],
        [{ resourcePath: "com.*" }, { resourcePath: "*" }, false],
        [{ resourcePath: "com.example.*" }, { resourcePath: "com.examplefoo" }, false],
        [{ resourcePath: "com.example" }, { resourcePath: "com.example.*" }, false],
        [weather, { ...weather, functionName: "temperature" }, true],
        [{ ...weather, functionName: "temperature" }, weather, false],
        [{ ...weather, constraints: { city: "Oslo" } }, { ...weather, constraints: { city: "Oslo", units: "C" } }, true],
        [{ ...weather, constraints: { city: "Oslo" } }, { ...weather, constraints: { city: "Paris" } }, false],
    ])("%o covers %o: %s", (parent, child, expected) => {
        expect(capabilityCovers(parent, child)).toBe(expected);
    });
});
