# Pricing & Margins — continuation

Branch: `worktree-pricing-margins-finish`. Continues commits through `6304d3ad` from the interrupted session; the locked original worktree is preserved.

- [x] T1: Pure pricing resolver (`313931aa`).
- [x] T2: Category migration, pricing policy CRUD and reprice (`ae0c1a94`, `979ec4eb`).
- [x] T3: Finish Digiflazz preview integration, category-aware bot edits and PATCH auto/manual regression fix. Sync/import portion exists in `6304d3ad`.
- [x] T4: Pricing API, authorization, validation and Settings write separation.
- [x] T5: Admin catalog pricing metadata.
- [x] T6: Pricing & Margins page, sidebar and Settings cleanup.
- [x] T7: Catalog source/margin display and automatic/manual price controls.
- [x] T8: Sync master, full typecheck/tests, UI verification and final report.

## Invariants

Stored `digiflazz_markup_*` values stay authoritative; no default/backfill. Category overrides global, manual SKU overrides both. Rounding defaults to `none`. Policy changes affect stored prices only on sync or explicit Apply now. Premium Apps keep manual prices. Orders, checkout and payment snapshots are unchanged.

## Verification

Focused API/UI checks and Playwright browser smoke passed. Final full typecheck and tests passed: 611 files, 11,457 tests. The first full run exposed a Digiflazz circular-import initialization issue; it was reproduced alone, fixed, and verified by the final full run. See `docs/pricing-margins-report.md`. Used isolated Postgres on port 5549, admin/storefront ports 8319/8320. No production changes or provider calls.

User request: delegate final merge and push to Luna after the full gate passes.
