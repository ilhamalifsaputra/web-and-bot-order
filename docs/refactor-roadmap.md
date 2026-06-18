# Incremental Refactor Roadmap (execution/09)

Technical-debt paydown via **small, behaviour-identical** steps — one unit per PR,
tests as the safety net. **No big-bang refactors** (CLAUDE.md: bot UX is a
contract; storefront grids must render identically).

Order = ROI↑ / risk↓. Each unit: file · extraction · safety net · DoD.

## ✅ A-04 — dedup `card()` ↔ `shapeEntries` — DONE

- **File:** `apps/storefront/src/routes/catalog.ts`.
- **Change:** `/c/:id` built group cards inline + shaped products via a local
  `card()` that duplicated `cards.ts` `shapeEntries`. Deleted `card()`; `/c/:id`
  now calls `shapeEntries(entries, catName, stock, ratings, bulk)` — the same
  shaper as `/search` and home. Dropped the now-unused
  `listActiveProductsWithCategory` read (entries already carry the products).
- **Safety net:** characterisation test in `storefront.test.ts` ("renders group
  cards and ungrouped product cards on a category page") — locks group `/g/:id`
  card, ungrouped `/p/:id` card, "from" price, and that grouped members are not
  emitted as standalone cards. Written + green **before** the change, still green
  after.
- **Identical-behaviour proof:** group/product field-by-field match; both old and
  new order products by name asc (`listActiveProductsWithCategory` and
  `listCatalogEntries` both `orderBy name`); category page ⇒ member `categoryId`
  == page category, so `catName` lookup == old `category.name`. Full suite 523 green.

## ◐ A-02 — split `handlers/checkout.ts` (809 LOC) — IN PROGRESS (multi-step)

Cohesive seams extracted one at a time into `handlers/checkout/*`; the public
entry stays `handlers/checkout.ts` (thin), re-exporting so `import * as checkout`
callers (callbacks, conversations) never move. Behaviour identical each step.

- **✅ Step 1 — timers module.** Moved the countdown/reminder machinery
  (`timersByOrder`/`activePaymentByChat` maps, `setActivePayment`,
  `clearActivePayment`, `cancelPaymentJobs`, `schedulePaymentJobs`,
  `formatCountdown`, `editPaymentBubble`, `countdownTick`, `paymentReminder`) to
  `handlers/checkout/timers.ts` (161 LOC). `checkout.ts` imports what it needs and
  re-exports the three public timer fns. **809 → 676 LOC.** Safety net: existing
  `handlers.test.ts` (`checkout.cancelPaymentJobs`/`buyNow`) +
  `conversations.test.ts` + `bybit-deposit.test.ts`. Full suite 523 green.
- **▶ Step 2 (next) — per-method handlers.** Extract `buyNow` (Binance Pay),
  `buyNowInternal`, `buyNowBybit`, `buyNowTokopay` to
  `handlers/checkout/{binance,bybit,qris}.ts`, factoring the shared preamble
  (`requireUser`, pending-count guard, voucher scratch, rate) into a small
  `checkout/shared.ts`. One method per PR; no i18n-key or keyboard changes.
- **DoD per step:** `pnpm -r typecheck && npx vitest run` green; zero diff in
  emitted Telegram text/keyboards; one reviewable PR.

## ⏳ Scheduled (one PR each, after A-02)

| Unit | File | LOC | Extraction sketch | Net | Risk |
|---|---|---|---|---|---|
| A-01 | `order-bot/src/conversations/admin.ts` | ~934 | split admin wizards by domain (pricing / stock / branding / broadcast) into `conversations/admin/*`; keep the registration surface | bot admin tests + characterisation per wizard | Med (UX contract) |
| A-03 | `packages/db/src/crud/orders.ts` | ~765 | peel cohesive helpers (creation vs finalize vs reporting) into focused modules under `crud/orders/*`; keep exports | crud unit tests (already strong) | Low–Med |
| A-05 | `order-bot/handlers/customer.ts` (~748), `handlers/admin.ts` (~651), `web-admin/routes/catalog.ts` (~584) | — | same per-section strangler; lowest priority | per-area tests | Med |

## Rules (every unit)

1. One unit per PR; never combine extractions.
2. Characterisation test **first** (lock current behaviour), then extract.
3. Public signatures preserved; re-export from the old path so callers don't move.
4. `pnpm -r typecheck && npx vitest run` green; output byte-identical.
5. Branch `refactor/<id>-<slug>` → review → merge.
