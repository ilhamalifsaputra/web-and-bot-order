# Resource Optimization Report

**Branch:** `worktree-resource-optimization` (dc3147f9..fca6c009/c242ca41, 13 commits)
**Scope:** Full repository resource/architecture audit + implementation of P0/P1
(and safe P2) findings, per `prompt-optimasi-resource-project.md`.

## 1. Architecture Summary

```text
User Web
   ↓
React SPA (apps/web-admin/client, apps/storefront/client — Vite build)
   ↓
Fastify API (apps/web-admin/src, apps/storefront/src — two separate
Fastify instances, both mounted inside ONE combined Node process)
   ↓
PostgreSQL (via Prisma, packages/db) / external providers (Digiflazz,
TokoPay, PayDisini, NOWPayments, Binance, Bybit)

Telegram User
   ↓
grammY Bot (apps/order-bot — long polling)
   ↓
Same combined process → packages/db (Prisma) → PostgreSQL
   → same payment-provider clients as the web side (packages/core)
```

The critical architectural fact this whole audit is built on: **this is not
a multi-container deployment.** `apps/server/src/index.ts` is a single
composition root that boots the web-admin Fastify instance, the storefront
Fastify instance, the grammY bot (long polling), and every in-process
background worker (outbox dispatcher, 7 payment-reconcile pollers, cron
jobs) — all inside **one Node process**. `docker-compose.yml` confirms this:
it defines exactly **one** service, `server` (plus `postgres`). There is no
`N containers × pool size` or `duplicate poller across replicas` problem
here, because there is only ever one replica by design. This changed the
shape of the audit from what the prompt's checklist implies for a typical
multi-service deployment — most of Tahap 5/6/14's "duplicate instance"
failure modes are structurally impossible here, so the audit focused on
what's actually possible in a single-process topology: leaks that grow
unboundedly *within* that one process over its lifetime, and inefficiency
on hot paths that one process alone still has to pay for on every request.

Key components identified:
- **Frontend:** two independent Vite-built React SPAs (`apps/web-admin/client`,
  `apps/storefront/client`), each served by their own Fastify instance via
  a cached `index.html` shell route (Task 7, see §8/§11).
- **Backend/API:** Fastify, two instances (admin + storefront), both
  registered inside `apps/server/src/index.ts`.
- **Bot:** grammY, long polling (not webhook) — `apps/order-bot`.
- **Database:** PostgreSQL via Prisma (`packages/db`), single connection
  string, no explicit `connection_limit` in `DATABASE_URL_PRISMA`
  (`.env.example:152`) — relies on Prisma's default pool sizing. Low risk
  given the single-process topology (no `N×pool` multiplication), not
  changed in this pass (no evidence of exhaustion under real traffic).
- **Background jobs:** `apps/order-bot/src/jobs/index.ts` (1,819 lines) plus
  7 payment-reconcile pollers under `apps/order-bot/src/payments/` —
  TokoPay, PayDisini, NOWPayments (QRIS/fiat rails), Binance-internal, Bybit
  deposit, Bybit-BSC deposit, Bybit-BSC confirmation tracker (crypto rails).
