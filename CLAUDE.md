# CLAUDE.md — conventions for `telegram-order-bot` (Node/TS monorepo)

Workspaces (pnpm: `apps/*` + `packages/*`): `apps/order-bot` (grammY),
`apps/web-admin` (Fastify+Nunjucks+HTMX admin panel), `apps/storefront`
(Fastify+Nunjucks+HTMX customer shop), `apps/server` (**composition root** — one
process, one `PrismaClient`, `apps/server/src/index.ts`), `packages/core` (config
zod, money Decimal, datetime luxon, i18n, password, mailer, fx), `packages/db`
(Prisma + `crud/*`), `packages/outbox-dispatcher` (drains `notification_outbox`
→ Telegram; run in-process by `apps/server`), `packages/web-ui` (shared Nunjucks
theme `_theme.njk`/`_macros.njk`
included by admin & storefront). All share **one SQLite DB** `data/bot.db` (WAL);
schema at `prisma/schema.prisma` (datasource `DATABASE_URL_PRISMA`). See `DOCS.md`
(architecture/features), `README.md` (VPS install), and `docs/` for audit reports.

## Money, data, audit
- **Decimal for all money** (`@app/core/money`), never `float`. Web has a `money`
  Nunjucks filter; bot uses `formatPrice`.
- **No raw SQL in routes/handlers** — add helpers to `packages/db/src/crud/*`
  (per-domain split, e.g. `orders.ts`, `stock.ts`, `pricing.ts`, `vouchers.ts`)
  and cover them with Vitest (`*.test.ts` colocated in `crud/`).
- **UTC in DB, `TIMEZONE` on display** (web `localdt` filter; bot `localize`).
- **Audit every state change** with the acting admin id (`logAdminAction`).
- **Shared SQLite is single-writer** — keep each `$transaction` short, and
  stagger writer crons to different seconds within the minute (see
  `apps/order-bot/src/jobs/index.ts`) so two jobs don't collide on the same
  tick and wait out the busy_timeout; the trigger to move to Postgres is ≥2
  concurrent writers.
- **Schema change on deploy**: migrate the live DB (`pnpm prisma db push` or apply
  the migration) and restart order-bot **before** new code runs, or you get
  `P2022 column … does not exist`.
- **Price a SKU through one place only** — `effectiveUnitPrice` (`@app/core/flash`)
  and `bulkDiscountFor` (`@app/core/bulk`) are the sole source of truth for
  discounts; every price-computing surface (storefront pages/cart/checkout, bot
  confirmation, `createOrder*`) must call them directly, never re-derive a
  discount locally — a drifted copy is how the storefront once quoted Rp20.000
  and charged Rp30.000 (`docs/audit-matematika-2026-07-20.md`). Flash and bulk
  discounts stack; reseller price and flash price don't — a reseller always
  pays `min(resellerPrice, flashPrice)`, never both.
- **Wallet credit at checkout is all-or-nothing** — a currency's credit only
  applies when it fully covers the order (total → zero); never leave a
  partial-remainder state no payment gateway can collect.
- **Denominations declare a `deliveryType`** (`auto` / `manual` /
  `manual_with_info`, `@app/core/enums`) — manual flows route through
  `Order.PROCESSING` and the admin's Awaiting Fulfillment queue
  (`fulfillManualOrder`) instead of instant stock fulfillment. Every
  payment-confirmation call site (all payment rails) must settle through
  `settlePaidOrder`, which branches on this — don't fulfill directly from a
  new call site or it'll skip manual orders.

## Never do
- **Never send Telegram from the web** (admin or storefront) — enqueue to
  `notification_outbox`; the notifier/bot delivers.
- **Never log secrets** — credentials, payment-proof `file_id`, password hashes,
  full DB URLs. The bulk/CSV paths are the next risk surface.

## Logging
- **Audit log (`logAdminAction`) is read by shop admins, not developers** —
  write `details` as a short natural-language sentence (e.g. `"Added 150
  items; skipped 2 invalid lines and 1 duplicate."`), never `key=value`
  shorthand. Full convention + examples: `docs/LOGGING.md`.
- **Pino logs (`packages/core/src/logger.ts`) are for developers/ops** —
  keep them in English, but write full sentences: state what happened, give
  enough context to understand significance without reading the
  surrounding code, and for warn/error explain why it matters or what's
  next. Spell out internal abbreviations (no bare `cb`/`cmd`/`idx`/`tx`).
- Never interpolate a truncated/sliced id or name list into a log
  string — summarize by count instead (e.g. `"12 products"`, not a clipped
  id dump).
- Structured metadata (the object arg to `logger.info({ err, id }, "msg")`)
  is untouched by this convention — only the leading message string
  follows it.

## Bot UX (grammY)
- **Edit the bubble, don't just toast.** Every terminal button tap ends on
  `smartEdit` (customer) / `adminEdit` (admin) + a navigation keyboard, turning
  the screen it lived on into a confirmation. Both helpers edit text *and*
  photo+caption bubbles, and fall back to a fresh send when an edit isn't
  possible. Never leave a stale screen behind.
- **One active keyboard per chat.** Every render helper retires the previous
  bubble's inline keyboard (`retireKeyboard`) when a new screen appears
  elsewhere, so stale menus can't be tapped against moved-on state. Unknown /
  pre-migration callback data answers with the `error.stale_screen` toast.
- **Wizards are single-bubble.** Multi-step flows edit one anchor bubble
  (`adminAnchor`/`menuAnchor` for typed-input steps) and delete the user's
  typed input (`consumeInput`) once captured — prompts, validation errors and
  the final confirmation all land in the same bubble, each with a live
  Cancel/Back keyboard. Customer free-text with record value (support text,
  review comments, TxIDs) and photos whose `file_id` is stored are NOT deleted.
