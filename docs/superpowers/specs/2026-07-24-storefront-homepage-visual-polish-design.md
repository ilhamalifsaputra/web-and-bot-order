# Storefront homepage — visual polish design

**Status:** approved, ready for implementation planning
**Scope:** `apps/storefront/client/src/pages/HomePage.tsx`, `HomePage.css`, `apps/storefront/client/src/lib/motion.ts` only. No other page.

## Goal

Elevate the storefront homepage's visual quality — depth, hierarchy, premium feel —
without changing the design system, brand identity, primary color, or component
library. This is a polish pass, not a redesign. Every value used must already exist
as a token in `apps/storefront/client/src/index.css`'s `@theme` block (`pine`,
`pine-dark`, `pine-tint`, `grass`, `grass-dark`, `grass-tint`, `amberx`, `rust`,
`ink`, `ink-soft`, `ink-faint`, `sand`, `line`, `card`, `paper`, `shadow-soft`,
`shadow-lift`, `radius-xl2`).

## Current state (baseline)

The hero is a flat `bg-linear-to-br from-ink via-pine-dark to-pine` panel (or, when
`hero_image` is set, an image with a dark overlay) with one `pine/20 blur-3xl`
glow circle top-right. Content is capped at `max-w-2xl`, leaving the right ~40% of
a wide viewport visually empty. Below the fold: 4 static feature cards, a numbered
step timeline, category cards, featured-product cards, 2 "coming soon" teaser
cards, a solid-`pine` "Our Promise" stat band, a trust checklist card, testimonials
(conditionally rendered), an FAQ accordion, and 3 contact cards. Sections reveal on
scroll via `.reveal`/`IntersectionObserver` with a 2s fallback timeout (STO-006,
already fixed, untouched by this spec).

