# Stellarium Platform dashboard

The console at platform.stellarium.sh. Organization members see their prepaid balance, usage and payouts. Admins buy credits, enroll nodes and set up payouts. It is a Next.js App Router app with CSS Modules (no Tailwind). Sign-in, organizations and roles are [Better Auth](https://www.better-auth.com), hosted by the operator. Its look follows stellarium.sh.

## Running locally

1. Start the operator with `BETTER_AUTH_SECRET` and `DASHBOARD_URL=http://localhost:3010` (`docker compose up` sets both). Top-ups and payouts also need its Stripe keys. See `apps/operator/README.md`.
2. Copy `.env.example` to `.env.local`.
3. `pnpm --filter dashboard dev`, then open http://localhost:3010. (Port 3010, so it can run beside the registry, which uses 3000.)

An organization's creator is its `owner`. Owners and `admin`s can buy credits, open the billing portal, set up payouts, manage and list nodes, create API clients and invite people. `member`s can view.

A listed node appears on **Explore** with its price per million script tokens. **API clients** run scripts on one node: one of the organization's own, for free, or a listed one, paid from the balance. A new client's secret is shown once, with an example that exchanges it for a run token at the operator. Set `PUBLIC_OPERATOR_URL` when the operator's public URL differs from `OPERATOR_URL`, so the example uses it. **Usage** shows billed runs beside paid calls.

## How it's built

- Better Auth runs in the operator at `/v1/auth/*`. `app/api/auth/[...all]/route.ts` forwards the browser's `/api/auth/*` there, so its cookies are set on the dashboard's domain. Client components call it through `lib/auth-client.ts`: sign-in and sign-up, password reset, the organization switcher, accepting invitations, and managing members on the settings page. Without `RESEND_API_KEY` on the operator, emails' links are in its log.
- Data is fetched in server components through `lib/api.ts` (`server-only`), which calls the operator with the browser's session cookie. Mutations are Server Actions in `lib/actions.ts`. Actions that go to Stripe redirect to the URL the operator returns.
- `proxy.ts` (Next 16's middleware) sends visitors without a session cookie to `/sign-in`, except on the sign-in, sign-up and password pages. The `(console)` layout checks the session and requires an active organization, sending the user to `/select-organization` otherwise.
- Theme tokens are stellarium.sh's, in `app/globals.css` under `:root[data-theme]`. The theme is set before paint by the script in `app/layout.tsx` and shares stellarium.sh's `theme` storage key.
- Shared building blocks (headers, sections, cards, tables, buttons, badges, fields, skeletons) are in `components/ui.module.css`. Each component has its own module beside it.
