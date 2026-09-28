# Audit: Per-SKU Delivery Flows — Ultra Code Review

**Date:** 2026-07-13
**Scope:** `feat/per-sku-delivery-flows` (uncommitted working-tree diff vs `master`, ~79 files, ~4,100 insertions)
**Method:** `/code-review ultra --fix` — 10 parallel finder angles (line-by-line scan,
removed-behavior audit, cross-file trace, language-pitfall scan, wrapper/proxy
correctness, reuse, simplification, efficiency, altitude, CLAUDE.md conventions),
each independent and unaware of the others' output, followed by 1-vote verification
(every candidate re-checked against live source by a fresh reader) and a final gap
sweep by a fifth-pass reviewer. All 15 findings below were **CONFIRMED** — a
verifier independently traced the exact trigger and quoted the code proving it.

This review runs *after* the feature's own 11-task implementation, each of which
was independently reviewed (several with a fix-and-re-review cycle), and after a
dedicated final whole-branch review. The findings here are almost entirely
**integration gaps between this feature and pre-existing code**, or **edge cases
across multiple new surfaces at once** — exactly the class of bug that per-task
review, however thorough, structurally cannot see.

---

## Critical / High severity

### 1. Admin "Resend to Telegram" sends an empty file for manually-fulfilled orders
**File:** `apps/web-admin/src/routes/api/orders.ts` (resend route, ~line 202) +
`apps/web-admin/client/src/pages/OrderDetailPage.tsx` (`canResend`, ~line 153)

The pre-existing resend route gates only on `status === DELIVERED` and the buyer
having a Telegram id, then unconditionally enqueues `ORDER_DELIVERED_DM` — the
stock-credentials event. The dispatcher's `deliverAccountDm` builds the file via
`groupCredentials`, which explicitly skips any item with no `stockItem`
(`packages/core/src/delivery.ts:38`). A manually-fulfilled order never reserves
stock (`fulfillManualOrder`'s own doc comment: "No stock is touched"), so
`stockItem` is always null. **The buyer receives an empty `.txt` file instead of
their actual `deliveredContent`, while the admin's toast and audit log both
report success.** `canResend` has no delivery-type check, so the button is shown
unconditionally.

**Fix:** branch on delivery type — for a manual order, enqueue
`enqueueManualDeliveredDm` (which already exists and reads `deliveredContent`
live) instead of `enqueueOrderDeliveredDm`.

### 2. No refund/reject/cancel path for a stuck `PROCESSING` order
**File:** `packages/db/src/crud/orders.ts` (`rejectOrder`, ~line 949)

`orderStatus.ts`'s `LEGAL_TRANSITIONS` was updated to declare
`PROCESSING → REJECTED`/`PROCESSING → CANCELLED` legal, but `rejectOrder` itself
still hard-guards `order.status !== PENDING_VERIFICATION` and throws otherwise.
No UI (web-admin or bot) exposes any reject/cancel/credit action for a
`PROCESSING` order — only "Send to Buyer" (`canFulfill`). **An admin who cannot
actually source a manual item for a paid order has no way to refund the buyer
short of direct DB manipulation.**

**Fix:** widen `rejectOrder`'s guard to accept `PROCESSING` (and thread through
whatever compensating action — e.g. wallet credit or manual refund note — the
product wants for a paid-but-unfulfillable manual order), and add the
corresponding UI action.

### 3. Unescaped admin-authored text breaks the bot's info-collection wizards
**File:** `apps/order-bot/src/conversations/customerInfo.ts` (`fieldPrompt`, ~line 51)
and `editCustomerInfo.ts` (`fieldPrompt`, ~line 64)

Both interpolate the admin-defined `field.label`, `field.options`, and
`field.placeholder` into a Telegram `parse_mode: "HTML"` message without calling
this codebase's `esc()` helper — even though `zAdditionalField` places no
character restriction on what an admin types. `editCustomerInfo.ts` escapes the
*buyer's* prior answer three lines below (line 73) but misses the admin-authored
strings, showing the gap was known for one interpolation point but not the
other. **Any admin who types `<`, `>`, or `&` into a field label breaks Telegram's
HTML parser — a 400 "can't parse entities" error — for every buyer of that SKU,
not just a cosmetic glitch.**

**Fix:** wrap `label`, `field.options.join(...)`, and `field.placeholder` in
`esc()` in both files, matching every other admin-controlled string sent as HTML
elsewhere in this codebase.

### 4. Bot checkout persists stale/unvalidated `customerData` after a quantity change
**File:** `apps/order-bot/src/handlers/checkout.ts` (`showOrderConfirmation`
gate, ~line 340)

