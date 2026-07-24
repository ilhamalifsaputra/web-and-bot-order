# Storefront Homepage Visual Polish Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Elevate the storefront homepage's visual depth, hierarchy, and premium feel (hero background, hero right-side composition, CTA hierarchy, interactive-card hover consistency) using only existing design tokens — no redesign, no new colors, no new dependencies.

**Architecture:** All changes live in three files: `apps/storefront/client/src/lib/motion.ts` (one new shared framer-motion variant), and `apps/storefront/client/src/pages/HomePage.tsx` (layered hero background, new hero product-preview composition sourced from already-fetched data, hover-state standardization on genuinely interactive cards). `HomePage.css` is read but not modified — the `.dot-grid` pattern it already defines is reused as-is.

**Tech Stack:** React 18, TypeScript, Tailwind CSS v4 (existing `@theme` tokens only), framer-motion (already a dependency, existing `lib/motion.ts` variants), Vitest + Testing Library.

## Global Constraints

- Every color/shadow/radius value used MUST already exist in `apps/storefront/client/src/index.css`'s `@theme` block (`pine`, `pine-dark`, `pine-tint`, `grass`, `grass-dark`, `grass-tint`, `amberx`, `ink`, `ink-soft`, `ink-faint`, `sand`, `line`, `card`, `shadow-soft`, `shadow-lift`) — never a freehand hex/px value.
- No new color tokens (no purple/cyan).
- No typography scale changes — only spacing/hierarchy/class polish within the existing scale.
- No changes outside `HomePage.tsx`, `HomePage.css`, `lib/motion.ts`.
- No new shared component — the hero product-preview cards are a one-off composition inline in `HomePage.tsx`.
- No real third-party brand names/logos as decoration — the hero product preview uses only the shop's real `data.products`.
- Hover-lift effects only on elements that are actually links/interactive — never on purely informational cards (the 4 feature cards, the "Our Promise" stat items, the trust-checklist card stay untouched).
- `pnpm typecheck` and `pnpm test` must stay green after every task.
- Spec reference: `docs/superpowers/specs/2026-07-24-storefront-homepage-visual-polish-design.md`.

---

## Task 1: Shared `hoverLift` motion variant

**Files:**
- Modify: `apps/storefront/client/src/lib/motion.ts`

**Interfaces:**
- Consumes: `DURATION`, `EASE` (already defined in this file).
- Produces: `export const hoverLift: { whileHover: { y: number; transition: { duration: number; ease: readonly number[] } } }` — a framer-motion gesture-prop object, spreadable onto any `motion.*` element as `{...hoverLift}`. Consumed by Task 2 (CTA) and Task 3 (hero product cards).

- [ ] **Step 1: Add the `hoverLift` export**

Add this after the existing `pressable` export (after line 36) in `apps/storefront/client/src/lib/motion.ts`:

```ts
export const hoverLift = {
  whileHover: { y: -2, transition: { duration: DURATION.fast, ease: EASE } },
};
```

- [ ] **Step 2: Typecheck**

Run: `pnpm --filter @app/storefront-client typecheck`
Expected: no errors (this is an additive export with no consumers yet, so nothing can break).

- [ ] **Step 3: Commit**

```bash
git add apps/storefront/client/src/lib/motion.ts
git commit -m "feat(storefront-client): add shared hoverLift motion variant"
```

---

## Task 2: Hero background depth + CTA hover hierarchy

**Files:**
- Modify: `apps/storefront/client/src/pages/HomePage.tsx:1-56` (imports), `:163-223` (hero section)
- Test: `apps/storefront/client/src/pages/HomePage.test.tsx`

**Interfaces:**
- Consumes: `hoverLift` from `../lib/motion` (Task 1).
- Produces: no new exports — this task only changes JSX/classNames inside the `HomePage` component's hero `<section>`. Task 3 appends more JSX to the same `<section>` after this task lands.

- [ ] **Step 1: Write the failing test for the layered background**

Add this test inside the `describe("HomePage", ...)` block in `apps/storefront/client/src/pages/HomePage.test.tsx` (near the other hero-image tests, after the "falls back to the plain gradient" test):

