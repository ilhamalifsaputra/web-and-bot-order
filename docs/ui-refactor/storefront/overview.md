# Storefront UI/UX Audit — Overview

## Scope

This audit covers the customer-facing storefront React SPA (`apps/storefront/client`, served behind
Fastify at `http://127.0.0.1:8100`) against the workflow and checklist in `auditUI.md`. It is audit and
documentation only — no source files under `apps/storefront` were modified.

## What was tested

- Full crawl of every route in the known page inventory (Home, Category, Search, Product, Cart, Checkout,
  Login, Register, Forgot password, Account, Orders, Referral, Reviews, Support + ticket detail, Settings,
  404) plus organic link-following (footer, FAQ accordion, hero anchors, category cards).
- A brand-new throwaway account (`audit_tester01`) was registered through the UI's password-based
  register flow (no Telegram/OTP required) to exercise every authenticated journey: Account, Orders,
  Referral, Reviews, Support (created and viewed a real ticket), Settings, and Checkout.
- Full customer journey: Landing -> Browse -> Search -> Product -> Add to cart -> Cart edits (qty
  update, quantity recalculation) -> sign-in gate -> Checkout (order-detail fields, voucher apply/error,
  payment-method step). Checkout could not be driven past payment-method selection because no payment
  gateway is configured in this environment (see Environment note below) — this matches the audit brief's
  instruction to stop at "picking a payment method."
- Four viewports: Desktop (1440x900), Laptop (1280x800, spot-check), Tablet (768x1024), Mobile (375x812).
- Keyboard navigation (Tab order, focus-visible contrast) and a source cross-check of every finding against
  the actual React components / Fastify routes responsible, so each item below has a precise file reference
  rather than a guess.

## Catalog state at time of audit

The live SQLite-backed catalog currently has exactly one active category ("Premium Apps") and one active
product ("Capcut Pro 1 Month", two denominations, both non-auto delivery). This is realistic pre-launch data,
not an empty database, and several findings below were only discoverable because of how this specific,
real configuration renders (e.g. STO-001's stock-badge bug only shows up because the one live product
happens to use manual delivery).

## Headline findings by severity

| Severity | Count |
|---|---|
| Critical | 1 |
| High | 3 |
| Medium | 7 |
| Low | 9 |
| **Total** | **20** |

Full detail for every item, with screenshots and file/line references, is provided as text in this audit's
final report (see the accompanying findings write-up); IDs (`STO-001`..`STO-020`) are consistent across
`report.json` and `implementation-plan.md`.

## Most important issues

1. **STO-001 (Critical)** — the storefront's own "Out of stock" badge misrepresents its only live product
   as unavailable on every listing surface (home/category/search), even though the product page happily
   sells it. This is a direct, confirmed conversion blocker.
2. **STO-002 (High)** — password-registered customers (an increasing share, given Telegram is optional) see
   a blank "Signed in as" name on `/account` — a one-line backend fix.
3. **STO-003 (High)** — keyboard focus is effectively invisible on the homepage's primary CTAs (WCAG 2.4.11).
4. **STO-004 (High)** — the language switcher is entirely unreachable on mobile viewports.
5. **STO-005 (Medium)** — the checkout voucher error renders far from its input on desktop, a inline-error
   placement bug that only "works" by accident on the mobile stacked layout.

## Environment note (not a UI defect)

No payment methods are configured in this instance, so "Place order & pay" stays disabled at the final
checkout step for every account — this blocked verifying the Payment and Confirmation legs of the customer
journey. It is an environment/config limitation, not a code defect, and is called out inline in
`customer-journey.md` and `checkout.md`.

## Deliverables

All files below live under `docs/ui-refactor/storefront/`:

- `overview.md` (this file)
- `findings.md` — every issue (ID, severity, page, screenshot, current/expected behavior, recommendation,
  implementation notes)
- `customer-journey.md`, `navigation.md`, `homepage.md`, `product-pages.md`, `checkout.md`, `ux.md`,
  `cro.md`, `responsive.md`, `accessibility.md`, `performance.md`, `design-system.md`
- `implementation-plan.md` — prioritized, grouped fix plan referencing finding IDs
- `report.json` — machine-readable findings
- `screenshots/` — 26 captured screenshots across viewports and states
