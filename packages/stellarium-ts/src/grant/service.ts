import type { ResourceFunctionCallParameter } from "requestscript";
import { isFreshExpiry, isValidPublicKey, safeVerifyData, signData } from "../crypto/utils.js";
import { invocationHash } from "../resource/invoker.js";
import type { NodeConfig } from "../service.js";
import {
    type Capability,
    capabilityCovers,
    capabilityMatches,
    CLOCK_SKEW_TOLERANCE_MS,
    type Grant,
    type GrantRenewalRequest,
    type GrantRequest,
    grantHash,
    grantRenewalPayload,
    grantRequestPayload,
    grantsHash,
    type InvocationAuthorization,
    invocationAuthorizationPayload,
    isCapability,
    isGrant,
    MAX_AUTHORIZATION_LIFETIME_MS,
    MAX_GRANT_CHAIN_LENGTH,
    MAX_GRANT_LIFETIME_MS,
    signGrant,
    verifyChain,
} from "./grant.js";
import type { BlockedCaller, GrantRepository, HeldGrantKey } from "./repository.js";

export interface GrantOptions {
    /** How long each issued copy lasts. At most `MAX_GRANT_LIFETIME_MS`. */
    lifetimeMs: number;
    /** No renewals after this time. Omit to allow renewal until revoked. */
    renewableUntil?: string;
}

/** What an approval hook decides: how long the grant lasts, and optionally narrower capabilities than requested. */
export interface GrantApproval extends GrantOptions {
    capabilities?: Capability[];
}

/**
 * Decides a signed grant request. The caller's key and the request's freshness are already
 * checked. Return undefined to refuse.
 */
export type ApproveGrant = (request: { publicKey: string, capabilities: Capability[], details: Record<string, unknown> | null }) => GrantApproval | undefined | Promise<GrantApproval | undefined>;

export interface InvocationTarget {
    resourcePath: string;
    resourceName: string;
    functionName: string;
    parameters: ResourceFunctionCallParameter[];
}

export interface RefreshResult {
    renewed: string[];
    failed: { id: string, error: string }[];
    /** Chains expired for longer than `HELD_GRANT_RETENTION_MS` whose issuer still refused renewal. They are deleted. */
    removed: string[];
}

/** Per grant request or renewal. */
export const GRANT_RENEW_TIMEOUT_MS = 10_000;
/**
 * How long a held chain is kept after it expires while its issuer refuses to renew it. A refusal
 * may be temporary, such as while this node's key is blocked, so chains aren't deleted at once.
 */
export const HELD_GRANT_RETENTION_MS = MAX_GRANT_LIFETIME_MS;
/** How often claiming a nonce also deletes expired ones. */
const NONCE_SWEEP_INTERVAL_MS = 60_000;

/** Thrown by `block` for a key that isn't an Ed25519 SPKI key. */
export class InvalidPublicKeyError extends Error {
    constructor() {
        super('Invalid public key');
    }
}

/** The issuer answered a renewal with a refusal, as opposed to failing to answer. */
class RenewalRefusedError extends Error {}

const expired = (grant: Grant, now = Date.now()) => Date.parse(grant.expiresAt) <= now;
const leafOf = (chain: Grant[]) => chain[chain.length - 1];
const heldKey = (chain: Grant[]): HeldGrantKey => ({ issuer: leafOf(chain).issuer, id: leafOf(chain).id });

/**
 * Issues, holds, renews and verifies capability grants. Every node plays all three roles:
 * a provider issues root grants, a holder can delegate narrower grants and renew them for
 * its own audiences, and renewal of either kind goes through `renew`.
 */
export class GrantService {
    private lastNonceSweep = 0;

    /** Without `approveGrant`, this node refuses every grant request. */
    constructor(private readonly repository: GrantRepository, private readonly config: Pick<NodeConfig, "baseUrl" | "publicKey" | "privateKey">, private readonly approveGrant?: ApproveGrant) {}

    get acceptsRequests(): boolean {
        return this.approveGrant !== undefined;
    }

    /** Issues a root grant for this node's resources. Returns it as a one-grant chain. */
    async issue(audience: string, capabilities: Capability[], options: GrantOptions): Promise<Grant[]> {
        checkCapabilities(capabilities);
        checkOptions(options);
        const grant = this.sign(crypto.randomUUID(), audience, capabilities, options.lifetimeMs, null);
        await this.repository.saveIssued({ id: grant.id, audience, capabilities, parent: null, lifetimeMs: options.lifetimeMs, renewableUntil: options.renewableUntil ?? null });
        return [grant];
    }

