import type { ResourceFunctionCallParameter } from "requestscript";
import { hashData, isFreshExpiry, safeVerifyData, signData } from "../crypto/utils.js";

/**
 * What a grant lets its audience call. `resourcePath` is exact, a segment prefix such as
 * `com.example.*`, or `*` for any path. An omitted `resourceName` or `functionName` matches any.
 * Each constraint requires the parameter of that name to equal the value (compared as JSON).
 */
export interface Capability {
    resourcePath: string;
    resourceName?: string;
    functionName?: string;
    constraints?: Record<string, unknown>;
}

/**
 * A signed statement that `issuer` lets `audience` call `capabilities` until `expiresAt`.
 * A root grant (`parent: null`) is issued by the provider. A delegated grant is issued by the
 * previous grant's audience, may only narrow it, and names it by `grantHash`.
 */
export interface Grant {
    /** Kept across renewals, so revoking an id revokes every renewal of it. */
    id: string;
    /** Ed25519 SPKI DER, base64url. */
    issuer: string;
    /** Where the audience renews this grant. */
    issuerBaseUrl: string;
    audience: string;
    capabilities: Capability[];
    issuedAt: string;
    expiresAt: string;
    parent: string | null;
    signature: string;
}

/** Sent with a call to a restricted function. Signed by the leaf grant's audience. */
export interface InvocationAuthorization {
    publicKey: string;
    /** Root first. */
    grants: Grant[];
    nonce: string;
    expiresAt: string;
    signature: string;
}

/** Asks a grant's issuer for a fresh copy of it. Signed by the grant's audience. */
export interface GrantRenewalRequest {
    grantId: string;
    publicKey: string;
    nonce: string;
    expiresAt: string;
    signature: string;
}

/** Asks a node for a new root grant. Signed by the key that would become its audience. */
export interface GrantRequest {
    publicKey: string;
    capabilities: Capability[];
    /** Anything the node's approval hook needs, such as an invite code. */
    details?: Record<string, unknown> | null;
    nonce: string;
    expiresAt: string;
    signature: string;
}

/** Longest lifetime of one grant. Renewal extends access past it. */
export const MAX_GRANT_LIFETIME_MS = 1000 * 60 * 60 * 24 * 30;
/** Longest lifetime of an invocation authorization or a renewal request. */
export const MAX_AUTHORIZATION_LIFETIME_MS = 1000 * 60 * 2;
/** Longest delegation chain, root included. */
export const MAX_GRANT_CHAIN_LENGTH = 4;

/** The object a grant's signature covers: every field except `signature`. Key order is part of the signed bytes. */
export function grantPayload(grant: Omit<Grant, "signature">) {
    const { id, issuer, issuerBaseUrl, audience, capabilities, issuedAt, expiresAt, parent } = grant;
    return { id, issuer, issuerBaseUrl, audience, capabilities, issuedAt, expiresAt, parent };
}

/** Names a grant as a delegated grant's `parent`. Independent of the key order the grant arrived in. */
export function grantHash(grant: Grant): string {
    return hashData({ ...grantPayload(grant), signature: grant.signature });
}

/** Key order is part of the signed bytes. */
export function invocationAuthorizationPayload(payload: { invocationHash: string, publicKey: string, nonce: string, expiresAt: string, grantsHash: string }) {
    const { invocationHash, publicKey, nonce, expiresAt, grantsHash } = payload;
    return { invocationHash, publicKey, nonce, expiresAt, grantsHash };
}

export function grantsHash(grants: Grant[]): string {
    return hashData(grants.map(grantHash));
}

/** Key order is part of the signed bytes. */
export function grantRenewalPayload(request: Omit<GrantRenewalRequest, "signature">) {
    const { grantId, publicKey, nonce, expiresAt } = request;
    return { grantId, publicKey, nonce, expiresAt };
}

/** Key order is part of the signed bytes. Omitted `details` are signed as null. */
export function grantRequestPayload(request: Omit<GrantRequest, "signature">) {
    const { publicKey, capabilities, details, nonce, expiresAt } = request;
    return { publicKey, capabilities, details: details ?? null, nonce, expiresAt };
}

export function signGrant(grant: Omit<Grant, "signature">, privateKey: string): Grant {
    return { ...grantPayload(grant), signature: signData(grantPayload(grant), privateKey) };
}

const isString = (value: unknown): value is string => typeof value === "string";
const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const sameJson = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

export function isCapability(value: unknown): value is Capability {
    return isObject(value)
        && isString(value.resourcePath) && value.resourcePath.length > 0
        && (value.resourceName === undefined || isString(value.resourceName))
        && (value.functionName === undefined || isString(value.functionName))
        && (value.constraints === undefined || isObject(value.constraints));
}