The `manual_with_info` info-collection gate is `!ctx.session.scratch.customerData`
— presence-only, not "does it match the current product/quantity." Nothing
clears `scratch.customerData` when a buyer backs out and changes quantity or
switches to a different `manual_with_info` product before re-tapping Buy.
`createOrderDirect`/`createOrderFromCart` persist it verbatim with **no**
server-side re-validation on the bot's path. The storefront's `performCheckout`
explicitly re-validates via `validateCustomerData(fields, customerData,
line.quantity)` as "the final server-side boundary… never trusted" — the bot has
no equivalent. **A buyer can end up with an order whose item count doesn't match
its stored answer count, silently missing data for later units, with the admin
never told.**

**Fix:** either clear `scratch.customerData` whenever quantity/product changes
after the wizard completes, or (better, matching the storefront's defense in
depth) call `validateCustomerData` server-side in the bot's order-creation path
too, not just at collection time.

### 5. Storefront's cart-homogeneity/customerData guard can be bypassed by a mid-checkout deactivation
**File:** `apps/storefront/src/routes/checkout.ts` (`performCheckout`, ~line 369)

The new mixed-delivery guard and the `manual_with_info` `customerData`
validation both key off `activeCartLines` (filtered by `product.isActive`), but
`createOrderFromCart` (`packages/db/src/crud/orders.ts:295`) reads the cart via
the **unfiltered** `getCart` and has no `isActive` check of its own. If an admin
deactivates a `manual_with_info` denomination between the buyer adding it to
cart and completing checkout, `activeCartLines` becomes empty — both the
homogeneity check and the `customerData` validation are skipped — while the raw
cart still has the line, so `createOrderFromCart` still creates the order.
**Result: a `PROCESSING` order with `customerData: null` for a SKU whose admin
fulfillment view depends entirely on those answers.**

**Fix:** make the `isActive` filtering consistent between the guard/validation
and the actual order-creation read (either both filtered or both raw), or have
`createOrderFromCart` itself reject/skip inactive lines explicitly.

---

## Important severity

### 6. Payment bubble never updates for a "processing" (manual-delivery) order
**Files:** `apps/order-bot/src/payments/{tokopayReconcile,paydisiniReconcile,binanceInternal,bybitDeposit,bybitBscDeposit}.ts`

Every gateway reconcile/poll loop's new `"processing"` branch only logs — none
call the sibling `"delivered"` branch's `editBubbleToSuccess`/
`clearOrderPaymentMessage`. The sweep mechanism that could catch this later,
`listDeliveredOrdersAwaitingEdit`, is gated strictly on `status: DELIVERED` and
never picks up a `PROCESSING` order. **A buyer who pays for a manual-delivery SKU
sees their "waiting for payment" QR bubble stuck indefinitely, even though a
separate `ORDER_PROCESSING_DM` was sent** — the two signals disagree.

**Fix:** have the "processing" branch also flip the anchored bubble to a
"payment received, being prepared" state and clear the payment-message anchor,
or extend the sweep to also catch `PROCESSING` orders.

### 7. `nudgeOutboxDispatcher()` skipped on 8 of 9 "processing" branches
**Files:** same payment-rail files as #6, plus `apps/order-bot/src/handlers/verification.ts` and `apps/storefront`'s wallet-checkout path

`settlePaidOrder`'s processing path enqueues `ORDER_PROCESSING_DM`, but only
`apps/web-admin/src/routes/api/orders.ts`'s `/approve` route nudges the
dispatcher unconditionally. Every other call site's processing branch omits the
nudge. **The buyer's "your order is being prepared" DM is delayed by up to the
full poll interval instead of arriving near-instantly**, unlike every other
just-paid notification in the codebase.

**Fix:** add `nudgeOutboxDispatcher()` to every processing branch, matching the
web-admin route's pattern.

### 8. `lowStockDenominations` doesn't exclude non-`auto` SKUs
**File:** `packages/db/src/crud/catalog.ts` (~line 359)

Manual/`manual_with_info` SKUs never have `StockItem` rows by design, so they
permanently read `available: 0` — below any realistic threshold. `verification.ts`'s
`maybeAlertLowStock` (fired on every auto-order approval) and the admin
dashboard's inventory widget both consume this unfiltered, so **every manual SKU
generates a false "critically low stock" alert forever**, drowning out genuine
signals for actual auto-stock SKUs.

**Fix:** filter `lowStockDenominations`'s query to `deliveryType: "auto"`.

### 9. No duplicate-key guard on admin-defined custom fields
**File:** `packages/core/src/deliveryFields.ts` (`zAdditionalFields`, ~line 53) +
`apps/web-admin/client/src/components/shared/AdditionalFieldsEditor.tsx`

Neither the zod schema nor the client-side editor rejects two fields sharing the
same `key`. `validateCustomerData`'s per-field loop does a plain
`out[field.key] = ...` assignment, so **if an admin accidentally creates two
fields with the same key, the buyer is still prompted for both (and types two
different answers), but only the second answer survives in storage** — silent
data loss with no error anywhere.

