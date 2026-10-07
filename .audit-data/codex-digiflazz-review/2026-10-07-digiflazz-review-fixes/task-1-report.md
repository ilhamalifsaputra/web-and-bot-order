# Task 1 report

Status: implementation and targeted verification complete; coordinator owns full-suite verification and independent review.

Commit: a0a9bb68277334c55c3bf9f362c5d6f47b8e46f1 (fix: preserve sync provenance and durable fulfillment outcomes). Worktree clean after commit; report and evidence are retained in the ignored execution ledger directory.

## Changes and locking rationale

- Sync reads current remembered membership and the current denomination in a short per-SKU transaction, locking the marker before the denomination. Availability, prices and provenance commit together. Earlier committed SKUs retain provenance if a later update fails. Cleanup checks current rows under the marker lock, so initial catalog snapshots cannot erase concurrent decisions.
- Admin toggles always acquire the same marker-first protocol, including when no marker exists or none of their IDs is remembered. A controlled PostgreSQL concurrency test exposed Prisma's empty-update upsert doing read-then-insert and producing P2002 for simultaneous initializers. Marker initialization now uses parameterized INSERT ON CONFLICT DO NOTHING before FOR UPDATE.
- The derived credential cache expires at the earliest source settings-cache expiry. Metadata returns only timestamps and performs no queries; hot credential-cache hits still return immediately. Existing same-process invalidation remains.
- CREDITED is terminal. Credit explicitly wakes known-ID finished FAILED/CANCELLED messages, including already-cancelled recovery, within the credit transaction. STOPPED/UNCERTAIN rows, rows without message IDs, successful finished rows, and finished credited rows are excluded.
- Completion acquires the order lock before saving the claimed message, matching canonical status/credit writers. It compares the current buyer-facing phase with the phase rendered by Telegram and persists an immediately due ACTIVE correction if they differ. The acknowledged message ID and correction are durable in one commit. No post-save reread is required for crash recovery. Message-not-modified edits use the same completion protocol. Lease ownership predicates remain on all saves; no supplier or Telegram calls occur inside transactions.
- Existing schema fields and public entry points are retained. wakeFulfillmentMessage accepts one optional narrowly scoped correction option; no migration was needed.

## Red/green evidence

All Vitest commands use the dedicated PostgreSQL database at 127.0.0.1:55459 and --maxWorkers=1 --minWorkers=1; no real supplier or Telegram endpoints are called.

1. Original regression selection: 12 expected assertion failures in task-1-red.log (3 credential source expiry cases, stale admin snapshot, partial-failure provenance, 2 credited terminal language cases, 2 later credit corrections, waiting-save interruption, and 2 concurrent-credit cancellation-edit variants). These failed on actual persisted state, not setup errors.
2. Same selection after fixes: 12 passed in task-1-green-focused.log. PowerShell Tee emitted an outer exit 1 because of the existing CJS deprecation warning on stderr; Vitest reported all 12 passed. Subsequent commands explicitly preserve the native exit code.
3. Six complete affected files: 450 passed, exit 0, 110.24 seconds in task-1-green-affected.log:
   - packages/db/src/crud/digiflazz.test.ts
   - packages/db/src/crud/fulfillmentMessages.test.ts
   - packages/db/src/crud/credit_order_to_balance.test.ts
   - packages/db/src/crud/settings.test.ts
   - packages/db/src/crud/catalog.test.ts
   - packages/outbox-dispatcher/src/fulfillmentMessages.test.ts
4. Additional deterministic absent-marker concurrency regression: expected P2002/assertion failure in task-1-red-absent-marker.log, then 1 passed/exit 0 in task-1-green-absent-marker.log after conflict-safe initialization. Uses an uncommitted first admin transaction and a pg_stat_activity lock barrier to observe the queued second writer.
5. After that final locking change: complete digiflazz and catalog files passed all 339 tests, exit 0, 59.89 seconds in task-1-green-final-locking.log. Across the affected files there are now 451 cases (one added after the initial six-file run).
6. Test-source TypeScript check (node node_modules/typescript/bin/tsc -p tsconfig.test.json --pretty false) passed with exit 0 after the final regression. git diff --check passed.

## Self-review and limits

