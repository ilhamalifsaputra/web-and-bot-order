
## P5 bulk catalog report
- tests/helpers/gameTopupBulkCatalog.ts: `buildBulkGameTopupCatalog(prisma, { tag })`, data-driven tables (18 plain games in "Game Top Up", 12 regional games in "Regional Games" with 2-4 region products each, 2 multi-edition games in "Game Editions" with variant x region, 8 Premium Apps with 3-6 plans). Same tag, find-before-create, crud helpers only, fake `fixture-*` supplierSku only.
- Script: `--bulk` flag (parseSeedArgs in scripts/lib/seedGameTopup.ts), usage text updated; `--remove` already removes every tagged row (verified by a bulk round-trip test).
- Tests: tests/helpers/gameTopupBulkCatalog.test.ts, scripts/lib/seedGameTopup.test.ts, tests/helpers/gameTopupFixtures.test.ts: 3 files pass; `tsc -p tsconfig.test.json --noEmit` clean. Note: implementation was written before the test (no separate RED run).
- Applied to bot_order_gtr (8.7 s): 32 games, 37 game-region pairs, 59 game + 8 premium = 67 bulk products, 743 bulk denominations. Tagged rows now: 5 categories, 74 products, 753 denominations, 1 user.
- Design note: regional/edition products live in separate GAME_TOPUP categories because a category that mixes regioned and region-less products skips the region picker.
