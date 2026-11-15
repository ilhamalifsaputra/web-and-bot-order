# TokoPay QRIS fee: trust the gateway's total, no fee formula anywhere

Date: 2026-11-11 (revised the same day: the built-in tariff table and the drift alert were dropped at
the owner's request). Branch: `worktree-tokopay-fee-settings`.

## Problem

The QRIS admin fee is TokoPay's own cut. The buyer pays it on top of the order total; the shop neither
sets it nor receives it. We send TokoPay `order.totalAmount` as `nominal` and TokoPay adds its fee.

Our code hard-codes that fee as Rp100 + 0.7% (`packages/core/src/payments/tokopay.ts:92-93`) and
re-derives it at 14 call sites, including the paid-amount checks in the storefront webhook and the bot
reconcile poller. Those checks have no tolerance: a payment Rp1 below the expected amount is UNDERPAID.

TokoPay announced on 2026-11-11 that QRIS transactions below Rp100,000 are charged 0% + Rp25. Buyers
therefore pay less than we expect, and a correctly paid order is flagged UNDERPAID. One order was hit
(already resolved by the owner). TokoPay is switched off until this ships.

TokoPay already returns the exact amount it will charge (`total_bayar`) when the transaction is created.
We keep it only inside the cached `Order.paymentRef` JSON and never read it. TokoPay has no API that
lists tariffs (docs.tokopay.id, checked 2026-11-11), so the fee is only knowable per transaction.

## Goals

1. A tariff change at TokoPay never breaks payment matching and never needs a code change, a deploy or
   a setting.
2. The amount shown next to the QR (bot caption, storefront pay page) always equals the amount the
   buyer's banking app shows when scanning.
3. No fee formula or tariff table exists in our code, and nothing is configured in the admin panel.

## Owner decisions

- Before the QR exists, the buyer is only told that a QRIS admin fee will be added; no figure is shown.
- No tariff table, no tariff setting, no "tariff changed" alert.
- The shop uses the plain `QRIS` channel.
- No bulk repair of past orders.

## Design

### 1. Per-order charge snapshot

`Order.gatewayChargeAmount Decimal?` (`gateway_charge_amount`) stores the fee-inclusive amount TokoPay
says the buyer must pay. `commitGatewayResult` (`packages/db/src/crud/orders.ts`) writes it in the same
`updateMany` that stores `paymentRef`. A data-only migration
(`20261111090100_order_gateway_charge_amount_backfill`) fills existing `TOKOPAY`/IDR orders: with the
`totalBayar` the old code cached in `payment_ref` when that figure passes `readTokopayCharge`'s
plausibility check, otherwise with the old formula (`total_amount + ROUND(100 + total_amount * 0.007)`,
an approximation for non-QRIS channels and orders with no cached total). It is one-shot: its first run
stores a cutoff in the internal setting `tokopay_gateway_charge_backfill_cutoff` and only orders created
before that cutoff are ever filled, because the deploy entrypoint re-runs it on every start and a new
order may legitimately have no charge yet.

A pure helper in core, `readTokopayCharge(totalAmount, totalBayar)`, returns:

- `{ kind: "ok", charge }` — digits only, at least the nominal sent to TokoPay, and the implied fee at
  most 50% of the total plus Rp10,000 (a guard against a broken response, not a tariff).
- `{ kind: "missing" }` — null or blank.
- `{ kind: "implausible" }` — anything else.

A TokoPay transaction whose total is `missing` or `implausible` is not shown to the buyer: the gateway
claim is released and the existing "payment could not be created" path runs (storefront: contact
fallback with retry; bot: the order shell is cancelled). An error is logged. Nothing is stored.

If TokoPay's dashboard switch makes the shop bear the fee, `total_bayar` equals the total and the
buyer-side fee is zero everywhere, with no change on our side.

### 2. One resolver for the expected charge

`expectedTokopayCharge(order)` in `packages/core/src/payments/tokopayCharge.ts` returns
`order.gatewayChargeAmount`, or `order.totalAmount` when no snapshot exists (an order whose TokoPay
transaction was never recorded). The fee is always `charge − totalAmount`.

Every matching and bookkeeping site uses it: storefront webhook, bot reconcile poller,
`deliverPaidTokopayOrder` (overpayment flags, `Payment.fee`), `findOverpaidExcess`,
`markOrderUnderpaid`, manual match, `creditUnderpaidTopupAnyway`.

Comparison rules are unchanged: below the expected charge is UNDERPAID, above it is overpaid, no
tolerance.

`computeQrisAdminFee`, `qrisChargeAmount`, `QRIS_ADMIN_FEE_FLAT` and `QRIS_ADMIN_FEE_PERCENT` are
deleted.

### 3. Buyer-facing amounts

| Screen | What is shown |
|---|---|
| Bot QR caption (product order and wallet top-up) | TokoPay's total; fee row = total − order total |
| Storefront pay page | TokoPay's total and the fee row, once the transaction exists |
| Storefront checkout and instant-buy summary, before the QR | order total, plus a note that a QRIS admin fee from the payment provider is added on the payment page; no fee figure |
| Payment-method row note (`web.qris_admin_fee_note`) | "+ biaya admin QRIS" / "+ QRIS admin fee" |

The checkout totals API no longer returns `qris_admin_fee` / `qris_grand_total`. The pay-page API keeps
both fields; they are null until the gateway result exists.

The bot sends and edits exactly the same messages as today; only the numbers change. The bot shows no
fee figure before the QR today, and that stays.

## Error handling

- `total_bayar` missing or implausible: no QR, claim released, error logged.
- An order with no snapshot (should not happen for a payable TokoPay order): expected charge is the
  order total, so a real payment is delivered and its fee portion is flagged as an overpayment for an
  admin to look at, rather than the order being stuck.

## Testing

- Core: `readTokopayCharge` (ok, missing, below nominal, non-digits, above cap), `expectedTokopayCharge`
  with and without a snapshot.
- DB: `commitGatewayResult` writes the snapshot only when the claim matches; `commitTokopayGateway`
  stores TokoPay's total and refuses a missing or implausible one.
- Matching, for the webhook and the reconcile poller, product orders and wallet top-ups: paid equal to
  the snapshot is delivered; below is UNDERPAID; above is overpaid.
- Manual match, overpayment excess and underpaid top-up credit read the snapshot.
- Bot: caption shows the snapshot; exact message counts stay pinned; a missing total sends no QR.
- Storefront: checkout totals carry no fee figure; pay page shows the snapshot.
- Client: the checkout summary shows the note instead of a fee amount, and the order total is the plain
  total for QRIS.

Gates: affected tests per task; at the end `pnpm typecheck && pnpm test`, and because React client
source changes, `pnpm doctor:changed`, `pnpm doctor:bugs`, `pnpm doctor:full` at 0 errors and 0
warnings, recorded in `docs/REACT_DOCTOR_PHASE_1_REPORT.md`.

## Deploy

This deployment never runs `prisma migrate deploy`. `docker-entrypoint.sh` runs `prisma db push`, which
adds the nullable `gateway_charge_amount` column, then runs the data-only migrations listed in its
`DATA_MIGRATIONS`, which now include the backfill. The backfill runs once in effect (cutoff above); later
starts change nothing. Full checklist: `docs/arsitektur/PAYMENT_GATEWAY.md` (TokoPay, "Deploy").

1. Keep TokoPay disabled from before the deploy until the post-deploy checks pass.
2. Pre-deploy, read-only: confirm the cached `totalBayar` of recent TokoPay orders is plain digits (any
   other format would make every new TokoPay transaction refused), and take a database backup.
3. Deploy the new image and restart server, storefront and order-bot on it together. New code before the
   column exists fails with P2022; old code after the column exists is harmless.
4. Post-deploy: TOKOPAY/IDR orders created before the cutoff with a null charge must number 0.
5. Re-enable TokoPay. Nothing has to be configured. Pay one small real QRIS order through the bot and one
   through the storefront: the caption / pay-page total equals the banking app's figure, the order
   delivers and is not flagged overpaid. Watch the logs for "no usable total" and "could not be
   verified" during the first day.