**Fix:** add a `.refine()` on `zAdditionalFields` rejecting duplicate keys, and
a matching client-side check in the field editor.

### 10. `editCustomerInfo`'s `/skip` + narrow error handling can crash the wizard
**File:** `apps/order-bot/src/conversations/editCustomerInfo.ts` (~line 168, ~line 213)

`/skip` carries forward the buyer's previously-stored answer **without
re-validating it against the field's current spec**. The final commit's
`catch` block only special-cases `error.order_not_processing` — any other
`ValidationError` (e.g. `error.field_invalid_select` from a spec that changed
mid-edit) falls through to `throw e`, crashing the wizard instead of
re-prompting in the same bubble like every other validation error in this file.

**Fix:** re-validate skipped values against the current spec, and widen the
catch to handle any `ValidationError` from `updateOrderCustomerData` with a
re-prompt, not just the one specific race key.

---

## Minor severity

### 11. Hardcoded English string in the bot's admin approve flow
**File:** `apps/order-bot/src/handlers/verification.ts` (~line 169)

`approve()`'s new "processing" branch sends
`` `✅ Order <code>${orderCode}</code> payment approved — queued for manual fulfilment.` ``
directly via `adminEdit`, bypassing `t()`/`coreT()` — even though the toast
three lines earlier correctly uses `coreT("admin.approved_processing", ...)`.
**Violates CLAUDE.md's "No leaked English… customer- and admin-facing strings go
through `t(ctx, key, args)`"** rule for the bot (this is the bot's own admin
flow, not the separately-exempt English-only web-admin SPA).

**Fix:** add an i18n key and route through `coreT()`.

### 12. Raw untranslated error key shown to admin on underpaid-manual-SKU delivery attempt
**File:** `packages/db/src/crud/binance_internal.ts` (`deliverUnderpaidOrder`) +
`apps/web-admin/src/routes/api/payments.ts` (~line 88) +
`apps/web-admin/client/src/pages/PaymentsPage.tsx`

The `deliverUnderpaidOrder` → `approveOrder` scope exclusion for manual SKUs is
intentional and correct (fails closed with `error.cannot_deliver_out_of_stock`).
But the route forwards `e.message` (which for a `ValidationError` is literally
the raw key string) straight into a client-side `alert(...)`. **The admin sees
the literal text `error.cannot_deliver_out_of_stock`**, not a readable message.

**Fix:** map the error key to a readable string before displaying (either
server-side or via a small client-side lookup), here and in finding #13.

### 13. Same raw-error-key pattern on the new manual-fulfillment route
**File:** `apps/web-admin/src/routes/api/orders.ts` (`/fulfill` route, ~line 322) +
`OrderDetailPage.tsx`

The new `fulfill` route returns `{ error: e.message }` on `ValidationError`;
`OrderDetailPage.tsx` renders it as raw text. **Two admins racing to fulfill the
same order (or a double-tap) shows the second admin the literal string
`error.order_not_processing`** instead of "this order was already fulfilled."
Same defect class as #12, different code path (new, not pre-existing).

**Fix:** same as #12 — translate before display.

### 14. Admin's client-side "at least one field" check is weaker than the server's validation
**File:** `apps/web-admin/client/src/lib/additionalFields.ts` (`hasAtLeastOneField`, ~line 59)

Only checks for a non-empty `key`. The server's `zAdditionalField` also requires
the key to match `/^[a-z0-9_]+$/`, both bilingual labels non-empty, and at least
one option for a `select` type. **The Save button can be enabled (and clicked)
on a spec the server will reject**, with only a generic error back — the admin
can't tell which specific requirement failed.

**Fix:** mirror the server's actual validation rules client-side (the codebase
already has a "client mirrors server" convention — see
`apps/storefront/client/src/lib/deliveryFields.ts`).

### 15. Two new notification-enqueue functions reimplement an existing helper
**File:** `packages/db/src/crud/notifications.ts` (`enqueueOrderProcessingDm`
~line 314, `enqueueManualDeliveredDm` ~line 341)

Both hand-roll `db.notificationOutbox.create({ event, orderId, payloadJson:
JSON.stringify(...) })` instead of calling the existing generic
`enqueueNotification(db, event, orderId, payload)` a few hundred lines above,
which does exactly this. Pure DRY — safe, behavior-preserving refactor
(verified: same resulting DB row either way).

**Fix:** delegate to `enqueueNotification` after the existing `telegramId ==
null` guard in each function.

---

## Noted but not independently re-verified (lower priority, not included in the 15 above)

