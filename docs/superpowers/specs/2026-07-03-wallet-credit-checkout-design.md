# Bot checkout: wallet-credit submenu + zero-total completion

## Context

User report (screenshot of the `testtoko` bot's order-confirmation screen):

1. The "Use USDT Credit" button reads `💎 Use USDT Credit (1.0000 USDT USDT)`
   — "USDT" appears twice.
2. After applying a wallet credit that fully covers the order (Total: Rp0),
   there is no way to actually finish the order — tapping a credit button
   just toggles it, and no gateway button exists to "pay" a Rp0 balance.

Investigation (`apps/order-bot/src/keyboards/customer.ts`,
`apps/order-bot/src/handlers/checkout.ts`, `packages/db/src/crud/orders.ts`,
`packages/db/src/crud/pricing.ts`, `packages/db/src/crud/tokopay.ts`) found:

- Bug 1 is a locale-string bug: `checkout.use_wallet_usdt_btn` /
  `wallet_usdt_active_btn` append a literal `" USDT"` after `{amount}`, but
  `{amount}` is built with `formatPrice(usdtBalance, "USDT", 4)`, which
  already appends `" USDT"`.
- Bug 2 is a real feature gap, not just UI: there is **no code path anywhere**
  that completes an order paid entirely by wallet credit. Every existing
  "buy now" rail (`buyNowTokopay`, `buyNowPaydisini`, `buyNowInternal`,
  `buyNowBybit`, `buyNowBybitBsc`, `buyNowNowpayments`) charges an external
  gateway for `order.totalAmount`; none of them special-case a total of 0.
- Separately, `computeConfirmation` (`checkout.ts`) only ever deducts **IDR**
  wallet credit from the previewed `Total` — toggling "Use USDT Credit" does
  not change the Total shown at all. USDT credit only takes effect later, if
  the buyer proceeds through a USDT gateway rail (`applyUsdtWalletToOrder`,
  called post-`finalizeOrderPayment` in `buyNowInternal`/`buyNowBybit`/
  `buyNowBybitBsc`/`buyNowNowpayments`).
- `Order` has a single `walletUsed` column and a single `currency` column
  per row (`prisma/schema.prisma`). Refund-on-cancel
  (`releaseOrderHolds`, `packages/db/src/crud/orders.ts:597-605`) credits
  `walletUsed` back to whichever wallet matches `order.currency`. Combining
  an IDR-credit deduction and a USDT-credit deduction on the *same* order
  would make a cancel refund the wrong wallet (fund-misdirection bug), so an
  order's wallet credit must stay single-currency.
- The dual-currency wallet itself (`User.walletBalance` /
  `walletBalanceUsdt`, `adjustWallet(..., { currency })`) is already correct
  and stable — confirmed in
  [[2026-07-03-admin-wallet-dual-currency-design]], which found the same
  backend fully working and only touched the web-admin UI. This spec builds
  on that same `adjustWallet` primitive, bot-side.
- The existing TokoPay auto-deliver path
  (`deliverPaidTokopayOrder`, `packages/db/src/crud/tokopay.ts`) is the
  reusable template for "fully paid → deliver now": claim idempotency →
  transition `PENDING_PAYMENT → PENDING_VERIFICATION` →
  `approveOrder(tx, id, { adminId: 0 })` (stock allocation + `DELIVERED` +
  enqueue `ORDER_DELIVERED_DM` outbox notification) → nudge the outbox
  dispatcher → edit the bubble to a "payment received" screen. The credential
  file itself is never rendered inline; it always goes out as a separate
  outbox DM (`CLAUDE.md`: never log/leak credentials into the wrong channel).

Scope decisions confirmed with the user during brainstorming:
- Redesign the two direct wallet-credit buttons into a single "Use Wallet
  Credit" entry point that opens a submenu (matches the existing
  `usdtMethodsKb` pattern) — explicitly to avoid the confirmation screen
  getting crowded as more payment methods are added later.
- Build the zero-total ("fully paid by wallet") completion path — this is
  the actual root cause of "no further action" in the report, not just a
  cosmetic fix.
