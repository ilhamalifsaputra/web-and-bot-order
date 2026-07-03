# Audit UI/UX Functional Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix all 10 confirmed findings from `docs/audit-ui-ux-functional-2026-07-01.md` — features across the Telegram bot, web-admin panel, and storefront that appear to work but actually fail (wrong payment instructions, silent-fail admin actions, dead-end backends with no UI, an "Apply" button that secretly places a real order, dead links, dead code, and a progressive-enhancement 404).

**Architecture:** Ten independent tasks grouped by app surface — Tasks 1-2 (`apps/order-bot`), Tasks 3-7 (`apps/web-admin`, backend Fastify routes under `src/routes/api/*` + React SPA under `client/src`), Tasks 8-10 (`apps/storefront`, Fastify + Nunjucks + HTMX). Each task touches a disjoint set of files — no task depends on another's output. Every fix reuses existing crud/service functions (`packages/db/src/crud/*`, `packages/core`) rather than duplicating logic; several tasks (4, 5, 6) only add UI/routes for backend logic that already exists and works.

**Tech Stack:** TypeScript, pnpm workspaces, grammY (bot), Fastify + Nunjucks + HTMX (web-admin legacy + storefront), React + TanStack Query + shadcn/Tailwind (web-admin SPA), Prisma (SQLite), Vitest.

## Global Constraints

- **Decimal for all money**, never `float` (`@app/core/money`) — applies to Task 6's denomination price fields.
- **No raw SQL in routes/handlers** — new/modified routes call `packages/db/src/crud/*` helpers only (Tasks 3, 4, 6).
- **Audit every admin state change** with `logAdminAction` (Tasks 3, 4, 5, 6).
- **Every mutating web route needs `csrfProtect`**; admin reads use `currentAdmin` (Tasks 3, 6, 8).
- **Settings edits are whitelist-only** — Task 7 only *removes* dead client-side code referencing keys never in the server whitelist; it does not add or widen the whitelist.
- **Never send Telegram from the web** — not touched by any task here (no new outbox/notification sends are introduced).
- **No leaked English** in bot customer/admin strings — `packages/core/locales/en.json` and `id.json` key sets must stay identical (Task 1 adds one key to both).
- **`pnpm typecheck` and `pnpm test` (Vitest) must stay green** after every task; each task's own steps already include its scoped test run, but a full-suite run at the end of execution is expected per this repo's convention.
- Task 6 requires `apps/web-admin/client/src/client/build` to be rebuilt (`pnpm --filter @app/web-admin-client build`) before any web-admin manual verification, per CLAUDE.md — not required for `pnpm test`/`pnpm typecheck` to pass, but required before `pnpm dev:web` reflects the change.

---

## Bot Telegram (`apps/order-bot`)

### Task 1: Fix "My Orders → Pay" showing wrong payment instructions

**Files:**
- Modify: `apps/order-bot/src/handlers/customer.ts:67-696`
- Modify: `apps/order-bot/src/keyboards/customer.ts:11,40-45,373-385`
- Modify: `packages/core/locales/en.json:227`
- Modify: `packages/core/locales/id.json:227`
- Test: `apps/order-bot/test/handlers.test.ts`

**Interfaces:**
- Consumes: `order.status` / `order.paymentMethod` (Prisma `Order` row returned by `getOrder(prisma, orderId)` in `packages/db`); `PaymentMethod` enum (`packages/core/src/enums.ts:128-154`); existing locale keys `checkout.pay_internal_btn`, `checkout.pay_bybit_btn`, `checkout.pay_bybit_bsc_btn`, `checkout.pay_qris_btn`, `checkout.pay_paydisini_btn`, `checkout.pay_nowpayments_btn`; existing callback route `v1:checkout:refresh:<orderId>` → `checkout.refreshPaymentStatus` (already wired in `apps/order-bot/src/handlers/callbacks.ts:123-127`, no change needed there).
- Produces: new locale key `order.pending_payment_rail` (en+id); `viewOrder()`'s rendered text now branches on `order.paymentMethod`; `orderDetailKb()` now emits a "🔄 Refresh Status" button (`cb("checkout", "refresh", order.id)`) for `PENDING_PAYMENT` orders whose method isn't the legacy `BINANCE_PAY`, consumed by the same `dispatchCheckout` router branch every other wait-screen keyboard already uses.

- [ ] **Step 1: Write the failing test**

Add this test in `apps/order-bot/test/handlers.test.ts` directly after the existing `"viewOrder never strands the user when the order isn't found"` test (which ends at line 351), i.e. immediately before the `it.each([OrderStatus.PAYMENT_DETECTED, ...])` BYBIT_BSC test that starts at line 353:

```ts
  it("viewOrder shows rail-specific pending-payment text (not the legacy Binance-ID copy) for a non-legacy payment method", async () => {
    const order = await makeOrder();
    // makeOrder() uses createOrderDirect only, which leaves paymentMethod at
    // the schema default "BINANCE_PAY" — stamp it to a real auto-confirm rail
    // the way finalizeOrderPayment would, without needing a live gateway mock.
    await prisma.order.update({ where: { id: order!.id }, data: { paymentMethod: PaymentMethod.TOKOPAY } });

    const { ctx, sink } = customerCtx();
    await customer.viewOrder(ctx, order!.id);

    const body = JSON.stringify(sink);
    expect(body).toContain(order!.orderCode);
    // The legacy order.pending_payment_detail copy must NOT appear for a
    // TOKOPAY order — this is the confirmed bug (audit 2026-07-01).
    expect(body).not.toContain("Pay to Binance ID");
    // The rail label is reused verbatim from checkout.pay_qris_btn ("QRIS"),
    // not invented new copy.
    expect(body).toContain("QRIS");
    // orderDetailKb must offer the same on-demand reconcile the wait screens
    // use, not just Cancel/Back/Menu.
    const markup = lastMarkup(sink);
    expect(JSON.stringify(markup)).toContain(`v1:checkout:refresh:${order!.id}`);
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run apps/order-bot/test/handlers.test.ts -t "rail-specific pending-payment text"`
Expected: FAIL — `viewOrder` currently branches only on `order.status === OrderStatus.PENDING_PAYMENT` (customer.ts:687-696) and always renders `order.pending_payment_detail`, so the body contains `"Pay to Binance ID"` (assertion `.not.toContain` fails) and does not contain `"QRIS"`; `orderDetailKb` (keyboards/customer.ts:373-385) never emits a refresh button for a pending order, so the markup assertion also fails.

- [ ] **Step 3: Write minimal implementation**

**3a. `apps/order-bot/src/handlers/customer.ts`** — insert a new label-lookup table right after the existing `BSC_TRACKING_STATUSES` constant (currently lines 63-67, blank line 68 before the "session scratch accessors" comment on line 69):

```ts
// Rail label shown on the generic pending-payment screen (viewOrder) — reuses
// the exact copy already shown on the "pick a gateway" buttons
// (checkout.pay_*_btn / usdtMethodsKb), so the wording matches what the buyer
// tapped instead of inventing new copy. BINANCE_PAY (legacy manual transfer,
// retired for new orders) is deliberately absent — it keeps the original
// order.pending_payment_detail text below.
const PENDING_PAYMENT_METHOD_LABEL_KEYS: Partial<Record<string, string>> = {
  [PaymentMethod.BINANCE_INTERNAL]: "checkout.pay_internal_btn",
  [PaymentMethod.BYBIT]: "checkout.pay_bybit_btn",
  [PaymentMethod.BYBIT_BSC]: "checkout.pay_bybit_bsc_btn",
  [PaymentMethod.TOKOPAY]: "checkout.pay_qris_btn",
  [PaymentMethod.PAYDISINI]: "checkout.pay_paydisini_btn",
  [PaymentMethod.NOWPAYMENTS]: "checkout.pay_nowpayments_btn",
};
```

Then replace the buggy branch currently at lines 686-696:

```ts
  let text: string;
  if (order.status === OrderStatus.PENDING_PAYMENT) {
    const binanceId = (await getSetting(prisma, "binance_pay_id")) || config.BINANCE_PAY_ID;
    const countdown = order.expiresAt ? formatCountdown(order.expiresAt) : `${config.PAYMENT_WINDOW_MINUTES}:00`;
    text = t(ctx, "order.pending_payment_detail", {
      code: order.orderCode,
      lines: itemLines.join("\n"),
      total: orderAmount(order, 4),
      binance_id: esc(binanceId),
      countdown,
    });
  } else if (
```

with:

```ts
  let text: string;
  if (order.status === OrderStatus.PENDING_PAYMENT) {
    const countdown = order.expiresAt ? formatCountdown(order.expiresAt) : `${config.PAYMENT_WINDOW_MINUTES}:00`;
    if (order.paymentMethod === PaymentMethod.BINANCE_PAY) {
      // Legacy manual-transfer rail (retired for new orders, but existing
      // rows can still carry it) — the only method this Binance-ID copy is
      // actually correct for.
      const binanceId = (await getSetting(prisma, "binance_pay_id")) || config.BINANCE_PAY_ID;
      text = t(ctx, "order.pending_payment_detail", {
        code: order.orderCode,
        lines: itemLines.join("\n"),
        total: orderAmount(order, 4),
        binance_id: esc(binanceId),
        countdown,
      });
    } else {
      // Every auto-confirm rail (Internal/Bybit/BybitBSC/Tokopay/Paydisini/
      // NOWPayments) — was wrongly shown the Binance-ID text above (audit
      // 2026-07-01). Show a generic rail-labeled notice instead; the
      // "🔄 Refresh Status" button orderDetailKb adds below reuses the same
      // on-demand reconcile (checkout.refreshPaymentStatus) the wait screens
      // already use, rather than duplicating each rail's full instructions.
      const methodKey = PENDING_PAYMENT_METHOD_LABEL_KEYS[order.paymentMethod];
      text = t(ctx, "order.pending_payment_rail", {
        code: order.orderCode,
        method: methodKey ? t(ctx, methodKey) : order.paymentMethod,
        lines: itemLines.join("\n"),
        total: orderAmount(order, 4),
        countdown,
      });
    }
  } else if (
```

(The rest of `viewOrder`, from the `} else if (order.paymentMethod === PaymentMethod.BYBIT_BSC ...` branch through the final `await smartEdit(ctx, text, ckb.orderDetailKb(order, lang));` at line 732, is unchanged.)

**3b. `packages/core/locales/en.json`** — insert after line 227 (`order.pending_payment_detail`), keeping alphabetical key order (`pending_payment_detail` < `pending_payment_rail` < `rejected`):

```json
  "order.pending_payment_rail": "<b>Order {code}</b> — ⏳ Awaiting Payment ({method})\n\n{lines}\nAmount: <b>{total}</b>\n\n⏳ Time remaining: <b>{countdown}</b>\n\nTap \"🔄 Refresh Status\" below to check if we've received your payment, or \"✕ Cancel Order\" if you'd like to stop waiting.",
```

**3c. `packages/core/locales/id.json`** — insert after line 227 (`order.pending_payment_detail`):

```json
  "order.pending_payment_rail": "<b>Pesanan {code}</b> — ⏳ Menunggu Pembayaran ({method})\n\n{lines}\nNominal: <b>{total}</b>\n\n⏳ Sisa waktu: <b>{countdown}</b>\n\nTekan \"🔄 Refresh Status\" di bawah untuk mengecek apakah pembayaran sudah kami terima, atau \"✕ Batalkan Pesanan\" jika ingin berhenti menunggu.",
```

**3d. `apps/order-bot/src/keyboards/customer.ts`** — add `PaymentMethod` to the enum import on line 11:

```ts
import { OrderStatus, StockStatus, TicketStatus } from "@app/core/enums";
```
→
```ts
import { OrderStatus, PaymentMethod, StockStatus, TicketStatus } from "@app/core/enums";
```

Add `paymentMethod` to `OrderLike` (lines 40-45):

```ts
interface OrderLike {
  id: number;
  orderCode: string;
  status: string;
  totalAmount: Decimal.Value;
}
```
→
```ts
interface OrderLike {
  id: number;
  orderCode: string;
  status: string;
  paymentMethod: string;
  totalAmount: Decimal.Value;
}
```

Replace `orderDetailKb` (lines 373-385):

```ts
export function orderDetailKb(order: OrderLike, lang: string): InlineKeyboard {
  const rows: Btn[][] = [];
  if (order.status === OrderStatus.PENDING_PAYMENT) {
    rows.push([
      { text: coreT("checkout.cancel_order", lang), data: cb("checkout", "cancel", order.id) },
    ]);
  }
  rows.push([
    { text: coreT("menu.back", lang), data: cb("order", "list") },
    { text: coreT("menu.main", lang), data: cb("menu", "main") },
  ]);
  return ik(rows);
}
```
→
```ts
export function orderDetailKb(order: OrderLike, lang: string): InlineKeyboard {
  const rows: Btn[][] = [];
  if (order.status === OrderStatus.PENDING_PAYMENT) {
    // Every rail except the legacy manual Binance Pay has an on-demand
    // reconcile poller (checkout.refreshPaymentStatus already no-ops for
    // BINANCE_PAY's default case) — offer the same "🔄 Refresh Status" button
    // the wait screens show, so My Orders → Pay isn't a dead end while waiting.
    if (order.paymentMethod !== PaymentMethod.BINANCE_PAY) {
      rows.push([
        { text: coreT("checkout.refresh_status_btn", lang), data: cb("checkout", "refresh", order.id) },
      ]);
    }
    rows.push([
      { text: coreT("checkout.cancel_order", lang), data: cb("checkout", "cancel", order.id) },
    ]);
  }
  rows.push([
    { text: coreT("menu.back", lang), data: cb("order", "list") },
    { text: coreT("menu.main", lang), data: cb("menu", "main") },
  ]);
  return ik(rows);
}
```

