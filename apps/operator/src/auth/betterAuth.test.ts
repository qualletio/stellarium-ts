import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import type { Database } from '../db/database.js';
import routes from '../routes/index.js';
import { createService, type Service } from '../service.js';
import { createTestDatabase } from '../testing.js';
import type { Email, Mailer } from './email.js';

const DASHBOARD = 'https://platform.test';

class CapturingMailer implements Mailer {
    readonly sent: Email[] = [];
    async send(email: Email) { this.sent.push(email); }

    /** The last link sent to `to`. */
    link(to: string): string {
        const email = this.sent.findLast((email) => email.to === to);
        return email!.text.match(/https:\/\/\S+/)![0];
    }
}

/** Sign-in and organizations through the real Better Auth routes, then the dashboard API with the session they set. */
describe('Better Auth', () => {
    let db: Database;
    let close: () => Promise<void>;
    let fastify: FastifyInstance;
    let service: Service;
    let mailer: CapturingMailer;

    beforeEach(async () => {
        ({ db, close } = await createTestDatabase());
        mailer = new CapturingMailer();
        service = createService(db, { platformFeeBps: 2000, auth: { secret: 'a-test-secret-that-is-at-least-32-chars', dashboardUrl: DASHBOARD, mailer, rateLimit: false } });
        fastify = Fastify();
        await fastify.register(routes, { prefix: '/v1', service });
        await fastify.ready();
    });

    afterEach(async () => {
        await fastify.close();
        await close();
    });

    /** Calls a Better Auth endpoint as the dashboard forwards it: `/api/auth/x` becomes `/v1/auth/x`. */
    async function call(method: 'GET' | 'POST', path: string, options: { body?: object, cookie?: string, origin?: string } = {}) {
        return fastify.inject({
            method,
            url: `/v1/auth${path.replace(/^.*\/api\/auth/, '')}`,
            payload: options.body,
            headers: { origin: options.origin ?? DASHBOARD, ...(options.cookie && { cookie: options.cookie }) },
        });
    }

    const cookieHeader = (response: { cookies: { name: string, value: string }[] }) =>
        response.cookies.map(({ name, value }) => `${name}=${value}`).join('; ');

    /** Signs up and verifies the email, returning the session cookie the verification link sets. */
    async function signUp(email: string): Promise<string> {
        const signedUp = await call('POST', '/sign-up/email', { body: { email, password: 'correct horse battery', name: email.split('@')[0] } });
        expect(signedUp.statusCode).toBe(200);
        // Unverified, the user gets no session.
        expect(signedUp.cookies.find((cookie) => cookie.name.includes('session_token'))).toBeUndefined();

        const verified = await call('GET', mailer.link(email));
        expect(verified.statusCode).toBe(302);
        return cookieHeader(verified);
    }

    const org = (cookie: string) => fastify.inject({ method: 'GET', url: '/v1/org', headers: { cookie } });

    test('a verified user creates an organization and becomes its owner', async () => {
        const cookie = await signUp('ada@example.com');
        expect((await org(cookie)).statusCode).toBe(403);

        const created = await call('POST', '/organization/create', { body: { name: 'Acme', slug: 'acme' }, cookie });
        expect(created.statusCode).toBe(200);

        const response = await org(cookie);
        expect(response.statusCode).toBe(200);
        expect(response.json()).toMatchObject({ id: expect.stringMatching(/^org_/), name: 'Acme', role: 'owner', admin: true, balanceMicroUsd: 0 });
    });

    test('a new sign-in opens the user\'s organization', async () => {
        const cookie = await signUp('ada@example.com');
        await call('POST', '/organization/create', { body: { name: 'Acme', slug: 'acme' }, cookie });

        const signedIn = await call('POST', '/sign-in/email', { body: { email: 'ada@example.com', password: 'correct horse battery' } });

        expect((await org(cookieHeader(signedIn))).json()).toMatchObject({ name: 'Acme', role: 'owner' });
    });

    test('an invited user joins as a member, and loses access when removed', async () => {
        const owner = await signUp('ada@example.com');
        const organizationId = (await call('POST', '/organization/create', { body: { name: 'Acme', slug: 'acme' }, cookie: owner })).json().id;
        const invited = await call('POST', '/organization/invite-member', { body: { email: 'grace@example.com', role: 'member' }, cookie: owner });
        expect(invited.statusCode).toBe(200);
        const link = mailer.link('grace@example.com');
        expect(link).toBe(`${DASHBOARD}/accept-invitation/${invited.json().id}`);

        const member = await signUp('grace@example.com');
        const accepted = await call('POST', '/organization/accept-invitation', { body: { invitationId: invited.json().id }, cookie: member });
        expect(accepted.statusCode).toBe(200);
        expect((await org(member)).json()).toMatchObject({ name: 'Acme', role: 'member', admin: false });
        expect((await fastify.inject({ method: 'POST', url: '/v1/org/enrollment-tokens', payload: {}, headers: { cookie: member } })).statusCode).toBe(403);

        const removed = await call('POST', '/organization/remove-member', { body: { memberIdOrEmail: 'grace@example.com', organizationId }, cookie: owner });
        expect(removed.statusCode).toBe(200);
        expect((await org(member)).statusCode).toBe(403);
    });

    test('renaming the organization renames the operator organization', async () => {
        const cookie = await signUp('ada@example.com');
        await call('POST', '/organization/create', { body: { name: 'Acme', slug: 'acme' }, cookie });
        const { id } = (await org(cookie)).json();

        expect((await call('POST', '/organization/update', { body: { data: { name: 'Acme Labs' } }, cookie })).statusCode).toBe(200);

        expect((await org(cookie)).json()).toMatchObject({ id, name: 'Acme Labs' });
    });

    test('refuses requests with a session from other origins', async () => {
        const cookie = await signUp('ada@example.com');

        const response = await call('POST', '/organization/create', { body: { name: 'Acme', slug: 'acme' }, cookie, origin: 'https://evil.test' });

        expect(response.statusCode).toBe(403);
    });

    test('refuses the dashboard API without a session', async () => {
        expect((await org('')).statusCode).toBe(401);
        expect((await org('better-auth.session_token=forged.value')).statusCode).toBe(401);
    });

    test('sends a password reset link that sets a new password', async () => {
        await signUp('ada@example.com');
        expect((await call('POST', '/request-password-reset', { body: { email: 'ada@example.com', redirectTo: `${DASHBOARD}/reset-password` } })).statusCode).toBe(200);

        const redirect = await call('GET', mailer.link('ada@example.com'));
        const token = new URL(redirect.headers.location as string).searchParams.get('token');
        expect((await call('POST', '/reset-password', { body: { token, newPassword: 'a new long password' } })).statusCode).toBe(200);

        const signedIn = await call('POST', '/sign-in/email', { body: { email: 'ada@example.com', password: 'a new long password' } });
        expect(signedIn.statusCode).toBe(200);
    });
});
