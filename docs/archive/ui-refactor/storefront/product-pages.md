# Product Listing and Product Detail

## Product listing (Category `/c/premium-apps`, Search `/search`)

Screenshot: `screenshots/category-desktop.png`, `screenshots/search-empty-desktop.png`

- **STO-001 (Critical):** the `StockBadge` shown on every card is wrong for non-auto-delivery products —
  see full writeup in the findings write-up. This is the single highest-impact issue in this whole audit
  because it is live, today, on the only product in the catalog.
- **STO-007 (Medium):** confirmed by source read — `CategoryPage.tsx` and `SearchPage.tsx` have no sort,
  filter, or pagination/infinite-scroll code at all. Fine at one product; a real gap once the catalog grows.
- **STO-018 (Low):** grid layout looks unfinished with a single item (see `homepage.md`).
- Cards otherwise do the right things: lazy-loaded images, "N options" variant-count hint, bulk-discount
  ribbon support (`-X%` badge, untested live since no product currently has a bulk discount configured), a
  rating/review-count line (conditionally hidden — correct — when `rating_count` is 0), and a consistent
  "from [price]" pattern.
- Search empty state is good: specific copy ("Nothing found — try another keyword.") + a "Back to home" CTA,
  matching the audit brief's guidance almost exactly (though "browse all products" would be marginally more
  useful than "home").
- **STO-017 (Low):** the browser tab title on `/search` never reflects the query (see findings write-up for
  the exact server-side line responsible).

## Product detail (`/p/capcut-pro-1-month`)

Screenshots: `screenshots/product-detail-desktop.png`, `screenshots/product-detail-mobile.png`

- Breadcrumb, plan selector (radio cards with live price), quantity stepper, and a clear two-tier CTA
  (soft "Add to cart" + solid "Buy now") are all present and functioning — this is a decent CTA hierarchy
  (Buy now is visually primary, matching the brief's "CTA hierarchy" ask).
- **STO-001 root cause lives here too:** the page's own `purchasable()` gate (delivery_type-aware) is
  *correct* — the bug is that the upstream listing cards do not share this logic. Nothing to fix on this
  page itself for that issue.
- **STO-011 (Medium):** no description/specs section, no multi-image gallery (single static hero image
  only, no thumbnails/zoom), no related/cross-sell products section — none of this scaffolding exists in
  `ProductPage.tsx` regardless of data. Currently invisible because this product's `description` is `null`,
  but worth building before the catalog needs it.
- Reviews section renders a clean, honest "No reviews yet." — no fabricated stars/counts.
- **Mobile (STO checklist "sticky purchase section"):** the Add to cart/Buy now controls sit inline in the
  page flow (`screenshots/product-detail-mobile.png`) with no sticky bottom bar. Not a problem for this
  product's short page, but once a description/gallery/reviews make the page longer, a sticky mobile buy bar
  becomes a real conversion lever — see `cro.md`.
- Both plans ("1 Month" / "1 month preorder") currently show identical pricing with no visible differentiator
  beyond the label — acceptable for now, but if preorder vs. immediate delivery ever differ in wait time,
  consider a short inline note under the radio (e.g. "ships within 24h") so the price-parity doesn't read as
  a duplicate option.

## Recommendation summary

1. **STO-001** is the priority — fix the shared stock-badge logic once, and it is fixed everywhere (home,
   category, search) simultaneously.
2. Build minimal description/gallery/related-products scaffolding (STO-011) ahead of catalog growth.
3. Add sort/filter/pagination to listings (STO-007) before the catalog outgrows a single screen.
