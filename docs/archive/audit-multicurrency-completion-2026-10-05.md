# Multicurrency audit implementation

The approved IDR/USD/USDT audit is implemented. This record covers the final behavior, the findings discarded after checking current code, and the checks needed to release the changes. Whole-branch independent review and the final full-suite result are recorded by the controller after implementation.

| Items | Classification | Result |
| --- | --- | --- |
| A1 | Verified real | Typed FX rates and sanity bounds read by shape; exact saved/imported values remain exact; crossed bounds refused. |
| A2 | Already fixed; proposed change discarded | NOWPayments uses invoice USD price and compares paid/required amounts in the same payment currency. Retained the existing half-up invoice policy. |
| A3 | Verified real | Fully wallet-covered purchases use wallet settlement; gateway paths cannot leave a unique-amount dust charge. |
| A4 | Verified real | Overpaid wallet top-ups alert admins on all payment rails; dust below persisted precision does not alert. |
| B5 | Verified real | IDR discounts round half-up to whole rupiah; wallet requests floor to whole rupiah; preview and charge share the calculation. |
| B6, E28 | Verified real | Admin and owner paid-order summaries use reconciled settlement-currency rows, including bulk/voucher discounts, wallet credit and unique amounts. |
| B7 | Verified real | QRIS instructions show the adjustments required to explain the payable. |
| B8 | Verified real | Delivered channel sales amount includes wallet funding and excludes the unique amount. |
| C9 | Partly already fixed | Nonfinite/negative price rejection retained; zero prices and reseller prices above retail now refused. |
| C10 | Partly already fixed | Nonfinite discount caps and negative minimums already refused; nonpositive usage limits and zero discount caps now refused. |
| C11 | Verified real | Top-up input must be canonical, positive, within limits and supported currency precision; malformed inputs return validation errors. |
| C12, E27 | Verified real precision gap | Bot and admin API share wallet-adjustment validation: nonzero, whole IDR, at most four USDT decimals. Signed debits remain supported. API zero rejection was already fixed. |
| C13 | Partly already fixed | Typed markup writes already validated; legacy markup reads now fail safely and resync reports invalid configuration. |
| C14 | Verified real | Dashboard numeric query parameters validated and bounded. |
| C15 | Verified real | Bot voucher gate supports minimum purchases above the old sentinel. |
| D16 | Verified real | Refund item/order budgets use the refund currency, saved FX and actual wallet debit currencies, with parent-order locks. |
| D17 | Verified real | Underpaid QRIS top-up credit excludes fees and is capped at the ordered principal. |
| D18 | Verified real; warning policy | Catalog below-cost badges and deduplicated admin alerts expose supplier cost increases. Reseller and overridden prices keep their existing pricing policy. |
| D19 | Verified real | New order items snapshot catalog unit cost; historical profit readers prefer the snapshot. |
| E20 | Verified real | Rejected orders that released voucher holds no longer produce false voucher drift. |
| E21, E22 | Verified real | Voucher sales include wallet funding; IDR sales-price reports exclude payment rounding/markers; unknown FX is skipped and counted in API and UI. |
| E23 | Verified real | Rounded zero has no negative sign; compact units promote at boundaries; USD hints keep two localized decimals. |
| E24 | Verified real | Browser money uses Decimal, actual storefront language and explicit runtime dependencies; bot labels use the correct currency and width budget. |
| E25 | Documented policy; no behavior change | Referral commission uses external `totalAmount`, net of wallet credit and including collected rounding/markers. Fully wallet-paid orders generate no commission. |
| E26 | Verified real | Logged-in voucher preview applies the same one-use-per-user check as creation and performs no writes. |

## Financial meaning and compatibility

Native per-currency revenue is collected external payment plus actual wallet ledger funding. Combined IDR charts and voucher sales instead show the recorded sales price: canonical IDR subtotal minus stored discounts where a finalized USDT price basis is available. These measures intentionally differ by payment rounding and unique amounts. Wallet row currency is authoritative; historical conversions use saved positive FX, never the live rate. Missing conversion data appears as excluded-order/item counts and chart gaps, rather than invented zero revenue or mislabeled IDR as USDT. See [the sales metrics contract](../sales-metrics-contract.md).

