# Digiflazz review fixes

> For agentic workers: use superpowers:subagent-driven-development and test-driven-development.

**Goal:** Complete the interrupted review of immediate dispatch and denomination synchronization, preserving admin decisions and delivering durable final Telegram progress messages.

**Architecture:** Retain existing dispatch and synchronization entry points. Make availability and provenance changes atomic, preserve the settings freshness bound, and ensure persisted progress completion cannot lose a concurrent order transition.

**Tech stack:** TypeScript, Prisma, PostgreSQL, Vitest, grammY.

**Spec:** Existing catalog sync design (`../specs/2026-08-16-digiflazz-catalog-sync-design.md`), existing customer progress behavior, and the confirmed defects below.

## Global constraints

- Work only in this worktree; preserve unrelated local changes and other sessions' worktrees.
- Keep money calculations in Decimal and existing quantization conventions.
- No network calls inside database transactions; do not contact real Telegram or supplier APIs during tests.
- Same-reference Digiflazz retries and the direct/cron/webhook lease ownership rules remain intact.
- Admin deactivation must not be undone by a stale sync snapshot.
- Commit availability changes and their provenance together, even when later rows fail.
- Derived credentials must not extend source settings' 30-second freshness bound.
- Reuse the saved Telegram message ID; uncertain or stopped sends remain stopped.
- A credited order is terminal; a later credit must correct a previously finalized failure/cancellation message.
- Final and waiting message completion must remain recoverable across concurrent transitions and worker crashes.
- Test with the dedicated local database only; use at most two Vitest workers with bounded heap for full-suite verification, and one worker for targeted tests.

## Review focus

1. An admin turns off a sync-deactivated SKU after the sync's initial reads.
2. A later SKU update fails after an earlier availability transition.
3. Source settings are almost expired when the derived credentials cache fills.
4. A cancelled or failed order receives credit after its Telegram message finishes.
5. Delivery or credit commits during a Telegram edit, followed by worker interruption.

## Task 1: Address the complete review findings

**Files:**

- `packages/db/src/crud/digiflazz.ts` and `digiflazzAutoDeactivated.ts`: synchronization and credential freshness.
- `packages/db/src/crud/catalog.ts`: compatible lock ordering for admin availability changes.
- `packages/db/src/crud/settings.ts`: source-cache metadata only if needed.
- `packages/db/src/crud/fulfillmentMessages.ts`, `orders.ts`: waking corrected outcomes.
- `packages/outbox-dispatcher/src/fulfillmentMessages.ts`: durable completion.
- Corresponding existing tests; add a focused test file only if isolation requires it.

**Interfaces:** Preserve public entry points and return shapes; add an internal helper or an optional narrowly scoped wake argument if necessary. Prefer existing schema fields and short row-locking transactions to new migrations.

- [x] Write regression tests for all five review-focus cases. Assert actual database state, progress text/message ID, and recovery on a new worker; use controlled barriers or fault injection around real database operations for race cases.
- [x] Run the new cases before implementation and capture expected failures, not setup errors.
- [x] Make sync availability and remembered-ID updates atomic per SKU, reading current membership and current state under the same locking protocol as admin toggles. Handle marker cleanup without overwriting concurrent decisions.
- [x] Prevent the credential cache from stacking another full TTL over aged source settings; retain same-process write invalidation.
- [x] Finish credited messages, explicitly wake safe existing-message rows when credit corrects a terminal result (including already-cancelled recovery), and prevent a concurrent wake from being overwritten by a waiting/final save.
- [x] Run affected test files with `node node_modules/vitest/vitest.mjs run <files> --maxWorkers=1 --minWorkers=1`. Record red/green evidence and any limitations in the task report.
- [x] Self-review the diff, then commit only the plan, production fixes, and regression tests.

## Integration verification

The coordinator runs all workspace typechecks, test-source typechecking, production builds, migration drift/timestamp checks, frontend-boundary checks, storefront lint, detection-engine purity, and the complete Vitest suite with at most two workers. An independent reviewer checks the whole fix diff before integration. Fetch before merging; merge and push to `origin/master` only after verification passes.