export function isGrant(value: unknown): value is Grant {
    return isObject(value)
        && isString(value.id) && isString(value.issuer) && isString(value.issuerBaseUrl) && isString(value.audience)
        && Array.isArray(value.capabilities) && value.capabilities.length > 0 && value.capabilities.every(isCapability)
        && isString(value.issuedAt) && isString(value.expiresAt)
        && (value.parent === null || isString(value.parent))
        && isString(value.signature);
}

/** A `prefix.*` pattern's prefix, `''` for `*`, or undefined for an exact path. */
function wildcardPrefix(pattern: string): string | undefined {
    if (pattern === "*") {
        return "";
    }
    return pattern.endsWith(".*") ? pattern.slice(0, -2) : undefined;
}

/** Wildcards match on segment boundaries: `com.example.*` matches `com.example.sub` but not `com.examplefoo`. */
function underPrefix(path: string, prefix: string): boolean {
    return prefix === "" || path === prefix || path.startsWith(`${prefix}.`);
}

function pathMatches(pattern: string, path: string): boolean {
    const prefix = wildcardPrefix(pattern);
    return prefix === undefined ? pattern === path : underPrefix(path, prefix);
}

/** True when every path `child` matches is also matched by `parent`. */
function pathCovers(parent: string, child: string): boolean {
    const parentPrefix = wildcardPrefix(parent);
    if (parentPrefix === undefined) {
        return parent === child;
    }
    const childPrefix = wildcardPrefix(child);
    if (childPrefix === "") {
        return parentPrefix === "";
    }
    return underPrefix(childPrefix ?? child, parentPrefix);
}

export function capabilityMatches(capability: Capability, resourcePath: string, resourceName: string, functionName: string, parameters: ResourceFunctionCallParameter[]): boolean {
    if (!pathMatches(capability.resourcePath, resourcePath)) {
        return false;
    }
    if (capability.resourceName !== undefined && capability.resourceName !== resourceName) {
        return false;
    }
    if (capability.functionName !== undefined && capability.functionName !== functionName) {
        return false;
    }
    return Object.entries(capability.constraints ?? {}).every(([name, value]) => {
        const parameter = parameters.find(p => p.name === name);
        return parameter !== undefined && sameJson(parameter.value, value);
    });
}

/** True when `child` allows nothing `parent` doesn't. A delegated grant may only narrow its parent. */
export function capabilityCovers(parent: Capability, child: Capability): boolean {
    if (!pathCovers(parent.resourcePath, child.resourcePath)) {
        return false;
    }
    if (parent.resourceName !== undefined && child.resourceName !== parent.resourceName) {
        return false;
    }
    if (parent.functionName !== undefined && child.functionName !== parent.functionName) {
        return false;
    }
    const childConstraints = child.constraints ?? {};
    return Object.entries(parent.constraints ?? {}).every(([name, value]) => name in childConstraints && sameJson(childConstraints[name], value));
}

export type ChainResult = { ok: true, leaf: Grant } | { ok: false, reason: string };

/**
 * Checks a chain's signatures, expiries and links, root first. Revocation is the caller's
 * job, since it needs the verifier's own records.
 */
export function verifyChain(grants: unknown, rootKey: string): ChainResult {
    if (!Array.isArray(grants) || grants.length === 0 || grants.length > MAX_GRANT_CHAIN_LENGTH) {
        return { ok: false, reason: "chain length" };
    }
    if (!grants.every(isGrant)) {
        return { ok: false, reason: "malformed grant" };
    }

    for (const [index, grant] of grants.entries()) {
        if (!isFreshExpiry(grant.expiresAt, MAX_GRANT_LIFETIME_MS)) {
            return { ok: false, reason: `grant ${index} expired` };
        }
        if (!safeVerifyData(grantPayload(grant), grant.issuer, grant.signature)) {
            return { ok: false, reason: `grant ${index} signature` };
        }

        if (index === 0) {
            if (grant.parent !== null || grant.issuer !== rootKey) {
                return { ok: false, reason: "root issuer" };
            }
            continue;
        }

        const parent = grants[index - 1];
        if (grant.parent !== grantHash(parent) || grant.issuer !== parent.audience) {
            return { ok: false, reason: `grant ${index} link` };
        }
        if (Date.parse(grant.expiresAt) > Date.parse(parent.expiresAt)) {
            return { ok: false, reason: `grant ${index} outlives its parent` };
        }
        if (!grant.capabilities.every(child => parent.capabilities.some(capability => capabilityCovers(capability, child)))) {
            return { ok: false, reason: `grant ${index} widens its parent` };
        }
    }

    return { ok: true, leaf: grants[grants.length - 1] };
}