(No changes needed in `apps/order-bot/src/handlers/callbacks.ts` — `dispatchCheckout`'s `"refresh"` branch at lines 123-127 already routes `v1:checkout:refresh:<id>` to `checkout.refreshPaymentStatus` generically by order id, regardless of which screen the tap came from.)

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run apps/order-bot/test/handlers.test.ts -t "rail-specific pending-payment text"`
Expected: PASS. Also run the full file to confirm no regressions in the other `viewOrder`/`orderDetailKb`-touching tests (the pre-existing `viewOrder` tests use `makeOrder()` unmodified, so they keep `paymentMethod: "BINANCE_PAY"` and still hit the legacy branch untouched):

Run: `pnpm vitest run apps/order-bot/test/handlers.test.ts`
Expected: PASS (all tests in the file, including the 4 pre-existing `viewOrder` tests and the BYBIT_BSC tracking `it.each`).

- [ ] **Step 5: Commit**
```bash
git add apps/order-bot/src/handlers/customer.ts apps/order-bot/src/keyboards/customer.ts packages/core/locales/en.json packages/core/locales/id.json apps/order-bot/test/handlers.test.ts
git commit -m "$(cat <<'EOF'
fix(order-bot): show rail-specific pending-payment text on My Orders → Pay

viewOrder() branched only on order.status, so every non-legacy payment
rail (Internal/Bybit/BybitBSC/Tokopay/Paydisini/NOWPayments) showed the
retired manual-transfer flow's Binance-ID instructions instead of
anything relevant to how the buyer is actually paying. Branch on
order.paymentMethod too, reuse the existing checkout.pay_*_btn rail
labels for the message, and add a Refresh Status button to
orderDetailKb wired to the same on-demand reconcile the wait screens
already use.
EOF
)"
```

**Note for implementer:** locale key `checkout.refresh_status_btn` is referenced by the new `orderDetailKb` code above — check whether it already exists in `packages/core/locales/{en,id}.json` (it's plausible it already exists for the wait-screen keyboards); if it doesn't exist yet, add it to both locale files (English: `"checkout.refresh_status_btn": "🔄 Refresh Status"`, Indonesian: `"checkout.refresh_status_btn": "🔄 Perbarui Status"`) before running Step 4, keeping both files' key sets identical per CLAUDE.md.

---

### Task 2: Fix voucher re-validation swallowing all errors silently

**Files:**
- Modify: `apps/order-bot/src/handlers/checkout.ts:16-58,172-192`
- Test: `apps/order-bot/test/handlers.test.ts`

**Interfaces:**
- Consumes: `ValidationError` (`packages/core/src/errors.ts:16-21`, shape `{ key: string; formatArgs: Record<string, unknown> }`); `logErrorRef(err, where, meta)` (`apps/order-bot/src/util/errors.ts:23-27`); `applyVoucherToSubtotal` / `getVoucherByCode` (`packages/db/src/crud/vouchers.ts`); `coreT(key, lang, args)` (`packages/core/src/i18n` via `apps/order-bot/src/util/i18n.ts`).
- Produces: `computeConfirmation()`'s `voucherLine` return value now carries a real, localized message (the specific `ValidationError` reason, or a `error.generic_ref`-style ref for unexpected errors) instead of silently going empty; consumed unchanged by `showOrderConfirmation`, `renderOrderConfirmation`, and `showUsdtMethods` (all three already interpolate `voucherLine` into the `checkout.confirm_order` template's `{voucher_line}` slot — no template or caller change needed).

- [ ] **Step 1: Write the failing test**

Add this test in `apps/order-bot/test/handlers.test.ts` inside the `describe("checkout handlers", ...)` block, directly after the `"showOrderConfirmation renders a summary and creates no order"` test (lines 741-746):

```ts
  it("showOrderConfirmation surfaces the voucher's specific error when re-validation fails, instead of silently dropping the discount (checkout.ts computeConfirmation)", async () => {
    // SAVE10 was valid when first applied; expire it now so the re-render's
    // silent re-validation (computeConfirmation) hits the same ValidationError
    // path applyVoucherToSubtotal throws on first apply.
    await prisma.voucher.update({ where: { id: sample.voucher.id }, data: { expiresAt: new Date(Date.now() - 60_000) } });
    const { ctx, sink } = customerCtx({
      session: { ...userSession(), scratch: { appliedVoucherCode: "SAVE10" } },
    });

    await checkout.showOrderConfirmation(ctx, sample.product.id, 2);

    // The specific reason must reach the user — not a silently-changed total.
    expect(sentIncludes(sink, "This voucher has expired.")).toBe(true);
    // The now-invalid voucher is still dropped from session (same behavior as
    // before, just no longer silent).
    expect(ctx.session.scratch.appliedVoucherCode).toBeUndefined();
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run apps/order-bot/test/handlers.test.ts -t "surfaces the voucher's specific error"`
Expected: FAIL — `computeConfirmation`'s current `catch { delete ctx.session.scratch.appliedVoucherCode; voucherCode = ""; }` (checkout.ts:188-191) swallows the `ValidationError("error.voucher_expired")` thrown by `applyVoucherToSubtotal` with zero text ever rendered, so `sentIncludes(sink, "This voucher has expired.")` is `false` and the assertion fails (the second assertion on `appliedVoucherCode` already passes today, but the first fails the test).

- [ ] **Step 3: Write minimal implementation**

In `apps/order-bot/src/handlers/checkout.ts`, add the `logErrorRef` import next to the other `util/` imports (currently lines 54-58):

```ts
import { smartEdit } from "../util/chat";
import { coreT, t } from "../util/i18n";
import { esc, formatPrice, formatIdr, priceIdr } from "../util/format";
import { currentUsdtRate } from "../util/rate";
import * as ckb from "../keyboards/customer";
```
→
```ts
import { smartEdit } from "../util/chat";
import { coreT, t } from "../util/i18n";
import { logErrorRef } from "../util/errors";
import { esc, formatPrice, formatIdr, priceIdr } from "../util/format";
import { currentUsdtRate } from "../util/rate";
import * as ckb from "../keyboards/customer";
```

Replace the voucher re-validation block (currently lines 172-192):

```ts
  let voucherCode = (ctx.session.scratch.appliedVoucherCode as string | undefined) ?? "";
  let voucherLine = "";
  if (voucherCode) {
    try {
      const voucherObj = await getVoucherByCode(prisma, voucherCode);
      if (voucherObj) {
        const discount = applyVoucherToSubtotal(voucherObj, subtotal);
        voucherLine = coreT("checkout.confirm_voucher_line", lang, {
          code: voucherCode,
          discount: formatIdr(discount),
        });
        subtotal = subtotal.minus(discount);
      } else {
        delete ctx.session.scratch.appliedVoucherCode;
        voucherCode = "";
      }
    } catch {
      delete ctx.session.scratch.appliedVoucherCode;
      voucherCode = "";
    }
  }
```

with:

```ts
  let voucherCode = (ctx.session.scratch.appliedVoucherCode as string | undefined) ?? "";
  let voucherLine = "";
  if (voucherCode) {
    try {
      const voucherObj = await getVoucherByCode(prisma, voucherCode);
      if (voucherObj) {
        const discount = applyVoucherToSubtotal(voucherObj, subtotal);
        voucherLine = coreT("checkout.confirm_voucher_line", lang, {
          code: voucherCode,
          discount: formatIdr(discount),
        });
        subtotal = subtotal.minus(discount);
      } else {
        delete ctx.session.scratch.appliedVoucherCode;
        voucherCode = "";
      }
    } catch (e) {
      // The voucher was valid when first applied but no longer is (expired /
      // used up / minimum purchase no longer met after a quantity or wallet-
      // toggle change) — this is EXPECTED, so surface the *specific* reason
      // instead of silently dropping the discount (the customer would
      // otherwise just see the total jump with zero explanation). Reuses the
      // same slot checkout.confirm_order's {voucher_line} already renders
      // into on success — matches how the first-apply path
      // (conversations/checkout.ts:81-87) surfaces the same ValidationError.
      if (e instanceof ValidationError) {
        voucherLine = `${coreT(e.key, lang, e.formatArgs)}\n`;
      } else {
        // Anything else (DB error, etc.) is unexpected — log it under a ref
        // so a customer report maps to the stack trace, same convention as
        // customer.ts's browse_denomination catch block.
        const ref = logErrorRef(e, `computeConfirmation: voucher re-validation failed for code=${voucherCode}`, {
          userId: info.id,
          productId,
        });
        voucherLine = `${coreT("error.generic_ref", lang, { ref })}\n`;
      }
      delete ctx.session.scratch.appliedVoucherCode;
      voucherCode = "";
    }
  }
```

**Design note (deliberate scoping decision, not a TBD):** only the `ValidationError` branch is exercised by Step 1's test, since triggering the `else` (unexpected-error) branch would require mocking `@app/db`'s `applyVoucherToSubtotal`/`getVoucherByCode` in a way this test file doesn't currently do anywhere (the file's only `vi.mock` is for the TokoPay gateway client, not `@app/db`). Introducing a new mocking convention for one branch of a single `catch` block is out of proportion for this fix; the `else` branch is implemented per the audit's explicit ask (log via `logErrorRef`, matching `customer.ts:492`'s exact call shape) and is covered by type-checking plus the same test exercising the surrounding rewritten block. If `ValidationError` is not already imported in `checkout.ts`, add it from `packages/core/src/errors` alongside the other error imports.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run apps/order-bot/test/handlers.test.ts -t "surfaces the voucher's specific error"`
Expected: PASS. Also re-run the full file to confirm the pre-existing voucher-adjacent tests (`buyNowTokopay keeps the voucher applied ...`, `buyNowTokopay clears the voucher ...`, lines 784-809) and the conversation-side voucher error path in `apps/order-bot/test/conversations.test.ts` still pass unchanged:

Run: `pnpm vitest run apps/order-bot/test/handlers.test.ts apps/order-bot/test/conversations.test.ts`
Expected: PASS (all tests).

- [ ] **Step 5: Commit**
```bash
git add apps/order-bot/src/handlers/checkout.ts apps/order-bot/test/handlers.test.ts
git commit -m "$(cat <<'EOF'
fix(order-bot): surface voucher re-validation errors instead of swallowing them

computeConfirmation's voucher re-validation (run on every confirmation
re-render) caught ALL exceptions and silently dropped the voucher with
zero user feedback — the total would just change with no explanation.
Distinguish ValidationError (expired/exhausted/min-purchase-not-met —
show the specific reason, matching how the first-apply path in
conversations/checkout.ts already surfaces it) from any other
unexpected error (log it via logErrorRef, matching the repo's existing
convention).
EOF
)"
```

---

## Web-Admin (`apps/web-admin`)

### Task 3: Fix Outbox retry & Reviews hide/unhide — silent failure due to legacy redirect routes

**Files:**
- Modify: `apps/web-admin/src/routes/api/outbox.ts:1-24`
- Modify: `apps/web-admin/src/routes/api/reviews.ts:1-24`
- Modify: `apps/web-admin/client/src/pages/OutboxPage.tsx:61`
- Modify: `apps/web-admin/client/src/pages/ReviewsPage.tsx:60-64`
- Modify: `apps/web-admin/client/src/pages/OutboxPage.test.tsx:1-6` (imports) and append new `it`
- Modify: `apps/web-admin/client/src/pages/ReviewsPage.test.tsx:1-6` (imports) and append new `it`
- Test (new): `apps/web-admin/test/outbox-reviews-api.test.ts`

**Interfaces:**
- Consumes: `retryNotification`, `setReviewHidden`, `logAdminAction` from `@app/db`; `csrfProtect`, `currentAdmin` from `../../plugins/auth`
- Produces: `POST /api/outbox/:id/retry` → `{ ok: true }` (404 if gone); `POST /api/reviews/:reviewId/hide` body `{ hidden: boolean }` → `{ ok: true, hidden }` (404 if gone)

**Context:** The legacy Nunjucks routes (`apps/web-admin/src/routes/outbox.ts` line 18, `apps/web-admin/src/routes/reviews.ts` line 20) still exist, still work, and are still covered by `apps/web-admin/test/web.test.ts` (lines 2417-2452 outbox, 2476-2517 reviews) — they are **not** dead and must **not** be removed (that would require rewriting an already-passing, unrelated test suite for zero benefit). The actual bug is that the two React pages POST to those legacy paths, which redirect (303) to a retired `GET /outbox`/`GET /reviews`, which now falls through to the SPA catch-all `spaShellRoutes` and returns HTML. `fetch` follows the redirect, `res.ok` is `true`, then `res.json()` throws on the HTML body — an uncaught rejection in `OutboxPage.retry` (no try/catch around the throw point) and a swallowed failure in `ReviewsPage` (no `onError` on `toggleHide` at all). The fix adds real JSON routes and repoints the SPA at them, leaving the legacy routes as-is.

- [ ] **Step 1: Write the failing tests**

Add to `apps/web-admin/client/src/pages/OutboxPage.test.tsx` (add `fireEvent` to the existing `@testing-library/react` import on line 3, so it reads `import { render, screen, waitFor, fireEvent } from "@testing-library/react";`), then append inside the `describe("OutboxPage", ...)` block:

```tsx
  it("retries a failed notification via /api/outbox/:id/retry and refetches", async () => {
    const failedRow = { ...ROW, id: 9, status: "FAILED" };
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    fetchSpy.mockResolvedValueOnce(
      new Response(
        JSON.stringify({ rows: [failedRow], total: 1, page: 1, hasNext: false, counts: { FAILED: 1 } }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "Content-Type": "application/json" } }),
    );
    fetchSpy.mockResolvedValueOnce(
      new Response(
        JSON.stringify({ rows: [{ ...failedRow, status: "PENDING" }], total: 1, page: 1, hasNext: false, counts: { PENDING: 1 } }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    render(<OutboxPage />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument());

    fireEvent.click(screen.getByRole("button", { name: "Retry" }));

    await waitFor(() =>
      expect(fetchSpy).toHaveBeenCalledWith("/api/outbox/9/retry", expect.objectContaining({ method: "POST" })),
    );
    await waitFor(() => expect(screen.getAllByText("PENDING").length).toBeGreaterThan(0));
  });
```

Add to `apps/web-admin/client/src/pages/ReviewsPage.test.tsx` (add `fireEvent` to its `@testing-library/react` import on line 3 the same way), then append inside `describe("ReviewsPage", ...)`:

```tsx
  it("hides a review via /api/reviews/:id/hide and refetches", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    fetchSpy.mockResolvedValueOnce(
      new Response(
        JSON.stringify({ reviews: [REVIEW], total: 1, page: 1, hasNext: false, summaries: [] }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify({ ok: true, hidden: true }), { status: 200, headers: { "Content-Type": "application/json" } }),
    );
    fetchSpy.mockResolvedValueOnce(
      new Response(
        JSON.stringify({ reviews: [{ ...REVIEW, hidden: true }], total: 1, page: 1, hasNext: false, summaries: [] }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    render(<ReviewsPage />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByRole("button", { name: "Hide" })).toBeInTheDocument());

    fireEvent.click(screen.getByRole("button", { name: "Hide" }));

    await waitFor(() =>
      expect(fetchSpy).toHaveBeenCalledWith(
        "/api/reviews/1/hide",
        expect.objectContaining({ method: "POST" }),
      ),
    );
    await waitFor(() => expect(screen.getByRole("button", { name: "Restore" })).toBeInTheDocument());
  });

  it("shows an alert when hiding a review fails (previously silently swallowed)", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    fetchSpy.mockResolvedValueOnce(
      new Response(
        JSON.stringify({ reviews: [REVIEW], total: 1, page: 1, hasNext: false, summaries: [] }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: "Review not found." }), { status: 404, headers: { "Content-Type": "application/json" } }),
    );
    const alertSpy = vi.spyOn(globalThis, "alert").mockImplementation(() => {});
    render(<ReviewsPage />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByRole("button", { name: "Hide" })).toBeInTheDocument());

    fireEvent.click(screen.getByRole("button", { name: "Hide" }));

    await waitFor(() => expect(alertSpy).toHaveBeenCalledWith("Review not found."));
  });
```

Write `apps/web-admin/test/outbox-reviews-api.test.ts` (new file, mirrors `apps/web-admin/test/settings-payment-toggle.test.ts`'s self-contained pattern):

```ts
import "./setup-env"; // MUST be first: sets env + builds the temp DB schema.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { config } from "@app/core/config";
import { prisma, initDb, upsertUser, setSetting, createCategory, createCatalogProduct, createDenomination, createOrderDirect } from "@app/db";
import { resetDb } from "../../../tests/helpers/sampleData";
import { makeSession, sessionJtiKey, newJti } from "../src/auth";
import { buildApp } from "../src/server";

const COOKIE = config.WEB_COOKIE_NAME;
const ADMIN_TG = 999;
let app: FastifyInstance;
let cookie: string;
let csrf: string;

beforeAll(async () => {
  await initDb();
  app = await buildApp();
  await app.ready();
});
afterAll(async () => {
  await app.close();
  await prisma.$disconnect();
});

beforeEach(async () => {
  await resetDb(prisma);
  const admin = await upsertUser(prisma, { telegramId: ADMIN_TG, username: "admin", fullName: "Admin" });
  const jti = newJti();
  await setSetting(prisma, sessionJtiKey(ADMIN_TG), jti);
  const { raw, data } = makeSession(admin.id, ADMIN_TG, jti);
  cookie = raw;
  csrf = data.csrf;
  await setSetting(prisma, "setup_completed", "true");
});

function postJson(url: string, c: string | null, csrfToken: string, body: Record<string, unknown> = {}) {
  return app.inject({
    method: "POST",
    url,
    headers: { "content-type": "application/json", "x-csrf-token": csrfToken },
    cookies: c ? { [COOKIE]: c } : {},
    payload: JSON.stringify(body),
  });
}

async function makeFailedNotif(): Promise<number> {
  const row = await prisma.notificationOutbox.create({
    data: { event: "ORDER_DELIVERED", payloadJson: JSON.stringify({ x: 1 }), status: "FAILED", attempts: 5, lastError: "boom" },
  });
  return row.id;
}

describe("POST /api/outbox/:id/retry", () => {
  it("happy path: requeues a FAILED notification back to PENDING and audits", async () => {
    const id = await makeFailedNotif();
    const res = await postJson(`/api/outbox/${id}/retry`, cookie, csrf);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
    const row = await prisma.notificationOutbox.findUnique({ where: { id } });
    expect(row!.status).toBe("PENDING");
    expect(row!.attempts).toBe(0);
    expect(row!.lastError).toBeNull();
    const audit = await prisma.auditLog.findFirst({ where: { action: "outbox_retry", targetId: id } });
    expect(audit).toBeTruthy();
  });

  it("returns 404 for a notification that no longer exists, writes no audit", async () => {
    const res = await postJson(`/api/outbox/999999/retry`, cookie, csrf);
    expect(res.statusCode).toBe(404);
    expect(await prisma.auditLog.findFirst({ where: { action: "outbox_retry" } })).toBeNull();
  });

  it("auth-fail: no admin session is redirected to /login and writes nothing", async () => {
    const id = await makeFailedNotif();
    const res = await postJson(`/api/outbox/${id}/retry`, null, csrf);
    expect(res.statusCode).toBe(303);
    expect(res.headers.location).toBe("/login");
    expect((await prisma.notificationOutbox.findUnique({ where: { id } }))!.status).toBe("FAILED");
  });

  it("bad-csrf: an invalid token is rejected with 403 and writes nothing", async () => {
    const id = await makeFailedNotif();
    const res = await postJson(`/api/outbox/${id}/retry`, cookie, "bad");
    expect(res.statusCode).toBe(403);
    expect((await prisma.notificationOutbox.findUnique({ where: { id } }))!.status).toBe("FAILED");
  });
});

async function makeReview(hidden = false): Promise<{ reviewId: number; buyerId: number }> {
  const category = await createCategory(prisma, `c${Math.random()}`);
  const parent = await createCatalogProduct(prisma, { categoryId: category.id, name: "P" });
  const product = await createDenomination(prisma, { productId: parent.id, name: "P", type: "SHARED", durationLabel: "1 Month", price: "5" });
  const buyer = await upsertUser(prisma, { telegramId: Math.floor(Math.random() * 1_000_000_000), username: "buyer", fullName: "Buyer" });
  const order = await createOrderDirect(prisma, { user: buyer, productId: product.id, quantity: 1 });
  const r = await prisma.review.create({
    data: { userId: buyer.id, orderId: order!.order.id, productId: product.id, rating: 5, comment: "great", hidden },
  });
  return { reviewId: r.id, buyerId: buyer.id };
}

describe("POST /api/reviews/:reviewId/hide", () => {
  it("happy path: hides a review and audits", async () => {
    const { reviewId } = await makeReview();
    const res = await postJson(`/api/reviews/${reviewId}/hide`, cookie, csrf, { hidden: true });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, hidden: true });
    expect((await prisma.review.findUnique({ where: { id: reviewId } }))!.hidden).toBe(true);
    const audit = await prisma.auditLog.findFirst({ where: { action: "review_hide", targetId: reviewId } });
    expect(audit).toBeTruthy();
  });

  it("unhide restores the review and audits as review_unhide", async () => {
    const { reviewId } = await makeReview(true);
    const res = await postJson(`/api/reviews/${reviewId}/hide`, cookie, csrf, { hidden: false });
    expect(res.statusCode).toBe(200);
    expect((await prisma.review.findUnique({ where: { id: reviewId } }))!.hidden).toBe(false);
    const audit = await prisma.auditLog.findFirst({ where: { action: "review_unhide", targetId: reviewId } });
    expect(audit).toBeTruthy();
  });

  it("returns 404 for a review that doesn't exist", async () => {
    const res = await postJson(`/api/reviews/999999/hide`, cookie, csrf, { hidden: true });
    expect(res.statusCode).toBe(404);
  });

  it("auth-fail: no admin session is redirected to /login and writes nothing", async () => {
    const { reviewId } = await makeReview();
    const res = await postJson(`/api/reviews/${reviewId}/hide`, null, csrf, { hidden: true });
    expect(res.statusCode).toBe(303);
    expect(res.headers.location).toBe("/login");
    expect((await prisma.review.findUnique({ where: { id: reviewId } }))!.hidden).toBe(false);
  });

  it("bad-csrf: an invalid token is rejected with 403 and writes nothing", async () => {
    const { reviewId } = await makeReview();
    const res = await postJson(`/api/reviews/${reviewId}/hide`, cookie, "bad", { hidden: true });
    expect(res.statusCode).toBe(403);
    expect((await prisma.review.findUnique({ where: { id: reviewId } }))!.hidden).toBe(false);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm test -- apps/web-admin/client/src/pages/OutboxPage.test.tsx apps/web-admin/client/src/pages/ReviewsPage.test.tsx apps/web-admin/test/outbox-reviews-api.test.ts`
Expected: FAIL — the new client tests fail because `apiPost` still targets `/outbox/${id}/retry` and `/reviews/${id}/hide` (303 redirect to HTML, `fetch` mock's third `mockResolvedValueOnce` never gets consumed by the right call, or the assertion on the literal path `/api/outbox/9/retry` doesn't match); the new route-test file fails with 404 (Fastify has no `POST /api/outbox/:id/retry` or `POST /api/reviews/:reviewId/hide` route registered yet).

- [ ] **Step 3: Write minimal implementation**

Replace `apps/web-admin/src/routes/api/outbox.ts` (full file):

```ts
import type { FastifyInstance } from "fastify";
import { NotificationStatus } from "@app/core/enums";
import { prisma, listNotifications, countNotifications, outboxStatusCounts, retryNotification, logAdminAction } from "@app/db";
import { logger } from "@app/core/logger";
import { currentAdmin, csrfProtect } from "../../plugins/auth";

const PAGE_SIZE = 50;
const STATUS_VALUES = Object.values(NotificationStatus) as string[];

export default async function outboxApiRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/outbox", { preHandler: currentAdmin }, async (req, reply) => {
    const q = req.query as Record<string, string | undefined>;
    const status = q.status && STATUS_VALUES.includes(q.status) ? q.status : null;
    const page = Math.max(Number(q.page) || 1, 1);
    const offset = (page - 1) * PAGE_SIZE;

    const [rows, total, counts] = await Promise.all([
      listNotifications(prisma, { status, limit: PAGE_SIZE, offset }),
      countNotifications(prisma, { status }),
      outboxStatusCounts(prisma),
    ]);

    return reply.send({ rows, total, page, hasNext: offset + rows.length < total, counts });
  });

  // JSON counterpart of the legacy POST /outbox/:id/retry (routes/outbox.ts),
  // which 303-redirects to a retired GET /outbox and breaks fetch()'s
  // res.json() once the SPA catch-all serves HTML there instead. The web
  // panel's React page calls this one; the legacy route is left in place
  // (still covered by test/web.test.ts) since nothing requires removing it.
  app.post("/api/outbox/:id/retry", { preHandler: csrfProtect }, async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    const ok = await retryNotification(prisma, id);
    if (!ok) return reply.code(404).send({ error: "That notification no longer exists." });
    await logAdminAction(prisma, {
      adminId: req.admin!.userId,
      action: "outbox_retry",
      targetType: "notification",
      targetId: id,
    });
    logger.info(`Admin ${req.admin!.userId} requeued outbox notification ${id} for delivery via the web panel`);
    return reply.send({ ok: true });
  });
}
```

Replace `apps/web-admin/src/routes/api/reviews.ts` (full file):

```ts
import type { FastifyInstance } from "fastify";
import { prisma, listReviews, countReviews, productRatingSummaries, setReviewHidden, logAdminAction } from "@app/db";
import { currentAdmin, csrfProtect } from "../../plugins/auth";

const PAGE_SIZE = 50;

export default async function reviewsApiRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/reviews", { preHandler: currentAdmin }, async (req, reply) => {
    const q = req.query as Record<string, string | undefined>;
    const productId = q.product && /^\d+$/.test(q.product) ? Number(q.product) : null;
    const hidden = q.hidden === "1" ? true : q.hidden === "0" ? false : null;
    const page = Math.max(Number(q.page) || 1, 1);
    const offset = (page - 1) * PAGE_SIZE;

    const filter = { productId, hidden };
    const [reviews, total, summaries] = await Promise.all([
      listReviews(prisma, { ...filter, limit: PAGE_SIZE, offset }),
      countReviews(prisma, filter),
      productRatingSummaries(prisma),
    ]);

    return reply.send({ reviews, total, page, hasNext: offset + reviews.length < total, summaries });
  });

  // JSON counterpart of the legacy POST /reviews/:reviewId/hide
  // (routes/reviews.ts) — see api/outbox.ts's retry route for why a parallel
  // JSON route exists instead of reusing the legacy 303-redirect one.
  app.post("/api/reviews/:reviewId/hide", { preHandler: csrfProtect }, async (req, reply) => {
    const reviewId = Number((req.params as { reviewId: string }).reviewId);
    const body = (req.body ?? {}) as Record<string, unknown>;
    if (typeof body.hidden !== "boolean") return reply.code(400).send({ error: "hidden must be a boolean." });
    const hide = body.hidden;
    const existing = await prisma.review.findUnique({ where: { id: reviewId } });
    if (!existing) return reply.code(404).send({ error: "Review not found." });
    await setReviewHidden(prisma, reviewId, hide);
    await logAdminAction(prisma, {
      adminId: req.admin!.userId,
      action: hide ? "review_hide" : "review_unhide",
      targetType: "review",
      targetId: reviewId,
    });
    return reply.send({ ok: true, hidden: hide });
  });
}
```

In `apps/web-admin/client/src/pages/OutboxPage.tsx`, change line 61 (the current `apiPost(...)` call inside `retry()`) to point at the new JSON route:
```tsx
      await apiPost(`/api/outbox/${id}/retry`, {});
```

In `apps/web-admin/client/src/pages/ReviewsPage.tsx`, replace lines 60-64 (the `toggleHide` mutation) so it points at the new JSON route and reports failures instead of swallowing them:
```tsx
  const toggleHide = useMutation({
    mutationFn: ({ id, hide }: { id: number; hide: boolean }) =>
      apiPost<void>(`/api/reviews/${id}/hide`, { hidden: hide }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["reviews"] }),
    onError: (e: Error) => alert(e.message),
  });
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm test -- apps/web-admin/client/src/pages/OutboxPage.test.tsx apps/web-admin/client/src/pages/ReviewsPage.test.tsx apps/web-admin/test/outbox-reviews-api.test.ts apps/web-admin/test/web.test.ts`
Expected: PASS (the last file, `web.test.ts`, re-run to confirm the untouched legacy routes still pass).

- [ ] **Step 5: Commit**
```bash
git add apps/web-admin/src/routes/api/outbox.ts apps/web-admin/src/routes/api/reviews.ts apps/web-admin/client/src/pages/OutboxPage.tsx apps/web-admin/client/src/pages/ReviewsPage.tsx apps/web-admin/client/src/pages/OutboxPage.test.tsx apps/web-admin/client/src/pages/ReviewsPage.test.tsx apps/web-admin/test/outbox-reviews-api.test.ts
git commit -m "$(cat <<'EOF'
Fix outbox retry / review hide silently failing against retired redirect routes

The SPA's Outbox/Reviews pages POSTed to legacy routes that 303-redirect to a
retired GET page, so fetch() followed it to the SPA HTML shell and res.json()
threw — the action succeeded server-side but the UI never reflected it. Add
JSON API routes and repoint the pages at them instead of touching the legacy
(still-tested) redirect routes.
EOF
)"
```

---

### Task 4: Add underpaid-order resolution UI (deliver / refund / cancel)

**Files:**
- Modify: `apps/web-admin/client/src/pages/PaymentsPage.tsx:32-40` (interface), `:141-146` (mutations), `:237-239` (new section)
- Test: `apps/web-admin/client/src/pages/PaymentsPage.test.tsx`

**Interfaces:**
- Consumes: `GET /api/payments` (already returns `underpaid: Order[]`, `pendingInternal: Order[]`), `POST /api/payments/order/:orderId/deliver|refund|cancel` (all already implemented in `apps/web-admin/src/routes/api/payments.ts:62-116`, all return `{ ok: true }` or `422 { error }`)
- Produces: an "Underpaid Orders" actionable table + a read-only "Pending Internal Transfers" table on `PaymentsPage`

- [ ] **Step 1: Write the failing test**

Append to `apps/web-admin/client/src/pages/PaymentsPage.test.tsx` (it already has `vi.mock("../api/client", () => ({ apiGet: vi.fn(), apiPost: vi.fn() }))` and a `mockPaymentsFetch` helper at the top, and already imports `within, fireEvent` — no new imports needed):

```tsx
const UNDERPAID = {
  id: 501,
  orderCode: "ORD-UP1",
  totalAmount: "45000",
  currency: "IDR",
  createdAt: "2026-06-20T08:00:00.000Z",
  user: { fullName: "Sari Dewi", username: "saridewi" },
};
const PENDING_INTERNAL = {
  id: 502,
  orderCode: "ORD-PI1",
  totalAmount: "3",
  currency: "USDT",
  paymentRef: "REF-abc123",
  expiresAt: "2026-07-01T12:00:00.000Z",
  user: { fullName: "Budi", username: "budi99" },
};

describe("PaymentsPage — underpaid order resolution", () => {
  it("lists underpaid orders and delivers one anyway", async () => {
    mockPaymentsFetch({ enabled: true, ledger: [], total: 0, page: 1, hasNext: false, outcomes: [], counts: {}, underpaid: [UNDERPAID], pendingInternal: [] });
    vi.mocked(apiPost).mockResolvedValueOnce({ ok: true });
    render(<PaymentsPage />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByText("ORD-UP1")).toBeInTheDocument());

    fireEvent.click(screen.getByRole("button", { name: "Deliver anyway" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Deliver anyway" }));

    await waitFor(() => expect(apiPost).toHaveBeenCalledWith("/api/payments/order/501/deliver", {}));
  });

  it("refunds an underpaid order to the buyer's wallet", async () => {
    mockPaymentsFetch({ enabled: true, ledger: [], total: 0, page: 1, hasNext: false, outcomes: [], counts: {}, underpaid: [UNDERPAID], pendingInternal: [] });
    vi.mocked(apiPost).mockResolvedValueOnce({ ok: true });
    render(<PaymentsPage />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByText("ORD-UP1")).toBeInTheDocument());

    fireEvent.click(screen.getByRole("button", { name: "Refund" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Refund" }));

    await waitFor(() => expect(apiPost).toHaveBeenCalledWith("/api/payments/order/501/refund", {}));
  });

  it("cancels an underpaid order", async () => {
    mockPaymentsFetch({ enabled: true, ledger: [], total: 0, page: 1, hasNext: false, outcomes: [], counts: {}, underpaid: [UNDERPAID], pendingInternal: [] });
    vi.mocked(apiPost).mockResolvedValueOnce({ ok: true });
    render(<PaymentsPage />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByText("ORD-UP1")).toBeInTheDocument());

    fireEvent.click(screen.getByRole("button", { name: "Cancel order" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel order" }));

    await waitFor(() => expect(apiPost).toHaveBeenCalledWith("/api/payments/order/501/cancel", {}));
  });

  it("lists pending internal transfers awaiting confirmation", async () => {
    mockPaymentsFetch({ enabled: true, ledger: [], total: 0, page: 1, hasNext: false, outcomes: [], counts: {}, underpaid: [], pendingInternal: [PENDING_INTERNAL] });
    render(<PaymentsPage />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByText("ORD-PI1")).toBeInTheDocument());
    expect(screen.getByText("REF-abc123")).toBeInTheDocument();
  });

  it("shows an alert when resolving an underpaid order fails", async () => {
    mockPaymentsFetch({ enabled: true, ledger: [], total: 0, page: 1, hasNext: false, outcomes: [], counts: {}, underpaid: [UNDERPAID], pendingInternal: [] });
    vi.mocked(apiPost).mockRejectedValueOnce(new Error("Order is no longer underpaid."));
    const alertSpy = vi.spyOn(globalThis, "alert").mockImplementation(() => {});
    render(<PaymentsPage />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByText("ORD-UP1")).toBeInTheDocument());

    fireEvent.click(screen.getByRole("button", { name: "Deliver anyway" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Deliver anyway" }));

    await waitFor(() => expect(alertSpy).toHaveBeenCalledWith("Order is no longer underpaid."));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test -- apps/web-admin/client/src/pages/PaymentsPage.test.tsx`
Expected: FAIL — `screen.getByText("ORD-UP1")` never appears (TS also fails to compile: `PaymentsData` has no `underpaid`/`pendingInternal` fields), because there's no UI rendering those arrays yet.

- [ ] **Step 3: Write minimal implementation**

In `apps/web-admin/client/src/pages/PaymentsPage.tsx`, replace lines 32-40 (the `PaymentsData` interface) with:

```tsx
interface OrderPartyRow {
  fullName: string | null;
  username: string | null;
}
interface UnderpaidOrderRow {
  id: number;
  orderCode: string;
  totalAmount: string;
  currency: string;
  createdAt: string;
  user: OrderPartyRow | null;
}
interface PendingInternalOrderRow {
  id: number;
  orderCode: string;
  totalAmount: string;
  currency: string;
  paymentRef: string | null;
  expiresAt: string | null;
  user: OrderPartyRow | null;
}
interface PaymentsData {
  enabled: boolean;
  ledger: TxRow[];
  total: number;
  page: number;
  hasNext: boolean;
  outcomes: readonly string[];
  counts: Record<string, number>;
  underpaid: UnderpaidOrderRow[];
  pendingInternal: PendingInternalOrderRow[];
}
```

After the `dismiss` mutation (currently lines 141-145), add:

```tsx
  const deliverAnyway = useMutation({
    mutationFn: (orderId: number) => apiPost(`/api/payments/order/${orderId}/deliver`, {}),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ["payments"] }); },
    onError: (e: Error) => alert(e.message),
  });

  const refundUnderpaid = useMutation({
    mutationFn: (orderId: number) => apiPost(`/api/payments/order/${orderId}/refund`, {}),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ["payments"] }); },
    onError: (e: Error) => alert(e.message),
  });

  const cancelUnderpaid = useMutation({
    mutationFn: (orderId: number) => apiPost(`/api/payments/order/${orderId}/cancel`, {}),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ["payments"] }); },
    onError: (e: Error) => alert(e.message),
  });
```

Insert this new section right after the Manual Match `</Card>` closing tag (currently line 237, right before the `{/* Outcome filter */}` comment on line 239):

```tsx
      {data && data.underpaid.length > 0 && (
        <div className="mb-6">
          <h2 className="text-sm font-semibold text-ink mb-3">Underpaid Orders ({data.underpaid.length})</h2>
          <DataTable
            columns={[
              {
                key: "order",
                header: "Order",
                render: o => (
                  <div className="flex flex-col">
                    <span className="font-mono text-xs">{o.orderCode}</span>
                    <span className="text-xs text-ink-soft">{o.user?.fullName ?? o.user?.username ?? "Unknown"}</span>
                  </div>
                ),
              },
              {
                key: "amount",
                header: "Amount",
                render: o => <span className="font-mono text-sm">{formatCurrencyDisplay(o.totalAmount, o.currency as "IDR" | "USDT" | "USD")}</span>,
              },
              {
                key: "date",
                header: "Date",
                render: o => <span className="text-xs text-ink-soft whitespace-nowrap">{new Date(o.createdAt).toLocaleString()}</span>,
              },
              {
                key: "actions",
                header: "",
                render: o => (
                  <div className="flex gap-2">
                    <ConfirmDialog
                      trigger={<Button variant="outline" size="sm" disabled={deliverAnyway.isPending}>Deliver anyway</Button>}
                      title="Deliver this order anyway?"
                      description={`Order ${o.orderCode} was underpaid. Deliver it anyway — this writes off the shortfall.`}
                      confirmLabel="Deliver anyway"
                      variant="default"
                      onConfirm={() => deliverAnyway.mutate(o.id)}
                    />
                    <ConfirmDialog
                      trigger={<Button variant="outline" size="sm" disabled={refundUnderpaid.isPending}>Refund</Button>}
                      title="Refund to the buyer's wallet?"
                      description={`Refund order ${o.orderCode}'s payment to the buyer's wallet balance.`}
                      confirmLabel="Refund"
                      variant="default"
                      onConfirm={() => refundUnderpaid.mutate(o.id)}
                    />
                    <ConfirmDialog
                      trigger={<Button variant="destructive" size="sm" disabled={cancelUnderpaid.isPending}>Cancel order</Button>}
                      title="Cancel this order?"
                      description={`Cancel order ${o.orderCode}. Any reserved stock or wallet holds are released.`}
                      confirmLabel="Cancel order"
                      onConfirm={() => cancelUnderpaid.mutate(o.id)}
                    />
                  </div>
                ),
              },
            ]}
            data={data.underpaid}
            keyExtractor={o => o.id}
            empty={<EmptyState title="No underpaid orders" />}
          />
        </div>
      )}

      {data && data.pendingInternal.length > 0 && (
        <div className="mb-6">
          <h2 className="text-sm font-semibold text-ink mb-3">Pending Internal Transfers ({data.pendingInternal.length})</h2>
          <DataTable
            columns={[
              { key: "order", header: "Order", render: o => <span className="font-mono text-xs">{o.orderCode}</span> },
              { key: "user", header: "Buyer", render: o => <span className="text-xs text-ink-soft">{o.user?.fullName ?? o.user?.username ?? "Unknown"}</span> },
              { key: "amount", header: "Amount", render: o => <span className="font-mono text-sm">{formatCurrencyDisplay(o.totalAmount, o.currency as "IDR" | "USDT" | "USD")}</span> },
              { key: "ref", header: "Transfer Ref", render: o => <span className="font-mono text-xs">{o.paymentRef ?? "—"}</span> },
              { key: "expires", header: "Expires", render: o => <span className="text-xs text-ink-soft whitespace-nowrap">{o.expiresAt ? new Date(o.expiresAt).toLocaleString() : "—"}</span> },
            ]}
            data={data.pendingInternal}
            keyExtractor={o => o.id}
            empty={<EmptyState title="No pending internal transfers" />}
          />
        </div>
      )}

```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test -- apps/web-admin/client/src/pages/PaymentsPage.test.tsx`
Expected: PASS

- [ ] **Step 5: Commit**
```bash
git add apps/web-admin/client/src/pages/PaymentsPage.tsx apps/web-admin/client/src/pages/PaymentsPage.test.tsx
git commit -m "$(cat <<'EOF'
Surface underpaid-order resolution in the Payments panel

GET /api/payments already returned underpaid/pendingInternal orders and the
deliver/refund/cancel routes already existed server-side, but no UI rendered
them — admins had no way to resolve an underpaid order from the web panel.
EOF
)"
```

---

### Task 5: Add customer role-change UI

**Files:**
- Modify: `apps/web-admin/client/src/pages/UserDetailPage.tsx:8-14` (imports), `:45-59` (mutations), `:85` (role row)
- Test (new): `apps/web-admin/client/src/pages/UserDetailPage.test.tsx`

**Interfaces:**
- Consumes: `POST /api/users/:userId/role` (already implemented, `apps/web-admin/src/routes/api/users.ts:50-67`, body `{ role: string }`, 400/403/404/`{ok:true}`); `GET /api/users/:userId` already returns `roles: ["CUSTOMER", "RESELLER"]`
- Produces: an editable role `<Select>` on `UserDetailPage` for non-admin users

- [ ] **Step 1: Write the failing test**

Create `apps/web-admin/client/src/pages/UserDetailPage.test.tsx` (new file, no prior test existed for this page):

```tsx
import "@testing-library/jest-dom";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Routes, Route } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { UserDetailPage } from "./UserDetailPage";
import { apiPost } from "../api/client";

vi.mock("../api/client", () => ({
  apiPost: vi.fn(),
}));

function Wrapper({ children }: { children: React.ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <MemoryRouter initialEntries={["/users/7"]}>
      <QueryClientProvider client={qc}>
        <Routes>
          <Route path="/users/:userId" element={children} />
        </Routes>
      </QueryClientProvider>
    </MemoryRouter>
  );
}

const USER_DETAIL = {
  user: { id: 7, username: "andi", fullName: "Andi Santoso", telegramId: "111", role: "CUSTOMER", banned: false, banReason: null, walletBalance: "0", walletCurrency: "IDR" },
  totalSpent: "150000",
  orders: [],
  tickets: [],
  ledger: [],
  roles: ["CUSTOMER", "RESELLER"],
};

beforeEach(() => {
  vi.restoreAllMocks();
  vi.mocked(apiPost).mockReset();
  Element.prototype.scrollIntoView = vi.fn();
  Element.prototype.hasPointerCapture = vi.fn(() => false);
  Element.prototype.setPointerCapture = vi.fn();
  Element.prototype.releasePointerCapture = vi.fn();
});

describe("UserDetailPage — role change", () => {
  it("renders the current role in an editable Select instead of a static badge", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify(USER_DETAIL), { status: 200, headers: { "Content-Type": "application/json" } }),
    );
    render(<UserDetailPage />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByText("Andi Santoso")).toBeInTheDocument());
    expect(screen.getByRole("combobox")).toBeInTheDocument();
  });

  it("changes the role via POST /api/users/:userId/role", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify(USER_DETAIL), { status: 200, headers: { "Content-Type": "application/json" } }),
    );
    vi.mocked(apiPost).mockResolvedValueOnce({ ok: true });
    render(<UserDetailPage />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByText("Andi Santoso")).toBeInTheDocument());

    await user.click(screen.getByRole("combobox"));
    await waitFor(() => screen.getByRole("option", { name: "RESELLER" }));
    await user.click(screen.getByRole("option", { name: "RESELLER" }));

    await waitFor(() => expect(apiPost).toHaveBeenCalledWith("/api/users/7/role", { role: "RESELLER" }));
  });

  it("shows a static badge (no Select) for an ADMIN user — admin status is managed elsewhere", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify({ ...USER_DETAIL, user: { ...USER_DETAIL.user, role: "ADMIN" } }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    render(<UserDetailPage />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByText("Andi Santoso")).toBeInTheDocument());
    expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
    expect(screen.getByText("ADMIN")).toBeInTheDocument();
  });

  it("alerts on a failed role change", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify(USER_DETAIL), { status: 200, headers: { "Content-Type": "application/json" } }),
    );
    vi.mocked(apiPost).mockRejectedValueOnce(new Error("Invalid role."));
    const alertSpy = vi.spyOn(globalThis, "alert").mockImplementation(() => {});
    render(<UserDetailPage />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByText("Andi Santoso")).toBeInTheDocument());

    await user.click(screen.getByRole("combobox"));
    await waitFor(() => screen.getByRole("option", { name: "RESELLER" }));
    await user.click(screen.getByRole("option", { name: "RESELLER" }));

    await waitFor(() => expect(alertSpy).toHaveBeenCalledWith("Invalid role."));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test -- apps/web-admin/client/src/pages/UserDetailPage.test.tsx`
Expected: FAIL — `screen.getByRole("combobox")` doesn't exist (role is rendered as a static `<Badge>`), so both the render assertion and role-change assertions fail.

- [ ] **Step 3: Write minimal implementation**

In `apps/web-admin/client/src/pages/UserDetailPage.tsx`, add to the import block (after line 8's `ConfirmDialog` import, before line 10's `Button` import):

```tsx
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from "@/components/ui/select";
```

After the `wallet` mutation and before the `ban` mutation (i.e., right after line 53's closing `});` for `wallet`), add:

```tsx
  const setRole = useMutation({
    mutationFn: (role: string) => apiPost(`/api/users/${userId}/role`, { role }),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ["user", userId] }); },
    onError: (e: Error) => alert(e.message),
  });
