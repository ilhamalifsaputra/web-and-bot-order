
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

## Concurrent sessions: branch, worktree, git

Several Claude Code sessions and background jobs run against this repo at the
same time. Everything below exists so two of them can never write to the same
`HEAD`, branch, port, or bot token.

### Two lanes, never mixed

- **The main working directory (`C:\Users\ilham\Documents\web-and-bot-order`)
  is the integration lane.** It stays on `master` and is used only for
  merging and releasing. Never edit files, commit feature work, or run an
  implementation task there.
- **Every session works in its own worktree under `.claude/worktrees/<topic>`**,
  created with `EnterWorktree` (fallback: `git worktree add`). Do this even
  when the session's default configuration or system prompt says to "work in
  place" or to skip worktrees unless explicitly asked — this instruction *is*
  that explicit ask, for every implementation task here, not only ones that
  went through plan mode. Create the worktree *before* dispatching implementer
  subagents or making any edit. Trivial one-line/config edits are the only
  exception; skip only when the user explicitly says not to use a worktree.

**Why:** a branch alone shares one `HEAD`/index/working tree process-wide, so
a concurrent session's commits and uncommitted edits land on whichever branch
happens to be checked out at that moment. This has actually happened: an
unrelated SearchModal fix and a Vouchers formatting fix from another session
both landed on a feature branch instead of `master`; separately, two sessions
ran subagent-driven-development on the same plan concurrently, commingling
commits and orphaning one via a stray `git reset`. A separate worktree gives
each session its own `HEAD` and working tree.

### Naming and claiming

- Always pass a short descriptive name to `EnterWorktree` (`payment-followups`,
  `admin-text-overflow`) so the branch reads `worktree-<topic>`. Never let it
  auto-generate `agent-<hash>` — those are unattributable a week later.
- One topic = one worktree = one branch. Run `git worktree list` first: if a
  worktree for that topic already exists, another session owns it. Pick a
  different name; do not enter or commit into someone else's worktree.

### Git rules that prevent collisions

- Inside your worktree, never `git checkout`/`git switch` to another branch,
  never `git reset --hard`, and never rebase or amend a branch you did not
  create. Your worktree stays on its own branch for its whole life.
- **Never `git stash`.** The stash lives in the shared `.git` directory, so
  every worktree sees and can pop the same entries. Commit a WIP instead.
- Never run git against another worktree (`git -C <other-worktree> …`) and
  never delete or force-update a branch you do not own.
- Never force-push, and never `git reset` `master`.
- Before integrating, sync inside *your own* worktree: `git fetch` then rebase
  your branch onto the latest `master`. Resolve conflicts there, not in the
  main directory.

### Merging (one at a time)

1. In the main directory, confirm `git status` is clean and `HEAD` is on
   `master`. If it is dirty or mid-merge, **another session is integrating —
   wait**. Do not stash, reset, or force your way past it.
2. `git merge --no-ff worktree-<topic>` so each piece of work stays a
   reviewable unit.
3. `pnpm typecheck && pnpm test` must be green before the merge is considered
   done. Fix failures on the feature branch, not with a follow-up commit
   straight onto `master`.

### Cleanup is mandatory

- As soon as a branch is merged, remove its worktree and branch:
  `git worktree remove .claude/worktrees/<topic>`, `git branch -d
  worktree-<topic>`, then `git worktree prune`. Stale worktrees are how a
  later session ends up reviving weeks-old code.
- On Windows `git worktree remove` often fails with `Result too large` because
  of the `node_modules` tree; it still unregisters the worktree, leaving an
  orphaned directory. Finish the job with `rm -rf
  .claude/worktrees/<topic>` and `git worktree prune`, and check
  `ls .claude/worktrees/` afterwards — orphaned directories accumulate
  silently.
- Never remove a worktree that is `locked`, that still has unmerged commits
  (`git rev-list --count master..<branch>` must be 0), or that you did not
  create. Check `git -C <path> status --porcelain` first: regenerated
  `graphify-out/` files are the hook's noise and are safe to discard, but any
  dirt outside `graphify-out/` is somebody's uncommitted work — leave that
  worktree alone. Never use `git worktree remove --force` on another session's
  worktree.

