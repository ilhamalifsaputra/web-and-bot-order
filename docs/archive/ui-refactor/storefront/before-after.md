# Before / After

Per-finding record of what changed, why, and the expected effect — companion to `findings.md` and
`implementation-plan.md`. All 20 findings (STO-001 through STO-020) were triaged; 19 shipped, 1 (STO-019) was a
deliberate scope decision to skip. Branding, colors, typography, and the component library were preserved
throughout — every change is usability/navigation/spacing/hierarchy/consistency/responsiveness/accessibility/
conversion, never a redesign.

## Batch 1 — Critical

### STO-001 — False "Out of stock" badge on manual/manual_with_info products
- **Before:** `StockBadge`/`ProductCard` read `available` directly. Non-`auto` denominations never carry stock
  rows by design (Task 2 skips stock reservation for them), so `available` was always `0` — every
  manual/manual_with_info product showed a red "Out of stock" badge on Home/Category/Search, even though it
  was fully purchasable on its own product page.
- **After:** Server-side card shaping (`apps/storefront/src/cards.ts`) adds `all_non_auto` (true when every
  active denomination on a product is non-`auto`). `StockBadge` shows "Available" whenever `all_non_auto` is
  true, mirroring `ProductPage.tsx`'s own `purchasable()` rule.
- **Impact:** Removes a store-wide false "sold out" signal that was actively suppressing sales on every
  manual-delivery listing.

## Batch 2 — High

### STO-002 — Web-only customer's display name falls back to a raw Telegram id
- **Before:** `GET /api/v1/account` built `name` from `fullName ?? username ?? String(telegramId)`, skipping
  the web login username. A password-only (non-Telegram) customer with no `fullName` saw a numeric id, or
  blank, as their name.
- **After:** `apps/storefront/src/routes/apiAccount.ts:82` adds `?? customer.user.loginUsername` before the
  Telegram-id fallback.
- **Impact:** Web-only accounts get a real, human display name on `/account`.

### STO-003 — Invisible focus ring on the dark hero band
- **Before:** The shared `:focus-visible` ring is tuned for light `bg-paper`/`bg-card` surfaces; on the hero's
  `bg-ink` and the "Our Promise" section's `bg-pine`, the same ring was effectively invisible to keyboard users.
- **After:** A `.focus-on-dark:focus-visible` override (`apps/storefront/client/src/index.css`) draws a
  90%-opacity white ring; applied to the hero's two CTAs.
- **Impact:** Keyboard-only visitors can now see where focus is on the highest-visibility part of the page.

### STO-004 — Language switcher unreachable on mobile
- **Before:** The switcher was `hidden sm:flex` with no mobile equivalent — mobile visitors had no way to
  change language at all.
- **After:** Folded into the existing mobile search row (`Layout.tsx:115-131`) as a compact globe-icon link.
- **Impact:** Restores a previously-inaccessible piece of functionality for the majority (mobile) of visitors.

## Batch 3 — Checkout/cart friction

### STO-005 — Voucher error rendered a column away from the voucher input
- **Before:** A failed voucher code's error text rendered inside `#checkout-summary`, visually separated from
  the input that caused it (a full column gutter away on desktop).
- **After:** The error now renders directly under the voucher input (`CheckoutPage.tsx`), with
  `aria-invalid`/`aria-describedby` wiring it to the field for screen readers.
- **Impact:** Cause and effect are adjacent; the error is also now programmatically associated with its field.

### STO-008 — No way back to the catalog from the cart
- **Before:** `CartPage.tsx` offered only "Continue to payment" — no path back to browsing without using
  browser Back.
- **After:** Added a "Continue shopping" link to `/`.
- **Impact:** Removes a dead end in the cart → checkout funnel.

### STO-009 — Checkout login prompt named Telegram specifically
- **Before:** `web.login_to_checkout` read "You'll sign in with Telegram at checkout…", inaccurate for
  password/email accounts (the storefront also supports username/email+password sign-in).
- **After:** Reworded to "Sign in to continue — your cart comes along." in both `en.json`/`id.json`.
- **Impact:** Copy no longer misdescribes the sign-in options actually available.