    /**
     * Narrows a grant this node holds for another audience. The child expires no later than the
     * held grant. Name the held grant by its id, or by its issuer and id when two issuers used the same id.
     */
    async delegate(heldGrant: string | HeldGrantKey, audience: string, capabilities: Capability[], options: GrantOptions): Promise<Grant[]> {
        checkCapabilities(capabilities);
        checkOptions(options);
        const chain = await this.findHeld(heldGrant);
        if (expired(leafOf(chain))) {
            throw new Error(`No unexpired held grant ${leafOf(chain).id}`);
        }
        if (chain.length >= MAX_GRANT_CHAIN_LENGTH) {
            throw new Error(`Grant chains are limited to ${MAX_GRANT_CHAIN_LENGTH} grants`);
        }
        const parent = leafOf(chain);
        if (!capabilities.every(child => parent.capabilities.some(capability => capabilityCovers(capability, child)))) {
            throw new Error('A delegated grant may only narrow the grant it is delegated from');
        }

        const grant = this.sign(crypto.randomUUID(), audience, capabilities, options.lifetimeMs, parent);
        await this.repository.saveIssued({ id: grant.id, audience, capabilities, parent: heldKey(chain), lifetimeMs: options.lifetimeMs, renewableUntil: options.renewableUntil ?? null });
        return [...chain, grant];
    }

    /**
     * Revoked ids are refused in any chain this node verifies, and are never renewed. A
     * delegator's revocation only stops renewal, since the provider never sees it, so it
     * takes effect when the current copy expires.
     */
    async revoke(grantId: string): Promise<void> {
        await this.repository.revoke(grantId);
    }

    /**
     * Refuses `publicKey` everywhere this node can identify a caller: in any position of a
     * restricted call's chain, and in renewals, grant requests and payment vouchers.
     */
    async block(publicKey: string, reason?: string): Promise<void> {
        if (!isValidPublicKey(publicKey)) {
            throw new InvalidPublicKeyError();
        }
        await this.repository.block(publicKey, reason ?? null);
    }

    /** False when the key wasn't blocked. */
    async unblock(publicKey: string): Promise<boolean> {
        return this.repository.unblock(publicKey);
    }

    async isBlocked(publicKey: string): Promise<boolean> {
        return this.repository.anyBlocked([publicKey]);
    }

    async getBlocked(offset: number, limit: number): Promise<BlockedCaller[]> {
        return this.repository.getBlocked(offset, limit);
    }

    /** Handles a holder's renewal request for a grant this node issued. Returns the fresh chain, or undefined if refused. */
    async renew(request: GrantRenewalRequest): Promise<Grant[] | undefined> {
        // A replayed request only hands the audience another copy that it alone can use, so nonces aren't tracked.
        if (!isFreshExpiry(request.expiresAt, MAX_AUTHORIZATION_LIFETIME_MS + CLOCK_SKEW_TOLERANCE_MS) || !safeVerifyData(grantRenewalPayload(request), request.publicKey, request.signature)) {
            return undefined;
        }
        const issued = await this.repository.getIssued(request.grantId);
        if (!issued || issued.audience !== request.publicKey || await this.isBlocked(request.publicKey)) {
            return undefined;
        }
        if (issued.renewableUntil !== null && Date.parse(issued.renewableUntil) <= Date.now()) {
            return undefined;
        }

        let chain: Grant[] = [];
        if (issued.parent !== null) {
            const held = await this.repository.getHeld(issued.parent);
            if (!held || expired(leafOf(held))) {
                return undefined;
            }
            chain = held;
        }
        if (await this.repository.anyRevoked([issued.id, ...chain.map(grant => grant.id)])) {
            return undefined;
        }

        const parent = chain.length > 0 ? leafOf(chain) : null;
        return [...chain, this.sign(issued.id, issued.audience, issued.capabilities, issued.lifetimeMs, parent)];
    }

