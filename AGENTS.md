# Agent instructions (Codex and other AGENTS.md readers)

The full project rules live in `.claude/CLAUDE.md`; read it before working
here. This file repeats the parts that decide how fast your test loop is. Keep
the "Tests" section below in sync with the "## Tests" section of
`.claude/CLAUDE.md` — if you change one, change the other.

## Tests

The full suite is ~580 files / ~10,600 tests and takes ~14 minutes. Do not run
it after every fix. Use the cheapest tier that fits:

- **While fixing / per task:** run the file you touched
  (`pnpm exec vitest run <path>`) or `pnpm test:changed` — the tests that
  import anything changed vs `master` (committed, staged or unstaged), plus the
  always-run guard tests in `pnpm test:guards`. Typecheck only the package you
  touched (`pnpm --filter <pkg> typecheck`). `pnpm --filter <pkg> test` runs
  nothing in this repo; use `pnpm exec vitest run <path>` instead.
- **Reviewing someone else's task:** read their `test:changed` output; don't
  rerun the full suite.
- **Once, after syncing with the latest `master` and before merging:**
  `pnpm typecheck && pnpm test` (full). This gate is never skipped.

`test:changed` falls back to the full suite on its own when you change
`prisma/schema.prisma`, `tests/helpers/**`, a `setup-env.ts`, a config file
(`package.json`, `vitest.config.*`, `vite.config.*`), the lockfile, a
`__fixtures__/**` file or the locale JSON (`packages/core/locales/*.json`) —
see `forceRerunTriggers` in `vitest.config.ts`. A new guard test that reads
source files from disk (and so is invisible to Vitest's import graph) must be
added to `test:guards` in the root `package.json`, and must import no database
setup. `test:changed` does not run the `pretest` checks (migration drift,
frontend boundaries, lint, detection purity); the full gate does, so a green
`test:changed` does not mean lint clean.

Database tests build their Postgres schema by copying a template that the
first DB test of a run builds once (`tests/helpers/schemaFromTemplate.ts`), so
a run with no DB test pays nothing for the database.

## Before trusting any test result in a fresh checkout or worktree

1. Copy `.env` from the main checkout (it is gitignored) and give
   `WEB_PORT`/`STOREFRONT_PORT` your own values.
2. `pnpm install`, then `pnpm prisma:generate`, then `pnpm -r build`.
   Without the generated Prisma client, DB tests fail with errors that look
   like schema bugs or "provider sqlite / URL must start with file:"; without
   the build, admin-shell tests fail with ENOENT on `dashboard-app/index.html`.

The suite is known to flake under machine load (timeouts, DB-reset lines).
Re-run a failing file alone before treating it as a regression.
