# Responsive Findings

Tested at Desktop (1440x900), Laptop (1280x800, spot-check), Tablet (768x1024), and Mobile (375x812).

## Navbar

- Desktop/Tablet (≥640px): logo, inline search box, Language / Account / Cart all visible in one row —
  confirmed clean at both 1440 and 768 widths (`screenshots/homepage-tablet.png`).
- Mobile (<640px): search box demotes to its own full-width row below a slimmer header (logo + Account icon
  + Cart icon only) — a sound, standard mobile header pattern.
- **STO-004 (High):** the Language switcher is dropped entirely below 640px rather than collapsing into an
  icon — this is the one real responsive regression found in the header, and it isn't just visual, it's a
  full loss of functionality on mobile.

## Hero

Scales cleanly across all four viewports — headline wraps sensibly, CTA buttons stay full-height/tappable,
trust-chip row wraps to two lines on mobile without overlapping (verified in
`screenshots/homepage-mobile.png`).

## Product grid

- Desktop: up to 3 columns (`lg:grid-cols-3`); Tablet: 2 columns; Mobile: 1 column implied by the same
  Tailwind classes — not directly screenshotted with more than one product in the grid, but the class
  structure (`sm:grid-cols-2 lg:grid-cols-3`) is standard and should be sound once more products exist.
- **STO-018 (Low):** with a single product, the grid still reserves its full column count at every
  breakpoint ≥640px, leaving visible empty space (see `homepage.md`).

## Checkout

Two-column desktop layout (Order details/Payment/Voucher on the left, Summary on the right) correctly
collapses to a single stacked column on mobile with no overlap, no horizontal scroll, and full-width tappable
inputs (`screenshots/checkout-voucher-error-mobile.png`).

- **STO-005 (Medium):** the voucher error's placement bug is specifically a desktop/laptop 2-column problem
  — it happens to read correctly on mobile purely because the stacked layout puts the error block right
  after the input in document order. Do not let a mobile-only regression test hide this bug going forward.

## Forms

Register/Login/Settings forms render as comfortable full-width single-column stacks at every viewport
tested — no cramped/overlapping fields found on mobile.

## Tables

The only tables in the crawled surface are the empty-state tables on My Orders and Help & Support
(`screenshots/orders-empty-desktop.png`). Both render as simple, single-row "no data" tables that don't yet
need horizontal-scroll handling — revisit once real order/ticket rows exist with several columns of data at
375px width, since a 5-column table (Order code / Items / Total / Status / Date) is a common candidate for
mobile overflow or the need to switch to a card-per-row layout below a certain breakpoint.

## Footer

Minimal footer reflows correctly from a horizontal row (logo left, tagline right) on desktop to a stacked,
centered layout on mobile — confirmed in `screenshots/homepage-mobile.png`.

## Summary

Only one genuine responsive defect was found (STO-004, language switcher). Every other responsively-tested
surface (navbar, hero, checkout, forms, footer) degrades gracefully across all four viewports. The
product-grid and orders/support table concerns are forward-looking watch items rather than currently broken
today, given the catalog/order-history size at time of audit.
