# Underpaid Override → Digiflazz Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An admin "Deliver anyway" on an UNDERPAID Digiflazz-routed order forwards it to Digiflazz; crediting an override order is capped at what the buyer actually paid; the override UI differs between Game Top Up and Premium Apps.

**Architecture:** Remove the `ADMIN_OVERRIDE` exclusion in `settlePaidOrder` so the existing Digiflazz branch and dispatch candidate query apply; trigger the dispatch from the admin route after commit. Cap `creditOrderToBalance` for override orders with `findUnderpaidReceived`. The Payments API adds family/provider fields to underpaid rows and the client renders a family-specific menu item, dialog and toast.

**Tech Stack:** TypeScript, pnpm workspaces, Prisma (PostgreSQL), Fastify (web-admin), React (admin client), Vitest, decimal.js via `@app/core/money`.

**Spec:** `docs/superpowers/specs/2026-11-16-underpaid-override-digiflazz-design.md` — read it; it is the requirements. Line numbers below are approximate; locate code by name.

## Global Constraints

- All money is `Decimal` from `@app/core/money`; never `number`/`parseFloat`.
- No raw SQL in routes/handlers; DB access lives in `packages/db/src/crud/*`.
- Audit entries (`logAdminAction`) are short natural-language sentences, never `key=value`.
- Pino logs are full English sentences; no secrets; no truncated id lists.
- The web never sends Telegram; it enqueues to the outbox.
- Premium Apps and Game Top Up stay separate: the family comes from the category group via the established resolver, never from a product name; family-specific wording/fields appear only for their family; tests assert presence for the right family and absence for the other.
- `triggerDigiflazzDispatch` is never called inside a `$transaction` callback (a guard test enforces it).
- React client: no lint/doctor suppressions, no disabled rules, no excluded files.
- Stage files by name; never `git add -A`/`-a` (a hook regenerates `graphify-out/`).
- Commit messages end with `Co-Authored-By: Claude Fable 5.2 <noreply@anthropic.com>` and no other attribution.
- Per task run only affected tests (`pnpm exec vitest run <path>`) and `pnpm --filter <pkg> typecheck`.
- Never `git stash`, never switch branch, never `git reset --hard`.

---

### Task 1: Override forwards Digiflazz orders (db + admin route + guard)

**Files:**
- Modify: `packages/db/src/crud/orders.ts` (`settlePaidOrder`, provider decision ~3267-3272)
- Modify: `packages/db/src/crud/binance_internal.ts` (`deliverUnderpaidOrder` ~941-1001)
- Modify: `apps/web-admin/src/routes/api/payments.ts` (`POST /api/payments/order/:orderId/deliver` ~204-265)
- Modify: `packages/db/src/crud/dispatchTriggerGuard.test.ts` (`SETTLE_FUNCTIONS`, `ALLOWLIST`)
- Test: `packages/db/src/crud/wallet_payment_facts.test.ts`, `apps/web-admin/test/payments-mutations-idempotency.test.ts` (and `apps/web-admin/test/web.test.ts` if its deliver-route test asserts the response body)

**Interfaces — Produces:**
- `deliverUnderpaidOrder(db, { orderId, adminId, reason })` resolves `{ order, credentials, kind: "delivered" | "processing", provider: "DIGIFLAZZ" | "MANUAL" | "STOCK" }`.
- Route response body: `{ ok: true, outcome: "delivered" | "forwarded_to_supplier" | "queued_manual" }` (`processing` + `DIGIFLAZZ` → `forwarded_to_supplier`; `processing` otherwise → `queued_manual`).