```

Replace line 85 (`<div className="flex justify-between"><span className="text-ink-soft">Role</span><span><Badge variant="outline">{user.role}</Badge></span></div>`) with:

```tsx
            <div className="flex justify-between items-center">
              <span className="text-ink-soft">Role</span>
              {user.role === "ADMIN" ? (
                <Badge variant="outline">{user.role}</Badge>
              ) : (
                <Select value={user.role} onValueChange={(role) => setRole.mutate(role)} disabled={setRole.isPending}>
                  <SelectTrigger className="w-28"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {data.roles.map((r) => (
                      <SelectItem key={r} value={r}>{r}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            </div>
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test -- apps/web-admin/client/src/pages/UserDetailPage.test.tsx`
Expected: PASS

- [ ] **Step 5: Commit**
```bash
git add apps/web-admin/client/src/pages/UserDetailPage.tsx apps/web-admin/client/src/pages/UserDetailPage.test.tsx
git commit -m "$(cat <<'EOF'
Add customer role-change Select to UserDetailPage

POST /api/users/:userId/role and the roles array from GET /api/users/:userId
already existed server-side, but the page only rendered a static read-only
badge — admins couldn't change a customer between CUSTOMER and RESELLER.
EOF
)"
```

---

### Task 6: Add denomination edit/delete (route + UI)

**Files:**
- Modify: `apps/web-admin/client/src/api/client.ts:39-51` (add `apiPatch`, `apiDelete`)
- Modify: `apps/web-admin/client/src/api/client.test.ts`
- Modify: `apps/web-admin/src/routes/api/catalog.ts:1-22` (imports), append routes after line 184
- Modify: `apps/web-admin/client/src/pages/ProductDetailPage.tsx:10-12` (imports), `:139-158` (DataTable columns)
- Modify: `apps/web-admin/client/src/App.tsx:7` (import), `:54` (route)
- Create: `apps/web-admin/client/src/pages/DenominationEditPage.tsx`
- Test (new): `apps/web-admin/client/src/pages/DenominationEditPage.test.tsx`
- Test: `apps/web-admin/client/src/pages/ProductDetailPage.test.tsx` (append)
- Test (new): `apps/web-admin/test/catalog-denomination-edit.test.ts`

**Interfaces:**
- Consumes: `updateDenomination`, `deleteDenomination`, `getDenomination` from `@app/db` (already implemented, `packages/db/src/crud/catalog.ts:278-352`)
- Produces: `PATCH /api/catalog/denominations/:id`, `DELETE /api/catalog/denominations/:id`; `apiPatch`/`apiDelete` client helpers; Edit/Delete controls on `ProductDetailPage`; new `DenominationEditPage`

- [ ] **Step 1: Write the failing tests**

Append to `apps/web-admin/client/src/api/client.test.ts` (add `apiPatch, apiDelete` to the line-3 import):

```ts
describe("apiPatch", () => {
  it("attaches the CSRF token as an X-CSRF-Token header and sends PATCH", async () => {
    const fetchMock = vi.fn(async (_path: string, _init: RequestInit) => ({ ok: true, json: async () => ({ ok: true }) }));
    vi.stubGlobal("fetch", fetchMock);
    await apiPatch("/api/catalog/denominations/10", { name: "New name" });
    const [path, init] = fetchMock.mock.calls[0]!;
    expect(path).toBe("/api/catalog/denominations/10");
    expect(init.method).toBe("PATCH");
    expect(new Headers(init.headers).get("X-CSRF-Token")).toBe("test-token");
    expect(JSON.parse(init.body as string)).toEqual({ name: "New name" });
  });
});

describe("apiDelete", () => {
  it("attaches the CSRF token as an X-CSRF-Token header and sends DELETE", async () => {
    const fetchMock = vi.fn(async (_path: string, _init: RequestInit) => ({ ok: true, json: async () => ({ ok: true }) }));
    vi.stubGlobal("fetch", fetchMock);
    await apiDelete("/api/catalog/denominations/10");
    const [path, init] = fetchMock.mock.calls[0]!;
    expect(path).toBe("/api/catalog/denominations/10");
    expect(init.method).toBe("DELETE");
    expect(new Headers(init.headers).get("X-CSRF-Token")).toBe("test-token");
  });

  it("throws the server's error message on failure", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 409, json: async () => ({ error: "Cannot delete a denomination with order history." }) })));
    await expect(apiDelete("/api/catalog/denominations/10")).rejects.toThrow("Cannot delete a denomination with order history.");
  });
});
```

Create `apps/web-admin/client/src/pages/DenominationEditPage.test.tsx` (new file):

```tsx
import "@testing-library/jest-dom";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { MemoryRouter, Routes, Route } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { DenominationEditPage } from "./DenominationEditPage";
import { apiGet, apiPatch } from "../api/client";