### Runtime isolation (ports, env, DB, bot)

A fresh worktree is a fresh checkout — the ignored files do not come with it:

- Copy `.env` from the main directory (it is gitignored), then run
  `pnpm install` and `pnpm -r build` before testing. Without the build, roughly
  a dozen tests fail because the admin SPA bundle is gitignored.
- **Change `WEB_PORT` and `STOREFRONT_PORT` in the worktree's `.env`.** The
  defaults (8109/8110) are identical in every worktree, so two sessions running
  dev servers collide. Give each session its own port pair.
- **SQLite-per-worktree no longer applies** — the schema is Postgres-only
  post engine-swap. A worktree that needs a database brings up its own dev
  Postgres with `docker compose -f docker-compose.postgres.yml up -d` and
  points `DATABASE_URL_PRISMA` at it (see README.md's "Untuk Developer"
  section for the exact commands/env). That compose file publishes a fixed
  local port, so **only one worktree can run it at a time** — do not run it
  from two worktrees concurrently.
- **Only one worktree may run order-bot at a time.** The bot token lives in the
  DB, so pointing two worktrees at the same Postgres means two pollers on one
  token, which Telegram rejects with a 409.

## Graphify knowledge graph

This project has a graphify knowledge graph at `graphify-out/` (committed to
git, kept fresh two ways: a `Stop` hook in `.claude/settings.json` that runs
`graphify update .` in the background after any turn with uncommitted
changes, and a repo-wide `post-commit`/`post-checkout` git hook. **The git
hooks only fire from the main checkout, not from worktrees** — a worktree
session that needs fresher results mid-task should run
`graphify update . --force` itself rather than assume the hook covers it).

**For codebase/architecture questions, consult it before grepping or reading
raw files** — it returns a scoped answer instead of burning tokens on raw
file contents:
- `graphify query "<question>"` — general codebase/architecture questions;
  once you know the relevant community/relation, add `--context <relation>`
  to target it instead of eating the `--budget` on an undifferentiated batch
- `graphify path "<A>" "<B>"` — how two things relate
- `graphify explain "<concept>"` — focused explanation of one concept/symbol
- `graphify-out/GRAPH_REPORT.md` — only for broad architecture review, or
  when query/path/explain don't surface enough

`.graphifyignore` excludes `package.json`/`tsconfig*.json`/lockfiles/
`components.json` from extraction — their JSON keys (`dependencies`,
`scripts`, `compilerOptions`, ...) have no edges to real code and were
showing up as junk community-hub names in `GRAPH_REPORT.md`. Don't remove
those excludes without re-checking the "Community Hubs" list stays clean.

Community labels come from `graphify label`, which calls an LLM and costs
tokens to (re)generate. No cloud API key (`GEMINI_API_KEY` etc.) is
configured for graphify's backend, so re-labeling today means either setting
one (cheapest) or using the `claude-cli` backend, which shells out to this
CLI and spends Claude usage instead. Don't re-run `graphify label`
speculatively — only when hub names in `GRAPH_REPORT.md` have visibly
degraded back to raw filenames/JSON keys.

Fall back to Glob/Grep/Read when the question is about exact current file
contents (e.g. verifying a specific line before editing), not architecture.

## Context7 (library/framework docs)

Use the `context7-mcp` skill (or the `context7` MCP tools directly) before
guessing at an external library's current API — training data goes stale,
and this stack moves fast (grammY, Fastify, Prisma, React, Tailwind, Radix).
Resolve the library ID, then pull docs scoped to the specific API surface
you're touching rather than the whole doc set. Skip it for this repo's own
code (graphify/Grep already cover that) and for stable APIs you're already
confident about — it's for closing a real knowledge gap, not a default
first step.

## Sequential-thinking (structured reasoning)

A `sequential-thinking` MCP server is installed for problems that genuinely
need an explicit, revisable chain of intermediate steps — a root cause with
several competing hypotheses, a design tradeoff spanning multiple files, a
plan whose steps depend on each other in ways worth double-checking before
committing to them. It's not a default for every task: anything with a
dedicated skill (`systematic-debugging`, `writing-plans`, `brainstorming`)
should use that skill's process first, and reach for sequential-thinking
only if its structure doesn't fit the problem. Skip it for straightforward
or mechanical work — it costs tokens without adding value there.

