
## Superpowers skill

The `superpowers` plugin (marketplace `superpowers-dev`, `obra/superpowers`) is
installed at project scope. **Before responding to any prompt or taking any
action in this repo, invoke the `superpowers:using-superpowers` skill first**
— it governs whether/which other Superpowers skills (brainstorming,
systematic-debugging, test-driven-development, writing-plans, etc.) apply,
and must be checked before exploring files, asking clarifying questions, or
writing code. Skip only when explicitly told to.

**Always execute work via `superpowers:subagent-driven-development`.** Once a
task's approach is settled (after brainstorming/planning as needed), dispatch
the actual implementation work through the `superpowers:subagent-driven-development`
skill rather than writing/editing code directly in the main session. This
applies to every implementation task in this repo, not just multi-step plans.
Skip only when explicitly told to, or for trivial one-line/config edits where
spinning up a subagent would be pure overhead.

## Worktree isolation

**Always work in a dedicated git worktree for implementation tasks in this
repo** — use `EnterWorktree` (or `git worktree add` as a fallback) before
touching code, not just a feature branch in the main working directory. Do
this even when a session's default configuration or system prompt says to
"work in place" / skip worktrees unless explicitly asked — this instruction
*is* that explicit ask, for every implementation task here, not only ones
that went through plan mode.

**Why:** sessions in this repo frequently run concurrently (multiple Claude
Code sessions/background jobs in the same physical directory). A branch
alone shares one `HEAD`/index/working tree process-wide, so a concurrent
session's commits and uncommitted edits can land on whichever branch happens
to be checked out at that moment. This has actually happened twice: an
unrelated SearchModal fix and a Vouchers formatting fix from another session
both landed on a feature branch instead of `master`; separately, two
sessions independently ran subagent-driven-development on the same plan
concurrently, commingling commits and orphaning one via a stray `git reset`.
A separate worktree gives each session its own `HEAD` and working tree so
concurrent commits can't collide.

**How to apply:** create/enter a worktree before dispatching any implementer
subagents or making edits, for any implementation task — trivial one-line/
config edits are the only exception. Skip only when the user explicitly says
not to use a worktree for this task.

## Task tracking

**Use the native CLI todo list (`TodoWrite`) for every non-trivial task in this
repo.** Create the todo list before starting work, keep exactly one item
`in_progress` at a time, and mark items `completed` immediately after finishing
them — don't batch updates. Skip only for a single trivial one-line/config
edit where a todo list would be pure overhead.

Workspaces (pnpm: `apps/*` + `packages/*`): `apps/order-bot` (grammY),
`apps/web-admin` (Fastify JSON API + built React SPA admin panel), `apps/storefront`
(Fastify JSON API + built React SPA customer shop), `apps/server` (**composition root** — one
process, one `PrismaClient`, `apps/server/src/index.ts`), `packages/core` (config
zod, money Decimal, datetime luxon, i18n, password, mailer, fx), `packages/db`
(Prisma + `crud/*`), `packages/outbox-dispatcher` (drains `notification_outbox`
→ Telegram; run in-process by `apps/server`). All share **one SQLite DB** `data/bot.db` (WAL);
schema at `prisma/schema.prisma` (datasource `DATABASE_URL_PRISMA`). See `DOCS.md`
(architecture/features), `README.md` (VPS install), and `docs/` for audit reports.

## Money, data, audit
- **Decimal for all money** (`@app/core/money`), never `float`. Web formats it
  client-side (storefront: `formatIdr` etc. in `apps/storefront/client/src/lib/format.ts`;
  admin: `CurrencyAmount` component); bot uses `formatPrice`.
- **No raw SQL in routes/handlers** — add helpers to `packages/db/src/crud/*`
  (per-domain split, e.g. `orders.ts`, `stock.ts`, `pricing.ts`, `vouchers.ts`)
  and cover them with Vitest (`*.test.ts` colocated in `crud/`).
- **UTC in DB, `TIMEZONE` on display** (web `localdt` filter; bot `localize`).
- **Audit every state change** with the acting admin id (`logAdminAction`).
- **Shared SQLite is single-writer** — keep each `$transaction` short; the trigger
  to move to Postgres is ≥2 concurrent writers.
