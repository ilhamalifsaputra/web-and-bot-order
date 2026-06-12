# Telegram Order Bot

A full-stack e-commerce platform built around a **Telegram bot** with an **admin web dashboard** and a **customer-facing storefront**. Customers browse a product catalog, place orders, and pay via Binance or TokoPay — directly through Telegram or the web shop. Admins manage inventory, orders, payments, customers, and analytics from a Fastify web panel.

Built as a **Node.js/TypeScript pnpm monorepo**. Three service apps share one SQLite database (WAL mode) through a single Prisma client — no synchronization required.

---

## Features

### Customer — Telegram Bot
- **Product catalog** — paginated browse, per-category filtering, product detail with stock badge, ratings, warranty, and bulk-pricing tiers
- **Checkout** — Buy Now flow with inline ± quantity buttons, order confirmation, and auto-cancel countdown
- **Payments** — Binance Pay (manual proof + TxID) and Binance Internal Transfer (UID-based, auto-confirmed by background poller)
- **Vouchers, wallet & referrals** — discount codes, wallet balance checkout, referral commission on first-purchase of referees
- **Order history** — full order log, credential delivery (digital products), warranty replacement requests
- **Restock notifications** — subscribe to out-of-stock products; bot alerts when restocked
- **Support tickets** — open a ticket with optional photo attachments; in-thread admin replies
- **Bilingual** — every string localized EN/ID via `t()` with per-user language preference

### Customer — Web Storefront
- **Guest browsing** — catalog, product detail, and stock badges without login
- **Guest cart** — cookie-based cart with merge on Telegram Login
- **Telegram Login** — OAuth-style authentication using the official Telegram Login Widget + HMAC verification
- **Checkout & payment pages** — order creation (shared CRUD with bot), Binance Internal Transfer (USDT) and TokoPay (IDR) payment pages with HTMX status polling
- **Account section** — order history, credential delivery, referral link, reviews, support tickets
- **Dual-currency display** — IDR as primary price, USDT equivalent shown alongside (derived from live market rate); currency chosen at payment time

### Admin — Web Panel
- **Order management** — list, detail, manual payment verification/rejection, refund flow
- **Catalog & inventory** — product CRUD, category management, per-product image URLs, bulk pricing, CSV stock import
- **Stock control** — add/remove stock items (credentials), bulk activate/deactivate, mark-dead
- **Payments panel** — Binance reconciliation view, poller watchdog, manual confirmation
- **Wallet ledger** — double-entry style wallet history with running balance per customer
- **Reviews moderation** — hide/unhide product reviews
- **Reports** — sales metrics, inventory status, customer analytics
- **Broadcasts** — enqueue bulk Telegram messages (ALL / RESELLERS / RECENT_BUYERS segments)
- **Support tickets** — view, reply, close customer support cases
- **Global search** — unified search across orders, users, and products
- **RBAC + 2FA** — role-based access control, optional TOTP two-factor authentication, force-logout
- **Audit log** — every admin state change recorded with acting admin ID and timestamp
- **Settings** — bot token, TokoPay credentials, Binance Pay ID, exchange rate, business rules — all editable without redeployment

---

## Tech Stack

| Layer | Technology |
|---|---|
| **Runtime** | Node.js ≥ 20, executed via `tsx` (no compile step in development) |
| **Language** | TypeScript 5.6 (strict, `noUncheckedIndexedAccess`, ESM) |
| **Package manager** | pnpm 9.15.9 (workspaces) |
| **Telegram bot** | grammY 1.30, `@grammyjs/conversations`, `@grammyjs/runner` |
| **Web framework** | Fastify 5 (web-admin + storefront) |
| **Templates** | Nunjucks 3 via `@fastify/view` |
| **Frontend interactivity** | HTMX 2 (no SPA framework) |
| **CSS** | Tailwind CSS via CDN + custom tokens |
| **Icons** | Lucide |
| **Database** | SQLite (WAL mode, single-writer) |
| **ORM** | Prisma 5 (`@prisma/client`) |
| **Money arithmetic** | `decimal.js` (never `float`) |
| **Date/time** | luxon (UTC in DB, `TIMEZONE` env on display) |
| **Config validation** | Zod |
| **Logging** | pino + pino-roll (structured JSON, file rotation) |
| **Scheduling** | croner 8 (cron jobs for order expiry, FX refresh, warranty reminders) |
| **Authentication (web)** | HMAC-signed session cookies + optional TOTP 2FA (bcryptjs passwords) |
| **Authentication (storefront)** | Telegram Login Widget + HMAC verification |
| **CSRF protection** | Double-submit cookie pattern on all mutating routes |
| **Payment gateways** | Binance Pay, Binance Internal Transfer (UID), TokoPay (IDR/QRIS) |
| **Build bundler** | esbuild (Hostinger single-file bundle) |
| **Testing** | Vitest 2 |
| **Containerization** | Docker (multi-stage), Docker Compose |

---

## Project Structure

