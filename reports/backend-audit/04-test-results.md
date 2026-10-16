# 04 - Test results

All results below are as reported by the task reports (`.superpowers/sdd/task-N-report.md`, `fixwave-report.md`); this document was written without running anything. Per-task runs were focused (`pnpm exec vitest run <path>`), never the full suite. Typecheck commands: `pnpm --filter <pkg> typecheck` and `tsc -p tsconfig.test.json`.

## Baseline (7d92dcfa)
- `pnpm typecheck` green (about 80 s).
- `pnpm test:guards`: 198/198.

## Honesty notes
- RED was by construction for some items: the Task 1 nonce tests for the finish step were written together with the fix (no separate RED run); the bot download cap RED (B13) was by inspection of the old `res.text()`, with no swap-back run; the fix-wave tests for SMTP_RECIPIENT/SMTP_REJECTED and for nonce invalidation/clearing are characterization tests of existing behavior (no source change); the `notificationIsolation.test.ts` tests use a mock tx.
- Some existing tests were changed because they pinned the defect: Task 1 wizard tests (owner ids pushed into `config.ADMIN_IDS`), Task 2 "CANCELLED is terminal" pin narrowed, Task 4 `topup-order-api.test.ts` and `wallet-topup-api.test.ts`, Task 6 assertions on FAILED/SENT behavior and one retry test using a backed-off PENDING row.
- A8, A9 and B10 RED/GREEN figures come from a summary table only.

## Task 1 (A1, B9, B12)
- Added: `startupWarnings.test.ts`, `login-limiter-cap.test.ts`, new cases in `web.test.ts` (ADMIN_IDS refusal, 429s, finish-step nonce; /setup/shop limit).
- RED: module missing; `loginLimiterSizes is not a function`; `resetSetupRateLimit is not a function`.
- GREEN: initial 3 files, 648 tests; after review round 1: `pnpm exec vitest run apps/web-admin/test/web.test.ts apps/web-admin/test/login-limiter-cap.test.ts packages/core/src/startupWarnings.test.ts` gave 3 files, 652 passed. `pnpm test:guards` 198 passed. Typechecks (web-admin, core, test tsconfig) clean.

## Task 2 (A2, B11)
- Added: describe block in `bybit_bsc_deposit.test.ts` (3 tests, real DB transactions with a concurrent write on a separate connection); `wallet_topup.test.ts` (late and on-time credit history); `orderStatus.test.ts` (edge and kind restrictions).
- RED: bybit 3 failed | 38 skipped (41); wallet_topup/orderStatus 7 failed | 3 passed | 121 skipped (131).
- GREEN: 3 files, 172 passed; related 15 files, 488 passed; other gateway/order crud 13 files, 356 passed. `@app/db` typecheck and test tsconfig clean.

## Task 3 (A3)
- Added: `settlePaidOrderNotifyIsolation.test.ts` (7 tests).
- RED: 7 of 7 failed. With the savepoint disabled: 3 of 7 failed with `25P02`.
- GREEN: 7/7; regression set (settlePaidOrder, orderStatus, emailEvents, automaticFulfillment, orderItemStatus, ledger_postings, fulfillmentMessages, dispatchTriggerGuard, notifications) 364/364; payment rails and wallet files 607/607; `pnpm test:guards` 198/198; typechecks clean.

## Task 4 (A6, A7)
- Added: `apps/storefront/test/checkout-quote-dedupe.test.ts` (18), `packages/db/src/crud/quote_binding.test.ts` (5), 4 tests in `idempotency.test.ts`.
- RED: `checkout-quote-dedupe.test.ts` 8 failed / 10 passed (the cart concurrent test passed: verified-no-change).
- GREEN: after A6, api, spa-api, topup-order-api, wallet_checkout, zero_total_checkout, wallet_cart_checkout_concurrency 269/269; after A7, `idempotency` + `checkout-quote-dedupe` 38/38; topup-order-api, wallet-topup-api, service-channel, checkout-quote-dedupe, idempotency, guest-checkout-api 140/140. `pnpm test:guards` 198/198. Typechecks clean.

