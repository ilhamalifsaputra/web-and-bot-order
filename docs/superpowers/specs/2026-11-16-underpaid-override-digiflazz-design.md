# Underpaid override forwards Game Top Up orders to Digiflazz

Date: 2026-11-16. Branch: `worktree-digiflazz-underpaid-override`. Owner-approved (option A).

## Problem

An admin can resolve an UNDERPAID order with "Deliver anyway" (`deliverUnderpaidOrder`,
`packages/db/src/crud/binance_internal.ts`). For a Digiflazz-routed order (Game Top Up) this does not
reach the supplier: `settlePaidOrder` (`packages/db/src/crud/orders.ts`) treats `DIGIFLAZZ` +
`completionMode === "ADMIN_OVERRIDE"` as a manual order and writes `digiflazzStatus = "failed"`, so the
order sits in PROCESSING until someone fulfils it by hand. The admin UI gives no hint of that: one generic
"Deliver anyway" dialog serves every product, and the success toast says "Order delivered." The owner hit
this in production: an override looked stuck and nothing arrived at Digiflazz.

## Decisions

1. An override on a Digiflazz-routed order forwards it to Digiflazz automatically, like a paid order.
   Payment facts stay UNDERPAID and the order stays marked `ADMIN_OVERRIDE` with its audited reason.
2. Crediting an `ADMIN_OVERRIDE` order to the buyer's balance is capped at the amount actually received.
3. The override UI differs by product family (Game Top Up vs Premium Apps), decided by the category
   group, never by product name.

## Design

### 1. Dispatch

- `settlePaidOrder`: remove the `ADMIN_OVERRIDE` exclusion. `isDigiflazz` is `provider === "DIGIFLAZZ"`;
  the block that writes `digiflazzStatus: "failed"` for an override is deleted. The existing Digiflazz
  branch then applies unchanged: PROCESSING with meta "automatic fulfillment queued (provider=DIGIFLAZZ)",
  no buyer "processing" DM and no manual-queue admin/owner alerts. `paymentState` stays UNDERPAID and the
  `payment.confirmed.customer` email stays suppressed for `ADMIN_OVERRIDE` (both already keyed on
  `completionMode`, untouched).
- `deliverUnderpaidOrder` returns the settlement kind (`"delivered" | "processing"`) and the order's
  fulfilment provider alongside what it returns today, and its audit sentence says what happened:
  "… fulfillment forwarded to Digiflazz." / "… delivered." / "… queued for manual fulfilment."
- Admin route `POST /api/payments/order/:orderId/deliver`: after the transaction commits, call
  `triggerDigiflazzDispatch(order.id)` when the result is `processing` (it ignores non-Digiflazz orders
  and never throws); the 5-second recovery cron remains the backstop. The response becomes
  `{ ok: true, outcome: "delivered" | "forwarded_to_supplier" | "queued_manual" }` and is what the
  idempotent replay stores.
- `dispatchTriggerGuard.test.ts`: the `ALLOWLIST` entry for `deliverUnderpaidOrder` is removed and
  `deliverUnderpaidOrder` is added to `SETTLE_FUNCTIONS`, so the guard now requires its caller to trigger
  the dispatch.
- `digiflazzCandidateWhere` needs no change: it has no condition on `paymentState` or `completionMode`.

### 2. Credit cap for override orders

`creditOrderToBalance` (`packages/db/src/crud/orders.ts`) credits `args.amount ?? order.totalAmount`.
When `order.completionMode === "ADMIN_OVERRIDE"`, the credited amount is capped at
`findUnderpaidReceived(tx, order.id)` (`_underpaid.ts`; null is treated as zero): the buyer never gets
back more than they sent. The wallet credit the order itself consumed (`walletUsed`) is still released by
the existing hold release, unchanged. When the cap reduces the amount, the audit sentence says so.
A received amount of zero credits nothing and the function reports that through its existing
"nothing credited" result path if one exists, otherwise through a `ValidationError`
`error.override_credit_nothing_received`.

This applies to every `ADMIN_OVERRIDE` order (Digiflazz, manual), not only Game Top Up: the over-credit
exists today on the manual path too.

### 3. Admin UI (`apps/web-admin/client/src/pages/PaymentsPage.tsx`)

The Payments API adds to each underpaid row (non-readonly admins only):
`overrideFamily: "GAME_TOPUP" | "PREMIUM_APPS"`, `overrideProvider: "DIGIFLAZZ" | "MANUAL" | "STOCK"`,
`overrideProductName: string`, and for Game Top Up `overrideTarget: string | null` (the player ID /
target the supplier will receive, from the order's stored customer data through the existing decrypting
reader). The family comes from the order's category group with the same rule
`customerProgressPhase` uses (`packages/core/src/orderFulfillment.ts`): group `GAME_TOPUP`, or no group
and provider `DIGIFLAZZ` → `GAME_TOPUP`; otherwise `PREMIUM_APPS`. That rule is extracted into one
exported function in core and both sites use it.

| | Game Top Up | Premium Apps |
|---|---|---|
| Menu item | "Forward to Digiflazz" (provider DIGIFLAZZ) / "Fulfil anyway" (other) | "Deliver account" |
| Dialog title | "Forward this top-up to Digiflazz?" | "Deliver this account anyway?" |
| Dialog body | product, target, order total; "The order was underpaid. Digiflazz will be charged from your supplier balance. Payment remains incomplete." | plan name; STOCK: "An account is taken from stock and sent now."; MANUAL: "The order goes to the manual queue." ; "Payment remains incomplete." |
| Confirm button | "Forward to Digiflazz" | "Deliver account" |
| Success toast | by `outcome`: "Order forwarded to Digiflazz." / "Order delivered." / "Order queued for manual fulfilment." | same mapping |

Game fields (target, supplier wording) never render for Premium Apps, and account/plan wording never
renders for Game Top Up. Wallet top-up rows keep "Credit to balance anyway" unchanged. The page's strings
stay hard-coded English like the rest of the page. The reason field stays required in both dialogs.

### 4. Out of scope

- Orders already parked by the old behaviour (`digiflazzStatus = "failed"`) are not re-dispatched; they
  stay in manual resolution.
- Bot-side admin screens.
- Refund paths other than `creditOrderToBalance`.

## Testing

- DB: override on a DIGIFLAZZ order → PROCESSING, `digiflazzStatus` not "failed", selected by
  `digiflazzCandidateWhere`, `paymentState` UNDERPAID, `completionMode` ADMIN_OVERRIDE, no manual-queue
  alert rows, no processing DM; override on STOCK and MANUAL orders unchanged.
- DB: `creditOrderToBalance` on an override order with received 40000 of total 50000 credits 40000;
  received unknown credits nothing; a non-override order still credits the total.
- Admin API: deliver route calls the dispatch trigger after commit for a processing Digiflazz result,
  returns the right `outcome`, replays it idempotently; underpaid rows carry the new fields; readonly
  rows do not.
- Guard: `dispatchTriggerGuard.test.ts` passes with the allowlist entry gone.
- Client: correct menu label, dialog and toast per family and provider; the other family's wording is
  absent; wallet top-up row unchanged.

Gates: affected tests per task; at the end `pnpm typecheck && pnpm test`, `pnpm doctor:changed`,
`pnpm doctor:bugs`, `pnpm doctor:full` at 0 errors / 0 warnings, recorded in
`docs/REACT_DOCTOR_PHASE_1_REPORT.md`. Server and admin client ship together.
