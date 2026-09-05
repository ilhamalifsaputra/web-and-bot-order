# Implementation deviations & design-system inconsistency log

Per FRONTEND_IMPLEMENTATION_PROMPT §26.1: when the implementation and the
design-system spec disagree, or when a recommended approach can't be followed
exactly, the deviation is recorded here **before** the code/spec change is made.

---

## A1 — Tailwind `@theme` block kept as a literal mirror, not `var()` forwards (Task 3, Part A)

**Context.** Task 3 single-sources every storefront design-token value into
`apps/storefront/client/src/styles/tokens.css` (`--gg-*` set + legacy short-name
aliases). The brief's recommended approach also rewrote the Tailwind v4
`@theme static` block in `apps/storefront/client/src/index.css` to reference
those values via `var()` (`--color-pine: var(--gg-pine)` etc.).

**Deviation.** The `@theme` block is **left as literal hex / font-stack /
box-shadow values**, exactly as before this task, now with a
`values mirror src/styles/tokens.css — keep in sync` note. The brief's own
fallback clause ("If `@tailwindcss/vite` … or the built CSS output changes vs.
baseline, revert only this block to literal values … and record the limitation
here. Try the `var()` version first.") — the `var()` version was tried first
and rejected on evidence.

**Why.** Tailwind v4 (4.3.1) does not *error* on `var()` in `@theme`, but it
only pre-resolves a token when it can read the literal value at build time.
With a `var()` value the built CSS changes in two ways that alter computed
style:

1. **Opacity-modified colour utilities lose their alpha.** Baseline emits
   `.bg-card\/90{background-color:#ffffffe6}` (pre-blended). With
   `--color-card: var(--gg-card)` Tailwind cannot compute the blend, so it
   drops the modifier — `.bg-card,.bg-card\/90{background-color:var(--color-card)}`
   renders `bg-card/90` fully opaque. Same for `bg-ink/5`, `bg-pine-tint/30`,
   `bg-amberx-tint/60`, `bg-grass/10`, `border-amberx/30`, `border-grass/30`,
   `border-grass/40`, `border-rust/30`, `border-rust/40` — all of which appear
   in the storefront's compiled CSS, i.e. are in use.
2. **`shadow-soft` / `shadow-lift` lose the `--tw-shadow-color` recolour
   channel** (`--tw-shadow:0 1px 2px var(--tw-shadow-color,#1018280a),…` →
   `--tw-shadow:var(--gg-shadow-soft)`). Bare computed value is unchanged and
   the storefront never recolours a shadow, but it is still a build-output
   change.

**Net effect on single-sourcing.** `tokens.css` is the single source for the
plain-CSS `app.css` component layer (its `:root` block was deleted; `.card` /
`.btn` / `.field` / `.chip` now read `--pine` / `--r-lg` / … as `var()`
forwards to `--gg-*`). The `@theme` block remains a second hand-maintained
copy of the ~23 colour/font/shadow values — unchanged from before the task,
but now explicitly labelled as a mirror with the canonical file named.
Eliminating that copy needs a Tailwind-side fix (or a build step that inlines
tokens.css into `@theme`) and is out of scope here.

**Files.** `apps/storefront/client/src/index.css` (`@theme` block + header
comment).

---

## A2 — literal `:root` token block retained in the build-free error shell (Task 3, Part A)

**Context.** `apps/storefront/static/app.css`'s `:root { --paper … }` token
block was removed (moved to `src/styles/tokens.css`). `app.css` is normally
pulled into the SPA bundle via `index.css`'s `@import`, so the tokens travel
with it.

**Deviation.** `apps/storefront/src/lib/spaFallback.ts`'s `staticFallbackHtml()`
— the hand-written last-resort page served only when the built `index.html`
can't be read (fresh clone before `pnpm build`, or a corrupt `dist`) — links
`/static/app.css` **standalone**, without the SPA bundle CSS. It therefore
never sees `src/styles/tokens.css`. A small literal `:root` block (the 25
legacy-name aliases, values copied from `tokens.css`) is now inlined as a
`<style>` in that shell's `<head>` so `.card` / `.btn` / `.wait-dot` keep
rendering there.

**Why not another option.** Serving `tokens.css` as a second static file would
re-introduce exactly the two-copies-kept-in-sync-by-comment drift this task
removes. The inline block is scoped to this one build-free shell, is the only
deliberate duplicate, and carries a keep-in-sync comment.

**Impact: none.** The normal SPA path and the normal error/404/503 shell path
(which read the built `index.html`) are unaffected; only the zero-build
last-resort page uses this inline block, and it renders exactly as before.

**Files.** `apps/storefront/src/lib/spaFallback.ts`.

---

## B1 — stale `font-size` `base` token in the design-system spec (Task 3, Part B)

Type: §26.1 design-system source-spec inconsistency (spec is wrong; the app's
shipped CSS is right). **Proposal written before the spec edit, per §26.1.**

**The inconsistency.** The design system carries two contradictory
representations of the `base` font size:

| File | Current `base` | Correct? |
|---|---|---|
| `gogogo-frontend/design-system/tokens.json:64` | `"base": "14px"` (flat, no responsive step) | **stale** |
| `gogogo-frontend/design-system/tokens.css:95` | `--gg-text-base: 0.875rem; /* 14px — buttons, field text (desktop) */` | **stale** — folds the mobile 16px into `--gg-text-md` under a different name and loses the responsive pairing |
| `gogogo-frontend/design-system/tailwind.preset.js:40-41` | `base: ['16px', …]` + `'base-desktop': ['14px', …]` | correct |

**Evidence** (Task 1 audit §D3, `00-audit.md:247-279`):

- Ground truth, `apps/storefront/static/app.css:120-125`:
  ```css
  /* 16px on small screens is not a style choice: Safari on iOS zooms the whole
     viewport in when a focused input's text is smaller than that … */
  .field { … font-size: 1rem; /* 16px */ … }
  @media (min-width: 640px) { .field { font-size: .875rem; } /* 14px */ }
  ```
- The audit's verdict: "`tokens.json`/`tokens.css`'s flat `base = 14px` is the
  stale entry. It silently drops the mobile-first 16px value and the
  accessibility rationale behind it (iOS Safari auto-zoom-on-focus
  prevention). `tailwind.preset.js`'s `base` (16px) + `base-desktop` (14px)
  pair is the accurate representation, matching `app.css` exactly."

**Which of the six canonical files are already correct** (checked, not assumed):

| File | State | Action |
|---|---|---|
| `foundations.md` | §3 typography table already says "Body — Manrope, 16px … mobile field text is 16px on purpose … desktop fields drop to 14px from 640px up" and "Button label — 14px/600" | none |
| `components.md` | "Text field" already says "Text: 16px on mobile (prevents iOS Safari's auto-zoom-on-focus), 14px from 640px up" | none |
| `page-templates.md` | §7 legal pages say "Body 16px/1.5 Manrope"; no `base`-token claim to correct | none |
| `tailwind.preset.js` | `base: 16px` + `base-desktop: 14px` already correct | none |
| `tokens.json` | `fontSize.base` is the flat stale `14px` | **edit** |
| `tokens.css` | `--gg-text-base` is the stale `0.875rem` | **edit** |

The three prose files and `tailwind.preset.js` already agree with `app.css`;
only the two token files disagree, and they disagree with the other four, not
with each other about anything deeper. No wider spec inconsistency found.

**Proposed change** (mirror `tailwind.preset.js`'s `base` / `base-desktop`
split; leave `md` = 16px untouched, exactly as `tailwind.preset.js` keeps both
`base` and `md` at 16px):

- `tokens.json` — `fontSize.base` → `"16px"`, add `"base-desktop": "14px"`.
- `tokens.css` — `--gg-text-base` → `1rem` (16px, mobile-first, iOS-zoom-safe),
  add sibling `--gg-text-base-desktop: 0.875rem` (14px, ≥640px); update the
  inline comments.
- `apps/storefront/client/src/styles/tokens.css` — the app's own copy of the
  `--gg-*` set (added in Part A) gets the identical edit in the same commit, so
  the app token file and the spec stay byte-identical.

**Impact on the app: none.** `--gg-text-base` is not referenced anywhere in
`apps/storefront` or `packages/web-ui` — the `.field` / `.btn` font sizes in
`app.css` are literal (`1rem` / `.875rem`), and Tailwind's `text-base` utility
is Tailwind core's own `--text-base`, unrelated to `--gg-text-base`. This
corrects the spec to match already-shipped behaviour; it changes no computed
value.

**Files.** `gogogo-frontend/design-system/tokens.json`,
`gogogo-frontend/design-system/tokens.css`,
`apps/storefront/client/src/styles/tokens.css`.

---

## D2-radius — `--gg-radius-xl` mirrored as `--radius-3xl`, class stays `rounded-3xl` (Task 9)

**Context.** Task 9's brief adds `--gg-radius-xl: 1.5rem` (24px) as a §26.2
extension for the full-bleed marketing bands (hero, "Our Promise",
AuthBrandPanel) and instructs: mirror it in the `@theme` block as
`--radius-xl`, then rename `rounded-3xl` → `rounded-xl` in the markup.

**Deviation.** The `@theme` mirror is **`--radius-3xl: 1.5rem`**, not
`--radius-xl`, and the markup **keeps `rounded-3xl`** (not renamed to
`rounded-xl`).

**Why.** Tailwind v4's core theme already defines `--radius-xl: 0.75rem`
(12px) and `--radius-3xl: 1.5rem` (24px), and the storefront's `@theme static`
block does not clear the core scale. `rounded-xl` is used at **~33 call
sites** across the storefront today (icon wells, buttons, inputs, the hero
preview cards) — all of them relying on the 12px core value. Overriding
`--radius-xl` to 1.5rem in `@theme` would silently re-radius every one of
them, a broad visual regression far outside this page's scope. Core's
`--radius-3xl` is already exactly the 24px this token wants, so mirroring
`--radius-3xl: 1.5rem` **pins that value with zero computed-style change** and
ties the `rounded-3xl` class to the documented `--gg-radius-xl` exception. The
brief's parenthetical fallback ("maybe they should just be `radius-lg` 16px")
does not apply either: the Tailwind `rounded-lg` utility resolves to core's
`--radius-lg` = `0.5rem` (8px) here, not the 16px `.card` radius, so that
route would shrink the bands.

**Net effect.** All three extension surfaces are present (`--gg-radius-xl` in
`tokens.extensions.css`, `--radius-3xl` in the `@theme` mirror,
`extensions.md` row). `rounded-3xl` in `HomePage.tsx` (hero, hero skeleton,
"Our Promise") and `AuthBrandPanel.tsx` now resolves through the documented
token instead of an implicit framework default. The trust-checklist panel,
which was also `rounded-3xl`, became a `<Card>` (`.card`, 16px) — it is a
bordered content card, not a full-bleed band.

**Files.** `apps/storefront/client/src/styles/tokens.extensions.css`,
`apps/storefront/client/src/index.css`,
`apps/storefront/client/docs/implementation/extensions.md` *(repo path:
`docs/implementation/extensions.md`)*, `apps/storefront/client/src/pages/HomePage.tsx`,
`apps/storefront/client/src/components/AuthBrandPanel.tsx`.

---

## 13-home-colour — reference-brand colours on HomePage adapted to this project's tokens (Task 9)

Type: §13 "reference-brand-specific colour → adapted to this project's brand
tokens." The reverse-engineered `HomePage.tsx` / `AuthBrandPanel.tsx` carried
four Tailwind-default hues that are **not in this project's palette**
(`pine` / `grass` / `amberx` / `rust` / `ink` / `paper` / `sand` / `line`
only). No violet or gold token was added. Each was mapped to the nearest
semantic token; the icons are decorative (every icon sits beside a text label
that already carries the meaning):

| Off-palette value | Where | Mapped to | Reasoning |
|---|---|---|---|
| `text-amber-400` / `text-amber-300` | hero "instant" ⚡ chip; AuthBrandPanel "instant" ⚡; **ProductCard catalog-tile "instant" ⚡ chip** (was `text-amber-300`, on its `bg-black/40` overlay — Task 10) | `text-grass` | "instant delivery" is a positive capability; `grass` reads well on the dark hero band, the pine auth panel, and the card's translucent-black image overlay, where `amberx` (`#b45c0a`, dark orange-brown) muddies against the dark grounds. |
| `text-violet-400` | hero "support" 🎧 chip; AuthBrandPanel "support" 🎧 | `text-pine-tint` | violet → pine family (brief guidance). On the dark hero / pine panel `text-pine` (`#2563eb`) is too low-contrast; `pine-tint` (`#e6effe`) matches the near-white decorative treatment of the sibling warranty icon. |
| `bg-violet-50` / `text-violet-600` | features grid "24/7 support" icon well; "Sosmed" upcoming-teaser icon well | `bg-pine-tint` / `text-pine` | violet → pine family. The support feature card now shares the pine well of the "instant" card; the four wells are pine / grass / amberx / pine. `rust` (the only remaining palette hue) means danger and is wrong for "support". |

Slight legibility trade-off logged: the hero's warranty and support chips now
use the same `pine-tint` icon colour, and two of the four feature-card wells
are pine. Both are acceptable — the pairs are decorative and the labels
disambiguate — and neither harms hierarchy.

**Files.** `apps/storefront/client/src/pages/HomePage.tsx`,
`apps/storefront/client/src/components/AuthBrandPanel.tsx`,
`apps/storefront/client/src/components/shop/ProductCard.tsx` *(Task 10 — instant-chip row above)*.

---

## 10-listing-structure — category-listing family kept its pills + sort on top of the §2 template (Task 10)

**Context.** `page-templates.md` §2 "Category listing" is deliberately minimal:
**breadcrumb → H2 → single 5-col product-card grid**, no sidebar, no facets,
no visible pagination. Task 10 migrates the four routes that share this shape
(`CategoryPage` `/c/:slug`, `CategoriesPage` `/categories`, `ProductsPage`
`/products`, `FlashPage` `/flash`) plus the `ProductCard` / `ProductCardSkeleton`
/ `SortSelect` domain components.

**Rule cited:** FRONTEND_IMPLEMENTATION_PROMPT §3.2 ("adapt composition, not
invention" — preserve existing business functionality; the design system is a
visual *language*, applied by re-skinning what the app already does, never by
removing a working feature to match a minimal template). §2's "no facets, no
pagination, no sort" describes gogogo.id's category pages; it is not a licence
to strip this shop's pre-existing category-switch pills or `?sort=` control.

**Deviations, all deliberate:**

1. **`CategoryPage` keeps its category-switch pill row.** §2 has no
   category switcher (each category is its own SEO page). This shop has always
   let a visitor hop between sibling categories from a horizontally-scrolling
   pill row under the H1. Kept, restyled to the `components.md`
   "Segmented control / tabs" visual — `rounded-full`, `text-sm`/`600`, scale
   padding (`px-3 py-1.5`), **active** = `bg-pine-tint` + `text-pine-dark`
   (the `.btn-soft` pattern), **inactive** = `text-ink-soft` on `bg-sand` with
   a `hover:bg-pine-tint hover:text-pine-dark` hover. They stay `<Link>`s (not
   a controlled `<Tabs>` — they navigate, they don't filter in place). The old
   `px-3.5!` / `py-1.5!` bang overrides (which existed only to beat the
   `.chip` class's own `padding`) are gone: the pill is now composed from
   plain utilities (`inline-flex items-center gap-2 rounded-full …`), no
   `.chip` class, no `!`.

2. **All four pages keep the `SortSelect` control.** §2 lists no sort. STO-007
   gave this family a shared cheapest/newest/rating sort that re-fetches with
   `?sort=` (the server owns price/rating ordering). Kept, and only rendered
   when `products.length > 1` (nothing to reorder otherwise). `SortSelect`
   now composes the `components/ui/Select` primitive instead of a raw
   `<select className="field">`; its responsive label-row layout, the
   `sm:w-auto!` collapse, its four options and i18n keys are unchanged.

3. **Grid density raised to the design-system 5-up, but only at `xl`.**
   `tokens.json productGridColumns.desktop: 5`. Current was
   `grid-cols-2 sm:grid-cols-3 lg:grid-cols-4`; now
   `grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5` — 5 cards only
   from ≥1280px, 4-up at 1024 (5 at 1024 is cramped). `gap-4` and the
   one-product `max-w-xs` special-case are unchanged. The per-page loading
   skeleton grids got the same `xl:grid-cols-5`.

4. **`CategoriesPage` is a category **tile** grid, not a product grid.** It has
   no products and no sort; it keeps its `sm:grid-cols-2 lg:grid-cols-3` tile
   layout. Only the breadcrumb was added and the tile card elevation was
   nudged onto the design-system step (`shadow-xs` → `shadow-soft`,
   `hover:shadow` → `hover:shadow-lift`) to match the migrated `ProductCard`
   and HomePage's category tiles.

5. **`ProductCard` rating stays an inline row, no overlay chip.**
   `components.md` "Product card" puts rating in a **top-left white pill
   overlay** on the art. This card's `top-3 left-3` corner already carries a
   stacked flash-badge + bulk-badge column and its `top-3 right-3` corner the
   instant ⚡ chip — both corners are occupied and the left column is
   variable-height, so a rating overlay could not be added without crowding
   or a larger recomposition outside this task's scope. The existing inline
   rating row (`<Stars>` + value + review count, below the title) is kept
   unchanged — it shows the same information. `components.md`'s "Sales row"
   (`587 RB+ Terjual`) is **not** added — this shop tracks no per-product
   sales count (audit C1).

6. **`ProductCard` bulk-hint text size.** `text-[0.7rem]` (11.2px, an
   arbitrary rem value) → `text-xs` (12px). `text-2xs` (`--gg-text-2xs`, 10px)
   was considered and rejected: `extensions.md` scopes that token to the
   `Badge` discount/savings label only ("must not replace `--gg-text-xs`
   where the shared 12px chip size is used"), and this is body-adjacent hint
   text, not a badge label.

7. **`ProductCard` / `ProductCardSkeleton` elevation.** `shadow-xs` →
   `shadow-soft` (resting), `hover:shadow-md` → `hover:shadow-lift` (a real
   elevation step, per `components.md` "Product card"). The skeleton's
   resting shadow was moved in lock-step so there is no elevation pop on
   load. The `border-line` + white `bg-card` + `rounded-2xl` (16px) already
   matched the spec and are untouched. `scale-[1.03]` on image hover
   (arbitrary but gate-allowed, no px/hex) is kept.

8. **`Breadcrumb` adopted with `components.md`-alignment tweaks.** The
   shared `components/shop/Breadcrumb.tsx` (audit verdict: `adopt`) was wired
   into all four pages. Four small changes bring it onto the `components.md`
   "Breadcrumb" spec: size `text-xs` → `text-sm` (14px); non-current crumbs
   `text-ink-faint` → `text-ink-soft` (nav base colour); the current
   (last, non-link) crumb `text-ink-soft` → `text-ink font-semibold` (spec:
   "current page in `ink` (bold)"); separator glyph `/` → `›`, coloured
   `text-ink-faint`. The current-crumb `<span>` also gains `min-w-0
   break-words` so a very long product / category name wraps inside the
   already-`flex-wrap` nav rather than pushing the row (§21 content
   robustness). These ripple to the two other current consumers
   (`ProductPage`, `InstantBuyPage`) as a pure visual refinement toward the
   design system; the `items: {label, href?}[]` API, the "last item = current,
   no link" behaviour and the `hover:text-pine` link treatment are unchanged.

   *Known pre-existing (not introduced here):* at ≤320px a pathologically
   long, unbroken category name still forces a small horizontal scroll on
   `CategoryPage` — via the `.page-title` h1 (`display:flex`, no `flex-wrap`,
   in `app.css`) and the `whitespace-nowrap` category pills inside their
   `overflow-x-auto` row — and on `CategoriesPage` via the tile `h2.truncate`
   (`white-space:nowrap`) in a rigid `1fr` grid track. All three predate this
   task; `/products` and `/flash` (breadcrumb, no pills, no truncate) show no
   overflow at 320px with realistic titles.

**Crumb labels used:** `CategoryPage` — `{Home} › {category.name}`;
`ProductsPage` — `{Home} › {All products}`; `FlashPage` —
`{Home} › {Flash sale}`; `CategoriesPage` — `{Home} › {Categories}`
(`web.nav_home` / `web.products_title` / `web.flash_title` /
`web.categories_page_title`; Indonesian: Beranda / Semua produk / Flash sale /
Kategori).

**Files.** `apps/storefront/client/src/pages/CategoryPage.tsx`,
`apps/storefront/client/src/pages/CategoriesPage.tsx`,
`apps/storefront/client/src/pages/ProductsPage.tsx`,
`apps/storefront/client/src/pages/FlashPage.tsx`,
`apps/storefront/client/src/components/shop/ProductCard.tsx`,
`apps/storefront/client/src/components/shop/ProductCardSkeleton.tsx`,
`apps/storefront/client/src/components/shop/SortSelect.tsx`,
`apps/storefront/client/src/components/shop/Breadcrumb.tsx`.

---

## 9-home-structure — HomePage kept content-richer than the §1 template; no category filter added (Task 9)

**Context.** `page-templates.md` §1 "Home / Landing" is a 6-section template
(promo strip, hero carousel, category **filter** pill control, repeated
5-col product sections + "show more", two help CTAs, FAQ accordion).

**Deviations, all deliberate:**

1. **Content-richer than the template.** This shop's Home has 11 sections —
   dark hero, feature grid, "how to order" stepper (`#how-to-order`), dynamic
   category grid (`#categories`), featured/newest product shelf (`#products`),
   upcoming-services teaser, "Our Promise" pine band, verifiable-trust
   checklist, testimonials (hidden when none), FAQ, contact cards
   (`#contact`). Every section carries real data / i18n and was kept; the
   migration re-skinned them onto `Card` / `Button` / `Accordion` /
   `TrustBadgeRow` / `Alert` primitives and the token radius/rhythm, it did
   not delete any. Per the brief: "content-richer … is a logged deviation,
   not a reason to delete sections."

2. **No category filter.** §1.3's pill segmented control filters the product
   shelves. This Home reaches categories through a category **grid** section
   instead (`business-adaptation.md` §Navigation). The grid was kept and **no
   filter was added** — a filter over a single "newest" shelf would filter
   nothing.

3. **No "show more" / "Tampilkan lebih banyak" button.** §1.4's ghost link
   pages through repeated product sections. This Home has one server-capped
   "Latest products" shelf and no pagination, so there is nothing to expand.
   The only nearby affordance — a "Browse by category" jump-link in the shelf
   header — was left as an inline `text-pine` link rather than promoted to a
   44px `.btn-ghost`, which would over-weight a section-header adjunct.

4. **Hero secondary CTA is not `.btn-ghost`.** The brief maps the two hero
   CTAs to `Button` primary / ghost. `.btn-ghost` is `ink-soft` text on a
   `sand` hover fill — invisible on the `bg-ink` hero (foundations.md §7
   dark-surface exception). The primary CTA uses `.btn btn-primary` (pine
   fill works on any ground); the secondary keeps `.btn` sizing with a white
   `border-white/20` + `hover:bg-white/15` outline treatment. Both keep the
   white `.focus-on-dark` ring.

5. **`Card` primitive is a `<div>`; link/anchor cards apply `.card` classes
   directly.** `Card` has no polymorphic `as` / `asChild`. The category tiles
   and contact cards are `<Link>` / `<a>` elements whose own class list is
   asserted by `HomePage.test.tsx` (the hover lift/shadow must be on the link
   itself). They apply `card card-pad …` utility classes directly — the
   established storefront pattern (`CartPage`, `OrderSummaryCard`, `PayPage`,
   `ErrorPage`) — rather than nesting a `<div>` inside the link. The feature
   grid, testimonial cards and trust-checklist panel (plain `<div>`s) use the
   `<Card>` component.

6. **"Coming soon" teaser stays hand-rolled.** Its dashed border marks it
   non-interactive (pinned by a test) and `.card` hardcodes
   `border: 1px solid` at plain-class precedence, which `border-dashed`
   cannot override. It keeps `rounded-2xl` + token colours.

7. **Contact-hours note left as-is.** Already token-clean
   (`bg-pine-tint` / `text-ink-soft` / `text-pine` / `rounded-2xl`); not in
   the brief's card/panel conversion list, so not churned into an `Alert`.

**Files.** `apps/storefront/client/src/pages/HomePage.tsx`,
`apps/storefront/client/src/pages/HomePage.css`,
`apps/storefront/client/src/pages/HomePage.test.tsx`.

---

## 11-product-detail — ProductPage + InstantBuyPage migration, DenominationCard + StickyPurchaseBar (Task 11)

**Context.** `page-templates.md` §3 "Product detail" describes gogogo.id's
top-up page: a User-ID card, **nominal tabs** (`Termurah` / `Membership` /
`Diamonds`) grouping a 2-col/3-col denomination grid, and a sticky
`Lanjutkan` bar with a two-strip cashback ribbon. Task 11 migrates the two
routes that share this shape — `ProductPage` (`/p/:slug`, cart flow) and
`InstantBuyPage` (the `checkout_flow === "instant"` one-page top-up rail) —
plus the `DenominationCard` domain component, and extracts the shared
`StickyPurchaseBar`.

**Rule cited:** FRONTEND_IMPLEMENTATION_PROMPT §3.2 rule 1 ("adapt
composition, not invention" — the design system is a visual *language*
applied by re-skinning existing business content; a minimal reference
template is not a licence to add or remove working behaviour).

**Deviations, all deliberate:**

1. **Flat denomination list — no nominal `<Tabs>` grouping.** §3's nominal
   tabs assume denomination *types* to group by (`Termurah` / `Membership` /
   `Diamonds`). This catalog's `denominations` is a flat, server-ordered list
   with no group dimension, so both pages render it as a single ungrouped
   grid. Adding a `<Tabs>` with one tab would be chrome over nothing.

2. **Denomination grid stays single-column.** §3 shows a 2-col mobile /
   3-col desktop grid of vertical tiles (icon top, price bottom). This shop's
   `DenominationCard` is a *horizontal* row — plan/label + stock/flash badges
   on the left, price (+ struck original) on the right — which needs the full
   row width to stay legible. On `ProductPage` the picker also sits in the
   ~half-width right column of the `md:grid-cols-2` page layout. Both pages
   keep `<div class="grid gap-3">` (one column); the off-scale `gap-2.5`
   (10px) is corrected to `gap-3` (12px, the spec's "12–16px gap").

3. **`DenominationCard` resting border is 2px, not the spec's literal 1px.**
   `components.md` "Denomination / package card" says `1px line` border at
   rest, `2px solid pine` when selected. Swapping 1px→2px on selection
   reflows every sibling in the grid by a pixel as the shopper clicks
   through. The card instead carries `border-2` at all times — `border-line`
   at rest (a 2px hairline in `#e3e8ef` is visually ~identical to 1px at tile
   scale), `has-[:checked]:border-pine` when selected — so selection is a
   pure colour swap. The card is composed from token utilities
   (`rounded-lg border-2 border-line bg-card p-4 shadow-soft`) instead of the
   shared `.card` class specifically so it takes the spec's `radius 8px`
   (`rounded-lg` = `--gg-radius-sm`) rather than `.card`'s unlayered 16px.

4. **`DenominationCard` selected state drops the fill.** The old
   `has-[:checked]:bg-pine-tint/40` wash is removed (spec: "never a solid
   colour fill on the whole card"). Selected = `has-[:checked]:border-pine`
   (2px solid) + `has-[:checked]:ring-2 has-[:checked]:ring-pine/35` (the
   translucent focus-ring halo `--gg-shadow-focus` describes; `shadow-focus`
   is not a wired Tailwind utility in this project). `DenominationCardProps`
   (`d`, `fx`, `lowThreshold`, `checked`, `onChange`), the `<input
   type="radio">` + `has-[:checked]:` contract and the `data-*` attributes
   are unchanged.

5. **`StickyPurchaseBar` has no cashback ribbon.** §3's strip 1 is a
   `pine-tint` "Asik kamu bisa dapat CASHBACK N Koin!" ribbon. This shop has
   no koin cashback, so the extracted component's `notice` slot is optional
   and both pages omit it. The price still renders in `grass-dark` ~20px/700
   per the spec; `savingsChip` / `secondaryChip` slots exist for a future
   bulk-discount hint but neither page passes one today.

6. **`ProductPage`'s sticky bar keeps its single CTA.** The component
   supports `primaryAction` + optional `secondaryAction` (the "Buy Now + Add
   to Cart" shape §3 implies, and CheckoutPage will use). `ProductPage`'s bar
   historically shows only Buy Now (or the restock CTA when nothing is
   purchasable) — Add to Cart lives in the in-page buy form only — and that
   behaviour is preserved: it passes `primaryAction` alone. The
   `IntersectionObserver` sentinel (`#buy-summary`) that shows/hides the bar
   is unchanged.

7. **`InstantBuyPage` keeps its existing `lg:grid-cols-3` desktop layout.**
   §3 / the brief suggest a 2-col "info left / buy right" split. InstantBuyPage
   already has a working multi-column desktop layout (left `col-span-2` =
   header + account fields + denomination grid + guest contact; right =
   `OrderSummaryCard`; a full-width row-2 = `PaymentMethodSelector`, placed
   there by documented, test-covered grid auto-placement). Re-fragmenting it
   into a strict 2-col would break that row-2 placement and its tests for no
   visual gain, so the grid is left as-is; only the sticky bar, the error
   banners, the denomination `gap`, and the `<h1>` size bang were touched.

8. **Inline error banners → `<Alert variant="banner" tone="error">`.**
   `ProductPage`'s `cartErrorKey` block and `InstantBuyPage`'s
   `previewErrorKey` / `placeOrderErrorKey` blocks (hand-rolled
   `card card-pad border-rust/40 bg-rust-tint …` rows) now render through the
   `ui/Alert` primitive. The `InstantBuyPage` nickname-check hints
   (`nickname-check-found` / `-not-found` / `-pending`, region `Callout`s) are
   **not** touched — they are deliberately soft informational text
   (`text-ink-soft` / `text-grass-dark`), already token-clean, and their exact
   markup / `data-testid`s are pinned by tests; converting a "not found" hint
   into a red error `Alert` would be the behaviour change the "keep exactly"
   list forbids.

9. **`<h1 className="page-title">` bang overrides dropped.** Both pages had
   `text-2xl! sm:text-3xl!` on the title; `.page-title` already resolves to
   24px→30px, so the `!important` overrides were redundant and are removed.

10. **`StickyPurchaseBar` is portaled to `document.body`.** `app.css` runs
    `main { animation: rise .5s … both }`; the `both` fill-mode leaves
    `<main>` with a non-`none` `transform` after load, which makes it the
    containing block for its `position: fixed` descendants. A bar rendered
    inside the routed page therefore pinned to `<main>`'s bottom edge (above
    the footer, scrolled away mid-page) instead of the viewport — a latent
    bug the three hand-rolled bars all shared, surfaced by this task's visual
    QA. The shared component renders via `createPortal(bar, document.body)`
    (with a `typeof document === "undefined"` SSR guard) so it escapes
    `<main>`. Fixing the root cause (`animation-fill-mode` on `<main>`, or a
    Layout restructure) is a cross-cutting base-layer change outside this
    task's file scope. The pre-existing `.page-title` / breadcrumb horizontal
    overflow at ≤320px with a long product name (deviations.md
    §10-listing-structure item 8 "Known pre-existing") also reproduces on
    `InstantBuyPage` ("Mobile Legends Diamonds") and is likewise untouched.

11. **`DeliveryFieldInput.tsx`'s own field-validation error left as-is.**
    The brief's Apply bullet names the instant-rail "account field"
    validation error alongside "Cek ID". The page-level error *banners*
    (item 8) were converted, but `DeliveryFieldInput.tsx`'s hand-rolled
    per-field `<p className="text-xs text-rust">` message (the one under a
    User-ID / server-data input) was **not** — that component is shared by
    `InstantBuyPage`, `CheckoutPage` and `OrderDetailPage`, so re-skinning
    it onto `FormField`'s error slot is a cross-consumer change outside a
    single page-migration task's scope. Deferred to whichever later task
    (Fase 7c checkout / Fase 7e order-detail) first has all three consumers
    in view, or a dedicated `DeliveryFieldInput` refactor. It is already
    token-clean (`text-rust`), so this is a structural/API alignment, not a
    colour or token fix.

12. **`shadow-lift` on the pinned bar casts downward, not upward.**
    `components.md` "Sticky purchase bar" describes a `shadow-lift` cast
    **upward** onto the content above it. This project's `--gg-shadow-lift`
    token is a single downward-offset shadow (`0 2px 4px …, 0 16px 36px
    -18px …`), and there is no upward-shadow token. On a viewport-bottom
    bar the visible portion of that shadow is minimal. Adding an
    upward-shadow token is a `design-system/` change requiring the §26.1
    proposal flow and is out of this task's scope; the bar keeps
    `shadow-lift` for now (still a real elevation token, just less visible
    in this position). Flag for Fase 10 hardening.

**Files.** `apps/storefront/client/src/components/shop/DenominationCard.tsx`,
`apps/storefront/client/src/components/shop/StickyPurchaseBar.tsx` (new),
`apps/storefront/client/src/pages/ProductPage.tsx`,
`apps/storefront/client/src/pages/InstantBuyPage.tsx`,
`apps/storefront/client/eslint.config.js` (Group-A `env()` allowlist entry
for `StickyPurchaseBar.tsx`).

## 12-search-overlay — `/search` full page → `SearchOverlay`; 404 page → §16 states; mobile header search row dropped (Task 12)

**Context.** `page-templates.md` §10 makes search an overlay panel, not a
route — and the user explicitly chose this over the old full `/search`
results page (plan Global Constraints, "`/search` route"). `page-templates.md`
§11 wants the 404 page on the standard chrome with a centered
illustration + message + primary action, and §16 forbids raw status codes
in the UI.

**Rule cited:** FRONTEND_IMPLEMENTATION_PROMPT §3.2 rule 1 (preserve
behaviour; adapt composition) + plan Global Constraints (`/search` must
still resolve for shared links; log the trade).

**Deviations, all deliberate + user-approved:**

1. **`/search` is no longer a results page — it is a redirect.** `App.tsx`
   still has the `<Route path="/search">`, but it renders
   `pages/SearchRedirect.tsx`: read `?q=`, open the `SearchOverlay`
   pre-filled, `navigate("/", { replace: true })`. Previously shared
   `/search?q=…` links therefore land on Home with the overlay open and the
   query run, instead of a dedicated full-page grid. `pages/SearchPage.tsx`
   (+ its test) is deleted; its recent-searches localStorage logic moved
   verbatim to `src/lib/recentSearches.ts` (same `storefront.recent_searches`
   key, same 5-entry cap, same case-insensitive dedupe, same private-mode
   try/catch), consumed by the overlay.

2. **Dropped with the route: the sort control, the `?sort=` param, and the
   results-as-a-shareable-page.** The overlay is a compact type-and-pick
   list, not a browsable grid — `SortSelect`, `SORT_KEYS` wiring and the
   `&sort=` query-string on `/api/v1/pages/search` are gone from this
   surface (the endpoint still accepts `sort`; the overlay just never sends
   it). Shoppers who want to sort a full catalogue use `/products` (which
   keeps its sort). This is the user-approved trade for the overlay pattern.

3. **No new dependency; the combobox ARIA is hand-rolled.** Pattern chosen:
   a `role="dialog"` + `aria-modal` shell (reusing `ui/useDialogA11y` —
   scroll-lock, Esc-to-close, focus trap, focus restore to the trigger)
   wrapping an APG **combobox**: the field is `role="combobox"` with
   `aria-expanded` / `aria-controls` / `aria-activedescendant`, and results
   are a `role="listbox"` of `role="option"` rows navigated with
   ArrowUp/ArrowDown. Result rows are **not** `<a>` elements (APG advises
   against interactive children inside options) — selection navigates
   programmatically via `useNavigate`, so middle-click / "open in new tab"
   on a result row is not available (acceptable for an ephemeral search
   panel; the product pages themselves are still normal links everywhere
   else). Enter with a highlighted row opens it; Enter with **no** highlight
   keeps the overlay open showing every match (there is no results page to
   route to) and records the term. The existing endpoint is debounced
   ~220ms; no backend/schema change.

4. **Desktop scrim is lighter than mobile, and scroll-lock applies on both.**
   §10 asks for "a lighter click-outside-to-close on the desktop dropdown".
   Interpreted as visual weight: mobile scrim is `bg-ink/45` (full-screen
   panel), desktop `bg-ink/25` (panel drops under the header search field,
   anchored `sm:top-20`, `sm:max-w-xl`, centered). Both close on
   scrim-click and both get `useDialogA11y`'s body scroll-lock + focus trap
   — matching the `Modal` primitive rather than special-casing desktop to
   "no trap". Functionally the same close affordances on every viewport.

5. **`ErrorPage.tsx` composes the §16 state components.** A 404 renders
   `NotFoundState`, a 5xx renders `ErrorState` (both non-`bare`, so they
   bring the centered icon-in-a-well + `StatusScreen` treatment §11 asks
   for). The `statusCode` / `message` prop API the SPA shell passes is
   unchanged, and the `fadeUp` entrance is kept. The status **number** is
   no longer the `text-5xl` headline (§16 "no raw status codes in the UI");
   it survives only as a small `aria-hidden` `text-xs text-ink-faint`
   caption below the state card, for support conversations. `message` is
   passed through as the state component's `description`, so the default
   404 copy is still `web.not_found` ("That page doesn't exist.") and the
   default 500 copy `web.error_message`. A 5xx keeps `ErrorState`'s
   canonical "Reload page" action rather than a back-home button; a 404
   (the overwhelmingly common shell case) gets the `web.back_home` CTA.

6. **Mobile secondary header row removed entirely.** `Navbar.tsx`'s
   `sm:hidden border-t` row held a full `<SearchForm>` field **and** a
   language `<a>`. The language switcher already has a mobile home in
   `MobileDrawer.tsx` (the `Globe` / `web.lang_label` row, Task 5), so the
   whole row is gone. Its replacement is a single search **icon** button in
   the main mobile bar (`sm:hidden`, `aria-label` = `web.nav_search`,
   `aria-haspopup="dialog"`) that opens the same `SearchOverlay`. The
   `MobileTabBar` "Cari" tab is unchanged — it still `<Link>`s to `/search`,
   which now resolves through `SearchRedirect` to the same overlay, so both
   mobile entry points end in one place. `SearchForm.tsx` itself became a
   button trigger (it no longer navigates); it is still used as the
   persistent desktop header pill. No `Navbar` / `Layout` prop became unused
   (`lang` / `otherLang` / `backPath` are still read by the desktop
   language switcher, which stays).

**New i18n keys** (`packages/core/locales/{en,id}.json`):
`web.search_no_results` (`{q}`), `web.search_browse_all`, `web.search_close`.

**Files.** `apps/storefront/client/src/components/shop/SearchOverlay.tsx`
(new — component + `SearchOverlayProvider` + `useSearchOverlay`),
`apps/storefront/client/src/pages/SearchRedirect.tsx` (new),
`apps/storefront/client/src/lib/recentSearches.ts` (new — extracted),
`apps/storefront/client/src/pages/ErrorPage.tsx`,
`apps/storefront/client/src/components/Layout.tsx` (mounts the provider),
`apps/storefront/client/src/components/layout/Navbar.tsx`,
`apps/storefront/client/src/components/layout/SearchForm.tsx`,
`apps/storefront/client/src/App.tsx`,
`packages/core/locales/{en,id}.json`. Deleted:
`apps/storefront/client/src/pages/SearchPage.tsx` (+ `.test.tsx`).

## 13-checkout — CartPage + CheckoutPage migration, PaymentMethodSelector grouping, Stepper restyle, StickyPurchaseBar wiring (Task 13)

**Context.** Fase 7c migrates the checkout funnel — `CartPage.tsx`,
`CheckoutPage.tsx`, and the shared domain components they use
(`OrderSummaryCard.tsx`, `PaymentMethodSelector.tsx`, `Stepper.tsx`,
`DeliveryFieldInput.tsx`, also shared with the already-migrated
`InstantBuyPage`). Pure re-skin — no total/subtotal/discount arithmetic,
mutation payload, endpoint string, payment-method state machine,
idempotency-key handling, or guest/auth branch logic changed; verified by
grepping the diff for `/api/v1/`, `formatIdr(`, `apiPost(`/`apiGet(`,
`mutationFn` — the only hits are the same expressions re-indented or moved
into a different prop, never a changed value or endpoint.

**Deviations, all deliberate:**

1. **Cart has no page-templates.md reference layout ("composed" per §3.2
   rule 3).** gogogo.id checks out from its own sticky bar with no dedicated
   cart template. `CartPage` keeps its existing desktop 2-col (line items +
   summary `Card`) / mobile sticky-bar shape, restyled onto `.card`/token
   utilities and the shared `<StickyPurchaseBar>` — no template to diverge
   from, so this is composition, not adaptation of an existing one.

2. **`PaymentMethodSelector` groups by this shop's actual payment rails, not
   page-templates.md's literal "e-wallet / VA / QRIS / retail" taxonomy.**
   This shop has no virtual-account or retail-outlet gateway; its eight rows
   are QRIS, PayDisini ("QRIS / E-Wallet"), four crypto gateways (Binance,
   Bybit, Bybit On-Chain, NOWPayments), and two wallet-credit rows. Grouped
   instead as **IDR quick-pay** (QRIS + PayDisini), **Cryptocurrency**
   (Binance/Bybit/Bybit BSC/NOWPayments), and **Wallet credit** (wallet_idr/
   wallet_usdt) under `field-label` sub-headings — three new i18n keys
   (`web.pay_group_idr`, `web.pay_group_crypto`, `web.pay_group_wallet`,
   `en`+`id`). Every row's own gating condition (`data.X_enabled`, wallet
   sufficiency) is byte-identical to before; the groups only wrap
   already-conditional rows, never add/remove one or change when it renders.
   `PaymentMethodRow` itself is a `border-2` card-surfaced `<label>` wrapping
   a `<ui/Radio>` — DenominationCard's `has-[:checked]:border-pine` + ring,
   no-fill selected treatment — kept as a `<label>` (not a literal `<Card>`)
   because the native label-wraps-input click-anywhere-to-select behaviour
   needs a real `<label>` element. Shared `PaymentMethodSelector` API
   (`data`/`method`/`onSelect`) is unchanged; `InstantBuyPage.test.tsx` (21
   tests, including the payment-row selection and re-validation-on-re-price
   suites) passes unmodified against the restyle.

3. **`Stepper` restyled to numbered circles + connector** (the brief's first
   option, not the pill-row fallback): a small numbered circle per step,
   `pine` active / `grass` + check done / `sand`+`ink-faint` upcoming,
   joined by a short connector bar (`grass` once passed, `line` otherwise).
   Chosen over the simpler pill row because circles-plus-connector reads as
   *progress* at a glance (the connector fills in as steps complete) in a
   way a same-shaped pill row does not. Kept: 3 steps, their labels, the
   below-`sm` collapse-to-number-only-except-current behaviour, and the
   `aria-label`/`aria-current="step"` wiring — this file was one of the 3
   left uncommitted by the interrupted prior attempt; reviewed and kept
   as-is (see task-13-report.md for that call).

4. **`CartPage`/`CheckoutPage` sticky bars now portal via
   `StickyPurchaseBar`, and their `env()`/`calc()` allowlist entries in
   `eslint.config.js` are dropped.** Both pages' hand-rolled `fixed` bottom
   bars are replaced by the shared, `document.body`-portaled
   `<StickyPurchaseBar>` (Task 11) — fixing the same `<main>`
   `transform`-makes-a-containing-block bug Task 11's own doc comment
   describes, which pinned the old bars to `<main>`'s bottom edge instead of
   the viewport. Neither page needs its own `env(safe-area-inset-bottom)`
   calc any more (the bar pads its own bottom for the notch); the pages'
   own reserved-runway space is now a plain `pb-28` utility. Removed from
   `eslint.config.js`'s allowlist (A) accordingly — `InstantBuyPage.tsx` and
   `ProductPage.tsx` keep their own entries (unchanged, out of this task's
   scope). One behavioural note: `StickyPurchaseBar`'s primary action is
   always a `<button onClick>`, not a `<Link>`, so `CartPage`'s
   "Continue to payment" mobile CTA (pure navigation, no mutation) now
   `navigate("/checkout")`s from a button instead of rendering an `<a
   href="/checkout">` — `CartPage.test.tsx`'s "single reachable place on
   mobile" assertion was updated from `getByRole("link", …)` to
   `getByRole("button", …)`; the destination and "exactly one control"
   property are unchanged. `CheckoutPage`'s bar was already button-based
   (it submits `placeOrderMutation`), so no equivalent selector change was
   needed there.

5. **`GuestContactCard` (in `CheckoutPage.tsx`) composes `<Label>` +
   `<Input>` directly, not a literal `<FormField>`** — same reasoning as
   `OrderSummaryCard`'s voucher field (Task 11/7b precedent): the label row
   also carries a "Required" badge beside the label text, which
   `FormField`'s single-child clone + fixed `<Label>` slot has no room for.
   `DeliveryFieldInput` (the field shared by `InstantBuyPage`/`CheckoutPage`/
   `OrderDetailPage`) DOES use a literal `<FormField>` — it has no such
   adjacent-badge requirement, only a label + control + error.

**Files.** `apps/storefront/client/src/pages/CartPage.tsx`,
`apps/storefront/client/src/pages/CheckoutPage.tsx`,
`apps/storefront/client/src/pages/CartPage.test.tsx` (one selector update),
`apps/storefront/client/src/components/shop/OrderSummaryCard.tsx`,
`apps/storefront/client/src/components/shop/PaymentMethodSelector.tsx`,
`apps/storefront/client/src/components/shop/Stepper.tsx`,
`apps/storefront/client/src/components/shop/DeliveryFieldInput.tsx`,
`apps/storefront/client/eslint.config.js` (allowlist cleanup),
`packages/core/locales/{en,id}.json` (3 new `web.pay_group_*` keys).

---

## 14-pay-topup-track — PayPage + WalletTopupPage + TrackOrderPage migration, cancel-order confirmation dialog (Task 14)

**Context.** Fase 7c, part 2 of the payment funnel: `PayPage.tsx` (shared by
`/checkout/:code/pay` and `/wallet/topup/:code/pay` via `variant`),
`WalletTopupPage.tsx`, `TrackOrderPage.tsx`. Pure re-skin plus ONE permitted
logic addition (below) — no fetch/poll endpoint, mutation payload, gateway
branch, countdown mechanism, or the `payState()`-driven state machine
changed. Verified by grepping the diff for `/api/v1`, `cancelMutation`,
`mutationFn`, `5000`/`5_000`, and every gateway flag name
(`is_binance`/`is_bybit`/`is_qris`/`is_paydisini`/`is_nowpayments`/etc.) —
zero hits touch a mutation definition or an endpoint string; the only
`cancelMutation` hits are the cancel button's `onClick`→`onConfirm` move
described below, and `mutationFn` has no diff hits at all in any of the
three files (the `useMutation({...})` blocks are byte-unchanged).

**The one logic addition — cancel-order confirmation dialog (required, not
optional).** `PayPage.tsx`'s cancel button (`web.cancel_order`, "Cancel this
order" / "Batalkan pesanan ini") used to call `cancelMutation.mutate()`
directly from `onClick` — the exact gap flagged in the Task 1 audit (§F
escalation #3) and required by the plan's Global Constraints ("Destructive
actions … MUST show a confirmation dialog … Do not silently keep the old
direct-execute behavior"). It now opens `<AlertDialog>` (built Task 7)
instead:

- Trigger `onClick` → `setCancelDialogOpen(true)` only; no mutation call.
- `AlertDialog onConfirm` → `() => cancelMutation.mutate()` — the exact same
  call the old `onClick` made, moved verbatim.
- `onCancel` → closes the dialog, no mutation.
- `confirmPending={cancelMutation.isPending}`, `tone="danger"`.
- Copy: title `web.cancel_order_confirm_title` ("Cancel this order?" /
  "Batalkan pesanan ini?"), description `web.cancel_order_confirm_body`
  ("Order {code} — this can't be undone." / "Pesanan {code} — tindakan ini
  tidak bisa dibatalkan.", `{code}` = `order.code`), confirm
  `web.cancel_order_confirm_yes` ("Yes, cancel" / "Ya, batalkan"), cancel
  `web.cancel_order_confirm_no` ("No, go back" / "Tidak, kembali"). Sourced
  from `business-adaptation.md`'s CTA Register (line ~83: canonical app
  string "Batalkan pesanan ini / Cancel this order", danger tone) — no
  existing precedent for the confirm/cancel button labels or body copy
  existed anywhere in the app (grepped for prior `AlertDialog` consumers:
  none besides the dev gallery and its own test), so these four new keys
  were written fresh, added to both `en.json`/`id.json`, and pass
  `packages/core/src/locales.test.ts`'s key-parity + placeholder-parity
  guard. The trigger button itself keeps its current `ghost`+`text-rust`
  visual weight rather than converging to the CTA Register's listed
  canonical `danger` variant — that variant note describes a still-open
  convergence target (the register itself flags the row as "currently
  `ghost text-rust`"), and this task's required change is the confirmation
  step, not the trigger's prominence; changing both at once on a
  payment-adjacent page seemed like more visual-behavior change than the
  brief asked for. Left for a later task if wanted.

**Deviations, all deliberate:**

1. **`PayPage`, `WalletTopupPage`, `TrackOrderPage` have no
   page-templates.md reference layout ("composed" per §3.2 rule 3)** — same
   reasoning as Task 13's `CartPage` entry. Each keeps its existing shape
   (payment-instructions card + status strip + countdown; currency-toggle +
   amount + method-list form; single centered lookup card) restyled onto
   `<Card>`/`<Button>`/`<Alert>`/`<FormField>`/`<Input>`/`<Badge>`, no
   template to diverge from.

2. **`StatusStrip` (PayPage's polled status chip) is now `<Badge>`-driven,
   with the SAME tone-per-state pairing it already had** — `waiting`→
   `pending` (amberx), `confirming`→ the one new Badge variant this task
   adds, `info` (pine — an existing token, not an invented color; it's the
   same pine tint `category` already uses, just paired with the `.chip`
   shape instead of the pill shape), `delivered`→`success` (grass),
   `expired`→`failed` (rust), `closed`→`neutral` (sand). **Flagged, not
   changed:** cross-referencing `business-adaptation.md`'s order-level
   "Entity States" table (line ~205, ~207) surfaces a real divergence —
   `PENDING_PAYMENT` (the order-level equivalent of PayPage's `waiting`) is
   tabled as `pine` ("actionable, not a warning"), and the `PROCESSING`
   bucket (the equivalent of PayPage's `confirming` — see
   `payState()`/routes/checkout.ts, which folds
   `PENDING_VERIFICATION`/`PAID`/`PAYMENT_DETECTED`/`CONFIRMING`/`CONFIRMED`
   into `confirming`) is tabled as `amberx`. PayPage's own hand-rolled chip
   has always paired them the other way around (`waiting`=amberx,
   `confirming`=pine), predating that table. Correcting the pairing to match
   the table would be a real, payment-page-visible color change on states a
   buyer is actively watching mid-transaction — out of scope for a task
   whose brief is "pure re-skin" and whose only sanctioned logic/behavior
   change is the cancel dialog. Not touched; noted here for a future task to
   decide deliberately, with sign-off, rather than as an incidental side
   effect of a component swap. Similarly, `closed` (the catch-all for
   cancelled/rejected/refunded/underpaid/failed) tables as `rust` under
   `FAILED`/`REFUNDED`, but PayPage's chip has always shown it as neutral
   `sand` — same call: flagged, not changed. `Badge.tsx`'s doc comment and
   `Badge.test.tsx` were updated for the new `info` variant only.

3. **`GatewayDownFallback` (PayPage's TokoPay/PayDisini/NOWPayments
   gateway-down block) splits into `<Alert variant="banner" tone="warning">`
   for the icon+title+body message, plus a sibling `flex flex-wrap` row for
   the Try again/WhatsApp/Telegram action links** — not one bordered box, as
   before. `Alert`'s banner variant has no action-row slot (`children`
   renders as inline text under the title), and stuffing block-level
   buttons into it would mean nesting a `<div>` inside the `<span>` Alert
   wraps banner `children` in when a `title` is set — invalid HTML nesting.
   The three action links themselves are untouched raw `<a className="btn
   btn-soft/ghost btn-sm">` (same convention `StatusScreen.tsx`'s
   `ActionControl` already uses for anchor-shaped buttons, since neither
   `Button` nor a router `Link` can render a plain external/full-reload
   `<a>` with `target="_blank"` semantics the way this needs).

4. **The four terminal-state cards (`delivered`/`confirming`/`expired`/
   `closed`) are `<Card className="text-center py-10">`, not a literal
   `StatusScreen`/`EmptyState`.** Per the brief: "don't force them through
   EmptyState/ErrorState unless the shape genuinely matches (a delivered
   success card is not an empty state)." `StatusScreen`'s non-`bare` shape
   also wraps its card in a `min-h-[360px]` viewport-centering box meant for
   a screen that IS the whole page content — wrong here, where these cards
   sit inside PayPage's existing `max-w-2xl` column alongside the Stepper
   and status strip. `Card` + the same `text-center py-10` override the raw
   markup already used is the direct swap; the `.card-pad` (shorthand
   `padding`) + `py-10` (longhand `padding-top`/`padding-bottom`) pairing is
   not new — `StatusScreen.tsx` itself already relies on the identical
   `card card-pad … py-10` combination rendering correctly, so this is a
   proven pattern, not a new cascade risk.

5. **`WalletTopupPage`'s currency toggle uses two `<Button variant="primary"
   | "soft">` inside a `grid grid-cols-2 gap-2`, not a radio group** —
   unchanged from the pre-migration two-button toggle (it was never a native
   radio pair); only the raw `<button className="btn …">` elements became
   `<Button>`.

6. **`PayPage.tsx`'s `cancelMutation` has no `onError` handler — known gap,
   follow-up needed.** Before this task, a failed cancel (e.g. a 409
   "already paid", or a dropped connection) silently re-enabled the Cancel
   button in place — there was no confirmation dialog yet to leave open.
   Now, with the AlertDialog wired in (see "The one logic addition" above),
   a failed cancel leaves the dialog open with the spinner stopped and both
   buttons re-enabled, but nothing tells the shopper the cancel attempt
   actually failed — on a payment page, mid-transaction. It's still
   dismissible (Esc and "No, go back" both work — not a trap), but reads as
   "the button is broken" rather than "that failed, try again." This is
   genuinely new UX surface created by the AlertDialog wiring, not a
   pre-existing bug carried over unchanged. Not fixed here: adding an
   `onError` to `cancelMutation` would touch the mutation definition, which
   this task's hard boundary explicitly forbade (see "Context" above —
   `mutationFn` blocks are byte-unchanged, verified by grep). Needs a
   dedicated small follow-up task: add an `onError` to `cancelMutation` that
   surfaces a friendly failure message — via the AlertDialog's own error
   slot, or an `Alert` in the dialog body; exact copy and placement are
   deferred to that follow-up task, not decided here.

**Also noted (Minor #6 from the review).** `<Alert variant="banner"
tone="error">` (used by `GatewayDownFallback` and `WalletTopupPage`'s
submit-error banner) now renders `role="alert"`, where the pre-migration raw
markup carried no ARIA role at all — a beneficial, previously-undocumented
behavior change: screen readers now announce these interruptively.

**`PaymentMethodRow` re-verification (not re-migration).** `WalletTopupPage`
imports `PaymentMethodRow` from `PaymentMethodSelector.tsx` (already
migrated in Task 13 — `border-2` card-surfaced `<label>` wrapping a
`ui/Radio`). Confirmed its exported prop contract (`value`, `checked`,
`onSelect`, `icon`, `title`, `subtitle`, optional `feeNote`) is unchanged
and `WalletTopupPage`'s call site still matches it field-for-field; the
component itself was not touched by this task. `PaymentMethodSelector.tsx`
was not edited.

**`TrackOrderPage`'s anti-enumeration behavior — confirmed unchanged.** The
single generic `web.track_not_found` failure message, its `FailureState`
routing (`not_found`/`throttled`/`error`), and the full-page `window.
location.assign` redirect on success are byte-unchanged; only the form
markup (now `<Card><form>…</Card>` + `<FormField>`/`<Input>`/`<Button
type="submit">`) changed. No secondary hint text was added to any failure
state.

**Files.** `apps/storefront/client/src/pages/PayPage.tsx`,
`apps/storefront/client/src/pages/PayPage.test.tsx` (cancel-dialog tests:
one existing test replaced by three — open-does-not-mutate,
confirm-mutates, cancel-does-not-mutate — every other test unmodified),
`apps/storefront/client/src/pages/WalletTopupPage.tsx`,
`apps/storefront/client/src/pages/TrackOrderPage.tsx`,
`apps/storefront/client/src/components/ui/Badge.tsx` (new `info` variant),
`apps/storefront/client/src/components/ui/Badge.test.tsx` (one new case),
`packages/core/locales/{en,id}.json` (4 new `web.cancel_order_confirm_*`
keys).

---

## 15-auth — Login/Register/Forgot/Reset migration, PasswordInput + TelegramLoginButton refactor (Task 15)

**Context.** Fase 7d: `LoginPage.tsx`, `RegisterPage.tsx`, `ForgotPage.tsx`,
`ResetPage.tsx`, plus the two shared pieces they compose,
`components/shop/PasswordInput.tsx` and `components/shop/
TelegramLoginButton.tsx`. Same hard-boundary discipline as the payment
migrations (Tasks 13/14): `POST /api/v1/auth/{login,register,forgot,
reset/:token}` payloads, `safeNext()` (client twin of the server's own
open-redirect re-check), the full-page-load redirect on success
(`window.location.assign`, not `navigate()` — a fresh session cookie needs a
fresh document to pick up the new CSRF token) on all four pages, the
Telegram-widget OAuth flow, `ResetPage`'s `GET .../reset/:token/check`
pre-check + its "request a new link" escape hatch, the password-visibility
toggle logic, and the `RegisterPage` Terms/Privacy notice's non-checkbox
nature are all byte-for-byte unchanged. Verified by grepping the diff for
`/api/v1/auth`, `safeNext`, `window.location.assign`, `reset/:token/check`,
`publicPost` — every hit is either an unchanged context line or one of two
new doc-comment sentences (in `RegisterPage.tsx`/`ResetPage.tsx`) that name
these terms in prose; zero hits touch a call, a payload, or the redirect
itself. `AuthBrandPanel.tsx` has **zero diff** — see below.

**1. Template mismatch (once, referenced from all four pages).**
`page-templates.md` §4 describes gogogo.id's auth flow as identifier-only →
OTP: an email/phone step, a Flip consent modal, then a 6-box OTP input with
a resend countdown. This app has no OTP step anywhere — real auth is
identifier+password plus Telegram-widget OAuth (the Task 1 audit already
flagged `ui/OtpInput` as `deferred — no current call site`; still true, not
built here). Per §3.2 rule 3 ("adapt composition, preserve business
functionality"), only the template's **visual shell** was carried over: a
full-screen page with no nav/footer, a centered card + `AuthBrandPanel`
split, no skip-to-content link (the card stays first in DOM order so a
keyboard user tabs straight into the form — unchanged from Task 16). The
identifier/email field maps onto `FormField`+`Input`, the password field(s)
onto `FormField`+`PasswordInput`, the OTP step's full-width primary submit
onto `Button variant="primary" fullWidth`, and Telegram OAuth is kept as a
secondary option below the primary CTA (`TelegramLoginButton`, now itself
`Button variant="soft" fullWidth`). No OTP input or Flip consent modal was
built — there is no business flow behind either.

**2. Banner convention: `Alert` called directly, not `Flash`.** `Flash` is
already an `Alert variant="banner"` shim (Fase 6 Task 7) that renders
byte-identical DOM with `role={false}`. This migration drops the `Flash`
import from all four pages and calls `Alert` directly — the same convention
`CheckoutPage`/`InstantBuyPage`/`WalletTopupPage`/`PayPage` already use — so
every banner in the auth flow now also picks up the spec `role="alert"`/
`role="status"` ARIA role Flash's shim deliberately withheld. `Flash.tsx`
itself is untouched (still a valid shim for other importers) and its own
test suite (`Flash.test.tsx`) is unaffected. Tone assignments, all
presentation-only (copy/keys unchanged):
  - `LoginPage`: the `reset=1` notice is now `tone="success"` (a genuine
    success, not Flash's flat "info" grey); the `err=tg_failed`/
    `err=tg_unlinked` notices are both `tone="error"` (both mean the
    Telegram flow didn't complete); the mutation error banner stays
    `tone="error"`.
  - `RegisterPage`: the mutation error banner is `tone="error"`.
  - `ForgotPage`: the SMTP-unavailable branch is `tone="warning"` (per the
    brief); the sent-confirmation branch is `tone="success"` (was Flash's
    "info"); the rate-limit/other error branch is `tone="error"`.
  - `ResetPage`: the invalid-token banner and the submit-error banner are
    both `tone="error"`.

**3. `AuthBrandPanel` — confirmed already done, zero further work.** The
brief asked to verify Task 9's claim that this file is fully migrated
before touching it. Read against deviations.md's own `D2-radius` entry
(Task 9): `rounded-3xl` already resolves through the `--radius-3xl` `@theme`
mirror (not an unpinned framework default), the panel already uses the
shared `TrustBadgeRow` primitive, and its colours are already
grass/pine-tint tokens (`bg-pine`, `text-pine-tint`, `text-grass`) — no
Tailwind-default amber/violet hues remain. There is no separate CTA on this
panel to reconsider (just the logo link, the trust row, and the policy-link
row). `git diff` on `AuthBrandPanel.tsx` for this task is empty — left
exactly as Task 9/16 built it.

**4. `ResetPage`'s token-check states kept close to their current shape,
not forced onto `LoadingState`/`ErrorState`.** Evaluated both:
  - **Loading** — `LoadingState variant="form"` renders its own `h-8 w-1/2`
    title skeleton plus three label+input skeleton pairs. This page already
    renders its real icon+`<h1>` above the conditional (unconditionally, not
    itself skeletoned) and the actual form only has two fields, so
    `LoadingState`'s shape would put a redundant second title skeleton under
    the real title and skeleton one field too many — a worse layout-shift
    match than the existing centered `<Spinner>`, not a better one. Kept the
    existing small centered spinner, only adding `aria-busy="true"
    aria-label={t("web.loading")}` (the same pairing `LoadingState` itself
    uses) so it announces correctly to assistive tech.
  - **Invalid token** — `ErrorState`'s action slot is hardcoded to exactly
    two shapes: `onRetry` → "Try again" (re-run the query) or no-`onRetry` →
    "Reload page" (`window.location.href` reload). Neither matches this
    page's actual escape hatch, a `<Link to="/forgot">` ("Request a new
    reset link"). Composing `ErrorState` here would mean either losing that
    exact destination/copy or extending `ErrorStateProps` with a
    caller-supplied action — a shared-component change with blast radius
    well outside a page re-skin. Kept the existing `RequestNewLinkNotice`
    (untouched, still its own function) paired with `Alert variant="banner"
    tone="error"` in place of `Flash`.
  Per the brief's own carve-out for this exact situation ("whichever
  preserves the exact copy/escape-hatch behavior with the least new
  markup") — both escape hatches are pixel/behavior-identical to before,
  only their banner primitive changed.

**5. `PasswordInput`/`TelegramLoginButton` — internal refactor only, output
class lists unchanged, confirmed by test.** `PasswordInput` now wraps
`components/ui/Input` instead of a raw `<input>`, forwarding `invalid`
(the prop `FormField.cloneElement` injects on any non-DOM-tag child) straight
through; the show/hide toggle, its two `aria-label` keys, and the "every
prop but `type` passes through" contract are unchanged.
`TelegramLoginButton`'s `<button>` is now `<Button variant="soft"
fullWidth>`; `Button` composes the identical `cn("btn", "btn-soft", "w-full")`
class list the hand-rolled version used, so `TelegramLoginButton.test.tsx`'s
`toHaveClass("btn", "btn-soft", "w-full")` assertion passes unmodified — no
test needed a class-list update.

**6. `RegisterPage`'s Terms/Privacy notice paragraph: `ink-faint` →
`ink-soft`, copy/non-checkbox nature unchanged.** The brief's target styling
names an `ink-soft` paragraph; applied only to this notice, since no test
asserts its text-colour class. The **password-hint** paragraph just above it
(`web.register_password_help`, "At least 8 characters.") keeps
`text-ink-faint` — `RegisterPage.test.tsx`'s "shows the 8-character password
hint…" test pins that exact class pair (`toHaveClass("text-xs",
"text-ink-faint")`), and changing it would be an unrequested, untested-for
visual change smuggled into a boundary-sensitive page. Same reasoning kept
the username-help paragraph (`web.register_username_help`) on `ink-faint`
too, for consistency between the two inline field hints.

**7. Submit buttons: disabled only while the mutation is pending, not
gated on field validity.** The brief's template mapping describes the
primary CTA as "disabled until valid, same as spec's OTP step for the
submit button." None of the four forms track per-keystroke validity today
(native `required`/`minLength`/`pattern` HTML5 validation already blocks an
invalid submit attempt — see `RegisterPage.test.tsx`'s "requires the
fullName field" test, which relies on exactly this). Wiring a
disabled-until-valid gate would mean lifting every currently-uncontrolled
password field into controlled state across four pages, purely to grey out
a button a fraction of a second earlier than the native validation already
does — more new state/logic than a re-skin task should introduce on
auth/session code. Deliberately not added; buttons keep their existing
`disabled={mutation.isPending}` gate, matching `TrackOrderPage`'s and
`WalletTopupPage`'s own submit-button convention.

**8. `ResetPage`'s new-password / confirm-password fields gained a
show/hide toggle.** They were raw `<input type="password">` before this
task and are now `<PasswordInput>` (×2) — additive UI only, no payload or
validation change (the fields still submit the same values to the same
`POST .../reset/:token`). Consistent with the toggle every other password
field in the app already has (Login, Register, Settings). Noted here
explicitly because it is a user-visible behavior addition on a
boundary-sensitive page, not only a restyle. Review follow-up: Task 15
review Minor #1.

**9. `RegisterPage` inline field hints not migrated to `FormField`'s
`hint` prop.** The two field-hint `<p>`s (`web.register_username_help`,
`web.register_password_help`) stay sibling paragraphs rather than being
passed through `FormField`'s `hint` slot, so they remain unlinked from
their inputs via `aria-describedby` — an a11y upgrade `FormField` was
built to provide. Left as-is because `RegisterPage.test.tsx` pins the
password hint's `text-xs text-ink-faint` class pair, and threading it
through `FormField` would change that DOM. Unchanged from before (not a
regression). Review follow-up: Task 15 review Minor #3 — close alongside
a small-print-treatment alignment pass if design wants uniform hint
styling.

**Files.** `apps/storefront/client/src/pages/LoginPage.tsx`,
`apps/storefront/client/src/pages/RegisterPage.tsx`,
`apps/storefront/client/src/pages/ForgotPage.tsx`,
`apps/storefront/client/src/pages/ResetPage.tsx`,
`apps/storefront/client/src/components/shop/PasswordInput.tsx`,
`apps/storefront/client/src/components/shop/TelegramLoginButton.tsx`. No
test files, locale files, or `AuthBrandPanel.tsx` were modified.

---

## 16-account — Account family migration + logout confirmation dialog (Task 16)

**Context.** Fase 7e: `AccountPage.tsx`, `OrdersPage.tsx`,
`OrderDetailPage.tsx`, `ReferralPage.tsx`, `ReviewsPage.tsx` (page-templates.md
§5 + §6). Same hard-boundary discipline as the payment/auth migrations
(Tasks 13/14/15): `POST /api/v1/auth/logout` payload, the `GET
/api/v1/account*` endpoints, every page's `401 → window.location.assign(
"/login?next=…")` guard, the logout-success → `window.location.assign("/")`
full reload, `OrderDetailPage`'s `useSse` stream + its merge logic +
`data?.processing` enable condition + 5s `refetchInterval` poll, the
PROCESSING-only editability of the manual-info form, the `#credentials`
hash-scroll, referral `earned_usdt` Decimal→`formatNativeUsdt`, the copy-link
logic, and the review rating/submit payloads are all byte-unchanged. Verified
by grepping the added-line diff for `/api/v1/account`, `/api/v1/auth/logout`,
`useSse`, `window.location.assign`, `logoutMutation`, `formatNativeUsdt`,
`processing`, `refetchInterval`, `mutationFn`, `5000`, `EventSource` — the
only hits on real code (not comments) are the two AlertDialog props
`onConfirm={() => logoutMutation.mutate()}` and
`confirmPending={logoutMutation.isPending}`, plus the logout trigger's
`onClick` changing from `logoutMutation.mutate()` to
`setLogoutDialogOpen(true)`. `OrderDetailPage`'s only logic-adjacent diff is
the Refresh `<button>` → `<Button>` swap (same `onClick={() => void
refetch()}`, same `disabled={isFetching}`).

**The one logic addition — logout confirmation dialog (required, not
optional).** `AccountPage.tsx`'s logout button (`web.nav_logout`, "Sign out" /
"Keluar") used to call `logoutMutation.mutate()` directly from `onClick` — the
same gap class flagged in the Task 1 audit (§F escalation #3) and required by
the plan's Global Constraints ("Destructive actions … MUST show a
confirmation dialog … Do not silently keep the old direct-execute behavior").
It now opens `<AlertDialog>` (built Fase 6 Task 7), mirroring PayPage's cancel
dialog (Task 14, deviations §14-pay-topup-track):

- Trigger `onClick` → `setLogoutDialogOpen(true)` only; no mutation call.
- `AlertDialog onConfirm` → `() => logoutMutation.mutate()` — the exact same
  call the old `onClick` made, moved verbatim. The mutation's `onSuccess:
  () => window.location.assign("/")` (full reload, CSRF-meta clear) is
  untouched.
- `onCancel` → closes the dialog, no mutation.
- `confirmPending={logoutMutation.isPending}`, `tone="danger"` (→ `<Button
  variant="danger">` confirm), focus starts on Cancel, Esc = cancel — all
  from the `AlertDialog`/`Modal` primitive.
- Copy: **new auth-specific keys** (no PayPage precedent fits — its
  `web.cancel_order_confirm_*` copy is order-specific: "Cancel this order?",
  "Order {code} — this can't be undone."). Four new keys added to both
  `en.json`/`id.json`, no `{placeholder}`s, passing
  `packages/core/src/locales.test.ts`'s key-parity + placeholder-parity
  guard:
  - `web.logout_confirm_title` — "Sign out?" / "Keluar dari akun?"
  - `web.logout_confirm_body` — "You'll need to sign in again to see your
    orders and balance." / "Kamu perlu masuk lagi untuk melihat pesanan dan
    saldo."
  - `web.logout_confirm_yes` — "Yes, sign out" / "Ya, keluar" (danger confirm)
  - `web.logout_confirm_no` — "Cancel" / "Batal" (default cancel)
- The trigger keeps its `ghost` + `text-rust` visual weight (now `<Button
  variant="ghost" className="… text-rust …">`), same call as PayPage's
  cancel trigger — the required change is the confirmation step, not the
  trigger's prominence.
- `AccountPage.test.tsx`: the single existing "logout posts … then assigns /"
  test is replaced by a 3-case `describe` block — click-opens-dialog-no-POST,
  confirm-POSTs-and-assigns-"/", cancel-closes-no-POST. The
  `window.location.assign("/")` assertion is preserved verbatim in the
  confirm case (a confirm-click was added before it, nothing about the
  assertion changed). Every other AccountPage test is unmodified; 16/16 pass.

**Deviations, all deliberate:**

1. **No `page-templates.md` §5 "info rows" — this account page has no
   email/phone/region to list.** §5's body is a list of *info rows* (Email,
   Nomor Telepon, Region dan Bahasa, Bantuan — icon + label + value +
   chevron). `AccountData` carries only
   `name`/`order_count`/`referral_code`/`wallet_idr`/`wallet_usdt` (no email,
   no phone, no fx rate — the page's own header comment says so). The page
   was already restructured (Task 11) into an identity block + a
   wallet/orders/referral **summary-tile grid** + a grouped **nav menu**
   whose rows *are* the icon + label + description + chevron shape §5
   describes, just pointing at destinations rather than showing scalar
   values. Kept that structure; the migration re-skinned its panels onto
   `<Card>` and left the `stat-label`/`stat-value`/`stat-sub` type roles
   (already present from Task 11) in place. §3.2 rule 1 ("adapt composition,
   preserve business functionality" — a minimal reference template is not a
   licence to invent an email row for data the API doesn't return).

2. **`SummaryCard` keeps `.card`/`.card-pad` utility classes on its
   `<Link>`/`<button>` elements rather than nesting a `<Card>`.** `Card` is a
   `<div>` with no polymorphic `as`/`asChild`; the summary tiles are `<Link>`
   (Orders, both wallet balances) or `<button>` (Referral, tap-to-copy)
   whose hover treatment must live on the interactive element itself. This
   is the established storefront pattern (deviations §9-home item 5,
   §11-product-detail) — apply `card card-pad …` directly on the link/button.
   The plain-`<div>` panels that *aren't* interactive (identity block,
   Recent Orders widget, the two grouped-menu containers) did become
   `<Card>`.

3. **No `rounded-3xl` on AccountPage.** §5 mentions a "decorative header
   background image" (gogogo.id's). This page's identity block is a plain
   `.card` (16px radius) with an avatar initial, no decorative band — nothing
   to resolve against the `--radius-3xl` mirror. (The `--radius-3xl` note in
   the brief was a "if it uses `rounded-3xl`" conditional; it doesn't.)

4. **Grouped-menu containers → `<Card padded={false}>`.** They hold
   full-bleed `MenuRow` links with their own `px-4 py-3` padding and
   `divide-y` separators, so the card must not add its own `.card-pad`
   inset — `padded={false}` composes `.card` (border + radius +
   `shadow-soft`) without `.card-pad`. Same for `OrderDetailPage`/`OrdersPage`
   table wrappers (a `.data-table` owns its own cell padding).

5. **`OrdersPage` gains a filter row (search `Input` + status `Select`) —
   net-new UI, entirely client-side.** §6's template has "a pill search field
   + a select dropdown (`Semua Status ▾`)"; this page had neither. Added, but
   the endpoint still returns the full list and **no query param is sent** —
   `data.orders` is filtered in the component (`code`/`items` substring +
   exact status match). The row renders **only when `data.orders.length > 1`**
   (a filter over ≤1 order sorts nothing — SortSelect's own
   "products.length > 1" precedent, deviations §10-listing item 2), which
   also keeps the existing 1-order and 0-order tests collision-free (the
   status `<option>` labels would otherwise clash with a `StatusBadge` chip's
   text under `getByText`). Status option labels come from a new exported
   `statusLabel(value)` helper in `StatusBadge.tsx` (same keyed-`t()`
   resolution the chip uses) so the filter and the chips can never show
   different words for the same status.

6. **`OrdersPage` empty state now distinguishes two states (§16).**
   `data.orders.length === 0` → the existing "No orders yet" `EmptyState`
   (suggestions shelf + catalogue CTA, unchanged). Filtered-to-nothing →
   a distinct `EmptyState` (`web.orders_no_match` /
   `web.orders_no_match_desc`, 5 new keys incl. `web.orders_filter_search` /
   `web.orders_filter_all_status` / `web.orders_filter_clear`) followed by a
   `<Button variant="soft">` that resets the filter — `EmptyState`'s `action`
   only supports `to`/`href`, not an `onClick`, so the reset control is a
   sibling button rather than the card's primary action.

7. **Entity-state colours — checked, no divergence to flag on these pages.**
   Task 14 flagged a `waiting`/`confirming`/`closed` tone divergence, but
   that was against PayPage's `PayState` strings (a payment-flow enum), not
   order statuses. `OrdersPage`/`OrderDetailPage`/`AccountPage` all render
   order statuses through the shared `StatusBadge`, whose mapping matches
   `business-adaptation.md`'s "Entity States" table:
   `pending_payment`→`pine`, `processing`→`amberx`, `delivered`→`grass`,
   `cancelled`/`rejected`/`refunded`/`failed`→`rust`,
   `partially_delivered`→`amberx`. No `StatusBadge` change made; nothing to
   flag.

8. **`ReviewsPage` rating control stays a native `<select>` (now `ui/Select`
   in a `FormField`), not a star-input.** Per the brief's explicit
   carve-out: a 5..1 numeric picker is a plain-select case, not an ambiguous
   one. `FormField` wires the `<Label htmlFor>` ↔ control id so
   `getByLabelText("Your rating")` still resolves; a `w-24!` width cap keeps
   the select from stretching to `.field`'s full width (the pre-existing
   `w-20!` cap, a Tailwind v3→v4 rename leftover, is replaced by `w-24!` —
   two more characters of label fit "5 ★"). Comment box →
   `ui/Textarea`; submit → `<Button type="submit">`. The `ReviewCard`
   comment `<p>` keeps its exact `text-sm text-ink-soft mt-2
   whitespace-pre-line break-words` class list (pinned by a test).

9. **`ReferralPage` bang-override cleanup, scoped.** Dropped the `text-2xl!`
   size cap on the referral **code** (it now takes the full `.stat-value`
   30px role, `+ break-words` so a long code still wraps) and the `text-xs!`
   cap on the referral-**link** `<Input>` (it now takes `.field`'s own
   16px→14px). The two summary **tiles** keep their `text-xl!` cap —
   consistent with AccountPage's `SummaryCard` tiles, which also cap
   `stat-value` at `text-xl!`/`text-2xl!` so a long `formatNativeUsdt` value
   doesn't overflow a half-width tile; unifying those is a cross-page
   type-scale decision, not this task's.

10. **`OrderDetailPage` — `page-title text-2xl!` bang dropped**
    (`.page-title` already resolves 24px→30px; the `!important` was
    redundant — deviations §11-product-detail item 9 precedent). The
    `codeish text-sm!` caps on the credential / delivered-content `<code>`
    blocks are **left as-is** (not named by the brief, and shrinking the
    already-small `.codeish` 12px further is not the goal). The
    `digiflazz_status` `pending`/`reviewing` sub-status lines inside the
    PROCESSING card stay token-styled hint text (`text-xs text-ink-soft`) —
    the brief allowed "token hints **or** a small `Alert`", and a bordered
    `Alert` box nested in the small reassurance card would over-weight a
    one-line status note. The `infoErrorKey` block (mid-edit-race / field
    error) **did** become `<Alert variant="banner" tone="error">` — it's a
    genuine error banner, and now picks up `role="alert"` where the
    hand-rolled `<div>` had no ARIA role.

11. **`<section>` / `<ul>` elements keep `.card` utility classes rather than
    nesting a `<Card>` `<div>`.** `OrderDetailPage`'s info / credentials /
    delivered-content `<section>`s (the credentials one must keep
    `id="credentials"` for the hash-scroll) and its mobile item-list `<ul>`
    stay semantic elements with `card card-pad …` applied directly — same
    reasoning as item 2. Plain wrapper `<div>`s (pending-payment card,
    PROCESSING card, totals card, desktop item-table wrapper) became
    `<Card>`.

**Files.** `apps/storefront/client/src/pages/AccountPage.tsx`,
`apps/storefront/client/src/pages/AccountPage.test.tsx`,
`apps/storefront/client/src/pages/OrdersPage.tsx`,
`apps/storefront/client/src/pages/OrderDetailPage.tsx`,
`apps/storefront/client/src/pages/ReferralPage.tsx`,
`apps/storefront/client/src/pages/ReviewsPage.tsx`,
`apps/storefront/client/src/components/shop/StatusBadge.tsx` (new exported
`statusLabel`), `packages/core/locales/{en,id}.json` (4 `web.logout_confirm_*`
+ 5 `web.orders_*` keys). No test file other than `AccountPage.test.tsx` was
modified; no SSE/poll/`window.location.assign` assertion was changed anywhere.

---

## 17-support — Support + TicketDetail + Settings migration, the §26.2 chat/thread extension (Task 17)

**Context.** Fase 7f migrates `SupportPage.tsx`, `TicketDetailPage.tsx`,
`SettingsPage.tsx` and the seven ticket domain components (`TicketMessageThread`,
`TicketComposer`, `TicketSidebar`, `TicketOrderSummaryCard`, `TicketStatusBadge`,
`AttachmentGallery`, `AttachmentPicker`). Pure re-skin — no support/settings
endpoint, payload, the multipart create-ticket / reply flow, the
`ticketDraft.ts` debounced-localStorage autosave, the `ticketTimeline.ts` merge
builder, the `Ctrl/Cmd+Enter` submit shortcut, the `ticketAttachments`
size/type limits, the quick-reply templates, the `SettingsPage`
`/credentials` payload, the server-driven Telegram-link redirect
(`?saved=1` / `?linked=1` / `?err=…`) or the `401 → window.location.assign`
guards changed. Verified by grepping the diff for `/api/v1/account/support`,
`/api/v1/account/settings`, `ticketDraft`, `ticketTimeline`, `metaKey`/`ctrlKey`,
`window.location.assign`, `FormData`/`apiPostFormWithProgress` — every hit is
the same expression re-indented or moved into a primitive's prop, never a
changed value, endpoint or handler.

**Deviations, all deliberate:**

1. **§26.2 extension — the ticket chat/thread pattern (`extensions.md` entry
   added, NOT a §28.2 escalation).** `components.md` has no template for a
   message-bubble timeline. The Task 1 audit marked `TicketMessageThread` /
   `TicketComposer` as `build`; in fact `TicketMessageThread` already composed
   `.card`/`.card-pad` + `bg-pine-tint/30` + `bg-sand` + the spacing scale, so
   it was a token-composed `refactor`/`adopt`, not a from-scratch build. It was
   refactored **in place** onto the `<Card>` primitive (bubble = `<Card>`
   surface), not rebuilt; the bubble geometry is byte-unchanged — customer
   right/`pine-tint/30`-tinted, support left/neutral, system events centered,
   per-date dividers, `text-sm whitespace-pre-line break-words` message body.
   The one off-scale value, the `text-[11px]` avatar initial, is now the
   `text-2xs` utility (`--gg-text-2xs`, Task 6a extension row) — which **removed
   `src/components/shop/TicketMessageThread.tsx` from the ESLint Group-B
   `text-[11px]` allowlist** in `apps/storefront/client/eslint.config.js`.
   `TicketDetailPage.tsx` stays in Group-B for its `grid-cols-[1fr_320px]`
   side-rail layout (unchanged). Logged in
   `docs/implementation/extensions.md` under "Component-pattern exceptions": no
   new hue, radius or shadow; derived entirely from `Card` / `pine-tint/30` /
   `pine`-`sand` avatar circle / 4px spacing / `text-xs ink-faint` timestamps.
   No pricing/auth/legal/destructive semantics, so **not** a §28.2 escalation.

2. **§8 is FAQ-only; this shop's `/account/support` is a ticket inbox +
   creation form (superset kept).** `page-templates.md` §8 "Support" is a
   FAQ page (FAQ H2 → accordion → help-CTA card → legal/regulator block).
   `business-adaptation.md` ("Pages" row + "Terminology": *"Layanan Pengaduan
   Konsumen" → Support tickets + FAQ on Home … not a static
   FAQ-plus-regulator-block page. FAQ content lives in the Home FAQ accordion.
   Any regulator/company-entity disclosure is shop-configured, not a fixed
   block*) is explicit that this app runs a real ticketing system here — a
   business feature the reference site never had. So **no FAQ accordion and no
   legal/regulator block were added to `SupportPage`** (that §8 treatment
   already lives on `HomePage`, Task 9); the existing ticket inbox
   (table↔cards) + new-ticket form were kept and re-skinned: the new-ticket
   `<textarea>`/`<select>` → `<FormField>` + `<Textarea>` / `<Select>`, the
   submit → `<Button>`. Per FRONTEND_IMPLEMENTATION_PROMPT §3.2 rule 1 ("adapt
   composition, not invention"): a minimal reference template is not a licence
   to strip a working business feature.

3. **Ticket sidebar sections keep native `<details open>`, not `ui/Accordion`.**
   `TicketSidebar` / `TicketOrderSummaryCard` render each section
   (`order summary`, `trust`, `recent tickets`, `help`) as its own `<details
   open className="card card-pad">` — a **stack of separate cards**, each
   independently collapsible, always-expanded on desktop. `ui/Accordion` takes
   a single `items` array and renders **one** card with `divide-y` dividers;
   moving to it would merge the four cards into one panel and lose the
   stacked-card visual and the per-section `open` default. The brief allows
   either and calls native `<details>` "fine and lighter"; kept as-is (already
   token-clean — `section-title`, `text-ink-soft`, `bg-grass`, `border-line`).
   Only the real `<button>` controls in these two files (the copy-order-code
   button) moved to `<Button>`; the `<Link className="btn …">` /
   `<a className="link">` elements stay utility-classed (`<Button>` is
   `<button>`-only — established pattern, deviations §9 item 5).

4. **No canonical-label fix on `SettingsPage`.** The brief flags a possible
   "Simpan" vs "Simpan perubahan" conflict. There is none: `business-adaptation.md`'s
   CTA Register has **two distinct rows** — `Simpan / Save` = "Save account
   credential changes" (`…/credentials`, primary) and `Simpan perubahan / Save
   changes` = "Persist edited order delivery info" (`PATCH …/info`, primary
   `-sm`). `SettingsPage`'s button is `web.settings_save` = "Simpan" / "Save",
   which already matches the credential-save row. No key changed.

5. **`TicketStatusBadge` token-aligned onto `<Badge>`, kept a separate
   component.** Per the Task 1 audit it stays a distinct component (ticket-
   specific copy the shared `StatusBadge` can't carry). Its hand-rolled
   `chip <tone>` class list is now `<Badge variant={…} icon={…}>`:
   OPEN/`waiting_admin` → `info` (pine chip), REPLIED/`waiting_customer` →
   `pending` (amberx chip), CLOSED → `success` (grass chip), unknown →
   `neutral` (sand chip) — the same tint/tone pairing it already had, now
   drawn from the shared `components.md` "Badge & chip" vocabulary. The
   `LABEL_KEY` / `ICON` maps and the raw-value fallback are unchanged; the
   `business-adaptation.md` "Support-ticket states" tone note (OPEN as `pine`
   in `TicketStatusBadge` vs `amberx` in the list `StatusBadge`) is preserved.
   Icon-to-text gap goes from `gap-1` (4px) to `.chip`'s own `gap-2` (8px) —
   an accepted consequence of adopting the shared chip.

6. **`AttachmentPicker` / `AttachmentGallery` left essentially as-is.** Both
   are already token-clean (`bg-sand` / `text-ink` / `border-line` /
   `bg-line/40` / `bg-ink/5` / `rounded-md`). `AttachmentPicker`'s attach
   trigger is a neutral **sand** button with no matching `<Button>` variant
   (`soft` is `pine-tint`); converting it would change its look or need a new
   variant — out of scope. `AttachmentGallery` the brief explicitly says
   "stays". The upload flow / size-type limits are on the HARD BOUNDARY.

7. **`SettingsPage` status banners → `<Alert variant="banner">`, including the
   "linked as {name}" confirmation.** The three query-param flashes
   (`?err=…` → `tone="error"`; `?saved=1` / `?linked=1` → `tone="info"`), the
   credentials-POST error (`tone="error"` — `<Alert>` carries `role="alert"`
   itself, so the wrapper `<div role="alert">` was dropped; the
   `within(form).getByRole("alert")` test still passes), and the persistent
   `tg_linked` confirmation (was a hand-rolled `rounded-xl border
   border-grass/30 bg-grass-tint` row with a custom icon circle) → `<Alert
   variant="banner" tone="success">`. `Flash` (and the `CheckCircle` import)
   are no longer used on this page.

8. **`TicketComposer` / `SupportPage` / `TicketDetailPage` `.btn` buttons →
   `<Button>`; textareas → `<Textarea>`.** `TicketComposer`'s reply textarea
   → `<Textarea>` (keeps `onKeyDown` Ctrl/Cmd+Enter, `maxLength`, the char
   counter, the `saveTicketDraft` debounce `useEffect` verbatim); its submit
   and `SupportPage`'s send + `TicketDetailPage`'s reopen / "issue solved" /
   quick-reply buttons → `<Button variant="soft|primary" size="sm">`. The
   quick-reply chips stay in their `flex flex-wrap gap-2` row and still call
   `applyTemplate` (fills the composer, never submits). `TicketDetailPage`'s
   thread card + closed-state banner → `<Card>`.

**No test file was modified.** All six suites
(`SupportPage`/`TicketDetailPage`/`SettingsPage`/`TicketMessageThread`/
`TicketComposer`/`TicketOrderSummaryCard`/`TicketStatusBadge`) pass unchanged
against the re-skin — selectors are label text / placeholder / role / rendered
copy, none of which moved.

**Files.** `apps/storefront/client/src/pages/SupportPage.tsx`,
`apps/storefront/client/src/pages/TicketDetailPage.tsx`,
`apps/storefront/client/src/pages/SettingsPage.tsx`,
`apps/storefront/client/src/components/shop/TicketMessageThread.tsx`,
`apps/storefront/client/src/components/shop/TicketComposer.tsx`,
`apps/storefront/client/src/components/shop/TicketStatusBadge.tsx`,
`apps/storefront/client/src/components/shop/TicketOrderSummaryCard.tsx`,
`apps/storefront/client/eslint.config.js` (Group-B allowlist: `TicketMessageThread` removed),
`docs/implementation/extensions.md` (§26.2 chat/thread row).

---

## 18-content — Content / legal pages to the §7 prose treatment (Task 18)

**Context.** Fase 7g migrates the five informational pages (`AboutPage`,
`HowToOrderPage`, `TermsPage`, `PrivacyPage`, `RefundPage`) — all thin wrappers
over `components/shop/StaticPage.tsx` — plus `components/shop/StepTimeline.tsx`.
Pure re-skin: no copy, no `t()` key, no route, and `spaShell.ts` (the crawler
shell / cloaking guard) untouched.

**The §7 mismatch, resolved (page-templates.md §7 vs §3.2 rule 3).** §7 wants
"a single narrow prose column (~768px), H1 + long-form body, no card chrome,
text on `paper`". The shell rendered EVERY block through `StepTimeline`
(numbered badge + icon + connector) — a step-sequence treatment. Split by what
each page actually is:

- **`/terms`, `/privacy`, `/refund` → plain prose.** These are §7's own
  reference language (legal/compliance copy, §28.2). `<article>` at
  `max-w-3xl` (= 48rem = 768px, the `--gg-container-prose` value exactly),
  `<h1>`/`<h2>` `font-display font-semibold` (Outfit 600 per §7), paragraphs
  `text-base leading-relaxed text-ink-soft`, `space-y-8` between sections, no
  `.card`, no numbered badges. Per-block warning/tip Callouts are preserved
  (terms block 3, refund blocks 1–2, privacy block 4) — same `Alert
  variant="panel"` shim as earlier phases, just no longer inside a badge.
- **`/how-to-order` → keeps `StepTimeline` (`variant="timeline"`).** It is a
  genuine ordered sequence (pick a plan → check out → pay → receive) with a
  merged QRIS/USDT payment step via the `render` escape hatch — the §3 "Cara
  Top Up" numbered-steps pattern, not §7 prose.
- **`/about` → prose (judgment call, noted).** Its four blocks are
  informational topics — "What we sell", "How your order is processed",
  "Hours", "How to reach us" — not an ordered procedure. Only block 2 has any
  sequence flavour, and it reads fine as a standalone section. Treated as the
  legal pages are; the generic per-block `FileText` icon it used to get added
  nothing and is dropped.

**Approach: a `variant?: "prose" | "timeline"` prop on `StaticPage` (default
`"prose"`), not a shell split.** The title / intro / end-of-page help-CTA are
identical across both treatments; only the middle differs (a `ProseBody` vs a
`TimelineBody` sub-component in the same file). A two-file split would
duplicate the shared chrome and the `_hN`/`_pN` block loop for no gain. The
`StaticPageProps` API stays source-compatible; `StaticPageStep.icon` is
**widened to optional** (prose pages have no badges, so the four legal/about
callers pass `steps` only for the `callout` config or omit it entirely) —
`TimelineBody` falls back to `FileText` when an icon is absent, so the one
timeline caller is unaffected. All five callers are updated in the same change.

**Token-alignment (design-system, Task 4 gate — token-only):**

- `StaticPage` help-CTA: hand-rolled `rounded-2xl border border-line bg-card
  p-6 shadow-xs` box → `<Card>`; hand-rolled `bg-pine px-4 py-2.5 …
  hover:bg-pine-dark` link → `<Link className="btn btn-primary">` (link-as-
  button, consistent with HomePage). No `!` bangs were present.
- `StepTimeline`: step-number badge `text-[11px]` → `text-2xs` (the
  `--gg-text-2xs` / `--text-2xs` token, same swap Task 17 did for
  `TicketMessageThread`); its Group-B ESLint allowlist entry is **removed** —
  `text-[11px]` was its last arbitrary value (verified: no other `-[…]` in the
  file). Stacked-layout heading `font-bold` → `font-semibold` (Outfit 600,
  matches the prose headings; only affects `/how-to-order`, the sole stacked
  caller — HomePage uses `layout="grid"`).
- `HowToOrderPage` merged payment step: the two `rounded-2xl border border-line
  bg-card p-5 shadow-xs` cards → `<Card>`.
- `PrivacyPage` analytics block (`children`): de-chromed from a `rounded-2xl …
  shadow-xs` card with an icon well to a plain prose `<section>` (`<h2>` +
  info `Callout`), matching the crawler shell.

**Minor deviation from §7's "16px/1.5":** paragraph body uses `leading-relaxed`
(1.625), not 1.5 — consistent with every other body-copy block in the
storefront and easier to read down a full-width legal column. Line-height is
the only §7 number not taken literally.

**HARD BOUNDARY held — verified.** ZERO copy changed: `git diff` for
`web.terms_`/`web.privacy_`/`web.refund_`/`web.about_`/`web.hto_`/`web.how_`
shows hits only for `web.static_help_*` and `web.privacy_analytics_h` — both
same key, className/indent change only; no key added, removed, renamed or
reordered. `spaShell.ts` is **not in the diff**. Cross-checked
`spaShell.ts`'s `STATIC_PAGES` (about=4, hto=5, terms=5, privacy=5, refund=5
blocks; privacy's conditional `privacy_analytics_h/p` under the same
`analyticsOn` flag): every migrated page renders the same `t()` prefixes, the
same block count, and the same order the shell emits.

**Tests.** New `components/shop/StaticPage.test.tsx` (prose renders section
`<h2>`s and no `<ol>`/`<li>` timeline; `variant="timeline"` renders the
`StepTimeline` `<ol>` with one `<li>` per step). `PrivacyPage.test.tsx` and
`StepTimeline.test.tsx` pass unchanged. Full `apps/storefront/client` suite:
96 files / 744 tests green. `lint` exit 0, `typecheck` clean, `build` succeeds.

**Files.** `apps/storefront/client/src/components/shop/StaticPage.tsx`,
`apps/storefront/client/src/components/shop/StepTimeline.tsx`,
`apps/storefront/client/src/pages/AboutPage.tsx`,
`apps/storefront/client/src/pages/HowToOrderPage.tsx`,
`apps/storefront/client/src/pages/TermsPage.tsx`,
`apps/storefront/client/src/pages/PrivacyPage.tsx`,
`apps/storefront/client/src/pages/RefundPage.tsx`,
`apps/storefront/client/src/components/shop/StaticPage.test.tsx` (new),
`apps/storefront/client/eslint.config.js` (Group-B allowlist: `StepTimeline` removed).

---

## 19-default-thumbnail — IP-safe default thumbnails + admin-configurable currency icon (Fase 12)

**Context.** Before this work, a product with no admin-set photo fell back to
a hardcoded Unsplash stock photo, keyed by a substring match against the
admin's free-text category name (`CATEGORY_IMAGES` in
`apps/storefront/src/images.ts`, plus a `PLACEHOLDER` default) — off-brand,
fragile (any category name that didn't match a needle silently got the wrong
stock photo), and a pointless third-party dependency for a shop that already
has its own product catalog. `DenominationCard` had no currency-icon concept
at all — every plan tile was plain text. Fase 12 (1) replaces the Unsplash
fallback with a business-agnostic design-system placeholder
(`DefaultThumb.tsx`, a lucide icon in a tinted well, zero external image
request), (2) makes BOTH the placeholder style and a new denomination
currency-icon chip admin-configurable per product via two new nullable
`Product` columns (`thumbnailKind`, `currencyIconKind` — additive Prisma
migration) rather than purely auto-guessed, and (3) never surfaces either
admin control, and never renders a currency-icon chip, for products in a
`PREMIUM_APPS`-group category — those rely solely on their own uploaded photo
plus a neutral generic placeholder.

**Rule cited:** FRONTEND_IMPLEMENTATION_PROMPT §14 (IP guardrails — no
unlicensed/unverified third-party asset shipped in the production bundle).

**The resolution rule**, verified against the current
`apps/storefront/src/images.ts` and `apps/storefront/src/denomIcon.ts`:

- **Thumbnail placeholder** (`defaultThumbKind(product, category)`, only
  consulted when `Product.webImageUrl` is absent — a real admin-uploaded
  photo always wins over any placeholder, untouched by this work):
  1. `category.group === "PREMIUM_APPS"` → always `"generic"`, unconditionally
     overriding even a set `product.thumbnailKind` (so a category reclassified
     to `PREMIUM_APPS` after an admin set a game-ish override can't keep
     showing game art off stale data).
  2. else `product.thumbnailKind`, when it's one of the six recognized kinds
     (`game` / `voucher` / `steam` / `entertainment` / `app` / `generic`).
  3. else a heuristic: `category.group === "GAME_TOPUP"` → `"game"`, else the
     first needle from the old `CATEGORY_IMAGES` category-name substring list
     (re-targeted from Unsplash URLs to icon kinds, pruned to the kinds this
     resolver distinguishes), else `"generic"`.
- **Denomination currency-icon chip** (`resolveDenomIconKind`, resolved ONCE
  per product — not per-denomination, since every SKU under one product
  shares the same in-game currency — and passed down as an `iconKind` prop to
  every `DenominationCard` on both `ProductPage.tsx` and
  `InstantBuyPage.tsx`):
  1. `category.group === "PREMIUM_APPS"` → always `null` (no chip renders,
     full stop — same unconditional-override shape as the thumbnail rule).
  2. else `product.currencyIconKind`, when it's one of the five recognized
     kinds (`diamond` / `coin` / `key` / `card` / `voucher`).
  3. else a heuristic on the cheapest active denomination's `qtyUnit`
     (case-insensitive substring match against `diamond`/`uc`/`cp`/`coin`/
     `gold`/`point`), then `category.group === "GAME_TOPUP"` → `"diamond"`,
     else `null` — better to show no chip than guess wrong.

**§14 IP note — corrects two assumptions in an earlier planning draft.**
That draft assumed a `gogogo-frontend/assets/catalog/` folder existed with
134 product key-art images that could seed dev/test data. **It does not
exist** — verified directly (`ls gogogo-frontend/assets/catalog` → nothing;
`gogogo-frontend/assets/` has only one subfolder, `icons/`). The only
reference-art folder that exists is `gogogo-frontend/assets/icons/` — 50
per-game (plus one shared `_currency-generic/`) subfolders holding 58 icon
files total (some games, e.g. `free-fire/`, have several), plus the folder's
own top-level `README.md` (59 files counted recursively), described by that
README as gogogo.id's own small **denomination-card**
icons pulled for reference, not full product photography, with an explicit
"swap in your own currency iconography before shipping" note. Since this
task's admin-configurable currency icon turned out to be a **preset dropdown
rendered as a lucide icon** (`ICON_KIND_ICONS` in `DenominationCard.tsx` —
`Gem`/`Coins`/`KeyRound`/`CreditCard`/`Ticket`), not an image asset at all,
`assets/icons/` ended up NOT used by the currency-icon feature itself. Its
only actual use anywhere in this plan is as substitute image bytes for the
dev-seed script (`tests/e2e/seed-thumbs.ts`, commit `25c31d55`) to exercise
the "admin uploaded a real photo" WebP-srcset rendering path visually during
manual QA. The script itself is committed and tracked (not gitignored — its
commit subject's "(gitignored)" tag is a misnomer); what is gitignored is
only its *output*, the `data/uploads/**` tree. It reads two files from
`gogogo-frontend/assets/icons/` at dev time and copies them into that
ignored tree — it never commits or ships any of those bytes. Confirmed
directly: `git diff --stat af54e943..HEAD -- gogogo-frontend data` is empty,
`git show --stat 25c31d55` touches exactly one file
(`tests/e2e/seed-thumbs.ts`), and every file under `gogogo-frontend/` is
tracked only as the pre-existing reference set (`git ls-files
gogogo-frontend/`), none of it copied into `data/uploads/` at commit time.
Net: this repo ships
**zero** third-party/gogogo.id imagery in its production bundle — every
default visual is a generated design-system placeholder (lucide icon + token
colours), and the one real per-product photo path (`Product.webImageUrl`) is
100% admin-uploaded original content via the pre-existing web-admin upload
flow.

**Token-alignment.** `DefaultThumb.tsx`'s well and `DenominationCard.tsx`'s
new icon chip both use only pre-existing design tokens — `bg-pine-tint` for
the tinted background, `text-pine` for the icon colour (identical pairing in
both files) — no new arbitrary Tailwind values were introduced anywhere in
this plan; the ESLint Group-A/Group-B arbitrary-value gate stayed green
throughout with no allowlist changes required.

**New functionality, not a closed deviation.** Checked
(`grep -in "denomination.*icon\|currency" deviations.md` before writing this
entry): no prior entry in this file mentions a denomination/currency-icon
concept — the only hits are unrelated (`WalletTopupPage`'s IDR/crypto
currency *toggle*, §14-pay-topup-track). `DenominationCard` simply had no
currency-icon slot before Fase 12; this entry documents new capability being
added, not something being closed out.

**Commits** (this branch, chronological):

- `396d0faf` feat(db): add Product.thumbnailKind + currencyIconKind
- `409458af` feat(web-admin): admin controls for thumbnail style + currency icon
- `5f33b327` feat(storefront): IP-safe design-system default thumbnails, admin-overridable
- `8143a7ce` fix(storefront): guard cart/instant-buy image fallbacks against nullable image
- `307d5c20` feat(storefront): denomination currency-icon slot, admin-overridable, hidden for PREMIUM_APPS
- `25c31d55` chore(storefront): local dev thumbnail seed for visual QA (gitignored)

**Files.** `prisma/schema.prisma` + migration, `packages/db/src/crud/catalog.ts`,
`apps/web-admin/src/routes/api/catalog.ts`,
`apps/web-admin/client/src/pages/ProductDetailPage.tsx`,
`apps/storefront/src/images.ts`, `apps/storefront/src/denomIcon.ts` (new),
`apps/storefront/src/cards.ts`, `apps/storefront/src/pageData.ts`,
`apps/storefront/src/routes/api.ts`, `apps/storefront/src/routes/cart.ts`,
`apps/storefront/client/src/components/shop/DefaultThumb.tsx` (new),
`apps/storefront/client/src/components/shop/DenominationCard.tsx`,
`apps/storefront/client/src/components/shop/ProductCard.tsx`,
`apps/storefront/client/src/pages/ProductPage.tsx`,
`apps/storefront/client/src/pages/InstantBuyPage.tsx`,
`apps/storefront/client/src/pages/CartPage.tsx`,
`apps/storefront/client/src/api/types.ts`,
`tests/e2e/seed-thumbs.ts` (new, committed; dev-only — writes only into the
gitignored `data/uploads/` tree, ships no bytes).

---

## 20-nested-surface — `.card-2`: containment depth may use a fill; §6's shadow-only rule now covers interaction depth only (/help)

Type: §26.1 amendment to a documented design-system rule. **Written before the
code/spec change, per §26.1.**

**The rule as it stood.** `apps/storefront/client/src/styles/tokens.css` §6
ELEVATION ends with:

> Depth = white `.card` on `--paper` + `--gg-shadow-soft` + 1px `--line` border.
> Hover / active states step up to `--gg-shadow-lift`, **not a darker fill**.

Read literally, that forbids ever expressing depth with a background change.

**The requirement it collides with.** `/help` is the first storefront surface
that genuinely nests one card inside another (the closed-ticket notice inside
`InlineTicketPanel`'s `card card-pad` section; the staged-attachment rows
inside `NewTicketCard`'s `card` form). The user's requirement for this page is
that nesting be a real, named pattern and that *"jangan ada yang nyaru"* —
nothing may blend into its container. A second **white** `.card` on a white
`.card` is exactly that camouflage: `--card` on `--card`, separated only by a
1px `--line` hairline and a soft shadow that a white-on-white pairing barely
resolves. `EvidenceUploader`'s staged-file rows
(`rounded-md border border-line bg-card` inside the white form) are the
concrete instance already on the page today.

**The amendment.** §6's rule is split into its two real halves:

- **Interaction depth — unchanged, still shadow-only.** Hover / active / press
  states step `--gg-shadow-soft` → `--gg-shadow-lift`. They must not recolour
  a surface. This is the half the original sentence was written for, and every
  existing consumer (`.card`, `ProductCard`, the category tiles) keeps it.
- **Containment depth — may use a fill (new).** A panel nested *inside* a card
  is a different axis from a card reacting to a pointer. L1 is a **raised**
  white card on `--paper`; L2 is a **recessed** `--sand` panel inside it — not
  a second raised white card. A recessed inset reads as recessed precisely by
  being darker than its container and casting no shadow of its own, which is
  what makes it impossible to confuse with the surface it sits on.

`tokens.css` §6's comment is updated to state both halves rather than only the
first.

**The implementation.** Two plain classes next to `.card` in
`apps/storefront/static/app.css` (same layer, same file, so they inherit the
"authoritative CSS" precedence the rest of the component layer has):

```css
.card-2     { background: var(--sand); border: 1px solid var(--line);
              border-radius: var(--r-md); box-shadow: none; }
.card-pad-2 { padding: 1rem; }
```

`--r-md` (12px), one step below `.card`'s `--r-lg` (16px): an inset must never
carry a larger corner radius than the container it sits in, or the two
outlines visibly fight along the shared edge. `box-shadow: none` is explicit,
not incidental — the absence of a cast shadow is half of what makes L2 read as
recessed rather than raised. `card-pad-2` is a flat `1rem`, deliberately
*not* the responsive 1.25→1.5rem of `.card-pad`: an inset does not need to
grow with the viewport the way its container does, and a nested panel that
tracked its parent's padding would eat the width it saves.

**Nesting is capped at depth 2 on this page.** There is no `.card-3`, and none
should be added: a third level has nowhere left to go except back toward white
(re-introducing the camouflage) or darker still (which starts reading as a
disabled/inactive surface, a meaning `--sand` does not otherwise carry).

**Applied at two sites, both already-existing surfaces:**

1. `InlineTicketPanel.tsx`'s closed-ticket notice had reached the right answer
   ad hoc — `card card-pad … bg-sand`, i.e. a `.card` whose white fill was
   immediately overridden back to sand by a utility. It becomes
   `card-2 card-pad-2`, which is the same rendered intent expressed once
   instead of twice, and drops the now-meaningless `.card` shadow.
2. `EvidenceUploader.tsx`'s staged-file rows were
   `rounded-md border border-line bg-card px-2 py-1 text-xs` — white chips on
   the white create-ticket card, the actual camouflage instance on `/help`.
   They move onto `.card-2` (keeping their own compact `px-2 py-1`, since
   `card-pad-2`'s 1rem is a panel padding, not a chip padding).

**Not a §28.2 escalation** — no pricing, auth, legal or destructive semantics
are touched; this is surface treatment only.

**Files.** `apps/storefront/static/app.css`,
`apps/storefront/client/src/styles/tokens.css` (§6 comment),
`apps/storefront/client/src/components/shop/InlineTicketPanel.tsx`,
`apps/storefront/client/src/components/shop/EvidenceUploader.tsx`.