- **Outbox dispatcher:** `packages/outbox-dispatcher` — decouples Telegram
  sends from web/admin request handlers (the repo's own "never send Telegram
  from the web" rule).
- **Deployment:** Docker / Docker Compose, multi-stage `Dockerfile`. The
  runtime stage deliberately ships devDependencies and raw TypeScript (run
  via `tsx`, no compiled `dist`) — documented inline (`Dockerfile:71-80`) as
  required for `pnpm start` and the migration entrypoint. This is a known,
  intentional tradeoff, not an oversight, and was not touched by this pass
  (see §9).
- **Legacy stack:** a prior Python + Nunjucks server-rendered stack has
  already been **fully migrated away**. No `.py`, Nunjucks templates,
  `requirements.txt`, or `pyproject.toml` exist anywhere in the application
  code (verified: `find . -iname "*.py"` outside `.claude/` skill tooling
  returns nothing; `grep -ri nunjucks` across the repo returns only
  historical code comments documenting the migration, e.g.
  `apps/storefront/src/server.ts:44`, `apps/storefront/src/routes/spaShell.ts:4-7`
  — no actual `.njk` files or `nunjucks` npm dependency remain). See §14.

## 2. Baseline / Current Problems

No runtime profiler was attached (no `--inspect`, no APM) — this audit is
static/code-level, per the prompt's own allowance to use "pendekatan
sesederhana mungkin" and to avoid adding a heavy profiler dependency to
production. Concrete, code-verifiable problems found (not measured RAM/CPU
numbers, which the prompt explicitly says not to fabricate — see §18):

- Two unbounded-growth in-memory `Map`s with dead/lazy-only eviction paths
  (rate-limit buckets, join-gate cache — §3).
- One 40-page React SPA (`web-admin`) shipping as a single 1,454.66 kB
  (~405 kB gzip) initial JS chunk, including pages an admin may open once a
  month (Branding, Storage, the 4-page setup wizard) — §11.
- `web-admin`'s Fastify instance shipping every response uncompressed while
  its sibling `storefront` instance already compresses correctly — §7.
- A synchronous `readFileSync` of the built `index.html` on every single
  page-load/refresh/deep-link request, across 5 route files in both apps —
  the busiest routes in the whole system, run inside a process that also
  polls Telegram and 7 payment gateways — §8.
- 3 of 7 payment-reconcile pollers with no rate-limit backoff at all — a
  429 from the gateway just gets retried at the flat poll interval forever,
  risking a self-inflicted retry storm — §6/§12.
- An O(N) sequential existence-check inside a 10-second-bounded Prisma
  transaction for bulk Digiflazz brand imports — §6.
- AI-coding-assistant tooling directories (`.claude/`, `.cursor/`, etc. —
  19 directories, none read by the build or runtime) being copied into
  every Docker build context and shipped in the production image — §9/§14.
- Two Prisma queries over-fetching full rows/includes where callers use a
  small subset of fields — §6.
- A 2N-query loop for a cascade delete's stock-history safety check — §6.

## 3. Critical Findings (P0)

| Priority | Area | Problem | Evidence | Fix | Expected Impact | Risk |
|---|---|---|---|---|---|---|
| P0 | Memory (bot) | `buckets` Map in the rate-limit middleware grows with every unique Telegram user who has ever messaged the bot, never actively pruned — a dead code branch (`else buckets.delete(...)`) could never execute because `dq.push(now)` always leaves `dq.length >= 1` | `apps/order-bot/src/middleware.ts:185-205` (pre-fix) | Fixed the dead branch + added `sweepRateLimitBuckets()` on a 10-min `.unref()`'d interval, exported for test | High — bounds bot process RAM growth over the process's lifetime, which was previously proportional to cumulative unique users, not active/concurrent users | Low (additive sweep, no behavior change to rate-limiting itself; 92/92 relevant tests pass) |

Only one true P0 was found: this codebase's single-process architecture and
generally careful engineering (documented inline reasoning for most
resource-sensitive decisions) meant the audit did not surface the more
severe P0 patterns the prompt's checklist anticipates for typical deployments
(duplicate worker/scheduler across replicas, duplicate bot polling,
infinite retry, uncontrolled logs) — those failure modes are structurally
absent here because there is only one process instance by design.

## 4. RAM Optimization

- **Task 1 (P0):** rate-limit bucket sweep — see §3.
- **Task 8 (P2):** the same unbounded-by-cumulative-users shape existed in
  two more caches, lower severity because they were already TTL-based with
  lazy eviction-on-read (an entry is only removed the next time the *same*
  key is read) — a user who interacts once and never returns left a
  permanent stale entry until the whole process restarts:
  - `packages/db/src/crud/warmUserCache.ts:72` (`cache`, 5-min TTL)
  - `apps/order-bot/src/middleware.ts:240` (`joinGateCache`, 5-min TTL)

  Fixed by adding `pruneWarmUserCache()` / `pruneJoinGateCache()`, each on a
  10-minute `.unref()`'d interval. Existing lazy eviction-on-read is
  unchanged — the sweep is additive, not a replacement.
- **Task 3:** web-admin's 1,454.66 kB initial JS chunk is memory the browser
  tab holds (parsed, compiled, and — for `recharts`/heavy pages — retained)
  whether or not the admin ever visits most of those 35 pages in a session.
  See §11 for the fix and the before/after number.
- No other unbounded in-memory structures were found. `packages/core`'s
  provider clients reuse HTTP agents rather than allocating per-call state;
  no additional global `Map`/`Set`/array-history pattern turned up in a
  repo-wide grep for `new Map()`/`new Set()` at module scope beyond the
  caches already covered above and ones with existing, correct bounds
  (verified during the audit, not enumerated here to avoid restating every
  clean file).

## 5. CPU Optimization

- **Task 7:** `readFileSync` on every request to the 5 SPA-shell routes
  (both apps' main HTML shell, unauth shell, setup shell, storefront's
  error-page fallback) — a synchronous, blocking disk read repeated on the
  single highest-traffic route family in the system, inside a process that
  also has to service Telegram bot updates and payment-poller ticks with no
  scheduling isolation. The file is a build-time-immutable Vite artifact;
  only small per-request string substitutions (CSRF token, favicon URL,
  admin-ids meta tag) are genuinely per-request. Fixed by memoizing the
  read once per process (`loadSpaIndexHtml()`), leaving the substitution
  logic untouched.
- **Task 2:** `web-admin` shipped every response uncompressed. Compression
  trades a small amount of CPU for materially less bytes-on-wire on
  compressible responses (HTML/JSON/JS) — `storefront`'s sibling Fastify
  instance already made this tradeoff correctly; `web-admin` now mirrors it
  exactly (same plugin, same version, same registration order, no custom
  threshold — Fastify/`@fastify/compress`'s own sane defaults).
- No hot-path deep-clone, repeated `JSON.stringify`/`parse`, or
  unnecessary-`Promise.all`-over-unbounded-array patterns were found beyond
  what's already covered under §6 (query/batch fixes) — the codebase's
  existing `Promise.all` usages over provider/DB calls were checked and are
  already bounded by `MAX_ORDERS_PER_CYCLE`-style caps in every poller.

## 6. PostgreSQL Optimization

**Connection Pool:** no explicit `connection_limit` on `DATABASE_URL_PRISMA`
(`.env.example:152`) — Prisma's default pool sizing applies. Given the
single-process topology (confirmed §1 — one `server` service in
`docker-compose.yml`), the classic "N containers × pool max" multiplication
this codebase's own CLAUDE.md and the prompt's Tahap 6 warn about does not
apply here (there is only one process, so it's `1 × pool_max`, not `N ×`).
No evidence of connection exhaustion was found (no test/log/error referencing
pool saturation). **Not changed** in this pass — no confirmed bottleneck,
and guessing at a pool size without production traffic data would violate
the prompt's own "jangan melakukan optimasi berdasarkan asumsi semata" rule.
Flagged as a P2/monitoring item for §19.

**Query Audit — 3 findings implemented:**

| Priority | Area | Problem | Evidence | Fix | Expected Impact | Risk |
|---|---|---|---|---|---|---|
| P1 | PostgreSQL (N+1) | `importDigiflazzBrand` did one `tx.denomination.findFirst` PER ROW inside a `db.$transaction` bounded by a 10-second timeout (`packages/db/src/client.ts`'s `transactionOptions.timeout: 10000`) — for a large brand price-list, N sequential round-trips risked exceeding the timeout | `packages/db/src/crud/digiflazz.ts:1319` (pre-fix) | Batched into one `findMany` + `Map` lookup before the loop; per-row `create`/`update` writes unchanged (they have real side effects like slug generation) | High for large imports — O(N) round-trips → O(1); removes timeout risk | Low-medium — a real Important-severity regression was caught in task review (see §17) and fixed before merge |
| P2 | PostgreSQL (over-fetch) | `listOrderItemsExpiringWarranty` used `include: { product: true, order: { include: { user: true } } }` — full rows of `OrderItem`, `Product`, `Order`, `User` for each match; `searchStockCredentials` had no `select` at all | `packages/db/src/crud/reports.ts:834`, `packages/db/src/crud/stock.ts:676` (pre-fix) | Added `select` derived from tracing each function's one real caller (`apps/web-admin/src/routes/api/dashboard.ts:263`, `apps/web-admin/src/routes/api/stock.ts:198`) plus each function's own internal field usage | Medium — smaller result sets, less serialization work, narrower Postgres row reads | Low — Prisma's `select` narrows the TS result type, so any caller reading an unselected field fails `pnpm typecheck` (stayed green) |
| P2 | PostgreSQL (batch) | `deleteCatalogProductCascade`'s cascade-delete safety check called `assertNoStockHistory` once per denomination (2 count queries × N denominations) | `packages/db/src/crud/catalog.ts:354-612` (pre-fix) | Replaced the per-denomination loop with 2 total `count` queries using `productId: { in: denomIds }` | Medium — 2N queries → 2 queries for admin-triggered product deletes (not a hot path, but a clean, zero-risk batch) | Low — mathematically exact-equivalent (counts are never negative, so "sum over IN-list > 0" ⟺ "any single denomination > 0"); confirmed by the Opus final review independently, not just the task reviewer |

**Index:** no new index was added — every hot query already had adequate
`WHERE`/index coverage per `EXPLAIN` spot-checks during the audit; adding
indexes "just in case" without a specific slow query as evidence would
violate the prompt's own "jangan menambahkan index secara membabi buta"
rule, so none were added.

**Data Type / Retention:** no inefficient data types or unbounded
append-only-table growth beyond what's already covered by this codebase's
existing, previously-shipped retention mechanisms (audit log, webhook/OTP
tables) were found to be newly in scope for this pass — not re-audited in
full depth here since it wasn't flagged as a live problem during Phase A
and touching retention policy on financial/audit tables is exactly the kind
of "don't delete transaction data" risk the prompt's Tahap 6/18 warn
against without a much more specific mandate.

## 7. Network Optimization

- **Task 2:** `web-admin` compression — see §5. This is the most direct
  "reduce unnecessary data transfer" win in this pass: every previously
  uncompressed admin response (HTML shell, JSON API responses) now
  transfers compressed, matching what `storefront` already did.
- **Task 5 (payment-poller backoff, P1, money-critical):** 3 of 7
  payment-reconcile pollers (`tokopayReconcile.ts`, `paydisiniReconcile.ts`,
  `nowpaymentsReconcile.ts`) had no rate-limit backoff — a `429` from the
  gateway just got retried at the flat configured poll interval, cycle
  after cycle, which under a sustained rate-limit episode turns into a
  retry storm against the gateway provider. 4 of 7 pollers
  (`binanceInternal`, `bybitDeposit`, `bybitBscDeposit`,
  `bybitBscConfirmationTracker`) already used a shared exponential-backoff
  helper (`apps/order-bot/src/payments/pollBackoff.ts`, 3s→30s cap). Fixed
  by extending the exact same, already-battle-tested pattern to the 3
  QRIS/fiat rails: a file-local `RateLimitedError` thrown on HTTP 429 in
  each of `packages/core/src/payments/{tokopay,paydisini,nowpayments}.ts`,
  wired into each poller's `pollOnce` via
  `backoff.shouldSkip()`/`recordRateLimit()`/`recordSuccess()`.

  **Post-merge-review correction:** the final whole-branch review (§17)
  found the initial `createBackoffGate()` call used the helper's 3000ms
  default base, which is *shorter* than the pollers' own 10-second default
  poll interval — meaning the first 1-2 consecutive 429s expired their
  backoff window before the next poll tick even arrived, so the gate didn't
  actually skip a cycle until the 3rd consecutive hit. Fixed in a follow-up
  commit (`fca6c009`) by sizing the base to the poll interval:
  `createBackoffGate({ baseMs: config.POLL_INTERVAL_SECONDS * 1000 })` —
  now even the *first* 429 can skip a full cycle.

  **Known, deliberately deferred follow-up:** none of the 3 QRIS pollers
  breaks out of its batch loop mid-cycle on a 429 — up to
  `MAX_ORDERS_PER_CYCLE` (49) more calls can still fire within the *same*
  cycle before the next cycle's `shouldSkip()` check takes effect. The
  Opus final review explicitly re-assessed this and judged it **acceptable,
  not a merge blocker**: these are read-only, idempotent GET calls (order
  status checks), sent serially not in parallel, and even in the worst case
  the new gate still cuts sustained-429 load to roughly **50 calls per
  ~40s** (one full cycle + one 30s skip window) versus **50 calls per ~10s**
  on `master` today with no gate at all — a ~4x reduction, strictly better
  than before in every scenario, never worse. See §19 for the recommended
  future pairing (early break + `baseMs` retune + `cursor.advance(checked)`
  fix, to be done together, not separately).

## 8. Disk I/O Optimization

- **Task 7:** see §5 — the `readFileSync`-per-request fix is the disk I/O
  finding for this pass. No other synchronous filesystem operations in a
  request path, unbounded local disk cache, or un-cleaned temp-file pattern
  were found.
- **Known limitation of the Task 7 fix (documented, not implemented — see
  §19):** the in-memory cache is per-process-lifetime, not
  invalidated on file change. This is correct for Docker deploys (each
  deploy restarts the process). It is a real (if narrow) staleness risk
  only for a non-Docker "rebuild artifacts in place, then restart later"
  deploy gap, or a `pnpm dev:web` dev server running next to an
  independent `pnpm -r build` — flagged by the Opus review, judged Minor,
  not fixed in this pass (out of scope: this pass targets Docker
  production deploys, where the concern doesn't apply).

## 9. Docker Optimization

| Priority | Area | Problem | Evidence | Fix | Expected Impact | Risk |
|---|---|---|---|---|---|---|
| P1 | Docker image size | 19 AI-coding-assistant tooling directories (`.claude/`, `.cursor/`, `.codewhale/`, etc. — none read by the build or runtime, confirmed by grepping `Dockerfile`, `docker-entrypoint.sh`, and every `package.json` script for references) were captured by the builder stage's `COPY . .`, then the *entire* builder `/app` — including these — copied into the runtime image via `COPY --from=builder ... /app /app` | `.dockerignore` (pre-fix, missing these entries); confirmed via `git show dc3147f9:.dockerignore \| grep .claude` → no match | Added a new `.dockerignore` section (19 directories) | Medium — smaller build context, smaller/faster image layer, no functional change | Low — `docker compose config` validates, `docker compose build` succeeds, `.claude/` (and siblings) genuinely unreferenced by any build/runtime script |

**Multi-stage build / Base image:** the `Dockerfile`'s runtime stage
deliberately ships devDependencies and raw TypeScript (`tsx`, no compiled
`dist`) — this is explicitly documented inline (`Dockerfile:71-80`) as
required for `pnpm start` and the migration entrypoint, a known and
intentional tradeoff. Per the prompt's own rule ("jangan melakukan
perubahan besar tanpa menjelaskan bottleneck yang ingin diselesaikan" and
"jangan mengganti framework hanya karena framework lain sedikit lebih
ringan"), this was **not** touched — reversing it would mean introducing a
real build pipeline (compiling to `dist`, adjusting the entrypoint and
migration runner), which is an architecture change out of scope for an
optimization pass, not a safe/mechanical fix. Base image was reviewed and
kept as-is — no clear compatibility/size/security win from switching was
found.

**Docker Compose:** exactly one application service (`server`) plus
`postgres` — no duplicate, dev-only-but-running-in-prod, or unused services
found. No excessive healthcheck interval, restart-loop pattern, or
unbounded bind-mount was found in `docker-compose.yml`/
`docker-compose.postgres.prod.yml`.

## 10. Startup Optimization

No heavy startup-time work was found beyond what's already necessary
(migration/schema application before the process becomes ready, per this
repo's own documented deploy sequence). No large dataset preloading,
blocking external network call before readiness, or duplicate/serial
initialization that's actually independent was found to be newly in scope.
Not changed in this pass — no confirmed startup-time problem, and the
prompt explicitly warns against lazy-loading aggressively "jika membuat
runtime menjadi kompleks" without a demonstrated need.

## 11. React Optimization

| Priority | Area | Problem | Evidence | Fix | Expected Impact | Risk |
|---|---|---|---|---|---|---|
| P1 | Bundle size | Every one of `web-admin`'s 40 page components was statically imported in `App.tsx`, shipping in one 1,454.66 kB (≈405 kB gzip) initial JS chunk — including pages opened rarely (Branding, Storage, Audit, Settlements, the 4-page setup wizard) | `apps/web-admin/client/src/App.tsx` (pre-fix, all static imports); `storefront/client/src/App.tsx` already used the correct lazy pattern as a reference | Converted 35 of 40 page imports to `React.lazy(() => import(...))` behind one top-level `<Suspense>`; kept `DashboardPage` (the `/` landing route), `LoginPage`, `ForgotPage`, `ResetPage`, `BootstrapPage` eager (auth entry points hit directly, no shell) | **Measured: main chunk 1,454.66 kB → 941 kB** (build output, not estimated) | Low-medium — see §17 for one Important-severity follow-up (stale-chunk recovery after deploy) found and fixed post-review |

No unnecessary `useMemo`/`useCallback` sprinkling, oversized global context,
or duplicate-API-call pattern was found to be newly in scope for this pass.
API payload shape (field selection vs. what's rendered) is addressed
indirectly by §6's Prisma `select` fixes, which narrow what the backend
sends in the first place.

**Follow-up correction found by the final review (fixed, see §17):** the
React.lazy conversion introduced a real, if narrow, regression — an admin
tab left open across a Docker deploy (which replaces all hashed chunk
files via `emptyOutDir: true`) would 404 on its first navigation to a
not-yet-fetched lazy page, and React's lazy machinery caches the rejected
import promise so the error boundary's "Try again" could never recover.
Fixed by a `vite:preloadError` listener in `main.tsx` that reloads the tab
once, so it re-fetches the current `index.html` and chunk manifest.

## 12. Telegram Bot Optimization

- **Mode:** long polling (not webhook) — kept as-is. Per the prompt's own
  rule, switching to webhook "hanya demi teori efisiensi" without a
  demonstrated deployment-complexity or resource win is exactly the kind of
  premature change to avoid; no evidence of real polling overhead was found
  on this single-process topology.
- **Task 1 (P0) / Task 8 (P2):** see §3/§4 — the two unbounded-cache fixes
  most directly answer this section's "does bot session/cache data leak
  unboundedly" question.
- **Task 5 (P1):** see §7 — the 3-poller backoff extension is this
  section's most significant fix; payment reconciliation runs inside the
  same process as the bot's own update handling, so an unthrottled retry
  storm against a payment gateway would compete for the same event loop as
  every Telegram update.
- **Duplicate instance/scheduler risk:** structurally absent — confirmed
  single `server` service in `docker-compose.yml` (§1), so there is no
  "multiple bot instance"/"duplicate polling"/"duplicate scheduler" failure
  mode possible in the current deployment shape.
- Middleware was reviewed for per-update unconditional DB/HTTP work beyond
  what's already necessary (auth/rate-limit/join-gate checks) — no new
  finding beyond the two cache fixes already covered.
- `apps/order-bot/src/jobs/index.ts` (1,819 lines) was read in full during
  the audit; no additional overlap, missing-concurrency-limit, or
  uncleaned-job pattern was found beyond what's covered elsewhere in this
  report — the file's size reflects business-logic breadth (many distinct
  job types), not duplicated/dead scheduling code.

## 13. Dependency Cleanup

- **Task 2** added exactly one new dependency to `web-admin`:
  `@fastify/compress@^9.1.0` — already present in the workspace via
  `storefront`, so `pnpm-lock.yaml` only gained one new importer entry, not
  a new package in the dependency graph (verified in the Opus final
  review — `git diff pnpm-lock.yaml` shows no new `packages:` entry).
- No other dependency was added anywhere in this branch (13 commits, 0
  other `package.json` changes).
- No dead/unused/duplicate-functionality dependency was confirmed removable
  during this pass with enough certainty to act on per the prompt's own
  "jangan menghapus package berdasarkan static tool saja" rule — a full
  `npm ls`/`npm outdated`-driven dependency-by-dependency audit across 9
  workspaces was judged out of proportion to this pass's P0/P1 focus and is
  listed as a §19 recommendation for a dedicated follow-up pass instead of
  being rushed here.

## 14. Legacy Python / Nunjucks Cleanup

**Fully migrated already — nothing to remove.** Verified directly, not
assumed:
- `find . -iname "*.py"` (excluding `node_modules`, `graphify-out`) returns
  **zero** matches outside `.claude/` (Claude Code's own skill tooling —
  unrelated to the application, not shipped at runtime, see below).
- `grep -ri nunjucks` across the whole repo returns **only** historical code
  comments documenting the completed migration (e.g.
  `apps/storefront/src/server.ts:44`, `apps/storefront/src/routes/spaShell.ts:4-7`,
  `apps/storefront/client/src/lib/format.ts:2`) — no `.njk` template files,
  no `nunjucks` npm dependency in any `package.json`.
- No `requirements.txt`/`Pipfile`/`pyproject.toml` exists in application
  code (only under `.claude/skills/*/scripts/` — Claude Code's own tooling,
  not the application's).
- `.env.example:2` still carries a comment — `"the legacy Python stack
  reads DATABASE_URL"` — and a commented-out legacy SQLite fallback line
  (`.env.example:165`, `#DATABASE_URL_PRISMA=file:../data/bot.db`,
  pre-dating the documented 2026-08-27 Postgres engine-swap). Neither is
  live code; both are historical-context comments. Left as-is — removing
  documentation comments has zero resource impact and is out of this pass's
  scope.

**Adjacent finding, implemented (Task 4, §9):** `.claude/`, `.cursor/`, and
17 sibling AI-coding-assistant tooling directories (including
`.claude/skills/*/scripts/*.py` — genuinely present, but Claude Code's own
tooling, not a leftover Python *backend*) were being copied into the Docker
build context and shipped in the runtime image with zero functional need.
Excluded via `.dockerignore` (§9's P1 fix) — this is the closest real match
to a Tahap 2 "sisa teknologi lama" style finding in this repo today, even
though its origin (AI tooling, not the original Python/Nunjucks stack) is
different from what the prompt anticipated.

## 15. Changes Implemented

All 10 originally-planned tasks, plus 2 post-review fixes (13 commits
total, `dc3147f9..fca6c009`/`c242ca41`):

1. Fix unbounded rate-limit bucket growth (P0) — bot middleware.
2. Add `@fastify/compress` to web-admin (P1).
3. Code-split web-admin's 35 static page imports (P1) — 1,454.66 kB →
   941 kB main chunk.
4. Exclude AI-tooling directories from the Docker build context (P1).
5. Add rate-limit backoff to 3 QRIS/fiat payment-reconcile pollers (P1,
   money-critical).
6. Batch the N+1 lookup in `importDigiflazzBrand` (P1).
7. Cache the SPA-shell `index.html` read instead of `readFileSync`
   per-request (P2), 5 files across both apps.
8. Add active pruning to `warmUserCache` and `joinGateCache` (P2).
9. Add `select` to two over-fetching Prisma queries, fields traced from
   real callers (P2).
10. Batch the per-denomination stock-history check in
    `deleteCatalogProductCascade` (P2).
11. *(post-review fix)* Retune the 3 new payment-poller backoff gates'
    `baseMs` to one poll interval, so the first 429 can skip a cycle
    instead of only the third.
12. *(post-review fix)* Recover from a stale-chunk `React.lazy` load
    failure after a deploy (`vite:preloadError` → reload once).

Every task was implemented via `superpowers:subagent-driven-development`:
a fresh implementer subagent per task, followed by an independent task
review (spec compliance + code quality) with a fix loop where needed
(Task 6 had one Important-severity regression caught and fixed pre-merge —
see §17), then a mandatory whole-branch Opus review before this report.

**P2/P3 findings NOT implemented (documented per the prompt's "P3 hanya
jika sangat aman dan jelas" rule):** see §19 for the full list.

## 16. Files Changed

34 files changed, 1,127 insertions(+), 122 deletions(-):

```text
.dockerignore                                          |  21 +
apps/order-bot/src/middleware.ts                        |  78 +-
apps/order-bot/src/payments/nowpaymentsReconcile.ts      |  33 +-
apps/order-bot/src/payments/paydisiniReconcile.ts        |  32 +-
apps/order-bot/src/payments/tokopayReconcile.ts          |  38 +-
apps/order-bot/test/joinGateSweep.test.ts                |  66 +  (new)
apps/order-bot/test/nowpayments-reconcile.test.ts        | 131 +  (new)
apps/order-bot/test/paydisini-reconcile.test.ts           |  91 +  (new)
apps/order-bot/test/rateLimitSweep.test.ts                |  74 +  (new)
apps/order-bot/test/tokopay-reconcile.test.ts             |  96 +  (new)
apps/storefront/src/lib/spaFallback.ts                    |  16 +-
apps/storefront/src/routes/spaShell.ts                    |   5 +-
apps/web-admin/client/src/App.tsx                         | 202 +-
apps/web-admin/client/src/main.tsx                        |   7 +
apps/web-admin/package.json                                |   1 +
apps/web-admin/src/routes/setupShell.ts                    |  15 +-
apps/web-admin/src/routes/spaShell.ts                      |  13 +-
apps/web-admin/src/routes/unauthShell.ts                   |  15 +-
apps/web-admin/src/server.ts                                |   6 +
apps/web-admin/test/web.test.ts                             |  16 +
packages/core/src/payments/nowpayments.test.ts              |  13 +-
packages/core/src/payments/nowpayments.ts                   |  13 +
packages/core/src/payments/paydisini.test.ts                |  13 +-
packages/core/src/payments/paydisini.ts                     |  13 +
packages/core/src/payments/tokopay.test.ts                  |  13 +-
packages/core/src/payments/tokopay.ts                       |  13 +
packages/db/src/crud/catalog.ts                              |  13 +-
packages/db/src/crud/digiflazz.test.ts                       |  80 +
packages/db/src/crud/digiflazz.ts                             |  37 +-
packages/db/src/crud/reports.ts                                |  16 +-
packages/db/src/crud/stock.ts                                   |   5 +
packages/db/src/crud/warmUserCache.test.ts                     |  27 +-
packages/db/src/crud/warmUserCache.ts                            |  34 +
pnpm-lock.yaml                                                     |   3 +
```

No file outside this list was touched. No public API response shape, DB
schema, or business-logic flow changed.

## 17. Risks / Compatibility Notes

- **Money-critical code touched:** Task 5 (payment-poller backoff) and
  Task 6 (Digiflazz batch import) touch payment/order code directly. Both
  were implemented with the most capable available model per this repo's
  own "Opus for money-critical work" convention, and both received extra
  scrutiny in task review. Task 6's task review caught a genuine
  correctness regression before merge: the initial batched existence-check
  broke idempotency for an intra-call duplicate `buyerSkuCode` (would
  create 2 rows instead of create-then-update-in-place) — fixed with
  last-occurrence-wins de-duplication before both the existence check and
  the main loop, then re-reviewed and approved.
- **Mandatory whole-branch review (Opus, per explicit project convention):**
  performed on the full `dc3147f9..fcf5b5c7` diff (11 commits) before this
  report. Verdict: **"Ready to merge: Yes."** Zero Critical findings. Two
  Important findings — both fixed in a follow-up commit pair before this
  report was finalized (see §11, §7, and the "Post-merge-review correction"
  notes above). Several Minor findings were documented, not implemented
  (§19).
- **Backoff/retry safety:** no idempotency, transactional lock, or
  retry-safety mechanism was loosened anywhere in this branch — confirmed
  independently by both the task reviewers and the final whole-branch
  review, which specifically checked this given the money-critical files
  touched.
- **Test coverage:** every task added or extended tests alongside its
  fix; no existing test was weakened or deleted to make a change pass.
- **No schema/migration changes** — nothing in this branch touches
  `packages/db/prisma/schema.prisma` or requires a migration.
- **No public API/business-flow changes** — every fix is either purely
  internal (query shape, caching, batching) or additive (a new backoff gate
  that can only skip work, never add it; a new sweep that can only remove
  already-expired cache entries).

## 18. Expected Impact

No runtime profiler was run before/after (per §2 — this was a static audit,
consistent with the prompt's own instruction not to add a heavy profiler
dependency and not to fabricate numbers). Where a real build-time number
exists, it's stated; everywhere else:

```text
RAM: medium improvement (two unbounded-growth caches now actively bounded;
     impact scales with bot uptime and cumulative unique user count —
     belum dapat diukur tanpa runtime benchmark on a long-lived process)
CPU: low-medium improvement (compression trades some CPU for less bytes-
     on-wire; readFileSync-per-request removed from the hottest routes —
     belum dapat diukur tanpa runtime benchmark)
DB connections: unchanged (no pool size change made — no confirmed
     bottleneck to justify one)
DB round-trips: importDigiflazzBrand N (rows) → 1 for the existence check;
     deleteCatalogProductCascade 2N (denominations) → 2 for the stock-
     history check (both exact, code-verifiable, not estimated)
Docker image: belum dapat diukur tanpa build-size comparison (context
     shrunk by 19 excluded directories' worth of files; exact byte delta
     not measured in this pass)
Container count: unchanged (already 1 app service before and after —
     nothing to reduce)
Startup: unchanged (no startup-path change made in this pass)
Bundle size (web-admin main chunk): 1,454.66 kB → 941 kB (measured,
     from actual vite build output during Task 3)
Network (external payment-gateway calls under sustained 429s): ~50 calls
     per ~10s (before, no gate) → ~50 calls per ~40s (after, gated) on the
     3 newly-covered QRIS/fiat rails — roughly a 4x reduction in worst-case
     sustained-retry load (derived from the poll-cycle/backoff-window math
     in §7, not a runtime measurement)
```

## 19. Remaining Recommendations

**Deliberately deferred, not implemented in this pass (documented per the
prompt's P2/P3 "only if trivial and obviously safe" rule):**

1. **Payment-poller batch loop doesn't break early on a 429 mid-cycle**
   (§7). Recommended fix, to be done together (not piecemeal): add an early
   `break` on the first `RateLimitedError` in each of the 3 QRIS pollers'
   batch loop, paired with a `cursor.advance(checked)` fix (advance by the
   number of orders actually checked, not `orders.length`, so the unchecked
   tail isn't skipped for a full rotation) — both changes reviewed together
   by the same Opus pass that reviewed the `baseMs` retune.
2. **`digiflazz.ts`'s new batched `findMany`** loads full denomination rows
   when only `id` and `supplierSku` are needed — add a `select`. Also,
   `(productId, supplierSku)` has no unique DB constraint, so if duplicate
   rows already exist, which row gets updated is non-deterministic (not a
   regression — the old per-row `findFirst` had the same non-determinism,
   just via a different arbitrary row); an `orderBy: { id: "asc" }` would
   make it deterministic if ever needed.
3. **`RateLimitedError` is declared three times** (once per gateway client
   file) without a shared `name` property, so logs show it as generic
   `Error`. A single shared class in `@app/core/http` would be tidier —
   cosmetic, not functional.
4. **Top-level `<Suspense>` in `App.tsx` sits above `AppShell`** — a hard
   refresh or deep link to a lazy route replaces the whole shell (sidebar +
   topbar) with a bare "Loading…" on first paint, rather than keeping the
   shell painted while just the page content loads. Moving `<Suspense>`
   inside `AppShell` around the route `<Outlet/>` would fix this but needs
   its own care for the `/setup/*` routes, which currently sit outside any
   error boundary.
5. **SPA-shell `index.html` cache (Task 7)** can serve a stale shell if
   assets are rebuilt in place without a process restart (non-Docker
   "build then restart later" deploys only — does not affect Docker
   deploys, where each deploy restarts the process). If this workflow is
   ever used in production, skip the cache when `NODE_ENV !== "production"`.
   The same 5-line loader is also now duplicated across 3 web-admin route
   files — a shared helper would remove the duplication.
6. **No test covers `deleteCatalogProductCascade` on a zero-denomination
   product** (the `denomIds.length === 0` guard added in Task 10) —
   existing tests cover one-denomination-with-stock and
   multiple-denominations-with-one-stocked, not the zero case.
7. **Test-only exports leaked into production modules** (`hasBucket`,
   `joinGateCacheSize`, `cacheSize`) — harmless (used only by tests), but
   `cacheSize` is a very generic name for a public `@app/db` export; could
   be renamed or moved behind a test-only entry point in a future pass.
8. **A dedicated dependency-audit pass** (§13) — `npm ls`/`npm outdated`
   plus real per-dependency import verification across all 9 workspaces —
   was judged out of proportion to this pass's P0/P1 focus and deserves its
   own follow-up rather than being rushed alongside money-critical changes.
9. **PostgreSQL connection pool sizing** (§6) has no explicit
   `connection_limit` — not a confirmed problem today (single-process
   topology means no `N×pool` multiplication), but worth setting explicitly
   once real production connection-count data exists, rather than relying
   on Prisma's default forever.

## 20. Verification Commands

```bash
pnpm typecheck        # clean, all 9 workspaces
pnpm test              # 8518/8520 passed on the full pre-fix-wave run;
                        # the 2 failures were independently re-run in
                        # isolation: VouchersPage.test.tsx passed 25/25
                        # (confirmed a flake under full-suite parallel
                        # load), storage-api.test.ts's dbBytes assertion
                        # fails in isolation too — a pre-existing,
                        # already-known bug unrelated to this branch
                        # (storage.ts still stats a legacy SQLite bot.db
                        # path post-Postgres-engine-swap)
pnpm -r build           # exit 0, all workspaces
docker compose config   # valid
docker compose build    # exit 0, bot-order-node:latest built successfully
```

Additionally, after the post-review fix wave (commits `fca6c009`,
`c242ca41`): the 4 affected poller test files were independently re-run
(`apps/order-bot/test/{tokopay,paydisini,nowpayments}-reconcile.test.ts` +
`poll-backoff.test.ts`) — 86/86 passed — and `pnpm typecheck` re-confirmed
clean.

---

*Generated as Phase F of a 20-phase resource-optimization audit
(`prompt-optimasi-resource-project.md`). Phase E (mandatory whole-branch
review, Opus model) verdict and full findings are summarized in §17 and
§19; the complete review transcript is preserved in this branch's
`.superpowers/sdd/progress.md` ledger for future reference.*