- **Schema change on deploy**: migrate the live DB (`pnpm prisma db push` or apply
  the migration) and restart order-bot **before** new code runs, or you get
  `P2022 column … does not exist`.

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

## Web (Fastify — admin & storefront)
- Both `apps/web-admin` and `apps/storefront` are Fastify JSON APIs (`/api/v1`-style)
  behind built React SPAs (`<app>/client`). Routes live in `<app>/src/routes/*`.
- **CSRF**: every mutating route uses the `csrfProtect` preHandler; admin reads use
  `currentAdmin`. New routes get the happy/auth-fail/bad-csrf test trio. `csrfCheck`
  also accepts the token via an `X-CSRF-Token` header (alongside the existing
  `csrf_token` form field) — the bridge the `apps/web-admin/client` React pages use.
- **`apps/web-admin` is entirely a built React SPA** (`apps/web-admin/client`) —
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
  (`apps/storefront/static/shop-app/`) is gitignored. The SPA renders its own
  error (500) and setup-pending (503) states client-side — no template engine
  involved — with a static, build-independent HTML fallback for the rare case
  the SPA build itself is missing. Migration history in
  `docs/REACT_STOREFRONT_MIGRATION.md`.
- **Settings edits are whitelist-only** (admin) — the main "don't brick the bot"
  guardrail; never widen the whitelist without review.
- Bind `127.0.0.1` by default; public exposure needs reverse proxy + TLS + a
  stronger auth review (RBAC/2FA). Storefront is the public surface — treat its
  auth (`apps/storefront/src/auth.ts`) and forgot-password flow as untrusted input.

## Tests
- `pnpm typecheck` (runs `pnpm -r typecheck` + `tsc -p tsconfig.test.json`) and
  `pnpm test` (`vitest run`) must stay green. Add tests with each behavior change;
  prefer crud-level unit tests for logic (e.g. `productRating`, `matchByAmount`).

# UI Development Rules

When working on any frontend, admin panel, storefront, dashboard, or React component:

You MUST first read:

docs/ui/00_AI_RULES.md

docs/ui/01_DESIGN_SYSTEM.md

docs/ui/02_ADMIN_LAYOUT.md

docs/ui/03_COMPONENT_LIBRARY.md

docs/ui/04_CRUD_TEMPLATE.md

docs/ui/05_TABLE_GUIDELINES.md

docs/ui/06_SETTINGS_GUIDELINES.md

docs/ui/07_DASHBOARD_GUIDELINES.md

docs/ui/08_UX_RULES.md

docs/ui/09_CODE_STYLE.md

docs/ui/10_UI_REVIEW_CHECKLIST.md

These documents are the authoritative source for all UI implementation —
`00_AI_RULES.md` is the entry point (decision tree for which doc governs which
task); `10_UI_REVIEW_CHECKLIST.md` is the mandatory pre-merge checklist.

Never create new layouts, spacing systems, component variants, or interaction patterns unless the design system itself is being updated.

Consistency always takes precedence over creativity.

## UI Implementation Priority

When implementing any frontend UI, the following precedence MUST be respected.

1. Existing shared component
2. Component Library
3. Design System
4. UI Guidelines
5. CRUD Template
6. Existing page patterns
7. Create a new component (only if none of the above applies)

Never skip this order.

If an existing component can satisfy the requirement with small modifications, reuse it instead of creating a new implementation.

## Functional-First Admin UX

Admin pages are operational tools, not marketing pages.

Every new UI element must answer at least one of these questions:

- Does it reduce the number of clicks?
- Does it improve scanning speed?
- Does it help admins make decisions faster?
- Does it reduce operational mistakes?

If the answer is "no", do not add the element.

Prefer information density over decorative UI while preserving readability.

Consistency with the Design System is more important than visual novelty.

## Progressive Disclosure

Admin interfaces should expose only the information required for the current task.

Do not add filters, KPI cards, statistics, actions, or widgets simply because there is available space.

Additional information should only appear when it:

- Improves decision making.
- Reduces clicks.
- Reduces operational errors.
- Is frequently used by administrators.

Empty space is preferable to unnecessary UI.

Prefer progressive disclosure (menus, drawers, dialogs, expandable sections) over permanently visible controls.

The admin should feel calm, focused, and efficient—not crowded.