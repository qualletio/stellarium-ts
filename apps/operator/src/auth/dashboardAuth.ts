import { and, eq } from 'drizzle-orm';
import type { FastifyRequest } from 'fastify';
import type { Database } from '../db/database.js';
import { authMembersTable, authOrganizationsTable } from '../db/schema.js';
import { OperationError } from '../errors.js';
import type { Organization } from '../ledger.js';
import type { OrganizationService } from '../organizations.js';
import type { Auth } from './betterAuth.js';

/** Who a dashboard request is from: a signed-in user, acting in their active organization. */
export interface DashboardSession {
    userId: string;
    /** Set only while the user is a member of it. */
    activeOrganization?: {
        id: string;
        name: string;
        /** The user's role in it: `owner`, `admin` or `member`. Better Auth separates several with commas. */
        role: string;
    };
}

/** Reads the session from a dashboard request's headers, so tests can supply a fake. */
export interface DashboardAuthenticator {
    /** Undefined when the request has no valid session. */
    verify(headers: Headers): Promise<DashboardSession | undefined>;
}

declare module 'fastify' {
    interface FastifyRequest {
        /** The organization a dashboard request acts on. Set by `authenticateDashboard`. */
        organization?: Organization;
        dashboardSession?: DashboardSession;
    }
}

/** Better Auth sessions, from the session cookie the dashboard forwards. */
export class BetterAuthAuthenticator implements DashboardAuthenticator {
    constructor(private readonly auth: Auth, private readonly db: Database) {}

    async verify(headers: Headers): Promise<DashboardSession | undefined> {
        const result = await this.auth.api.getSession({ headers });
        if (!result) return undefined;
        const { user, session } = result;
        if (!session.activeOrganizationId) return { userId: user.id };
        // The user may have left or been removed since choosing it.
        const [membership] = await this.db.select({ id: authOrganizationsTable.id, name: authOrganizationsTable.name, role: authMembersTable.role })
            .from(authMembersTable)
            .innerJoin(authOrganizationsTable, eq(authOrganizationsTable.id, authMembersTable.organizationId))
            .where(and(eq(authMembersTable.organizationId, session.activeOrganizationId), eq(authMembersTable.userId, user.id)))
            .limit(1);
        return { userId: user.id, activeOrganization: membership };
    }
}

/** A Fastify request's headers, as Better Auth reads them. */
export function requestHeaders(request: FastifyRequest): Headers {
    const headers = new Headers();
    for (const [name, value] of Object.entries(request.headers)) {
        for (const item of Array.isArray(value) ? value : [value]) {
            if (item !== undefined) headers.append(name, item);
        }
    }
    return headers;
}

/**
 * A preHandler factory: checks the session cookie and loads the operator organization for the session's
 * active organization, creating it the first time.
 */
export function authenticateDashboard(authenticator: DashboardAuthenticator, organizations: OrganizationService) {
    return async (request: FastifyRequest): Promise<void> => {
        const session = await authenticator.verify(requestHeaders(request));
        if (!session) {
            throw new OperationError(401, 'Not signed in');
        }
        const active = session.activeOrganization;
        if (!active) {
            throw new OperationError(403, 'Select an organization first');
        }
        request.dashboardSession = session;
        request.organization = await organizations.forAuthOrganization(active.id, active.name);
    };
}

/** Owners and admins move money and manage nodes. */
export function isAdmin(role: string | undefined): boolean {
    return (role ?? '').split(',').some((name) => name.trim() === 'owner' || name.trim() === 'admin');
}

/** A preHandler: only organization owners and admins may move money or manage nodes. */
export async function requireAdmin(request: FastifyRequest): Promise<void> {
    if (!isAdmin(request.dashboardSession?.activeOrganization?.role)) {
        throw new OperationError(403, 'Only organization admins can do this');
    }
}
