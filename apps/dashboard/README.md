# Stellarium Platform dashboard

The console at platform.stellarium.sh. Organization members see their prepaid balance, usage and payouts. Admins buy credits, enroll nodes and set up payouts. It is a Next.js App Router app with CSS Modules (no Tailwind). Sign-in, organizations and roles are [Better Auth](https://www.better-auth.com), hosted by the operator. Its look follows stellarium.sh.

## Running locally

1. Start the operator with `BETTER_AUTH_SECRET` and `DASHBOARD_URL=http://localhost:3010` (`docker compose up` sets both). Top-ups and payouts also need its Stripe keys. See `apps/operator/README.md`.
2. Copy `.env.example` to `.env.local`.
3. `pnpm --filter dashboard dev`, then open http://localhost:3010. (Port 3010, so it can run beside the registry, which uses 3000.)

An organization's creator is its `owner`. Owners and `admin`s can buy credits, open the billing portal, set up payouts, manage and list nodes, create API clients and invite people. `member`s can view.

A listed node appears on **Explore** with its price per million script tokens. **API clients** run scripts on one node: one of the organization's own, for free, or a listed one, paid from the balance. A new client's secret is shown once, with an example that exchanges it for a run token at the operator. Set `PUBLIC_OPERATOR_URL` when the operator's public URL differs from `OPERATOR_URL`, so the example uses it. **Usage** shows billed runs beside paid calls.

**Composer** is a chat with Claude that writes RequestScript for the resources an API client's node knows. Admins run a proposed request, or deploy a proposed contract, with one click. Each message is charged to the organization's balance for the Claude tokens it used. It needs `ANTHROPIC_API_KEY` and `DASHBOARD_SERVICE_SECRET` (the operator's value), and locally `NODE_URL_REWRITES`, since compose nodes report container hostnames. See `.env.example`.

## How it's built

- Better Auth runs in the operator at `/v1/auth/*`. `app/api/auth/[...all]/route.ts` forwards the browser's `/api/auth/*` there, so its cookies are set on the dashboard's domain. Client components call it through `lib/auth-client.ts`: sign-in and sign-up, password reset, the organization switcher, accepting invitations, and managing members on the settings page. Without `RESEND_API_KEY` on the operator, emails' links are in its log.
- Data is fetched in server components through `lib/api.ts` (`server-only`), which calls the operator with the browser's session cookie. Mutations are Server Actions in `lib/actions.ts`. Actions that go to Stripe redirect to the URL the operator returns.
- `proxy.ts` (Next 16's middleware) sends visitors without a session cookie to `/sign-in`, except on the sign-in, sign-up and password pages. The `(console)` layout checks the session and requires an active organization, sending the user to `/select-organization` otherwise.
- The Composer: `app/api/composer/route.ts` holds a turn at the operator (`/v1/org/composer/turns`), runs a streaming tool loop with Claude (`lib/composer/turn.ts`), streams NDJSON events to `components/Composer.tsx`, then completes the turn with its messages and token usage. Holding and completing a turn send `DASHBOARD_SERVICE_SECRET`, so a browser can't report its own usage. Claude sees the node's `GET /v1/resources` as a catalog (`lib/composer/catalog.ts`), and its `check_script` and `propose_script` tools parse scripts with `requestscript` and check them against it (`lib/composer/check.ts`). Run and Deploy are Server Actions that get a run token for the API client from the operator (`/v1/org/clients/:id/token`) and call the node.
- Theme tokens are stellarium.sh's, in `app/globals.css` under `:root[data-theme]`. The theme is set before paint by the script in `app/layout.tsx` and shares stellarium.sh's `theme` storage key.
- Shared building blocks (headers, sections, cards, tables, buttons, badges, fields, skeletons) are in `components/ui.module.css`. Each component has its own module beside it.
