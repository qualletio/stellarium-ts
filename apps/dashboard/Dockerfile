# The dashboard's production image. Build it from the repository root, which holds the lockfile:
#   docker build -f apps/dashboard/Dockerfile .
# Railway uses it through RAILWAY_DOCKERFILE_PATH=apps/dashboard/Dockerfile. OPERATOR_URL and GITHUB_SIGN_IN are read at
# runtime, so the image doesn't depend on them.
FROM node:22-trixie-slim AS base

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/*

ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
ENV NEXT_TELEMETRY_DISABLED=1
RUN corepack enable && corepack prepare pnpm@12.11.2 --activate

WORKDIR /app

FROM base AS build

COPY . .
# drizzle-kit is allowed to install agent skills, and pnpm requires a skills directory.
RUN mkdir -p .cursor/skills
# The dashboard doesn't depend on other workspace packages, so it needs neither their dependencies nor a native toolchain.
RUN pnpm install --frozen-lockfile --filter dashboard
RUN pnpm --filter dashboard build

FROM base AS dashboard

ENV NODE_ENV=production
COPY --from=build /app /app
WORKDIR /app/apps/dashboard
EXPOSE 3010
# Not `pnpm start`: corepack would download pnpm again on every start.
CMD ["node_modules/.bin/next", "start", "--port", "3010"]