vi.mock("../api/client", () => ({
  apiGet: vi.fn(),
  apiPatch: vi.fn(),
}));

function Wrapper({ children }: { children: React.ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <MemoryRouter initialEntries={["/catalog/42/denominations/10/edit"]}>
      <QueryClientProvider client={qc}>
        <Routes>
          <Route path="/catalog/:productId/denominations/:denomId/edit" element={children} />
          <Route path="/catalog/:productId" element={<div>product-detail-page</div>} />
        </Routes>
      </QueryClientProvider>
    </MemoryRouter>
  );
}

const PRODUCT_DETAIL = {
  product: {
    id: 42,
    denominations: [
      {
        id: 10,
        name: "Netflix 1 Month",
        type: "SHARED",
        durationLabel: "1 Month",
        price: "15000",
        costPrice: "10000",
        resellerPrice: null,
        warrantyDays: 30,
        description: "Shared profile",
      },
    ],
  },
};

beforeEach(() => {
  vi.restoreAllMocks();
  vi.mocked(apiGet).mockReset();
  vi.mocked(apiPatch).mockReset();
  Element.prototype.scrollIntoView = vi.fn();
  Element.prototype.hasPointerCapture = vi.fn(() => false);
  Element.prototype.setPointerCapture = vi.fn();
  Element.prototype.releasePointerCapture = vi.fn();
});