```
.
├── apps/
│   ├── order-bot/          # Telegram bot (grammY) — customer + admin flows
│   │   └── src/
│   │       ├── handlers/       # Command & callback handlers (customer, admin, checkout)
│   │       ├── conversations/  # Multi-step grammY conversations (proof upload, support, etc.)
│   │       ├── keyboards/      # Inline + reply keyboard builders (localized)
│   │       ├── jobs/           # Croner scheduled jobs (expiry, FX refresh, reminders)
│   │       ├── payments/       # Binance Internal Transfer poller + matching
│   │       ├── util/           # i18n, formatters, smartEdit, errors, validators
│   │       ├── middleware.ts   # Rate-limit, registered-user, update-id binding
│   │       ├── context.ts      # MyContext type + session definition
│   │       └── main.ts         # buildBot() factory (testable, no side effects)
│   │
│   ├── web-admin/          # Admin dashboard (Fastify + Nunjucks + HTMX)
│   │   └── src/
│   │       ├── routes/         # One module per area (orders, payments, catalog, users…)
│   │       ├── plugins/        # Fastify plugins (views, auth, static, CSRF)
│   │       ├── views/          # Nunjucks .njk templates
│   │       ├── auth.ts         # Session cookie helpers
│   │       └── server.ts       # buildApp() factory
│   │
│   ├── storefront/         # Customer web shop (Fastify + Nunjucks + HTMX)
│   │   └── src/
│   │       ├── routes/         # home, catalog, cart, checkout, account, support, auth
│   │       ├── payments/       # TokoPay client + webhook verification
│   │       ├── plugins/        # Fastify plugins (views, auth, static, cookie)
│   │       ├── images.ts       # Product image URL resolution (web URL → Unsplash fallback)
│   │       ├── pricing.ts      # IDR/USDT conversion helpers
│   │       ├── shop.ts         # Catalog browsing + cart management utilities
│   │       ├── auth.ts         # Telegram Login Widget HMAC verification + session cookies
│   │       └── server.ts       # buildApp() factory
│   │
│   ├── notifier/           # Background notification sender — drains notification_outbox
│   │   └── src/
│   │       ├── dispatcher.ts   # Outbox poll → Telegram send loop (retry-aware)
│   │       └── main.ts         # Standalone entry point
│   │
│   └── server/             # Combined single-process entry (Hostinger / managed hosting)
│       └── src/
│           └── index.ts        # Composition root — wires all apps + bot + workers
│
├── packages/
│   ├── core/               # Shared utilities (config, money, i18n, logging, datetime)
│   │   ├── src/
│   │   │   ├── config.ts       # Zod-validated environment variables (all services)
│   │   │   ├── money.ts        # Decimal money operations
│   │   │   ├── i18n.ts         # t() translation function + locale loading
│   │   │   ├── datetime.ts     # UTC ↔ TIMEZONE helpers (luxon)
│   │   │   ├── logger.ts       # Pino logger with file rolling
│   │   │   ├── formatters.ts   # Price, date, duration formatting
│   │   │   ├── enums.ts        # Shared enum constants (OrderStatus, PaymentMethod, etc.)
│   │   │   ├── fx.ts           # USDT/IDR currency conversion helpers
│   │   │   └── runtime.ts      # Cached bot credentials from DB Settings
│   │   └── locales/
│   │       ├── en.json         # English strings
│   │       └── id.json         # Indonesian strings (key sets kept identical)
│   │
│   ├── db/                 # Prisma client + per-domain CRUD repositories
│   │   ├── prisma/         # (symlinked from root) schema + migrations
│   │   └── src/
│   │       ├── client.ts       # PrismaClient singleton + initDb() (WAL pragma)
│   │       ├── crud/           # Per-domain repositories (18 modules, 10 test files)
│   │       │   ├── users.ts, catalog.ts, stock.ts, cart.ts, vouchers.ts
│   │       │   ├── orders.ts, referrals.ts, reviews.ts, support.ts
│   │       │   ├── settings.ts, audit.ts, reports.ts, notifications.ts
│   │       │   ├── binance_internal.ts, tokopay.ts, broadcasts.ts
│   │       │   ├── pricing.ts, credentials.ts
│   │       │   └── *.test.ts   # Vitest unit tests per module
│   │       └── index.ts        # Re-exports all CRUD helpers
│   │
│   └── web-ui/             # Shared Nunjucks templates + static assets
│       └── views/
│           ├── _theme.njk      # Tailwind config + font tokens (shared by both webs)
│           ├── _macros.njk     # Reusable macros (flash, status_badge, csrf_field, etc.)
│           ├── admin/          # web-admin-specific template fragments
│           └── shop/           # storefront-specific template fragments
│
├── prisma/
│   └── schema.prisma       # Single shared schema (21 models, SQLite WAL)
│
├── data/
│   └── bot.db              # SQLite database (WAL mode, git-ignored)
│
├── scripts/
│   ├── build-bundle.ts     # esbuild — bundle dist/server.cjs for Hostinger
│   ├── reset-admin-password.ts  # Break-glass admin recovery
│   ├── convert-prices-to-idr.ts # One-time USDT → IDR price migration
│   └── binance-probe.ts    # Binance API connectivity diagnostics
│
├── tests/
│   └── helpers/            # Shared test database + fixture utilities
│
├── Dockerfile              # Multi-stage build (builder → slim runtime)
├── docker-compose.yml      # Three-service compose (bot, web-admin, notifier)
├── package.json            # Workspace root
├── package.prod.json       # Flat deps for Hostinger (no workspaces)
├── pnpm-workspace.yaml
├── tsconfig.base.json
├── vitest.config.ts
├── .env.example
├── CLAUDE.md               # Coding conventions & guardrails
├── DEPLOY-HOSTINGER.md     # Hostinger Node.js App Manager runbook
└── CUTOVER-IDR.md          # One-time USDT → IDR price migration guide
```

---

## Architecture Overview

### System Architecture

