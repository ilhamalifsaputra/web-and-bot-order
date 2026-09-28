# Implementation Plan

Prioritized by severity/impact, grouped so related fixes land together (shared files, shared components, or
shared cause). This plan covers documentation findings only — no code has been changed as part of this
audit; each batch below is scoped for a follow-up implementation pass.

## Batch 1 — Critical correctness fix (do first, alone)

**Resolves: STO-001**

- Extend the product-card stock signal to be delivery-type-aware, matching the product page's own
  `purchasable()` rule, so manual/manual_with_info products never show a false "Out of stock" badge on
  Home/Category/Search.
- Files: `apps/storefront/client/src/components/shop/StockBadge.tsx`,
  `apps/storefront/client/src/components/shop/ProductCard.tsx`, plus whichever server-side module builds
  `ProductCardData` under `apps/storefront/src/` (needs to start including delivery-type info per card).
- Why alone/first: single highest-impact issue found, touches a shared component used on every listing
  surface, and is currently live-misleading customers about the store's only product.
- Suggested test: extend `ProductCard.test.tsx`/`StockBadge.test.tsx` with a non-auto-delivery, zero-stock
  fixture and assert no red "Out of stock" badge renders.

## Batch 2 — High-severity access/trust fixes (small, independent, safe to parallelize)

**Resolves: STO-002, STO-003, STO-004**

1. **STO-002** — add `?? customer.user.loginUsername` to the name fallback in
   `apps/storefront/src/routes/apiAccount.ts:82`. One line; add a regression test for a password-only
   customer account.
2. **STO-003** — add an "on dark surface" focus-visible style for interactive elements on the hero/`bg-pine`
   band; audit both surfaces for the same fix (`apps/storefront/client/src/pages/HomePage.tsx`, plus
   whatever shared focus-ring utility is used app-wide).
3. **STO-004** — surface the language switcher on mobile: fold it into the existing `sm:hidden` mobile
   search row in `apps/storefront/client/src/components/Layout.tsx` (lines 84, 119).

These three are independent of each other and of Batch 1 — safe to implement and review in parallel.

## Batch 3 — Checkout/cart friction pass (one PR, same files)

**Resolves: STO-005, STO-008, STO-009, STO-010, STO-012**

All land in `apps/storefront/client/src/pages/CheckoutPage.tsx` /
`apps/storefront/client/src/pages/CartPage.tsx` / locale JSON — worth one combined pass since they touch the
same small set of files and the same customer moment (cart -> checkout):

1. **STO-005** — move the voucher-specific error out of `#checkout-summary` and into the same card as the
   voucher input (`CheckoutPage.tsx` lines ~433-466).
2. **STO-010** — add a "copy to all units" shortcut to the per-unit additional-fields block.
3. **STO-012** — link "contact support" in the no-payment-methods empty state to `/account/support`.
4. **STO-008** — add a "Continue shopping" link to `CartPage.tsx`.
5. **STO-009** — reword `web.login_to_checkout` in both `packages/core/locales/en.json:445` and
   `id.json:445` to not name Telegram specifically.

## Batch 4 — Homepage resilience (one PR)

**Resolves: STO-006, STO-018**

- Add a timeout-based fallback to the reveal-on-scroll `IntersectionObserver` in
  `apps/storefront/client/src/pages/HomePage.tsx`/`HomePage.css` so sections never stay permanently
  invisible outside of organic scrolling.
- While in this file, clamp/adjust the "Latest products" grid so a single item doesn't leave two-thirds of
  the row empty (STO-018) — same component, cheap to bundle.

## Batch 5 — Product listing & detail scaffolding (larger, plan ahead of catalog growth)

**Resolves: STO-007, STO-011**

- Add sort (cheapest/newest/rating) to `CategoryPage.tsx`/`SearchPage.tsx`, then filters/pagination as the
  catalog grows past a screenful (STO-007). Check backend API support for `sort`/`limit`/`offset` before
  scoping the frontend work.
- Add conditionally-rendered description/specs block, multi-image gallery, and a same-category
  related-products section to `ProductPage.tsx` (STO-011). Larger effort; can be sequenced after Batch 1-4.

## Batch 6 — Design-system primitives (unlocks several Low findings at once)

**Resolves: STO-015, STO-020, and reduces future cost of STO-013/STO-016**

- Add a shared `PasswordInput` component (show/hide toggle) — reuse across Login/Register/Settings
  (STO-015).
- Add a shared toast/snackbar primitive — apply to support-ticket creation success (STO-020) and consider
  for add-to-cart confirmation.
- Add a shared skeleton-loading primitive (see `performance.md`) — apply to Home/Category/Product/Account
  initial loads.
- These are infrastructure investments: once they exist, STO-013 (Telegram widget fallback), STO-016
  (empty-state CTA buttons), and any future toast/skeleton need become cheap follow-ups rather than new
  components each time.

## Batch 7 — Low-priority polish (bundle into a single cleanup PR)

**Resolves: STO-013, STO-014, STO-016, STO-017, STO-019**

1. **STO-013** — styled fallback around the Telegram widget when its domain check fails; verify BotFather
   `/setdomain` for every real deployment origin as an ops checklist item.
2. **STO-014** — align Register's username helper text with its actual `pattern` (or vice versa).
3. **STO-016** — add "Browse products" CTA buttons to the Orders/Reviews empty states.
4. **STO-017** — interpolate the `q` query param into the `/search` page title in
   `apps/storefront/src/routes/spaShell.ts:110-112`.
5. **STO-019** — product-scope decision: consider surfacing referral commission balance on `/account`
   alongside the existing wallet balances, instead of deferring entirely to the bot.

## Suggested sequencing

1. Batch 1 (Critical) — ship alone, verify live.
2. Batch 2 (High) — parallel, independent PRs.
3. Batch 3 (checkout/cart friction) — one combined PR.
4. Batch 4 (homepage resilience) — one PR.
5. Batch 6 (design-system primitives) — before or alongside Batch 5, since Batch 5's larger product-detail
   work will want the skeleton-loading primitive anyway.
6. Batch 5 (listing/detail scaffolding) — largest effort, plan against actual catalog-growth timeline.
7. Batch 7 (polish) — whenever convenient; lowest risk, lowest urgency.

Every batch above references only finding IDs already defined in `report.json`/the findings write-up — no
new issues are introduced by this plan. `pnpm typecheck` and `pnpm test` should stay green throughout per
this repo's CLAUDE.md; each batch should ship with its own test coverage (see per-batch notes above) before
merging.
