FROM node:22-trixie-slim AS base

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/*

ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable && corepack prepare pnpm@12.11.2 --activate

WORKDIR /app

FROM base AS build

RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

COPY . .
# drizzle-kit is allowed to install agent skills, and pnpm requires a skills directory.
RUN mkdir -p .cursor/skills
RUN pnpm install --frozen-lockfile
RUN pnpm --filter stellarium-ts build && pnpm --filter operator build

FROM base AS operator

COPY --from=build /app /app
WORKDIR /app/apps/operator
EXPOSE 3001
ENTRYPOINT ["sh", "/app/docker/operator-entrypoint.sh"]

FROM base AS local-resource-node

COPY --from=build /app /app
WORKDIR /app/apps/local-resource-node
ENV PORT=3002
EXPOSE 3002
ENTRYPOINT ["sh", "/app/docker/node-entrypoint.sh"]

FROM base AS local-caller-node

COPY --from=build /app /app
WORKDIR /app/apps/local-caller-node
ENV PORT=3000
EXPOSE 3000
ENTRYPOINT ["sh", "/app/docker/node-entrypoint.sh"]
