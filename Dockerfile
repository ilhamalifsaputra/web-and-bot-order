# Multi-stage build for the pnpm monorepo (order-bot / web-admin / notifier).
#
# The apps run via tsx (no compile step), so the runtime image ships the source
# + node_modules + the generated Prisma client. One image serves all three
# services; docker-compose selects which app to run via `command`.

# ---- Stage 1: builder ----
FROM node:20-slim AS builder

ENV PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH \
    CI=1
# Prisma reads this at `generate` time (it does NOT connect — value is a dummy).
ENV DATABASE_URL_PRISMA=file:/app/data/bot.db

WORKDIR /app

# OpenSSL is required by Prisma's query engine.
RUN apt-get update && apt-get install -y --no-install-recommends openssl \
    && rm -rf /var/lib/apt/lists/*

RUN corepack enable && corepack prepare pnpm@9.15.9 --activate

# Install dependencies against the committed lockfile, then bring in sources.
# (.dockerignore keeps the Python trees / node_modules / data out of context.)
COPY . .
RUN pnpm install --frozen-lockfile

# Generate the Prisma client into node_modules/.prisma (+ engine binaries).
RUN pnpm exec prisma generate


# ---- Stage 2: runtime ----
FROM node:20-slim AS runtime

ENV NODE_ENV=production \
    PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends openssl tini \
    && rm -rf /var/lib/apt/lists/* \
    && corepack enable && corepack prepare pnpm@9.15.9 --activate \
    && groupadd -r app && useradd -r -g app -m -d /home/app app

# Copy the fully-installed workspace (node_modules symlinks + generated client).
COPY --from=builder --chown=app:app /app /app

# Data dir is a mount point (SQLite DB + logs). Owned by the runtime user.
RUN mkdir -p /app/data/logs && chown -R app:app /app/data

USER app

# tini reaps zombies and forwards SIGTERM so runner.stop() can shut down cleanly.
ENTRYPOINT ["/usr/bin/tini", "--"]
# Default service; overridden per-service in docker-compose.yml.
CMD ["pnpm", "--filter", "@app/order-bot", "start"]
