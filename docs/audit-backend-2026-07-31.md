# Backend Audit — Delta since 2026-07-06 + Full Pass on High-Risk Areas

**Date:** 2026-07-31
**Scope:** `apps/server`, `apps/order-bot`, the Fastify route layer of `apps/web-admin`
and `apps/storefront` (server side only — the React SPAs under `client/` were out of
scope), `packages/core`, `packages/db`, `packages/outbox-dispatcher`, and
`prisma/schema.prisma` + `prisma/migrations/*`. ~37,000 lines of backend source.
**Nature:** READ-ONLY — no code was changed during this audit. Findings are for review
and prioritization before any fix lands.
**Baseline:** `pnpm typecheck` clean across all workspaces; `pnpm test` green
(250 files / 3,106 tests). Every finding below is a latent defect that the existing
suite does not catch.
**Methodology:** 7 parallel agents. Four ran a *full pass* over the highest-risk areas
(money/reconciliation, order-checkout-stock, payment gateways, auth/CSRF); two audited
the *delta* of the 211 commits landed since the last backend audit (order-bot; data
layer + schema); one acted as a dedicated **regression verifier** against the two prior
audits. Each agent was required to dedup against `docs/audit-security-2026-06-23.md`,
`docs/audit-backend-2026-07-06.md`, `docs/audit-matematika-2026-07-20.md`,
`docs/audit-per-sku-delivery-flows-2026-07-13.md` and `docs/audit-fitur-md-2026-07-04.md`,
and to report only genuinely new issues, regressions, or explicitly-deferred items.
Every High below was then re-verified by hand against the source before inclusion.

## Executive summary

| Severity | Count |
|---|---|
| High | 9 |
| Medium | 37 |
| Low | 26 |

### The good news first: nothing regressed

All **6 High findings** from `audit-backend-2026-07-06.md` are **FIXED**, each with a
traceable commit. All spot-checked Mediums and Lows from that audit landed too. Every
**Critical and High** from `audit-security-2026-06-23.md` **held** across the 211
commits since. There is not a single REGRESSED or NEVER-FIXED item in this audit.
Full table in §0.

### Top items by impact

1. **[HIGH]** Every **discounted QRIS order is silently unpayable**. `7064b94` changed
   what is *sent* to TokoPay to the net `totalAmount` but left the *verification* side
   deriving its fee from the gross `subtotalAmount`. Any order with a voucher, bulk
   discount, or wallet credit fails the short-payment gate — the buyer pays, the webhook
   refuses to deliver, the poller repeats the same refusal every cycle, and the expiry
   job cancels the order. Money in, nothing out, no admin alert. Found independently by
   two agents. → §1 H-1
2. **[HIGH]** A **paid `PROCESSING` order can be rejected into a terminal state that
   `creditOrderToBalance` then refuses forever** — `canReject` was widened to include
   `PROCESSING`, `canCredit` was not. The buyer's money becomes unrecoverable without
   hand-editing SQLite. → §2 H-2
3. **[HIGH]** **Every customer's bcrypt password hash and email are serialized into
   admin API responses**, reachable by the lowest-privilege `readonly` admin role. → §4 H-4
4. **[HIGH]** A **failed gateway delivery permanently consumes its idempotency claim**,
   so the reconcile poller can never retry the payment — the order auto-cancels while the
   money sits in the merchant account. → §2 H-3
5. **[HIGH]** **`POST /setup/restart` is permanently unauthenticated, un-CSRF'd, and
   never locks** after setup completes — an unauthenticated loop reboots the single
   process hosting the bot, storefront and admin panel. → §4 H-5
6. **[HIGH]** **12 columns and 2 indexes exist only in `schema.prisma` with no migration
   SQL anywhere** — the two biggest features of the quarter (flash sales, per-SKU
   delivery) shipped with zero migration folders. → §6 H-8

### Cross-cutting pattern

The prior audit found its bugs at *migration seams*. This one finds them at a different
seam: **the same business rule implemented on two surfaces, where only one surface got
the fix.** H-1 (send-side updated, verify-side not), H-2 (`canReject` widened,
`canCredit` not), H-4 (the ticket JSON got a projection, users/orders/payments did not),
Order-4 (storefront got `claimGatewaySlot`, the bot did not), Order-10 (bot got
`refuseDuplicateCheckout`, storefront did not), Sec-3 (storefront rotates the session
jti on password change, admin does not), Pay-2 (TokoPay got a live re-check, PayDisini
did not), Pay-6/Pay-7 (three rails alert on overpayment, three do not), Bot-8 (five jobs
carry `protect: true`, four do not). In almost every case the *second* surface is the one
that was written later or fixed later — the fix was applied where the bug was reported
rather than to the rule. The structural remedy is to push each of these rules down into
one shared helper (mostly in `packages/db/src/crud/*`) that both surfaces must call,
which is exactly what `computeEligibleAmounts` and `claimGatewaySlot` already do
successfully elsewhere.

A second, quieter pattern: **`Decimal` is used everywhere, but never validated for
finiteness.** `new Decimal("NaN")` constructs happily and returns `false` from every
inequality guard in the codebase, including the reconciliation drift check (§1 M-3).

---

## 0. Status of prior audit findings

### `audit-backend-2026-07-06.md` — all 6 High FIXED

| ID | Status | Evidence |
|---|---|---|
| Money-1 (USDT ignored by `reconcileFinances`) | **FIXED** | `packages/db/src/crud/reports.ts:135-142`, commit `e39aac5` |
| Data-1 (`bulkAddStock` dedup race) | **FIXED** | `apps/web-admin/src/routes/api/stock.ts:133` now wraps in `$transaction`, commit `48f39aa` |
| Data-2 (gateway-invoice race) | **FIXED** | `claimGatewaySlot`/`commitGatewayResult`/`releaseGatewaySlot`, `orders.ts:155-221`, commits `1610152`/`2a7a4ee`/`e2ddd34` |
| Security-1 (reset token in access log) | **FIXED** | `apps/storefront/src/server.ts:43-45` — anchor dropped, `/g` added, applied in both the access-log hook and the error handler, commits `d56cb65`/`42b25fc` |
| Outbox-1 (infinite re-claim loop) | **FIXED** | `packages/outbox-dispatcher/src/dispatcher.ts:160-163` → `releaseNotificationClaimWithBackoff`, commit `b8b1ab6` |
| Log-5-1 (ban/unban writes empty audit details) | **FIXED** | `apps/order-bot/src/conversations/admin.ts:486-530`, commit `a76044e` |

