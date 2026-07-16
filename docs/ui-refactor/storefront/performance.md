# Performance UX Findings

This audit did not run Lighthouse/Web Vitals tooling; findings below are perceived-performance observations
from Playwright network/console inspection and manual interaction.

## Lazy loading

`ProductCard.tsx` sets `loading="lazy"` and `decoding="async"` on every product image — correct practice,
confirmed by source read. No eagerly-loaded below-fold images were found.

## Image optimization

The one live product image is served directly from `images.unsplash.com` with query-string sizing
(`?w=800&q=80&auto=format&fit=crop`) — reasonable for a placeholder/demo asset, but worth revisiting once
real product photography is uploaded: confirm the production image pipeline serves appropriately-sized,
modern-format (WebP/AVIF) images rather than relying on a third-party CDN's on-the-fly params indefinitely.

## Layout shift

No visible layout shift was observed while images loaded during this audit's crawl (product images have a
fixed-height container — `h-44` on cards, a fixed aspect area on the product detail page). No CLS concerns
found.

## Skeleton loading

No skeleton loaders were observed anywhere in the crawl — pages that fetch data client-side (Home, Category,
Search, Product, Account, Orders, etc.) all use TanStack Query and appear to render `null`/nothing until
data resolves (e.g. `HomePage.tsx`: `if (!data) return null;`), rather than a placeholder skeleton. On the
fast local environment used for this audit, loads were near-instant so this wasn't visually jarring, but on
a slower connection this would present as a blank content area rather than a loading indicator — worth
adding basic skeleton states for the primary data-driven pages (Home, Category, Product, Account) as a
perceived-performance improvement, especially since the audit brief explicitly calls out "skeleton loading"
as an evaluation category.

## Loading indicators

Button-level loading states are handled well and consistently: Login/Register/Checkout submit buttons show
an inline spinner and become `disabled` while their mutation is pending (a shared `Spinner` component +
`data-submit-once`-style guard, confirmed in `LoginPage.tsx`/`RegisterPage.tsx`/`CheckoutPage.tsx` source).
This is a real strength — no double-submit risk was found anywhere tested.

## Interaction latency

All interactions tested against the local instance (add to cart, quantity update, voucher apply, ticket
creation, FAQ accordion) responded immediately with no perceptible lag — expected for a local environment,
not meaningful evidence about production latency under real network conditions.

## The reveal-on-scroll mechanism as a perceived-performance concern

Related to **STO-006** (documented fully in `homepage.md`/`findings.md`): the homepage's opacity-0 sections
mean that, on a slow connection where the JS bundle takes longer to parse/execute, a visitor could see the
hero render (server-sent HTML shell) followed by a visibly blank gap below it for longer than on a fast
connection, before the `IntersectionObserver` attaches and sections begin fading in as the visitor scrolls.
This compounds a genuinely slow load with an additional, avoidable "is the rest of the page broken?"
moment. Recommend pairing any fix here with the skeleton-loading recommendation above.

## Recommendation summary

1. Add basic skeleton placeholders to Home/Category/Product/Account while their initial query is pending —
   currently these render nothing until data resolves.
2. Add the STO-006 reveal-mechanism safety net (timeout-based fallback) so a slow JS load never compounds
   with a "sections stay invisible" moment.
3. Revisit the image pipeline (real photography, modern formats, self-hosted vs. third-party CDN) ahead of
   catalog growth — not urgent with a single demo image today.
4. Run a proper Lighthouse/Web Vitals pass once real hosting/network conditions are available — this audit's
   local-environment numbers aren't representative of production performance.
