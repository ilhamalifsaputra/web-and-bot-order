---
name: shopping-flow-landmarks
description: Where the customer catalog→product→checkout handlers, keyboards, smartEdit, and locales live in apps/order-bot
metadata:
  type: project
---

Customer shopping flow map (apps/order-bot). Verify line numbers before acting — code shifts.

**Handlers**
- `src/handlers/customer.ts` — browse list (`browseProductsFlat`), product detail (`browseProduct`), qty input, my-orders, wallet, referral, restock, tickets. `downloadHistory` builds a .txt with hardcoded English.
- `src/handlers/checkout.ts` — `showOrderConfirmation`/`computeConfirmation` (summary), `buyNow` (Binance Pay), `buyNowInternal` (auto-confirm UID transfer), `sendPaymentInstructions` (+countdown/reminder timers), `cancelPendingOrder`. Per-order timers in module maps `timersByOrder`/`activePaymentByChat`.
- `src/handlers/callbacks.ts` — central `v1:<domain>:<action>` router (`routeCallback`), domain table `DOMAIN_ROUTES`. Inline helpers: `showReviewPrompt`, `requestReplacement`, `closeTicketUser`.
- `src/conversations/checkout.ts` — voucher conversation (grammY conversations plugin owns `voucher:start`).

**Keyboards** — `src/keyboards/customer.ts`. Builders: `productDetailKb`, `orderConfirmKb`, `paymentInstructionsKb`, `proofCancelKb`, `ordersListKb`, `orderDetailKb`, `backToMain`, `notificationKb`. Reply keyboards: `mainPersistentKb`, `productsPersistentKb` (numbered). `cb(...)` builds `v1:` callback data.

**Render plumbing** — `src/util/chat.ts`: `smartEdit` (customer) edits bubble on callback (text or photo+caption), falls back to fresh send; clears `awaitingQtyProductId`. `adminEdit` is admin twin. `src/util/errors.ts`: `logErrorRef` → `error.generic_ref` quotable ref.

**i18n** — `packages/core/locales/{en,id}.json`, accessed via `t(ctx,key,args)` (handlers) / `coreT(key,lang,args)` (keyboards/timers). Money: USDT/other via `formatPrice`/local `price()`; IDR via `formatIdr` (added to `packages/core/src/formatters.ts` — formatPrice can't do Rp prefix/dotted thousands). As of 2026-05-31 post-fix: 219 keys each, key sets + placeholders fully matched.

See [[ux-antipatterns]].
