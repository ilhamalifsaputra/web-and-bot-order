# Math-Logic Audit — Pricing, Discounts, Conversion, Reconciliation

**Date:** 2026-07-20
**Scope:** every surface that computes money or quantities — `packages/core`
(`money.ts`, `formatters.ts`, `flash.ts`, `fx.ts`), `packages/db/src/crud`
(`orders.ts`, `pricing.ts`, `vouchers.ts`, `catalog.ts`, `revenue.ts`,
`reports.ts`, `referrals.ts`, `wallet_checkout.ts`, `binance_internal.ts`), and
the three price *previews* that must agree with them: the storefront checkout
(`apps/storefront/src/routes/checkout.ts`), the bot confirmation screen
(`apps/order-bot/src/handlers/checkout.ts`), and catalog/product shaping
(`apps/storefront/src/cards.ts`, `pageData.ts`).
**Nature:** audit **and fix** — all seven findings below are fixed in the same
change that produced this document. `pnpm typecheck` and `pnpm test` (206 files,
2194 tests) are green.

## Executive summary

| Severity | Count |
|---|---|
| High | 1 |
| Medium | 3 |
| Low | 3 |

The arithmetic itself was sound. There is no float money math anywhere in the
order path, `quantizeMoney` is applied consistently, and the currency rails are
kept apart with real care. **Every finding below is a duplication problem, not a
formula problem:** the same price is computed in up to four places, and the
copies had drifted. One of those drifts was live — a buyer could be shown one
total on the storefront checkout page and charged a higher one.

The through-line fix is to make each pricing rule exist exactly once
(`@app/core/flash`, and the new `@app/core/bulk`) and have every screen and every
order path call it.

---

## §1 Findings

### F1 [HIGH] — the storefront quoted a total it would not charge
**Where:** `apps/storefront/src/routes/checkout.ts` (`computeTotals`).

The preview capped the voucher against the **gross** subtotal, while
`createOrderFromCart` (`packages/db/src/crud/orders.ts`) caps it against the
subtotal **net of the bulk discount** — the deliberate Money-2 rule from
`docs/audit-backend-2026-07-06.md`. With both a bulk rule and a percent voucher
on one cart the two disagreed:

> Subtotal Rp80.000, bulk 25% (Rp20.000), voucher 50%.
> Preview: 50% of Rp80.000 = Rp40.000 off → **Rp20.000** shown.
> Charged: 50% of Rp60.000 = Rp30.000 off → **Rp30.000** taken.

Three consequences from the one line: the quoted `total_usdt` was derived from
the wrong figure; the client's "wallet credit fully covers this" decision
(`CheckoutPage.tsx`) was made against the wrong figure, so the all-or-nothing
wallet rail could be offered and then rejected by
`completeCartOrderWithWalletCredit`'s zero-total assertion; and the voucher's
`minPurchase` was validated against the gross subtotal, so a voucher could pass
on screen and then throw `error.voucher_min_purchase` at the last step.

The bot's confirmation screen already applied the voucher to a bulk-reduced
subtotal. Only the storefront diverged.

**Fixed:** pass `subtotal.minus(bulkDiscount)`, matching the order path exactly.
**Regression test:** `apps/storefront/test/spa-api.test.ts` — "quotes the same
total it charges when a bulk discount and a voucher stack (math audit F1)".
Verified to fail on the pre-fix code with `expected '40000' to be '30000'`.

### F2 [MEDIUM] — asymmetric zero-clamp between the two order creators
**Where:** `packages/db/src/crud/orders.ts` (`createOrderDirect`).

`createOrderFromCart` clamps `afterDiscount` at zero; `createOrderDirect` did
not. It was structurally safe (its voucher is capped at `subtotal − bulk`, and
the bulk percent is bounded at write time) — but that safety rested on a
write-time guard alone (see F3), and the two functions being spelled differently
is precisely what produced Money-2 in the first place. A negative here would be
persisted as a negative `walletUsed`/`totalAmount`, corrupting the audit trail.

**Fixed:** `Decimal.max(ZERO, …)`, identical to the cart path.

### F3 [MEDIUM] — bulk-pricing rules were trusted at read time
**Where:** `packages/db/src/crud/catalog.ts` (`upsertBulkPricing`) and every
consumer of the stored row.

`upsertBulkPricing` rejected a percent outside `(0,100]`, but nothing re-checked
the row when it was *used*. `activeFlashPercent` already establishes the opposite
convention for the same class of row, and documents why: a row written before the
guard existed, or written by hand against the shared SQLite file, must not be
able to zero out a price. `minQuantity` was never validated at all — `0` or a
negative turns a "buy 5+, save 20%" promotion into a permanent price cut.

**Fixed:** new `packages/core/src/bulk.ts` (`activeBulkPercent`, `isBulkActive`,
`bulkDiscountFor`) validates the stored rule on **read**, mirroring `flash.ts`;
`upsertBulkPricing` now also rejects `minQuantity < 1` with the new
`error.invalid_min_quantity` key (added to both locale files). The storefront's
catalog badge goes through `activeBulkPercent` too, so a card can never advertise
a rule checkout would refuse to honour.