All 8 Mediums fixed as well (Schema-3 taken as the documented-limitation option, per that
finding's own offer). Spot-checked Lows — Log-5-4/5/6/7, Security-2, Data-4, Outbox-5 —
all landed.

### `audit-security-2026-06-23.md` — all Critical/High HELD

Bot-1 (CRIT, `adminOnly` on privileged commands), Checkout-1 (duplicate-checkout guard,
now covering 7 rails, up from 5), Checkout-2/Stock-1 (reservation-at-creation),
Payment-1 (live `checkTransaction` decides paid, not the callback body), Payment-2
(`USE_UNIQUE_CENTS` hard gate, extended to the newer BSC rail), Pricing-1 (voucher
per-user redemption), Admin-1 (`checkSetupLock`, with a residual — see M-30), Admin-2/
Infra-1 (`readonly` default on admin-add), Bot-2 (atomic delivery claim), Infra-2
(outbox claim + stale reclaim, strengthened with an urgent-vs-broadcast split).

> Note: git history is squashed at `e2f261c` (2026-06-27), so the 06-23 fixes have no
> individually-blameable commits and were verified by present-state code inspection.

---

## 1. Money, pricing, FX, reconciliation

### H-1 [HIGH] — TokoPay's expected charge is derived from the gross subtotal while the gateway bills the net total; every discounted QRIS order is rejected as short-paid
`packages/core/src/payments/tokopay.ts:47,57` · `apps/storefront/src/routes/checkout.ts:565,759,775` ·
`apps/order-bot/src/handlers/checkout.ts:1048,1054` · `apps/order-bot/src/payments/tokopayReconcile.ts:100`
· `packages/db/src/crud/tokopay.ts:141`

*(Reported independently by both the money agent and the payments agent — the strongest
signal in this audit.)*

Commit `7064b94` changed the nominal sent to TokoPay from the fee-inclusive grand total
to the base `order.totalAmount`, on the correct basis that TokoPay adds its own admin fee
on top of `nominal` (`tokopay.ts:56-58` documents exactly this). It did **not** change the
verification side, which still computes:

```ts
qrisChargeAmount(totalAmount, subtotalAmount) = totalAmount + 100 + 0.007 × subtotalAmount
```

`subtotalAmount` is the **gross, pre-discount** figure (`orders.ts:452,655`);
`totalAmount` is net of bulk discount, voucher and wallet credit (`pricing.ts:141-151`).
Before `7064b94` both sides used the same base and agreed. They now diverge by
`0.007 × (subtotal − total)` on any order carrying a discount.

**Failure scenario.** Subtotal Rp1,000,000, voucher −Rp100,000 ⇒ `totalAmount`
Rp900,000. We send `nominal=900,000`; TokoPay bills the buyer 900,000 + 100 +
0.7%×900,000 = **Rp906,400**, which the QR shows and the buyer pays. The webhook computes
`expectedCharge` = 900,000 + 100 + 0.7%×1,000,000 = **Rp907,100**, hits
`live.amount.lessThan(expectedCharge)` (`checkout.ts:775`), logs "short-paid", records the
transaction `unmatched`, and returns without delivering. `reconcileOrder` repeats the
identical comparison every poll cycle, so the order sits `PENDING_PAYMENT` until
`autoCancelExpiredOrders` cancels it. **The buyer has paid and receives nothing,
permanently, and the only signal is an incremented `unmatched` counter.** Two secondary
effects: the checkout and pay pages quote a `qris_grand_total` (`checkout.ts:176,544`) and
the bot caption quotes a fee (`handlers/checkout.ts:1048`) that both contradict the QR the
buyer is actually looking at; and the overpayment alert at `tokopay.ts:141-156` is
suppressed, because `expectedCharge` is inflated above the threshold a real overpayment
would cross.

**Fix.** Make the fee base the amount actually sent — `computeQrisAdminFee(order.totalAmount)`
— in `qrisChargeAmount` and both display sites. Safer still: drop the local fee
re-derivation from the two short-payment gates entirely and compare against the
`total_bayar` TokoPay itself returned at `createTransaction` time (already cached in
`order.paymentRef`), treating the gateway's surcharge as opaque.

### Medium

- **M-1 — Dashboard profit and margin ignore every discount, so a loss-making promo reads as profitable.**
  `packages/db/src/crud/revenue.ts:31-33` (`orderItemRevenueIdr`), used by `profitSummarySince:269-306`
  and `topProductsByMargin:202-243`. Line revenue is `unitPrice × quantity`, which is never reduced by
  `bulkDiscountAmount`, `discountAmount` or `walletUsed` — those live only on the Order row. 10 units at
  Rp100,000, cost Rp80,000, 30% voucher: charged Rp700,000, true profit −Rp100,000, but the KPI reports
  **profit Rp200,000, margin 20%**. The same endpoint's `revenue` block comes from `revenueSummary` (net
  `totalAmount`), so one response carries two contradicting revenue figures for the same day. *Fix:*
  prorate `bulkDiscountAmount + discountAmount` across lines by each line's share of `subtotalAmount`, or
  rename the card to "GMV".
- **M-2 — An abandoned checkout permanently burns a one-per-user voucher.**
  `packages/db/src/crud/orders.ts:535,695` create a `VoucherRedemption` row; `releaseOrderHolds`
  (`orders.ts:971-979`) rolls back only `usedCount`. Verified: `voucherRedemption` has `create`,
  `findUnique` and `count` call sites and **no delete anywhere in the repo**. After an expired checkout the
  admin's Vouchers page shows the code as unused while `assertVoucherNotRedeemedByUser` throws
  `error.voucher_already_redeemed` for that buyer forever, with no admin surface to clear it. *Fix:* delete
  the redemption row inside `releaseOrderHolds` (only reached from cancel/reject/expire); move
  `getVoucherStats.totalRedemptions` to another source.
- **M-3 — `"NaN"` passes every voucher and wallet bound check and poisons the amount permanently.**
  `apps/web-admin/src/routes/api/vouchers.ts:86,213,233` · `packages/db/src/crud/vouchers.ts:47-61,144-154,299`
  · `apps/web-admin/src/routes/api/users.ts:288-296` · `apps/order-bot/src/handlers/admin.ts:225`.
  Empirically verified against this repo's decimal.js: `new Decimal("NaN")` constructs, and `lte(0)`,
  `gt(100)`, `isNegative()`, `isZero()` and `lessThan(0)` all return `false`; `Decimal.max(0, NaN)` is
  `NaN`. `""` throws (so blanks are caught) and `Infinity` is caught for PERCENT — NaN is caught by
  nothing. `POST /api/vouchers {type:"PERCENT", value:"NaN"}` is accepted, checkout persists
  `totalAmount: NaN`, and the order is unpayable. **`reconcileFinances` will not flag it either** — its
  drift check `expected.minus(o.totalAmount).abs().greaterThan("0.0001")` is also `false` for NaN, so the
  books report clean. The same hole exists on both wallet rails. *Fix:* require `.isFinite()` in all four
  guards, exactly as `activeFlashPercent` (`flash.ts:54`) and `activeBulkPercent` (`bulk.ts:55`) already do.
- **M-4 — The bot's admin surface can neither see nor move the USDT wallet.**
  `apps/order-bot/src/handlers/admin.ts:52,172,215-255`. The user card renders only `walletBalance` (IDR),
  formatted by a helper named `price` that is `formatUsdtAmount` and emits a bare unlabelled number;
  `/wallet <uid> <amount>` takes no currency and defaults to IDR. Referral commissions are always credited
  in USDT (`referrals.ts:70-74`), so a customer with 25 USDT shows `Wallet: 0`; an admin resolving "where is
  my referral credit?" issues `/wallet 42 25`, credits **IDR**, and creates a second wrong balance while the
  real 25 USDT stays untouched — with an audit row reading `Adjusted wallet by 25` and no currency at all.
  web-admin already renders both via `CurrencyStack`, so the two admin surfaces disagree. *Fix:* render both
  balances with explicit labels and add a currency argument to the bot flow.

### Low

| ID | Finding | Location |
|---|---|---|
| L-1 | Admin order-detail money rows don't add up on a USDT order — `usdtFromIdr` is applied per component, which its own doc forbids; a 0.1 USDT hole an admin can't explain | `apps/web-admin/src/routes/orderMoneyView.ts:55-58,66-68` |
| L-2 | `usd_idr_rate` is the one money setting with no plausibility check — a dropped digit is accepted silently and snapshotted onto every order created afterwards | `apps/web-admin/src/routes/api/settings.ts:191-196` vs `crud/pricing.ts:81-90` |
| L-3 | "Today" on the KPI cards (timezone-aware) and "today" on the charts (raw UTC) are different days; everything delivered 00:00–07:00 local lands on the wrong bar | `packages/db/src/crud/revenue.ts:114-137,317-340,358-383` |

---

## 2. Orders, checkout, stock, delivery

### H-2 [HIGH] — A paid `PROCESSING` order can be rejected into a terminal state that credit-to-balance then refuses forever
`packages/db/src/crud/orders.ts:1516-1526` (`computeOrderEligibility`)