describe("DenominationEditPage", () => {
  it("prefills the form from the existing denomination", async () => {
    vi.mocked(apiGet).mockResolvedValue(PRODUCT_DETAIL);
    render(<DenominationEditPage />, { wrapper: Wrapper });

    await waitFor(() => expect(screen.getByDisplayValue("Netflix 1 Month")).toBeInTheDocument());
    expect(screen.getByDisplayValue("15000")).toBeInTheDocument();
    expect(screen.getByDisplayValue("10000")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /save changes/i })).toBeInTheDocument();
  });

  it("submits the edited fields via PATCH and navigates back to the product detail page", async () => {
    vi.mocked(apiGet).mockResolvedValue(PRODUCT_DETAIL);
    vi.mocked(apiPatch).mockResolvedValueOnce({ id: 10, name: "Netflix 1 Month Plan" });
    render(<DenominationEditPage />, { wrapper: Wrapper });

    await waitFor(() => expect(screen.getByDisplayValue("Netflix 1 Month")).toBeInTheDocument());
    fireEvent.change(screen.getByDisplayValue("Netflix 1 Month"), { target: { value: "Netflix 1 Month Plan" } });

    const btn = screen.getByRole("button", { name: /save changes/i });
    await waitFor(() => expect(btn).not.toBeDisabled());
    fireEvent.click(btn);

    await waitFor(() =>
      expect(apiPatch).toHaveBeenCalledWith("/api/catalog/denominations/10", {
        name: "Netflix 1 Month Plan",
        type: "SHARED",
        durationLabel: "1 Month",
        price: "15000",
        costPrice: "10000",
        warrantyDays: 30,
        description: "Shared profile",
      }),
    );
    await waitFor(() => expect(screen.getByText("product-detail-page")).toBeInTheDocument());
  });

  it("shows an error message when saving fails", async () => {
    vi.mocked(apiGet).mockResolvedValue(PRODUCT_DETAIL);
    vi.mocked(apiPatch).mockRejectedValueOnce(new Error("A valid type is required."));
    render(<DenominationEditPage />, { wrapper: Wrapper });

    await waitFor(() => expect(screen.getByDisplayValue("Netflix 1 Month")).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: /save changes/i }));

    await waitFor(() => expect(screen.getByText(/a valid type is required/i)).toBeInTheDocument());
  });
});
```

Append to `apps/web-admin/client/src/pages/ProductDetailPage.test.tsx` (add `within` to the `@testing-library/react` import at the top of the file, and add a route for the edit page to the `Wrapper`'s `<Routes>`, right after the existing `denominations/new` route: `<Route path="/catalog/:productId/denominations/:denomId/edit" element={<div>denomination-edit-page</div>} />`), then append inside `describe("ProductDetailPage", ...)`:

```tsx
  it("navigates to the denomination edit page on 'Edit' click", async () => {
    const user = userEvent.setup();
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify(PRODUCT_DETAIL), { status: 200, headers: { "Content-Type": "application/json" } }),
    );
    render(<ProductDetailPage />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByText("PRIVATE")).toBeInTheDocument());

    await user.click(screen.getByRole("button", { name: "Edit" }));

    await waitFor(() => expect(screen.getByText("denomination-edit-page")).toBeInTheDocument());
  });

  it("deletes a denomination after confirming", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify(PRODUCT_DETAIL), { status: 200, headers: { "Content-Type": "application/json" } }),
    );
    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "Content-Type": "application/json" } }),
    );
    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify({ ...PRODUCT_DETAIL, product: { ...PRODUCT_DETAIL.product, denominations: [] } }), { status: 200, headers: { "Content-Type": "application/json" } }),
    );
    render(<ProductDetailPage />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByText("PRIVATE")).toBeInTheDocument());

    await user.click(screen.getByRole("button", { name: "Delete" }));
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: "Delete" }));

    await waitFor(() =>
      expect(fetchSpy).toHaveBeenCalledWith("/api/catalog/denominations/10", expect.objectContaining({ method: "DELETE" })),
    );
    await waitFor(() => expect(screen.queryByText("PRIVATE")).not.toBeInTheDocument());
  });
```

Create `apps/web-admin/test/catalog-denomination-edit.test.ts` (new file, mirrors `apps/web-admin/test/settings-payment-toggle.test.ts`):

```ts
import "./setup-env";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { config } from "@app/core/config";
import { prisma, initDb, upsertUser, setSetting, createCategory, createCatalogProduct, createDenomination, bulkAddStock, createOrderDirect } from "@app/db";
import { resetDb } from "../../../tests/helpers/sampleData";
import { makeSession, sessionJtiKey, newJti } from "../src/auth";
import { buildApp } from "../src/server";

const COOKIE = config.WEB_COOKIE_NAME;
const ADMIN_TG = 999;
let app: FastifyInstance;
let cookie: string;
let csrf: string;

beforeAll(async () => {
  await initDb();
  app = await buildApp();
  await app.ready();
});
afterAll(async () => {
  await app.close();
  await prisma.$disconnect();
});

beforeEach(async () => {
  await resetDb(prisma);
  const admin = await upsertUser(prisma, { telegramId: ADMIN_TG, username: "admin", fullName: "Admin" });
  const jti = newJti();
  await setSetting(prisma, sessionJtiKey(ADMIN_TG), jti);
  const { raw, data } = makeSession(admin.id, ADMIN_TG, jti);
  cookie = raw;
  csrf = data.csrf;
  await setSetting(prisma, "setup_completed", "true");
});

async function seedDenomination() {
  const category = await createCategory(prisma, "Cat");
  const parent = await createCatalogProduct(prisma, { categoryId: category.id, name: "Parent" });
  const denom = await createDenomination(prisma, { productId: parent.id, name: "1 Month", type: "SHARED", durationLabel: "1 Month", price: "10000" });
  return denom.id;
}

function patchJson(url: string, c: string | null, csrfToken: string, body: Record<string, unknown>) {
  return app.inject({
    method: "PATCH",
    url,
    headers: { "content-type": "application/json", "x-csrf-token": csrfToken },
    cookies: c ? { [COOKIE]: c } : {},
    payload: JSON.stringify(body),
  });
}
function del(url: string, c: string | null, csrfToken: string) {
  return app.inject({
    method: "DELETE",
    url,
    headers: { "x-csrf-token": csrfToken },
    cookies: c ? { [COOKIE]: c } : {},
  });
}

describe("PATCH /api/catalog/denominations/:id", () => {
  it("happy path: updates the denomination and audits", async () => {
    const id = await seedDenomination();
    const res = await patchJson(`/api/catalog/denominations/${id}`, cookie, csrf, {
      name: "1 Month Plus",
      type: "SHARED",
      durationLabel: "1 Month",
      price: "12000",
    });
    expect(res.statusCode).toBe(200);
    const row = await prisma.denomination.findUnique({ where: { id } });
    expect(row!.name).toBe("1 Month Plus");
    expect(row!.price.toString()).toBe("12000");
    const audit = await prisma.auditLog.findFirst({ where: { action: "denomination_update", targetId: id } });
    expect(audit).toBeTruthy();
  });

  it("auth-fail: no admin session is redirected to /login and writes nothing", async () => {
    const id = await seedDenomination();
    const res = await patchJson(`/api/catalog/denominations/${id}`, null, csrf, { name: "Hacked", type: "SHARED", durationLabel: "1 Month", price: "1" });
    expect(res.statusCode).toBe(303);
    expect(res.headers.location).toBe("/login");
    expect((await prisma.denomination.findUnique({ where: { id } }))!.name).toBe("1 Month");
  });

  it("bad-csrf: an invalid token is rejected with 403 and writes nothing", async () => {
    const id = await seedDenomination();
    const res = await patchJson(`/api/catalog/denominations/${id}`, cookie, "bad", { name: "Hacked", type: "SHARED", durationLabel: "1 Month", price: "1" });
    expect(res.statusCode).toBe(403);
    expect((await prisma.denomination.findUnique({ where: { id } }))!.name).toBe("1 Month");
  });
});