### STO-010 — Repeated manual_with_info fields across multiple units
- **Before:** Buying N units of a manual_with_info product meant retyping the same per-unit fields (e.g.
  email) N times, even when buying multiple for yourself.
- **After:** A "Copy to all units" action on Unit 1 copies its answers into every other unit.
- **Impact:** Cuts repetitive typing on the highest-friction step of a multi-unit manual purchase.

### STO-012 — "Contact support" was plain text, not a link
- **Before:** The no-payment-methods empty state said "...or contact support" with no way to act on it.
- **After:** Wrapped in a `Link` to `/account/support`.
- **Impact:** A dead-end empty state now has a working forward action.

## Batch 4 — Homepage resilience

### STO-006 — Reveal-on-scroll sections could stay permanently invisible
- **Before:** Sections used `IntersectionObserver` + a CSS `.reveal` class with no fallback; a screenshot
  tool, non-scrolling crawler, or slow/erroring JS could leave 5 of 7 homepage sections at `opacity: 0`
  forever.
- **After:** A 2-second timeout (`HomePage.tsx`) force-reveals every `.reveal` section regardless of whether
  an intersection ever fired.
- **Impact:** No code path can leave homepage content invisible indefinitely.

### STO-018 — Single-product grid left two-thirds of the row empty
- **Before:** A 1-product catalog (or 1-product category/search result) still rendered in a 3-column grid,
  reading as visually broken rather than a deliberate one-item shelf.
- **After:** Grids clamp to a capped-width single column when `products.length === 1` (Home/Category/Search).
- **Impact:** A small catalog no longer looks broken on its own storefront.

## Batch 5 — Product listing & detail scaffolding

### STO-007 — No sort on Category/Search
- **Before:** Category and Search always rendered in one fixed server order (name-asc for search,
  sortOrder-asc for category) with no way to reorder.
- **After:** A shared `SortSelect` dropdown (Featured / Price: low to high / Newest / Top rated) on both pages,
  backed by a new `?sort=` query param (`apps/storefront/src/cards.ts`'s `sortProductCards`, wired through
  `pageData.ts` and `routes/apiPages.ts`). Only shown once a grid has more than one product. Filters and
  pagination were explicitly deferred per the plan ("as the catalog grows past a screenful") — not implemented,
  since the current catalog doesn't yet need them.
- **Impact:** Gives visitors control over listing order now; the `?sort=` param is the seam filters/pagination
  will attach to later.

### STO-011 — No description, gallery, or related products on product detail
- **Before:** `ProductPage.tsx` rendered only the image, plan picker, price/qty/CTA, and reviews — no
  description block ever appeared in practice (the audit's fixture data had a null description, masking that
  the conditional render already existed), and there was no cross-sell path back into the catalog.
- **After:** Added a same-category "You might also like" shelf (`related_products`, capped at 4, current
  product excluded — `apps/storefront/src/pageData.ts`), reusing the existing `ProductCard`. The
  description block was already implemented and needed no change. **Multi-image gallery was not implemented** —
  the `Product` schema only has a single `webImageUrl` field; adding a gallery needs a new DB table/migration,
  which is backend feature work outside a UI/UX polish pass. Flagged for a future, explicitly-scoped change.
- **Impact:** Product detail now has a discovery path back into the catalog instead of being a dead end after
  "no thanks."

## Batch 6 — Design-system primitives

### STO-015 — No show/hide toggle on password fields
- **Before:** Login/Register/Settings password inputs were plain `type="password"` with no way to verify what
  was typed before submitting.
- **After:** Shared `PasswordInput` component (eye-icon toggle) applied to all three pages.
- **Impact:** Reduces failed-login/failed-signup friction from silent typos.

### STO-020 — No confirmation when a support ticket is created
- **Before:** Submitting a support ticket gave no success feedback — the form just cleared.
- **After:** Shared `Toast` component; `POST /api/v1/account/support` now returns the new `ticket_id`, and the
  client shows a "Ticket #N created" toast on success.
- **Impact:** Closes the loop on a support submission the customer previously had to just trust worked.

