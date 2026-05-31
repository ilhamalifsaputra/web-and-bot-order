# telegram-order-bot

A Telegram-based ordering platform with a web admin panel, built as a Node/TypeScript
pnpm monorepo. Customers browse a catalog and check out (Buy Now → confirm → pay) through a
[grammY](https://grammy.dev) bot; admins manage orders, payments, stock, wallets, and
reports from a Fastify web panel. Three services share **one** SQLite database
(WAL mode) over [Prisma](https://www.prisma.io).

> Migrated from a legacy Python (SQLAlchemy/Alembic) stack; see `RUN.md` for the
> deploy/cutover runbook.

## Features

### Customer (Telegram bot)
- **Catalog** — numbered, paginated product list with prices; per-product detail
  with stock, rating, warranty, and bulk-pricing tiers.
- **Checkout** — Buy Now → confirmation → payment, with a pending-order expiry
  countdown and reminders. Quantity entry via inline ± buttons or typed input.
- **Payments** — Binance Pay (manual screenshot + TxID proof) and Binance
  Internal Transfer (UID-based, auto-confirmed by a poller).
- **Vouchers, wallet & referrals** — apply discount codes, pay from wallet
  balance, earn referral commission on referrals' first purchase.
- **After-sale** — order history (downloadable), reviews/ratings, warranty
  replacement requests, and restock ("notify when available") subscriptions.
- **Support tickets** — open a ticket with optional photos; admins reply in-thread.
- **Bilingual** — every customer/admin string is localized EN/ID (`t()`), with a
  per-user language preference.

### Admin (bot + web panel)
- **Order ops** — verify/reject payment proofs, view orders, stock allocation.
- **Catalog & stock** — create/edit products, upload stock, bulk
  activate/deactivate, mark-dead, bulk-price preview, and CSV import.
- **Payments panel** — reconciliation view + Binance poller watchdog/alerts.
- **Wallet ledger** — authoritative double-entry-style ledger with running balance.
- **Reviews moderation, reports, broadcasts, and global search.**
- **RBAC + 2FA** — role-based access, TOTP two-factor, force-logout.
- **Audit log** — every state change records the acting admin id.
- **Outbox monitor** — health of the `notification_outbox` → notifier pipeline.

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

The web panel **never** talks to Telegram directly — it enqueues to
`notification_outbox`, and the notifier (or bot) delivers. SQLite is
single-writer; the order-bot owns the order-flow writes.

### Workspaces

| Path                | Package           | Role |
|---------------------|-------------------|------|
| `apps/order-bot`    | `@app/order-bot`  | Customer + admin Telegram bot (grammY, conversations, runner). Browse, Buy Now checkout, payment flows, stock allocation, scheduled jobs. |
| `apps/web-admin`    | `@app/web-admin`  | Admin web panel (Fastify + Nunjucks + HTMX). Orders, payments, reviews, wallet ledger, reports, RBAC/2FA. |
| `apps/notifier`     | `@app/notifier`   | Drains `notification_outbox` and delivers Telegram messages/broadcasts. |
| `packages/core`     | `@app/core`       | Shared config, money (Decimal), i18n (`t()` over `locales/{en,id}.json`), datetime, logging (pino), formatters. |
| `packages/db`       | `@app/db`         | Prisma client + per-domain CRUD helpers (`src/crud/*`). |

### Repository layout

```
apps/
  order-bot/src/
    handlers/        customer, admin, checkout, callbacks, verification, static
    conversations/   multi-step flows (proof upload, support, product/voucher create…)
    keyboards/        inline + persistent reply keyboards (localized)
    jobs/            scheduled jobs (payment expiry, reminders) via croner
    payments/        Binance poller + matching
    util/            chat (smartEdit), i18n, format, errors, validators
    middleware.ts    rate-limit, registered-user, update-id binding
  web-admin/src/
    routes/          one module per area (orders, payments, stock, reports, auth…)
    views/           Nunjucks templates (HTMX-driven)
  notifier/src/      outbox drain loop
packages/
  core/src/          config, money, i18n, datetime, logger, formatters
  core/locales/      en.json, id.json (key sets kept identical, parity-tested)
  db/src/crud/       audit, catalog, orders, stock, wallet, vouchers, reviews,
                     referrals, support, broadcasts, reports, binance_internal…
data/bot.db          shared SQLite (WAL)
```

## Tech stack

- **Runtime:** Node ≥ 20, run via `tsx` (no compile step in dev)
- **Package manager:** pnpm 9 (workspaces)
- **Bot:** grammY (`@grammyjs/conversations`, `@grammyjs/runner`), croner for jobs
- **Web:** Fastify 5, Nunjucks views, HTMX, bcryptjs auth, CSRF + cookie sessions, TOTP 2FA
- **Data:** Prisma 5 over SQLite (`data/bot.db`, WAL)
- **Money:** `decimal.js` — never `float`
- **Tests:** Vitest

## Quick start (local dev)

```bash
pnpm install
pnpm prisma:generate

# create a .env at the repo root (see "Configuration" below), then create the DB:
pnpm exec prisma db push

# run any single service (each watches + reloads):
pnpm dev:bot        # order-bot
pnpm dev:web        # web-admin (default http://127.0.0.1:8000)
pnpm dev:notifier   # notifier
```

## Configuration

Services read environment variables via `packages/core/src/config.ts`. Put them in a
`.env` at the repo root.

**Shared / core**

| Key                   | Notes |
|-----------------------|-------|
| `DATABASE_URL_PRISMA` | e.g. `file:/app/data/bot.db` (use an **absolute** path in containers) |
| `ADMIN_IDS`           | Comma-separated Telegram user IDs |
| `TIMEZONE`            | UTC in DB, this TZ on display (e.g. `Asia/Jakarta`) |
| `CURRENCY`            | Display currency (e.g. `USDT`) |
| `DEFAULT_LANGUAGE`    | `en` or `id` |
| `LOG_LEVEL` · `LOG_FILE_PATH` · `LOG_JSON_FILE` · `LOG_BACKUP_COUNT` | pino logging |

**order-bot**

| Key                   | Notes |
|-----------------------|-------|
| `BOT_TOKEN` · `BOT_USERNAME` | Telegram bot credentials |
| `SUPPORT_GROUP_ID`    | Group that receives tickets / replacement requests |
| `PAYMENT_WINDOW_MINUTES` · `INTERNAL_PAYMENT_WINDOW_MINUTES` | Pending-order expiry windows |
| `POLL_INTERVAL_SECONDS` | Binance poller cadence |
| `RATE_LIMIT_MAX` · `RATE_LIMIT_WINDOW_SECONDS` | Per-user flood limit |
| `LOW_STOCK_THRESHOLD` · `DEFAULT_WARRANTY_DAYS` | Catalog defaults |
| `REFERRAL_COMMISSION_PERCENT` | Referral payout |
| `USE_UNIQUE_CENTS` · `USDT_IDR_RATE` | Unique-cents amount matching; IDR display rate |

**Payments (Binance)**

| Key                   | Notes |
|-----------------------|-------|
| `BINANCE_PAY_ID`      | Manual-proof Binance Pay ID |
| `BINANCE_RECEIVE_UID` | Internal-transfer UID (auto-confirmed method) |
| `BINANCE_API_KEY` · `BINANCE_API_SECRET` · `BINANCE_API_BASE` | Poller API access |
| `BINANCE_QR_PATH`     | Payment QR image path |

**web-admin**

| Key                   | Notes |
|-----------------------|-------|
| `WEB_HOST` · `WEB_PORT` | Defaults `127.0.0.1:8000`; public exposure needs a reverse proxy + TLS |
| `WEB_COOKIE_SECRET`   | ≥ 32 chars |
| `WEB_COOKIE_NAME` · `WEB_SESSION_TTL_HOURS` | Session cookie |
| `WEB_LOGIN_RATE_LIMIT_MAX` · `WEB_LOGIN_RATE_LIMIT_WINDOW_SECONDS` | Login throttle |

**notifier**

| Key                   | Notes |
|-----------------------|-------|
| `NOTIF_BOT_TOKEN`     | Bot token used for delivery |
| `PUBLIC_CHANNEL_ID`   | Channel for public/broadcast posts |
| `NOTIF_POLL_INTERVAL_SECONDS` · `NOTIF_MAX_ATTEMPTS` | Outbox drain cadence + retry cap |

## Database & migrations

All services share one Prisma schema (`prisma/schema.prisma`) over a
single SQLite file. Apply schema changes with:

```bash
pnpm exec prisma db push      # sync the schema to data/bot.db
pnpm prisma:generate          # regenerate the client after schema edits
```

> **On deploy:** migrate the live DB **and restart order-bot before new code runs**,
> or you get `P2022 column … does not exist`. SQLite is single-writer — keep each
> `$transaction` short; the trigger to move to Postgres is ≥2 concurrent writers
> (see `RUN.md §9`).

## Testing

```bash
pnpm test                                   # full Vitest suite
pnpm exec vitest run apps/order-bot/test/conversations.test.ts   # one file
pnpm exec vitest                            # watch mode
```

Logic is covered with **crud-level unit tests** (`packages/db/src/crud/*.test.ts`)
plus handler/conversation tests in `apps/order-bot/test/`. New web routes get the
happy / auth-fail / bad-CSRF test trio. `pnpm -r typecheck` and `pnpm test` must
stay green; add tests with each behavior change.

## Common scripts

```bash
pnpm test            # full Vitest suite
pnpm typecheck       # pnpm -r typecheck + the test tsconfig
pnpm build           # build all workspaces
pnpm prisma:generate # regenerate the Prisma client
pnpm prisma:pull     # introspect the DB into the schema
pnpm dev:bot | dev:web | dev:notifier   # run a single service (watch mode)
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
- **Bot UX:** edit the bubble in place (`smartEdit`/`adminEdit`), never strand the
  user — every terminal screen offers a forward action.
- **Never send Telegram from the web** — enqueue to `notification_outbox`; the notifier delivers.
- **Never log secrets** (tokens, payment-proof `file_id`, password hashes, DB URLs).
- **No leaked English** — customer/admin strings go through `t(ctx, key, args)`; keep
  `locales/en.json` and `locales/id.json` key sets (and `{placeholders}`) identical.
- `pnpm -r typecheck` and `pnpm test` must stay green; add tests with each behavior change.

## Roadmap & status

The live backlog is **`feedback.md`** (`§0` is the consolidated board); this is a
snapshot.

### ✅ Shipped
- **Web admin** — Tier 1 (`/payments`, `/outbox`, dashboard SLA widgets) ·
  Tier 2 (wallet ledger, reviews moderation, restock waitlist, `/reports`, bulk
  ops: activate/deactivate + mark-dead + bulk-price preview + **CSV import**) ·
  Tier 3 (**RBAC**, **2FA + force-logout**, **broadcast**, **global search**).
- **Wallet ledger** — authoritative table, running balance, every move recorded.
- **Payments (Binance)** — Internal Transfer auto-confirm, amount fallback +
  `normalizeTx` fix, poller watchdog + dashboard alert, fixture test.
- **Bot UX** — edit-in-place everywhere, `smartEdit` photo+caption, numbered
  browse list with prices, stale-catalog race fix, global + handler-level error
  correlation refs, never-strand sweep, quantity-input exit guard.
- **i18n** — localized admin strings, per-user language, language-aware
  persistent keyboards, EN/ID parity test, `formatIdr`.
- **Docs/conventions** — `CLAUDE.md`, deploy/migration checklist, this README.
- **218 tests green**, `pnpm -r typecheck` clean.

### 🔴 Needs owner action (decision blocker, not a delivery blocker)
- **Binance `note` field** — send one memo'd test transfer, run
  `pnpm exec tsx scripts/binance-probe.ts`, read the `NOTE-FIELD VERDICT`. Decides
  note-vs-amount-vs-UID matching, then sync the payment-screen copy. Auto-confirm
  already works via the amount fallback, so this only refines the matching strategy.

### 🗓 Planned / deferred (each its own focused PR)
- **Multi-session "active sessions" list** (per-device + selective revoke) — needs
  a sessions table; force-logout covers the practical need for now.
- **Photo broadcasts + richer delivery analytics** — web broadcast is text-only today.
- **Fine-grained RBAC** — per-action capabilities (currently coarse, by URL area).
- **Lighter browse layout** — optional fallback if the branded ASCII renders poorly.

### 🧪 Testing gaps (nice-to-have)
- End-to-end web `/reviews` hide → bot rating exclusion (crud-level already covered).
- Extend the happy / auth-fail / bad-CSRF route trio to every new web route.

### 🔧 Ops (every deploy)
Migrate the DB (`prisma db push` or apply migrations) **and restart order-bot
before new code runs** (avoids `P2022`). Pending migrations to apply on the live
DB: `review_hidden`, `wallet_transactions`, `broadcasts`.

## Project docs

- `CLAUDE.md` — coding conventions and guardrails
- `RUN.md` — running & cutover runbook (Docker)
- `feedback.md` — live backlog & roadmap (source of truth for the section above)
