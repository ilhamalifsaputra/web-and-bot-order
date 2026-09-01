# gogogo-frontend — Foundations

> Layout, grids and component composition here were reverse-engineered from
> the live gogogo.id storefront (2026-09-01), logged in as `ilhmalif@gmail.com`
> — see `../screenshots/`. **Every colour, font, radius and shadow value below
> is this repo's own "Clean Modern" brand instead** (`apps/storefront/static/app.css`,
> `packages/web-ui/views/_theme.njk`) — gogogo.id's actual dark/yellow theme
> was swapped out so this system matches the rest of the codebase.

The product is a **games top-up / voucher storefront** (same shape as
gogogo.id). The visual language borrowed from this repo is **light, calm,
and soft-shadowed** — a pale "paper" background, white cards, one blue
primary action, and green reserved for savings/success — the opposite of
gogogo.id's dark/flat/loud-yellow original.

---

## 1. Brand

| Token | Value | Use |
|---|---|---|
| Primary — pine | `#2563eb` | Primary buttons, links, focus ring, active nav/tab |
| Primary dark | `#1d4ed8` | Primary hover/active |
| Primary tint | `#e6effe` | Soft-button fill, active-tab background, avatar background |
| Success/savings — grass | `#16a34a` | Discount badges, "Hemat" savings, positive states |
| Grass dark | `#15803d` | Savings/checkout price text (on tint) |
| Grass tint | `#e7f6ec` | Discount badge fill, success banners |
| Warning — amberx | `#b45c0a` | Pending states, soft warnings |
| Danger — rust | `#dc2626` | Errors, destructive actions, inline validation |

Text on solid primary/danger buttons is **white**. Soft/tinted variants (the
`.btn-soft` pattern) pair a tint background with the *dark* shade of that hue
as text — e.g. `pine-tint` background + `pine-dark` text — never a flat fill
with dark-on-light like gogogo.id's yellow buttons.

---

## 2. Colour system

### Surface ramp

Unlike gogogo.id's dark theme, depth here comes from **white cards floating
on a pale paper background**, lifted by a soft shadow, not by darkening
surfaces.

| Level | Token | Hex | Where |
|---|---|---|---|
| 0 — page | `paper` | `#f6f8fb` | App background (a barely-there cool radial wash is layered on top, not flat) |
| 1 — card | `card` | `#ffffff` | Cards, panels, fields |
| 2 — subtle fill | `sand` | `#eef1f6` | Ghost-button hover, table header row, ghost chip fill |
| — border | `line` | `#e3e8ef` | 1px hairline on every card/field |
| — strong | — | `#c5cbd6` | Scrollbar thumb, stronger dividers |

### Text

| Token | Hex | Use |
|---|---|---|
| `ink` | `#1b2330` | Primary text, headings |
| `ink-soft` | `#5a6473` | Secondary text, field labels, table headers |
| `ink-faint` | `#677288` | Placeholder, tertiary text |

### Status & support

| Role | Hex | Notes |
|---|---|---|
| Success / discount / savings | `#16a34a` (solid) / `#e7f6ec` (tint) | Replaces gogogo.id's cyan — same "money in your favour" role |
| Warning / pending | `#b45c0a` (solid) / `#fdedcf` (tint) | |
| Error | `#dc2626` (solid) / `#fde7e7` (tint), `#b91c1c` dark | Inline validation text + field border |
| Primary / links | `#2563eb` (solid) / `#e6effe` (tint), `#1d4ed8` dark | |

### Contrast / a11y notes

- `ink` (`#1b2330`) on `paper` (`#f6f8fb`) ≈ 14.9:1 — AAA.
- `ink-soft` (`#5a6473`) on `card`/`paper` ≈ 5.4:1 — AA for normal text.
- White on `pine` (`#2563eb`) ≈ 4.9:1 — AA (bold/14px+ button text only; don't
  drop below 14px semibold on this fill).
- `pine-dark` on `pine-tint` (soft-button pattern) ≈ 7.4:1 — AAA.
- `grass-dark` (`#15803d`) on `grass-tint` (`#e7f6ec`) ≈ 5.1:1 — AA, safe for
  the checkout price and discount badge text.

---

## 3. Typography

**Two families, split by role** (not one family for everything, unlike
gogogo.id):

- **Display — Outfit**: `h1`–`h3`, `.page-title`, `.section-title`,
  `.stat-value`. Weight 600/700 only.
- **Sans — Manrope**: everything else — body copy, nav, buttons, labels.
  Weights 400/500/600/700 all appear standalone in the app.
- **Mono — JetBrains Mono**: order codes, voucher codes, referral codes
  (`.codeish`). Weight 400 unweighted or 600 (`font-semibold`) — never 500.

### Scale (as actually used, not an invented ramp)