```
┌──────────────────────────────────────────────────────────────┐
│                     Client Layer                             │
│  Telegram App          Browser (admin)    Browser (shop)     │
└──────────┬─────────────────┬──────────────────┬─────────────┘
           │ Telegram API    │ HTTP             │ HTTP
           ▼                 ▼                  ▼
┌──────────────┐   ┌──────────────┐   ┌──────────────────────┐
│  order-bot   │   │  web-admin   │   │     storefront       │
│  (grammY)    │   │  (Fastify)   │   │     (Fastify)        │
│  port: long  │   │  port: 8000  │   │     port: 8100       │
│  polling or  │   │  Nunjucks +  │   │     Nunjucks +       │
│  webhook     │   │  HTMX        │   │     HTMX             │
└──────┬───────┘   └──────┬───────┘   └──────────┬───────────┘
       │                  │                       │
       └──────────────────┼───────────────────────┘
                          │  @app/db (Prisma)
                          ▼
              ┌───────────────────────┐
              │  data/bot.db          │
              │  (SQLite, WAL mode)   │
              │  Single writer        │
              └───────────────────────┘
                          │
              ┌───────────┴────────────┐
              │    notifier (background)│
              │    drains outbox →      │
              │    Telegram messages    │
              └────────────────────────┘
```

### Single-Process Mode (Hostinger / Managed Hosting)

All four services fold into **one Node process** via `apps/server`:

```
apps/server/src/index.ts
├── buildApp()         ← web-admin Fastify instance
├── buildShopApp()     ← storefront Fastify instance
├── buildBot(token)    ← grammY bot (polling or webhook route)
├── scheduleJobs()     ← croner: order expiry, FX refresh, reminders
├── startPolling()     ← Binance Internal Transfer poller
└── runDispatcher()    ← notification outbox drain
```

One `PrismaClient` across all services — single-writer invariant is trivially maintained.

**Host dispatch** (when `SHOP_PUBLIC_URL` is set): a single TCP listener routes incoming HTTP requests by `Host` header — shop domain → storefront, anything else → web-admin/bot.

### Request Flow (Customer checkout, web)

1. Customer adds to cart (cookie-based guest cart or `CartItem` DB row if logged in)
2. Telegram Login Widget authenticates via HMAC-SHA256 (`BOT_TOKEN`) → session cookie
3. Guest cart merges into `CartItem` rows on login
4. `POST /checkout` → `createOrderFromCart()` CRUD (shared with bot) → `Order` row, `StockItem` rows reserved, `uniqueCents` applied for Binance matching
5. Payment page polls `GET /checkout/:code/status` (HTMX, ~5s interval)
6. **USDT path:** customer sends to Binance UID → Binance Internal Transfer poller (`binanceInternal.ts`) detects TX → `confirmOrder()` in `$transaction` → outbox enqueued
7. **IDR path:** TokoPay creates QRIS/VA → customer pays → TokoPay webhook `POST /pay/tokopay/callback` → signature verified → idempotent insert into `ProcessedTokopayTx` → `confirmOrder()` → outbox enqueued
8. Notifier drains outbox → delivers credential message via Telegram
9. HTMX poll detects `DELIVERED` status → credential displayed on payment page

### Database Interactions

- All money stored as Prisma `Decimal` — no `Float` columns
- UTC timestamps stored; displayed in `TIMEZONE` env
- Every write that changes order/wallet state is wrapped in `prisma.$transaction()`
- Idempotency tables: `ProcessedBinanceTx` and `ProcessedTokopayTx` (unique TX/ref constraints prevent double-confirms)
- `notification_outbox` decouples the web layer from Telegram: web enqueues, bot/notifier delivers
- `AuditLog` records every admin action with actor ID

### External Integrations

| Integration | Purpose |
|---|---|
| **Telegram Bot API** | Order bot, admin commands, credential delivery, support tickets |
| **Binance Pay** | Manual payment proof (USDT) |
| **Binance Internal Transfer** | Automatic payment confirmation via UID + API |
| **TokoPay** | IDR payment gateway (QRIS, virtual account, e-wallet) |
| **open.er-api.com** | Hourly USD/IDR exchange rate refresh |

---

## Prerequisites

| Requirement | Version |
|---|---|
| **Node.js** | ≥ 20.x |
| **pnpm** | 9.x (`npm install -g pnpm@9`) |
| **SQLite** | Built into Node (Prisma manages it) |
| **Docker** | 24+ (optional, for containerized deployment) |
| **Docker Compose** | v2 (optional) |

No database server installation required — SQLite is a file on disk.

---

## Installation

```bash
# 1. Clone the repository
git clone <repo-url>
cd telegram-order-bot

# 2. Install dependencies (all workspaces)
pnpm install

# 3. Copy and configure environment variables
cp .env.example .env
# Edit .env with your values (see Environment Variables below)

# 4. Generate the Prisma client
pnpm prisma:generate

# 5. Create / sync the database
pnpm exec prisma db push

# 6. (First-time only) Bootstrap the first admin account
# Open the web panel, navigate to /admin/setup, and register
```

---

## Environment Variables

All environment variables are validated at startup by Zod (`packages/core/src/config.ts`). Missing required variables will cause the process to exit with an error message.

### Core / Shared