    /**
     * Handles a caller's request for a new root grant: checks its signature and nonce, then
     * asks the approval hook. Returns the issued chain, or undefined if refused. Throws if the
     * hook throws or returns an invalid approval; the caller must then sign a new request.
     */
    async handleRequest(request: GrantRequest): Promise<Grant[] | undefined> {
        if (!this.approveGrant) {
            return undefined;
        }
        const { publicKey, capabilities, nonce, expiresAt, signature } = request;
        const details = request.details ?? null;
        if (!Array.isArray(capabilities) || capabilities.length === 0 || !capabilities.every(isCapability)) {
            return undefined;
        }
        if (details !== null && (typeof details !== 'object' || Array.isArray(details))) {
            return undefined;
        }
        if (!isFreshExpiry(expiresAt, MAX_AUTHORIZATION_LIFETIME_MS + CLOCK_SKEW_TOLERANCE_MS) || !safeVerifyData(grantRequestPayload(request), publicKey, signature)) {
            return undefined;
        }
        if (await this.isBlocked(publicKey)) {
            return undefined;
        }
        // The hook may have side effects, such as using up an invite code, so it sees each request once.
        if (!await this.claimNonce(`request:${publicKey}`, nonce, Date.parse(expiresAt))) {
            return undefined;
        }

        const approval = await this.approveGrant({ publicKey, capabilities, details });
        if (!approval) {
            return undefined;
        }
        const granted = approval.capabilities ?? capabilities;
        try {
            checkCapabilities(granted);
            checkOptions(approval);
        } catch (error) {
            throw new Error(`approveGrant returned an invalid approval: ${error instanceof Error ? error.message : String(error)}`);
        }
        return this.issue(publicKey, granted, approval);
    }

    /**
     * Asks the node at `providerBaseUrl` for a root grant and stores it. Throws if refused.
     * The provider verifies the grant again on every call, so a grant from the wrong key only fails there.
     */
    async request(providerBaseUrl: string, capabilities: Capability[], details?: Record<string, unknown>): Promise<Grant[]> {
        const unsigned = { publicKey: this.config.publicKey, capabilities, details: details ?? null, nonce: crypto.randomUUID(), expiresAt: new Date(Date.now() + MAX_AUTHORIZATION_LIFETIME_MS).toISOString() };
        const request: GrantRequest = { ...unsigned, signature: signData(grantRequestPayload(unsigned), this.config.privateKey) };

        const response = await fetch(`${providerBaseUrl}/v1/grants/request`, {
            method: 'POST',
            body: JSON.stringify(request),
            headers: { 'Content-Type': 'application/json' },
            signal: AbortSignal.timeout(GRANT_RENEW_TIMEOUT_MS),
        });
        if (!response.ok) {
            const detail = await response.json().then((body) => (body as { error?: unknown } | null)?.error, () => undefined);
            throw new Error(`Grant request to ${providerBaseUrl} refused: ${typeof detail === 'string' ? detail : response.status}`);
        }
        const { grants } = await response.json() as { grants: Grant[] };

        const chain = verifyChain(grants, Array.isArray(grants) && isGrant(grants[0]) ? grants[0].issuer : '');
        if (!chain.ok || grants.length !== 1 || grants[0].issuerBaseUrl !== providerBaseUrl || chain.leaf.audience !== this.config.publicKey) {
            throw new Error(`Grant request to ${providerBaseUrl} returned an invalid grant`);
        }
        await this.repository.saveHeld(grants);
        return grants;
    }

    /** Stores a chain whose leaf names this node as its audience. Throws if the chain is invalid. */
    async add(chain: Grant[]): Promise<void> {
        const result = verifyChain(chain, Array.isArray(chain) && isGrant(chain[0]) ? chain[0].issuer : '');
        if (!result.ok) {
            throw new Error(`Invalid grant chain: ${result.reason}`);
        }
        if (result.leaf.audience !== this.config.publicKey) {
            throw new Error('Grant chain is not addressed to this node');
        }
        await this.repository.saveHeld(chain);
    }

    /**
     * A held chain, rooted at the node serving `rootBaseUrl`, that covers the call. When every
     * such chain has expired, the latest-expiring one is renewed, once, before giving up, so a
     * call waits on at most one renewal. Undefined when this node holds no usable grant.
     */
    async chainFor(rootBaseUrl: string, target: InvocationTarget): Promise<Grant[] | undefined> {
        const chains = (await this.repository.getHeldByRoot(rootBaseUrl)).filter(chain =>
            leafOf(chain).capabilities.some(capability => capabilityMatches(capability, target.resourcePath, target.resourceName, target.functionName, target.parameters)));

        const chain = chains.find(candidate => !expired(leafOf(candidate)));
        if (chain || chains.length === 0) {
            return chain;
        }
        try {
            return await this.renewHeld(chains[0]);
        } catch {
            return undefined;
        }
    }

