# 01 — Design System (Tokens & Foundations)

**Scope:** every visual primitive used by the Trustance Admin Dashboard
(`apps/web-admin/client`). Every color, spacing value, radius, shadow, font, motion
curve, icon size, and breakpoint an admin page can use is defined here. If a value
you need isn't in this document, it doesn't exist yet — do not invent one; either
find the closest documented token or raise the gap.

Source of truth in code: `apps/web-admin/client/src/index.css` (two `@theme` blocks)
and `apps/web-admin/client/components.json`.

---

## 1. Design philosophy

Trustance Admin is a **premium digital marketplace back-office** — the products sold
through it (VPN, streaming, gift cards, software, AI tools, digital accounts) are
premium and trust-sensitive, and the admin panel that runs the business has to read
as equally premium and trustworthy. The visual target is the class of tool run by
Stripe, Linear, Vercel, Shopify Admin, GitHub, and Supabase — **not** a generic
Bootstrap admin template (AdminLTE, CoreUI, Tabler). Do not copy any of those
products pixel-for-pixel; use them only as a calibration for quality bar.

Concretely, that means:

- **Minimal.** Every screen shows exactly what's needed to act, nothing more.
  Decoration that doesn't carry information is removed.
- **Whitespace is intentional**, not accidental. Spacing follows the scale in §4 —
  never "whatever looks okay," always a token.
- **Usability over visual effects.** No gradients, no glassmorphism, no drop-shadows
  for decoration. Shadows exist only to communicate elevation (`soft`/`lift`, §6) for
  functional reasons — a card resting on the page, a menu floating above it.
- **Every interaction has a purpose.** Animation communicates state change (a save
  succeeded, a panel opened) — it is never purely decorative. See §8.
- **Fast.** The UI must feel instant. Motion durations are short (150–350ms, §8),
  loading states are skeletons rather than spinners wherever a shape is knowable in
  advance (see `08_UX_RULES.md`).
- **Enterprise-scalable.** The system must hold up across hundreds of pages and
  thousands of components built by many contributors over years — see
  `00_AI_RULES.md` §7 for the "consistency over creativity" mandate this implies.

## 2. Stack (what actually renders this)

- **React 18 + TypeScript**, built with **Vite**.
- **Tailwind CSS v4**, CSS-first configuration. There is **no `tailwind.config.*`
  file** — the entire theme (colors, radius, shadow, fonts) is declared directly in
  `apps/web-admin/client/src/index.css` using `@theme` blocks, and Tailwind's
  `@tailwindcss/vite` plugin (wired in `vite.config.ts`) generates utility classes
  from those CSS custom properties automatically.
