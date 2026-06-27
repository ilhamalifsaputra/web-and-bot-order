# Dual credit balance (IDR + USDT) + credit-on-unfulfilled-order

**Date:** 2026-06-16
**Status:** Design approved, pending spec review

## Problem

Two buyers can compete for the same stock, or a buyer's payment can arrive late
or asynchronously. The result: money lands for an order that can no longer be
fulfilled (the unit was reserved/sold to someone else, or stock vanished at
delivery). Today that money becomes an **unmatched** payment on the Payments
page with no automatic resolution.

We want the affected buyer's money to land in a **credit balance** they can spend
on a future purchase — in the **same currency they paid**, with no conversion.

Decisions taken during brainstorming:
- Money goes to a **credit balance** (store credit), not back to the buyer's
  external account. The word "refund" is intentionally avoided — the money does
  not leave the system. The word "saldo" is also avoided; the domain term is
  **credit balance**.
- USDT-paid money must stay USDT and be spendable **only on USDT orders**;
  IDR-paid money stays IDR for IDR/QRIS orders. Therefore **two separate credit
  balances** (Approach A), no cross-currency conversion.

## Current system (facts the design builds on)

- `users.wallet_balance` is a single `Decimal`, effectively **IDR**-denominated
  (shown via the `money`/`idr` filters). USDT orders derive their total from IDR
  via an `fxRate` snapshot.
- `wallet_transactions` is an append-only ledger: one row per applied move
  (`delta`, `balanceAfter`, `reason`, optional `adminId`/`orderId`). Reasons
  already include `order_payment`, `order_refund`, `underpaid_refund`,
  `admin_adjust`, `referral`.
- All balance moves go through one chokepoint: `adjustWallet(db, userId, delta,
  opts)`.
- Credit balance **is already spent at checkout**: `order_payment` debits it on
  order creation; `order_refund` credits it back on cancel
  (`releaseOrderHolds`). But this is wired only on **IDR** orders — USDT/internal
  orders currently force `walletUsed = 0`.
- Stock is reserved at **order creation** (`AVAILABLE → RESERVED → SOLD`); a
  reservation is released back to `AVAILABLE` on cancel/expiry. So two buyers
  cannot hold the same unit at once — the failure mode is a **late/async
  payment** against an order that already expired, or stock lost at delivery.
- Payment matchers tag a payment `matched` / `underpaid` / `unmatched` /
  `delivery_failed` / `dismissed`. `delivery_failed` already covers "payment
  matched a PENDING order but stock was gone at delivery." `unmatched` (no
  `orderId`) is money the live matcher couldn't tie to a PENDING order — but a
  QRIS payment carries `ref = orderCode`, and crypto carries a unique amount, so
  a *cancelled* order is often still identifiable.
- Precedent: `refundUnderpaidOrder` already credits the balance via
  `adjustWallet` (this existing flow keeps its current naming; not renamed here).

## Goals / non-goals

**Goals**
1. A second, independent **USDT credit balance** alongside the IDR one.
2. Spend routing: an order spends only the credit balance matching its currency.
3. **Credit-on-unfulfilled-order**: when a paid order can't be fulfilled, add the
   paid amount to the buyer's matching-currency credit balance.

**Non-goals**
- Cross-currency conversion between the two balances.
- Returning money to the buyer's external account.
- More than two currencies (IDR, USDT).

## Terminology

| Domain term | Use |
|---|---|
| **credit balance** | the user-facing name for the wallet balance(s) |
| **IDR / USDT credit balance** | the two per-currency balances |
| "add to credit balance" / "credited to balance" | the action |
| ~~refund~~, ~~saldo~~ | **do not use** in new copy/identifiers |

Existing internal identifiers (`wallet_balance`, `WalletTransaction`,
`adjustWallet`, reason `order_refund`) are kept for continuity; only **new**
identifiers and **all** user-facing labels use "credit balance".

## Data model (Approach A — two columns + currency-tagged ledger)

- `users.wallet_balance` **stays = IDR** balance (no value migration needed).
- Add `users.wallet_balance_usdt Decimal @default(0) @map("wallet_balance_usdt")`.
- `wallet_transactions`: add `currency String @default("IDR") @map("currency")`.
  Existing rows default to `IDR` (correct — the system was IDR-base). `delta` and
  `balanceAfter` are interpreted in that row's currency.
- `orders.walletUsed` unchanged — it is implicitly in the order's `currency`.
- **Migration:** add columns with `prisma db push` (or a migration) and restart
  order-bot **before** new code runs (CLAUDE.md deploy rule), to avoid
  `P2022 column … does not exist`.

## Component 1 — currency-aware `adjustWallet`

`adjustWallet(db, userId, delta, opts)` gains `opts.currency: "IDR" | "USDT"`,
defaulting to `"IDR"` (back-compat: every current caller keeps behaving as IDR).