- USDT credit **is** converted (at the live rate) and folded into the
  previewed Total, for parity with IDR credit.
- IDR credit and USDT credit are **mutually exclusive** on a single order
  (never combined) — required by the single-currency `walletUsed`/`currency`
  constraint above.

## Design

### 1. Locale fix — duplicate "USDT"

`packages/core/locales/en.json` and `id.json`: drop the literal `" USDT"`
suffix from `checkout.use_wallet_usdt_btn` and `checkout.wallet_usdt_active_btn`,
since `{amount}` already carries the unit. (`checkout.use_wallet_idr_btn` /
`wallet_idr_active_btn` are unaffected — `formatIdr` has no separate unit
suffix to duplicate.)

### 2. "Use Wallet Credit" submenu

`apps/order-bot/src/keyboards/customer.ts`:

- `orderConfirmKb` drops its two direct wallet rows (lines ~427-442) and
  instead renders **one** row when `idrBalance > 0 || usdtBalance > 0`:
  - Inactive: `checkout.use_wallet_btn` → `💳 Use Wallet Credit`
  - Active (either credit applied): `checkout.wallet_active_btn` with args
    `{ currency, amount }` → `✅ Wallet Credit Applied (IDR −Rp18.000)` or
    `(USDT −$1.0000)`. Unlike today's active-label (which shows the raw
    balance), this shows the **actual amount deducted** — computed by the
    caller (`computeConfirmation`, see §3) and passed in, fixing the
    existing display inaccuracy as part of this rewrite.
  - Tapping (whether active or not) opens the submenu via
    `cb("walletm", "open", productId, qty)`.
