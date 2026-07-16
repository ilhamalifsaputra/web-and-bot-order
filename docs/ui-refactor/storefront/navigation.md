# Navigation

## Header

`apps/storefront/client/src/components/Layout.tsx` renders a single, minimal header on every page: logo
(-> home), a search box, and a nav cluster of Language / Account (or Sign in) / Cart. This is appropriately
lean for a small, focused catalog — there is no risk of the "too many menus" problem the audit brief warns
about, because there simply isn't a mega-menu or deep category tree yet.

- **STO-004 (High):** the Language link is hidden below the `sm:` breakpoint (`hidden ... sm:flex`,
  `Layout.tsx:84`) with no alternate access point anywhere in the app. Every mobile visitor is stuck with
  whichever language the server picked. This is the single most impactful navigation issue found.
- The mobile header (confirmed in `screenshots/homepage-mobile.png`) shows only Account + Cart icons, with
  the search box demoted to its own full-width row below the header (`Layout.tsx:119`, `sm:hidden` block) —
  this is a reasonable mobile pattern and works fine; the language toggle should join it there.
- No hamburger/mobile menu exists — and none is needed yet given how few nav items exist. If more nav items
  are added later (a hamburger would be introduced then), keep the language switcher visible regardless of
  that future decision.

## Breadcrumbs

Product detail pages show a correct, working breadcrumb (Home / Category / Product,
`screenshots/product-detail-desktop.png`). Category pages do not need one beyond the H1 (single level deep).
No duplicate or confusing breadcrumb labels were found.

## Footer

Minimal footer: logo + tagline ("Instant delivery · QRIS & USDT payments"), no link columns (no legal
pages, no additional nav) were found during the crawl. This is consistent with the brief's "don't
over-navigate" principle — nothing to simplify here, but if legal/policy pages exist elsewhere they were
not discoverable from any crawled page, which is worth a product-level decision rather than a UI fix.

## Search as navigation

The header search box is present on every page and works correctly (tested "capcut" and a nonsense term —
see `customer-journey.md` step 3). No autocomplete/suggestions were observed while typing — evaluated
further in the dedicated search behavior notes in `ux.md`.

## Categories

Only one category exists live ("Premium Apps"); the homepage's "Find your service" section and the
"Browse by category" link both route correctly to it. Category depth is flat (no subcategories) — nothing to
simplify structurally, and the one-category state naturally avoids any of the "duplicate pages" or "hidden
navigation depth" failure modes the brief warns about — revisit this doc once the catalog has more than a
handful of categories to confirm the flat structure still holds up.

## Recommendation summary

1. Fix STO-004 first — it is the only real navigational access issue found (mobile language switching).
2. No other structural navigation changes are needed at the current catalog size; re-audit navigation once
   more categories/products exist, specifically watching for: whether "Find your service" needs to become a
   proper dropdown, and whether the flat one-level category structure still suffices.