Verified at source:

```ts
canCredit: status === OrderStatus.PENDING_VERIFICATION || status === OrderStatus.UNDERPAID,   // :1521
canReject: status === OrderStatus.PENDING_VERIFICATION || status === OrderStatus.PROCESSING,  // :1523
```

`canReject` was widened to include `PROCESSING` by the 07-13 per-SKU delivery fix;
`canCredit` was not. A `PROCESSING` order is a manual-fulfilment order **the buyer has
already paid for through a gateway** (`settlePaidOrder`'s manual branch,
`orders.ts:1387-1416`), so its `walletUsed` is 0 and its `totalAmount` was paid externally.

**Failure scenario.** A buyer pays Rp500,000 via QRIS for a manual SKU; the order lands
`PROCESSING`. The admin cannot source the account and taps the only refund-shaped button
the UI offers — **Reject**. `rejectOrder` runs `releaseOrderHolds`, which returns 0 (no
stock held, no wallet used), and the order becomes `REJECTED`, a terminal state.
`creditOrderToBalance` (`orders.ts:1049-1057`) now throws `error.order_terminal` forever.
The buyer's Rp500,000 is unrecoverable without direct DB manipulation. The same trap fires
via `/api/orders/:id/cancel` and the Orders-page bulk cancel, which accept any non-terminal
status including `PROCESSING`, `CONFIRMED` and `PAID`.

**Fix.** Add `PROCESSING` (and the other paid-but-undelivered states) to `canCredit`,
and/or have `rejectOrder`/`cancelOrder` refuse an order whose `paidAt` is set unless the
caller has already credited it. The 07-13 audit recommended threading through "whatever
compensating action" — only the reject half was implemented.

### H-3 [HIGH] — A failed delivery transaction permanently consumes its idempotency claim, so the payment can never be retried
`packages/db/src/crud/tokopay.ts:84-95,164-168` — identical shape in `paydisini.ts:93,163`,
`nowpayments.ts:95,165`, `binance_internal.ts:201,226`, `bybit_deposit.ts:168,193`

The gateway-transaction claim row is created at `:84`, **outside** the delivery
`$transaction` that starts at `:95`. If anything inside that transaction throws —
`SQLITE_BUSY` under a concurrent writer, the 15s timeout, a transient
`enqueueNotification` failure — the transaction rolls the order back, but the catch at
`:164-168` only re-tags the claim `delivery_failed` and rethrows. **The claim row
survives.** Because `:88` returns `already_processed` for *any* unique violation without
inspecting `outcome`, every subsequent retry is turned away.

**Failure scenario.** A buyer pays via QRIS. The webhook's delivery transaction times out
because a large bot checkout is holding the single SQLite writer (see M-7). The order rolls
back to `PENDING_PAYMENT`. Every reconcile-poller cycle re-calls
`deliverPaidTokopayOrder`, hits the unique violation on the same `trxId`, and returns
`already_processed`, which `tokopayReconcile.ts:135` treats as "nothing to do" — silently.
The order is `PENDING_PAYMENT`, so `canAct` is false and no admin button exists for it;
`autoCancelExpiredOrders` then cancels it at expiry, refunding only `walletUsed` (0).
Buyer paid, order cancelled, no trace but one dashboard counter.

**Fix.** On the failure path, delete the claim row — or make the `already_processed` check
treat `outcome === "delivery_failed"` as re-claimable. Alternatively move the claim
`create` inside the transaction and rely on the unique index alone for the
double-callback guard.

### Medium

- **M-5 — A `deliveryType` edit on a denomination with in-flight orders silently loses stock forever.**
  `apps/web-admin/src/routes/api/catalog.ts:434-490` + `packages/db/src/crud/orders.ts:1377-1379`.
  `settlePaidOrder` reads the **live** denomination row to decide auto-vs-manual, but `deliveryType` is
  freely editable with no in-flight-order guard. A buyer creates an AUTO order for qty 3 (3 `StockItem` rows
  → `RESERVED`); an admin flips the SKU to `manual`; the buyer pays; `settlePaidOrder` takes the manual
  branch, which touches no stock; the admin hand-fulfils to `DELIVERED` (terminal). Those 3 rows are never
  flipped to `SOLD` and never released — `releaseOrderHolds` only runs on cancel/reject/credit — so they are
  permanently excluded from `countAvailableStock`. The reverse edit strands a paid order on
  `error.cannot_deliver_out_of_stock`. *Fix:* reject the edit when non-terminal orders exist, or snapshot
  `deliveryType` onto `OrderItem` at creation (the pattern `warrantyDaysSnapshot` already uses).
- **M-6 — The bot's three gateway rails never got the `claimGatewaySlot` fix the storefront received.**
  `apps/order-bot/src/handlers/checkout.ts:946,1058,1187` each write the cached invoice with a bare
  `prisma.order.update`. The 07-06 Data-2 fix was applied to the storefront's `payView` only, so the same
  flow now has an atomic claim on one front and last-writer-wins on the other. A buyer starting a
  NOWPayments checkout in the bot and opening the same order's pay page on the web can end up with two
  invoices, with the poller watching one while the buyer pays the other. Also raw model access in a handler.
  *Fix:* wrap all three in the existing claim/commit/release trio, as `storefront/routes/checkout.ts:548-583`
  does.
- **M-7 — Storefront checkout runs unbounded per-unit work inside one 5s transaction, holding the single SQLite writer.**
  `apps/storefront/src/routes/checkout.ts:416-464`. `performCheckout` uses Prisma's default 5s timeout (unlike
  `deliverPaidTokopayOrder`'s explicit 15s) while `createOrderFromCart` does per-line pricing and stock counts
  and then, **per unit**, `allocateOneAvailableStock` + an `orderItem.create`. Neither cart line count nor
  total units is capped (`api.ts:153` clamps per-line qty to 99 only). A cart of 10 auto SKUs × 99 units is
  ~3,000 queries in one write transaction — it stalls the bot, every webhook and H-3's delivery transaction,
  then likely times out and rolls back, so the buyer can never complete that cart. *Fix:* cap total units
  server-side and batch the per-unit inserts into one `createMany`.
- **M-8 — `markStockDead` has no status filter, so a delivered credential can be marked dead.**
  `packages/db/src/crud/stock.ts:51-56` vs `bulkMarkStockDead:63-74`, which deliberately restricts to
  `AVAILABLE`/`RESERVED` "so a delivered credential is never altered". The single-item path
  (`POST /api/stock/item/:stockId/dead`) has no such guard. An admin mis-tapping a `SOLD` row in a list that
  shows all statuses corrupts `stockStatusCounts` and destroys the record that this credential was delivered
  to a specific order — the one artifact a warranty dispute is resolved with. *Fix:* give `markStockDead` the
  same guard as an `updateMany` returning a count, and surface "already sold".

### Low

| ID | Finding | Location |
|---|---|---|
| L-4 | The manual branch of `settlePaidOrder` writes no `logAdminAction` on poller-driven settlement, while the AUTO branch does — same business event, audited on one path only | `packages/db/src/crud/orders.ts:1387-1416` |
| L-5 | `attachPaymentProof` is dead code that bypasses `transitionOrderStatus` entirely (no legality check, no history row) — a loaded gun for the next proof-upload feature | `packages/db/src/crud/orders.ts:830-849` |
| L-6 | `releaseOrderHolds` leaves `OrderItem.stockItemId` pointing at a released row; an admin inspecting a cancelled order is shown another buyer's live credential | `packages/db/src/crud/orders.ts:949-960` |
| L-7 | The bot has `refuseDuplicateCheckout`; the storefront has only a `MAX_PENDING_ORDERS = 10` ceiling — same flow, different guardrails | `apps/storefront/src/routes/checkout.ts:416` vs `apps/order-bot/src/handlers/checkout.ts:116-138` |

