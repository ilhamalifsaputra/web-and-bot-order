# Storefront UI/UX Findings

All findings were reproduced live against `http://127.0.0.1:8100` with Playwright, then cross-referenced against source under `apps/storefront/client/src/` and `apps/storefront/src/` to pin down the exact file responsible. IDs are referenced from `report.json` and `implementation-plan.md`.

Severity scale: **Critical** (blocks or actively misleads purchase), **High** (real conversion/access/trust damage, affects a broad class of users), **Medium** (clear friction or inconsistency), **Low** (polish/copy).

---

## STO-001 — "Out of stock" badge misrepresents purchasable manual-delivery products

- **Severity:** Critical
- **Page:** Homepage, Category (`/c/premium-apps`), Search
- **Screenshot:** `screenshots/homepage-desktop.png`, `screenshots/category-desktop.png`
- **Current behavior:** The only product in the live catalog, "Capcut Pro 1 Month", shows a red "Out of stock" badge on every listing card (home, category, search). Its API payload confirms both denominations have `available: 0` and `in_stock: false` because both use `delivery_type: "manual_with_info"`/`"manual"`, which never carry a real stock count. The product page itself already accounts for this via `purchasable(d) { return d.delivery_type !== "auto" || d.in_stock; }` and lets the customer add it to cart and reach checkout successfully — confirmed live.
- **Expected behavior:** The listing-card stock indicator should use the same purchasability rule as the product page.
- **Recommendation:** Extend `StockBadge` to accept `delivery_type` and skip the red state whenever every denomination is non-`auto`.
- **Implementation notes:** `apps/storefront/client/src/components/shop/StockBadge.tsx`, `apps/storefront/client/src/components/shop/ProductCard.tsx`, and the server-side card builder under `apps/storefront/src/` that emits `ProductCardData`.

---

## STO-002 — Blank "Signed in as" name for password-registered customers

- **Severity:** High
- **Page:** Account (`/account`)
- **Screenshot:** `screenshots/account-desktop.png`
- **Current behavior:** After registering via the password-only form, `/account` shows "Signed in as" followed by nothing. `GET /api/v1/account` returns `{"name":"", ...}`.
- **Root cause:** `apps/storefront/src/routes/apiAccount.ts:82`: `name: customer.user.fullName ?? customer.user.username ?? String(customer.telegramId ?? "")` — omits `loginUsername`, the field the register flow actually sets.
- **Expected behavior:** Should show the registered username/email when no Telegram identity is linked.
- **Recommendation:** Add `?? customer.user.loginUsername` to the fallback chain.
- **Implementation notes:** `apps/storefront/src/routes/apiAccount.ts:82`.

---

## STO-003 — Keyboard focus ring invisible on hero CTA buttons

- **Severity:** High
- **Page:** Homepage (hero section)
- **Screenshot:** `screenshots/keyboard-focus-hero-cta2.png`
- **Current behavior:** Tabbing to "Browse products" over the blue gradient hero shows no visible focus ring. Computed style on the focused element: `outline-color: rgba(37, 99, 235, 0.4)` at 2px — a 40%-opacity blue ring on a solid blue background.
- **Expected behavior:** Focus indicators must meet WCAG 2.4.11 contrast against their background.
- **Recommendation:** Add an "on dark surface" focus style (lighter ring/offset shadow) for interactive elements on `bg-ink`/`bg-pine`/hero surfaces.
- **Implementation notes:** Hero buttons in `apps/storefront/client/src/pages/HomePage.tsx` (~lines 130-143); check the "Our Promise" `bg-pine` band too — same risk.

---

## STO-004 — Language switcher unreachable on mobile

- **Severity:** High
- **Page:** Global navigation, mobile viewport
- **Screenshot:** `screenshots/homepage-mobile.png`
- **Current behavior:** `apps/storefront/client/src/components/Layout.tsx:84` renders the EN/ID toggle `hidden ... sm:flex` (≥640px only). No other language control exists anywhere in the app.
- **Expected behavior:** Every visitor should be able to switch language regardless of viewport.
- **Recommendation:** Fold the toggle into the existing mobile secondary row (`Layout.tsx:119`, already used for the mobile search bar) or add it to Settings as a fallback.
- **Implementation notes:** `apps/storefront/client/src/components/Layout.tsx:84,119`.

---

## STO-005 — Voucher error message disconnected from its input on desktop

- **Severity:** Medium
- **Page:** Checkout
- **Screenshot:** `screenshots/checkout-voucher-error-desktop.png` vs `screenshots/checkout-voucher-error-mobile.png`
- **Current behavior:** An invalid voucher code renders "Voucher code not found." inside the right-hand `#checkout-summary` column, ~400px and a full column gutter from the discount-code input in the left column. Mobile's stacked layout incidentally places them adjacent.
- **Expected behavior:** Inline errors should render next to the field they validate on every viewport.
- **Recommendation:** Move the voucher-specific error into the same card as the voucher input, independent of the totals-level error block that belongs in the summary.
- **Implementation notes:** `apps/storefront/client/src/pages/CheckoutPage.tsx` — input block lines 433-458, error block lines 461-466.