describe("DELETE /api/catalog/denominations/:id", () => {
  it("happy path: deletes the denomination and audits", async () => {
    const id = await seedDenomination();
    const res = await del(`/api/catalog/denominations/${id}`, cookie, csrf);
    expect(res.statusCode).toBe(200);
    expect(await prisma.denomination.findUnique({ where: { id } })).toBeNull();
    const audit = await prisma.auditLog.findFirst({ where: { action: "denomination_delete", targetId: id } });
    expect(audit).toBeTruthy();
  });

  it("auth-fail: no admin session is redirected to /login and writes nothing", async () => {
    const id = await seedDenomination();
    const res = await del(`/api/catalog/denominations/${id}`, null, csrf);
    expect(res.statusCode).toBe(303);
    expect(res.headers.location).toBe("/login");
    expect(await prisma.denomination.findUnique({ where: { id } })).not.toBeNull();
  });

  it("bad-csrf: an invalid token is rejected with 403 and writes nothing", async () => {
    const id = await seedDenomination();
    const res = await del(`/api/catalog/denominations/${id}`, cookie, "bad");
    expect(res.statusCode).toBe(403);
    expect(await prisma.denomination.findUnique({ where: { id } })).not.toBeNull();
  });

  it("refuses to delete a denomination with order history (409) and writes nothing", async () => {
    const id = await seedDenomination();
    await bulkAddStock(prisma, id, ["cred1"]);
    const buyer = await upsertUser(prisma, { telegramId: 12345, username: "buyer", fullName: "Buyer" });
    await createOrderDirect(prisma, { user: buyer, productId: id, quantity: 1 });
    const res = await del(`/api/catalog/denominations/${id}`, cookie, csrf);
    expect(res.statusCode).toBe(409);
    expect(await prisma.denomination.findUnique({ where: { id } })).not.toBeNull();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm test -- apps/web-admin/client/src/api/client.test.ts apps/web-admin/client/src/pages/DenominationEditPage.test.tsx apps/web-admin/client/src/pages/ProductDetailPage.test.tsx apps/web-admin/test/catalog-denomination-edit.test.ts`
Expected: FAIL — `apiPatch`/`apiDelete` don't exist (import error), `DenominationEditPage` module doesn't exist, `ProductDetailPage` has no "Edit"/"Delete" buttons, and `PATCH`/`DELETE /api/catalog/denominations/:id` return 404 (no such route registered).

- [ ] **Step 3: Write minimal implementation**

Append to `apps/web-admin/client/src/api/client.ts` (after `apiPost`, line 51):

```ts
export async function apiPatch<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(path, {
    method: "PATCH",
    credentials: "include",
    headers: { "Content-Type": "application/json", "X-CSRF-Token": csrfToken() },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({})) as { error?: string };
    throw new Error(data.error ?? `${path} responded ${res.status}`);
  }
  return res.json() as Promise<T>;
}

export async function apiDelete<T>(path: string): Promise<T> {
  const res = await fetch(path, {
    method: "DELETE",
    credentials: "include",
    headers: { "X-CSRF-Token": csrfToken() },
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({})) as { error?: string };
    throw new Error(data.error ?? `${path} responded ${res.status}`);
  }
  return res.json() as Promise<T>;
}
```

In `apps/web-admin/src/routes/api/catalog.ts`, add `updateDenomination, deleteDenomination, getDenomination` to the `@app/db` import (line 14, after `createDenomination`), then append these two routes after the existing `/api/catalog/denominations/:id/active` route (after line 184's closing `});`, before `app.get("/api/catalog/:productId", ...)`):

```ts
  app.patch("/api/catalog/denominations/:id", { preHandler: csrfProtect }, async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    if (!Number.isInteger(id)) return reply.code(400).send({ error: "Invalid denomination id." });
    const existing = await getDenomination(prisma, id);
    if (!existing) return reply.code(404).send({ error: "Denomination not found." });

    const body = (req.body ?? {}) as Record<string, unknown>;
    const name = (typeof body.name === "string" ? body.name : "").trim();
    if (!name) return reply.code(400).send({ error: "Name is required." });

    const type = typeof body.type === "string" ? body.type.toUpperCase() : "";
    if (!Object.values(ProductType).includes(type as ProductType)) {
      return reply.code(400).send({ error: "A valid type is required." });
    }

    const durationLabel = (typeof body.durationLabel === "string" ? body.durationLabel : "").trim();
    if (!durationLabel) return reply.code(400).send({ error: "Duration is required." });

    const price = parseDecimal(body.price);
    if (price === null) return reply.code(400).send({ error: "A valid price is required." });

    const costPrice = body.costPrice != null ? parseDecimal(body.costPrice) : null;
    if (body.costPrice != null && costPrice === null) {
      return reply.code(400).send({ error: "Cost price must be a valid number." });
    }
    const resellerPrice = body.resellerPrice != null ? parseDecimal(body.resellerPrice) : null;
    if (body.resellerPrice != null && resellerPrice === null) {
      return reply.code(400).send({ error: "Reseller price must be a valid number." });
    }

    let warrantyDays: number | null = null;
    if (body.warrantyDays != null && body.warrantyDays !== "") {
      const n = Number(body.warrantyDays);
      if (!Number.isInteger(n)) return reply.code(400).send({ error: "Warranty days must be a whole number." });
      warrantyDays = n;
    }

    await updateDenomination(prisma, id, {
      name,
      type: type as ProductType,
      durationLabel,
      price,
      costPrice,
      resellerPrice,
      warrantyDays,
      description: typeof body.description === "string" ? body.description.trim() || null : null,
    });
    await logAdminAction(prisma, {
      adminId: req.admin!.userId,
      action: "denomination_update",
      targetType: "denomination",
      targetId: id,
      details: `Updated denomination "${name}".`,
    });
    return reply.send({ id, name });
  });

  app.delete("/api/catalog/denominations/:id", { preHandler: csrfProtect }, async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    if (!Number.isInteger(id)) return reply.code(400).send({ error: "Invalid denomination id." });
    const existing = await getDenomination(prisma, id);
    if (!existing) return reply.code(404).send({ error: "Denomination not found." });
    try {
      await deleteDenomination(prisma, id);
    } catch (err) {
      if (err instanceof Error && err.message === "cannot delete a denomination with order history") {
        return reply.code(409).send({ error: "Cannot delete a denomination with order history." });
      }
      throw err;
    }
    await logAdminAction(prisma, {
      adminId: req.admin!.userId,
      action: "denomination_delete",
      targetType: "denomination",
      targetId: id,
    });
    return reply.send({ ok: true });
  });

```

**Note for implementer:** confirm `deleteDenomination`'s actual thrown-error message/shape for "has order history" by reading `packages/db/src/crud/catalog.ts:346` before wiring the `catch` above — adjust the message match if it differs from `"cannot delete a denomination with order history"`.

Create `apps/web-admin/client/src/pages/DenominationEditPage.tsx` (new file):

```tsx
import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useParams } from "react-router-dom";
import { PageLayout } from "../components/shared/PageLayout";
import { PageHeader } from "../components/shared/PageHeader";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from "@/components/ui/select";
import { apiGet, apiPatch } from "../api/client";

const DENOMINATION_TYPES = [
  { value: "SHARED", label: "Shared" },
  { value: "PRIVATE", label: "Private" },
];

interface EditableDenomination {
  id: number;
  name: string;
  type: string;
  durationLabel: string;
  price: string;
  costPrice: string | null;
  resellerPrice: string | null;
  warrantyDays: number;
  description: string | null;
}

interface ProductDetailForEdit {
  product: { id: number; denominations: EditableDenomination[] };
}

function isValidPrice(value: string): boolean {
  if (value.trim() === "") return false;
  return !Number.isNaN(Number(value.trim()));
}

export function DenominationEditPage() {
  const { productId, denomId } = useParams<{ productId: string; denomId: string }>();
  const navigate = useNavigate();
  const qc = useQueryClient();

  const { data, isError } = useQuery<ProductDetailForEdit>({
    queryKey: ["catalog", productId],
    queryFn: async () => apiGet<ProductDetailForEdit>(`/api/catalog/${productId}`),
    enabled: !!productId,
  });
  const denomination = data?.product.denominations.find((d) => d.id === Number(denomId));

  const [loaded, setLoaded] = useState(false);
  const [name, setName] = useState("");
  const [type, setType] = useState<string | null>(null);
  const [durationLabel, setDurationLabel] = useState("");
  const [price, setPrice] = useState("");
  const [costPrice, setCostPrice] = useState("");
  const [resellerPrice, setResellerPrice] = useState("");
  const [warrantyDays, setWarrantyDays] = useState("");
  const [description, setDescription] = useState("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (loaded || !denomination) return;
    setName(denomination.name);
    setType(denomination.type);
    setDurationLabel(denomination.durationLabel);
    setPrice(denomination.price);
    setCostPrice(denomination.costPrice ?? "");
    setResellerPrice(denomination.resellerPrice ?? "");
    setWarrantyDays(denomination.warrantyDays ? String(denomination.warrantyDays) : "");
    setDescription(denomination.description ?? "");
    setLoaded(true);
  }, [denomination, loaded]);

  const save = useMutation({
    mutationFn: () =>
      apiPatch<{ id: number; name: string }>(`/api/catalog/denominations/${denomId}`, {
        name: name.trim(),
        type,
        durationLabel: durationLabel.trim(),
        price: price.trim(),
        ...(costPrice.trim() ? { costPrice: costPrice.trim() } : {}),
        ...(resellerPrice.trim() ? { resellerPrice: resellerPrice.trim() } : {}),
        ...(warrantyDays.trim() ? { warrantyDays: Number(warrantyDays.trim()) } : {}),
        ...(description.trim() ? { description: description.trim() } : {}),
      }),
    onMutate: () => setError(null),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["catalog", productId] });
      navigate(`/catalog/${productId}`);
    },
    onError: (e: Error) => setError(e.message),
  });

  const canSubmit =
    name.trim().length > 0 &&
    type !== null &&
    durationLabel.trim().length > 0 &&
    isValidPrice(price);

  if (isError) return <PageLayout title="Edit Denomination"><p className="text-sm text-rust">Failed to load denomination.</p></PageLayout>;
  if (!loaded) return <PageLayout title="Edit Denomination"><p>Loading…</p></PageLayout>;

  return (
    <PageLayout title="Edit Denomination">
      <PageHeader
        title="Edit Denomination"
        breadcrumb={[
          { label: "Catalog", href: "/catalog" },
          { label: "Product", href: `/catalog/${productId}` },
        ]}
        actions={
          <Button variant="outline" size="sm" onClick={() => navigate(`/catalog/${productId}`)}>
            ← Back
          </Button>
        }
      />

      <div className="max-w-lg flex flex-col gap-4">
        <div>
          <label className="text-sm font-medium text-ink">
            Name <span className="text-rust">*</span>
          </label>
          <Input className="mt-1" placeholder="e.g. Netflix Premium" value={name} onChange={(e) => setName(e.target.value)} />
        </div>

        <div>
          <label className="text-sm font-medium text-ink">
            Type <span className="text-rust">*</span>
          </label>
          <Select value={type ?? ""} onValueChange={(v) => setType(v)}>
            <SelectTrigger className="mt-1">
              <SelectValue placeholder="Select type" />
            </SelectTrigger>
            <SelectContent>
              {DENOMINATION_TYPES.map((t) => (
                <SelectItem key={t.value} value={t.value}>{t.label}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div>
          <label className="text-sm font-medium text-ink">
            Duration Label <span className="text-rust">*</span>
          </label>
          <Input className="mt-1" placeholder="e.g. 1 Month" value={durationLabel} onChange={(e) => setDurationLabel(e.target.value)} />
        </div>

        <div>
          <label className="text-sm font-medium text-ink">
            Price <span className="text-rust">*</span>
          </label>
          <Input className="mt-1" placeholder="e.g. 15000" value={price} onChange={(e) => setPrice(e.target.value)} />
        </div>

        <div>
          <label className="text-sm font-medium text-ink">Cost Price</label>
          <Input className="mt-1" placeholder="Optional" value={costPrice} onChange={(e) => setCostPrice(e.target.value)} />
        </div>

        <div>
          <label className="text-sm font-medium text-ink">Reseller Price</label>
          <Input className="mt-1" placeholder="Optional" value={resellerPrice} onChange={(e) => setResellerPrice(e.target.value)} />
        </div>

        <div>
          <label className="text-sm font-medium text-ink">Warranty Days</label>
          <Input className="mt-1 w-32" placeholder="Optional" value={warrantyDays} onChange={(e) => setWarrantyDays(e.target.value)} />
        </div>

        <div>
          <label className="text-sm font-medium text-ink">Description</label>
          <Textarea className="mt-1" rows={3} placeholder="Optional" value={description} onChange={(e) => setDescription(e.target.value)} />
        </div>

        {error && <p className="text-sm text-rust">{error}</p>}

        <Button disabled={!canSubmit || save.isPending} onClick={() => save.mutate()}>
          {save.isPending ? "Saving…" : "Save Changes"}
        </Button>
      </div>
    </PageLayout>
  );
}
```

In `apps/web-admin/client/src/pages/ProductDetailPage.tsx`, add `ConfirmDialog` and `apiDelete` to the imports (insert `import { ConfirmDialog } from "../components/shared/ConfirmDialog";` alongside the existing shared-component imports; change the `api/client` import to `import { apiGet, apiPost, apiDelete } from "../api/client";`), add a delete handler after `toggleDenominationActive` (after line 86):

```tsx
  async function deleteDenomination(id: number) {
    try {
      await apiDelete(`/api/catalog/denominations/${id}`);
      await queryClient.invalidateQueries({ queryKey: ["catalog", productId] });
    } catch (e) {
      alert(e instanceof Error ? e.message : "Failed to delete denomination.");
    }
  }
```

and append a new column to the `DataTable`'s `columns` array (after the `"active"` column, before the closing `]}` on line 158):

```tsx
          {
            key: "actions",
            header: "",
            render: d => (
              <div className="flex gap-2">
                <Button variant="ghost" size="sm" onClick={() => navigate(`/catalog/${productId}/denominations/${d.id}/edit`)}>
                  Edit
                </Button>
                <ConfirmDialog
                  trigger={<Button variant="ghost" size="sm" className="text-rust">Delete</Button>}
                  title="Delete this denomination?"
                  description={`Delete "${d.name}". This is refused if it has order history.`}
                  confirmLabel="Delete"
                  onConfirm={() => deleteDenomination(d.id)}
                />
              </div>
            ),
          },
```

In `apps/web-admin/client/src/App.tsx`, add the import and the route:

```tsx
import { DenominationEditPage } from "./pages/DenominationEditPage";
```
```tsx
        <Route path="/catalog/:productId/denominations/:denomId/edit" element={<DenominationEditPage />} />
```
(Register this route before the more general `/catalog/:productId` route, matching the existing `denominations/new` route's placement.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm test -- apps/web-admin/client/src/api/client.test.ts apps/web-admin/client/src/pages/DenominationEditPage.test.tsx apps/web-admin/client/src/pages/ProductDetailPage.test.tsx apps/web-admin/test/catalog-denomination-edit.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**
```bash
git add apps/web-admin/client/src/api/client.ts apps/web-admin/client/src/api/client.test.ts apps/web-admin/src/routes/api/catalog.ts apps/web-admin/client/src/pages/ProductDetailPage.tsx apps/web-admin/client/src/pages/ProductDetailPage.test.tsx apps/web-admin/client/src/pages/DenominationEditPage.tsx apps/web-admin/client/src/pages/DenominationEditPage.test.tsx apps/web-admin/client/src/App.tsx apps/web-admin/test/catalog-denomination-edit.test.ts
git commit -m "$(cat <<'EOF'
Add denomination edit/delete JSON routes and SPA UI

