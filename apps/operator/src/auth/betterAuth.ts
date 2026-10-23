import { asc, eq } from 'drizzle-orm';
import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { organization } from 'better-auth/plugins/organization';
import type { Database } from '../db/database.js';
import {
    authAccountsTable, authInvitationsTable, authMembersTable, authOrganizationsTable, authSessionsTable, authUsersTable, authVerificationsTable,
} from '../db/schema.js';
import type { Email, Mailer } from './email.js';

/** Where the dashboard reaches Better Auth: it forwards `<dashboard>/api/auth/*` to the operator's `/v1/auth/*`. */
export const AUTH_BASE_PATH = '/api/auth';

export interface AuthConfig {
    /** Signs session cookies. At least 32 characters. */
    secret: string;
    /** The dashboard's origin. Links in emails and OAuth callbacks point at it, and only it may call the auth routes. */
    dashboardUrl: string;
    mailer: Mailer;
    github?: { clientId: string, clientSecret: string };
    /** Per-client limits on sign-in, sign-up and the other auth routes. Default true; tests turn it off. */
    rateLimit?: boolean;
}

/**
 * Better Auth, for the dashboard: email and password sign-in (and GitHub when configured), and organizations
 * with `owner`, `admin` and `member` roles. Its tables are in the operator's schema.
 */
export function createAuth(db: Database, config: AuthConfig) {
    // Not awaited, so how long sending takes doesn't reveal whether an account exists.
    const send = (email: Email) => void config.mailer.send(email);
    return betterAuth({
        secret: config.secret,
        baseURL: config.dashboardUrl,
        basePath: AUTH_BASE_PATH,
        trustedOrigins: [config.dashboardUrl],
        // Better Auth relaxes both outside production (by NODE_ENV), which the operator doesn't set.
        advanced: { disableOriginCheck: false },
        rateLimit: { enabled: config.rateLimit ?? true },
        database: drizzleAdapter(db, {
            provider: 'pg',
            schema: {
                user: authUsersTable, session: authSessionsTable, account: authAccountsTable, verification: authVerificationsTable,
                organization: authOrganizationsTable, member: authMembersTable, invitation: authInvitationsTable,
            },
        }),
        emailAndPassword: {
            enabled: true,
            requireEmailVerification: true,
            sendResetPassword: async ({ user, url }) => send({
                to: user.email,
                subject: 'Reset your Stellarium password',
                text: `Reset your password: ${url}\n\nIf you didn't ask to, ignore this email.`,
            }),
        },
        emailVerification: {
            sendOnSignUp: true,
            sendOnSignIn: true,
            autoSignInAfterVerification: true,
            sendVerificationEmail: async ({ user, url }) => send({
                to: user.email,
                subject: 'Verify your email for Stellarium',
                text: `Verify your email address: ${url}`,
            }),
        },
        socialProviders: config.github ? { github: config.github } : undefined,
        databaseHooks: {
            session: {
                create: {
                    // A new sign-in opens the user's first organization, rather than asking them to pick one.
                    before: async (session) => {
                        const [membership] = await db.select({ organizationId: authMembersTable.organizationId }).from(authMembersTable)
                            .where(eq(authMembersTable.userId, session.userId)).orderBy(asc(authMembersTable.createdAt)).limit(1);
                        return { data: { ...session, activeOrganizationId: membership?.organizationId ?? null } };
                    },
                },
            },
        },
        plugins: [
            organization({
                // Balances, nodes and payouts belong to the organization.
                disableOrganizationDeletion: true,
                requireEmailVerificationOnInvitation: true,
                sendInvitationEmail: async ({ id, email, organization, inviter }) => send({
                    to: email,
                    subject: `Join ${organization.name} on Stellarium`,
                    text: `${inviter.user.name} invited you to ${organization.name} on Stellarium: ${config.dashboardUrl}/accept-invitation/${id}`,
                }),
            }),
        ],
    });
}

export type Auth = ReturnType<typeof createAuth>;
