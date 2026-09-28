# Homepage

Screenshots: `screenshots/homepage-desktop.png`, `screenshots/homepage-tablet.png`,
`screenshots/homepage-mobile.png`, `screenshots/homepage-anchor-jump-produk.png`

## Hero

Strong, focused hero: trust-badge kicker, a benefit-led H1 ("Digital products, delivered instantly"), a
one-line value prop naming the actual payment methods (QRIS/USDT), a primary CTA ("Browse products") and a
secondary CTA ("Contact support"), plus four inline trust chips (Instant delivery / QRIS & USDT / Warranty
included / 24/7 support). This is a well-structured hero for the product — no changes recommended to its
content or hierarchy.

- **STO-003 (High):** keyboard focus on the hero's two CTA buttons is effectively invisible (blue-on-blue
  focus ring at 40% opacity) — see `screenshots/keyboard-focus-hero-cta2.png`. Fix the focus style for
  interactive elements on this dark/saturated background before anything else on this page.

## Sections below the fold

In document order: Why shop with us (4 feature cards) -> Categories -> Latest products -> Coming up
(2 static "coming soon" cards) -> Our Promise (stat band) -> Testimonials (conditionally rendered, hidden
today since there are no qualifying reviews yet) -> FAQ (5-item accordion, tested and working) -> Contact
(Telegram + support ticket links).

- **STO-006 (Medium):** every one of these sections is scroll-revealed (`opacity:0` until an
  IntersectionObserver fires). Confirmed via computed styles that 5 of 7 sections were still invisible
  immediately after page load. This is a working, intentional animation for real scrolling users (verified
  jumping straight to `#produk` via anchor link still reveals correctly), but it has no safety-net fallback
  beyond `prefers-reduced-motion`, so it fully blanks the page for screenshot/print/PDF tools and any
  crawler that does not scroll. See `performance.md` for the perceived-performance angle on this same
  mechanism.
- **STO-018 (Low):** "Latest products" uses a `sm:grid-cols-2 lg:grid-cols-3` grid; with the current single
  product, two-thirds of the row sits empty (see `screenshots/homepage-anchor-jump-produk.png`), reading as
  an unfinished section rather than a deliberate one-item shelf.
- The "Coming up" cards (Social Media Services, Game Top-Up) are correctly non-interactive (no href, no
  cursor-pointer) and clearly labelled "Coming soon" — good, on-brand practice for pre-launch feature
  teasers; no issue found here, just confirm their hover/shadow styling stays visually distinct from real
  clickable cards as more get added.
- FAQ accordion works correctly (tested clicking "Is there a warranty?" — expands in place, answer text
  correct, no layout jump).
- Testimonials section is conditionally hidden when there are no ≥4★ reviews with comments yet — a good
  practice (no fabricated social proof), confirmed by source comment in `HomePage.tsx` ("Section
  disembunyikan saat belum ada ulasan, supaya tidak ada testimoni karangan di halaman").

## Recommendation summary

1. Fix hero CTA focus contrast (STO-003) — highest priority on this page, accessibility-blocking.
2. Add a reveal-mechanism safety net (STO-006) so the page is never permanently blank to non-scrolling
   consumers of the page.
3. Low priority: clamp the "Latest products" grid to avoid the lopsided single-item layout (STO-018) as a
   quick polish item; naturally resolves as the catalog grows.
