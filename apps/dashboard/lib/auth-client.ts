import { organizationClient } from 'better-auth/client/plugins';
import { createAuthClient } from 'better-auth/react';

/** Better Auth in the browser. It calls this origin's /api/auth, which forwards to the operator. */
export const authClient = createAuthClient({ plugins: [organizationClient()] });

/** Better Auth's error for a failed call, or a generic one. */
export const errorMessage = (error: { message?: string } | null | undefined) => error?.message || 'Something went wrong. Try again.';
