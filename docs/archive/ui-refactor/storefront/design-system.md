# Design System / Component Consistency

Per this repo's CLAUDE.md constraint, branding/colors/typography/component library are treated as fixed —
this document flags *consistency* gaps within the existing system, not redesign recommendations.

## Buttons

Consistent primary/soft/ghost button styles observed throughout (`btn btn-primary`, `btn btn-soft`,
`btn btn-ghost` classes recur identically across Home, Product, Cart, Checkout, Account). No inconsistent
one-off button styling was found. **Gap:** focus-visible styling is not consistently legible across all
background contexts — see STO-003; this is a design-system-level fix (an "on dark surface" focus variant),
not a one-page patch.

## Cards

The `card`/`card-pad` class pair is used uniformly for every panel (product cards, account stat tiles,
checkout sections, settings panels) — good consistency. One exception: the "Coming soon" teaser cards on the
homepage use a visually similar card treatment to real clickable product cards but are intentionally
non-interactive; recommend a subtly distinct treatment (e.g. dashed border or reduced-opacity icon) so they
read as "not yet available" at a glance rather than only via the "Coming soon" text badge.

## Inputs

All text/email/password inputs share the same `field` class and consistent label-above-input layout across
Register, Login, Settings, Checkout, and Support. **Gap (STO-015):** no shared `PasswordInput` variant with
a show/hide toggle exists — worth adding to the shared component set once, rather than patching each page.

## Badges

`StockBadge` (green "In stock" / amber "N left" / red "Out of stock") is used consistently across
ProductCard and ProductPage — the only issue is *logical*, not visual (STO-001): the same well-designed
badge component is fed incorrect input data for non-auto-delivery products. The bulk-discount badge
(`-X%`, rust background) and the "Instant delivery" badge (dark overlay + lightning icon) are both used
consistently on every product card.

## Accordions

The FAQ accordion (native `<details>`/custom toggle pattern, confirmed working via click-test) is the only
accordion pattern in the crawled surface — consistent, no other accordion implementation to compare against.

## Alerts / Flash messages

A single shared `Flash` component (`kind="error"` / `kind="info"`) is reused across Login and Register for
top-of-form messaging — good reuse. The checkout voucher error and the "no payment methods" empty state use
a different, ad-hoc pattern (a bordered/tinted box with an icon) rather than the shared `Flash` component —
worth consolidating onto one shared alert component so error styling doesn't drift between pages over time.

## Toasts

No toast/snackbar component was observed being used anywhere in the crawl (support ticket creation and
add-to-cart both rely on a page transition or a silently-updated list instead of a toast — STO-020). If a
toast primitive doesn't exist yet in the shared component set, this is a good time to introduce one, since
several findings (STO-020, and optionally add-to-cart confirmation) would benefit from the same primitive.

## Skeleton loading

No skeleton-loading component exists anywhere in the app (see `performance.md`) — recommend adding one
shared skeleton primitive (e.g. a pulsing block matching card dimensions) rather than a bespoke one per page.

## Modals / Drawers

None were found anywhere in the crawled storefront surface (no modal dialogs, no slide-out drawers) — cart
and account actions all use full page navigation instead. This is consistent, if minimal; not a defect, just
noted for completeness since the audit brief asks about modal/drawer consistency specifically.

## Recommendation summary

1. Add an "on dark surface" focus-ring variant to the shared button/link focus styles (fixes STO-003 at the
   system level, not just the hero).
2. Add two new shared primitives the system currently lacks entirely: a toast/snackbar, and a skeleton
   loader — several independent findings (STO-020, performance.md) would each get cheaper once these exist.
3. Consolidate the ad-hoc voucher-error/empty-state alert styling onto the existing `Flash` component.
4. Add a shared `PasswordInput` variant (STO-015).