- [ ] **Step 1: Failing tests (write all, show they fail)**
  - `wallet_payment_facts.test.ts`: an UNDERPAID order whose `fulfillmentProvider` is `"DIGIFLAZZ"` (build it with the file's helpers; if none creates a Digiflazz product, set `fulfillmentProvider: "DIGIFLAZZ"` on the order row) → after `deliverUnderpaidOrder`: status `PROCESSING`; `digiflazzStatus` is NOT `"failed"`; `paymentState` `"UNDERPAID"`; `completionMode` `"ADMIN_OVERRIDE"`; result `kind === "processing"`, `provider === "DIGIFLAZZ"`; the order is returned by `prisma.order.findFirst({ where: { id, ...digiflazzCandidateWhere(new Date()) } })` (export `digiflazzCandidateWhere` from crud/digiflazz.ts if it is not exported); zero `notificationOutbox` rows for the manual-queue admin alert event and for the buyer processing DM event (use the event names `settlePaidOrder` enqueues in its manual branch); exactly one `underpaid_deliver` audit row whose `details` contains "forwarded to Digiflazz".
  - Same file: the existing STOCK and MANUAL override tests must still pass unchanged; add `kind`/`provider` assertions to them.
  - `payments-mutations-idempotency.test.ts`: the deliver route returns `outcome` (`"delivered"` for the existing stock case), a replay returns the same stored body; add a Digiflazz case that mocks/spies `triggerDigiflazzDispatch` the way other route tests in `apps/web-admin/test` or `apps/storefront/test/digiflazz-dispatch-trigger.test.ts` do, and asserts it was called exactly once with the order id AFTER the response's transaction committed (order already PROCESSING when the spy runs), and not at all for a stock order that ended `delivered`.

- [ ] **Step 2: `settlePaidOrder`** — replace the provider decision with:

```ts
  const provider = fulfillmentProviderFor(order);
  // An admin override of an UNDERPAID order (completionMode ADMIN_OVERRIDE) on a
  // Digiflazz-routed order is forwarded to the supplier exactly like a paid one:
  // the admin has decided the order is to be fulfilled, and parking it for manual
  // work left overrides looking stuck with nothing sent to Digiflazz. Payment
  // facts stay UNDERPAID (see the paymentState writes below, keyed on
  // completionMode); crediting such an order back is capped at what the buyer
  // actually paid (creditOrderToBalance).
  const isDigiflazz = provider === "DIGIFLAZZ";
  const isManual = provider !== "STOCK";
```
  (the `db.order.update({ data: { digiflazzStatus: "failed", ... } })` block is deleted). Nothing else in the function changes.

- [ ] **Step 3: `deliverUnderpaidOrder`** — capture `fulfillmentProviderFor(order)` before settling, return `kind: result.kind` and `provider`, update the docstring ("normal stock / manual / supplier fulfilment route"), and make the audit sentence end with: `delivered.` when kind is delivered; `forwarded to Digiflazz.` when processing + DIGIFLAZZ; `queued for manual fulfilment.` otherwise — e.g. `Admin override for underpaid order ${order.orderCode}: ${reason}. Payment remains UNDERPAID; fulfillment forwarded to Digiflazz.`

- [ ] **Step 4: Route** — `const result = await deliverUnderpaidOrder(...)`; after it resolves (outside any transaction): `if (result.kind === "processing") triggerDigiflazzDispatch(result.order.id);` then the existing `nudgeOutboxDispatcher()`; respond `{ ok: true, outcome }`. Keep idempotency, rate limit, CSRF and error handling exactly as they are.

- [ ] **Step 5: Guard test** — delete the `deliverUnderpaidOrder` entry from `ALLOWLIST` (leave the Map empty if it was the only entry — check the "every allowlist entry is still needed" assertion still holds for an empty map) and add `"deliverUnderpaidOrder"` to `SETTLE_FUNCTIONS`. Run the guard; it must pass with the route's trigger call satisfying rule A.

- [ ] **Step 6: Run** `pnpm exec vitest run packages/db/src/crud/wallet_payment_facts.test.ts packages/db/src/crud/dispatchTriggerGuard.test.ts packages/db/src/crud/ledger_postings.test.ts apps/web-admin/test/payments-mutations-idempotency.test.ts`, plus `apps/web-admin/test/web.test.ts` if you changed it; typecheck `@app/db` and the web-admin server package. Expected: all pass.

- [ ] **Step 7: Commit** — `fix: admin override forwards an underpaid Digiflazz order to the supplier`

---

### Task 2: Cap the credit of an override order at the amount received

**Files:**
- Modify: `packages/db/src/crud/orders.ts` (`creditOrderToBalance` ~2290-2470)
- Test: the test file that already covers `creditOrderToBalance` (`grep -rln "creditOrderToBalance" packages/db/src/crud/*.test.ts`)

**Interfaces — Consumes:** `findUnderpaidReceived(db, orderId): Promise<Decimal | null>` from `packages/db/src/crud/_underpaid.ts` (reads `processedBinanceTx`, `processedBybitTx`, `qrisUnderpaidTx`).

- [ ] **Step 1: Failing tests.** Read `creditOrderToBalance` fully first (amount derivation ~2408, `releaseOrderHolds`, double-credit guard, audit sentence, return shape).
  1. Override order (`completionMode: "ADMIN_OVERRIDE"`, status PROCESSING, total 50000) with a recorded underpaid receipt of 40000 (create the `qrisUnderpaidTx` row the way `markOrderUnderpaid` does, or drive the real flow: `markOrderUnderpaid` then `deliverUnderpaidOrder` on a manual product) → credits exactly 40000; the wallet transaction amount is 40000; the audit `details` says the credit was limited to the amount received.
  2. Override order with NO recorded receipt → nothing is credited (assert the function's existing "nothing credited" outcome if it has one; otherwise it throws `ValidationError` with key `error.override_credit_nothing_received`) and the order's state is exactly what that outcome leaves today for a zero credit — read the code and assert the real behaviour; do not invent a new state.
  3. Override order where `args.amount` is passed explicitly above the received amount → capped at received; below it → the explicit amount is used.
  4. A non-override PROCESSING order of total 50000 still credits 50000 (unchanged).
  5. Wallet credit the order consumed (`walletUsed`) is released exactly as before for an override order (assert against the existing behaviour for a non-override order with the same `walletUsed`).

- [ ] **Step 2: Implement.** After the existing amount is derived, when `order.completionMode === "ADMIN_OVERRIDE"`: `const received = (await findUnderpaidReceived(tx, order.id)) ?? ZERO;` and `amount = Decimal.min(amount, q4(received))`. Add a comment explaining that an override order was fulfilled on a short payment, so the buyer must never get back more than they sent, and that `walletUsed` is returned separately by the hold release. If a new error key is needed, add `error.override_credit_nothing_received` to BOTH locale files (`packages/core/locales/id.json`, `en.json`) and to the admin client's `describeError` map (`apps/web-admin/client/src/lib/errorMessages.ts`) following the neighbouring entries.

- [ ] **Step 3: Run** the covering test file(s) and `pnpm --filter @app/db typecheck` (plus `packages/core/src/locales.test.ts` if locales changed). Expected: pass.

- [ ] **Step 4: Commit** — `fix: crediting an admin-override order is capped at the amount received`

---

### Task 3: Family-specific override UI

**Files:**
- Modify: `packages/core/src/orderFulfillment.ts` (extract the family rule used by `customerProgressPhase` ~148-151 into an exported `orderTransactionFamily(order): "WALLET_TOPUP" | "GAME_TOPUP" | "PREMIUM_APPS"`; `customerProgressPhase` calls it)
- Modify: `apps/web-admin/src/routes/api/payments.ts` (underpaid list ~100-200) and, if needed, `packages/db/src/crud/orders.ts` (a `listUnderpaidOrdersForAdmin` reader that includes `items.product.product.category`, or reuse `fullInclude`) — no raw SQL in the route
- Modify: `apps/web-admin/client/src/pages/PaymentsPage.tsx` (`UnderpaidOrderRow` type ~138, menu ~668-702, `useUnderpaidActions` ~1058, `PaymentOverrideDialog` ~1204)
- Test: `packages/core/src/orderFulfillment.test.ts` (or wherever `customerProgressPhase` is tested), the web-admin API test covering the payments list, `apps/web-admin/client/src/pages/PaymentsPage.test.tsx`

Read `.claude/skills/web-fastify-conventions/SKILL.md` and `.claude/skills/ui-development-dispatch/SKILL.md` first.

**Interfaces — Consumes:** route response `outcome` from Task 1.
**Produces (underpaid row fields, non-readonly admins only):** `overrideFamily: "GAME_TOPUP" | "PREMIUM_APPS"`, `overrideProvider: "DIGIFLAZZ" | "MANUAL" | "STOCK"`, `overrideProductName: string`, `overrideTarget: string | null` (Game Top Up only; null for Premium Apps). Wallet top-up rows carry none of them.

- [ ] **Step 1: Core.** Test then extract `orderTransactionFamily`; behaviour of `customerProgressPhase` must not change (existing tests stay green).
- [ ] **Step 2: API.** Tests first: a GAME_TOPUP Digiflazz underpaid order row has `overrideFamily: "GAME_TOPUP"`, `overrideProvider: "DIGIFLAZZ"`, the product name and the buyer's target; a PREMIUM_APPS stock row has `overrideFamily: "PREMIUM_APPS"`, `overrideProvider: "STOCK"`, `overrideTarget: null`; a legacy order with no category group and provider DIGIFLAZZ is `GAME_TOPUP`; a readonly admin's rows have none of the new fields. For the target, find how the admin order page already shows a game order's player id / target (search `apps/web-admin/src` for the decrypting customer-data reader used by the order detail API) and reuse that reader; never return the raw encrypted column, and never log the value. If no existing reader gives a single display string, return the same structure the order detail API returns and render it in the client the way that page does.
- [ ] **Step 3: Client.** Tests first in `PaymentsPage.test.tsx`, then implement per the spec's table:
  - GAME_TOPUP + DIGIFLAZZ row: menu "Forward to Digiflazz"; dialog title "Forward this top-up to Digiflazz?"; body shows product name, target and order total and the sentence "The order was underpaid. Digiflazz will be charged from your supplier balance. Payment remains incomplete."; confirm button "Forward to Digiflazz"; NO "Deliver account" / account wording anywhere in that menu or dialog.
  - GAME_TOPUP + non-Digiflazz row: menu and confirm "Fulfil anyway"; body says the order goes to the manual queue.
  - PREMIUM_APPS row: menu "Deliver account"; title "Deliver this account anyway?"; body names the plan; STOCK → "An account is taken from stock and sent now."; MANUAL → "The order goes to the manual queue."; plus "Payment remains incomplete."; NO Digiflazz / target / supplier wording.
  - Toast by response `outcome`: "Order forwarded to Digiflazz." / "Order delivered." / "Order queued for manual fulfilment."
  - Reason input stays required (confirm disabled when empty) in both; POST body and idempotency unchanged.
  - A row without the new fields (older server) falls back to the Premium Apps wording with a neutral body; WALLET_TOPUP rows are unchanged.
  - Update the existing tests that click "Deliver anyway" to the new labels; keep what they assert (POST path/body, disabled-until-reason, error toast, stock-refusal message).
  Keep the dialog a single component with a small pure helper that maps `(family, provider)` to its copy, colocated in the page or in `apps/web-admin/client/src/lib/`; reuse the existing dialog/menu primitives and classes.
- [ ] **Step 4: Run** the three test files, typecheck `@app/core`, the web-admin server and the admin client packages, and `pnpm doctor:changed` (0 errors, 0 warnings).
- [ ] **Step 5: Commit** — `feat(admin): family-specific underpaid override (forward to Digiflazz vs deliver account)`

---

## Final gate (controller)

1. `git fetch`; rebase onto latest `master` if it moved (branch is not pushed).
2. `pnpm typecheck && pnpm test` — full, once, on a quiet tree.
3. `pnpm doctor:bugs`, `pnpm doctor:full` at 0/0; record in `docs/REACT_DOCTOR_PHASE_1_REPORT.md`; add a `docs/CHANGELOG.md` entry.
4. Whole-branch review (most capable model).
