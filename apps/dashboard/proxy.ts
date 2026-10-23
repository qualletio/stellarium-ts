import { clerkMiddleware } from '@clerk/nextjs/server';

// Makes the Clerk session available to auth(). Access is checked where data is read: the (console) layout,
// /select-organization, and the operator itself, which verifies the session token on every call.
export default clerkMiddleware();

export const config = {
  matcher: [
    // Skip Next.js internals and static files, unless found in search params.
    '/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)',
    '/(api|trpc)(.*)',
  ],
};