- **shadcn/ui**, style variant **`radix-nova`** (`components.json`), base color
  `neutral` (overridden by the app's own palette — see §3), `cssVariables: true`.
  Primitives are hand-copied into `src/components/ui/` (not consumed as a package),
  so they can be extended directly — see `03_COMPONENT_LIBRARY.md` for what's already
  been added on top of stock shadcn.
- **Radix UI** (`radix-ui`, the consolidated package) under every interactive
  primitive (Dialog, Popover, DropdownMenu, Select, Tabs, Switch, Checkbox, etc.).
- **`class-variance-authority` (cva)** for every component with variants/sizes.
- **`framer-motion`** for interactive micro-animations (button press, dropdown
  panels, page transitions, staggered lists) — see §8.
- **`lucide-react`** — the *only* icon library (`components.json`:
  `"iconLibrary": "lucide"`). Never mix in another icon set.
- **`@tanstack/react-query`** for all server-state data fetching/caching/mutations.
- **`sonner`** for toast notifications.
- **`recharts`** for charts.
- **`tailwind-merge`** (via the `cn()` helper in `src/lib/utils.ts`) for safely
  combining conditional Tailwind class strings.

Notably **absent**, and not to be introduced casually: `react-hook-form`, `zod` (see
`04_CRUD_TEMPLATE.md` for the manual validation pattern used instead), any
Sheet/Drawer package, any global client-state library (Redux, Zustand, Jotai — server
state lives in React Query, UI state lives in local `useState`, see
`09_CODE_STYLE.md`).

## 3. Color tokens

Two token layers exist in `index.css` and are **intentionally numerically
synchronized** — shadcn's semantic layer is repointed at the same palette as the
hand-authored "ported" layer (which mirrors the storefront's Nunjucks theme, so the
whole product — bot, storefront, admin — shares one palette). Always prefer the
**semantic Tailwind utility names** (`bg-card`, `text-foreground`, `border-border`)
inside generic/shadcn-derived components, and the **named palette utilities**
(`bg-paper`, `text-ink`, `bg-pine`) everywhere else in page/feature code — this
matches the existing codebase split.

### 3.1 Semantic layer (shadcn tokens)

| Utility | CSS var | Value | Use |
|---|---|---|---|
| `bg-background` / `text-foreground` | `--background` / `--foreground` | `#f6f8fb` / `#1b2330` | Page canvas |
| `bg-card` / `text-card-foreground` | `--card` / `--card-foreground` | `#ffffff` / `#1b2330` | Card, dialog, dropdown surfaces |
| `bg-popover` / `text-popover-foreground` | `--popover` / `--popover-foreground` | `#ffffff` / `#1b2330` | Popover/tooltip surfaces |
| `bg-primary` / `text-primary-foreground` | `--primary` / `--primary-foreground` | `#2563eb` / `#ffffff` | Primary actions |
| `bg-secondary` / `text-secondary-foreground` | `--secondary` / `--secondary-foreground` | `#eef1f6` / `#1b2330` | Secondary actions/fills |
| `bg-muted` / `text-muted-foreground` | `--muted` / `--muted-foreground` | `#eef1f6` / `#5a6473` | Muted backgrounds, secondary text |
| `bg-accent` / `text-accent-foreground` | `--accent` / `--accent-foreground` | `#eef1f6` / `#1b2330` | Hover/active fills |
| `bg-destructive` | `--destructive` | `#dc2626` | Destructive actions |
| `border-border` | `--border` | `#e3e8ef` | Default border |
| `border-input` | `--input` | `#e3e8ef` | Form control border |
| `ring-ring` | `--ring` | `#2563eb` | Focus ring |

`--chart-1..5` and `--sidebar*` CSS vars also exist in `index.css` as shadcn
boilerplate but are **not used anywhere in the live app** — the real `Sidebar`
component uses the named palette tokens below, and charts use the palette's
semantic colors (grass/pine/amberx/rust), not the grayscale `--chart-*` ramp. Do not
start using `--chart-*`/`--sidebar*` without first checking whether that's still
true.

### 3.2 Named palette (the tokens you'll use most in page code)

| Token | Hex | Meaning / use |
|---|---|---|
| `paper` | `#f6f8fb` | Page background |
| `sand` | `#eef1f6` | Subtle fill, neutral badge background, hover fill |
| `line` | `#e3e8ef` | Borders, `divide-y divide-line` |
| `ink` | `#1b2330` | Primary text |
| `ink-soft` | `#5a6473` | Secondary text (labels, captions, muted content) |
| `ink-faint` | `#626f83` | Tertiary text/icons — darkened from an earlier `#97a1b1` specifically to pass WCAG AA (4.5:1) against white; **never revert to a lighter faint tone** |
| `pine` | `#2563eb` | Primary brand blue — primary actions, links, active nav state |
| `pine-dark` | `#1d4ed8` | Primary hover/pressed |
| `pine-tint` | `#e6effe` | Primary tint background (active sidebar item, info badges) |
| `grass` | `#16a34a` | Success / positive |
| `grass-dark` | `#15803d` | Success emphasis |
| `grass-tint` | `#e7f6ec` | Success tint background |
| `amberx` | `#b45c0a` | Warning |
| `amberx-tint` | `#fdedcf` | Warning tint background |
| `rust` | `#dc2626` | Danger / error / destructive |
| `rust-dark` | `#b91c1c` | Danger emphasis |
| `rust-tint` | `#fde7e7` | Danger tint background |

### 3.3 Color rules

- **Never** use raw Tailwind palette colors (`text-red-500`, `bg-green-100`,
  `bg-teal-600`, etc.) for anything semantic. Use `rust`/`grass`/`amberx`/`pine` (or
  the shadcn `destructive`/`primary` equivalents). This was an explicit, named bug
  fixed in the July 2026 consistency pass — reintroducing it regresses that work.
- **Never** hardcode a hex value in a chart or inline style — reference the CSS
  variable (`var(--color-grass)`, `var(--color-line)`, etc.) or the corresponding
  Tailwind utility.
- Status colors always map through the 4-tone system: **success → grass, warning →
  amberx, danger → rust, neutral → sand/ink-soft**. Never invent a 5th tone for a new
  status; pick the closest of the four.
- Destructive UI (buttons, badges) uses the **tinted** style
  (`bg-destructive/10 text-destructive`), not solid red fills — see `button.tsx`'s
  `destructive` variant in `03_COMPONENT_LIBRARY.md`. Solid red is reserved for
  small, deliberate accents (e.g. an urgency dot), not large surfaces.

## 4. Typography

Three font families, loaded via `@fontsource` and declared in `index.css`:

| Token | Family | Loaded weights | Use |
|---|---|---|---|
| `font-display` | Outfit | 500, 600, 700 | Page titles (`<h1>`), section headers, prominent numerals (KPI values, stat cards) |
| `font-sans` | Manrope | 400, 500, 600, 700 | Body text, UI labels, table cells — the global default (`html { @apply font-sans }`) |
| `font-mono` | JetBrains Mono | 400, 500 | Codes/identifiers — order codes, TOTP secrets, API keys |

### Type scale (observed, canonical usage)

| Class | Where |
|---|---|
| `font-display text-3xl font-semibold text-ink` | Large standalone stat numbers (e.g. Payments page totals) |
| `font-display text-2xl font-semibold text-ink` | Page `<h1>` (via `PageHeader`) |
| `font-display text-xl font-semibold text-ink` | Card-level stat values (`StatCard`) |
| `text-sm font-semibold text-ink` | Section `<h2>` sub-headers within a page ("Items (n)", "History") |
| `text-xs font-semibold uppercase tracking-wider text-ink-soft` | Sidebar group headers, settings section-label captions |
| `font-mono text-sm font-semibold text-ink` | Order codes and other identifiers |
| `text-sm text-ink-soft` | Secondary/body copy — descriptions, table cell values |
| `text-xs text-ink-soft` | Tertiary/caption copy |

Rules:
- Page `<h1>` is always rendered through `PageHeader` (`02_ADMIN_LAYOUT.md`) — never
  hand-write a page title's classes.
- Use real heading elements (`<h1>`/`<h2>`), not styled `<div>`/`<span>`, for
  anything that is structurally a heading — `CardTitle`'s `as` prop exists
  specifically so a visual style doesn't have to sacrifice semantics (see
  `03_COMPONENT_LIBRARY.md` §Card).