Reference audit: `docs/ui-refactor/storefront/homepage.md`,
`docs/ui-refactor/storefront/design-system.md` (colors/branding/component library
"treated as fixed" per this repo's CLAUDE.md).

## A. Hero background — layered depth, no new colors

Replace the single flat gradient with layered depth, all built from existing tokens:

1. **Base gradient**: rebalance stops to weight `ink` more and saturated `pine`
   less — `from-ink via-ink to-pine-dark` (image-present variant keeps its overlay
   but shifts the same direction: `from-ink/95 via-ink/90 to-pine-dark/80`).
2. **Radial glows**: keep the existing top-right `pine/20 blur-3xl` circle; add a
   second, smaller, lower-opacity `grass/10 blur-3xl` glow bottom-left. Both purely
   decorative, `aria-hidden`, `pointer-events-none`.
3. **Texture**: reuse the `.dot-grid` pattern already defined in `HomePage.css`
   (currently applied only to the retired stats band) at low opacity (`opacity-[0.07]`
   or similar) as a full-bleed overlay inside the hero.
4. **Vignette**: a subtle radial `inset-0` overlay (`black/0` center to `black/15`
   corners) via an absolutely positioned div, to pull focus toward the center.

Layer order (back to front): base gradient → radial glows → dot-grid texture →
vignette → existing content.

## B. Hero right side — real product composition

Fill the empty right side with 2–3 floating glass cards sourced from `data.products`
(the same array already fetched for the Featured Products section — no new API call).

- Each card shows `p.image` (small thumbnail), `p.name` (truncated), and
  `p.from_price` (via the existing `Price` component for correct formatting).
- Visual treatment: `bg-white/10 backdrop-blur-md border border-white/15
  shadow-lift rounded-2xl` — same frosted family as the existing hero trust badge
  (`bg-white/5 border-white/15`), just elevated to card weight.
- Layout: absolutely positioned within the hero, `hidden lg:block` (tablet/mobile
  hero is unchanged — single column, no cramping). Cards are loosely staggered
  (slight CSS `rotate`/`translate` offsets, not a grid) to read as a casual stack.
- Entrance animation: existing `staggerContainer`/`staggerItem` framer-motion
  variants from `lib/motion.ts` (already used elsewhere in the app) — no new
  animation primitives.
- Data-dependent: if `data.products.length < 2`, render fewer cards or omit the
  composition entirely. Never fabricate a placeholder product.
- Each card links to `/p/${slug}` (same destination as the real product card),
  since it depicts a real product — this makes it a functional shortcut, not pure
  decoration.

## C. CTA hierarchy

- Primary CTA (`Browse products`): add `hover:shadow-lift` (existing token,
  currently unused on this button) and the new `hoverLift` motion variant (see
  §D). No color or size change.
- Secondary CTA (`Contact support`, outline): strengthen hover fill from
  `hover:bg-white/10` to `hover:bg-white/15` for clearer secondary-vs-primary
  contrast. No structural change.

## D. Below-the-fold card depth — interactive vs. decorative split

Adding hover affordance to a non-clickable element is a false-affordance bug, not
polish, so treatment depends on whether the card is a link:

- **Interactive cards** (category cards, product cards, contact cards — all
  already `<Link>`/`<a>`): standardize hover depth on the `hoverLift` variant +
  `shadow-soft → shadow-lift` transition. Category/contact cards currently use an
  ad-hoc `hover:shadow-md`; align them to `shadow-lift` so every "liftable" card in
  the page shares one depth language.
- **Non-interactive cards** (the 4 "why shop with us" feature cards, the "Our
  Promise" band's 4 stat items, the trust-checklist card): **no hover effect
  added.** They stay static (`shadow-xs`), since they're informational, not links.
- **"Coming soon" teaser cards** (2 cards, social media / game top-up): give them
  a visually distinct non-interactive treatment — dashed border
  (`border-dashed`) and reduced-opacity icon well — so they read as "not yet
  available" without depending solely on the text badge. This closes an existing,
  already-flagged gap in `docs/ui-refactor/storefront/design-system.md` ("Cards"
  section).

## E. Color balance

No new hues are introduced anywhere in this spec. The rebalancing happens
primarily in the hero (§A), which is where flat `pine` currently dominates most
visibly. Below-the-fold sections already use `grass`/`amberx`/`rust` sparingly and
correctly (feature-card icon wells, badges) — left as-is.

## F. Motion additions

One new export in `apps/storefront/client/src/lib/motion.ts`:

```ts
export const hoverLift = {
  whileHover: { y: -2, transition: { duration: DURATION.fast, ease: EASE } },
};
```

Reused everywhere a lift is needed (§B floating cards, §C primary CTA, §D
interactive cards) instead of a per-component one-off. Everything else reuses
existing variants (`fadeUp`, `staggerContainer`/`staggerItem`, `pressable`). No new
easing curves, no bounce/spring physics, no scroll-jacking. The existing
`.reveal`/`IntersectionObserver` scroll-reveal system for below-fold sections is
untouched.

## Explicitly out of scope

- **No new color tokens** (purple for AI products, cyan for VPN products) — the
  homepage doesn't currently segment products by category in a way that needs
  them, and this repo's storefront colors are documented as fixed. Revisit only if
  a concrete category-badge feature is scoped later.
- **No typography scale changes** — existing `font-display`/`font-sans` sizes and
  weights stay exactly as-is; only spacing/hierarchy polish within the existing
  scale.
- **No changes outside `HomePage.tsx`/`HomePage.css`/`lib/motion.ts`** —
  Product/Cart/Checkout/Account pages, header, footer are untouched.
- **No noise-texture image asset or SVG filter** — the reused `.dot-grid` CSS
  pattern covers the "texture" need without a new asset.
- **No new shared component** — the hero product-preview cards are a one-off
  composition inline in `HomePage.tsx` (not reused elsewhere), consistent with how
  the rest of the hero is already built inline.
- **No real third-party brand logos/names** (Netflix, Adobe, CapCut, etc.) as
  decoration — §B uses only the shop's own real inventory, avoiding trademark risk
  and fabricated content.

## Testing

- `HomePage.test.tsx` already exists — extend/adjust for: the new hero product
  cards render only when `data.products.length >= 2` (or the reduced/absent case
  when fewer), and link to the correct product slug.
- Visual/manual check (per root CLAUDE.md UI rules): run the storefront dev
  server, view the homepage at desktop/tablet/mobile widths, confirm the hero
  composition only appears at `lg+`, confirm hover states only apply to actually
  interactive cards, confirm `prefers-reduced-motion` still holds (existing
  `.reveal` fallback is unaffected; framer-motion respects reduced-motion via its
  own defaults — verify `hoverLift`/stagger don't need an explicit guard).
- `pnpm typecheck` and `pnpm test` must stay green.
