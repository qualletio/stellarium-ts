import { createHash, createPrivateKey, createPublicKey, type KeyObject } from "node:crypto";
import { exportJWK, jwtVerify, SignJWT } from "jose";
import { OperationError } from "../errors.js";

/** The `iss` of every run token. Copied as RUN_TOKEN_ISSUER in stellarium-ts's client/runTokens.ts. */
export const RUN_TOKEN_ISSUER = 'stellarium';

export const RUN_TOKEN_LIFETIME_SECONDS = 60 * 15;

/** What a run token says: which client runs, on which node, paid by which organization. */
export interface RunTokenClaims {
    clientId: string;
    organizationId: string;
    nodePublicKey: string;
}

/**
 * Signs and verifies run tokens: EdDSA JWTs an API client presents to a node's `POST /v1/run`. The audience
 * is the node's public key, so a node can't replay a caller's token at another node. Nodes verify them
 * against `jwks()`, served at `/v1/.well-known/jwks.json`.
 */
export class RunTokenSigner {
    private readonly privateKey: KeyObject;
    private readonly publicKey: KeyObject;
    readonly kid: string;

    /** `privateKey` is an Ed25519 PKCS#8 DER key, base64url, like a node's signing key. */
    constructor(privateKey: string) {
        this.privateKey = createPrivateKey({ key: Buffer.from(privateKey, 'base64url'), format: 'der', type: 'pkcs8' });
        if (this.privateKey.asymmetricKeyType !== 'ed25519') {
            throw new Error('The run token signing key must be an Ed25519 key');
        }
        this.publicKey = createPublicKey(this.privateKey);
        this.kid = createHash('sha256').update(this.publicKey.export({ format: 'der', type: 'spki' })).digest('base64url').slice(0, 16);
    }

    async sign(claims: RunTokenClaims): Promise<{ token: string, expiresIn: number }> {
        const token = await new SignJWT({ org: claims.organizationId })
            .setProtectedHeader({ alg: 'EdDSA', kid: this.kid })
            .setIssuer(RUN_TOKEN_ISSUER)
            .setSubject(claims.clientId)
            .setAudience(claims.nodePublicKey)
            .setIssuedAt()
            .setExpirationTime(`${RUN_TOKEN_LIFETIME_SECONDS}s`)
            .setJti(crypto.randomUUID())
            .sign(this.privateKey);
        return { token, expiresIn: RUN_TOKEN_LIFETIME_SECONDS };
    }

    /** Throws 401 unless the token is one of this signer's, unexpired and addressed to `nodePublicKey`. */
    async verify(token: string, nodePublicKey: string): Promise<RunTokenClaims> {
        try {
            const { payload } = await jwtVerify(token, this.publicKey, { issuer: RUN_TOKEN_ISSUER, audience: nodePublicKey, algorithms: ['EdDSA'] });
            if (typeof payload.sub !== 'string' || typeof payload.org !== 'string') {
                throw new Error('Run token is missing its client or organization');
            }
            return { clientId: payload.sub, organizationId: payload.org, nodePublicKey };
        } catch {
            throw new OperationError(401, 'Invalid run token');
        }
    }

    async jwks(): Promise<{ keys: object[] }> {
        return { keys: [{ ...await exportJWK(this.publicKey), kid: this.kid, alg: 'EdDSA', use: 'sig' }] };
    }
}