    /** Builds the authorization sent with a call. Sign a new one per attempt: providers refuse a reused nonce. */
    authorize(chain: Grant[], target: InvocationTarget): InvocationAuthorization {
        const nonce = crypto.randomUUID();
        const expiresAt = new Date(Date.now() + MAX_AUTHORIZATION_LIFETIME_MS).toISOString();
        const hash = invocationHash(target.resourcePath, target.resourceName, target.functionName, target.parameters);
        const signature = signData(invocationAuthorizationPayload({ invocationHash: hash, publicKey: this.config.publicKey, nonce, expiresAt, grantsHash: grantsHash(chain) }), this.config.privateKey);
        return { publicKey: this.config.publicKey, grants: chain, nonce, expiresAt, signature };
    }

    /**
     * Renews every held chain past half its lifetime. A failed renewal keeps the current copy,
     * unless the issuer refused it and the chain expired more than `HELD_GRANT_RETENTION_MS` ago.
     */
    async refreshDue(): Promise<RefreshResult> {
        const result: RefreshResult = { renewed: [], failed: [], removed: [] };
        const now = Date.now();
        for (const chain of await this.repository.getAllHeld()) {
            const leaf = leafOf(chain);
            const issuedAt = Date.parse(leaf.issuedAt);
            const halfway = issuedAt + (Date.parse(leaf.expiresAt) - issuedAt) / 2;
            if (now < halfway) {
                continue;
            }
            try {
                await this.renewHeld(chain);
                result.renewed.push(leaf.id);
            } catch (error) {
                if (error instanceof RenewalRefusedError && expired(leaf, now - HELD_GRANT_RETENTION_MS)) {
                    await this.repository.deleteHeld(heldKey(chain));
                    result.removed.push(leaf.id);
                    continue;
                }
                result.failed.push({ id: leaf.id, error: error instanceof Error ? error.message : String(error) });
            }
        }
        return result;
    }

    /**
     * True when `authorization` lets its signer make exactly this call: the chain is rooted at
     * this node, unrevoked, addressed to the signer and covers the call, and the nonce is new.
     */
    async verifyInvocation(authorization: unknown, target: InvocationTarget): Promise<boolean> {
        if (!isAuthorization(authorization) || !isFreshExpiry(authorization.expiresAt, MAX_AUTHORIZATION_LIFETIME_MS + CLOCK_SKEW_TOLERANCE_MS)) {
            return false;
        }
        const chain = verifyChain(authorization.grants, this.config.publicKey);
        if (!chain.ok || chain.leaf.audience !== authorization.publicKey) {
            return false;
        }
        const hash = invocationHash(target.resourcePath, target.resourceName, target.functionName, target.parameters);
        const payload = invocationAuthorizationPayload({ invocationHash: hash, publicKey: authorization.publicKey, nonce: authorization.nonce, expiresAt: authorization.expiresAt, grantsHash: grantsHash(authorization.grants) });
        if (!safeVerifyData(payload, authorization.publicKey, authorization.signature)) {
            return false;
        }
        if (!chain.leaf.capabilities.some(capability => capabilityMatches(capability, target.resourcePath, target.resourceName, target.functionName, target.parameters))) {
            return false;
        }
        if (await this.repository.anyRevoked(authorization.grants.map(grant => grant.id))) {
            return false;
        }
        // Every audience in the chain, so blocking a delegator also cuts off what it handed on.
        if (await this.repository.anyBlocked(authorization.grants.map(grant => grant.audience))) {
            return false;
        }
        return this.claimNonce(authorization.publicKey, authorization.nonce, Date.parse(authorization.expiresAt));
    }

    /**
     * Nonces are kept in the node's database, so they survive a restart. Replicas of a node that
     * don't share a database don't see each other's nonces.
     */
    private async claimNonce(publicKey: string, nonce: string, expiresAt: number): Promise<boolean> {
        const now = Date.now();
        if (now - this.lastNonceSweep >= NONCE_SWEEP_INTERVAL_MS) {
            this.lastNonceSweep = now;
            await this.repository.deleteExpiredNonces(now);
        }
        return this.repository.claimNonce(`${publicKey}:${nonce}`, expiresAt);
    }

