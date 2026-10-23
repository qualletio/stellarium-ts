import { hashData, signData } from "../crypto/utils.js";

/** The scheme of the `Authorization` header on node requests to the operator. */
export const OPERATOR_AUTH_SCHEME = 'Stellarium';

/**
 * The object a node signs to authenticate one operator request. `path` is the URL path without the
 * query string, and `bodyHash` is `hashData` of the parsed JSON body (`{}` when there is none).
 * Key order is part of the signed bytes. The operator rebuilds this in apps/operator/src/auth/nodeAuth.ts.
 */
export function operatorRequestPayload(method: string, path: string, body: unknown, timestamp: string) {
    return { method: method.toUpperCase(), path, bodyHash: hashData(body ?? {}), timestamp };
}

/**
 * `Authorization` header value for a request to `url`: the scheme, then base64url JSON of
 * `{ publicKey, timestamp, signature }`. The operator accepts timestamps within a few minutes of its clock.
 */
export function operatorAuthorization(method: string, url: string, body: unknown, publicKey: string, privateKey: string): string {
    const timestamp = new Date().toISOString();
    const signature = signData(operatorRequestPayload(method, new URL(url).pathname, body, timestamp), privateKey);
    const credentials = Buffer.from(JSON.stringify({ publicKey, timestamp, signature })).toString('base64url');
    return `${OPERATOR_AUTH_SCHEME} ${credentials}`;
}