| Variable | Description | Required | Default |
|---|---|---|---|
| `DATABASE_URL_PRISMA` | SQLite file path. Use absolute path in containers: `file:/app/data/bot.db` | ✅ | `file:../data/bot.db` |
| `ADMIN_IDS` | Comma-separated Telegram user IDs with admin access | ✅ | — |
| `TIMEZONE` | IANA timezone for display (e.g. `Asia/Jakarta`) | ✅ | — |
| `DEFAULT_LANGUAGE` | Default language for new users (`en` or `id`) | | `en` |
| `LOG_LEVEL` | Pino log level: `debug`, `info`, `warn`, `error` | | `info` |
| `LOG_FILE_PATH` | Path for rolling log file (optional) | | — |
| `LOG_JSON_FILE` | Write structured JSON log to this path (optional) | | — |
| `LOG_BACKUP_COUNT` | Number of rotated log files to keep | | `5` |

### Telegram Bot

| Variable | Description | Required |
|---|---|---|
| `BOT_TOKEN` | Token from [@BotFather](https://t.me/BotFather). Can also be stored in web-admin Settings (DB wins over env) | ✅ |
| `BOT_USERNAME` | Bot username without `@` (for referral links). Auto-fetched via `getMe()` if omitted | |
| `SUPPORT_GROUP_ID` | Group/channel ID where support tickets are forwarded (negative for groups) | |
| `RATE_LIMIT_MAX` | Max messages per user per window | `5` |
| `RATE_LIMIT_WINDOW_SECONDS` | Rate-limit window | `3` |
| `DEFAULT_WARRANTY_DAYS` | Default warranty period in days | `30` |
| `LOW_STOCK_THRESHOLD` | Alert admins when stock ≤ this number | `3` |
| `REFERRAL_COMMISSION_PERCENT` | Referral commission on first purchase (e.g. `10` = 10%) | `10` |

### Payment — Binance Pay (Manual Proof)

| Variable | Description | Required |
|---|---|---|
| `BINANCE_PAY_ID` | Binance Pay merchant ID shown to customers | ✅ |
| `BINANCE_QR_PATH` | Path to a static QR code image (optional) | |
| `CURRENCY` | Display currency label (e.g. `USDT`) | `USDT` |
| `PAYMENT_WINDOW_MINUTES` | Minutes until manual-proof order auto-cancels | `30` |
| `USE_UNIQUE_CENTS` | Append unique cents to amounts for matching (`1` = on) | `1` |

### Payment — Binance Internal Transfer (Auto-Confirmed)

| Variable | Description | Required |
|---|---|---|
| `BINANCE_RECEIVE_UID` | Your Binance UID for receiving transfers. Leave blank to disable this method | |
| `BINANCE_API_KEY` | Read-only Binance API key | |
| `BINANCE_API_SECRET` | Binance API secret | |
| `BINANCE_API_BASE` | Binance API base URL | `https://api.binance.com` |
| `POLL_INTERVAL_SECONDS` | How often to check Binance for new transfers | `10` |
| `INTERNAL_PAYMENT_WINDOW_MINUTES` | Minutes until auto-confirm order expires | `15` |

### Web Admin

| Variable | Description | Required | Default |
|---|---|---|---|
| `WEB_HOST` | Bind address. Use `0.0.0.0` behind a reverse proxy | | `127.0.0.1` |
| `WEB_PORT` | Port for the admin panel | | `8000` |
| `WEB_COOKIE_SECRET` | HMAC secret for session cookies (≥ 32 characters). Rotate to invalidate all sessions | ✅ | — |
| `WEB_COOKIE_NAME` | Session cookie name | | `stockweb_session` |
| `WEB_SESSION_TTL_HOURS` | Session lifetime in hours | | `12` |
| `WEB_LOGIN_RATE_LIMIT_MAX` | Max login attempts per window | | `5` |
| `WEB_LOGIN_RATE_LIMIT_WINDOW_SECONDS` | Login rate-limit window | | `60` |
| `WEB_COOKIE_SECURE` | Set `Secure` flag on cookies (`true` in production behind TLS) | | `false` |

### Storefront

| Variable | Description | Required | Default |
|---|---|---|---|
| `STOREFRONT_PORT` | Port for the customer storefront | | `8100` |
| `SHOP_HOST` | Public hostname of the storefront (e.g. `shop.example.com`). When set, a single listener dispatches by `Host` header | | — |
| `SHOP_PUBLIC_URL` | Full public URL of the storefront (e.g. `https://shop.example.com`) | | — |

### Combined Server / Webhook Mode

| Variable | Description | Required |
|---|---|---|
| `BOT_MODE` | `polling` (default) or `webhook` | |
| `PUBLIC_URL` | Public HTTPS base URL, no trailing slash (e.g. `https://shop.example.com`). Required in webhook mode | ✅ (webhook) |
| `WEBHOOK_SECRET` | Random secret used as both the URL path segment and Telegram `secret_token` header. **Never log this** | ✅ (webhook) |
| `PORT` | Override listen port (injected by managed hosts) | |

### Notifier

| Variable | Description | Required | Default |
|---|---|---|---|
| `NOTIF_BOT_TOKEN` | Separate bot token for notifications. Falls back to main bot if unset | | — |
| `PUBLIC_CHANNEL_ID` | Channel ID for public broadcasts. Notifier is disabled if unset | | — |
| `NOTIF_POLL_INTERVAL_SECONDS` | Outbox drain interval | | `10` |
| `NOTIF_MAX_ATTEMPTS` | Max retries before marking outbox item failed | | `5` |

---

## Running Locally

### Development (separate processes, recommended)

```bash
# Terminal 1 — Telegram bot (watch mode)
pnpm dev:bot

# Terminal 2 — Admin web panel (http://127.0.0.1:8000)
pnpm dev:web

# Terminal 3 — Notification outbox drain
pnpm dev:notifier
```

### Development (single combined process)

```bash
# Runs bot + web-admin + storefront + notifier in one process
# Admin: http://127.0.0.1:8000 | Storefront: http://127.0.0.1:8100
pnpm start
```

### Type checking

```bash
pnpm typecheck        # pnpm -r typecheck (all packages) + test tsconfig
```

### Tests

```bash
pnpm test             # Vitest — full suite
pnpm exec vitest      # Watch mode
```

### Build (Hostinger bundle)

```bash
pnpm run build:bundle  # → dist/server.cjs (~3.5 MB, all @app/* inlined)
```

### Database utilities

```bash
pnpm exec prisma db push      # Sync schema to data/bot.db
pnpm prisma:generate          # Regenerate Prisma client after schema changes
pnpm prisma:pull               # Introspect existing DB into schema
```

### Admin recovery

```bash
pnpm reset-admin-password <telegram_id>              # Clear password + 2FA
pnpm reset-admin-password <telegram_id> --set <pw>  # Set a new password
```

---

## Web Admin Routes

The web admin panel is a server-rendered Fastify application. All mutating routes require a valid CSRF token and an authenticated admin session.

| Path | Methods | Description |
|---|---|---|
| `/login` | GET, POST | Admin login (username/password + optional TOTP) |
| `/logout` | POST | Invalidate session |
| `/setup` | GET, POST | Bootstrap first admin (disabled after first admin exists) |
| `/dashboard` | GET | Overview stats, SLA widgets, poller health |
| `/orders` | GET | Order list with filters (status, date, search) |
| `/orders/:id` | GET | Order detail — items, payment, stock allocation |
| `/orders/:id/verify` | POST | Manually confirm payment proof |
| `/orders/:id/reject` | POST | Reject payment with reason |
| `/orders/:id/refund` | POST | Issue full refund to wallet |
| `/payments` | GET | Payments ops panel — Binance reconciliation |
| `/outbox` | GET | Notification outbox monitor |
| `/catalog` | GET, POST | Product list + create product |
| `/catalog/:id` | GET, POST | Edit product detail, image URL, pricing |
| `/catalog/:id/toggle` | POST | Activate/deactivate product |
| `/stock` | GET | Inventory overview |
| `/stock/:productId` | GET, POST | Add stock items, bulk CSV import |
| `/stock/:productId/deactivate` | POST | Bulk deactivate stock |
| `/vouchers` | GET, POST | Voucher list + create voucher |
| `/vouchers/:id/disable` | POST | Disable a voucher |
| `/users` | GET | Customer list |
| `/users/:id` | GET | Customer profile — orders, wallet, referrals |
| `/users/:id/ban` | POST | Ban/unban customer |
| `/reviews` | GET | Review moderation list |
| `/reviews/:id/hide` | POST | Hide/unhide a review |
| `/reports` | GET | Sales, inventory, customer reports |
| `/search` | GET | Unified search (orders, users, products) |
| `/admins` | GET, POST | Admin list + invite new admin |
| `/admins/:id/revoke` | POST | Revoke admin access |
| `/broadcast` | GET, POST | Enqueue bulk Telegram message |
| `/support` | GET | Support ticket list |
| `/support/:id` | GET, POST | Ticket detail + admin reply |
| `/settings` | GET, POST | Bot credentials, payment settings, business rules |
| `/audit` | GET | Admin action audit log |
| `/healthz` | GET | Liveness probe — `{"status":"ok"}` + DB ping |

### Authentication

All routes except `/login`, `/setup`, and `/healthz` require a valid session cookie. Session cookies are HMAC-signed with `WEB_COOKIE_SECRET`, scoped to `httpOnly`, and respect `WEB_COOKIE_SECURE`.

---

## Storefront Routes

The customer storefront is server-rendered with HTMX partial updates.

| Path | Description |
|---|---|
| `GET /` | Home page — banner, featured products |
| `GET /c/:slug` | Category page — filtered product grid |
| `GET /p/:id` | Product detail — stock, pricing, reviews, restock button |
| `GET /search` | Product search results |
| `GET /cart` | Cart page (guest cookie cart or DB cart if logged in) |
| `POST /cart/add` | Add item to cart |
| `POST /cart/remove` | Remove item from cart |
| `GET /checkout` | Checkout summary — validate, apply voucher |
| `POST /checkout` | Create order |
| `GET /checkout/:code/pay` | Payment page — Binance or TokoPay |
| `GET /checkout/:code/status` | HTMX partial — poll order status |
| `POST /pay/tokopay/callback` | TokoPay webhook (public, signature-verified) |
| `GET /login` | Telegram Login Widget page |
| `POST /auth/telegram` | Telegram Login callback (HMAC verification) |
| `POST /logout` | Clear session |
| `GET /account` | Account overview |
| `GET /account/orders` | Order history |
| `GET /account/orders/:code` | Order detail + credential delivery |
| `GET /account/referral` | Referral code + link |
| `GET /account/reviews` | Customer review history |
| `GET /account/support` | Support ticket list + create |
| `GET /healthz` | Liveness probe |

---

## Database

### Engine & Configuration

- **Database:** SQLite 3 with WAL (Write-Ahead Logging) mode
- **ORM:** Prisma 5 (`@prisma/client`)
- **Schema location:** `prisma/schema.prisma`
- **Data file:** `data/bot.db` (+ `bot.db-wal`, `bot.db-shm`)
- **Single-writer model:** All services run in one process; one `PrismaClient` instance; transactions are kept short. Move to PostgreSQL when ≥ 2 concurrent writers are needed.

### Schema Overview (21 models)

| Model | Purpose |
|---|---|
| `User` | Customer/admin account — telegramId, language, wallet balance, referral code |
| `Category` | Product categories with sort order and emoji |
| `Product` | Catalog items — price (IDR), stock type, warranty, web image URL |
| `StockItem` | Individual inventory credentials (AVAILABLE / RESERVED / SOLD) |
| `BulkPricing` | Quantity-based discount tiers per product |
| `Order` | Customer purchase — status, currency (IDR/USDT), payment method, expiry |
| `OrderItem` | Line items in an order — product, stock item, unit price snapshot |
| `Voucher` | Discount codes (FIXED or PERCENT type) with usage limits |
| `CartItem` | Shopping cart entries per user |
| `Review` | Product rating + comment (hideable) |
| `Referral` | Referral tracking — referrer, referee, commission, paid status |
| `WalletTransaction` | Append-only wallet ledger with running balance |
| `SupportTicket` | Customer support cases (OPEN / CLOSED) |
| `TicketMessage` | In-thread conversation messages (USER or ADMIN sender) |
| `RestockSubscription` | Per-product notification subscriptions |
| `Setting` | Key-value store for runtime configuration (bot token, FX rate, TokoPay keys) |
| `AuditLog` | Admin action audit trail with actor ID, action, target, details |
| `NotificationOutbox` | Async message queue — web enqueues, bot/notifier delivers |
| `Broadcast` | Bulk message records with segment and delivery metrics |
| `ProcessedBinanceTx` | Idempotency ledger for Binance Internal Transfer confirmations |
| `ProcessedTokopayTx` | Idempotency ledger for TokoPay webhook confirmations |

### Schema Changes (Migrations)

```bash
# After editing prisma/schema.prisma:
pnpm exec prisma db push       # Apply changes to data/bot.db
pnpm prisma:generate           # Regenerate Prisma client

# ⚠ IMPORTANT on production deploys:
# Always run db push + restart order-bot BEFORE deploying new code.
# Running new code against an old schema causes P2022 errors.
```

### USDT → IDR Price Migration (one-time)

If upgrading from an older USDT-priced catalog:

```bash
# 1. Stop the server
# 2. Backup data/bot.db
cp data/bot.db data/bot.db.bak-$(date +%Y%m%d)

# 3. Push schema (adds orders.currency, orders.fx_rate, web_image_url)
pnpm exec prisma db push

# 4. Convert catalog prices (replace 16000 with current market rate)
pnpm tsx scripts/convert-prices-to-idr.ts 16000

# 5. Start server
pnpm start
```

See `CUTOVER-IDR.md` for full details and rollback procedure.

---

## Authentication

### Admin Web Panel

- **Login flow:** POST `/login` with username + bcrypt-hashed password → session cookie issued
- **Optional 2FA:** TOTP (compatible with Google Authenticator, Authy). Secret stored in `Setting` table under an admin-specific key
- **Session cookies:** HMAC-signed (`<payloadB64url>.<ts>.<sig>`), `httpOnly`, configurable `Secure`, TTL from `WEB_SESSION_TTL_HOURS`
- **CSRF:** Double-submit cookie on all POST/PATCH/DELETE routes (`csrfProtect` preHandler)
- **Force-logout:** Rotating a JTI in Settings immediately invalidates all live sessions
- **Admin recovery:** `pnpm reset-admin-password <telegram_id>` clears password + 2FA

### Storefront (Customer)

- **Telegram Login Widget:** Standard Telegram OAuth flow; the widget posts `{id, first_name, username, photo_url, auth_date, hash}` to the server
- **HMAC verification:** Server verifies `hash` using HMAC-SHA256 with `BOT_TOKEN` (official Telegram algorithm); rejects if `auth_date` is stale
- **Session:** Same HMAC-signed cookie pattern as web-admin (separate cookie name/scope)
- **Guest access:** Catalog and cart are accessible without login; cart stored in a cookie. Checkout requires login
- **Cart merge:** On login, guest cookie cart merges into `CartItem` DB rows (quantities summed for duplicate products)

### Authorization Roles

| Role | Access |
|---|---|
| `CUSTOMER` | Telegram bot + storefront |
| `ADMIN` | Web admin panel (all sections based on URL-prefix RBAC) |
| `OWNER` / super-admin | Sensitive settings: bot token, TokoPay secret, admin management |

---

## Deployment

### Option 1: Docker Compose (Recommended for VPS)

Three services share one image and one SQLite volume:

```bash
# Build
docker compose build

# Start services (staged startup recommended)
docker compose up -d notifier     # notifier first
docker compose up -d web-admin    # then web panel
docker compose up -d order-bot    # bot last (stops any competing order-flow writer)

# Logs
docker compose logs -f order-bot

# Stop
docker compose down
```

All three services bind to `./data/bot.db`. The compose file uses `restart: unless-stopped` and `json-file` logging with rotation.

### Option 2: Hostinger Node.js App Manager (Managed Hosting)

A single combined process running all services. See `DEPLOY-HOSTINGER.md` for the full runbook. Key steps:

```bash
# Build the bundle locally
pnpm run build:bundle     # → dist/server.cjs (~3.5 MB)

# Upload to Hostinger via SSH or File Manager:
# - dist/server.cjs
# - package.prod.json → rename to package.json
# - prisma/schema.prisma
# - packages/web-ui/views/ (Nunjucks templates)
# - data/bot.db (if migrating from existing DB)

# On Hostinger (via SSH or terminal):
npm install
npx prisma generate
npx prisma db push

# Set startup file: dist/server.cjs (or node dist/server.cjs)
```

**Required environment variables for Hostinger:**
- `DATABASE_URL_PRISMA=file:/home/<user>/nodeapp/data/bot.db` (absolute path)
- `BOT_TOKEN`, `ADMIN_IDS`, `WEB_COOKIE_SECRET`, `TIMEZONE`
- For webhook mode: `BOT_MODE=webhook`, `PUBLIC_URL`, `WEBHOOK_SECRET`

**Keep alive:** Hostinger Passenger idles the app on no traffic. Add an UptimeRobot monitor pinging `GET /healthz` every 1–5 minutes to keep the bot poller and cron jobs running.

**Bot transport modes:**
- `BOT_MODE=polling` — simple, works without a domain, fully depends on UptimeRobot keep-alive
- `BOT_MODE=webhook` — Telegram POSTs updates to your domain, reduces idle risk; still need UptimeRobot for Binance poller

### Option 3: Local / Direct Node

```bash
# Start all services in one process (dev)
pnpm start

# Or start individual services
pnpm dev:bot
pnpm dev:web
pnpm dev:notifier
```

---

## Docker

### Dockerfile

Multi-stage build to minimize the runtime image size:

```
Stage 1 (builder): node:20-slim
  → install pnpm, copy source, pnpm install --frozen-lockfile, prisma generate

Stage 2 (runtime): node:20-slim
  → install openssl (Prisma requirement) + tini (process reaping)
  → create non-root user "app"
  → copy workspace from builder
  → VOLUME /app/data (SQLite + logs)
  → ENTRYPOINT tini → pnpm --filter @app/order-bot start
```

### Docker Compose

```yaml
# Three services, one SQLite file, one image
docker compose up -d
```

Service layout:

| Service | Container | Port | Command |
|---|---|---|---|
| `order-bot` | `bot-order` | — | `pnpm --filter @app/order-bot start` |
| `notifier` | `bot-notifier` | — | `pnpm --filter @app/notifier start` |
| `web-admin` | `bot-web-admin` | `WEB_PORT` (8000) | `pnpm --filter @app/web-admin start` |

All services mount `./data:/app/data` (shared SQLite) and read from `.env`.

### Building for a specific target

```bash
# Build and tag the image
docker compose build

# Run a one-off command (e.g., schema migration)
docker compose run --rm order-bot pnpm exec prisma db push
```

---

## Testing

### Running Tests

```bash
pnpm test                  # Full Vitest suite (all packages)
pnpm exec vitest           # Watch mode
pnpm exec vitest run packages/db/src/crud/orders.test.ts   # Single file
pnpm typecheck             # TypeScript type check (all workspaces)
```

### Test Coverage

Tests are **CRUD-level unit tests** using an isolated in-memory SQLite database (see `tests/helpers/testdb.ts`). Each test file sets up its own schema and tears down after.

| Test file | Covers |
|---|---|
| `order_creation.test.ts` | Order creation, unique-cents assignment, validation |
| `purchase_flow.test.ts` | Full cart → checkout → payment → credential delivery flow |
| `stock_deduction.test.ts` | Stock reservation, deduction, oversell prevention |
| `voucher_application.test.ts` | Voucher validation, application, usage increment |
| `pricing.test.ts` | Bulk discount calculation, IDR/USDT conversion |
| `wallet.test.ts` | Wallet top-up, refund, referral commission payouts |
| `reviews.test.ts` | Review creation, product rating, hide/unhide |
| `notifications.test.ts` | Outbox enqueue, retry logic, mark sent/failed |
| `broadcasts.test.ts` | Broadcast enqueue, segment filtering, delivery metrics |
| `reconciliation.test.ts` | Binance TX matching, TokoPay idempotency |

### Test Conventions

- Every new CRUD helper gets a Vitest unit test
- New web routes get a **happy / auth-fail / bad-CSRF** test trio
- `pnpm -r typecheck` and `pnpm test` must remain green on every commit
- No mocked database — tests run against a real isolated SQLite

---

## CI/CD

No CI/CD pipeline is configured in this repository. Recommended additions:

- Run `pnpm typecheck && pnpm test` on every pull request
- Build the Docker image and run smoke tests on the `main` branch
- Automate `pnpm run build:bundle` artifact upload for Hostinger deployments

---

## Security

### Secrets & Credentials

- **Never commit `.env`** — use `.env.example` as the template
- **Bot token** can be stored in web-admin Settings (DB) instead of env; DB value takes precedence — prevents env-file leaks
- **TokoPay secret** and **admin passwords** are stored as write-only fields in the UI — the current value is never echoed back or logged
- **Payment proof file IDs** (`file_id`) are never logged — a Telegram `file_id` is a permanent download link

### Web Security

- **CSRF protection** on every mutating route (double-submit cookie)
- **Admin panel bound to `127.0.0.1`** by default — public exposure requires a reverse proxy + TLS
- **Login brute-force protection** — rate-limited by IP via `WEB_LOGIN_RATE_LIMIT_*`
- **`httpOnly` + `Secure` session cookies** — set `WEB_COOKIE_SECURE=true` behind TLS
- **HMAC-signed session tokens** — rotating `WEB_COOKIE_SECRET` invalidates all sessions

### Payment Security

- **Idempotency tables** — `ProcessedBinanceTx` and `ProcessedTokopayTx` prevent double-confirms even if a webhook fires twice
- **TokoPay webhook signature verification** — every callback is signature-checked before any state change
- **Telegram Login HMAC** — the storefront verifies the widget hash using `BOT_TOKEN` before trusting any login data
- **`auth_date` freshness check** — Telegram Login payloads with a stale timestamp are rejected

### Database

- **No raw SQL** in routes or handlers — all queries go through Prisma CRUD helpers
- **Enum values stored as uppercase strings** — consistent with the original Python schema; never lowercase
- **`$transaction` for all state changes** — prevents partial writes

---

## Performance Considerations

### SQLite Single-Writer

SQLite with WAL mode allows concurrent readers but only one writer at a time. The single-process architecture (via `apps/server`) ensures there is always exactly one `PrismaClient`. If the workload grows beyond what a single writer can handle (e.g., high-concurrency flash sales), migrate to **PostgreSQL** — no application-level changes required, only a `datasource` change in `prisma/schema.prisma`.

### HTMX Partial Updates

The web admin and storefront use HTMX to update only changed DOM fragments (e.g., cart count, order status), avoiding full page reloads for interactive actions.

### Payment Status Polling

Storefront payment pages poll `GET /checkout/:code/status` every ~5 seconds via HTMX. Each poll is a single indexed `Order` lookup by `orderCode` — constant time.

### Rate Limiting

Telegram bot messages are rate-limited per user (`RATE_LIMIT_MAX` / `RATE_LIMIT_WINDOW_SECONDS`). Admin web login attempts are rate-limited by IP. TokoPay webhooks and Telegram Login endpoints should be placed behind a reverse proxy with request-rate limits in production.

### Exchange Rate Caching

The `usd_idr_rate` Setting is updated hourly by a background cron job. Individual requests read the cached DB value — no live FX API calls on the request path.

### Cron Jobs

All scheduled jobs (order expiry, FX refresh, warranty reminders, broadcast drain) are managed by `croner` with `protect: true` — overlapping executions are skipped rather than queued.

---

## Troubleshooting

### `P2022: column does not exist`

Schema was not migrated before deploying new code.

```bash
pnpm exec prisma db push
# Then restart the server
```

### Bot not responding after credentials change

Bot token is read once at startup. After changing `bot_token` in Settings:

1. On Hostinger: `touch tmp/restart.txt` (Passenger restart) or use the panel
2. On Docker: `docker compose restart order-bot`
3. Local: `Ctrl+C` then `pnpm start`

### Storefront shows wrong prices (Rp 1 instead of Rp 16,000)

The USDT → IDR price migration has not been run. See `CUTOVER-IDR.md`:

```bash
pnpm exec prisma db push
pnpm tsx scripts/convert-prices-to-idr.ts <current-usd-idr-rate>
```

### `usd_idr_rate` not updating automatically

Check that `usd_idr_rate_auto` is not set to `false` in Settings. The FX refresh job calls `open.er-api.com` — verify outbound internet connectivity from the server.

### Hostinger app goes idle, bot stops responding

The Passenger process manager shuts down the Node process after inactivity. Add an UptimeRobot (or similar) monitor:

- URL: `https://your-domain.com/healthz`
- Interval: every 1–5 minutes
- Expected: HTTP 200

### Admin panel login loop (session not persisting)

Set `WEB_COOKIE_SECURE=false` for HTTP-only local development. For production behind TLS, set `WEB_COOKIE_SECURE=true` and ensure the reverse proxy passes the correct `Host` header.

### TokoPay webhook not confirming orders

1. Verify `tokopay_secret` is saved in Settings → Payments
2. Check that the webhook URL (`POST /pay/tokopay/callback`) is publicly accessible
3. Check that TokoPay merchant status is active (KYB approved)
4. Review `AuditLog` for any `tokopay_callback.*` entries
5. Check `ProcessedTokopayTx` table for the transaction reference — if the row exists, the webhook was already processed

### Prisma client out of sync after schema change

```bash
pnpm prisma:generate
```

If running Docker, rebuild the image:

```bash
docker compose build
```

---

## Contributing

1. Fork the repository and create a feature branch
2. Follow the conventions in `CLAUDE.md`:
   - Decimal for all money (`@app/core/money`), never `float`
   - No raw SQL — add helpers to `packages/db/src/crud/*` with Vitest tests
   - UTC in DB, `TIMEZONE` on display
   - Audit every state change with `logAdminAction`
   - Never send Telegram from web routes — enqueue to `notification_outbox`
   - Never log secrets (tokens, payment proof `file_id`, password hashes)
3. Add tests for any new behavior:
   - CRUD helpers → `packages/db/src/crud/*.test.ts`
   - Web routes → happy / auth-fail / bad-CSRF test trio
4. Run `pnpm -r typecheck && pnpm test` — both must pass
5. Submit a pull request with a clear description of the change

---

## License

License information is not included in this repository. Contact the maintainer for terms of use.

---

## Project Documentation

| File | Purpose |
|---|---|
| `CLAUDE.md` | Coding conventions, guardrails, and architectural decisions |
| `DEPLOY-HOSTINGER.md` | Step-by-step Hostinger Node.js App Manager deployment runbook |
| `CUTOVER-IDR.md` | One-time USDT → IDR catalog price migration guide |
| `WEBSITE JUALAN/plan.md` | Storefront architecture decisions and feature roadmap |
| `WEBSITE JUALAN/design.md` | UI/UX design specifications for the storefront |