---

## STO-006 — Reveal-on-scroll leaves homepage sections invisible without an organic scroll

- **Severity:** Medium
- **Page:** Homepage
- **Screenshot:** `screenshots/homepage-desktop.png`, `screenshots/homepage-mobile.png`
- **Current behavior:** Sections use `.reveal` (`opacity:0`) flipped to `.visible` only via `IntersectionObserver`. Confirmed via computed styles: 5 of 7 sections were still `opacity:0` right after load. Works for real scrolling users but has no fallback for screenshot/print/PDF tools, non-scrolling crawlers, or slow/erroring JS (only `prefers-reduced-motion` is handled).
- **Expected behavior:** No code path should leave content permanently invisible.
- **Recommendation:** Add a timeout-based fallback that forces `.visible` after N seconds regardless of intersection, or widen `rootMargin` so content reveals earlier.
- **Implementation notes:** `apps/storefront/client/src/pages/HomePage.tsx:51-72`, `apps/storefront/client/src/pages/HomePage.css:21-38`.

---

## STO-007 — No sort, filter, or pagination on product listings

- **Severity:** Medium
- **Page:** Category, Search
- **Screenshot:** `screenshots/category-desktop.png`
- **Current behavior:** Confirmed by source read — no sort/filter/pagination controls exist in `CategoryPage.tsx` or `SearchPage.tsx`. Not visible today only because the catalog has one product.
- **Expected behavior:** Once a category exceeds a screenful, customers need at least a sort control and eventually pagination/infinite scroll.
- **Recommendation:** Add a sort dropdown first (cheapest/newest/rating), then filters/pagination as the catalog grows.
- **Implementation notes:** `apps/storefront/client/src/pages/CategoryPage.tsx`, `apps/storefront/client/src/pages/SearchPage.tsx`.

---

## STO-008 — No "Continue shopping" link on the cart page

- **Severity:** Medium
- **Page:** Cart
- **Screenshot:** `screenshots/cart-desktop.png`
- **Current behavior:** The cart offers only "Continue to payment"; no link back to browsing exists.
- **Expected behavior:** A "Continue shopping" affordance per the audit brief's cart checklist.
- **Recommendation:** Add a "Continue shopping" link near the summary/checkout CTA.
- **Implementation notes:** `apps/storefront/client/src/pages/CartPage.tsx` (~line 167).

---

## STO-009 — "Sign in with Telegram" copy hides the working password-login path

- **Severity:** Medium
- **Page:** Cart (signed-out summary copy)
- **Screenshot:** `screenshots/cart-desktop.png`
- **Current behavior:** Cart tells signed-out visitors "You'll sign in with Telegram at checkout" — misleading, since this audit registered/logged in with plain username/email/password, no Telegram involved.
- **Expected behavior:** Copy should mention signing in generally, not single out Telegram.
- **Recommendation:** Reword to "Sign in to continue — your cart comes along" in both locales.
- **Implementation notes:** `packages/core/locales/en.json:445`, `packages/core/locales/id.json:445` (key `web.login_to_checkout`).

---

## STO-010 — Repeated per-unit fields at checkout with no bulk-fill shortcut

- **Severity:** Medium
- **Page:** Checkout
- **Screenshot:** `screenshots/checkout-step1-desktop.png`
- **Current behavior:** Buying qty 3 of a `manual_with_info` product renders 3 separate required "Email" inputs ("Unit 1 of 3"..."Unit 3 of 3") with no way to fill one and apply to the rest.
- **Expected behavior:** A "same for all units" shortcut for the common case of buying multiples for oneself.
- **Recommendation:** Add an optional "Copy to all units" action next to Unit 1's field(s).
- **Implementation notes:** `apps/storefront/client/src/pages/CheckoutPage.tsx`, order-details block.

---

## STO-011 — Product detail page has no description, gallery, or related products

- **Severity:** Medium
- **Page:** Product detail
- **Screenshot:** `screenshots/product-detail-desktop.png`
- **Current behavior:** `ProductPage.tsx` renders one static image, plan selector, price/qty/CTA, and reviews only — no description/specs section, no multi-image gallery, no related-products section exists in the component regardless of data (masked today by a null `description`).
- **Expected behavior:** Description/specs and related products are expected per the audit brief's Product Detail checklist.
- **Recommendation:** Add a conditionally-rendered description/specs block and a same-category "You might also like" section.
- **Implementation notes:** `apps/storefront/client/src/pages/ProductPage.tsx`.

---

## STO-012 — "No payment methods" empty state doesn't link to support

