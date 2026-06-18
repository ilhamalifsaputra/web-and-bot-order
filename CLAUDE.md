# CLAUDE.md — conventions for `telegram-order-bot` (Node/TS monorepo)

Workspaces (pnpm: `apps/*` + `packages/*`): `apps/order-bot` (grammY),
`apps/web-admin` (Fastify+Nunjucks+HTMX admin panel), `apps/storefront`
(Fastify+Nunjucks+HTMX customer shop), `apps/notifier` (drains
`notification_outbox`), `apps/server` (**composition root** — one process, one
`PrismaClient`, `apps/server/src/index.ts`), `packages/core` (config zod, money
Decimal, datetime luxon, i18n, password, mailer, fx), `packages/db` (Prisma +
`crud/*`), `packages/web-ui` (shared Nunjucks theme `_theme.njk`/`_macros.njk`
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
- **Shared SQLite is single-writer** — keep each `$transaction` short; the trigger
  to move to Postgres is ≥2 concurrent writers (RUN.md §9).
- **Schema change on deploy**: migrate the live DB (`pnpm prisma db push` or apply
  the migration) and restart order-bot **before** new code runs, or you get
  `P2022 column … does not exist`.

## Never do
- **Never send Telegram from the web** (admin or storefront) — enqueue to
  `notification_outbox`; the notifier/bot delivers.
- **Never log secrets** — credentials, payment-proof `file_id`, password hashes,
  full DB URLs. The bulk/CSV paths are the next risk surface.

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

## Web (Fastify — admin & storefront)
- Both `apps/web-admin` and `apps/storefront` are Fastify+Nunjucks+HTMX and share
  the `packages/web-ui` theme. Routes live in `<app>/src/routes/*`.
- **CSRF**: every mutating route uses the `csrfProtect` preHandler; admin reads use
  `currentAdmin`. New routes get the happy/auth-fail/bad-csrf test trio.
- **Settings edits are whitelist-only** (admin) — the main "don't brick the bot"
  guardrail; never widen the whitelist without review.
- Bind `127.0.0.1` by default; public exposure needs reverse proxy + TLS + a
  stronger auth review (RBAC/2FA). Storefront is the public surface — treat its
  auth (`apps/storefront/src/auth.ts`) and forgot-password flow as untrusted input.

## Tests
- `pnpm typecheck` (runs `pnpm -r typecheck` + `tsc -p tsconfig.test.json`) and
  `pnpm test` (`vitest run`) must stay green. Add tests with each behavior change;
  prefer crud-level unit tests for logic (e.g. `productRating`, `matchByAmount`).