### F4 [MEDIUM] — the bulk discount had two spellings
**Where:** `apps/order-bot/src/handlers/checkout.ts` vs
`packages/db/src/crud/orders.ts`.

The bot's confirmation screen reduced the subtotal with
`subtotal × (1 − percent/100)`, unquantized; the order subtracted
`quantize(subtotal × percent/100)`. Algebraically identical, numerically
identical only up to rounding — the same latent divergence class as F1, on the
same screen pair.

**Fixed:** both call `bulkDiscountFor`, and the bot quantizes its subtotal the
way `createOrderDirect` does.
**Regression test:** `apps/order-bot/test/handlers.test.ts` — "quotes the same
bulk-discounted total the order charges (math audit F4)".

### F5 [LOW] — flash prices carried sub-rupiah cents
**Where:** `packages/core/src/flash.ts` (`flashPrice`).

Quantized to 2 decimals on a central-**IDR** price model, so a discounted
denomination could cost Rp33.499,33 while the IDR rail quantizes the order total
to whole rupiah at pay time. Per-line figures and the charged total could
disagree by up to a rupiah, with `formatIdr` rounding each line independently so
the gap never showed.

**Fixed:** quantize to 0 decimals. The admin's live preview in
`DenominationEditPage.tsx` was rounding to 2dp as well and now rounds to whole
rupiah, so what the admin previews is what the server stores.

### F6 [LOW] — catalog and product pages quoted flash prices to resellers
**Where:** `apps/storefront/src/cards.ts`, `apps/storefront/src/pageData.ts`.

Both priced with `flashPrice`, which ignores `resellerPrice` by design. A
reseller is actually charged `min(resellerPrice, flashPrice)`, so a reseller
whose standing price is the cheaper of the two was quoted **more** than they
would pay.

**Fixed:** both now price with `effectiveUnitPrice` against the viewer's role
(threaded from `optionalCustomer` in `routes/apiPages.ts`), and the flash badge
only appears when the flash price is the one that actually won — the rule
`flashViewFor` already applied to cart lines.

### F7 [LOW] — reconciliation assumed `walletUsed`'s currency
**Where:** `packages/db/src/crud/reports.ts` (`reconcileFinances`).

`Order.walletUsed` is a bare number with no currency of its own: on a USDT order
it is USDT (debited *after* the IDR→USDT conversion), on an IDR order it is IDR
(debited *before* any conversion). That the two never mix on one order held only
by caller discipline — `createInternalOrder` and both `wallet_checkout` rails each
deliberately withhold the IDR `walletAmount`. Nothing enforced it, and a future
caller passing both would have made every affected order look like drift while
the real error went unnamed.

**Fixed:** the wallet leg is now read from `WalletTransaction` rows, which carry
a `currency`, and each leg is subtracted in its own currency at the right point
in the conversion. Orders predating the ledger's `orderId` stamping fall back to
the historical interpretation.

---

## §2 Verified clean

Re-derived and found correct; recorded here so the next audit does not repeat the
work.

- **Decimal discipline.** No float money arithmetic in the order path. The only
  `Number()` calls on money are test assertions, gateway payload parsing, and
  two client-side display comparisons the server re-checks.
- **`computeUniqueCents`.** The 0.002 step is deliberately larger than the
  payment matchers' 0.001 tolerance, and `core.test.ts` pins that adjacent order
  ids stay more than one tolerance apart.
- **`orderItemRevenueIdr`.** The "never multiply `OrderItem.unitPrice` by
  `fxRate`" rule is enforced through a single helper, with the past inflation bug
  documented at the call site.
- **Referral commission.** Converts an IDR order's total with the order's own
  `fxRate` snapshot (falling back to the live rate), then takes the configured
  percent — no double conversion.
- **`applyUsdtWalletToOrder`.** Clamps to the payable amount and to the available
  balance, and deliberately leaves the unique cents payable on-chain.
- **`fx.ts` rounding.** `roundRateToStep` is half-up on a validated positive step
  and returns the rate unrounded for a missing/invalid step.
- **Currency separation on wallet rails.** `createInternalOrder` destructures
  `walletAmount` away from `createOrderDirect` so an IDR debit can never land on
  a USDT order; both `wallet_checkout` rails do the same.

## §3 Files changed

| Area | Files |
|---|---|
| New shared rule | `packages/core/src/bulk.ts` (+ `bulk.test.ts`) |
| Pricing core | `packages/core/src/flash.ts`, `index.ts`, `package.json`, `locales/{en,id}.json` |
| Order paths | `packages/db/src/crud/orders.ts`, `catalog.ts`, `reports.ts` |
| Previews | `apps/storefront/src/routes/checkout.ts`, `cards.ts`, `pageData.ts`, `routes/apiPages.ts`, `apps/order-bot/src/handlers/checkout.ts` |
| Admin | `apps/web-admin/client/src/pages/DenominationEditPage.tsx` |
| Tests | `apps/storefront/test/spa-api.test.ts`, `apps/order-bot/test/handlers.test.ts`, `packages/db/src/crud/order_creation.test.ts`, `packages/core/src/flash.test.ts` |
