# Deploying the operator and the Stellarium Platform to production

This guide runs Stellarium's payment stack for real money:

- **PostgreSQL**: the operator's organizations, ledger, receipts, top-ups and payouts.
- **The operator** (`apps/operator`): holds balances, moves money for paid calls, and talks to Stripe.
- **The dashboard** (`apps/dashboard`): the console at platform.stellarium.sh.
- **Stripe**, in live mode: card top-ups through Checkout, and payouts through Connect Express (US only).
- **Clerk**, a production instance: dashboard sign-in, organizations and roles.

Do the whole procedure with Stripe in test mode and a Clerk development instance first. The README's [Running Locally](../README.md#running-locally) guide walks through that end to end.

## 1. Secrets

| Secret | Used by | Notes |
| --- | --- | --- |
| `STRIPE_SECRET_KEY` (`sk_live_...`) | Operator | Moves real money. Use a restricted key if you prefer, with write access to Checkout Sessions, Customers, Customer Portal sessions, Accounts, Account Links, Login Links and Transfers. |
| `STRIPE_WEBHOOK_SECRET`, `STRIPE_CONNECT_WEBHOOK_SECRET` | Operator | The signing secrets of the two webhook endpoints in step 6. They are different in production. |
| `CLERK_SECRET_KEY` | Operator and dashboard | The production instance's secret key. |
| `CLERK_JWT_KEY` | Operator | The production instance's JWT public key (PEM). Lets the operator verify session tokens without a network call. |
| `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` | Dashboard | Public, but specific to the production instance. |
| `DATABASE_URL` | Operator | Contains the database password. |

Keep them in your platform's secrets manager, not in files.

**Build images from a clean checkout.** The root `Dockerfile` copies the whole repository, so any `apps/*/.env` file on the build machine ends up inside the image. Local development relies on that. In production, build in CI or from a fresh clone, and pass configuration as environment variables at runtime.

## 2. Stripe

In the [Stripe dashboard](https://dashboard.stripe.com), in live mode:

1. Finish activating the account, with business details and the bank account the platform's balance pays out to.
2. Under **Settings → Connect**, set up a platform or marketplace for **Express** accounts in the **United States**. Fill in the platform profile and branding, which Express onboarding shows to providers.
3. Under **Settings → Billing → Customer portal**, configure and activate the portal. The dashboard's **Manage in Stripe** button opens it.
4. Under **Settings → Payment methods**, choose what Checkout offers for top-ups. Cards credit the balance as soon as they're paid. Delayed methods such as ACH credit it when the payment clears, through `checkout.session.async_payment_succeeded`.
5. Under **Developers → API keys**, create the secret key (or restricted key) for the operator.

The webhook endpoints need the operator's public URL, so they come in step 6.

**Platform balance and payouts.** Transfers to providers are paid from the platform's *available* Stripe balance. Card payments become available a few days after capture (Stripe shows your account's schedule). The operator's default 7-day hold on earnings covers that. If you shorten the hold, a transfer can fail for insufficient funds; the operator returns its amount to the provider's earnings and retries in a later week.

## 3. Clerk

