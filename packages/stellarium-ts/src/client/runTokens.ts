import { createRemoteJWKSet, type JWTPayload, type JWTVerifyGetKey, jwtVerify } from "jose";

/** The `iss` of every run token. Copied from RUN_TOKEN_ISSUER in apps/operator/src/runs/tokens.ts. */
export const RUN_TOKEN_ISSUER = 'stellarium';

/** The `aud` of every membership token. Copied from MEMBERSHIP_TOKEN_AUDIENCE in apps/operator/src/runs/tokens.ts. */
export const MEMBERSHIP_TOKEN_AUDIENCE = 'stellarium:membership';

/** What a membership token says: the operator's statement that a node belongs to an organization. */
export interface Membership {
    /** The node's public key. */
    publicKey: string;
    organizationId: string;
}

/** Who a run token lets run scripts on this node, and which organization pays. */
export interface RunTokenClaims {
    clientId: string;
    organizationId: string;
    /** Every claim of the verified token, which scripts read as the built-in `jwt`. */
    payload: JWTPayload;
}

/** Whether `token` has the three base64url segments of a JWT, as opposed to an API key. */
export function looksLikeJwt(token: string): boolean {
    return /^[\w-]+\.[\w-]+\.[\w-]+$/.test(token);
}

/**
 * Verifies the run tokens API clients get from the operator's `POST /v1/oauth/token`, against the
 * operator's published keys. A token is only valid at the node whose public key is its audience.
 */
export class RunTokenVerifier {
    private readonly keys: JWTVerifyGetKey;

    /** `keys` replaces fetching `{operatorUrl}/.well-known/jwks.json`, in tests. */
    constructor(operatorUrl: string, private readonly nodePublicKey: string, keys?: JWTVerifyGetKey) {
        // Cached, and refetched when a token names a key it doesn't have.
        this.keys = keys ?? createRemoteJWKSet(new URL(`${operatorUrl}/.well-known/jwks.json`));
    }

    /** The token's claims, or undefined unless it is signed by the operator, unexpired and addressed to this node. */
    async verify(token: string): Promise<RunTokenClaims | undefined> {
        try {
            const { payload } = await jwtVerify(token, this.keys, { issuer: RUN_TOKEN_ISSUER, audience: this.nodePublicKey, algorithms: ['EdDSA'] });
            if (typeof payload.sub !== 'string' || typeof payload.org !== 'string') {
                return undefined;
            }
            return { clientId: payload.sub, organizationId: payload.org, payload };
        } catch {
            return undefined;
        }
    }

    /**
     * The membership a node's token states, or undefined unless the operator signed it and it was valid at
     * `at`. Events are checked at the time they were published, since a delivery may be retried after the
     * token that came with it expires.
     */
    async verifyMembership(token: string, at: Date = new Date()): Promise<Membership | undefined> {
        try {
            const { payload } = await jwtVerify(token, this.keys, { issuer: RUN_TOKEN_ISSUER, audience: MEMBERSHIP_TOKEN_AUDIENCE, algorithms: ['EdDSA'], currentDate: at });
            if (payload.use !== 'membership' || typeof payload.sub !== 'string' || typeof payload.org !== 'string') {
                return undefined;
            }
            if (payload.iat !== undefined && payload.iat * 1000 > at.getTime() + CLOCK_SKEW_MS) {
                return undefined;
            }
            return { publicKey: payload.sub, organizationId: payload.org };
        } catch {
            return undefined;
        }
    }
}

/** How far a membership token's issue time may be after the moment it is checked at. */
const CLOCK_SKEW_MS = 5 * 60 * 1000;
