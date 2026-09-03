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