updateDenomination/deleteDenomination existed in packages/db but were only
reachable via now-dead legacy Nunjucks routes; there was no JSON API or SPA
path to edit or delete a denomination in the new stack.
EOF
)"
```

---

### Task 7: Remove dead `STORE_KEYS` code from SettingsPage

**Files:**
- Modify: `apps/web-admin/client/src/pages/SettingsPage.tsx:44-48`, `:131`, `:396-408`
- Test: `apps/web-admin/client/src/pages/SettingsPage.test.tsx`

**Interfaces:**
- Consumes: none (pure deletion)
- Produces: no behavior change to any real setting; removes a card that could only ever render given fabricated data no real server response produces

**Context:** Confirmed by repo-wide search that `min_order_amount`, `order_expiry_minutes`, `stock_low_threshold` appear nowhere else in the codebase (not in `EDITABLE` in `apps/web-admin/src/routes/api/settings.ts:28-71`, not in any other route, template, or test). `GET /api/settings` can never return a field with those keys, so `fieldGroup(data.fields, STORE_KEYS).length > 0` is always `false` in production — pure dead code. Because production data can never trigger this code path, the "failing test" here is a fabricated-payload regression test: given a hypothetical `fields` entry using one of those three keys, the *current* code renders a "Store" card (proving the code path is live, just never exercised by the real server) — after deletion, that same fabricated field falls through to "Other Settings" instead and no "Store" heading ever appears again.

- [ ] **Step 1: Write the failing test**

Append to `apps/web-admin/client/src/pages/SettingsPage.test.tsx` inside `describe("SettingsPage", ...)`:

```tsx
  it("never renders a 'Store' card — min_order_amount/order_expiry_minutes/stock_low_threshold are not real settings (dead STORE_KEYS code removed)", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          ...SETTINGS_DATA,
          fields: [
            ...SETTINGS_DATA.fields,
            { key: "min_order_amount", label: "Min order amount", secret: false, hasValue: true, value: "10000", needsRestart: false },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    render(<SettingsPage />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByText("Shop name")).toBeInTheDocument());

    expect(screen.queryByText("Store")).not.toBeInTheDocument();
    // The stray field still renders somewhere (Other Settings), not silently dropped.
    expect(screen.getByText("Min order amount")).toBeInTheDocument();
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test -- apps/web-admin/client/src/pages/SettingsPage.test.tsx`
Expected: FAIL — `screen.queryByText("Store")` finds the "Store" `<CardTitle>` (current code puts `min_order_amount` in `STORE_KEYS`, so `fieldGroup(data.fields, STORE_KEYS).length > 0` is `true` for this fabricated payload and the card renders).

- [ ] **Step 3: Write minimal implementation**

In `apps/web-admin/client/src/pages/SettingsPage.tsx`, delete lines 44-48:

```tsx
const STORE_KEYS = new Set([
  "min_order_amount",
  "order_expiry_minutes",
  "stock_low_threshold",
]);
```

Update the `ALL_GROUPED_KEYS` set (currently lines 129-135) by removing the `...STORE_KEYS,` line:

```tsx
const ALL_GROUPED_KEYS = new Set([
  ...BRANDING_KEYS,
  ...TELEGRAM_KEYS,
  ...FX_KEYS,
  ...PAY_CRED_KEYS,
]);
```

Delete the "Store" card block (currently lines 396-408):

```tsx
          {/* Store */}
          {fieldGroup(data.fields, STORE_KEYS).length > 0 && (
            <Card>
              <CardHeader>
                <CardTitle>Store</CardTitle>
              </CardHeader>
              <CardContent className="divide-y divide-line">
                {fieldGroup(data.fields, STORE_KEYS).map((field) => (
                  <FieldRow key={field.key} field={field} onSaved={invalidate} />
                ))}
              </CardContent>
            </Card>
          )}

```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test -- apps/web-admin/client/src/pages/SettingsPage.test.tsx`
Expected: PASS

- [ ] **Step 5: Commit**
```bash
git add apps/web-admin/client/src/pages/SettingsPage.tsx apps/web-admin/client/src/pages/SettingsPage.test.tsx
git commit -m "$(cat <<'EOF'
Remove dead STORE_KEYS/"Store" card from SettingsPage

min_order_amount, order_expiry_minutes, and stock_low_threshold are not in
the server's EDITABLE whitelist or anywhere else in the codebase, so the
Store card could never render in production — confirmed dead code.
EOF
)"
```

---

## Storefront (`apps/storefront`)

### Task 8: Fix voucher "Apply" button silently placing a real order

**Files:**
- Create: `apps/storefront/views/_checkout_totals.njk`
- Modify: `apps/storefront/src/routes/checkout.ts:375-377` (insert new route)
- Modify: `apps/storefront/views/checkout.njk:97-164`
- Test: `apps/storefront/test/storefront.test.ts`

**Interfaces:**
- Consumes: `checkoutView(customer, voucherCode, null)` (existing, unexported-but-local function in `checkout.ts`, lines 118-152) and `getUsdIdrRate(prisma)` (already imported in `checkout.ts`) — no new crud code needed, this is pure reuse.
- Produces: `POST /checkout/voucher/preview` → renders `_checkout_totals.njk` fragment (HTML), swapped into `#checkout-summary` via HTMX. No order, no stock reservation, no `$transaction`.

**Context:** `checkoutView()` already recomputes totals with a voucher code as a stateless preview (it's what powers `GET /checkout`'s initial render) — this task exposes it as its own route rather than duplicating any voucher/cart logic.

- [ ] **Step 1: Write the failing test**

Add to `apps/storefront/test/storefront.test.ts` (new `describe` block, placed after the existing Bybit BSC checkout describe block, reusing the file's existing `productId`, `loginAs`, `csrfFrom` fixtures):

```ts
describe("checkout — voucher preview does not create an order (Task 8 fix)", () => {
  let voucherBuyerId: number;
  let voucherCode: string;

  beforeAll(async () => {
    const { hashPassword } = await import("@app/core/password");
    const { createVoucher } = await import("@app/db");
    const { VoucherType } = await import("@app/core/enums");
    const u = await prisma.user.create({
      data: {
        loginUsername: "voucherbuyer",
        email: "voucher@buyer.test",
        passwordHash: hashPassword("voucher-pass-99"),
        referralCode: "VCHR001",
      },
    });
    voucherBuyerId = u.id;
    const v = await createVoucher(prisma, { code: "SAVE10", type: VoucherType.PERCENT, value: "10" });
    voucherCode = v.code;
  });

  async function voucherSession() {
    const cookie = await loginAs("voucherbuyer", "voucher-pass-99");
    await addToCart(prisma, voucherBuyerId, productId, 1);
    const page = await app.inject({ method: "GET", url: "/checkout", headers: { cookie } });
    return { cookie, csrf: csrfFrom(page.body) };
  }

  it("POST /checkout/voucher/preview recomputes totals but never creates an order", async () => {
    const { cookie, csrf } = await voucherSession();
    const before = await prisma.order.count({ where: { userId: voucherBuyerId } });

    const res = await app.inject({
      method: "POST",
      url: "/checkout/voucher/preview",
      headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
      payload: new URLSearchParams({ voucher_code: voucherCode, csrf_token: csrf }).toString(),
    });

    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("Voucher"); // web.voucher_discount label, applied 10% off
    const after = await prisma.order.count({ where: { userId: voucherBuyerId } });
    expect(after).toBe(before); // <-- the actual bug: this used to be before + 1
  });

  it("shows an inline error for an unknown voucher code, still without creating an order", async () => {
    const { cookie, csrf } = await voucherSession();
    const before = await prisma.order.count({ where: { userId: voucherBuyerId } });

    const res = await app.inject({
      method: "POST",
      url: "/checkout/voucher/preview",
      headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
      payload: new URLSearchParams({ voucher_code: "NOPE-DOES-NOT-EXIST", csrf_token: csrf }).toString(),
    });

    expect(res.statusCode).toBe(200);
    const after = await prisma.order.count({ where: { userId: voucherBuyerId } });
    expect(after).toBe(before);
  });

  it("rejects the preview request without a valid CSRF token", async () => {
    const { cookie } = await voucherSession();
    const res = await app.inject({
      method: "POST",
      url: "/checkout/voucher/preview",
      headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
      payload: new URLSearchParams({ voucher_code: voucherCode, csrf_token: "wrong" }).toString(),
    });
    expect(res.statusCode).toBe(403);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run apps/storefront/test/storefront.test.ts -t "voucher preview"`
Expected: FAIL — `POST /checkout/voucher/preview` doesn't exist yet, so Fastify returns 404 (`res.statusCode` is `404`, not `200`), failing the `expect(res.statusCode).toBe(200)` assertions.

- [ ] **Step 3: Write minimal implementation**

**3a. `apps/storefront/src/routes/checkout.ts`** — insert this new route immediately after the closing `);` of the `POST /checkout` handler (currently ends at line 375), before the `// ---- Payment instructions ----` comment (currently line 377):

```ts
  // ---- Voucher preview (Task 8 fix): recompute totals with the voucher
  // code WITHOUT creating an order — reuses the SAME checkoutView() that
  // powers GET /checkout, so this can never drift from the real totals.
  // The Apply button on checkout.njk calls this via HTMX instead of
  // submitting the main form, so a valid voucher code can no longer be
  // indistinguishable from clicking "Place Order".
  app.post<{ Body: { voucher_code?: string } }>(
    "/checkout/voucher/preview",
    { preHandler: csrfProtect },
    async (req, reply) => {
      const customer = req.customer!;
      const voucherCode = (req.body.voucher_code ?? "").trim().toUpperCase() || null;
      const [view, fxRate] = await Promise.all([
        checkoutView(customer, voucherCode, null),
        getUsdIdrRate(prisma),
      ]);
      return reply.view("_checkout_totals.njk", {
        lang: requestLang(req),
        fx: fxRate ? fxRate.toString() : null,
        subtotal: view.subtotal,
        bulk_discount: view.bulk_discount,
        voucher_discount: view.voucher_discount,
        total: view.total,
        voucher_error_key: view.error_key,
        idr_enabled: view.idr_enabled,
        paydisini_enabled: view.paydisini_enabled,
        binance_enabled: view.binance_enabled,
        bybit_enabled: view.bybit_enabled,
        bybit_bsc_enabled: view.bybit_bsc_enabled,
        nowpayments_enabled: view.nowpayments_enabled,
      });
    },
  );

```

No new imports are needed — `getUsdIdrRate`, `requestLang`, `csrfProtect`, `prisma` are all already imported at the top of this file (lines 31, 64, 49, 22 respectively), and `checkoutView` is a local function in this same file.

**Note for implementer:** confirm `checkoutView`'s actual return-object field names (`subtotal`, `bulk_discount`, `voucher_discount`, `total`, `error_key`, `idr_enabled`, etc.) by reading its implementation and its callers in `GET /checkout` before wiring the field names above — adjust to match if they differ.

**3b. Create `apps/storefront/views/_checkout_totals.njk`** (new file — the Totals card, extracted so it can render standalone for the HTMX swap, mirroring the existing `_pay_status.njk` fragment convention: no `{% extends %}`, self-contained):

```
{# Checkout Totals card — extracted into its own fragment so it can be
   re-rendered standalone by POST /checkout/voucher/preview (Task 8 fix)
   without creating an order. Self-contained: imports its own macros and
   recomputes any_method itself rather than relying on the parent template's
   {% set %} scope, so it renders correctly both embedded (full GET /checkout
   page) and standalone (the HTMX voucher-preview response). #}
{% import "_shop.njk" as shop %}
{% set any_method = idr_enabled or paydisini_enabled or binance_enabled or bybit_enabled or bybit_bsc_enabled or nowpayments_enabled %}

{% if voucher_error_key %}
<div class="card card-pad border-rust/40 bg-rust-tint text-rust-dark text-sm mb-3">
  <i data-lucide="alert-triangle" class="w-4 h-4"></i> {{ t(voucher_error_key, lang) }}
</div>
{% endif %}

<div class="card card-pad">
  <h2 class="section-title mb-3">{{ t('web.summary', lang) }}</h2>
  <div class="text-sm divide-y divide-line">
    <div class="flex justify-between py-2">
      <span class="text-ink-soft">{{ t('web.subtotal', lang) }}</span>
      <span>{{ subtotal | idr }}</span>
    </div>
    {% if bulk_discount != "0" %}
    <div class="flex justify-between py-2 text-grass-dark">
      <span>{{ t('web.bulk_discount', lang) }}</span>
      <span>−{{ bulk_discount | idr }}</span>
    </div>
    {% endif %}
    {% if voucher_discount != "0" %}
    <div class="flex justify-between py-2 text-grass-dark">
      <span>{{ t('web.voucher_discount', lang) }}</span>
      <span>−{{ voucher_discount | idr }}</span>
    </div>
    {% endif %}
    <div class="flex justify-between py-3 items-baseline">
      <span class="font-semibold">{{ t('web.order_total', lang) }}</span>
      {{ shop.price(total, fx, "text-lg") }}
    </div>
  </div>
  {% if fx %}
  <p class="text-xs text-ink-faint">{{ t('web.usdt_note', lang) }}</p>
  {% endif %}
  <button type="submit" class="btn btn-primary w-full mt-4" {% if not any_method %}disabled style="opacity:.5;cursor:not-allowed"{% endif %}>
    {{ t('web.place_order', lang) }} <i data-lucide="chevron-right" class="w-4 h-4"></i>
  </button>
  <a href="/cart" class="btn btn-ghost w-full mt-2">{{ t('web.back_to_cart', lang) }}</a>
</div>
```

**3c. `apps/storefront/views/checkout.njk`** — two edits.

Replace the voucher card's Apply button, current lines 97-105:

```
    {# Voucher #}
    <div class="card card-pad">
      <label class="field-label" for="voucher_code">{{ t('web.voucher_label', lang) }}</label>
      <div class="flex gap-2">
        <input id="voucher_code" name="voucher_code" value="{{ voucher_code }}" class="field uppercase"
               placeholder="{{ t('web.voucher_placeholder', lang) }}" maxlength="32">
        <button type="submit" class="btn btn-soft shrink-0">{{ t('web.voucher_apply', lang) }}</button>
      </div>
    </div>
```

with:

```
    {# Voucher — Apply is a plain button (never type="submit"): it previews
       the discount via HTMX against /checkout/voucher/preview instead of
       submitting the real checkout form (Task 8 fix — this used to be
       indistinguishable from clicking Place Order for a valid code).
       hx-include="closest form" carries voucher_code + csrf_token (and any
       other form fields) along; the swap only replaces #checkout-summary,
       so this input's live value is untouched and still submits with the
       real "Place Order" click afterwards. #}
    <div class="card card-pad">
      <label class="field-label" for="voucher_code">{{ t('web.voucher_label', lang) }}</label>
      <div class="flex gap-2">
        <input id="voucher_code" name="voucher_code" value="{{ voucher_code }}" class="field uppercase"
               placeholder="{{ t('web.voucher_placeholder', lang) }}" maxlength="32">
        <button type="button" hx-post="/checkout/voucher/preview" hx-include="closest form"
                hx-target="#checkout-summary" hx-swap="innerHTML"
                class="btn btn-soft shrink-0">{{ t('web.voucher_apply', lang) }}</button>
      </div>
    </div>
```

Replace the Totals card, current lines 132-164:

```
  {# Totals #}
  <div class="card card-pad">
    <h2 class="section-title mb-3">{{ t('web.summary', lang) }}</h2>
    <div class="text-sm divide-y divide-line">
      <div class="flex justify-between py-2">
        <span class="text-ink-soft">{{ t('web.subtotal', lang) }}</span>
        <span>{{ subtotal | idr }}</span>
      </div>
      {% if bulk_discount != "0" %}
      <div class="flex justify-between py-2 text-grass-dark">
        <span>{{ t('web.bulk_discount', lang) }}</span>
        <span>−{{ bulk_discount | idr }}</span>
      </div>
      {% endif %}
      {% if voucher_discount != "0" %}
      <div class="flex justify-between py-2 text-grass-dark">
        <span>{{ t('web.voucher_discount', lang) }}</span>
        <span>−{{ voucher_discount | idr }}</span>
      </div>
      {% endif %}
      <div class="flex justify-between py-3 items-baseline">
        <span class="font-semibold">{{ t('web.order_total', lang) }}</span>
        {{ shop.price(total, fx, "text-lg") }}
      </div>
    </div>
    {% if fx %}
    <p class="text-xs text-ink-faint">{{ t('web.usdt_note', lang) }}</p>
    {% endif %}
    <button type="submit" class="btn btn-primary w-full mt-4" {% if not any_method %}disabled style="opacity:.5;cursor:not-allowed"{% endif %}>
      {{ t('web.place_order', lang) }} <i data-lucide="chevron-right" class="w-4 h-4"></i>
    </button>
    <a href="/cart" class="btn btn-ghost w-full mt-2">{{ t('web.back_to_cart', lang) }}</a>
  </div>
</form>
```

with:

```
  {# Totals — extracted into _checkout_totals.njk (Task 8 fix) so the
     voucher-preview HTMX response can re-render just this card. #}
  <div id="checkout-summary">
    {% include "_checkout_totals.njk" %}
  </div>
</form>
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run apps/storefront/test/storefront.test.ts -t "voucher preview"`
Expected: PASS (3 tests: preview applies a discount without creating an order, unknown code shows an inline error without creating an order, missing/wrong CSRF is rejected with 403)

Also run the full file to confirm no regression in the existing checkout tests (the Totals card markup is unchanged, just relocated):

Run: `pnpm vitest run apps/storefront/test/storefront.test.ts`
Expected: PASS (all existing + 3 new tests)

- [ ] **Step 5: Commit**
```bash
git add apps/storefront/src/routes/checkout.ts apps/storefront/views/checkout.njk apps/storefront/views/_checkout_totals.njk apps/storefront/test/storefront.test.ts
git commit -m "fix(storefront): voucher Apply previews the discount via HTMX instead of placing a real order"
```

---

### Task 9: Fix dead Telegram contact link on homepage when bot isn't configured

**Files:**
- Modify: `apps/storefront/views/home.njk:276-301`
- Test: `apps/storefront/test/storefront.test.ts`

**Interfaces:**
- Consumes: `bot_username` (already passed from `apps/storefront/src/routes/home.ts:92`, `await resolveBotUsername()`) and `wa_number` (line 93).
- Produces: no route/data changes — template-only fix, so the contact grid never renders a dead `href="https://t.me/"`, and the grid column count matches however many contact cards are actually visible (1, 2, or 3).

- [ ] **Step 1: Write the failing test**

Add to `apps/storefront/test/storefront.test.ts` (new `describe` block, near the existing "login widget — live bot username" describe block at line 643, reusing the same `"YourBot"`-placeholder pattern already used there):

```ts
describe("home page — Telegram contact link hidden when bot isn't configured (Task 9 fix)", () => {
  it("never renders a dead https://t.me/ link when bot_username resolves empty", async () => {
    await setSetting(prisma, "bot_username", "YourBot"); // .env.example placeholder → resolves to ""
    const res = await app.inject({ method: "GET", url: "/" });
    expect(res.statusCode).toBe(200);
    expect(res.body).not.toContain('href="https://t.me/"');
    await deleteSetting(prisma, "bot_username");
  });

  it("shows the Telegram contact link when a real bot_username is configured", async () => {
    await setSetting(prisma, "bot_username", "realtoko_bot");
    const res = await app.inject({ method: "GET", url: "/" });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('href="https://t.me/realtoko_bot"');
    await deleteSetting(prisma, "bot_username");
  });

  it("uses a 1-column contact grid when only the support-ticket card remains (no WA, no bot)", async () => {
    await deleteSetting(prisma, "support_whatsapp");
    await setSetting(prisma, "bot_username", "YourBot"); // → ""
    const res = await app.inject({ method: "GET", url: "/" });
    expect(res.statusCode).toBe(200);
    expect(res.body).not.toMatch(/sm:grid-cols-[23]/);
    await deleteSetting(prisma, "bot_username");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run apps/storefront/test/storefront.test.ts -t "Telegram contact link"`
Expected: FAIL on the first test — the current template renders `<a href="https://t.me/">` unconditionally, so `res.body` DOES contain `href="https://t.me/"`, failing `expect(res.body).not.toContain(...)`. The third test also fails because the grid class is `sm:grid-cols-2` (from `wa_number` alone) even though only 1 card (Support ticket) is actually visible.

- [ ] **Step 3: Write minimal implementation**

**`apps/storefront/views/home.njk`** — replace the contact section, current lines 276-301:

```
  <p class="mt-2 text-center text-ink-soft">{{ t('web.contact_sub', lang) }}</p>

  <div class="mt-8 grid grid-cols-1 {{ 'sm:grid-cols-3' if wa_number else 'sm:grid-cols-2' }} gap-4 max-w-2xl mx-auto">
    {% if wa_number %}
    <a href="https://wa.me/{{ wa_number }}" target="_blank" rel="noopener noreferrer"
       class="flex flex-col items-center gap-3 rounded-2xl border border-line bg-card p-6 text-center shadow-sm transition hover:shadow-md">
      <div class="grid h-12 w-12 place-items-center rounded-2xl bg-grass-tint">
        <svg class="h-6 w-6 text-grass-dark" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413z"/></svg>
      </div>
      <div>
        <h3 class="font-semibold text-ink">WhatsApp</h3>
        <p class="mt-1 text-xs text-ink-faint">{{ t('web.contact_wa_sub', lang) }}</p>
      </div>
    </a>
    {% endif %}

    <a href="https://t.me/{{ bot_username }}" target="_blank" rel="noopener noreferrer"
       class="flex flex-col items-center gap-3 rounded-2xl border border-line bg-card p-6 text-center shadow-sm transition hover:shadow-md">
      <div class="grid h-12 w-12 place-items-center rounded-2xl bg-[#eff6ff]">
        <svg class="h-6 w-6 text-[#2563eb]" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M11.944 0A12 12 0 0 0 0 12a12 12 0 0 0 12 12 12 12 0 0 0 12-12A12 12 0 0 0 12 0a12 12 0 0 0-.056 0zm4.962 7.224c.1-.002.321.023.465.14a.506.506 0 0 1 .171.325c.016.093.036.306.02.472-.18 1.898-.962 6.502-1.36 8.627-.168.9-.499 1.201-.82 1.23-.696.065-1.225-.46-1.9-.902-1.056-.693-1.653-1.124-2.678-1.8-1.185-.78-.417-1.21.258-1.91.177-.184 3.247-2.977 3.307-3.23.007-.032.014-.15-.056-.212s-.174-.041-.249-.024c-.106.024-1.793 1.14-5.061 3.345-.48.33-.913.49-1.302.48-.428-.008-1.252-.241-1.865-.44-.752-.245-1.349-.374-1.297-.789.027-.216.325-.437.893-.663 3.498-1.524 5.83-2.529 6.998-3.014 3.332-1.386 4.025-1.627 4.476-1.635z"/></svg>
      </div>
      <div>
        <h3 class="font-semibold text-ink">Telegram</h3>
        <p class="mt-1 text-xs text-ink-faint">{{ t('web.contact_tg_sub', lang) }}</p>
      </div>
    </a>

    <a href="/account/support"
```

with (guards the Telegram link exactly like the WhatsApp link above it, and makes the grid-column count reflect however many of the (up to) 3 contact cards are actually visible — WhatsApp + Telegram + the always-present Support ticket card):

```
  <p class="mt-2 text-center text-ink-soft">{{ t('web.contact_sub', lang) }}</p>

  {% set contact_count = 1 + (1 if wa_number else 0) + (1 if bot_username else 0) %}
  {% set contact_cols = "sm:grid-cols-3" if contact_count == 3 else ("sm:grid-cols-2" if contact_count == 2 else "") %}
  <div class="mt-8 grid grid-cols-1 {{ contact_cols }} gap-4 max-w-2xl mx-auto">
    {% if wa_number %}
    <a href="https://wa.me/{{ wa_number }}" target="_blank" rel="noopener noreferrer"
       class="flex flex-col items-center gap-3 rounded-2xl border border-line bg-card p-6 text-center shadow-sm transition hover:shadow-md">
      <div class="grid h-12 w-12 place-items-center rounded-2xl bg-grass-tint">
        <svg class="h-6 w-6 text-grass-dark" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413z"/></svg>
      </div>
      <div>
        <h3 class="font-semibold text-ink">WhatsApp</h3>
        <p class="mt-1 text-xs text-ink-faint">{{ t('web.contact_wa_sub', lang) }}</p>
      </div>
    </a>
    {% endif %}

    {% if bot_username %}
    <a href="https://t.me/{{ bot_username }}" target="_blank" rel="noopener noreferrer"
       class="flex flex-col items-center gap-3 rounded-2xl border border-line bg-card p-6 text-center shadow-sm transition hover:shadow-md">
      <div class="grid h-12 w-12 place-items-center rounded-2xl bg-[#eff6ff]">
        <svg class="h-6 w-6 text-[#2563eb]" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M11.944 0A12 12 0 0 0 0 12a12 12 0 0 0 12 12 12 12 0 0 0 12-12A12 12 0 0 0 12 0a12 12 0 0 0-.056 0zm4.962 7.224c.1-.002.321.023.465.14a.506.506 0 0 1 .171.325c.016.093.036.306.02.472-.18 1.898-.962 6.502-1.36 8.627-.168.9-.499 1.201-.82 1.23-.696.065-1.225-.46-1.9-.902-1.056-.693-1.653-1.124-2.678-1.8-1.185-.78-.417-1.21.258-1.91.177-.184 3.247-2.977 3.307-3.23.007-.032.014-.15-.056-.212s-.174-.041-.249-.024c-.106.024-1.793 1.14-5.061 3.345-.48.33-.913.49-1.302.48-.428-.008-1.252-.241-1.865-.44-.752-.245-1.349-.374-1.297-.789.027-.216.325-.437.893-.663 3.498-1.524 5.83-2.529 6.998-3.014 3.332-1.386 4.025-1.627 4.476-1.635z"/></svg>
      </div>
      <div>
        <h3 class="font-semibold text-ink">Telegram</h3>
        <p class="mt-1 text-xs text-ink-faint">{{ t('web.contact_tg_sub', lang) }}</p>
      </div>
    </a>
    {% endif %}

    <a href="/account/support"
```

(the remainder of the block — the Support-ticket `<a>` and its closing `</div>` — is unchanged, so it isn't repeated here.)

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run apps/storefront/test/storefront.test.ts -t "Telegram contact link"`
Expected: PASS (3 tests)

Run the full file to confirm no regression (e.g. the default-config home page test that still expects a visible Telegram link, since `BOT_USERNAME=TestBot` in `setup-env.ts`):

Run: `pnpm vitest run apps/storefront/test/storefront.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**
```bash
git add apps/storefront/views/home.njk apps/storefront/test/storefront.test.ts
git commit -m "fix(storefront): hide the homepage Telegram contact link when the bot isn't configured"
```

---

### Task 10: Fix restock form defaulting to a 404 action when JS hasn't set the denomination id yet

**Files:**
- Modify: `apps/storefront/src/routes/catalog.ts:87-113`
- Modify: `apps/storefront/views/product.njk:69`
- Test: `apps/storefront/test/storefront.test.ts`

**Interfaces:**
- Consumes: `denominations` array already built in `GET /p/:slug` (each item has `id`, `in_stock` — lines 88-101), mirrors the exact same "first in-stock, else first" selection logic the client-side JS already uses (`product.njk:159-164`).
- Produces: new `default_restock_denomination_id: number` field in the `product.njk` view context, consumed by the restock form's `action` attribute so it's always a valid `/restock/:id`, even before JS runs (or with JS disabled).

- [ ] **Step 1: Write the failing test**

Add to `apps/storefront/test/storefront.test.ts`, immediately after the existing `it("shows out-of-stock + restock CTA when no stock", ...)` test (currently lines 301-306), reusing the file's existing `emptyProductSlug`/`emptyProductId` fixtures (the single-denomination, zero-stock "Spotify Family" product seeded in `beforeAll`):

```ts
  it("renders a valid denomination id in the restock form's default action (Task 10 fix)", async () => {
    const res = await app.inject({ method: "GET", url: `/p/${emptyProductSlug}` });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain(`action="/restock/${emptyProductId}"`);
    expect(res.body).not.toContain('action="/restock/"');
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run apps/storefront/test/storefront.test.ts -t "restock form's default action"`
Expected: FAIL — the current template hard-codes `action="/restock/"`, so `res.body` contains the literal `action="/restock/"` (failing the `.not.toContain` assertion) and does NOT contain `action="/restock/${emptyProductId}"`.

- [ ] **Step 3: Write minimal implementation**

**3a. `apps/storefront/src/routes/catalog.ts`** — insert the default-id computation right after the `denominations` array is built (currently lines 87-101), and pass it into the view (currently line 113 `denominations,`):

Replace:
```ts
    const catName = product.category.name;
    const denominations = product.denominations.map((d) => {
      const available = stock[d.id]?.available ?? 0;
      const rule = bulkRules[d.id];
      return {
        id: d.id,
        name: d.name,
        duration_label: d.durationLabel,
        price: new Decimal(d.price).toString(),
        warranty_days: d.warrantyDays,
        available,
        in_stock: available > 0,
        bulk: rule ? { min_quantity: rule.minQuantity, discount_percent: rule.discountPercent } : null,
      };
    });

    return reply.view("product.njk", {
      ...ctx,
      product: {
        slug: product.slug,
        name: product.name,
        description: product.description,
        category_name: catName,
        category_slug: product.category.slug,
        image: product.webImageUrl ?? productImage(product, catName),
      },
      denominations,
```

with:
```ts
    const catName = product.category.name;
    const denominations = product.denominations.map((d) => {
      const available = stock[d.id]?.available ?? 0;
      const rule = bulkRules[d.id];
      return {
        id: d.id,
        name: d.name,
        duration_label: d.durationLabel,
        price: new Decimal(d.price).toString(),
        warranty_days: d.warrantyDays,
        available,
        in_stock: available > 0,
        bulk: rule ? { min_quantity: rule.minQuantity, discount_percent: rule.discountPercent } : null,
      };
    });
    // Default restock-form target (Task 10 fix): mirrors product.njk's inline
    // JS selection order ("first in-stock denomination, else the first
    // denomination" — see product.njk's `firstEnabled || radios[0]`) so the
    // form already has a valid /restock/:id action at page-load time, before
    // that JS runs (or with JS disabled) — `denominations` is never empty
    // here (guarded by the 404 check above).
    const defaultRestockDenominationId = (denominations.find((d) => d.in_stock) ?? denominations[0])!.id;

    return reply.view("product.njk", {
      ...ctx,
      product: {
        slug: product.slug,
        name: product.name,
        description: product.description,
        category_name: catName,
        category_slug: product.category.slug,
        image: product.webImageUrl ?? productImage(product, catName),
      },
      denominations,
      default_restock_denomination_id: defaultRestockDenominationId,
```

**3b. `apps/storefront/views/product.njk`** — line 69, replace:

```
      <form id="restock-form" method="post" action="/restock/" class="mt-3 hidden">
```

with:

```
      <form id="restock-form" method="post" action="/restock/{{ default_restock_denomination_id }}" class="mt-3 hidden">
```

(No JS changes needed — `select()` in the existing `<script>` block, lines 142-149, still overwrites `action` correctly whenever the buyer switches to an out-of-stock denomination; this fix only removes the window where the default is an invalid, id-less path.)

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run apps/storefront/test/storefront.test.ts -t "restock form's default action"`
Expected: PASS (1 test)

Run the full file to confirm the pre-existing out-of-stock/restock-CTA test still passes unchanged:

Run: `pnpm vitest run apps/storefront/test/storefront.test.ts -t "restock"`
Expected: PASS (2 tests: the existing "shows out-of-stock + restock CTA" test and the new one)

- [ ] **Step 5: Commit**
```bash
git add apps/storefront/src/routes/catalog.ts apps/storefront/views/product.njk apps/storefront/test/storefront.test.ts
git commit -m "fix(storefront): default the restock form's action to a valid denomination id at render time"
```

---

## Post-Execution Verification

After all 10 tasks are complete and individually reviewed:

1. Run `pnpm typecheck` (repo-wide) — must be green.
2. Run `pnpm test` (full Vitest suite across all workspaces) — must be green.
3. Rebuild the web-admin SPA (`pnpm --filter @app/web-admin-client build`) since Tasks 3-7 touch `apps/web-admin/client` — required before any manual `pnpm dev:web` check reflects the changes, per CLAUDE.md.
4. Dispatch the final whole-branch code reviewer per the subagent-driven-development skill before considering the branch ready to merge.