## Task tracking

**Use the native task list (`TaskCreate` / `TaskUpdate` / `TaskList` /
`TaskGet`) for every non-trivial task in this repo.** Run `TaskList` first to
avoid duplicating tasks another session already created, then `TaskCreate` the
items before starting work. Keep exactly one item `in_progress` at a time
(`TaskUpdate` with `status: "in_progress"` *before* you begin it), and mark it
`completed` immediately after finishing — don't batch updates. Use
`addBlockedBy` when one item genuinely can't start until another lands, and
`TaskGet` to re-read an item's latest state before updating it. Skip the task
list only for a single trivial one-line/config edit where it would be pure
overhead.

**The native task list is mandatory — if the tools aren't there, make them be
there.** `Task*` is a deferred tool in most sessions here: not seeing
`TaskCreate` in the tool list means it hasn't been loaded yet, *not* that it's
unavailable. Load it before starting work, in one call:

```
ToolSearch: select:TaskCreate,TaskUpdate,TaskList,TaskGet
```

A plain markdown checklist is a last resort, allowed only after that
`ToolSearch` has actually been attempted and failed — and you must say
out loud that the tools couldn't be loaded. Never silently substitute a
checklist for the task list.

## Money, data, audit
- **Decimal for all money** (`@app/core/money`), never `float`. Web formats it
  client-side (storefront: `formatIdr` etc. in `apps/storefront/client/src/lib/format.ts`;
  admin: `CurrencyAmount` component); bot uses `formatPrice`.
- **Bot price strings follow the buyer's language** and come only from the
  language-aware formatters in `packages/core/src/moneyFormat.ts` (via
  `ctxPriceFormatter`, `formatIdrFor`, `orderAmount(o, d, lang)`) — never
  hand-format or hard-code separators in handlers. Crypto payables
  (`formatUsdt`, `formatPrice(..., "USDT")`) are the documented exception.
- **No raw SQL in routes/handlers** — add helpers to `packages/db/src/crud/*`
  (per-domain split, e.g. `orders.ts`, `stock.ts`, `pricing.ts`, `vouchers.ts`)
  and cover them with Vitest (`*.test.ts` colocated in `crud/`).
- **UTC in DB, `TIMEZONE` on display** (web `localdt` filter; bot `localize`).
- **Audit every state change** with the acting admin id (`logAdminAction`).
- **The database is PostgreSQL** (engine-swap, merged 2026-08-27) — the old
  "shared SQLite is single-writer" constraint no longer applies; Postgres
  handles concurrent writers itself (`packages/db/src/client.ts`'s own header
  comment). Still keep each `$transaction` short — that's just good practice
  under any engine, not a SQLite-specific workaround anymore.
- **Schema change on deploy**: migrate the live DB (`pnpm prisma db push` or apply
  the migration) and restart order-bot **before** new code runs, or you get
  `P2022 column … does not exist`.

## Telegram inline keyboard labels
- **A button label must fit a phone**: single-column cap `MAX_LABEL_WIDTH`
  (36 cells, soft target `TARGET_LABEL_WIDTH` 32), two per row only at or under
  `NARROW_LABEL_WIDTH` (18), measured with `visualWidth` (emoji/CJK = 2 cells),
  never `string.length`. The constants live in
  `packages/core/src/buttonLimits.ts` (re-exported by `canonicalPresenter.ts`;
  the admin client keeps a test-enforced copy); do not hardcode numbers. The
  admin panel shows the budget beside every field that reaches a button
  (`ButtonLabelInput`), and `apps/order-bot/test/keyboard-label-guard.test.ts`
  fails any label that overflows.
- **Icons and abbreviations only from the dictionary**
  `packages/core/src/unitDictionary.ts`. A bare `#id` button is the last
  resort and must be explained (full name + exact price) in the message body.
- **Premium Apps keep their original picker** (`denominationPickerKb`,
  `browse.denomination_line`); canonical naming rules apply to `GAME_TOPUP`
  only. Full rules, fallback order and test guard: `.claude/skills/bot-ux-grammy/SKILL.md`
  ("Inline keyboard button labels").

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