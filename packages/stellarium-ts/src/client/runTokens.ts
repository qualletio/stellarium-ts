import { createRemoteJWKSet, type JWTPayload, type JWTVerifyGetKey, jwtVerify } from "jose";

/** The `iss` of every run token. Copied from RUN_TOKEN_ISSUER in apps/operator/src/runs/tokens.ts. */
export const RUN_TOKEN_ISSUER = 'stellarium';

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
}