## Task 5 (A8, A9, B8, B10, B13)
- Added/updated: guest-checkout-api (A8), support-api (A9), route-id-params and support-api (B8), route-id-params (B10), `boundedBody`, photo and bot tests (B13).
- RED per item: A8 signed-in user got 200 not 429; A9 2 and 3 tickets; B8 500 on 9 admin list routes + 3 id routes and storefront ids/`page=1e999`; B10 readonly got 404 not 403; B13 proxy 200 for oversize.
- GREEN: guest-checkout-api 21/21; support-api 24/24 then 27/27; route-id-params 87/87; boundedBody 5/5; photo tests 9/9; bot 3/3. Typecheck clean: core, storefront, web-admin, order-bot, test tsconfig.

## Task 6 (B1-B5, B7)
- Added/updated: ownerEmail, notifications (retry, `markNotificationSkipped`), storageMaintenance prune, emailEvents, dispatcher, `outbox-reviews-api`.
- RED before fix: ownerEmail 2, notifications 2, storageMaintenance 1, emailEvents 24, dispatcher 10. Review-fix RED: `pnpm exec vitest run packages/outbox-dispatcher/src/dispatcher.test.ts apps/web-admin/test/outbox-reviews-api.test.ts` gave 6 failed | 114 passed.
- GREEN: outbox-dispatcher 371 tests plus db and web-admin sets; review-fix GREEN: `pnpm exec vitest run packages/outbox-dispatcher apps/web-admin/test/outbox-reviews-api.test.ts packages/db/src/crud/{notifications,ownerEmail,emailEvents}.test.ts` gave 11 files, 578 passed. Typechecks clean: db, outbox-dispatcher, core, web-admin.

## Task 7 (B6)
- Added: "ticket-closed buyer notification (B6)" in `support.test.ts` (6 tests); updated jobs.test.ts autoClose failure injection (now a `$transaction` spy).
- RED: 5 of 6 failed.
- GREEN: support, notifications, templates 314 passed; jobs autoClose 2; handlers "ticket close" 3; dispatcher TICKET_CLOSED 13; web-admin users-vouchers-support-audit-api 114. Typechecks clean: db, outbox-dispatcher, order-bot, web-admin.

## Fix wave (e123731b)
- `support.test.ts` "reused" (RED = flag did not exist, GREEN); `notificationIsolation.test.ts` (2, GREEN); dispatcher SMTP characterization tests (GREEN); `web.test.ts` nonce tests (GREEN); spa-api duplicate test still green. Typecheck for db, storefront, web-admin, outbox-dispatcher and `tsconfig.test.json` clean.

## Gate typecheck log
`.superpowers/sdd/gate-typecheck.log` holds a `pnpm typecheck` run in the worktree; its first lines show all package typechecks starting and the first ones finishing. (The tail was not inspected for this report.)

## Final full gate
Run on the final code (HEAD 32a94d41 plus the test-only fix below), against an isolated Postgres.

- `pnpm -r --workspace-concurrency=1 typecheck` then `tsc -p tsconfig.test.json`: exit 0. (Run one package at a time because the machine had about 2 GB free; the parallel run had been killed for memory.)
- `pnpm test -- --maxWorkers=2` (includes the pretest guards: migration drift/timestamps, frontend boundaries, storefront lint, detection purity): 642 of 644 files and 11,981 of 11,984 tests passed.
- 3 tests failed, reproducibly when re-run alone, so they were real, not load flakes:
  `web.test.ts` "approve → DELIVERED + outbox rows" and "manual match unmatched tx → delivered + ledger updated", and `automaticFulfillment.test.ts` "alerts once when terminal failure is repeated". All three still asserted the old rule that a disabled email is stored as `FAILED`. Task 6 (B1) deliberately changed that to `SKIPPED`, so the assertions were updated to `SKIPPED` (test-only change, no production code touched).
- Re-run of those two files after the update: 661 of 661 passed.
- Not re-run: the whole suite a second time after this test-only edit.

