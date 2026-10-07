# SDD ledger — plan: docs/superpowers/plans/2026-10-07-digiflazz-review-fixes.md

Base: 2250bf4886d8f7e3a45832e10e7ad879c555d3ef.
User authorizes completing the review, necessary fixes, merge, and push origin/master.
Dedicated test DB: codex-digiflazz-review-pg, localhost 55459.

| Scan | Producer/consumer or requirement consistency | Result |
| --- | --- | --- |
| Task 1 self-consistency | Regression tests cover each named behavior; production steps restore the same contracts | Consistent |
| Sync and admin toggle | Both change availability/provenance; both must share lock ordering | Enforced by task constraints |
| DB wake and worker save | Later credit must reopen only safely editable saved messages; completion must retain concurrent wake | Enforced by task constraints |
| Credentials and settings | Derived cache must expire no later than source settings | Enforced by task constraints |

Initial static review: sync 2 Important findings, dispatch 1 P2 finding, progress 3 P2 findings. No unresolved scope rulings.
Baseline: workspace typecheck and test-source typecheck pass. Both SPA builds pass directly; pnpm Node 26 child shutdown failed once after a successful admin build, and direct Vite rerun passed.
Task 1: in progress; implementer will own all code edits and targeted red/green tests; coordinator owns the complete suite.

Task 1 implementation: a0a9bb68277334c55c3bf9f362c5d6f47b8e46f1. Implementer /root/fix_review_findings. 13 regression cases proven red/green; 450 tests in 6 affected files pass, then 339 tests in 2 locking-related files pass after the additional absent-marker race fix. Report task-1-report.md.
Final review: /root/final_fix_review, package review-2250bf48..a0a9bb68.diff, pending.
Full suite: session 14772; one fork worker, 1024 MB per-process heap limit, output .review-full-tests.log and .review-full-tests.json; pending.
Final typechecks and server bundle pass. Both SPA builds and storefront lint pass; migration drift, migration timestamps, frontend boundaries, and detection-engine purity pass. No new migration introduced by review fixes.

Final review found Important: sync row lock targets products instead of denominations at digiflazz.ts:2506. Schema mapping confirms denominations. Full-suite session 14772 intentionally terminated before completion; partial output is not verification success. Implementer resumed for a controlled real-row locking regression and correction. Waiting for reviewer's complete findings before corrective commit.

Task 1: fix round 1/5; corrective commit fd9d24388f7ce8f1fea9732e610888d901af21bc. One Important finding corrected and reproduced with a real concurrent price-override RED/GREEN regression. Complete Digiflazz/catalog 340 tests pass, test-source typecheck and diff check pass. No other final-review findings. Scoped re-review pending.
Full suite restarted at fd9d2438: session 47433, one fork worker and 1024 MB heap limit. Previous interrupted log archived in this workspace as interrupted-full-tests.log.

Task 1: complete (commits 2250bf48..fd9d2438, final review and scoped re-review clean). Reviewer /root/final_fix_review confirms wrong-table finding addressed, no new findings. Full integration suite remains pending; no merge/push yet.

Verification followup: second full run found a preexisting CapCut test fixture dependent on undefined equal-key SQL order. Isolated case passes; full handlers file fails. Run 47433 intentionally stopped and archived as fixture-failed-full-tests.log. Minimal fixture correction committed 2d28cc02bd47b187f6ba70d5be380a1bf42d2b32: explicit sortOrder only, no production behavior change; all 377 handler tests pass, final test-source tsc and diff check pass. Scoped fixture review pending.
Resource decision: measured free memory stays 2.8–3.2 GB during single-worker run. Full verification now uses at most two fork workers and 768 MB heap per process to reduce elapsed time while bounding allocation; targeted tests retain one worker. Plan updated with this bound.
Current complete suite: session 8727 on 2d28cc02; output .review-full-tests.log and .review-full-tests.json, pending. Earlier partial test output never counted as green-suite evidence.

Fixture review complete: /root/final_fix_review confirms explicit fixture sort matches production policy; label/price/stock/callback assertions retained. No findings. Latest full run passes initial 1007 tests including previously failing handlers file; full result still pending.

Full-run environment issue: integrity.test.ts queries public directly and requires prisma db push on the base test DB (its header states this prerequisite). Coordinator initially provisioned only per-file schemas and omitted base public initialization, causing 4/5 integrity assertions to fail. Base public schema now initialized on dedicated local55459 database; fresh integrity retry passes 5/5 with exit 0. No code change. Let current full run finish to collect all remaining results, then perform a clean full rerun with corrected prerequisites before integration.