Owner paid receipts use `subtotal - bulk discount - voucher discount - wallet credit + unique amount = displayed payable`. USDT subtotals absorb conversion remainders and native rows display up to four decimals. Legacy fractional IDR rows round half-up and derive the displayed subtotal from the rounded stored payable, absorbing the display residual without changing order, ledger or refund amounts. Unit prices are indicative and marked per unit; the additive subtotal is authoritative. New whole-rupiah rows retain their values. Old queued email payloads without the new rows remain renderable. Buyer receipt behavior is retained.

The final whole-branch review identified two Important findings and one Minor finding. The correction wave prevents malformed imported FX partner bounds from disabling comparison against retained/default bounds, updates the independent parity diagnostic for the recorded-price basis and missing-FX counts, and closes the legacy IDR display residual above. Valid simultaneous FX-band changes and blank-bound disable behavior remain supported. The parity report attributes combined-IDR changes to top-up funding plus an explicit independently calculated sales-basis adjustment; exact residual/drift and missing-FX counts must match. Its old native wallet reconciliation and deliberate broken-world detection remain enforced.

Legacy nullable cost snapshots use the existing live-cost fallback. No historical cost backfill or repair of previously saved malformed FX settings is included. Legacy missing FX requiring a currency conversion needs admin review. NOWPayments half-up invoicing can differ from the order by less than half a USD cent; changing that acceptance policy would affect existing invoices and was discarded.

## Deployment

Apply `20261005100000_add_order_item_cost_snapshot` before running the new code, regenerate the Prisma client, and restart processes using that client, including the order bot. The nullable column has no default or backfill. Starting new code against the old schema causes missing-column errors. Follow [the migration guide](../MIGRATIONS.md). Install the updated lockfile and rebuild both browser clients for their explicit `decimal.js` dependencies and formatting changes.

## Verification pointers

Each behavior fix was reproduced before implementation; already-fixed cases and E25 were characterized without manufacturing failures. Relevant regression files include `cost_snapshot`, `refund_currency_budget`, `idrDiscountRounding`, `orderMoneyRows`, `revenue`, `revenue.sql-crosscheck`, `vouchers`, `reports`, `referrals`, `settlePaidOrder`, `notifications`, wallet API/bot handler tests, and `tests/money-format-client-parity.test.ts`.

E24/E26 consumer verification passed 515 tests across 22 files; E27 passed 483 API/bot tests; E28 passed 288 receipt/notification/dispatcher tests. Both affected browser builds and workspace/test typechecking passed. Migration drift/timestamps, frontend boundaries, storefront lint and detection purity passed before the final review. Tests run against isolated test PostgreSQL schemas with one worker; no production data or services are required.

The final correction wave passed 1,202 targeted tests across 16 files, including the actual admin and owner receipt consumers and independent parity failure cases. Fresh workspace/test typechecking, both browser builds, and all five pretest checks passed on October 6. Root test typechecking now shares Vitest's admin-client import alias so the added rendered receipt regression stays typechecked. The first full suite had 9,979 passes and 11 failures: four test-database setup failures were resolved by initializing only the dedicated test schema; the seven remaining failures were addressed in this correction wave.

The final full-suite run exercised 10,007 tests across 550 files: 10,004 passed and three failed in the unchanged `stock-replacement-api` suite after a 9.92-hour system gap. Those failures were a test timeout, a reset-hook timeout, and a unique Streaming fixture collision; the logged full-suite process exited 1. A fresh isolated rerun of the unchanged suite passed all 25 tests in 42.72 seconds (check and process exit 0). The full-suite run therefore is not reported as green; the controller accepted the isolated rerun under the user-approved flaky-suite ruling, with all 10,007 unique cases accounted for. The independent Astra scoped review was approved with zero open findings after addressing all three findings. No source, test, or configuration changes were made after the tested feature tree.

Old fixtures changed only where they encoded corrected behavior: whole-rupiah discounts, correctly denominated refund/USDT values, raw-USDT-as-IDR fallback, English/Indonesian separators, or a voucher already redeemed before preview. Assertions and consumer tests remain in place.