In the [Clerk dashboard](https://dashboard.clerk.com):

1. Create a production instance for the application, on the domain `platform.stellarium.sh`. Add the DNS records Clerk lists and wait for them to verify.
2. Turn on **Organizations**. Balances, nodes and payouts belong to organizations. Clerk's `org:admin` role can buy credits, manage nodes and set up payouts; `org:member` can view.
3. Configure the sign-in methods you want (email, Google, GitHub and so on). Social providers need their own production OAuth credentials.
4. On the **API keys** page, copy the publishable key, the secret key and the JWT public key.

## 4. Database

Use a managed PostgreSQL 16 (RDS, Neon, Supabase and so on) with a dedicated user and **backups turned on**. The ledger is the record of every organization's money, so treat it like financial data: point-in-time recovery, restricted access, and no manual edits. The operator applies the migrations in `apps/operator/drizzle/` itself at startup.

## 5. The operator

Build the image from the repository root:

```sh
docker build --target operator -t stellarium-operator .
```

Configure it with environment variables:

| Variable | Value |
| --- | --- |
| `DATABASE_URL` | Managed PostgreSQL URL (add `?sslmode=require` if your provider needs it). |
| `STRIPE_SECRET_KEY` | From step 2. |
| `STRIPE_WEBHOOK_SECRET`, `STRIPE_CONNECT_WEBHOOK_SECRET` | From step 6. The operator refuses to start with a Stripe key but without these. |
| `CLERK_SECRET_KEY`, `CLERK_JWT_KEY` | From step 3. |
| `DASHBOARD_URL` | `https://platform.stellarium.sh`. The only CORS origin and the only accepted session-token `azp`. Stripe sends users back to pages under it. |
| `PLATFORM_FEE_BPS` | Optional. The platform's share of each captured payment, in basis points. Defaults to 2000 (20%). |
| `MIN_TOP_UP_CENTS`, `MAX_TOP_UP_CENTS` | Optional. Default 1000 ($10) and 100000 ($1,000). |
| `PAYOUT_HOLD_DAYS`, `PAYOUT_INTERVAL_DAYS`, `PAYOUT_MIN_MICRO_USD` | Optional. Default 7, 7 and 10000000 ($10). Never use the test-mode overrides from the local guide. |
| `RATE_LIMIT_MAX`, `RATE_LIMIT_TIME_WINDOW` | Optional. Per-IP limit on every route but the webhooks. Default 100 per minute. |

Leave `SEED_DEV` unset. The seed creates development organizations with free credit, and the image's entrypoint runs it only when `SEED_DEV=1`.

```sh
docker run -d --name operator --restart unless-stopped -p 127.0.0.1:3001:3001 \
  --env-file /secure/operator.env stellarium-operator
```

The operator serves plain HTTP on port 3001. Put it behind a TLS reverse proxy (Caddy, nginx, or a cloud load balancer), on its own host name, for example `operator.stellarium.sh`. Run one instance: its maintenance loop (releasing expired holds, retrying and running payouts) runs in every process.

**Rate limiting behind a proxy.** `apps/operator/src/server.ts` creates Fastify without `trustProxy`, so behind a proxy every request appears to come from the proxy, and the per-IP limit becomes a global one. Enable `trustProxy` or raise `RATE_LIMIT_MAX` before going live.

Nodes that host paid functions use `OPERATOR_URL=https://<operator host>/v1`.

## 6. Stripe webhooks

With the operator reachable over HTTPS, add two endpoints under **Developers → Webhooks** in live mode:

| Endpoint | Listens to | Events |
| --- | --- | --- |
| `https://<operator host>/v1/stripe/webhook` | Events on your account | `checkout.session.completed`, `checkout.session.async_payment_succeeded`, `charge.refunded`, `charge.dispute.created`, `charge.dispute.closed`, `transfer.reversed` |
| `https://<operator host>/v1/stripe/connect-webhook` | Events on connected accounts | `account.updated` |

Copy each endpoint's signing secret into `STRIPE_WEBHOOK_SECRET` and `STRIPE_CONNECT_WEBHOOK_SECRET`, and restart the operator. Each endpoint verifies with its own secret, so they can't be swapped. The operator handles each event at most once, so Stripe's retries are safe.

## 7. The dashboard

Deploy `apps/dashboard` as a Next.js app on the domain `platform.stellarium.sh`, for example on Vercel with the project's root directory set to `apps/dashboard`, or with `pnpm --filter dashboard build && pnpm --filter dashboard start` behind your proxy. Set:

| Variable | Value |
| --- | --- |
| `OPERATOR_URL` | `https://<operator host>/v1`. Read on the server only. |
| `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY`, `CLERK_SECRET_KEY` | From step 3. |
| `NEXT_PUBLIC_CLERK_SIGN_IN_URL`, `NEXT_PUBLIC_CLERK_SIGN_UP_URL` | `/sign-in` and `/sign-up`. |

`NEXT_PUBLIC_*` values are compiled into the client bundle, so set them before building.

## 8. Smoke test

Use small amounts and a real card.

1. Liveness: `curl https://<operator host>/v1/` returns `{"hello":"world"}`.
2. Sign up at https://platform.stellarium.sh and create two organizations, a caller and a provider.
3. **Credits** (caller): buy $10. The balance updates within seconds, and the payment appears in Stripe. If it doesn't, check the platform webhook endpoint's deliveries in Stripe.
4. **Payouts** (provider): set up payouts with real details. The status shows **Ready** when `account.updated` arrives on the Connect endpoint.
5. **Nodes**: create an enrollment token in each organization and start a node with it (`ENROLLMENT_TOKEN`, `OPERATOR_URL`).
6. Make a paid call from the caller's node. The caller's **Usage** page shows the charge, and the provider's earnings grow by 80% of it.
7. Refund the test top-up in Stripe if you like. The caller's balance drops by the refunded amount.

The first payout goes out once the provider's earnings, after the 7-day hold, reach $10.

## 9. Ongoing operations

- **Alert on these operator log lines:**
  - `Maintenance failed`: releasing expired holds or running payouts threw. It retries on the next pass, so alert on repeats.
  - `Payout has been pending too long to retry safely`: a transfer may or may not exist in Stripe. Check Stripe for a transfer with the payout's `payoutId` metadata before doing anything.
- **Disputes:** respond in Stripe. An open dispute takes the disputed amount off the organization's balance, and a won dispute returns it. The platform absorbs lost disputes.
- **Back up the database,** and test restoring it.
- **Rotate keys** in Stripe and Clerk, then update the operator's and dashboard's environment and restart them. Rotating a webhook endpoint's secret needs the matching operator variable updated at the same time.
