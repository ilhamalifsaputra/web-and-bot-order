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

## Considered but NOT extended

- **Mobile nav-drawer scrim** — was `bg-[rgba(15,23,42,0.35)]` in `Layout.tsx`.
  Resolved with the existing `--gg-ink` token via Tailwind's opacity modifier
  (`bg-ink/35`), not a new token. The audit (§D2) had floated a named
  `ink/35` alpha token; the opacity modifier makes it unnecessary.
- **Telegram contact card** — was `bg-[#eff6ff]` / `text-[#2563eb]` in
  `HomePage.tsx`. `#2563eb` is exactly `--gg-pine`; the sibling contact cards
  already use `bg-pine-tint` / `text-pine`. Fixed by making the card
  consistent, no new value.
