# Design-token extensions (spec §26.2)

Values the running storefront needs that the design-system spec
(`gogogo-frontend/design-system/tokens.css` → `apps/storefront/client/src/styles/tokens.css`)
does not define. Each is a reviewed, scoped exception recorded here and
implemented in `apps/storefront/client/src/styles/tokens.extensions.css`
(value) + the `@theme` block in `apps/storefront/client/src/index.css`
(Tailwind utility name).

This is not a second token source. Prefer promoting a stable extension into the
real spec over letting the file grow. Anything added here must first be checked
against every existing `--gg-*` token for a fit.

| Token | Value | Scope | Why it exists | Added |
|---|---|---|---|---|
| `--gg-grass-dark-aa` (`text-grass-dark-aa`) | `#157e3b` | `StockBadge` "in stock" pill foreground only | The shared `--gg-grass-dark` (`#15803d`) on `--gg-grass-tint` measures **4.49:1** — 0.01 short of WCAG AA (4.5:1) for the pill's `text-xs`. This marginally darker green clears AA (~4.55:1) with no perceptible hue shift. Must not replace `--gg-grass-dark` where the shared success green is used (StatusBadge, ProductCard, money deltas). Previously hard-coded as the arbitrary class `text-[#157e3b]`; moved to a token when the §7.3 ESLint gate (Task 4) banned raw hex in `.tsx`. | Task 4 (2026-09) |
| `--gg-text-2xs` (`text-2xs`) | `0.625rem` (10px) | `Badge` `discount` / `savings` variant label only | `components.md` "Badge & chip" specifies **~10px/700** for the Discount and Savings badges. The design-system type scale (`tokens.css` §TYPOGRAPHY) bottoms out at `--gg-text-xs` (`0.75rem` / 12px), 2px above the spec, and the Task 4 ESLint gate bans `text-[10px]` (px arbitrary value), so there is no in-scale way to reach it. This is the single 10px step. Scoped to those two Badge variants — must not replace `--gg-text-xs` where the shared 12px chip size is used. Mirrored as `--text-2xs` in the `@theme` block of `index.css` to generate the `text-2xs` utility (Tailwind v4 has no built-in `2xs`). | Task 6a (2026-09) |

## Component-pattern exceptions (no design-system template)

Not token-value extensions — cases where `components.md` has **no template**
for a component the app needs, so its treatment is composed from existing
tokens/primitives and recorded here instead.

| Component | Basis | Why it exists | Added |
|---|---|---|---|
| `Modal` / `AlertDialog` (`components/ui/`) | Visual: `Card` (white `.card` surface, `radius-lg`, `shadow-*`) + an `ink/45` scrim. A11y: the `MobileDrawer` (Task 5) dialog contract — `role="dialog"`/`alertdialog` + `aria-modal`, focus trap, Esc, scrim-click, body scroll-lock with scrollbar compensation, focus restore, `createPortal` to `document.body`, `prefers-reduced-motion` via the app-wide `<MotionConfig>` — extracted to `components/ui/useDialogA11y.ts` and shared by both. | The reverse-engineered storefront barely used modals, so `components.md` has no "Modal" section. No new token or off-token value is introduced; styling is entirely existing token utilities + the `.card` class. `MobileDrawer` keeps its own inline copy of the a11y logic (already-reviewed Task 5 code) — the hook only de-duplicates the two new dialog primitives. | Task 7b (2026-09) |

## Considered but NOT extended

- **Mobile nav-drawer scrim** — was `bg-[rgba(15,23,42,0.35)]` in `Layout.tsx`.
  Resolved with the existing `--gg-ink` token via Tailwind's opacity modifier
  (`bg-ink/35`), not a new token. The audit (§D2) had floated a named
  `ink/35` alpha token; the opacity modifier makes it unnecessary.
- **Telegram contact card** — was `bg-[#eff6ff]` / `text-[#2563eb]` in
  `HomePage.tsx`. `#2563eb` is exactly `--gg-pine`; the sibling contact cards
  already use `bg-pine-tint` / `text-pine`. Fixed by making the card
  consistent, no new value.