    private async findHeld(heldGrant: string | HeldGrantKey): Promise<Grant[]> {
        if (typeof heldGrant !== 'string') {
            const chain = await this.repository.getHeld(heldGrant);
            if (!chain) {
                throw new Error(`No held grant ${heldGrant.id} from ${heldGrant.issuer}`);
            }
            return chain;
        }
        const chains = await this.repository.getHeldById(heldGrant);
        if (chains.length === 0) {
            throw new Error(`No held grant ${heldGrant}`);
        }
        if (chains.length > 1) {
            throw new Error(`Several issuers gave this node a grant with id ${heldGrant}: name the issuer too`);
        }
        return chains[0];
    }

    /** Asks the leaf grant's issuer for a fresh chain and stores it. Throws if refused or invalid. */
    private async renewHeld(chain: Grant[]): Promise<Grant[]> {
        const leaf = leafOf(chain);
        const unsigned = { grantId: leaf.id, publicKey: this.config.publicKey, nonce: crypto.randomUUID(), expiresAt: new Date(Date.now() + MAX_AUTHORIZATION_LIFETIME_MS).toISOString() };
        const request: GrantRenewalRequest = { ...unsigned, signature: signData(grantRenewalPayload(unsigned), this.config.privateKey) };

        const response = await fetch(`${leaf.issuerBaseUrl}/v1/grants/renew`, {
            method: 'POST',
            body: JSON.stringify(request),
            headers: { 'Content-Type': 'application/json' },
            signal: AbortSignal.timeout(GRANT_RENEW_TIMEOUT_MS),
        });
        if (response.status === 403) {
            throw new RenewalRefusedError(`Renewal of grant ${leaf.id} refused`);
        }
        if (!response.ok) {
            throw new Error(`Renewal of grant ${leaf.id} failed: ${response.status}`);
        }
        const { grants } = await response.json() as { grants: Grant[] };

        // The issuer may not swap in a different grant or root.
        const renewed = verifyChain(grants, chain[0].issuer);
        if (!renewed.ok || renewed.leaf.id !== leaf.id || renewed.leaf.audience !== this.config.publicKey) {
            throw new Error(`Renewal of grant ${leaf.id} returned an invalid chain`);
        }
        await this.repository.saveHeld(grants);
        return grants;
    }

    private sign(id: string, audience: string, capabilities: Capability[], lifetimeMs: number, parent: Grant | null): Grant {
        const now = Date.now();
        const expiresAt = Math.min(now + lifetimeMs, parent ? Date.parse(parent.expiresAt) : Infinity);
        return signGrant({
            id,
            issuer: this.config.publicKey,
            issuerBaseUrl: this.config.baseUrl,
            audience,
            capabilities,
            issuedAt: new Date(now).toISOString(),
            expiresAt: new Date(expiresAt).toISOString(),
            parent: parent ? grantHash(parent) : null,
        }, this.config.privateKey);
    }
}

/** Verifiers refuse a grant with no capabilities or a malformed one, so it is never signed. */
function checkCapabilities(capabilities: unknown): void {
    if (!Array.isArray(capabilities) || capabilities.length === 0 || !capabilities.every(isCapability)) {
        throw new Error('capabilities must be a nonempty list of capabilities, each with a resourcePath');
    }
}

function checkOptions(options: GrantOptions): void {
    if (!Number.isSafeInteger(options.lifetimeMs) || options.lifetimeMs <= 0 || options.lifetimeMs > MAX_GRANT_LIFETIME_MS) {
        throw new Error(`lifetimeMs must be a positive integer of at most ${MAX_GRANT_LIFETIME_MS}`);
    }
    if (options.renewableUntil !== undefined && !Number.isFinite(Date.parse(options.renewableUntil))) {
        throw new Error('renewableUntil must be a date');
    }
}

function isAuthorization(value: unknown): value is InvocationAuthorization {
    if (typeof value !== 'object' || value === null) {
        return false;
    }
    const { publicKey, grants, nonce, expiresAt, signature } = value as Record<string, unknown>;
    return typeof publicKey === 'string' && Array.isArray(grants) && typeof nonce === 'string' && typeof expiresAt === 'string' && typeof signature === 'string';
}