Reviewed the full production and regression-test diff against every global constraint and review-focus case. Money still uses Decimal and existing quantization. Direct/cron/webhook supplier lease handling is unchanged. Regression races retain real database side effects, and recovery tests discard the old worker and assert the saved message ID/text with a new worker.

The marker serializes availability writers, and each sync SKU now uses its own short transaction. This adds database work to hourly catalog synchronization; no network calls hold those locks. Existing CJS deprecation and legacy plaintext test-fixture warnings remain in test output. No remaining targeted failures are known. Full workspace-suite verification, production builds/checks, and independent review are the coordinator's next steps; they were intentionally not duplicated here.

## Independent-review correction: actual denomination row lock

Correction commit: fd9d24388f7ce8f1fea9732e610888d901af21bc (fix: lock denomination rows before catalog sync updates). Worktree clean after commit.

The final independent reviewer caught one Important issue in a0a9bb68: the sync lock queried `products` although the actual Prisma Denomination model maps `denominations`. I had changed the initial correct table based on the stale introductory catalog comment and failed to verify the mapping in schema.prisma. The availability tests did not catch it because those writers serialize on the shared marker; ordinary price editors do not use the marker.

Added a real-database regression using the existing updateDenomination editor in an uncommitted admin transaction. It sets price to 25000 and priceOverridden=true, then starts sync with the still-visible old snapshot. A pg_stat_activity lock barrier observes sync queued on the denomination operation before releasing the admin commit. Against the wrong-table lock, the override flag survives but sync overwrites the price to 16500: expected 25000 / received 16500, captured in task-1-red-denomination-lock.log (1 expected failure, exit 1; no setup failure).

The production correction changes only the lock table to `denominations`; the directly related catalog introductory comment now describes both actual table mappings. With the correct lock, sync waits before reading the denomination and observes the committed override. Full impacted digiflazz and catalog files passed 340/340, exit 0, in 61.36 seconds (task-1-green-denomination-lock.log). Test-source TypeScript and git diff --check pass after this correction. The combined affected files now contain 452 cases. The coordinator stopped the partial full-suite run before this correction and will restart it after the fix commit and scoped independent re-review.

## Full-suite fixture correction: explicit CapCut plan order

Fixture/plan commit: 2d28cc02bd47b187f6ba70d5be380a1bf42d2b32 (test: give CapCut plan fixtures explicit display order). Worktree clean after commit.

The coordinator's subsequent complete-suite run exposed one failure among the 377 handler tests: the CapCut Premium Apps/USD fixture expected its four labels and callback IDs in insertion order, but the six-month plan appeared first. The archived RED evidence is fixture-failed-full-tests.log in this execution-ledger directory. The coordinator reran that exact case unchanged in isolation: 1 passed/376 skipped in 8.79 seconds (.review-handler-isolation.log).

Read-only investigation established that all four fixture denominations have price 4480 and default sortOrder 0. getCatalogProductWithDenominations sorts only by sortOrder and price; browseProduct and denominationPickerKb retain the returned order. Both the fixture and that production ordering behavior are identical at baseline 2250bf48. Consequently, the exact insertion-order assertion relied on SQL ordering among equal sort keys. The isolated pass versus whole-file failure confirms test nondeterminism under the larger database workload, not a functional regression from the fixes.

After the coordinator stopped the suite and authorized the correction, the only test change adds sortOrder: made.length to those four fixture inserts, explicitly setting their intended order. Exact label, price, stock and callback assertions remain. No production code changed. Full handlers.test.ts passed all 377 cases, exit 0, in 71.57 seconds (task-1-green-handler-fixture.log). Test-source TypeScript and git diff --check pass.

The coordinator also requested two plan-only resource wording updates: full-suite verification may use at most two Vitest workers with bounded heap; targeted verification still uses one. Their observed free memory during the single-worker full run was about 2.8–3.2 GB. The chosen full rerun uses maxWorkers=2/minWorkers=1 and NODE_OPTIONS=--max-old-space-size=768, bounding three Node processes' heap allowance to about 2.25 GB. This is the coordinator's resource decision; no other plan semantics or production behavior changed. Final whole-suite verification and scoped review of the fixture adjustment remain with the coordinator.
