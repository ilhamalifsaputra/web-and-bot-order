# TokoPay QRIS fee: trust the gateway's total, no admin setting

Date: 2026-11-11. Branch: `worktree-tokopay-fee-settings`.

## Problem

The QRIS admin fee is TokoPay's own cut. The buyer pays it on top of the order total; the shop neither
sets it nor receives it. We send TokoPay `order.totalAmount` as `nominal` and TokoPay adds its fee.

Our code hard-codes that fee as Rp100 + 0.7% (`packages/core/src/payments/tokopay.ts:92-93`) and
re-derives it at 14 call sites, including the paid-amount checks in the storefront webhook and the bot
reconcile poller. Those checks have no tolerance: a payment Rp1 below the expected amount is UNDERPAID.

TokoPay announced on 2026-11-11 that QRIS transactions below Rp100,000 are charged 0% + Rp25. This
applies to the `QRIS` and `QRIS_CUSTOM` channels, not to `QRISREALTIME`. Buyers therefore pay less than
we expect, and a correctly paid order is flagged UNDERPAID. One order was hit (already resolved by the
owner). TokoPay is switched off until this ships.

TokoPay already returns the exact amount it will charge (`total_bayar`) when the transaction is created.
We keep it only inside the cached `Order.paymentRef` JSON and never read it.

## Goals

1. A future tariff change must not break payment matching, and must not need a deploy or a setting.
2. The amount shown next to the QR (bot caption, storefront pay page) always equals the amount the
   buyer's banking app shows when scanning.
3. Nothing about the fee has to be configured in the admin panel.
4. An admin is told when TokoPay's amount differs from our estimate.

## Owner decisions

- The shop uses the plain `QRIS` channel.
- No tariff editor in Settings. The estimate table is built into the code from the owner's TokoPay
  dashboard tariff list plus the announcement above.
- Admins are notified on a mismatch.
- No bulk repair of past orders.

## Non-goals

- Supporting payment flows for channels other than QRIS (the table below is data for estimates only).
- Making `tokopay_default_channel` admin-editable.
- The shop absorbing or splitting the fee in our own code. TokoPay's dashboard switch "Biaya admin:
  Anda / Pembeli" already covers that, and this design follows it automatically (section 1).
- Enforcing TokoPay's per-channel minimum and maximum amounts.
- Existing follow-ups from the backend audit (fee included in underpaid refunds, missing Payment rows
  on the storefront TokoPay path).

## Design

### 1. Per-order charge snapshot

Add `Order.gatewayChargeAmount Decimal?` (`gateway_charge_amount`): the fee-inclusive amount the gateway
says the buyer must pay. Null means "the gateway did not tell us".

`commitGatewayResult` (`packages/db/src/crud/orders.ts:373`) gains an optional `gatewayChargeAmount`
argument and writes it in the same `updateMany` that stores `paymentRef`, so the snapshot and the cached
gateway result can never disagree. All three TokoPay creation paths pass it: storefront
`checkout.ts:1122`, bot `handlers/checkout.ts:2069`, bot `handlers/walletTopup.ts:690`. Other gateways
pass nothing.

A pure helper in core, `readTokopayCharge(channel, totalAmount, totalBayar)`, returns one of:

- `{ kind: "ok", charge }` — `total_bayar` parses as a whole-rupiah Decimal, is at least `totalAmount`,
  and the implied fee is at most the plausibility cap: `max(10%, 2 × the channel's highest table
  percent)` of the total, plus Rp10,000. An unknown channel uses 10%.
- `{ kind: "missing" }` — `total_bayar` is null or empty. The snapshot stays null.
- `{ kind: "implausible" }` — anything else. The caller releases the gateway claim, shows the buyer the
  existing "payment could not be created" error instead of a QR, and enqueues the admin alert in
  section 5 with reason `implausible`. Nothing is stored.

If the dashboard switch makes the shop bear the fee, `total_bayar` equals the total, the snapshot equals
the total, and the buyer-side fee is zero everywhere without any change on our side.

The migration adds the column and backfills every existing `TOKOPAY` order with the old formula
(`total_amount + ROUND(100 + total_amount * 0.007)`), so historical overpaid/underpaid evaluations do not
change.

### 2. One resolver for the expected charge

