# Multi-stage build for the pnpm monorepo. The runtime runs the combined server
# (apps/server) which boots web-admin + storefront + order-bot + the in-process
# workers (outbox dispatcher + payment pollers) in one process.
#
# The apps run via tsx (no compile step), so the runtime image ships the source
# + node_modules + the generated Prisma client. The default CMD runs the combined
# server (`pnpm start`); docker-compose uses the same command.
#
# Before that command runs, docker-entrypoint.sh brings the database schema up to
# date (taking a verified snapshot first), so a deploy cannot leave new code
# running against an old schema. See docs/MIGRATIONS.md.

# ---- Stage 1: builder ----
# node:sqlite (used by scripts/migrate-sqlite-to-postgres.ts,
# scripts/reconcile-sqlite-postgres.ts, and the pre-existing
# scripts/migrate-catalog-rename.ts / scripts/backfill-catalog-slugs.ts) needs
# Node >=22.13 — it does not exist at all on Node 20. 24 is the current Active
# LTS line (see package.json's engines.node).
FROM node:24-slim AS builder

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

# Build the React SPAs (outputs: apps/web-admin/static/dashboard-app/ and
# apps/storefront/static/shop-app/). Both are gitignored, so they must be
# built here — not present in the build context.
RUN pnpm --filter @app/web-admin-client build
RUN pnpm --filter @app/storefront-client build


# ---- Stage 2: runtime ----
FROM node:24-slim AS runtime

ENV NODE_ENV=production \
    PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH

WORKDIR /app

# gosu drops privileges from root → app in the entrypoint (after it has fixed
# ownership of the bind-mounted data dir). sqlite3 is what deploy/backup/backup.sh
# uses for its WAL-safe ".backup" snapshot, which the entrypoint takes before it
# applies a schema change — without it that snapshot, and therefore the whole
# automatic schema update, refuses to run.
RUN apt-get update && apt-get install -y --no-install-recommends openssl tini gosu sqlite3 \
    && rm -rf /var/lib/apt/lists/* \
    && corepack enable && corepack prepare pnpm@9.15.9 --activate \
    && groupadd -r app && useradd -r -g app -m -d /home/app app

# Copy the fully-installed workspace (node_modules symlinks + generated client).
COPY --from=builder --chown=app:app /app /app

# Data dir is a mount point (SQLite DB + logs). Owned by the runtime user.
RUN mkdir -p /app/data/logs && chown -R app:app /app/data

# Copy the entrypoint explicitly and set the execute bit here — a Windows git
# checkout does not preserve the +x mode, so we cannot rely on the copied file.
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

# Same +x caveat for the backup/restore scripts, which the entrypoint calls for
# the pre-migration snapshot and an operator may run via `docker compose exec`.
RUN chmod +x /app/deploy/backup/*.sh

# NOTE: we deliberately stay root here. The entrypoint chowns the bind-mounted
# /app/data (root-owned on a fresh host clone) and then drops to `app` via gosu.

# tini reaps zombies and forwards SIGTERM so runner.stop() can shut down cleanly.
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/docker-entrypoint.sh"]
# Combined composition root (web-admin + storefront + bot + in-process workers).
CMD ["pnpm", "start"]
