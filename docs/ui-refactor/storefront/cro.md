# Conversion Rate Optimization (CRO)

## Direct conversion blockers

- **STO-001 (Critical):** the single biggest CRO issue found in this audit. Every listing surface (home,
  category, search) tells visitors the only product in the store is "Out of stock", when it is in fact
  purchasable. Any visitor who trusts that badge and doesn't click through never discovers the product is
  actually buyable. This is worth fixing before any other CRO work — it caps conversion at whatever fraction
  of visitors click through despite the badge.
- **STO-004 (High):** mobile visitors who prefer the "other" language have zero way to switch — for a
  bilingual (EN/ID) storefront, this is a silent conversion loss for a meaningful chunk of mobile traffic
  with no workaround.

## CTA placement and clarity

- Hero primary/secondary CTA hierarchy is good (solid "Browse products" vs. outlined "Contact support").
- Product-detail CTA hierarchy is good (solid "Buy now" vs. soft "Add to cart") — correctly nudges toward
  the faster path for a digital good with no real cart-building behavior expected.
- **Sticky mobile purchase bar:** not currently present (`screenshots/product-detail-mobile.png`). Low
  priority today given the page is short, but recommended before adding the description/gallery/related-
  products content in STO-011 — once the page is longer, losing the buy button off-screen while reading
  reviews/description is a real drop-off point.

## Trust and social proof

- Trust chips (Instant delivery / QRIS & USDT / Warranty included / 24/7 support) appear in the hero and
  repeated in a dedicated feature-card section — solid, non-redundant reinforcement.
- Reviews are handled honestly: "No reviews yet" shown plainly rather than faked, and the homepage
  testimonials section is code-gated to only render when real ≥4★ reviews with comments exist. This is the
  right call ethically and legally, but it does mean the storefront currently has zero visible social proof
  anywhere — worth flagging as a business risk (not a UI bug) to prioritize collecting/displaying real
  reviews once orders start flowing.
- No urgency indicators (e.g. "3 left", "12 sold today") are shown anywhere — reasonable given honesty is
  clearly a design value here (see the "Our Promise" section's explicit "Not customer-count promises" copy),
  so introducing fabricated urgency would conflict with the existing brand voice. Not recommended unless
  backed by real data (e.g. a genuine low-stock count for actual auto-delivery products).

## Checkout friction affecting conversion

- **STO-010 (Medium):** repeated per-unit fields for multi-quantity purchases add avoidable friction at the
  exact moment a customer is about to pay.
- **STO-005 (Medium):** a voucher error that appears to "do nothing" (because it renders far from the input)
  risks customers assuming discount codes don't work and abandoning rather than retrying/proceeding without
  one.
- **STO-012 (Low):** the payment-methods-unavailable empty state's "contact support" isn't clickable — a
  customer blocked here has no one-click way to reach out.

## Cross-sell / upsell

- **STO-011 (Medium):** no related-products/cross-sell section exists on the product page at all. With only
  one product today there's nothing to cross-sell to, but the two "Coming up" teaser cards (Social Media
  Services, Game Top-Up) on the homepage are a reasonable stand-in for future-category upsell awareness in
  the meantime.

## Exit points

- Cart has no "Continue shopping" link (STO-008) — every exit from the cart other than checking out goes
  through the header, a small but real bit of added friction for a customer who wants to add one more item.
- 404 and search-empty states both correctly funnel back to Home with a clear single CTA — no dead ends
  found in the crawled surface.

## Recommendation summary (priority order)

1. STO-001 — fix the false out-of-stock signal (highest-leverage single fix in this whole audit).
2. STO-004 — restore mobile language switching.
3. STO-005, STO-010, STO-008, STO-012 — checkout/cart friction reductions, bundled as a single pass since
   they're all in the same two files.
4. Plan for a sticky mobile buy bar and a related-products section ahead of catalog/content growth.
