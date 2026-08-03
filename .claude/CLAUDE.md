
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

## Graphify knowledge graph

This project has a graphify knowledge graph at `graphify-out/` (committed to
git, kept fresh by a `Stop` hook in `.claude/settings.json` that runs
`graphify update .` in the background after any turn with uncommitted
changes — no manual update needed).

**For codebase/architecture questions, consult it before grepping or reading
raw files** — it returns a scoped answer instead of burning tokens on raw
file contents:
- `graphify query "<question>"` — general codebase/architecture questions
- `graphify path "<A>" "<B>"` — how two things relate
- `graphify explain "<concept>"` — focused explanation of one concept/symbol
- `graphify-out/GRAPH_REPORT.md` — only for broad architecture review, or
  when query/path/explain don't surface enough

Fall back to Glob/Grep/Read when the question is about exact current file
contents (e.g. verifying a specific line before editing), not architecture.

## Task tracking

**Use the native CLI todo list (`TodoWrite`) for every non-trivial task in this
repo.** Create the todo list before starting work, keep exactly one item
`in_progress` at a time, and mark items `completed` immediately after finishing
them — don't batch updates. Skip only for a single trivial one-line/config
edit where a todo list would be pure overhead. If `TodoWrite` isn't in the
session's available tool list (e.g. some background-job session types don't
expose it), fall back to a plain markdown checklist and say so — don't
silently substitute one for the other without noting the tool wasn't
available.

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

## Tests
- `pnpm typecheck` (runs `pnpm -r typecheck` + `tsc -p tsconfig.test.json`) and
  `pnpm test` (`vitest run`) must stay green. Add tests with each behavior change;
  prefer crud-level unit tests for logic (e.g. `productRating`, `matchByAmount`).