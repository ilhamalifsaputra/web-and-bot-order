# UI/UX Audit Prompt — Web Admin, Storefront, Telegram Bot

Use this as a standing brief when auditing any of this project's three
client-facing surfaces. Audit only — do not change business logic, and do
not ship code changes until findings are reviewed and prioritized with the
user.

## Ground rules (all surfaces)
- Presentation-layer only. Never touch pricing/stock/order logic, CRUD
  helpers in `packages/db/src/crud/*`, or notification/outbox dispatch.
- Report findings as a prioritized list (Critical / High / Medium / Low),
  each with: location (`file:line`), what's wrong, concrete user-facing
  impact, and a suggested fix.
- Call out *systemic* patterns (a fix that should apply to many
  pages/screens once) separately from one-off issues.
- Before citing a known issue from prior notes/memory as still valid,
  re-check the current code — treat prior audit notes as a lead, not a
  fact.
- Respect existing conventions instead of proposing a new design language;
  cite the specific `CLAUDE.md` convention a finding violates.

## 1. `apps/web-admin/client` — admin panel (React SPA)
Source of truth for the visual language: the storefront's "Clean Modern"
theme (brand blue `#2563eb`, Outfit/Manrope/JetBrains Mono, fixed radius
scale xs/sm/md/lg/pill, `shadow-soft`/`shadow-lift`). Admin is intentionally
**light-only** — dark mode was removed on purpose; don't recommend
reintroducing it.

Audit for:
- **Consistency of shared primitives** — pages should use `DataTable`,
  `StatusBadge`, `ConfirmDialog`, `EmptyState`, `PageHeader`, `FilterBar`,
  and Sonner toasts rather than hand-rolled tables, raw shadcn `<Badge>`,
  or hardcoded color banners. Flag any page still doing its own thing.
- **Empty / loading / error states** — every list/detail page should have
  a deliberate empty state and skeleton/loading state, not a blank screen.
- **Destructive-action confirmation** — deletes/deactivates should route
  through `ConfirmDialog`, not a bare `confirm()` or silent action.
- **Navigation & IA** — sidebar grouping, breadcrumb/back affordances,
  Ctrl+K search discoverability and keyboard-accessibility.
- **Accessibility** — color contrast against the brand palette, visible
  focus states, keyboard operability of dialogs/dropdowns/tables.
- **Responsive behavior** — the `max-w-[1440px]` content area and gutter
  scaling at 16/20/24/32px breakpoints; check tables/forms don't break
  below common admin viewport widths.
- **Visual parity with the storefront** — since the explicit goal is "one
  product ecosystem," flag anything in admin that reads as a different
  product (mismatched type scale, spacing, iconography, tone).

## 2. `apps/storefront/client` — public shop (React SPA + Fastify JSON API)
This app is the *reference* implementation of the Clean Modern theme —
weight internal-consistency issues here heavily, since admin is meant to
follow its lead, not the other way around.

Audit the customer journey end to end: catalog → product detail → cart →
checkout → account/orders → support/reviews. Focus on:
- **Mobile-first responsiveness** — most traffic arrives from a Telegram
  in-app browser/webview; verify layouts, tap targets, and modals work at
  narrow widths, not just desktop.
- **Loading / empty / error states** — empty cart, no orders yet, no
  search results, out-of-stock product, failed payment — each needs a
  clear, non-technical message and a way forward.
- **Checkout clarity** — price breakdown legibility (money must render via
  the shared money formatting, never a raw float), step progression,
  ability to correct a mistake without losing the cart.
- **Auth flows** — login/register/forgot/reset password: error messaging,
  password requirements surfaced up front, redirect behavior after
  success. This is the public untrusted surface, so treat friction here as
  higher priority than on admin.
- **Trust signals** — order status visibility, review/rating display,
  referral program clarity if surfaced in the UI.

## 3. `apps/order-bot` — Telegram bot (grammY)
For the **customer shopping flow** (catalog → product detail →
checkout/order, cart excluded), use the dedicated
`telegram-shop-ux-auditor` subagent instead of auditing it manually here —
it already runs an audit-first, approval-gated workflow scoped to exactly
that flow.

For everything that agent doesn't cover (admin-side wizards/commands,
support flow, referral flow, notifications), audit against the "Bot UX
(grammY)" conventions in `CLAUDE.md`:
- **Edit the bubble, don't just toast** — every terminal action should end
  on `smartEdit`/`adminEdit` plus a navigation keyboard, not a stale
  screen left behind.
- **One active keyboard per chat** — check `retireKeyboard` is called
  when a new screen supersedes an old one; look for taps against
  stale/dead keyboards.
- **Single-bubble wizards** — multi-step admin flows should stay on one
  anchor bubble (`adminAnchor`/`menuAnchor`) with `consumeInput` deleting
  the user's typed steps; validation errors and the final confirmation
  should land in the same bubble.
- **Toast vs. alert** — routine success as a toast, destructive/error as
  `show_alert: true`; slow mutations should show a buttonless
  `admin.processing` state before completing.
- **No leaked English / no dead ends** — every customer/admin string goes
  through `t(ctx, key, args)` with matching `en`/`id` keys and
  `{placeholders}`; every terminal screen offers at least one forward
  action (Menu / My Orders / Back).

## Output format
For each surface, produce:
1. A prioritized findings list (per the ground rules above).
2. A short "systemic patterns" summary — issues worth fixing once across
   many screens rather than page-by-page.