### Skeleton-loading primitive (unblocks STO-013/STO-016 cheaply, reduces future cost)
- **Before:** Home/Category/Search/Account all rendered nothing (`if (!data) return null`) until their query
  resolved — reads as a blank/broken page on a slow connection.
- **After:** Shared `Skeleton`/`ProductCardSkeleton` components; wired into Home, Category, Search, and Account
  as a layout-shaped pulsing placeholder (`aria-busy`/`aria-label="Loading…"`).
- **Impact:** A slow-loading storefront now visibly signals "loading," not "broken."

## Batch 7 — Polish

### STO-013 — Telegram widget's raw domain-invalid error broke page styling
- **Before:** When the deployed origin isn't registered via BotFather's `/setdomain`, Telegram's own widget
  script renders raw, unstyled error text (e.g. "Bot domain invalid") directly into the page — no callback or
  error event fires, so there was no way to catch and style it.
- **After:** New `useTelegramWidget` hook (shared by Login/Settings) starts a timeout after injecting the
  widget script; if no `<iframe>` appears within it (the only available success signal), the container is
  hidden and a styled fallback message renders instead — pointing to "contact support" on Settings, to the
  password form on Login.
- **Impact:** A misconfigured Telegram domain now degrades gracefully instead of leaking raw script output
  into the page.

### STO-014 — Username helper text said "lowercase" but the field accepted uppercase
- **Before:** Register/Settings username fields had `pattern="[a-zA-Z0-9_]+"` (accepts uppercase) while the
  helper text said "lowercase letters, numbers, underscores" and the server's `LOGIN_USERNAME_RE`
  (`packages/db/src/crud/webauth.ts`) is `^[a-z0-9_]{3,32}$` (lowercase-only) — a user typing an uppercase
  username passed client-side validation, then got a 400 from the server.
- **After:** Tightened both patterns to `[a-z0-9_]+`, matching the server and the (correct) helper text.
- **Impact:** Removes a client/server validation mismatch that could surface as a confusing late-stage 400.

### STO-016 — Orders/Reviews empty states were dead ends
- **Before:** "No orders yet" / "You haven't reviewed anything yet." offered no forward action.
- **After:** Both add a "Continue shopping" link to `/`.
- **Impact:** First-time visitors to these pages get a path back into the catalog instead of a dead end.

### STO-017 — Search page `<title>` never echoed the query
- **Before:** `/search?q=netflix`'s `<title>` always showed the generic "Search products…" placeholder,
  regardless of the query — didn't match the in-page `<h1>` ("Results for \"netflix\"").
- **After:** `apps/storefront/src/routes/spaShell.ts` now parses `?q=` and renders the same
  `web.search_results` copy in `<title>` when present.
- **Impact:** Browser tabs/history and search-engine snippets for `/search` now reflect the actual query.

### STO-019 — Referral commission balance lives only in the bot — **not implemented (scope decision)**
- **Before/after:** Unchanged. The finding itself flagged this as a "product-scope decision," not a bug —
  `/account/referral`'s API (`ReferralData`) only carries `referral_code`/`referral_link`; no commission-balance
  field exists anywhere in the backend. Surfacing a number here would mean adding new backend data (a
  commission-balance query/field), which is feature work, not UI/UX polish, and out of scope for this pass per
  the audit brief (preserve business logic; improve usability of what exists). Left for a deliberate, separately
  -scoped product decision.

## Verification

- `pnpm typecheck` (repo-wide, `pnpm -r typecheck` + `tsc -p tsconfig.test.json`): clean.
- `pnpm test` (repo-wide): 2052/2055 passing. The 3 failures are pre-existing, in
  `apps/web-admin/client/src/lib/additionalFields.test.ts` — unrelated to the storefront audit (uncommitted
  web-admin work-in-progress that predates this task; not touched here).
- Storefront-scoped tests (`apps/storefront/**`): 395/395 passing across 40 files, including new coverage added
  for every fix above (skeleton loading states, sort dropdown wiring, Telegram-widget fallback, related
  products, username pattern, empty-state CTAs, search-title interpolation).
- `pnpm --filter @app/storefront-client build`: rebuilt clean after every client-side batch.
- Nothing in this pass was committed — all changes remain in the working tree per standing instructions.