| Role | Spec |
|---|---|
| Page title (mobile, <640px) | Outfit, 24px / 600 / `-0.025em` tracking |
| Page title (desktop, ≥640px) | Outfit, 30px / 600 / `-0.025em` tracking |
| Page lead (subtitle under title) | Manrope, 14px, `ink-soft` |
| Section title | Outfit, 18px / 600 |
| Stat value | Outfit, 30px / 600 / line-height 1 |
| Stat / field label | Manrope, ~11px / 600 / **uppercase**, `0.05em` tracking, `ink-soft` |
| Body | Manrope, 16px / 400 / 1.5 (mobile field text is 16px on purpose — smaller triggers an iOS Safari zoom-in on focus; desktop fields drop to 14px from 640px up) |
| Button label | Manrope, 14px / 600 |
| Table header | Manrope, ~13px / 600 / **uppercase**, `0.03em` tracking, `ink-soft` |
| Code / order IDs | JetBrains Mono, 12px |

No display-weight-400 headings anywhere hydrated — Outfit only ever appears
semibold or bold.

---

## 4. Spacing

4px base grid. Concretely measured values in the codebase:

- **Card padding:** `1.25rem` (20px) mobile → `1.5rem` (24px) from 640px up.
- **Button padding:** `0.5rem 1rem`, **min-height `2.75rem`** (44px — WCAG/iOS
  tap-target minimum). Compact `.btn-sm`: `0.375rem 0.75rem`, min-height
  `2rem` on a mouse, but **grows back to 44px on `(pointer: coarse)`** — one
  rule serving both dense-desktop and thumb-sized-touch.
- **Field padding:** `0.5rem 0.75rem`, min-height `2.75rem`.
- **Chip padding:** `0.125rem 0.625rem`.

---

## 5. Radius

Real scale from `apps/storefront/static/app.css` (`--r-*`) — much smaller
than a typical 8-step design-token ramp:

| Token | Value | Use |
|---|---|---|
| `xs` | 4px | `.codeish` |
| `sm` | 8px | `.btn-sm`; admin's retuned `.field` |
| `md` | 12px | `.btn`, `.field` (default) |
| `lg` | 16px | `.card` (both storefront and admin agree on 1rem) |
| `full` | 9999px | `.chip`, avatars, pill tabs |

---

## 6. Elevation

This brand is **not flat** — real shadows carry the depth, cards are white on
paper:

| Token | Value | Use |
|---|---|---|
| `shadow-soft` | `0 1px 2px rgba(16,24,40,.04), 0 8px 24px -14px rgba(16,24,40,.12)` | Default card / primary-button resting state |
| `shadow-lift` | `0 2px 4px rgba(16,24,40,.06), 0 16px 36px -18px rgba(16,24,40,.18)` | Hover / active |
| `shadow-focus` | `0 0 0 3px rgb(37 99 235 / .35)` | Button/field focus ring |
| `shadow-none` | `none` | Ghost/text buttons, flush elements |

Recipe: **white `.card` + 1px `line` border + `shadow-soft`**, stepping to
`shadow-lift` on hover — this replaces gogogo.id's "surface-ramp only, no
shadow" approach entirely.

---

## 7. Layout & responsive

- **Content max width:** `1152px` (`max-w-6xl`) — verified as the dominant
  container class across the storefront's own pages (Layout, HomePage,
  ProductPage, LoginPage, …). Long-form pages narrow to `768px` prose width.
- **Breakpoints (Tailwind defaults):** sm `640` · md `768` · lg `1024` ·
  xl `1280` · 2xl `1536`.
- **Background texture:** a faint cool radial gradient wash
  (`pine` at 5% opacity, fixed) sits behind the page — not a flat fill.

### Grids (structure from gogogo.id, unchanged)

| Surface | Mobile | Desktop |
|---|---|---|
| Product grid | 2 columns | 5 columns (3 at md) |
| Product detail | 1 column + sticky bottom purchase bar | 2 columns: left summary (~1fr) / right purchase panel (~1.6fr) |
| Footer | Stacked accordion sections | 5-column row |

### Navigation

- **Desktop:** fixed top bar — logo · text nav · search field (pill,
  `sand` fill) · coin balance chip · avatar (`pine-tint` background,
  `pine-dark` initial, not the gogogo.id baby-blue).
- **Mobile:** search collapses to an icon; primary nav moves to a **fixed
  bottom tab bar** (icon + label, active item tinted `pine`).

### Dark-surface exception

A hero band or promo strip may still invert to a dark fill (`bg-ink` or
`bg-pine`) for visual punch — when it does, interactive elements on it opt
into a brighter **white** focus ring (`.focus-on-dark`) instead of the
default `pine`-tinted one, since that ring is invisible on a dark background.

---

## 8. Motion

- Default transition: `150ms` on background-color/color/transform.
- **Entrance:** page content fades + lifts 8px on load — `rise 0.5s
  cubic-bezier(0.22, 1, 0.36, 1)` — respects `prefers-reduced-motion`.
- **Loading dot:** a pulsing `0.625rem` circle (`wait-pulse`, `1.6s`) for the
  "waiting on setup" state.
- Signature ease-out curve: `cubic-bezier(0.22, 1, 0.36, 1)` — used
  everywhere, not Tailwind's default `cubic-bezier(0.4, 0, 0.2, 1)`.