- **Toast vs alert:** routine success → non-blocking toast
  (`answerCallbackQuery({ text })`); errors / destructive confirms →
  `show_alert: true`. Slow terminal mutations render a buttonless
  `admin.processing` state first so a double-tap can't re-run them.
- **Never strand the user:** every terminal screen offers ≥1 forward action
  (Menu / My Orders / Back).
- **No leaked English:** customer- and admin-facing strings go through
  `t(ctx, key, args)` against `packages/core/locales/{en,id}.json`. Keep both
  files' key sets identical (and `{placeholders}` matched per key).
- **Custom emoji:** outgoing HTML text/captions optionally route through the
  `custom_emoji_map` Settings-driven transformer (`@app/core/customEmoji`),
  which wraps mapped unicode emoji in `<tg-emoji>`. Write new bot strings
  with plain unicode emoji and let the transformer handle mapping — never
  hand-wrap `<tg-emoji>` yourself. It skips text inside `<pre>`/`<code>` and
  inline-keyboard labels, where entities aren't allowed.

## Web (Fastify — admin & storefront)
- Both `apps/web-admin` and `apps/storefront` are Fastify+Nunjucks+HTMX and share
  the `packages/web-ui` theme. Routes live in `<app>/src/routes/*`.
- **CSRF**: every mutating route uses the `csrfProtect` preHandler; admin reads use
  `currentAdmin`. New routes get the happy/auth-fail/bad-csrf test trio. `csrfCheck`
  also accepts the token via an `X-CSRF-Token` header (alongside the existing
  `csrf_token` form field) — the bridge the `apps/web-admin/client` React pages use.
- **`apps/web-admin`'s dashboard (`GET /`) is a built React SPA**, not Nunjucks —
  run `pnpm --filter @app/web-admin-client build` once after a fresh clone (and
  again after editing anything under `apps/web-admin/client/`) before `pnpm test`
  or `pnpm dev:web` will serve it correctly; the build output
  (`apps/web-admin/static/dashboard-app/`) is gitignored, same as a generated
  Prisma client — a required one-time step, not optional.
- **The storefront is a built React SPA** (`apps/storefront/client`) backed by
  the JSON API under `/api/v1` — same pattern/build contract as web-admin: run
  `pnpm --filter @app/storefront-client build` once after a fresh clone (and
  again after editing anything under `apps/storefront/client/`) before
  `pnpm test` or `pnpm dev:store` will serve it correctly; the build output
  (`apps/storefront/static/shop-app/`) is gitignored. Nunjucks + `_theme.njk`
  survive only for `error.njk` (must render before/without the SPA build,
  e.g. a DB-down 500) — `setup_pending.njk` is a standalone HTML page (no theme,
  no htmx), served before the SPA is built. Migration history in
  `docs/REACT_STOREFRONT_MIGRATION.md`.
- **Settings edits are whitelist-only** (admin) — the main "don't brick the bot"
  guardrail; never widen the whitelist without review.
- Bind `127.0.0.1` by default; public exposure needs reverse proxy + TLS + a
  stronger auth review (RBAC/2FA). Storefront is the public surface — treat its
  auth (`apps/storefront/src/auth.ts`) and forgot-password flow as untrusted input.
- **Product/branding photo uploads generate WebP srcset variants on upload**
  (`apps/web-admin/src/lib/webpVariants.ts`) and the storefront serves those
  variants — don't assume the on-disk original format when adding a new image
  surface; `pnpm images:backfill` regenerates variants for pre-existing photos.

## Fast, efficient monorepo workflow
- **Scope commands to the workspace you're touching while iterating** — use
  `pnpm --filter <name> dev|typecheck|build` (every workspace has these
  scripts) instead of the repo-wide `pnpm -r ...` / root `pnpm typecheck` /
  `pnpm build`, which walk all 8 workspaces plus both SPA client packages on
  every run. Still run the full `pnpm typecheck` and `pnpm test` before
  considering a change done — see `## Tests` below, this doesn't relax that.
- **Scope test runs while iterating** — `pnpm vitest run <path>` (or watch
  mode `pnpm vitest <pattern>`) against the file/dir you're changing, not the
  full `pnpm test`. The root `vitest.config.ts` is one shared config, so an
  unscoped run always spins up both React SPA suites under jsdom too.
- **Only rebuild the SPA client you touched** — `@app/web-admin-client` and
  `@app/storefront-client` (Vite builds) are the slow step in `pnpm build`.
  Build just the one you edited (`pnpm --filter @app/web-admin-client build`
  / `pnpm --filter @app/storefront-client build`); don't rebuild both, and
  don't rebuild either on unrelated backend changes. (See `## Web` above for
  *when* a build is required at all.)
- **Only regenerate the Prisma client after a schema change** — `pnpm
  prisma:generate` writes a gitignored generated client; running it on
  unrelated edits is wasted work.
- **Don't run the dev server and one-off scripts (backfill/reconcile/probe)
  against `data/bot.db` at the same time** — the shared SQLite is
  single-writer (see above); concurrent WAL writers serialize and slow each
  other down instead of parallelizing.
- **Don't delete `node_modules` or the pnpm store to "fix" install issues** —
  pnpm's content-addressed store already makes installs incremental. Prefer
  `pnpm install --frozen-lockfile` for a fast, reproducible install (e.g. to
  verify CI-like state) over a full `pnpm install` that may rewrite the
  lockfile.

## Tests
- `pnpm typecheck` (runs `pnpm -r typecheck` + `tsc -p tsconfig.test.json`) and
  `pnpm test` (`vitest run`) must stay green. Add tests with each behavior change;
  prefer crud-level unit tests for logic (e.g. `productRating`, `matchByAmount`).