`expectedTokopayCharge(order, channel)` in `packages/db/src/crud/tokopay.ts` returns
`order.gatewayChargeAmount`, or, when that is null, `order.totalAmount + (estimateTokopayFee(channel,
order.totalAmount) ?? 0)`. The fee is always `charge − totalAmount`.

Every matching and bookkeeping site uses it instead of re-deriving the formula:

| Site | Use |
|---|---|
| storefront `checkout.ts:1329` | webhook paid-amount check |
| bot `payments/tokopayReconcile.ts:184` | reconcile paid-amount check |
| `crud/tokopay.ts:298`, `:403` | overpayment flags (top-up, product) |
| `crud/tokopay.ts:342`, `:378` | `Payment.fee` / `Payment.netAmount` |
| `crud/overpayments.ts:139` | refundable excess |
| `crud/orderStatus.ts:303` | `markOrderUnderpaid` guard |
| `crud/manualMatch.ts:133` | manual-match required amount |
| `crud/wallet_topup.ts:1108` | fee deducted when crediting an underpaid top-up |

The channel comes from `getTokopayCreds` (`crud/tokopay.ts:46`, default `QRIS`). Sites that do not hold
the credentials read `tokopay_default_channel` through a small `getTokopayChannel(db)` helper that
applies the same default.

Comparison rules are unchanged: below the expected charge is UNDERPAID, above it is overpaid, no
tolerance. Only the source of the expected figure changes.

### 3. Built-in tariff table (estimates only)

New file `packages/core/src/payments/tokopayFee.ts` holds the table, keyed by TokoPay channel code. Each
entry is an ordered list of tiers `{ upTo, flat, percent }`; a tier applies when `amount < upTo`, and the
last tier has `upTo: null`. Fee = `flat + amount × percent / 100`, rounded half-up to whole rupiah.

| Group | Channel code | Tariff |
|---|---|---|
| QRIS | `QRIS` | below Rp100,000: Rp25; otherwise Rp100 + 0.70% |
| QRIS | `QRIS_CUSTOM` | below Rp100,000: Rp25; otherwise Rp250 + 0.70% |
| QRIS | `QRISREALTIME` | 1.70% |
| QRIS | `QRIS_WK` | 1.20% |
| Virtual account | `BRIVA` | Rp3,000 |
| Virtual account | `BCAVA` | Rp4,200 |
| Virtual account | `BNIVA`, `MANDIRIVA`, `BSIVA` | Rp3,500 |
| Virtual account | `PERMATAVA` | Rp2,000 |
| Virtual account | `CIMBVA`, `DANAMONVA` | Rp2,500 |
| Virtual account | `BNCVA`, `PERMATAVAA` | Rp3,000 |
| E-money | `SHOPEEPAY`, `DANA`, `ASTRAPAY`, `OVOPUSH` | 2.50% |
| E-money | `GOPAY`, `LINKAJA`, `SHOPEEPAY_REALTIME` | 3.00% |
| E-money | `VIRGO` | 2.00% |
| E-money | `DANA_REALTIME` | 3.20% |
| E-money | `GOPAY_REALTIME` | 3.50% |
| E-money | `OVOPUSH_REALTIME` | 2.70% |
| E-money custom name | `DANA_CUSTOM`, `SHOPEE_CUSTOM`, `OVO_CUSTOM`, `LINKAJA_CUSTOM` | 2.50% |
| Retail | `ALFAMART`, `INDOMARET` | Rp3,000 |
| Pulsa | `TELKOMSEL` | 32.00% |
| Pulsa | `AXIS`, `XL`, `TRI`, `SMARTFREN` | 25.00% |

Source: the owner's TokoPay dashboard tariff list and the TokoPay announcement, both dated 2026-11-11.
The file's header comment records that source and date.

`estimateTokopayFee(channel, amount)` is pure and synchronous and returns a Decimal, or `null` for a
channel code that is not in the table. Lookup trims and upper-cases the code.

`computeQrisAdminFee`, `qrisChargeAmount`, `QRIS_ADMIN_FEE_FLAT` and `QRIS_ADMIN_FEE_PERCENT` are
deleted, so the compiler flags every caller.

No setting is added for the tariff and the admin Settings page does not change.

