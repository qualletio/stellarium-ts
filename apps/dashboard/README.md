# Stellarium Platform dashboard

The console at platform.stellarium.sh. Organization members see their prepaid balance, usage and payouts. Admins buy credits, enroll nodes and set up payouts. It is a Next.js App Router app with CSS Modules (no Tailwind) and Clerk for sign-in, organizations and roles. Its look follows stellarium.sh.

## Running locally

1. Start the operator with `CLERK_SECRET_KEY` (and `CLERK_JWT_KEY`) from the same Clerk instance and `DASHBOARD_URL=http://localhost:3010`. Top-ups and payouts also need its Stripe keys. See `apps/operator/README.md`.
2. Copy `.env.example` to `.env.local` and fill in the Clerk keys.
3. `pnpm --filter dashboard dev`, then open http://localhost:3010. (Port 3010, so it can run beside the registry, which uses 3000.)

In Clerk, enable Organizations. Clerk's `org:admin` role can buy credits, open the billing portal, set up payouts and manage nodes. `org:member` can view.

## How it's built

- Data is fetched in server components through `lib/api.ts` (`server-only`), which calls the operator with the user's Clerk session token. Mutations are Server Actions in `lib/actions.ts`. Actions that go to Stripe redirect to the URL the operator returns.
- `proxy.ts` (Next 16's middleware) requires a signed-in user everywhere but sign-in and sign-up. The `(console)` layout requires an active organization and sends the user to `/select-organization` otherwise.
- Theme tokens are stellarium.sh's, in `app/globals.css` under `:root[data-theme]`. The theme is set before paint by the script in `app/layout.tsx` and shares stellarium.sh's `theme` storage key. Clerk's components take the same tokens through `appearance.variables`.
- Shared building blocks (headers, sections, cards, tables, buttons, badges, fields, skeletons) are in `components/ui.module.css`. Each component has its own module beside it.