- Reads/writes the matching column (`wallet_balance` for IDR,
  `wallet_balance_usdt` for USDT).
- Per-currency overdraw check → `error.insufficient_wallet` unless
  `allowNegative`.
- Writes one `wallet_transactions` row tagged with `currency`.

This stays the single chokepoint; no other code reads/writes balances directly.

## Component 2 — spend routing

- At checkout, `walletUsed` is debited from the **order-currency** balance:
  IDR order → IDR balance, USDT order → USDT balance. This also **enables the
  currently-disabled USDT spend path** (`createInternalOrder` / bybit), so a USDT
  credit balance is actually usable.
- Only the matching-currency balance is offered/applied in the "use credit
  balance" UI; the other currency's balance is never shown as spendable on that
  order.
- `releaseOrderHolds` credits `walletUsed` back with `{ currency: order.currency
  }` on cancel/expiry.

## Component 3 — credit-on-unfulfilled-order (the trigger)

New CRUD `creditOrderToBalance(db, orderId, { adminId? })`:
- Credits the **paid amount** to the buyer's credit balance in `order.currency`
  via `adjustWallet({ currency, reason: "unfulfilled_credit", orderId })`.
- Releases any held stock and marks the order `CANCELLED` (the order is void; the
  balance credit is evidenced by the ledger row). The existing `REFUNDED` status
  is intentionally **not** used, to keep "credit balance, not refund" semantics.
- **Idempotent**: guarded by order status + the absence of a prior
  `unfulfilled_credit` ledger row for that order, so a retry/double-tap cannot
  double-credit.
- Audited via `logAdminAction`.

**Entry points**
- **(a) Admin manual — Payments panel (Phase 2 start).** For an `unmatched` tx
  the admin can identify, add **"Add to buyer's credit balance"** next to the
  existing Dismiss / Match-by-hand. Admin picks the order/buyer; the tx is marked
  with a new outcome `credited_to_balance`.
- **(b) Admin order action.** When `approveOrder` can't deliver (out of stock →
  `delivery_failed`), offer "Add paid amount to buyer's credit balance."
- **(c) Auto-link in matchers (follow-up).** When a matcher/webhook resolves a
  payment to an order that is no longer deliverable but **confidently
  identifiable** (QRIS `ref = orderCode`; crypto unique-amount → the cancelled
  order), credit the balance automatically and set outcome
  `credited_to_balance` instead of leaving it `unmatched`.

Truly unidentifiable money (no buyer) stays manual → **Dismiss**, as today.

New processed-tx outcome: `credited_to_balance` added to `TX_OUTCOMES`.

## Component 4 — surfaces (display)

- **Web admin:** user detail shows both credit balances; the wallet ledger gains
  a **currency** column; Payments panel gets the "Add to buyer's credit balance"
  action + the new outcome badge.
- **Storefront account:** show **IDR credit balance** and **USDT credit balance**
  separately.
- **Bot:** the buyer's profile/credit-balance screen shows both; checkout's "use
  credit balance" offers only the order-currency balance.
- **i18n:** new keys in `en.json` + `id.json`, identical key sets, matched
  placeholders. Buyer-facing copy uses "credit balance" / "credit balance kamu",
  never "refund" or "saldo".

## Error handling / edge cases

- Per-currency overdraw → `error.insufficient_wallet`.
- All credit/spend/stock mutations run inside one short `$transaction`
  (single-writer SQLite serializes; keep it short).
- Double-credit prevention: `creditOrderToBalance` checks order status and the
  ledger for an existing `unfulfilled_credit` row for that order before applying.
- Existing data: all current balances and ledger rows are IDR — correct by
  default with the new `currency` default.

## Testing

- `adjustWallet` per-currency: independent credit / debit / overdraw on each
  balance (extend `wallet.test.ts`).
- Spend routing: IDR order debits IDR balance; USDT order debits USDT balance.
- `releaseOrderHolds` credits back in the order's currency.
- `creditOrderToBalance`: credits the correct currency, marks order `CANCELLED`,
  is idempotent on retry.
- Matcher / `delivery_failed` path → identifiable order → balance credit +
  `credited_to_balance` outcome.
- Web render: two credit balances + ledger currency column + Payments action.

## Phasing

- **Phase 1 — foundation:** schema (two columns + ledger currency),
  currency-aware `adjustWallet`, spend routing (incl. enabling USDT spend),
  display surfaces. Self-contained; the USDT credit balance becomes real and
  spendable.
- **Phase 2 — credit trigger:** `creditOrderToBalance` + admin manual action
  (Payments panel + order action) + `credited_to_balance` outcome. Matcher
  auto-link (entry point c) is a follow-up within this phase.
