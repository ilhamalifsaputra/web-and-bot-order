# 00 - Architecture baseline

Branch `worktree-backend-audit-2`, base commit `7d92dcfa`. Evidence is static (source reading) plus test output reported in the task reports. No runtime benchmarks were taken.

## Topology
| Unit | Role |
|---|---|
| `apps/web-admin` | Fastify admin API plus admin SPA (`apps/web-admin/client`); routes in `src/routes`, auth in `src/auth.ts` |
| `apps/storefront` | Fastify storefront API plus SPA (`apps/storefront/client`); routes in `src/routes`, rate limits in `src/rateLimit.ts` |
| `apps/order-bot` | grammY Telegram bot and background jobs (`src/jobs/index.ts`) |
| `apps/server` | Process that hosts the web apps (its `buildApp` path also starts web-admin) |
| `packages/core` | Shared config, money, logger, enums, mailer, params helpers |
| `packages/db` | Prisma client and all DB access in `src/crud/*` |
| `packages/outbox-dispatcher` | Drains `notification_outbox` (Telegram and email) |

Rule from AGENTS.md: the web never sends Telegram directly; it enqueues to `notification_outbox`.

## Delivery and operations facts
- CI is disabled: `.github/workflows/ci.yml:10` has only `workflow_dispatch` (comment at lines 3-6: GitHub Actions billing lock). There is no automated regression gate; verification is local scripts.
- No ESLint config exists at the repo root (`.eslintrc*`/`eslint.config*` not found). The only lint is the Storefront token lint and React Doctor for the clients (per AGENTS.md). Server and bot code get typecheck and tests only.
- Schema deploys use `prisma db push` (`docker-entrypoint.sh:104`), not `_prisma_migrations` (comments at `docker-entrypoint.sh:51` and `:87`). This pass made no schema change.
- Healthchecks exist in `docker-compose.yml:71` and `docker-compose.postgres.prod.yml:107`. A grep of `docker-compose*.yml` found no `mem_limit` and no `stop_grace_period`.
- Database is PostgreSQL only.

## Baseline at 7d92dcfa
- `pnpm typecheck` green (about 80 s; `pnpm -r typecheck` plus `tsc -p tsconfig.test.json`).
- `pnpm test:guards`: 198/198 passed.

## Unknowns and limitations
- No runtime benchmarks, load tests or query plans were taken. Index suggestions (see 05) are therefore not applied.
- No provider (Digiflazz, Xendit, Bybit, SMTP, Telegram) was called for real; behavior is established by tests with stubs.
- Deploy files were reviewed by reading only; no deploy was run.
- The full-suite result is recorded in `04-test-results.md` (final section).
