import { createClerkClient, verifyToken } from '@clerk/backend';
import type { FastifyRequest } from 'fastify';
import { OperationError } from '../errors.js';
import type { Organization } from '../ledger.js';
import type { OrganizationService } from '../organizations.js';

/** Who a dashboard request is from: a Clerk user, acting in their active Clerk organization. */
export interface DashboardSession {
    userId: string;
    clerkOrgId?: string;
    /** The user's role in that organization. */
    role?: string;
}

/** Verifies dashboard session tokens, so tests can supply a fake. */
export interface DashboardAuthenticator {
    verify(token: string): Promise<DashboardSession>;
    organizationName(clerkOrgId: string): Promise<string>;
}

declare module 'fastify' {
    interface FastifyRequest {
        /** The organization a dashboard request acts on. Set by `authenticateDashboard`. */
        organization?: Organization;
        dashboardSession?: DashboardSession;
    }
}

function claim(payload: Record<string, unknown>, ...path: string[]): string | undefined {
    let value: unknown = payload;
    for (const key of path) value = (value as Record<string, unknown> | undefined)?.[key];
    return typeof value === 'string' ? value : undefined;
}

/** Clerk's backend SDK. Verifies networklessly when `jwtKey` is given. */
export class ClerkAuthenticator implements DashboardAuthenticator {
    private readonly client;

    constructor(private readonly options: { secretKey: string, jwtKey?: string, authorizedParties: string[] }) {
        this.client = createClerkClient({ secretKey: options.secretKey });
    }

    async verify(token: string): Promise<DashboardSession> {
        let payload: Record<string, unknown>;
        try {
            payload = await verifyToken(token, this.options) as unknown as Record<string, unknown>;
        } catch {
            throw new OperationError(401, 'Invalid session token');
        }
        // Session tokens v2 nest the active organization under `o`; v1 has flat `org_*` claims.
        const role = claim(payload, 'o', 'rol') ?? claim(payload, 'org_role');
        return {
            userId: claim(payload, 'sub')!,
            clerkOrgId: claim(payload, 'o', 'id') ?? claim(payload, 'org_id'),
            role: role?.replace(/^org:/, ''),
        };
    }

    async organizationName(clerkOrgId: string): Promise<string> {
        return (await this.client.organizations.getOrganization({ organizationId: clerkOrgId })).name;
    }
}

/**
 * A preHandler factory: verifies the `Authorization: Bearer <Clerk session token>` header and loads
 * the operator organization for the session's active Clerk organization, creating it the first time.
 */
export function authenticateDashboard(authenticator: DashboardAuthenticator, organizations: OrganizationService) {
    return async (request: FastifyRequest): Promise<void> => {
        const [scheme, token] = (request.headers.authorization ?? '').split(' ');
        if (scheme !== 'Bearer' || !token) {
            throw new OperationError(401, 'Missing session token');
        }
        const session = await authenticator.verify(token);
        if (!session.clerkOrgId) {
            throw new OperationError(403, 'Select an organization first');
        }
        request.dashboardSession = session;
        request.organization = await organizations.forClerkOrganization(session.clerkOrgId, () => authenticator.organizationName(session.clerkOrgId!));
    };
}

/** A preHandler: only organization admins may move money or manage nodes. */
export async function requireAdmin(request: FastifyRequest): Promise<void> {
    if (request.dashboardSession?.role !== 'admin') {
        throw new OperationError(403, 'Only organization admins can do this');
    }
}
