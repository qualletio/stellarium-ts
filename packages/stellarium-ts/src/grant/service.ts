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
    isAuthorization,
    isCapability,
    isGrant,
    MAX_AUTHORIZATION_LIFETIME_MS,
    MAX_GRANT_CHAIN_LENGTH,
    MAX_GRANT_LIFETIME_MS,
    signGrant,
    verifyChain,
} from "./grant.js";
import type { BlockedCaller, GrantRepository, GrantKey } from "./repository.js";

export interface GrantOptions {
    /** How long each issued copy lasts. At most `MAX_GRANT_LIFETIME_MS`. */
    lifetimeMs: number;
    /** Access ends at this time: no copy expires later, and none is renewed after it. Omit to allow renewal until revoked. */
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
/** Most renewals `refreshDue` has in flight at once. */
const REFRESH_CONCURRENCY = 8;

/** Thrown by `block` for a key that isn't an Ed25519 SPKI key. */
export class InvalidPublicKeyError extends Error {
    constructor() {
        super('Invalid public key');
    }
}

/** Another node answered a grant request or renewal with a refusal, as opposed to failing to answer. */
class GrantRefusedError extends Error {}

const expired = (grant: Grant, now = Date.now()) => Date.parse(grant.expiresAt) <= now;
const leafOf = (chain: Grant[]) => chain[chain.length - 1];
const keyOf = (grant: Grant): GrantKey => ({ issuer: grant.issuer, id: grant.id });
const heldKey = (chain: Grant[]): GrantKey => keyOf(leafOf(chain));
/** The root grant's issuer, or `''` when the chain is malformed, so that `verifyChain` refuses it. */
const rootIssuer = (chain: unknown) => Array.isArray(chain) && isGrant(chain[0]) ? chain[0].issuer : '';
const isWellFormed = (chain: unknown): chain is Grant[] => Array.isArray(chain) && chain.length > 0 && chain.every(isGrant);
/** True when `renewed` holds the same grants as `chain`, position by position. Renewal keeps each grant's issuer and id. */
const sameGrants = (renewed: Grant[], chain: Grant[]) => renewed.length === chain.length && renewed.every((grant, index) => grant.issuer === chain[index].issuer && grant.id === chain[index].id);

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
        const grant = this.sign(crypto.randomUUID(), audience, capabilities, options.lifetimeMs, null, options.renewableUntil ?? null);
        await this.repository.saveIssued({ id: grant.id, audience, capabilities, parent: null, lifetimeMs: options.lifetimeMs, renewableUntil: options.renewableUntil ?? null });
        return [grant];
    }

    /**
     * Narrows a grant this node holds for another audience. The child expires no later than the
     * held grant. Name the held grant by its id, or by its issuer and id when two issuers used the same id.
     */
    async delegate(heldGrant: string | GrantKey, audience: string, capabilities: Capability[], options: GrantOptions): Promise<Grant[]> {
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

        const grant = this.sign(crypto.randomUUID(), audience, capabilities, options.lifetimeMs, parent, options.renewableUntil ?? null);
        await this.repository.saveIssued({ id: grant.id, audience, capabilities, parent: heldKey(chain), lifetimeMs: options.lifetimeMs, renewableUntil: options.renewableUntil ?? null });
        return [...chain, grant];
    }

    /**
     * Revoked grants are refused in any chain this node verifies, and are never renewed. A
     * delegator's revocation only stops renewal, since the provider never sees it, so it
     * takes effect when the current copy expires. Name a grant this node issued by its id, and
     * any other grant, such as one delegated further down a chain, by its issuer and id.
     */
    async revoke(grant: string | GrantKey): Promise<void> {
        await this.repository.revoke(typeof grant === 'string' ? { issuer: this.config.publicKey, id: grant } : grant);
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
        if (await this.repository.anyRevoked([{ issuer: this.config.publicKey, id: issued.id }, ...chain.map(keyOf)])) {
            return undefined;
        }

        const parent = chain.length > 0 ? leafOf(chain) : null;
        return [...chain, this.sign(issued.id, issued.audience, issued.capabilities, issued.lifetimeMs, parent, issued.renewableUntil)];
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
        if (!validCapabilities(capabilities)) {
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

        const grants = await this.postForGrants(`${providerBaseUrl}/v1/grants/request`, request, `Grant request to ${providerBaseUrl}`);
        const chain = verifyChain(grants, rootIssuer(grants));
        if (!chain.ok || (grants as Grant[]).length !== 1 || (grants as Grant[])[0].issuerBaseUrl !== providerBaseUrl || chain.leaf.audience !== this.config.publicKey) {
            throw new Error(`Grant request to ${providerBaseUrl} returned an invalid grant`);
        }
        await this.repository.saveHeld(grants as Grant[]);
        return grants as Grant[];
    }

    /** Stores a chain whose leaf names this node as its audience. Throws if the chain is invalid. */
    async add(chain: Grant[]): Promise<void> {
        const result = verifyChain(chain, rootIssuer(chain));
        if (!result.ok) {
            throw new Error(`Invalid grant chain: ${result.reason}`);
        }
        if (result.leaf.audience !== this.config.publicKey) {
            throw new Error('Grant chain is not addressed to this node');
        }
        await this.repository.saveHeld(chain);
    }

    /**
     * Stores a chain passed in the node's start options. A held copy of the same grant that
     * expires no earlier is a renewal of it, so it is kept. Returns false, storing nothing, for
     * an expired chain. Throws if the chain is otherwise invalid.
     */
    async seed(chain: Grant[]): Promise<boolean> {
        if (isWellFormed(chain)) {
            const held = await this.repository.getHeld(heldKey(chain));
            if (held && Date.parse(leafOf(held).expiresAt) >= Date.parse(leafOf(chain).expiresAt)) {
                return true;
            }
            // No grant in a valid chain outlives its parent, so the leaf expires first.
            if (expired(leafOf(chain))) {
                return false;
            }
        }
        await this.add(chain);
        return true;
    }

    /**
     * A held chain, rooted at the node serving `rootBaseUrl`, that covers the call. When every
     * such chain has expired, the latest-expiring one is renewed, once, before giving up, so a
     * call waits on at most one renewal. Undefined when this node holds no usable grant.
     */
    async chainFor(rootBaseUrl: string, target: InvocationTarget): Promise<Grant[] | undefined> {
        const now = Date.now();
        // The provider refuses a chain from a key it no longer uses, such as after a key rotation.
        // When this node doesn't know the provider as a peer, chains from any root key are tried.
        const rootKey = await this.repository.getPeerKey(rootBaseUrl);
        const usable = (chain: Grant[]) => (rootKey === undefined || chain[0].issuer === rootKey)
            && leafOf(chain).capabilities.some(capability => capabilityMatches(capability, target.resourcePath, target.resourceName, target.functionName, target.parameters));

        const chain = (await this.repository.getUnexpiredHeldByRoot(rootBaseUrl, now)).find(usable);
        if (chain) {
            return chain;
        }
        const latestExpired = (await this.repository.getExpiredHeldByRoot(rootBaseUrl, now)).find(usable);
        if (!latestExpired) {
            return undefined;
        }
        try {
            return await this.renewHeld(latestExpired);
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
        const now = Date.now();
        const due = (await this.repository.getAllHeld()).filter(chain => {
            const leaf = leafOf(chain);
            const issuedAt = Date.parse(leaf.issuedAt);
            return now >= issuedAt + (Date.parse(leaf.expiresAt) - issuedAt) / 2;
        });

        // Renewals run a few at a time, so one slow issuer doesn't hold up the rest.
        type Outcome = { renewed: string } | { removed: string } | { failed: { id: string, error: string } };
        const outcomes: Outcome[] = [];
        const refresh = async (chain: Grant[]): Promise<Outcome> => {
            const leaf = leafOf(chain);
            try {
                await this.renewHeld(chain);
                return { renewed: leaf.id };
            } catch (error) {
                if (error instanceof GrantRefusedError && expired(leaf, now - HELD_GRANT_RETENTION_MS)) {
                    await this.repository.deleteHeld(heldKey(chain));
                    return { removed: leaf.id };
                }
                return { failed: { id: leaf.id, error: error instanceof Error ? error.message : String(error) } };
            }
        };
        let next = 0;
        const worker = async () => {
            while (next < due.length) {
                const index = next++;
                outcomes[index] = await refresh(due[index]);
            }
        };
        await Promise.all(Array.from({ length: Math.min(REFRESH_CONCURRENCY, due.length) }, worker));

        const result: RefreshResult = { renewed: [], failed: [], removed: [] };
        for (const outcome of outcomes) {
            if ('renewed' in outcome) {
                result.renewed.push(outcome.renewed);
            } else if ('removed' in outcome) {
                result.removed.push(outcome.removed);
            } else {
                result.failed.push(outcome.failed);
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
        if (await this.repository.anyRevoked(authorization.grants.map(keyOf))) {
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

    private async findHeld(heldGrant: string | GrantKey): Promise<Grant[]> {
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

        const grants = await this.postForGrants(`${leaf.issuerBaseUrl}/v1/grants/renew`, request, `Renewal of grant ${leaf.id}`);
        // The issuer may not swap in a different grant, root or chain, so the renewal replaces the held copy.
        const renewed = verifyChain(grants, chain[0].issuer);
        if (!renewed.ok || !sameGrants(grants as Grant[], chain) || renewed.leaf.audience !== this.config.publicKey) {
            throw new Error(`Renewal of grant ${leaf.id} returned an invalid chain`);
        }
        await this.repository.saveHeld(grants as Grant[]);
        return grants as Grant[];
    }

    /**
     * POSTs a signed request to another node's grant endpoint and returns the chain it answered
     * with, unverified. Throws `GrantRefusedError` if the node refused, and an Error if it failed.
     */
    private async postForGrants(url: string, body: GrantRequest | GrantRenewalRequest, description: string): Promise<unknown> {
        const response = await fetch(url, {
            method: 'POST',
            body: JSON.stringify(body),
            headers: { 'Content-Type': 'application/json' },
            signal: AbortSignal.timeout(GRANT_RENEW_TIMEOUT_MS),
        });
        if (!response.ok) {
            const detail = await response.json().then((answer) => (answer as { error?: unknown } | null)?.error, () => undefined);
            const reason = typeof detail === 'string' ? detail : response.status;
            throw response.status === 403 ? new GrantRefusedError(`${description} refused: ${reason}`) : new Error(`${description} failed: ${reason}`);
        }
        const answer = await response.json() as { grants?: unknown } | null;
        return answer?.grants;
    }

    /** The copy expires after `lifetimeMs`, but no later than its parent or `renewableUntil`. */
    private sign(id: string, audience: string, capabilities: Capability[], lifetimeMs: number, parent: Grant | null, renewableUntil: string | null): Grant {
        const now = Date.now();
        const expiresAt = Math.min(now + lifetimeMs, parent ? Date.parse(parent.expiresAt) : Infinity, renewableUntil !== null ? Date.parse(renewableUntil) : Infinity);
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
function validCapabilities(capabilities: unknown): capabilities is Capability[] {
    return Array.isArray(capabilities) && capabilities.length > 0 && capabilities.every(isCapability);
}

function checkCapabilities(capabilities: unknown): void {
    if (!validCapabilities(capabilities)) {
        throw new Error('capabilities must be a nonempty list of capabilities, each with a resourcePath');
    }
}

function checkOptions(options: GrantOptions): void {
    if (!Number.isSafeInteger(options.lifetimeMs) || options.lifetimeMs <= 0 || options.lifetimeMs > MAX_GRANT_LIFETIME_MS) {
        throw new Error(`lifetimeMs must be a positive integer of at most ${MAX_GRANT_LIFETIME_MS}`);
    }
    // A grant expires by renewableUntil, so a past one would only sign an expired grant.
    if (options.renewableUntil !== undefined && !(Date.parse(options.renewableUntil) > Date.now())) {
        throw new Error('renewableUntil must be a future date');
    }
}