---

## 3. Payment gateways and webhooks

**Signature verification status — no unauthenticated caller can mark an order paid on any
rail today.** All three inbound webhooks verify before acting, all use `timingSafeEqual`
with a length pre-check, and all fail closed when credentials are unset.

| Rail | Inbound webhook | Signature verification |
|---|---|---|
| TokoPay | `POST /pay/tokopay/callback` | Present (`md5(merchantId:secret:refId)`, timing-safe). Doesn't bind amount/status — mitigated by a live server-to-server `checkTransaction` before delivery. |
| PayDisini | `POST /pay/paydisini/callback` | Present (`md5(apiKey:userKey:refId:amount)`, timing-safe). Binds amount, **not status**, and has **no** live re-check → M-9. |
| NOWPayments | `POST /pay/nowpayments/callback` | Strongest — HMAC-SHA512 over the recursively key-sorted body, timing-safe. Covers status and amount. |
| Binance Internal | Poll-only | N/A inbound; outbound HMAC-SHA256-signed read-only call. |
| Bybit Internal | Poll-only | N/A inbound; Bybit V5 HMAC-SHA256 signing. |
| Bybit BSC | Poll-only | N/A inbound; same V5 signing. The BscScan tracker is unauthenticated but display-only — with the exception in M-11. |

*(The TokoPay fee-base defect is H-1, in §1.)*

### Medium

- **M-9 — PayDisini's callback is trusted on its own word.** `packages/core/src/payments/paydisini.ts:151-182`.
  The signature material is independent of the payment outcome, and `cb.paid` comes from the unsigned
  `body.status`. This is the exact design rated HIGH for TokoPay in 06-23 (Payment-1); TokoPay was hardened
  with a live `checkTransaction`, but PayDisini — added later — never got that layer, even though
  `checkTransaction` exists in its client and its own reconcile poller uses it. Any single signed body
  observed once can be replayed with `status` flipped to `success`. Cross-order forgery still needs the api
  key, so this is defense-in-depth, not a bypass. *Fix:* mirror the TokoPay hardening.
- **M-10 — A `"stale"` webhook outcome is completely silent: money in, order cancelled, nobody told.**
  `apps/storefront/src/routes/checkout.ts:791,840,898`. All three handlers `reply.send({status})` with no
  branch for `"stale"` — no warn, no outbox alert. `deliverPaid*Order` returns `"stale"` when the order left
  `PENDING_PAYMENT` between callback and transaction, which happens routinely because
  `autoCancelExpiredOrders` cancels on a timer. The pollers can't recover it either (they filter
  `expiresAt > now`), and `reconcileFinances` doesn't scan ledger rows. Note the bot-side pollers *do*
  `alertAdmins` on stale — only the web webhooks are silent. *Fix:* log and enqueue an admin alert.
- **M-11 — The BSC confirmation tracker can escalate a genuinely-paid order to `FAILED`, permanently blocking delivery.**
  `apps/order-bot/src/payments/bybitBscConfirmationTracker.ts:190-206` +
  `packages/db/src/crud/bybit_bsc_deposit.ts:328-354`. The tracker is documented as display-only, but after
  10 consecutive cycles (under two minutes) where a **third-party block explorer** returns no tx, the order
  transitions to `FAILED` — which is not in `PRE_DELIVERY_STATUSES`, so Bybit's later status-3 report
  consumes the idempotency slot and returns `"stale"`. A free-tier key that 200s with an empty result is
  enough. *Fix:* don't transition to `FAILED` from explorer data, or add `FAILED` to `PRE_DELIVERY_STATUSES`.
- **M-12 — An empty NOWPayments `payment_id` poisons the idempotency ledger for every later IPN.**
  `packages/core/src/payments/nowpayments.ts:155-156`. `verifyIpn` returns `trxId: ""` when `payment_id` is
  absent, and that empty string becomes the UNIQUE ledger key. The first such IPN inserts a row keyed `""`;
  every subsequent one is answered `already_processed`, so a genuinely-paid order is never delivered and
  never flagged. *Fix:* treat a blank `trxId` as a verification failure.
- **M-13 — Binance Internal delivers on overpayment with no ledger flag and no admin alert.**
  `apps/order-bot/src/payments/binanceInternal.ts:87-96` + `packages/db/src/crud/binance_internal.ts:184-230`.
  TokoPay, PayDisini and NOWPayments all set `outcome: "overpaid"` and call `enqueueAdminOverpaid`; Binance
  does not. A buyer owing 12.37 USDT who sends a round 15 gets delivery, and the 2.63 surplus leaves no
  operational trail. *Fix:* add the same excess block.
- **M-14 — Both Bybit rails treat overpayment as "no match": the deposit is orphaned and the order auto-cancels.**
  `matchByAmount` (`binanceInternal.ts:107-116`) filters on `|tx.amount − expected| <= 0.001`. Because
  internal transfer and BEP20 carry no memo, amount is the only disambiguator, so a buyer who rounds up
  (13.00 for a 12.37 order — very common) matches nothing, the deposit is recorded `unmatched`, and the
  order expires. The BSC rail has no `markUnderpaid` path at all. *Fix:* make the tolerance asymmetric —
  accept `>= expected − tolerance` while still refusing when two orders qualify.
