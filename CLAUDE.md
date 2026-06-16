# CLAUDE.md — conventions for `telegram-order-bot` (Node/TS monorepo)

Workspaces: `apps/order-bot` (grammY), `apps/web-admin` (Fastify+Nunjucks+HTMX),
`apps/notifier`, `packages/core`, `packages/db` (Prisma over shared SQLite
`data/bot.db`). See `feedback.md` for the live backlog and `WEB.md`/`RUN.md` for
roadmap and deploy.

## Money, data, audit
- **Decimal for all money** (`@app/core/money`), never `float`. Web has a `money`
  Nunjucks filter; bot uses `formatPrice`.
- **No raw SQL in routes/handlers** — add helpers to `packages/db/src/crud/*`
  (per-domain split) and cover them with Vitest.
- **UTC in DB, `TIMEZONE` on display** (web `localdt` filter; bot `localize`).
- **Audit every state change** with the acting admin id (`logAdminAction`).
- **Shared SQLite is single-writer** — keep each `$transaction` short; the trigger
  to move to Postgres is ≥2 concurrent writers (RUN.md §9).
- **Schema change on deploy**: migrate the live DB (`pnpm prisma db push` or apply
  the migration) and restart order-bot **before** new code runs, or you get
  `P2022 column … does not exist`.

## Never do
- **Never send Telegram from the web** — enqueue to `notification_outbox`; the
  notifier/bot delivers.
- **Never log secrets** — credentials, payment-proof `file_id`, password hashes,
  full DB URLs. The bulk/CSV paths are the next risk surface.
- **Settings edits are whitelist-only** (web) — the main "don't brick the bot"
  guardrail.

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

## Web admin (Fastify)
- **CSRF**: every mutating route uses the `csrfProtect` preHandler; reads use
  `currentAdmin`. New routes get the happy/auth-fail/bad-csrf test trio.
- Bind `127.0.0.1` by default; public exposure needs reverse proxy + TLS + a
  stronger auth review (RBAC/2FA — see `feedback.md §4.3/§4.4`).

## Tests
- `pnpm -r typecheck` and `pnpm test` must stay green. Add tests with each
  behavior change; prefer crud-level unit tests for logic (e.g. `productRating`,
  `matchByAmount`).
