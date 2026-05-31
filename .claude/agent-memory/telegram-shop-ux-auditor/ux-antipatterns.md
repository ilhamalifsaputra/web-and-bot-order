---
name: ux-antipatterns
description: Customer-facing UX issues in the order-bot shopping flow — most resolved 2026-05-31; keep as a checklist of usual offenders
metadata:
  type: project
---

Anti-patterns found in apps/order-bot customer flow (audit 2026-05-31, branch feat/web-admin-tier2). All ten H/M/L items below were FIXED on 2026-05-31 (typecheck + 217 tests green). Kept as the "usual offenders" checklist — re-verify they haven't regressed before future audits.

RESOLVED 2026-05-31:
- **Payment/checkout strand (H2).** `paymentInstructionsKb` + `proofCancelKb` now add a non-destructive `menu.main` row alongside Cancel Order.
- **menu.main label bug (H1).** `menu.main` was "← Back" in BOTH locales (id leaked English). Now "🏠 Menu" / "🏠 Menu".
- **Stale bubble after error toast (H3).** `showOrderConfirmation` vanished-product / out-of-stock paths now `smartEdit` into a recovery screen + `backToMain`, not toast-and-return.
- **IDR not via shared helper (M1).** `buyNowInternal` used inline `Rp${toLocaleString}`. NOTE: `formatPrice` CANNOT render IDR (suffix currency + decimal point, e.g. "123456.00 USDT"). Added `formatIdr(amount)` to `packages/core/src/formatters.ts` (prefix Rp, dotted thousands, no decimals) — IDR routes through it now.
- **Hardcoded English (M2/M3/M4/L1).** `requestReplacement` alert → `order.replacement_requested`; ticket btn labels → `support.btn_resolve/reply/close`; `supportPhotoPromptKb` ternary → `support.btn_submit_photos/no_photos`; `downloadHistory` caption + .txt body → `order.history_file_*` + `order.history_file_caption`.
- **Persistent reply-keyboard labels were hardcoded English (L2).** See [[persistent-keyboard-i18n]] for the language-aware build+match design.
- **Orphan locale keys (L3) removed:** menu.cart, browse.add_to_cart, browse.choose_product_flat, browse.page_hint, checkout.use_wallet, checkout.summary, wallet.history. menu.wallet was KEPT (L2 now uses it). Bot has NO real cart — flow is Buy Now → confirm; "Cart/Keranjang" terms were misleading leftovers.

**Why:** these violated CLAUDE.md "edit the bubble / never strand / no leaked English / formatPrice everywhere".
**How to apply:** when auditing, confirm these spots are still clean; if new money rendering appears, IDR must use `formatIdr`, USDT/other use `formatPrice`/`price()`. See [[shopping-flow-landmarks]].