### 4. Buyer-facing amounts

| Screen | Source |
|---|---|
| Bot QR caption, product order and wallet top-up (`util/qrisCaption.ts`, `handlers/checkout.ts:2040`, `handlers/walletTopup.ts:678`) | snapshot; fee row = snapshot − total |
| Storefront pay page (`checkout.ts:1098`, `qris_admin_fee` / `qris_grand_total`) | snapshot once the gateway result exists |
| Storefront checkout before the QR (`checkout.ts:299`) | `estimateTokopayFee` |

When the snapshot is null these screens fall back to the estimate. When the estimate is also `null`
(unknown channel), the pre-QR screen shows no fee figure and the total without a fee.

`qrisCaptionAmounts` receives the fee as an argument instead of computing it. The bot sends and edits
exactly the same messages as today; only the numbers change.

`web.qris_admin_fee_note` (id and en) stops quoting "Rp100 & 0,7%" and becomes a rate-free note
("+ biaya admin QRIS" / "+ QRIS admin fee"). The estimate itself is already shown in the order summary.

### 5. Tariff-drift alert

When a TokoPay transaction is created and `readTokopayCharge` returns `ok` with a charge different from
`totalAmount + estimate`, or returns `implausible`, call `enqueueAdminTokopayFeeDrift(db, …)`
(`crud/notifications.ts`, same shape as the other `enqueueAdmin*` helpers). It writes one
`notification_outbox` row per resolved admin under a new `NotificationEvent.ADMIN_TOKOPAY_FEE_DRIFT`;
the notifier delivers it. The web never sends Telegram itself.

The helper is limited to one alert per 24 hours through a timestamp stored under the internal setting
key `tokopay_fee_drift_alerted_at`, checked and written in one transaction. That key is not listed in
the admin Settings page. The message states the order total, our estimate and TokoPay's figure, says the
payment is processed with TokoPay's figure, and says the built-in estimate table needs a code update. A
drift does not block the payment; an `implausible` result does (section 1).

## Error handling

- `total_bayar` missing: snapshot null, estimate used everywhere. This is the only case that still
  depends on the built-in table being right; it is logged as a warning at creation.
- `total_bayar` implausible: no QR, claim released, admin alerted.
- Unknown channel code: estimate `null`, treated as zero fee by the resolver fallback, logged as a
  warning once per process.
- Failure to enqueue the drift alert never fails the checkout; it is logged.

## Testing

- Core: `estimateTokopayFee` for `QRIS` at 99,999 and 100,000, `QRIS_CUSTOM`, a flat-only channel, a
  percent-only channel, an unknown code; every table entry is well-formed (ascending bounds, last tier
  open); `readTokopayCharge` for ok, missing, below total, above cap, and a pulsa channel within its cap.
- DB: `expectedTokopayCharge` with and without a snapshot; `commitGatewayResult` writes the snapshot only
  when the claim sentinel matches; drift alert once per 24 hours.
- Matching, for both the webhook and the reconcile poller, product orders and wallet top-ups: a payment
  equal to a snapshot that differs from the estimate is delivered; below the snapshot is UNDERPAID;
  above is overpaid; an order with a backfilled old-formula snapshot is still judged by that snapshot.
- Manual match, overpayment excess and underpaid top-up credit read the snapshot.
- Bot: caption shows the snapshot; exact `sendMessage` / `edit*` / `deleteMessage` / `sendDocument`
  counts stay pinned; an implausible total sends no QR.
- Storefront: checkout preview uses the estimate; pay page uses the snapshot.
- Tests that pin the old literals are updated (core `tokopay.test.ts`, `tokopay-webhook.test.ts`,
  `crud/tokopay.test.ts`, storefront client fixtures).

Gates: `pnpm test:changed` per task; at the end `pnpm typecheck && pnpm test`. If React client source
changes: `pnpm doctor:changed`, `pnpm doctor:bugs`, `pnpm doctor:full` at 0 errors and 0 warnings,
recorded in `docs/REACT_DOCTOR_PHASE_1_REPORT.md`.

## Deploy

1. Apply the migration (column and backfill) and restart order-bot before the new code runs.
2. Release the server and the storefront client together.
3. Re-enable TokoPay. Nothing has to be filled in under Settings.
