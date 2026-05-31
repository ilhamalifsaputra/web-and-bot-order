# telegram-order-bot

A Telegram-based ordering platform with a web admin panel, built as a Node/TypeScript
pnpm monorepo. Customers browse a catalog and check out (Buy Now → confirm → pay) through a
[grammY](https://grammy.dev) bot; admins manage orders, payments, stock, wallets, and
reports from a Fastify web panel. Three services share **one** SQLite database
(WAL mode) over [Prisma](https://www.prisma.io).

> Migrated from a legacy Python (SQLAlchemy/Alembic) stack; see `RUN.md` for the
> deploy/cutover runbook.

## Architecture

```
┌─────────────┐   ┌─────────────┐   ┌─────────────┐
│  order-bot  │   │  web-admin  │   │  notifier   │
│  (grammY)   │   │  (Fastify)  │   │ (outbox →   │
│             │   │  + HTMX/    │   │  Telegram)  │
│             │   │  Nunjucks   │   │             │
└──────┬──────┘   └──────┬──────┘   └──────┬──────┘
       │                 │                 │
       └────────┬────────┴────────┬────────┘
                │   @app/db (Prisma)
                ▼
        data/bot.db  (SQLite, WAL, single-writer)
```

### Workspaces

| Path                | Package           | Role |
|---------------------|-------------------|------|
| `apps/order-bot`    | `@app/order-bot`  | Customer + admin Telegram bot (grammY, conversations, runner). Browse, Buy Now checkout, payment flows, stock allocation. |
| `apps/web-admin`    | `@app/web-admin`  | Admin web panel (Fastify + Nunjucks + HTMX). Orders, payments, reviews, wallet ledger, reports, RBAC/2FA. |
| `apps/notifier`     | `@app/notifier`   | Drains `notification_outbox` and delivers Telegram messages/broadcasts. |
| `packages/core`     | `@app/core`       | Shared config, money (Decimal), i18n (`t()` over `locales/{en,id}.json`), logging (pino). |
| `packages/db`       | `@app/db`         | Prisma client + per-domain CRUD helpers (`src/crud/*`). |

## Tech stack

- **Runtime:** Node ≥ 20, run via `tsx` (no compile step)
- **Package manager:** pnpm 9 (workspaces)
- **Bot:** grammY (`@grammyjs/conversations`, `@grammyjs/runner`), croner for jobs
- **Web:** Fastify 5, Nunjucks views, HTMX, bcryptjs auth, CSRF + cookie sessions
- **Data:** Prisma 5 over SQLite (`data/bot.db`, WAL)
- **Money:** `decimal.js` — never `float`
- **Tests:** Vitest

## Quick start (local dev)

```bash
pnpm install
pnpm prisma:generate

# create a .env at the repo root (see "Configuration" below)

# run any single service:
pnpm dev:bot        # order-bot
pnpm dev:web        # web-admin (default http://127.0.0.1:8000)
pnpm dev:notifier   # notifier
```

## Configuration

Services read environment variables via `packages/core/src/config.ts`. Put them in a
`.env` at the repo root. Common keys:

| Key                   | Used by      | Notes |
|-----------------------|--------------|-------|
| `BOT_TOKEN`           | order-bot    | Telegram bot token |
| `BOT_USERNAME`        | order-bot    | |
| `ADMIN_IDS`           | all          | Comma-separated Telegram user IDs |
| `BINANCE_PAY_ID`      | order-bot    | Payment method config |
| `DATABASE_URL_PRISMA` | all          | e.g. `file:/app/data/bot.db` (use an **absolute** path in containers) |
| `WEB_COOKIE_SECRET`   | web-admin    | ≥ 32 chars |
| `WEB_PORT`            | web-admin    | Default `8000`; binds `127.0.0.1` |
| `NOTIF_BOT_TOKEN`     | notifier     | |
| `PUBLIC_CHANNEL_ID`   | notifier     | |
| `TIMEZONE`            | all          | UTC in DB, this TZ on display |

## Common scripts

```bash
pnpm test            # full Vitest suite
pnpm typecheck       # pnpm -r typecheck + test tsconfig
pnpm build           # build all workspaces
pnpm prisma:generate # regenerate the Prisma client
pnpm prisma:pull     # introspect the DB into the schema
```

## Deploy (Docker)

The three services share one image (`bot-order-node:latest`) and one mounted SQLite DB:

```bash
docker compose build
docker compose up -d notifier      # Fase 1 — safest
docker compose up -d web-admin     # Fase 3
docker compose up -d order-bot     # Fase 5 — stop any other order-flow writer first
```

See **`RUN.md`** for the full runbook: DB placement, the mandatory datetime conversion,
phased bring-up, backups, monitoring, rollback, and the optional SQLite → Postgres move.

## Conventions

Project conventions live in **`CLAUDE.md`**. Highlights:

- **Decimal for all money** — never `float`.
- **No raw SQL in routes/handlers** — add helpers to `packages/db/src/crud/*` with Vitest coverage.
- **UTC in DB**, `TIMEZONE` on display.
- **Audit every state change** with the acting admin id (`logAdminAction`).
- **Never send Telegram from the web** — enqueue to `notification_outbox`; the notifier delivers.
- **Never log secrets** (tokens, payment-proof `file_id`, password hashes, DB URLs).
- **No leaked English** — customer/admin strings go through `t(ctx, key, args)`; keep
  `locales/en.json` and `locales/id.json` key sets identical.
- `pnpm -r typecheck` and `pnpm test` must stay green; add tests with each behavior change.

## Project docs

- `CLAUDE.md` — coding conventions and guardrails
- `RUN.md` — running & cutover runbook (Docker)
- `feedback.md` — live backlog