```tsx
  it("layers the hero background with two decorative glows, a texture overlay, and a vignette", async () => {
    const { container } = renderHome(homeFixture());
    await screen.findByRole("heading", { name: "Netflix Premium" });
    const hero = container.querySelector("section.bg-ink");
    expect(hero).not.toBeNull();
    const decorative = hero!.querySelectorAll('[aria-hidden="true"]');
    // 1 top-right glow + 1 bottom-left glow + 1 dot-grid texture + 1 vignette = 4,
    // on top of whichever base gradient div (image or plain) also renders aria-hidden.
    expect(decorative.length).toBeGreaterThanOrEqual(4);
    expect(hero!.querySelector(".dot-grid")).not.toBeNull();
    expect(hero!.querySelector(".bg-grass\\/10")).not.toBeNull();
  });

  it("gives the primary hero CTA a stronger shadow on hover and the secondary CTA a more visible hover fill", async () => {
    renderHome(homeFixture());
    const primary = await screen.findByRole("link", { name: /Browse products/ });
    expect(primary.className).toContain("hover:shadow-lift");
    const secondary = screen.getByRole("link", { name: /Contact support/ });
    expect(secondary.className).toContain("hover:bg-white/15");
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm vitest run apps/storefront/client/src/pages/HomePage.test.tsx -t "layers the hero background"`
Expected: FAIL — `hero!.querySelector(".dot-grid")` is `null` (no such element exists yet).

Run: `pnpm vitest run apps/storefront/client/src/pages/HomePage.test.tsx -t "stronger shadow"`
Expected: FAIL — `primary.className` does not contain `"hover:shadow-lift"`.

- [ ] **Step 3: Add the `motion` import**

In `apps/storefront/client/src/pages/HomePage.tsx`, add this import after the existing `import { apiGet } from "../api/client";` line (line 45):

```tsx
import { motion } from "framer-motion";
```

And add `hoverLift` to the existing `lib/motion` import — since this is the first use of `lib/motion` in this file, add a new import line right after the `framer-motion` import:

```tsx
import { hoverLift } from "../lib/motion";
```

- [ ] **Step 4: Replace the hero section's background layers and CTA classes**

Replace the full hero `<section>` block (currently lines 163–223 of `HomePage.tsx`, from `{/* 1. Hero ... */}` through its closing `</section>`) with:

```tsx
      {/* 1. Hero (design.md §4.8, mockup perbaikan) */}
      <section className="relative overflow-hidden rounded-3xl bg-ink px-6 py-12 sm:px-10 sm:py-16 mb-12">
        {hero_image ? (
          <>
            <img
              src={hero_image}
              alt=""
              aria-hidden="true"
              loading="eager"
              decoding="async"
              width={1600}
              height={600}
              className="absolute inset-0 h-full w-full object-cover"
            />
            <div className="absolute inset-0 bg-linear-to-br from-ink/95 via-ink/90 to-pine-dark/80"></div>
          </>
        ) : (
          <div className="absolute inset-0 bg-linear-to-br from-ink via-ink to-pine-dark"></div>
        )}
        {/* Layered depth: two low-opacity glows -> reused .dot-grid texture -> soft vignette.
            All decorative, aria-hidden, and never intercept clicks. */}
        <div aria-hidden="true" className="pointer-events-none absolute -right-16 -top-16 h-64 w-64 rounded-full bg-pine/20 blur-3xl"></div>
        <div aria-hidden="true" className="pointer-events-none absolute -left-10 bottom-0 h-56 w-56 rounded-full bg-grass/10 blur-3xl"></div>
        <div aria-hidden="true" className="dot-grid pointer-events-none absolute inset-0"></div>
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_at_center,transparent_45%,rgba(0,0,0,0.18)_100%)]"
        ></div>
        <div className={`relative max-w-2xl ${heroProducts.length >= 2 ? "lg:max-w-xl" : ""}`}>
          <span className="inline-flex items-center gap-1.5 rounded-full border border-white/15 bg-white/5 px-3 py-1 text-xs font-medium uppercase tracking-wide text-grass">
            <ShieldCheck className="h-3.5 w-3.5" />
            {t("web.hero_badge")}
          </span>
          <h1 className="mt-5 text-4xl font-display font-bold leading-tight text-white sm:text-5xl">
            {t("web.hero_title")}
          </h1>
          <p className="mt-4 text-lg text-ink-faint">{t("web.hero_sub")}</p>
          <div className="mt-7 flex flex-wrap gap-3">
            <motion.a
              href="#produk"
              {...hoverLift}
              className="focus-on-dark inline-flex items-center gap-2 rounded-xl bg-pine px-5 py-3 font-semibold text-white hover:bg-pine-dark transition-colors shadow-soft hover:shadow-lift"
            >
              <ShoppingBag className="h-5 w-5" />
              {t("web.hero_cta")}
            </motion.a>
            <a
              href="#kontak"
              className="focus-on-dark inline-flex items-center gap-2 rounded-xl border border-white/20 px-5 py-3 font-semibold text-white hover:bg-white/15 transition-colors"
            >
              <MessageCircle className="h-5 w-5" />
              {t("web.hero_cta2")}
            </a>
          </div>
          {/* honest trust chips: capabilities/guarantees, no customer-count claims */}
          <div className="mt-8 flex flex-wrap gap-x-6 gap-y-2 border-t border-white/10 pt-5 text-sm text-ink-faint">
            <span className="inline-flex items-center gap-1.5">
              <Zap className="h-4 w-4 text-amber-400" /> {t("web.badge_instant")}
            </span>
            <span className="inline-flex items-center gap-1.5">
              <Shield className="h-4 w-4 text-grass" /> QRIS &amp; USDT
            </span>
            <span className="inline-flex items-center gap-1.5">
              <CheckCircle className="h-4 w-4 text-pine-tint" /> {t("web.feat_warranty")}
            </span>
            <span className="inline-flex items-center gap-1.5">
              <Headphones className="h-4 w-4 text-violet-400" /> {t("web.badge_support")}
            </span>
          </div>
        </div>
      </section>
```

