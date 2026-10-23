import { generateKeyPairSync, sign } from 'node:crypto';
import { describe, expect, test } from 'vitest';
import { OperationError } from '../errors.js';
import { ClerkAuthenticator } from './clerk.js';

const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwtKey = publicKey.export({ type: 'spki', format: 'pem' }).toString();
const DASHBOARD = 'https://platform.test';

/** An RS256 session token, as Clerk issues them. */
function sessionToken(claims: Record<string, unknown>, key = privateKey): string {
    const now = Math.floor(Date.now() / 1000);
    const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url');
    const unsigned = `${encode({ alg: 'RS256', typ: 'JWT', kid: 'ins_test' })}.${encode({ sub: 'user_1', azp: DASHBOARD, iat: now, nbf: now - 5, exp: now + 60, ...claims })}`;
    return `${unsigned}.${sign('RSA-SHA256', Buffer.from(unsigned), key).toString('base64url')}`;
}

describe('ClerkAuthenticator', () => {
    const authenticator = new ClerkAuthenticator({ secretKey: 'sk_test_unused', jwtKey, authorizedParties: [DASHBOARD] });

    test('reads the active organization from v2 session tokens', async () => {
        const session = await authenticator.verify(sessionToken({ v: 2, o: { id: 'org_clerk', rol: 'admin', slg: 'acme' } }));

        expect(session).toEqual({ userId: 'user_1', clerkOrgId: 'org_clerk', role: 'admin' });
    });

    test('reads the active organization from v1 session tokens', async () => {
        const session = await authenticator.verify(sessionToken({ org_id: 'org_clerk', org_role: 'org:member', org_slug: 'acme' }));

        expect(session).toEqual({ userId: 'user_1', clerkOrgId: 'org_clerk', role: 'member' });
    });

    test('has no organization for a session without an active one', async () => {
        expect(await authenticator.verify(sessionToken({}))).toEqual({ userId: 'user_1', clerkOrgId: undefined, role: undefined });
    });

    test.each([
        ['signed by another key', () => sessionToken({}, generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey)],
        ['for another site', () => sessionToken({ azp: 'https://evil.test' })],
        ['expired', () => sessionToken({ exp: Math.floor(Date.now() / 1000) - 120 })],
        ['malformed', () => 'not-a-token'],
    ])('refuses a token %s with 401', async (_, token) => {
        await expect(authenticator.verify(token())).rejects.toSatisfy((error: OperationError) => error.statusCode === 401);
    });
});