- New `walletCreditKb(productId, qty, lang, idrBalance, useWalletIdr, usdtBalance, useWalletUsdt)`,
  same shape as `usdtMethodsKb`:
  - Row per currency with balance > 0: `checkout.wallet_menu_idr_btn`
    (`💳 IDR Credit ({balance} available)`) / active state
    `checkout.wallet_menu_idr_active_btn` (`✅ IDR Credit`), same pattern for
    USDT. Tapping toggles that currency **on** and forces the other **off**
    (`cb("walletm", "idr", productId, qty)` / `cb("walletm", "usdt", ...)`).
  - Tapping the already-active currency toggles it back off (removes the
    credit) — same as today's toggle behavior, just relocated.
  - Back row (`menu.back`) → `cb("walletm", "back", productId, qty)` →
    re-renders the confirmation screen (same bubble, mirrors how
    `usdtMethodsKb`'s Back returns via `cb("buy", ...)`).

`apps/order-bot/src/handlers/callbacks.ts`: new `walletm` domain dispatcher
mirroring `dispatchWallet`/`dispatchUsdt`:
```
walletm:open  → checkout.showWalletCreditMenu(ctx, pid, qty)   // renders walletCreditKb
walletm:idr   → session.useWalletIdr = !session.useWalletIdr; if turning on, useWalletUsdt = false
              → checkout.showWalletCreditMenu(ctx, pid, qty)   // stay on submenu after a toggle
walletm:usdt  → session.useWalletUsdt = !session.useWalletUsdt; if turning on, useWalletIdr = false
              → checkout.showWalletCreditMenu(ctx, pid, qty)
walletm:back  → checkout.showOrderConfirmation(ctx, pid, qty)
```
The old `wallet:idr` / `wallet:usdt` callback actions
(`dispatchWallet` in `callbacks.ts`) are removed — no other caller references
them (confirmed via grep; the `wallet` domain's remaining action is
`wallet:view`, unrelated to checkout, unchanged).

### 3. Confirmation math: USDT credit joins the preview, mutually exclusive

`apps/order-bot/src/handlers/checkout.ts`, `computeConfirmation`:

- Takes an additional `rate: Decimal | null` param (the caller already fetches
  `currentUsdtRate()` — thread it in instead of re-fetching).
- Keep the existing IDR branch unchanged (only reachable when `useWalletIdr`
  is true, which — per the new mutual exclusivity — implies `useWalletUsdt`
  is false).
- Add a USDT branch: when `useWalletUsdt && usdtBalance.greaterThan(0) && rate`,
  compute `usdtTotal = usdtFromIdr(subtotal, rate)`,
  `usdtDeduction = Decimal.min(usdtBalance, usdtTotal)`, convert back with
  `idrEquivalent = usdtDeduction.times(rate)`, subtract `idrEquivalent` from
  `subtotal`, and set `walletLine` to a new key `checkout.confirm_wallet_usdt_line`
  → `"USDT Credit: −{usdt_amount} (≈ {idr_amount})\n"`.
- Returns two new fields the keyboard/render layer needs:
  `walletDeductionLabel: { currency: "IDR" | "USDT"; amount: string } | null`
  (for the entry-button active state, §2) and `fullyCovered: boolean` (whether
  the post-credit `subtotal` is exactly 0 — for §4).
- `rate` can be `null` (USDT payments disabled shop-wide) — the USDT branch
  is simply skipped in that case, same as `hasUsdt` already guards gateway
  buttons elsewhere.

### 4. "Complete Order" button when fully covered

`showOrderConfirmation` / `renderOrderConfirmation` pass `r.fullyCovered`
into `orderConfirmKb` (which currency is active is already implied by the
`useWalletIdr`/`useWalletUsdt` flags the function already receives — no new
param needed for that half). When `fullyCovered` is true:

- Skip rendering the QRIS/PayDisini/USDT gateway rows entirely — charging a
  gateway for Rp0 has no meaning.
- Render one row instead: `checkout.complete_order_btn` (`✅ Complete Order`)
  → `cb("walletpay", productId, qty)`.
- Voucher and the wallet-credit entry button/submenu stay available as
  normal (the buyer can still remove the voucher or switch off the credit,
  which un-covers the order and brings the gateway buttons back on
  re-render).

### 5. Wallet-only completion — server side

New function in `packages/db/src/crud/orders.ts` (colocated tests in the
existing `orders.test.ts`, per `CLAUDE.md`):

```ts
export async function completeOrderWithWallet(
  db: Db,
  args: {
    user: { id: number; role: string };
    productId: number;
    quantity: number;
    voucherCode?: string | null;
    currency: "IDR" | "USDT";
    rate?: Decimal.Value; // required when currency === "USDT"
  },
)
```

- Re-derives subtotal/bulk-discount/voucher-discount from scratch exactly
  like `createOrderDirect` (never trusts the caller's "fully covered" claim —
  same defensive posture as every other `buyNow*` rail, which re-validates
  quantity/stock/voucher server-side).
- For `currency: "IDR"`: reads the caller's *current* `walletBalance`,
  requires it to be `>= afterDiscount` (throws `error.insufficient_wallet`
  otherwise — e.g. a concurrent spend since the preview was rendered), sets
  `walletUsed = afterDiscount`, `totalAmount = 0`, `uniqueCents = 0`,
  `currency: "IDR"`, `paymentMethod: PaymentMethod.WALLET`.
- For `currency: "USDT"`: same shape but against `walletBalanceUsdt`, with
  `afterDiscount` converted via `usdtFromIdr(afterDiscount, rate)` first.
- Deducts the matching wallet via `adjustWallet(db, userId, -walletUsed, { currency, reason: "order_payment", orderId })`
  (same call every other rail already makes).
- Stamps `paidAt: new Date()`, transitions
  `PENDING_PAYMENT → PENDING_VERIFICATION` via `transitionOrderStatus`, then
  calls `approveOrder(db, order.id, { adminId: 0 })` — identical sequence to
  `deliverPaidTokopayOrder`, reused rather than duplicated where the two
  diverge only in "how was payment confirmed."
- Enqueues `ORDER_DELIVERED_DM` the same way `deliverPaidTokopayOrder` does
  (buyer link only, never credentials in the outbox payload).
- Returns the delivered order (caller nudges the outbox dispatcher and edits
  the bubble — see §6).

`packages/core/src/enums.ts`: add `WALLET: "WALLET"` to the `PaymentMethod`
const (string column, no DB migration needed — same as every other
`PaymentMethod` value).

### 6. Bot handler + routing

`apps/order-bot/src/handlers/checkout.ts`: new
`completeOrderWithWallet(ctx, productId, quantity)`, same guard shape as
`buyNowTokopay`/etc.:

1. Load user, check `countUserPendingOrders` against `MAX_PENDING_ORDERS`.
2. `refuseDuplicateCheckout(ctx, user.id, productId, PaymentMethod.WALLET)`.
3. Read `useWalletIdr`/`useWalletUsdt` from session to pick `currency`; if
   neither is set (stale tap on an old bubble), fall back to the existing
   "stale screen" toast pattern used elsewhere in `callbacks.ts`.
4. Call `crud.completeOrderWithWallet` inside `prisma.$transaction`; catch
   `ValidationError` the same way every other rail does (`smartEdit` the
   error + `backToMain`).
5. On success: clear `appliedVoucherCode`/`useWalletIdr`/`useWalletUsdt` from
   session, `smartEdit` the bubble to a new `checkout.wallet_paid` success
   text (mirrors `checkout.qris_paid`'s shape) with `paymentSuccessKb(lang)`,
   then `nudgeOutboxDispatcher()` so the credential DM goes out immediately
   (matches `reconcileOrder`'s call after a TokoPay auto-deliver).

`apps/order-bot/src/handlers/callbacks.ts`: new `walletpay` domain →
`dispatchWalletPay`, calling `checkout.completeOrderWithWallet(ctx, pid, qty)`,
registered in `DOMAIN_ROUTES`.

### 7. New locale strings + admin label

Added to **both** `packages/core/locales/en.json` and `id.json` (matching key
sets, `{placeholders}` matched per `CLAUDE.md`):

- `checkout.use_wallet_btn`, `checkout.wallet_active_btn`
- `checkout.wallet_menu_idr_btn` / `_active_btn`,
  `checkout.wallet_menu_usdt_btn` / `_active_btn`
- `checkout.confirm_wallet_usdt_line`
- `checkout.complete_order_btn`
- `checkout.wallet_paid`

Removed (superseded by the above): `checkout.use_wallet_idr_btn`,
`wallet_idr_active_btn`, `use_wallet_usdt_btn`, `wallet_usdt_active_btn`.

Web-admin: wherever `PaymentMethod` is mapped to a display label for the
orders list/detail (grep for the existing `TOKOPAY`/`BINANCE_INTERNAL` label
map), add a `WALLET → "Wallet"` entry so a wallet-only order doesn't render
as a raw enum string.

## Testing

- `packages/db/src/crud/orders.test.ts`: `completeOrderWithWallet` —
  fully-covered-by-IDR happy path (wallet debited, order `DELIVERED`,
  `paymentMethod: WALLET`); fully-covered-by-USDT happy path (rate
  conversion correct); insufficient-balance-at-completion-time (balance
  dropped between preview and tap) throws `error.insufficient_wallet` and
  makes no wallet/stock change; out-of-stock-at-completion-time throws and
  makes no wallet change; voucher discount + wallet credit combine correctly
  to reach zero.
- `apps/order-bot` keyboard/locale tests: both locale files still have
  matching key sets (existing parity test, if any — otherwise this is a
  manual check per `CLAUDE.md`); `orderConfirmKb` renders the single wallet
  entry button (not two) and the `Complete Order` row only when
  `fullyCovered`.
- `apps/web-admin`: existing order-list/detail tests still pass with a
  `WALLET`-method order fixture rendering its label instead of blowing up.

## Verification

1. `pnpm typecheck` and `pnpm test` green.
2. Manually in the bot: apply IDR credit that exactly covers a cheap
   product → confirm "Complete Order" appears, gateway buttons are gone,
   tapping it delivers immediately and the credential DM arrives. Repeat
   with USDT credit. Confirm switching from IDR credit to USDT credit (or
   vice versa) in the submenu properly clears the other. Confirm a
   *partial* credit still shows the normal gateway buttons (no regression
   to the existing partial-credit + gateway flow). Confirm the USDT button
   label no longer doubles "USDT".