Note: this references `heroProducts`, which does not exist yet — Task 3 adds its derivation. For this task only, temporarily add the line `const heroProducts: typeof products = [];` immediately after the existing `const { hero_image, categories, products, testimonials, low_threshold, bot_username, wa_number } = data;` line (around line 154) so the file compiles; Task 3 replaces this placeholder with the real derivation and the floating-card JSX.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm vitest run apps/storefront/client/src/pages/HomePage.test.tsx`
Expected: PASS — all tests, including the two new ones and the full existing suite (background/CTA changes don't alter any text content or existing element roles).

- [ ] **Step 6: Typecheck**

Run: `pnpm --filter @app/storefront-client typecheck`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add apps/storefront/client/src/pages/HomePage.tsx apps/storefront/client/src/pages/HomePage.test.tsx
git commit -m "feat(storefront-client): layer hero background depth and strengthen CTA hover states"
```

---

## Task 3: Hero right-side product-preview composition

**Files:**
- Modify: `apps/storefront/client/src/pages/HomePage.tsx`
- Test: `apps/storefront/client/src/pages/HomePage.test.tsx`

**Interfaces:**
- Consumes: `hoverLift` (Task 1), `staggerContainer`/`staggerItem` (already exported from `../lib/motion`), `motion` (Task 2's import), `data.products: ProductCardData[]` (already fetched — see `apps/storefront/client/src/api/types.ts`), `Price` component (`../components/shop/Price`, props `{ value, fx, size? }`).
- Produces: `heroProducts` local variable (replaces Task 2's placeholder), `HERO_CARD_STYLES` module-level constant. Nothing consumed by later tasks.

- [ ] **Step 1: Write the failing tests**

Add these tests to `apps/storefront/client/src/pages/HomePage.test.tsx`, right after the two tests added in Task 2:

```tsx
  it("shows a hero product-preview composition when at least two products are available, linking each card to its product", async () => {
    const second = { ...product, slug: "spotify-premium", name: "Spotify Premium" };
    const { container } = renderHome(homeFixture({ products: [product, second] }));
    await screen.findByRole("heading", { name: "Netflix Premium" });
    const preview = container.querySelector('[data-testid="hero-product-preview"]');
    expect(preview).not.toBeNull();
    const cardLinks = preview!.querySelectorAll("a");
    expect(cardLinks.length).toBe(2);
    expect(cardLinks[0]).toHaveAttribute("href", "/p/netflix-premium");
    expect(cardLinks[1]).toHaveAttribute("href", "/p/spotify-premium");
    expect(preview!.textContent).toContain("Netflix Premium");
    expect(preview!.textContent).toContain("Spotify Premium");
  });

  it("caps the hero product-preview composition at three cards", async () => {
    const products = [
      product,
      { ...product, slug: "spotify-premium", name: "Spotify Premium" },
      { ...product, slug: "canva-pro", name: "Canva Pro" },
      { ...product, slug: "capcut-pro", name: "CapCut Pro" },
    ];
    const { container } = renderHome(homeFixture({ products }));
    await screen.findByRole("heading", { name: "Netflix Premium" });
    const preview = container.querySelector('[data-testid="hero-product-preview"]');
    expect(preview!.querySelectorAll("a").length).toBe(3);
  });

  it("hides the hero product-preview composition when fewer than two products are available", async () => {
    const { container } = renderHome(homeFixture({ products: [product] }));
    await screen.findByRole("heading", { name: "Netflix Premium" });
    expect(container.querySelector('[data-testid="hero-product-preview"]')).toBeNull();
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm vitest run apps/storefront/client/src/pages/HomePage.test.tsx -t "hero product-preview"`
Expected: FAIL — `container.querySelector('[data-testid="hero-product-preview"]')` is `null` in all three (the composition doesn't exist yet; `heroProducts` is still Task 2's empty-array placeholder).

- [ ] **Step 3: Add the `Price` import**

In `apps/storefront/client/src/pages/HomePage.tsx`, add after the existing `import EmptyState from "../components/shop/EmptyState";` line:

```tsx
import Price from "../components/shop/Price";
```

- [ ] **Step 4: Add the `HERO_CARD_STYLES` constant**

Add this near the other module-level constants at the top of the file (after `const SKELETON_CARDS = ...`, around line 80):

```tsx
// Loose stagger positions for up to 3 hero product-preview cards — plain
// numbers/strings, not CSS transform strings, so framer-motion's own
// whileHover translateY composes correctly with this static rotation
// instead of one overwriting the other.
const HERO_CARD_STYLES: Array<{ top: string; right: string; rotate: number }> = [
  { top: "6%", right: "4%", rotate: -4 },
  { top: "40%", right: "20%", rotate: 3 },
  { top: "72%", right: "0%", rotate: -2 },
];
```

- [ ] **Step 5: Replace the `heroProducts` placeholder and append the floating-card composition**

Replace the placeholder line added in Task 2 (`const heroProducts: typeof products = [];`) with:

```tsx
  // Real inventory only — never a fabricated/placeholder product. Fewer than
  // 2 available products means no composition at all (see homepage design spec).
  const heroProducts = products.length >= 2 ? products.slice(0, 3) : [];
```

Then, still inside the hero `<section>` from Task 2, insert this block immediately after the closing `</div>` of the `relative max-w-2xl` content div and before the section's own closing `</section>`:

```tsx
        {heroProducts.length > 0 && (
          <div
            data-testid="hero-product-preview"
            className="pointer-events-none absolute inset-y-0 right-0 hidden w-[36%] lg:block"
          >
            <motion.div
              className="relative h-full"
              variants={staggerContainer}
              initial="initial"
              animate="animate"
            >
              {heroProducts.map((p, i) => (
                <motion.div
                  key={p.slug}
                  variants={staggerItem}
                  {...hoverLift}
                  className="pointer-events-auto absolute w-48 rounded-2xl border border-white/15 bg-white/10 p-3 shadow-lift backdrop-blur-md"
                  style={{ top: HERO_CARD_STYLES[i]!.top, right: HERO_CARD_STYLES[i]!.right, rotate: HERO_CARD_STYLES[i]!.rotate }}
                >
                  <Link to={`/p/${p.slug}`} className="focus-on-dark flex items-center gap-3">
                    <span className="grid h-11 w-11 shrink-0 place-items-center overflow-hidden rounded-xl bg-white/10">
                      {p.image ? (
                        <img
                          src={p.image}
                          alt=""
                          aria-hidden="true"
                          loading="lazy"
                          width={44}
                          height={44}
                          className="h-full w-full object-cover"
                        />
                      ) : (
                        <Package className="h-5 w-5 text-white/70" aria-hidden="true" />
                      )}
                    </span>
                    <span className="min-w-0">
                      <span className="block truncate text-sm font-semibold text-white">{p.name}</span>
                      <Price value={p.from_price} fx={fx} size="text-xs" />
                    </span>
                  </Link>
                </motion.div>
              ))}
            </motion.div>
          </div>
        )}
```

Also add `staggerContainer, staggerItem` to the `lib/motion` import added in Task 2, so the full line reads:

```tsx
import { hoverLift, staggerContainer, staggerItem } from "../lib/motion";
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `pnpm vitest run apps/storefront/client/src/pages/HomePage.test.tsx`
Expected: PASS — the 3 new tests and the full existing suite (single-product fixtures never render the composition, so no duplicate "Netflix Premium" heading/text collisions with existing single-product assertions).

- [ ] **Step 7: Typecheck**

Run: `pnpm --filter @app/storefront-client typecheck`
Expected: no errors.

- [ ] **Step 8: Commit**

```bash
git add apps/storefront/client/src/pages/HomePage.tsx apps/storefront/client/src/pages/HomePage.test.tsx
git commit -m "feat(storefront-client): add hero product-preview composition from real inventory"
```

---

## Task 4: Standardize interactive-card hover depth (category + contact cards)

**Files:**
- Modify: `apps/storefront/client/src/pages/HomePage.tsx` (category card `Link`, ~line 296; three contact cards, ~lines 532, 551, 569 in the pre-change file)
- Test: `apps/storefront/client/src/pages/HomePage.test.tsx`

**Interfaces:**
- Consumes: nothing new.
- Produces: nothing consumed by later tasks.

- [ ] **Step 1: Write the failing test**

Add this test after the existing categories test in `apps/storefront/client/src/pages/HomePage.test.tsx` (the file already has a categories fixture with slug `"streaming"`, and a contact section with WA + Telegram + Ticket links):

```tsx
  it("gives category and contact cards a consistent lift-and-shadow hover treatment", async () => {
    renderHome(homeFixture());
    await screen.findByRole("heading", { name: "Netflix Premium" });
    const categoryLink = screen.getByRole("link", { name: /View products/ });
    expect(categoryLink.className).toContain("hover:-translate-y-0.5");
    expect(categoryLink.className).toContain("hover:shadow-lift");

    const ticketLink = screen.getByRole("link", { name: /Support ticket/ });
    expect(ticketLink.className).toContain("hover:-translate-y-0.5");
    expect(ticketLink.className).toContain("hover:shadow-lift");
  });
```

(The accessible name comes from `t("web.contact_ticket")`, which is `"Support ticket"` in `packages/core/locales/en.json`.)

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run apps/storefront/client/src/pages/HomePage.test.tsx -t "consistent lift-and-shadow"`
Expected: FAIL — `categoryLink.className` contains `hover:shadow` but not `hover:shadow-lift` (they're different strings; `hover:shadow` alone is a substring failure for `toContain("hover:shadow-lift")`).

- [ ] **Step 3: Update the category card's hover classes**

In `apps/storefront/client/src/pages/HomePage.tsx`, find the category card `Link`:

```tsx
                className="group flex items-center gap-4 rounded-2xl border border-line bg-card p-5 shadow-xs transition hover:border-pine-tint hover:shadow"
```

Replace with:

```tsx
                className="group flex items-center gap-4 rounded-2xl border border-line bg-card p-5 shadow-xs transition hover:-translate-y-0.5 hover:border-pine-tint hover:shadow-lift"
```

- [ ] **Step 4: Update the three contact cards' hover classes**

All three contact cards (WhatsApp `<a>`, Telegram `<a>`, and the Ticket `<Link>`) currently share this className:

```tsx
              className="flex flex-col items-center gap-3 rounded-2xl border border-line bg-card p-6 text-center shadow-xs transition hover:shadow-md"
```

Replace all three occurrences with:

```tsx
              className="flex flex-col items-center gap-3 rounded-2xl border border-line bg-card p-6 text-center shadow-xs transition hover:-translate-y-0.5 hover:shadow-lift"
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm vitest run apps/storefront/client/src/pages/HomePage.test.tsx`
Expected: PASS — all tests, including the new one.

- [ ] **Step 6: Typecheck**

Run: `pnpm --filter @app/storefront-client typecheck`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add apps/storefront/client/src/pages/HomePage.tsx apps/storefront/client/src/pages/HomePage.test.tsx
git commit -m "feat(storefront-client): standardize category/contact card hover depth on shadow-lift"
```

---

## Task 5: Distinguish "coming soon" teaser cards as non-interactive

**Files:**
- Modify: `apps/storefront/client/src/pages/HomePage.tsx` (the two "Layanan mendatang" cards, ~lines 358–386 in the pre-change file)
- Test: `apps/storefront/client/src/pages/HomePage.test.tsx`

**Interfaces:**
- Consumes: nothing new.
- Produces: nothing consumed by later tasks. Closes the gap flagged in `docs/ui-refactor/storefront/design-system.md` ("Cards" section: "Coming soon" teasers visually match real clickable cards).

- [ ] **Step 1: Write the failing test**

Add this test after the "hides the WhatsApp contact card" test in `apps/storefront/client/src/pages/HomePage.test.tsx`:

```tsx
  it("gives the two 'coming soon' teaser cards a dashed border so they read as non-interactive", async () => {
    const { container } = renderHome(homeFixture());
    await screen.findByRole("heading", { name: "Netflix Premium" });
    const teasers = container.querySelectorAll(".border-dashed");
    expect(teasers.length).toBe(2);
  });
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run apps/storefront/client/src/pages/HomePage.test.tsx -t "coming soon"`
Expected: FAIL — `container.querySelectorAll(".border-dashed")` is empty.

- [ ] **Step 3: Update both teaser cards**

In `apps/storefront/client/src/pages/HomePage.tsx`, find the two "Layanan mendatang" cards. The first (Social Media Services):

```tsx
          <div className="flex items-start gap-4 rounded-2xl border border-line bg-card p-6 shadow-xs">
            <span className="grid h-12 w-12 shrink-0 place-items-center rounded-xl bg-violet-50 text-violet-600">
              <Share2 className="h-6 w-6" />
            </span>
```

Replace with:

```tsx
          <div className="flex items-start gap-4 rounded-2xl border border-dashed border-line bg-card p-6 shadow-xs">
            <span className="grid h-12 w-12 shrink-0 place-items-center rounded-xl bg-violet-50 text-violet-600 opacity-70">
              <Share2 className="h-6 w-6" />
            </span>
```

The second (Game Top-Up):

```tsx
          <div className="flex items-start gap-4 rounded-2xl border border-line bg-card p-6 shadow-xs">
            <span className="grid h-12 w-12 shrink-0 place-items-center rounded-xl bg-pine-tint text-pine">
              <Gamepad2 className="h-6 w-6" />
            </span>
```

Replace with:

```tsx
          <div className="flex items-start gap-4 rounded-2xl border border-dashed border-line bg-card p-6 shadow-xs">
            <span className="grid h-12 w-12 shrink-0 place-items-center rounded-xl bg-pine-tint text-pine opacity-70">
              <Gamepad2 className="h-6 w-6" />
            </span>
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm vitest run apps/storefront/client/src/pages/HomePage.test.tsx`
Expected: PASS — all tests.

- [ ] **Step 5: Typecheck**

Run: `pnpm --filter @app/storefront-client typecheck`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add apps/storefront/client/src/pages/HomePage.tsx apps/storefront/client/src/pages/HomePage.test.tsx
git commit -m "fix(storefront-client): give coming-soon teaser cards a dashed, muted non-interactive treatment"
```

---

## Task 6: Full verification and visual QA

**Files:** none modified — verification only.

**Interfaces:** none.

- [ ] **Step 1: Full repo typecheck**

Run: `pnpm typecheck`
Expected: exits 0, no errors in any workspace.

- [ ] **Step 2: Full test suite**

Run: `pnpm test`
Expected: exits 0, all suites pass (including `HomePage.test.tsx`'s now-8-additional tests).

- [ ] **Step 3: Build the storefront client**

Run: `pnpm --filter @app/storefront-client build`
Expected: build succeeds (this regenerates `apps/storefront/static/shop-app/`, required before manual dev-server verification renders the updated bundle).

- [ ] **Step 4: Manual visual verification**

Start the dev server (check `apps/storefront/package.json` / root `package.json` for the exact script, e.g. `pnpm dev:store`), open the homepage in a browser, and confirm at desktop width (≥1280px):
- The hero background reads as layered (dark base, two soft glows, faint dot texture, corner vignette) rather than a flat wash.
- If the seeded shop has ≥2 products, 2–3 floating glass product cards appear on the hero's right side, don't overlap the hero text, and each links to its product page.
- The primary CTA button visibly lifts/gains a stronger shadow on hover; the secondary CTA's hover fill is clearly visible against the dark hero.
- Category cards and the 3 contact cards lift slightly with a stronger shadow on hover.
- The 2 "coming soon" cards read as visually distinct (dashed border, muted icon) from real clickable cards, and have no hover effect.
- The 4 "why shop with us" feature cards and the "Our Promise" band still have **no** hover effect (they're not links).

Then confirm at tablet (~768px) and mobile (~375px) widths: hero floating cards are absent (`lg:block` only), hero content and all cards remain fully readable with no overlap or clipping.

- [ ] **Step 5: Confirm no unintended diff**

Run: `git status --short` and `git diff --stat master...HEAD -- apps/storefront/client/src/pages/HomePage.tsx apps/storefront/client/src/pages/HomePage.css apps/storefront/client/src/lib/motion.ts`
Expected: only the 3 files listed in Global Constraints changed across Tasks 1–5; no other file touched by this plan.

No commit for this task — it's verification-only. If Step 4 surfaces a real defect, fix it as a new bite-sized task appended to this plan before considering the work done.