These surfaced during the review but are efficiency/simplification/altitude
observations rather than correctness bugs, and were not run through the
1-vote verification step (the 15 above filled the review's finding cap, and
correctness bugs outrank cleanup findings by the review's own rules):

- `apps/order-bot/src/handlers/customer.ts`'s `refreshOrderDetail` does 3 full
  eager-loaded `getOrder` queries per button tap (a "before" snapshot, `viewOrder`'s
  own internal load, and an "after" snapshot) where 1-2 lighter queries would do.
- `settlePaidOrder` loads a full order just to read `deliveryType`, then its
  `auto` branch calls `approveOrder`, which immediately re-queries the same order.
- `fulfillManualOrder`'s final refresh-and-return is discarded by its only
  production caller.
- `performCheckout`'s new homogeneity check calls `getCart` a second time in the
  same transaction `createOrderFromCart` already calls it in (this redundancy
  was introduced by this review session's own final-whole-branch-review fix).
- Redundant loop counters in `customerInfo.ts`/`editCustomerInfo.ts` (`unitIdx`/
  `fieldIdx` are both fully derivable from array lengths already in scope).
- The `customerData` scratch-read-then-delete pattern is copy-pasted across 7
  `buyNow*` bot handlers instead of one shared helper.
- `tokopay.ts`/`paydisini.ts`/`nowpayments.ts` each check `result.kind ===
  "delivered"` twice with unrelated logic sandwiched between, instead of once.
- No shared `isAutoDelivery(denom)` predicate — 13 files independently compare
  `deliveryType` against `"auto"`/`"manual_with_info"` via raw string equality,
  with two subtly different idioms (`!== AUTO` vs `=== MANUAL_WITH_INFO`) that
  only agree today because there are exactly three delivery types.
- The "one delivery type per order" invariant is enforced by two independently-
  authored checks (the cart-add route and `performCheckout`) rather than one
  shared function both call — and the actual bypass path (guest-cart-merge in
  `apps/storefront/src/routes/auth.ts`) is still open at its source; this
  session's fix (finding context, not in the 15) only catches the *symptom* at
  checkout time, it doesn't unstick a buyer whose cart is already merged-mixed.

## Fixes applied

All 15 findings were fixed directly in the working tree (not committed —
this whole branch remains uncommitted per explicit user instruction for this
session). Applied via one controller pass (findings #9, #11 → the `en`/`id`
locale key wording matches, and #15) plus three parallel fix batches for the
rest, each independently typechecked and tested:

- **#1, #6, #7** (resend-empty-file, stale payment bubble, missing dispatcher
  nudge) — fixed across `apps/web-admin/src/routes/api/orders.ts` and the 5
  payment-rail files + `verification.ts` + `checkout.ts`'s wallet path.
- **#3, #4, #5, #10** (unescaped wizard text, stale/unvalidated
  `customerData`, mid-checkout deactivation bypass, `editCustomerInfo`
  crash-on-skip) — fixed in both bot wizards, and centrally in
  `createOrderDirect`/`createOrderFromCart` (`packages/db/src/crud/orders.ts`)
  so the re-validation and `isActive` filtering apply to every caller at once
  rather than being duplicated per call site.
- **#2, #8, #12, #13** (no reject path for `PROCESSING`, false low-stock
  alerts, raw untranslated error keys) — `rejectOrder` widened to accept
  `PROCESSING` after confirming its existing side effects (stock release,
  wallet/voucher handling) are safe for a stockless manual order; a new
  `canReject` flag (distinct from `canAct`) exposes it in the admin UI;
  `lowStockDenominations` now filters to `auto` SKUs only; a new
  `describeError()` lookup replaces raw key display in the two admin pages
  that showed one.
- **#9, #14, #15** — new `admin.approved_processing_bubble` i18n key
  (bot); a new `fieldsAreValid()` helper mirroring the server's real
  `zAdditionalField` requirements now gates the admin's Save button (replacing
  the looser `hasAtLeastOneField`); `enqueueOrderProcessingDm`/
  `enqueueManualDeliveredDm` now delegate to the existing `enqueueNotification`
  helper instead of reimplementing it.

**One regression caught during final verification, self-corrected:** tightening
`fieldsAreValid()` (#14) broke 2 of Task 7's own pre-existing tests in
`DenominationCreatePage.test.tsx`, which had encoded the OLD, looser
"just needs a key" contract as their expectation. This was the fix working as
intended (the whole point of #14 is that a key alone should no longer be
enough) — the two tests were updated to fill in both bilingual labels before
expecting the Save button to enable, not reverted.

**Final verification** (run fresh after all 15 fixes, independent of any
batch's own self-reported numbers): full root `pnpm typecheck` clean across
all 10 workspace packages, `pnpm test` green twice in a row —
**193 test files / 1,984 tests, zero failures**.