- Never introduce a font size outside this scale for body/heading text. `text-4xl`+
  and sizes between the ones listed do not currently exist in the app and should not
  be added without updating this table first.

## 5. Spacing scale

Tailwind's default spacing scale is used as-is (4px increments) — there is no custom
spacing token set. In practice, admin pages use a small, consistent subset of that
scale for structural spacing:

| Value | Tailwind class | Use |
|---|---|---|
| 4px | `gap-1` / `p-1` | Tightest inline gaps (icon-to-label) |
| 8px | `gap-2` / `p-2` | Form control internal gaps, button icon gaps |
| 12px | `gap-3` / `p-3` | Compact card padding (`Card size="sm"`) |
| 16px | `gap-4` / `p-4` | **Default card padding**, toolbar→list gap, card-to-card grid gap |
| 24px | `gap-6` / `mb-6` | Page-title→content gap, section→section gap |
| 32px | `gap-8` | Large structural gaps (e.g. Settings jump-nav ↔ content column) |

### Canonical page-section transitions

| Transition | Value | Class |
|---|---|---|
| Page title → page content | 24px | `gap-6` (applied by the page's outer flex column, **not** by `PageHeader` itself, see `02_ADMIN_LAYOUT.md`) |
| Search/filter bar → list | 16px | `gap-4` |
| List → pagination | 16px | `mt-4` |
| Card → card (grid) | 16px | `gap-4` |
| Section → section | 24px | `gap-6` / `mb-6` |
| Card internal padding | 16px default / 12px `size="sm"` | `--card-spacing` CSS var on `Card` |

Never apply an arbitrary pixel value (`mb-[13px]`, `gap-[10px]`) — round to the
nearest token above.

## 6. Radius scale

Declared as explicit steps (not a single base `--radius` + `calc()`, unlike stock
shadcn):

| Utility | Value |
|---|---|
| `rounded-xs` | `0.25rem` (4px) |
| `rounded-sm` | `0.5rem` (8px) |
| `rounded-md` | `0.75rem` (12px) |
| `rounded-lg` | `0.75rem` (12px, same as `md`) |
| `rounded-xl` | `1rem` (16px) — **standard for `Card`** |
| `rounded-2xl` | `1.25rem` (20px) |
| `rounded-3xl` | `1.5rem` (24px) |
| `rounded-4xl` | `9999px` (fully round) — **standard for `Badge`, avatars, pills** |

Cards use `rounded-xl`; buttons/inputs use `rounded-lg`; badges/pills use
`rounded-4xl`. Do not introduce a new radius value — pick the step above that matches
the component category, matching what similar components already use.

## 7. Shadow / elevation

Two elevation tokens only — this is a flat system, not a multi-level shadow ramp:

| Token | Value | Use |
|---|---|---|
| `shadow-soft` | `0 1px 2px rgba(16,24,40,.04), 0 8px 24px -14px rgba(16,24,40,.12)` | **Resting elevation** — `Card`, default `Button` |
| `shadow-lift` | `0 2px 4px rgba(16,24,40,.06), 0 16px 36px -18px rgba(16,24,40,.18)` | **Elevated/floating** — dropdown panels, popovers, the sticky bulk-action bar |

Never author a custom `box-shadow` value. If neither token is elevated enough for a
new case, that's a design-system gap to raise, not a reason to freehand a shadow.

## 8. Motion, animation, transition

Defined in `apps/web-admin/client/src/lib/motion.ts` and consumed via `framer-motion`:

| Token | Value |
|---|---|
| `EASE` | `[0.22, 1, 0.36, 1]` |
| `DURATION.fast` | `0.15s` |
| `DURATION.base` | `0.22s` |
| `DURATION.slow` | `0.35s` |

Shared variants (import, don't redefine): `fadeUp`, `fadeIn`, `staggerContainer`,
`staggerItem`. Shared interaction preset: `pressable = { whileTap: { scale: 0.97 } }`
— applied to **every** `Button` by default (it's baked into `button.tsx`, not opt-in
per instance).

Named custom keyframe: `--animate-checkmark-pop` (`0.35s
cubic-bezier(0.34,1.56,0.64,1)`), used for save-confirmation checkmarks
(`SaveConfirmDialog`, `ImageUploadField`). Always apply it with the `motion-safe:`
variant prefix (`motion-safe:animate-checkmark-pop`) so it's suppressed under
`prefers-reduced-motion` — see `08_UX_RULES.md` §Reduced Motion.

Rules:
- Never introduce a new easing curve or duration constant per-component — import
  from `lib/motion.ts`.
- Animation exists to communicate state, not to decorate. A list re-ordering, a panel
  opening, a save succeeding — yes. A hover glow with no functional meaning — no.
- Every custom (non-Tailwind-utility) animation must be `motion-safe:`-gated.

## 9. Icon system

**Lucide (`lucide-react`) is the only icon library.** Never import from
`@radix-ui/react-icons`, `react-icons`, or any other set — an icon from a different
family will look visually inconsistent (different stroke width/corner radius) next
to Lucide icons.

### Sizing scale

| Class | Pixel size | Use |
|---|---|---|
| `h-3.5 w-3.5` | 14px | Breadcrumb chevron separators, inline secret-field markers |
| `h-4 w-4` (default) | 16px | **Standard size** — nav item icons, button leading icons, stat-card icons, table row-action icons |
| `h-5 w-5` | 20px | Larger touch-target icons — mobile hamburger, dialog close |
| `size-3` | 12px | Icons inside `xs` buttons, inside `Badge` (`[&>svg]:size-3!`) |
| `w-12 h-12` / `size-16` container + `size-10` icon | 48px / 64px container + 40px icon | **Hero/decorative icon exception** — a single large icon standing alone as the visual focus of an empty-state or a success-confirmation moment, never paired inline with text. Used by `EmptyState` (`w-12 h-12`) and `SaveConfirmDialog`'s success checkmark (`size-16` tinted circle containing a `size-10` icon). This is a deliberate, size-system-agnostic exception for these two specific full-block moments — do not extend it to any icon that sits next to a label, in a button, badge, or table cell (those stay on the scale above). |

Button-embedded icons auto-size via `button.tsx`'s
`[&_svg:not([class*='size-'])]:size-4` rule — an `<svg>` child with no explicit size
class inside a `Button` becomes 16px automatically; only override with an explicit
`size-*`/`h-*`/`w-*` class when you deliberately need a different size (e.g. inside an
`xs` button).

Icons paired with text in a flex row should carry `shrink-0`/`flex-shrink-0` so long
labels don't squash them.

Never introduce a new icon size outside this scale, and never extend the hero/decorative
exception above to a third component without updating this table first.

## 10. Component size tokens (cross-reference)

Full variant/size definitions live in `03_COMPONENT_LIBRARY.md`; the sizes below are
listed here as the canonical scale so new components stay aligned:

| Component | Sizes |
|---|---|
| Button | `xs` (h-6) / `sm` (h-7) / `default` (h-8) / `lg` (h-9); icon-only: `icon-xs` (6) / `icon-sm` (7) / `icon` (8) / `icon-lg` (9) |
| Input | `h-8` (single fixed size — no size prop) |
| Card | `default` (16px padding) / `sm` (12px padding) |
| Table row/cell | `p-2` cell padding (fixed) |
| Dialog / AlertDialog | `default` / `sm` |
| Drawer *(spec'd, not yet built — see `03_COMPONENT_LIBRARY.md`)* | `default` (~400px) / `lg` (~560px) |
| Badge | `h-5` (single fixed size — no size prop) |
| Avatar | `sm` / `default` / `lg` |
| Switch | `sm` / `default` |
| Select trigger | `sm` / `default` |

## 11. Responsive breakpoints

**No custom breakpoints are defined** — the app uses Tailwind v4's built-in defaults:

| Breakpoint | Min width | What hinges here |
|---|---|---|
| `sm` | 640px | `PageHeader` title/actions row switches from stacked to horizontal; `SearchBar` grows from full-width to `w-64`; TopBar search label/kbd hint appear |
| `md` | 768px | `DataTable` switches from mobile card-stack to table layout; TopBar user name label appears; `Input` font size drops from 16px to 14px (iOS zoom-prevention) |
| `lg` | 1024px | **Primary hinge** — `Sidebar` switches from mobile slide-in drawer to permanently visible fixed column; content padding increases to `px-6` |
| `xl` | 1280px | Content padding increases to `px-8` |
| `2xl` | 1536px | Available but not currently load-bearing anywhere in the admin shell |

See `02_ADMIN_LAYOUT.md` for exactly how the shell responds at each breakpoint.

## 12. Dark mode — not supported (by design, not by omission)

**The admin dashboard is permanently light-mode only.** There is a single `:root`
color-variable scope in `index.css`; no `.dark` class, no `prefers-color-scheme`
media query, no `next-themes`/`ThemeProvider`, and no theme-toggle UI exist anywhere
in the client.

This is a deliberate reversal, not an oversight: dark mode was built (per
`docs/superpowers/specs/2026-06-27-admin-panel-saas-redesign.md`, which specified a
`.dark` class + `localStorage` toggle) and then **fully removed** in a later commit,
with `docs/superpowers/specs/2026-07-05-admin-ui-consistency-design.md` stating
explicitly: *"No dark mode work (removed entirely; admin is permanently
light-only)."*

**Rule: never add `dark:` Tailwind variants, a `.dark` class toggle, or any
dark-palette CSS variables to this app.** If a future product decision reverses this
again, it should be a deliberate, repo-wide initiative that updates this document
first — not a single component quietly growing `dark:` classes.
