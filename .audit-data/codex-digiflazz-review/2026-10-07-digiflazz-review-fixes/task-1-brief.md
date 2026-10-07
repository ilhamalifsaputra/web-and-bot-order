## Task 1: Address the complete review findings

**Files:**

- `packages/db/src/crud/digiflazz.ts` and `digiflazzAutoDeactivated.ts`: synchronization and credential freshness.
- `packages/db/src/crud/catalog.ts`: compatible lock ordering for admin availability changes.
- `packages/db/src/crud/settings.ts`: source-cache metadata only if needed.
- `packages/db/src/crud/fulfillmentMessages.ts`, `orders.ts`: waking corrected outcomes.
- `packages/outbox-dispatcher/src/fulfillmentMessages.ts`: durable completion.
- Corresponding existing tests; add a focused test file only if isolation requires it.

**Interfaces:** Preserve public entry points and return shapes; add an internal helper or an optional narrowly scoped wake argument if necessary. Prefer existing schema fields and short row-locking transactions to new migrations.

- [ ] Write regression tests for all five review-focus cases. Assert actual database state, progress text/message ID, and recovery on a new worker; use controlled barriers or fault injection around real database operations for race cases.
- [ ] Run the new cases before implementation and capture expected failures, not setup errors.
- [ ] Make sync availability and remembered-ID updates atomic per SKU, reading current membership and current state under the same locking protocol as admin toggles. Handle marker cleanup without overwriting concurrent decisions.
- [ ] Prevent the credential cache from stacking another full TTL over aged source settings; retain same-process write invalidation.
- [ ] Finish credited messages, explicitly wake safe existing-message rows when credit corrects a terminal result (including already-cancelled recovery), and prevent a concurrent wake from being overwritten by a waiting/final save.
- [ ] Run affected test files with `node node_modules/vitest/vitest.mjs run <files> --maxWorkers=1 --minWorkers=1`. Record red/green evidence and any limitations in the task report.
- [ ] Self-review the diff, then commit only the plan, production fixes, and regression tests.

## Integration verification

The coordinator runs all workspace typechecks, test-source typechecking, production builds, migration drift/timestamp checks, frontend-boundary checks, storefront lint, detection-engine purity, and the complete Vitest suite with a single worker. An independent reviewer checks the whole fix diff before integration. Fetch before merging; merge and push to `origin/master` only after verification passes.