- **Severity:** Low
- **Page:** Checkout
- **Screenshot:** `screenshots/checkout-step1-desktop.png`
- **Current behavior:** "...or contact support" renders as plain text, not a link.
- **Recommendation:** Wrap "contact support" in a link to `/account/support`.
- **Implementation notes:** `apps/storefront/client/src/pages/CheckoutPage.tsx` (~line 427).

---

## STO-013 — Raw "Bot domain invalid" text breaks Settings page styling

- **Severity:** Low
- **Page:** Account Settings
- **Screenshot:** `screenshots/settings-desktop.png`
- **Current behavior:** The Telegram-link card renders Telegram's raw widget error "Bot domain invalid" in default serif font, breaking visual consistency, whenever the bot's domain isn't authorized for this origin.
- **Recommendation:** Add a styled fallback around the widget, and verify BotFather `/setdomain` matches every deployed origin operationally.
- **Implementation notes:** `apps/storefront/client/src/pages/SettingsPage.tsx`.

---

## STO-014 — Username helper text says "lowercase" but the field accepts uppercase

- **Severity:** Low
- **Page:** Register
- **Screenshot:** `screenshots/register-desktop.png`
- **Current behavior:** Helper text says "lowercase letters, numbers, underscores"; `pattern="[a-zA-Z0-9_]+"` accepts uppercase too.
- **Recommendation:** Align copy and validation (either tighten the pattern or fix the copy).
- **Implementation notes:** `apps/storefront/client/src/pages/RegisterPage.tsx:93-97`.

---

## STO-015 — No password show/hide toggle anywhere

- **Severity:** Low
- **Page:** Login, Register, Account Settings
- **Screenshot:** `screenshots/login-desktop.png`, `screenshots/register-desktop.png`, `screenshots/settings-desktop.png`
- **Current behavior:** All password fields render with no visibility toggle.
- **Recommendation:** Add a shared `PasswordInput` component with a show/hide toggle.
- **Implementation notes:** `LoginPage.tsx`, `RegisterPage.tsx`, `SettingsPage.tsx`.

---

## STO-016 — Orders/Reviews empty states lack a CTA button

- **Severity:** Low
- **Page:** My orders, My reviews
- **Screenshot:** `screenshots/orders-empty-desktop.png`
- **Current behavior:** Good, specific copy ("No orders yet — your purchases will show up here.") but no actionable button.
- **Recommendation:** Add a "Browse products" button per the audit brief's empty-state guidance.
- **Implementation notes:** `OrdersPage.tsx`, `ReviewsPage.tsx`.

---

## STO-017 — Search page's browser tab title ignores the query

- **Severity:** Low
- **Page:** Search
- **Screenshot:** `screenshots/search-empty-desktop.png`
- **Current behavior:** `apps/storefront/src/routes/spaShell.ts:110-112` always renders the generic `web.search_placeholder` string as the `/search` title, never reading `req.query.q` — confirmed with two different queries, both showing "Search products… — Trustance" in the tab despite the on-page `<h1>` correctly showing `Results for "..."`.
- **Recommendation:** Interpolate the `q` param into the title, matching the product/category routes a few lines above in the same file.
- **Implementation notes:** `apps/storefront/src/routes/spaShell.ts:110-112`.

---

## STO-018 — Single-item product grid leaves a visually "broken" gap

- **Severity:** Low
- **Page:** Homepage, Category
- **Screenshot:** `screenshots/homepage-anchor-jump-produk.png`
- **Current behavior:** `sm:grid-cols-2 lg:grid-cols-3` grid with one product leaves two-thirds of the row empty, reading as unfinished rather than a deliberate single-item shelf.
- **Recommendation:** Clamp grid columns to the actual item count, or left-align with a fixed card width.
- **Implementation notes:** `apps/storefront/client/src/pages/HomePage.tsx`, `CategoryPage.tsx`.

---

## STO-019 — Referral commission balance lives only in the bot

- **Severity:** Low
- **Page:** Referral
- **Screenshot:** `screenshots/referral-desktop.png`
- **Current behavior:** Shows code/link, then defers balance to "the bot" — no number/history on the web.
- **Recommendation:** Product-scope decision; flagged for awareness given `/account` already shows wallet balances in the same UI.
- **Implementation notes:** `apps/storefront/client/src/pages/ReferralPage.tsx`.

---

## STO-020 — No success confirmation when a support ticket is created

- **Severity:** Low
- **Page:** Help & support
- **Screenshot:** `screenshots/support-ticket-created-desktop.png`
- **Current behavior:** Submitting a ticket clears the textbox and silently adds a table row — no toast.
- **Recommendation:** Add a brief success toast ("Ticket #1 created").
- **Implementation notes:** `apps/storefront/client/src/pages/SupportPage.tsx`.

---

## Environment blocker (not a numbered finding)

**Checkout cannot be completed past payment-method selection in this environment** — no payment gateway is configured, so "Place order & pay" stays disabled even with all required fields filled. Not a code defect; it prevented testing the Payment/Confirmation legs of the customer journey (see `customer-journey.md`).