- **M-15 — TokoPay and PayDisini credentials travel in GET query strings.**
  `packages/core/src/payments/tokopay.ts:66-73,121-128` · `paydisini.ts:44-51,100-107`. Query strings are
  the most commonly logged part of an HTTP request — forward proxies, egress gateways, TLS-inspection
  appliances, and the gateway's own access logs. The code is aware (`// never log the query — it carries the
  secret`), which protects our own throw sites but nothing upstream. NOWPayments does this correctly with an
  `x-api-key` header. *Fix:* move to headers/POST bodies where the APIs allow; otherwise wrap every `fetch`
  so no thrown error can carry the URL.

### Low

| ID | Finding | Location |
|---|---|---|
| L-8 | The webhook rate limit is keyed on the gateway's own egress IP, so a shop confirming >30 payments/min gets 429s on real paid callbacks; success itself consumes the anti-abuse budget | `apps/storefront/src/rateLimit.ts:105-122` |
| L-9 | External amounts round-trip through a JS float before becoming the ledger `Decimal` — hostile inputs are rejected correctly, but the persisted amount is the float rounding of the exchange's exact decimal string | `binanceInternal.ts:142`, `bybitDeposit.ts:125`, `bybitBscDeposit.ts:148` |
| L-10 | No `AbortSignal` on any gateway `fetch`, and reconcile pollers loop orders serially — one hung gateway converts a cycle into `pendingOrders × timeout` with `isRunning` blocking all other work | `tokopay.ts:128`, `paydisini.ts:107`, `nowpayments.ts:102` + the three reconcilers |
| L-11 | The BSC tracker re-fetches the chain head once per order instead of once per cycle, doubling pressure on the API whose rate-limit exhaustion feeds M-11 | `bybitBscConfirmationTracker.ts:117-123,170-175` |

---

## 4. Auth, CSRF, route security

**Route coverage is otherwise excellent.** All 84 routes under
`apps/web-admin/src/routes/api/*` were enumerated individually: every `GET` carries
`currentAdmin` (`/api/admins` carries `requireSuper`), and every `POST`/`PATCH`/`DELETE`
carries `csrfProtect`. **Zero gaps.** The storefront's `/api/v1/*` surface is equally
clean — every mutating route requires the header token and re-checks ownership, and no
IDOR was found anywhere (customer-scoped routes 404 rather than 403). The only
authenticity gaps are H-5 and the logout routes (L-16).

### H-4 [HIGH] — Every customer's bcrypt password hash and email are serialized into admin API responses
`apps/web-admin/src/routes/api/users.ts:129,228` · `routes/api/orders.ts:135,197` ·
`routes/api/payments.ts:61-62`, backed by `packages/db/src/crud/users.ts:28,415` and
`packages/db/src/crud/orders.ts:224-228,1596`

These routes spread whole Prisma `User` rows into the JSON body (`...u`, `...user`, and
`...o` where the order include is `user: true`). The underlying crud helpers apply no
projection — verified: `listUsers` ends in a bare
`db.user.findMany({ where, orderBy, skip, take })` with no `select`, and
`prisma/schema.prisma:29-30` confirms `User` carries both `email` and `passwordHash`.
Those fields therefore ship to the browser.

All five routes are guarded by `currentAdmin` only — there is **no role gate on reads** —
so the lowest-privilege role reaches them: `POST /api/admins/add`
(`api/admins.ts:64`) creates new admins as `"readonly"`, and `canMutate` blocks their
writes but nothing blocks their reads.

**Attack.** A readonly staff account — or anyone with a stolen admin cookie, or XSS in the
admin SPA — pages `GET /api/users?pageSize=100` and walks off with every shopper's email
and bcrypt hash, cracks the weak ones offline, and signs into the storefront where those
accounts hold IDR and USDT wallet balances. This is the same bug class commit `f206176`
fixed for the ticket JSON; the fix never reached users, orders or payments.

**Fix.** Add an explicit `select` at the crud layer — mirror `TICKET_USER_SELECT`
(`packages/db/src/crud/support.ts:470`) — or a shaper in each route. Never spread a raw
`User` row into a reply.

### H-5 [HIGH] — `POST /setup/restart` is permanently unauthenticated, un-CSRF'd, and reachable long after setup completes
`apps/web-admin/src/routes/setup.ts:201-214`

Verified at source: unlike its three siblings (`/setup/bot`, `/setup/owner`, `/setup/shop`,
which all call `await checkSetupLock(reply)` first), this handler has **no lock check, no
`currentAdmin`, and no `csrfProtect`**. `plugins/setupGate.ts:13` excludes the whole
`/setup` prefix from the first-run gate, and `setupRoutes` is registered unconditionally
(`server.ts:123`), so the route stays live forever.

**Attack.** Any unauthenticated caller who can reach the admin host issues
`POST /setup/restart` in a loop, writing `tmp/restart.txt` on every hit and bouncing the
Passenger app — the single process hosting the bot, the storefront and the admin panel —
indefinitely. The response also discloses `bot_configured` pre-auth. Mitigated in practice
by the default `127.0.0.1` bind, so exposure needs LAN reach, a misconfigured proxy, or
SSRF. Note the existing test (`apps/web-admin/test/web.test.ts:5115-5137`) **asserts the
unauthenticated 200 as correct behavior**, and `api/settings.ts:441-447` documents the
exposure as known ("already the case") while routing the in-app button to a gated twin
instead of closing it.

**Fix.** Add `if (await checkSetupLock(reply)) return;` so it dies with the rest of the
wizard, and update the test to assert the post-setup 303/403.

### Medium

- **M-16 — Admin password change does not rotate the session jti** (`apps/web-admin/src/routes/api/settings.ts:497-508`).
  Every other admin credential path rotates it — `/reset` (`routes/auth.ts:246`), `/login` (`:166`),
  `/api/admins/:tgId/logout` (`api/admins.ts:95`). The storefront's identical bug was fixed as Storefront-2
  in 06-23 (`apiAccount.ts:501-513`); web-admin was never given the same treatment. An attacker who copied
  a session cookie keeps full super-admin access for the rest of `WEB_SESSION_TTL_HOURS` even after the
  admin changes their password to evict them. *Fix:* mint a new jti and re-issue the cookie, per the
  storefront pattern.
- **M-17 — Registration and reset-token submission have no rate limiting** (`apps/storefront/src/routes/apiAuth.ts:114,191-208`).
  `/auth/login` gets `loginRateLimited` + `accountLockedOut`, `/auth/forgot` gets `loginRateLimited` +
  `forgotEmailRateLimited`; `/auth/register` and `/auth/reset/:token` get neither. Register is the most
  expensive unauthenticated endpoint in the app — a cost-12 bcrypt (~450 ms of single-threaded CPU) plus a
  DB write — on a single-process server backed by a single-writer SQLite file. A few hundred concurrent
  POSTs saturate the event loop and stall checkout and the bot. *Fix:* apply `loginRateLimited(clientIp(req))`
  to both; the helper and its config knobs already exist.
- **M-18 — Ticket attachments are written to disk before the request is validated, with no quota or throttle.**
  `apps/storefront/src/routes/apiAccount.ts:270-304` + `lib/ticketAttachments.ts:57-119`. `parseTicketMultipart`
  saves each part inline as it streams, *before* the order-ownership check and before the `if (message)`
  guard that decides whether a ticket row is created at all. Any registered customer can POST an empty
  message with 3×20 MB parts in a loop: each request returns `{ok:true, ticket_id:null}`, creates no DB row
  an admin could see, and leaves 60 MB of orphaned files. `storageCleanupJob` prunes by joined ticket rows,
  so files with no ticket may never be reclaimed — a filled disk takes down SQLite's WAL writes and the whole
  app. *Fix:* buffer parts and write only after the checks pass; add a per-user attachment limit.
- **M-19 — Both error handlers log the full request URL including the query string.**
  `apps/storefront/src/server.ts:148` · `apps/web-admin/src/server.ts:109`. The access-log hooks correctly
  strip the query and the comment there explains why ("may carry tokens"), but the `setErrorHandler` logs
  `redactPath(req.url)` unsplit, and `redactPath` only rewrites `/reset/<seg>` path segments. The
  storefront's Telegram Login callbacks carry their credentials entirely in the query
  (`GET /auth/telegram?...&hash=<hmac>`), so any throw during `establishSession` writes a still-valid
  Telegram auth payload to the error log, replayable within the 15-minute `TG_AUTH_MAX_AGE_SECONDS` window.
  *Fix:* `redactPath(req.url.split("?", 1)[0])` in both handlers.
- **M-20 — SPA shells embed the per-session CSRF token in HTML with no `Cache-Control`.**
  `apps/storefront/src/routes/spaShell.ts:582-624` · `apps/web-admin/src/routes/spaShell.ts:36-45`. Both
  substitute the live session token into `index.html` and send it with no cache directive, so this per-user
  document is heuristically cacheable. The storefront is explicitly expected to sit behind a reverse proxy;
  a caching layer that stores a logged-in customer's page serves their CSRF token to every later visitor,
  which combined with `SameSite=Lax` on a top-level navigation is enough to forge state-changing requests.
  *Fix:* `Cache-Control: no-store` on every SPA-shell response in both apps.

### Low

| ID | Finding | Location |
|---|---|---|
| L-12 | Multipart upload CSRF uses `!==` instead of `constantTimeEqual` — the one CSRF comparison in the app that doesn't follow the rule; also silently rejects the `X-CSRF-Token` header | `apps/web-admin/src/lib/upload.ts:78` |
| L-13 | Both logout routes are mutating and CSRF-unprotected, and each rotates the server-side jti — a cross-origin form POST force-logs-out the victim on every device | `apps/web-admin/src/routes/auth.ts:260-268`, `apps/storefront/src/routes/apiAuth.ts:143-150` |
| L-14 | SMTP connection test echoes the raw driver error, which routinely embeds the server banner, resolved host/port and authenticating username | `apps/web-admin/src/routes/api/settings.ts:428` |
| L-15 | `POST /api/admins/add` accepts `0` and negative integers as Telegram ids; `/setup/owner` correctly requires `> 0` | `apps/web-admin/src/routes/api/admins.ts:59-73` |
| L-16 | Password-reset tokens are additive — requesting a new one doesn't invalidate the old, so every link in the throttle window stays independently valid for an hour | `packages/db/src/crud/webauth.ts:120-131` |
| L-17 | Product lookup runs ahead of the role/CSRF gate on the photo-upload route, letting any authenticated role enumerate product ids by response differential | `apps/web-admin/src/routes/catalogPhoto.ts:30-38` |
| L-18 | Ticket **video** attachments are trusted on the declared MIME type alone (images get magic-byte checks). Execution is genuinely blocked by `nosniff` + `default-src 'none'`, so this is stored-content hygiene — worth a test asserting those headers stay | `apps/storefront/src/lib/ticketAttachments.ts:106-110` |

---

## 5. Order bot (delta since 2026-07-06)

**Locale parity is clean.** `en.json` and `id.json` both carry 917 keys with zero
missing-key and zero `{placeholder}` mismatches in either direction, enforced by
`packages/core/src/locales.test.ts`. What parity doesn't catch: 43 keys whose Indonesian
value is byte-identical to the English one, of which ~15 are genuinely untranslated
strings shown to Indonesian users — most notably `admin.verification_item`, an entire
screen body. One reverse leak: `menu.wallet_inline` holds Indonesian text in **en.json**
(currently unreferenced — a dead key, worth deleting). → L-19

### H-6 [HIGH] — Restock subscriptions are consumed before the DMs are sent, and the fan-out has no throttle
`apps/order-bot/src/handlers/admin.ts:599-621`, called from `conversations/admin.ts:174`

Verified at source: `prisma.restockSubscription.deleteMany(...)` at `:609` runs
**before** the send loop at `:611-621`. Any failure after that point is permanent — the
subscriber is never told and their subscription no longer exists to retry against. The
catch handler at `:619` states this outright: *"their subscription was already consumed,
they won't be retried."* Compounding it, the loop calls `ctx.api.sendMessage` with **no
throttle at all**, unlike `drainBroadcasts` which sleeps `BROADCAST_THROTTLE_MS = 40`
between sends.

**Failure scenario.** 60 users tap "Notify me when back in stock"; an admin pastes new
credentials; the `deleteMany` fires; roughly the first 30 DMs land and the rest hit
Telegram's bulk rate limit. Those ~30 customers are never notified and have no
subscription left. A bot restart mid-loop loses the remainder the same way.

Two secondary defects in the same function: `prisma.user.findMany` /
`prisma.restockSubscription.deleteMany` are raw model access inside a handler (the project
rule routes these through `packages/db/src/crud/*`), and `Number(tgId)` at `:613` sends to
chat `0` for web-only users with `telegramId: null`.

**Fix.** Delete each subscription after its DM succeeds (or mark `notifiedAt` instead of
deleting), add the same 40 ms throttle, filter `telegramId: { not: null }`, and move the
two Prisma calls into a crud helper.

### H-7 [HIGH] — The flash-sale announcement holds one write transaction across a whole-customer-base enqueue
`apps/order-bot/src/jobs/index.ts:412-426` → `packages/db/src/crud/notifications.ts:499-545`

`announceStartedFlashSales` wraps the claim-stamp **and** `enqueueFlashSaleBroadcast` in a
single `prisma.$transaction(..., { timeout: 15000 })`. Inside, `enqueueFlashSaleBroadcast`
does a `user.findMany` over every non-banned Telegram-linked customer, a
`notificationOutbox.createMany` of one row per customer, and a `broadcast.create`. On the
shared single-writer SQLite file that is a multi-second exclusive write transaction — and
the explicit 15s timeout is itself an admission of it, directly against the "keep each
`$transaction` short" rule.

**Failure scenario.** A flash sale opens at 14:00 with 20,000 customers in the DB. When
the cron fires, for the duration of that `createMany` every concurrent writer — a
customer's `createInternalOrder`, `settlePaidOrder`, `cancelOrder`, the outbox
dispatcher's claim — blocks past the 5s `busy_timeout` and fails with P1008/P2028. This is
the production failure `7fe394a` was written to mitigate; that commit only staggered the
cron *start* second, it did not shorten the lock the transaction holds.

**Fix.** Keep only the conditional `flashAnnouncedAt` claim inside the transaction, then
enqueue outside it in chunked `createMany` batches (e.g. 500 rows per short transaction).

### Medium

- **M-21 — Unknown `v1:adm:*` callbacks silently no-op instead of showing `error.stale_screen`.**
  `apps/order-bot/src/handlers/admin.ts:659-739`. `handleAdminCallback`'s `switch (section)` has no
  `default:` and no case has a trailing `else`, so an unrecognized admin callback falls through and
  `routeCallback` fires a blank `answerCallbackQuery()` — spinner clears, nothing happens, no explanation.
  This is the one domain that skips the invariant `dispatchBrowse` (`callbacks.ts:62-65`) and
  `routeCallback`'s own unknown-domain path (`:269-277`) both implement. *Fix:* add the `default:`/`else`
  branches answering `error.stale_screen`.
- **M-22 — Conversation wait loops never answer an unrecognized inline tap, leaving the button spinning.**
  `conversations/support.ts:95,106-126` · `customerInfo.ts:105-110` · `editCustomerInfo.ts:137-142` ·
  `conversations/admin.ts:111-134`. The conversations plugin consumes the update before `routeCallback`
  runs, so a non-matching tap is never answered at all and Telegram keeps the spinner up until it times out.
  The only escape is knowing to type `/cancel`. *Fix:* answer `error.stale_screen` in each loop's
  fall-through when `u.callbackQuery` is present.
- **M-23 — The new support order-picker step leaves three live inline keyboards in the chat.**
  `conversations/support.ts:70-73,99-102,139-142`. The `AWAITING_ORDER` step sends via bare
  `ctx.api.sendMessage` + `orderPickerKb`, bypassing `smartEdit`/`menuAnchor` and never calling
  `retireKeyboard`; the following two sends do the same. Four bubbles with four tappable keyboards, against
  the one-active-keyboard invariant — and per M-22, tapping a stale one just hangs. *Fix:* route all three
  through `menuAnchor`.
- **M-24 — `8c41146` fixed only half the single-bubble violation in the qty-input wizard.**
  `handlers/customer.ts:649-670`. The commit correctly added `consumeInput(ctx)`, but the wizard still
  re-renders through `smartEdit`, which on a typed update takes its fresh-send path — so "prompt → error →
  prompt" still stacks new bubbles. Two typos leave three dead bubbles. *Fix:* use `menuAnchor` in
  `handleQtyTextInput`. (The two sibling commits, `649491c` and `d6d7f78`, were checked and are complete.)
- **M-25 — The broadcast conversation targets web-only users and has no throttle, so its reported counts are wrong.**
  `conversations/admin.ts:377-379,405-419`. The `user.findMany` omits `telegramId: { not: null }` — unlike
  `enqueueFlashSaleBroadcast`, which includes it — so every web-registered customer becomes
  `sendMessage(0)` and lands in `failed`; no inter-send delay compounds it with 429s. The preview says
  "5,000 users", the result says "sent 900, failed 4,100", and that misleading number is what
  `logAdminAction` writes permanently. *Fix:* filter on `telegramId` in both the preview and the send list,
  and reuse `BROADCAST_THROTTLE_MS`.
- **M-26 — Four scheduled jobs are missing `{ protect: true }`, so a slow run can overlap itself.**
  `jobs/index.ts:491-494` — `reconcileFinancesJob` and all three poller watchdogs, while every other job in
  the list has it with a comment explaining why. The watchdogs run every 2 minutes, and each reads its alert
  flag, DMs *every* admin sequentially, and only then writes the flag — so a slow Telegram means run B reads
  a still-unset flag and every admin is paged twice. *Fix:* add `protect: true` to all four and move the
  flag write before the DM loop.
- **M-27 — One bad row aborts the whole stale-ticket batch for an hour.**
  `jobs/index.ts:109-127`. `autoCloseStaleTickets` wraps only the customer DM in try/catch; the
  `findUnique` and `closeTicket` run bare inside the loop, so a single write-lock timeout throws out of the
  whole `for` and the job wrapper logs "this run was skipped". `autoCancelExpiredOrders` immediately above
  does this correctly with a per-row try/catch. *Fix:* mirror that pattern.
- **M-28 — The delivery log interpolates a list of redacted credentials, and five admin strings bypass `t()`.**
  `handlers/verification.ts:198-199,63,66,213,285` · `handlers/admin.ts:200-203`. Line 199 builds
  `` `… (creds redacted: ${redacted.join(", ")})` `` — an interpolated per-item list, which the logging
  convention forbids outright, and it puts derived credential material into logs for a 50-item order.
  Separately, `maybeAlertLowStock` hardcodes `coreT(..., "en", ...)`, so an Indonesian admin always gets the
  English alert. *Fix:* summarize by count; add locale keys and pass each admin's own language.

### Low

| ID | Finding | Location |
|---|---|---|
| L-19 | ~15 `id.json` values are untranslated English (notably `admin.verification_item`, a whole screen); `menu.wallet_inline` is Indonesian text sitting in `en.json` | `packages/core/locales/{en,id}.json` |
| L-20 | `ticket_close` writes an audit row with no `details` sentence — the same shape as the fixed Log-5-7, on the sibling action that was left behind | `apps/order-bot/src/handlers/admin.ts:570-577` |

---

## 6. Data layer and schema (delta since 2026-07-06)

### H-8 [HIGH] — The migration history can no longer reproduce `schema.prisma`: 12 columns and 2 indexes exist only in the schema
`prisma/schema.prisma:142-144,196,199,214-217,298,301,507` vs `prisma/migrations/*`

Verified by diffing every `@map`ped scalar in the schema against every identifier in the
migrations tree. Spot-checked and confirmed absent from **all** migration files:
`delivery_type`, `additional_fields`, `what_you_get`, `terms`, `warranty_note`,
`customer_data`, `delivered_content`, `closed_at`, `flash_discount_percent` — plus the
indexes `ix_denominations_flash_ends_at` and `ix_support_tickets_closed_at`. The two
largest schema commits of the quarter, `34777ba` (flash sales) and `1085074` (per-SKU
delivery flows), edited `schema.prisma` and added **no migration folder at all**.

**Failure scenario.** An operator — or the Postgres cutover this repo names as its own
scaling trigger — runs `prisma migrate deploy` against a fresh DB and gets a
`denominations` table with no `delivery_type`. The first catalog read throws
`P2022 column denominations.delivery_type does not exist`, and neither the bot nor the
storefront can serve a single product. `docs/MIGRATIONS.md:17-21` explicitly promises the
folder is "divalidasi byte-identik via `prisma migrate diff`"; that promise is now false
for the two biggest features shipped this quarter.

**Mitigating factor.** Day-to-day deploys in this repo use `prisma db push` (per
`CLAUDE.md`), which reads the schema directly — so this is a latent hazard rather than a
live outage. It becomes live the moment anyone uses the migration path.

**Fix.** Generate one catch-up migration —
`prisma migrate diff --from-migrations ./prisma/migrations --to-schema-datamodel ./prisma/schema.prisma --script`
— and add that command as a CI check that fails when the diff is non-empty.

### H-9 [HIGH] — A migration that already failed a real deploy is still unrunnable on any DB that ran its broken version, and its folder timestamp collides with a sibling
`prisma/migrations/20260725000000_add_ticket_priority_category_resolved/migration.sql`

Commit `058afd7`'s own message records the original failure verbatim:

> *"…the NOT NULL DEFAULT CURRENT_TIMESTAMP form only worked in tests because
> `prisma db push` rebuilds the table from scratch… (P3018, **partially applied**:
> category/first_response_at/resolved_at went through, last_status_change_at didn't)."*

The corrected file still opens with the same three bare `ADD COLUMN` statements and has no
`IF NOT EXISTS` guard anywhere.

**Failure scenario.** On the DB that took the partial application, `migrate deploy` now
refuses outright (P3009, failed migration recorded). `migrate resolve --rolled-back` then
re-runs the file and dies on `duplicate column name: category`.
`migrate resolve --applied` marks it done while `last_status_change_at` is still absent,
so every `supportTicket` read throws `P2022` — the entire support module is down until
someone falls back to `db push`.

Separately and independently verified: `20260725000000_add_support_ticket_priority` and
`20260725000000_add_ticket_priority_category_resolved` share a **byte-identical
timestamp**. The ordering the second file's own comment depends on ("priority was added by
the other branch, don't redo it") holds only by the lexicographic accident that `s` < `t`.

**Fix.** Split the file into individually idempotent steps, or re-cut it as a fresh
later-timestamped migration that assumes the partial state; renumber one of the two
colliding folders; and add a "Recovering from a failed `migrate deploy`" section to
`docs/MIGRATIONS.md` — no doc currently mentions P3018 or `migrate resolve`.

### Medium

- **M-29 — `lastStatusChangeAt` is NOT NULL in the schema but nullable in the migration, and two live write paths never stamp it.**
  `prisma/schema.prisma:516` declares `DateTime @default(now())` (non-nullable) while the migration adds it
  nullable — so a `db push` DB and a `migrate deploy` DB have physically different schemas from one repo.
  The migration comment asserts "every code path that writes this column sets it explicitly", but
  `reopenTicket` (`crud/support.ts:142-146`, reached from both the bot and the storefront) writes only
  `status`/`closedAt`, and the bot's `replyToTicket` (`:173-195`) sets neither `lastStatusChangeAt` nor
  `firstResponseAt`. The admin queue's "Waiting since" column reads exactly this field, so a freshly
  reopened ticket looks stale and an answered one looks unanswered; `firstResponseAt` stays permanently null
  for every ticket answered via Telegram.
- **M-30 — Abandoned-mid-wizard state leaves the pre-auth, no-CSRF `POST /setup/owner` open.**
  `apps/web-admin/src/routes/setup.ts:61-62,126-139` + `plugins/setupGate.ts:11`. Not a regression —
  `git blame` puts it in the initial squashed commit — but a live residual of the 06-23 Admin-1 surface via
  a different trigger. `OWNER_TG_KEY` is deleted only on a *successful* `POST /setup/shop`, so a wizard
  abandoned after step 2 leaves `setup_completed` unset and `checkSetupLock` returning `false` **permanently**,
  while the shop runs normally and nobody notices. Anyone who can reach the panel can then submit their own
  `telegram_id` + password and get `addAdminId` + `upsertUser(role=ADMIN)`; with `DEFAULT_WEB_ROLE = "super"`
  that is a full super-admin. *Fix:* timestamp `OWNER_TG_KEY` and expire it, or write `setup_completed` at
  step 2.
- **M-31 — The overdue rule silently excludes every ticket that was ever replied to.**
  `crud/support.ts:353-357`. The predicate is `status = OPEN AND repliedAt IS NULL AND createdAt < cutoff`,
  but `addTicketMessage:222-225` flips a ticket back to OPEN on a customer follow-up **without clearing
  `repliedAt`**. `bece3cd` made this a structural single source of truth for the KPI, the filter and the
  badge — so all three are wrong together. A customer replying "still not fixed" to a three-week-old ticket
  is invisible to the very triage queue built to catch it. It also keys on `createdAt`, contradicting
  `schema.prisma:513-516`'s stated intent. *Fix:* `status IN (OPEN) AND lastStatusChangeAt < cutoff`, mirrored
  in `ticketWhereRaw:406-410`.
- **M-32 — No index on `order_items(product_id)` or `orders(delivered_at)`, the two columns every new revenue/flash-sale query filters on.**
  `schema.prisma:380,331-335`; queries at `crud/revenue.ts:202-212,269-278` and `crud/catalog.ts:698-704`.
  `order_items` is the fastest-growing table in the DB (one row per unit per order); at ~200k rows the Flash
  Sales table and the dashboard's profit tile each become a full scan, and because scans hold a read lock, a
  concurrent checkout's write queues behind an admin refreshing a page. *Fix:* add
  `@@index([productId])` and `@@index([status, deliveredAt])` with the matching migration.
- **M-33 — `topProducts` loads every delivered order line ever into JS memory.**
  `crud/revenue.ts:155-160` — no `take`, no `since`, no `groupBy`; it materializes the full history and
  buckets it in a `Map` to return the top 10. The admin Reports page is a single request that pulls the
  entire `order_items` and `denominations` tables into the Node heap, with no page size to cap it.
  *Fix:* `orderItem.groupBy` bounded by a `since` window.
- **M-34 — The new customers/audit admin surfaces filter and sort on entirely unindexed columns.**
  `schema.prisma:61` (User has **no** `@@index` at all beyond its uniques), `:614` (AuditLog indexes
  `createdAt` only). Paged listing filters on `role`/`banned`/`createdAt`/`lastSeenAt` and sorts on
  `createdAt`/`lastSeenAt`, so every page load and every `count` is a full scan plus an in-memory sort.
  `rankUserIdsBySpend` (`crud/users.ts:374-385`) additionally has **no `take`** — on a 50k-customer shop
  "sort by spend" loads all 50k ids and then issues a `groupBy` over them, which Prisma must chunk around
  SQLite's 999-parameter bind limit, turning one page render into dozens of queries.
- **M-35 — Test-coverage gap: 7 of 23 changed crud files shipped with no test change.**
  `binance_internal.ts`, `bybit_deposit.ts`, `bybit_bsc_deposit.ts`, `nowpayments.ts`, `paydisini.ts`,
  `orderStatus.ts`, `reviews.ts`. What is now untested: the new `"processing"` branch in each of the five
  gateway files (including the guard that **skips** `ORDER_DELIVERED_DM` on that path while keeping the
  overpaid alert unconditional — two branches that now interact, with no combination asserted), the two new
  `LEGAL_TRANSITIONS` entries, and `listRestockSubscribers`' widened `include` shape that
  `handlers/admin.ts:600` destructures. Mitigating: the shared branch point `settlePaidOrder` *is* well
  covered (419-line test file), so risk is concentrated in per-gateway wiring rather than the core rule.
  *Fix:* one table-driven `"processing"` test across the four near-identical gateway files.
- **M-36 — The ticket filter predicate now exists twice (Prisma + hand-written SQL), and only one is used for counting.**
  `crud/support.ts:338-366` vs `:369-418`. The raw variant is defensible — it is in the crud layer, and every
  user value is bound via `Prisma.sql` tagged templates with no interpolation and no injection vector — but
  `countTickets:485` always uses the Prisma version while the priority-sorted page uses the SQL one, so the
  two must stay equivalent forever. They already differ subtly on `%term%` escaping. *Fix:* derive the raw
  query's id set from the Prisma `where` so there is exactly one predicate.
- **M-37 — 15 `logAdminAction` call sites still write no `details`, worst on deletes.**
  `api/vouchers.ts:358-363`, `api/catalog.ts:516-521`, `api/outbox.ts:41-46`, `api/broadcast.ts:97,110,123`,
  `api/reviews.ts:38`, `api/payments.ts:122`, `api/support.ts:297,310`, `api/settings.ts:505,531,544`,
  `order-bot/handlers/admin.ts:485,572`. `voucher_delete` and `denomination_delete` write only `targetId`,
  and the referenced row is deleted in the same request — so "who deleted the WELCOME50 code?" resolves to
  `voucher_delete → voucher #47` pointing at nothing. The bot-side instances the prior audit named were
  fixed; the web-side tail was not swept. *Fix:* capture the name/code before the delete and write a sentence.

### Low

| ID | Finding | Location |
|---|---|---|
| L-21 | The boot-time drift check never learned about the new tables — `voucher_products` and `order_status_history` are absent from `PAYMENT_LEDGER_TABLES`, so a missed `db push` passes boot and throws `P2021` at payment time instead | `packages/db/src/crud/integrity.ts:26-36` |
| L-22 | `DATABASE.md` and `CHANGELOG.md` are now stale across eleven schema commits (prior Schema-1/2, widened by an order of magnitude) — zero mentions of `voucher_products`, `delivery_type`, `priority`, `customer_data`… | `docs/DATABASE.md`, `docs/CHANGELOG.md:9,38` |
| L-23 | `deleteCatalogProductCascade` bypasses the order-history guard its sibling `deleteDenomination` enforces; saved today only by an `ON DELETE RESTRICT` FK that was already wrong once before 06-23 | `packages/db/src/crud/catalog.ts:240-245` |

---

## 7. Outbox, notifications, composition root

Verified clean and worth recording: **the web never sends Telegram** (zero grammY imports
in either web app; the only outbound traffic is the read-only `getMe`/`getChat`/`getFile`
helper); **exactly one `new PrismaClient()`** in the repo; all 11 `NotificationEvent`
values are handled with no placeholder mismatch, every interpolated value HTML-escaped and
length-capped; poison messages (bad JSON, missing `chat_id`, unknown event, 403 Forbidden)
all fail immediately rather than looping; and the composition root wraps every cron job in
a `.catch()`, stops producers in dependency order on shutdown, and routes
`unhandledRejection`/`uncaughtException` through the same path.

### Low

| ID | Finding | Location |
|---|---|---|
| L-24 | The channel-not-configured backoff shares its counter with the terminal-failure path, so a row that waited out a long config gap has ~150 attempts and its first *real* failure computes `151 >= 5` and goes straight to `FAILED` with zero retries — contradicting the path's own doc-comment | `packages/db/src/crud/notifications.ts:329` vs `:295-296` |
| L-25 | `sleepOrNudge` adds an `AbortSignal` listener per poll tick with `{ once: true }`, which only removes on fire — ~8,600 accumulated listeners/day, a `MaxListenersExceededWarning` within minutes | `packages/outbox-dispatcher/src/dispatcher.ts:87` |
| L-26 | `retryNotification` has no status guard, so the API can requeue an already-`SENT` `ORDER_DELIVERED_DM` and re-send a buyer's credentials; the UI hides the button but the route accepts any id, and the helper's own doc says "FAILED (or stuck)" | `packages/db/src/crud/notifications.ts:589-596` ← `api/outbox.ts:37-40` |

---

## Suggested remediation order

1. **H-1** (TokoPay fee base) — the only finding actively losing money on every discounted
   QRIS order right now. One-line conceptual fix, needs a test asserting a discounted
   order's expected charge equals what the gateway bills.
2. **H-4** (password hashes in admin API) — smallest fix-to-impact ratio here; add the
   projection at the crud layer and the whole class closes.
3. **H-2**, **H-3** (money-trapping order states) — both are "the buyer paid and cannot be
   made whole"; H-2 is a two-word change to `canCredit`, H-3 needs the claim-row lifecycle
   reconsidered across five gateway files.
4. **H-6**, **H-7** (bot fan-out) — H-7 in particular can stall every writer in the
   process for seconds.
5. **H-5**, **M-30** (setup routes) — close both together; they are the same surface.
6. **H-8**, **H-9** (migrations) — latent while deploys use `db push`, but they block the
   Postgres path this repo has already named as its scaling trigger, and H-9 has already
   caused one real failed deploy.
7. **M-3** (`Decimal` NaN) — cheap, and it currently defeats the reconciliation safety net
   that is supposed to catch everything else.

Everything else is best batched by area rather than by severity, since most Mediums in a
section share a root cause with the High above them.
