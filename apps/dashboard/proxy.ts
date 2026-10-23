import { getSessionCookie } from 'better-auth/cookies';
import { type NextRequest, NextResponse } from 'next/server';

// Pages a signed-out visitor may open.
const PUBLIC_PATHS = ['/sign-in', '/sign-up', '/forgot-password', '/reset-password'];

/**
 * Sends visitors without a session cookie to sign in. This only checks that a cookie is present: the (console)
 * layout checks the session, and the operator checks it again on every call.
 */
export function proxy(request: NextRequest) {
  const { pathname, search } = request.nextUrl;
  if (PUBLIC_PATHS.includes(pathname) || getSessionCookie(request)) return NextResponse.next();
  const signIn = new URL('/sign-in', request.url);
  if (pathname !== '/') signIn.searchParams.set('redirect', `${pathname}${search}`);
  return NextResponse.redirect(signIn);
}

export const config = {
  matcher: [
    // Skip Next.js internals, the auth endpoints and static files.
    '/((?!_next|api/auth|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)',
  ],
};
