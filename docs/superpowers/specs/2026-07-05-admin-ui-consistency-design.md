# Admin UI Consistency Design

## Context

The admin panel (`apps/web-admin/client`, React SPA) went through a foundation
pass in PR #29 (`feat/admin-storefront-visual-alignment`, merged 2026-07-03):
storefront-matched tokens (colors, fonts, radius, shadow) were wired in, and a
shared component library (`PageHeader`, `DataTable`, `FilterBar`, `Card`,
`StatusBadge`, `Button`, `Switch`, `Badge`, etc.) already exists in
`src/components/shared/` and `src/components/ui/`.

Despite that foundation, the 12 admin pages adopt it inconsistently — each
page independently re-invents its own vertical spacing wrapper, some pages
hand-roll cards/tables/badges instead of using the shared components, and a
couple of pages bypass the design tokens outright (hardcoded hex colors, raw
Tailwind `red-*`/`green-*` instead of the app's `rust`/`grass` semantic
tokens). The result is the symptom list the user reported: differing card
heights, inconsistent padding/margin, non-uniform search bars and headers,
misaligned label/value rows.

A three-agent codebase audit (component library, page-by-page, and
storefront theme-token source-of-truth) confirmed the tokens and most needed
components already exist — the fix is consolidation and bug-fixing, not
building a new design system from scratch. Full audit findings are preserved
in this session's history; this spec captures the resulting design.

**Intended outcome:** all 12 admin pages (Dashboard, Catalog, Stock, Orders,
Users, Vouchers, Settings, Outbox, Reports, Payments, Admins, plus
UserDetail/ProductDetail) render with identical spacing rhythm, card
treatment, typography, and control sizing, with zero page-level one-off
styling for anything the shared library already covers.

## Scope decisions (confirmed with user)

- **Rollout**: one full pass, single PR/branch covering shared components and
  all 12 pages together (not phased).
- **Component strategy**: reuse and extend the existing `Button`/`Switch`
  rather than introducing separately-named `PrimaryButton`/`SecondaryButton`/
  `StatusSwitch` wrappers — avoids duplicate components doing the same job.
- **Standardization strictness**: full replacement of one-off/hand-rolled
  patterns with the shared components, no page-specific exceptions.

## 1. Spacing convention

No new spacing tokens are introduced — Tailwind's default scale
(`gap-1`…`gap-8` = 4/8/12/16/24/32px) already matches the requested 8pt
scale, and it's already the *majority* convention in the codebase. The fix
is codifying semantic usage and eliminating the minority deviations, not
adding a parallel token system.

| Transition | Value | Class |
|---|---|---|
| Page title → content | 24px | `gap-6` |
| Search/filter bar → list | 16px | `gap-4` |
| List → pagination | 16px | `mt-4` |
| Card → card (grid) | 16px | `gap-4` |
| Section → section | 24px | `gap-6` / `mb-6` |
| Card internal padding | 16px | existing `--card-spacing` |

## 2. Root fix: Dashboard's double-gap bug

Reading the actual component code (not just the audit summary) changed this
section from the original design. `PageHeader` (`src/components/shared/
PageHeader.tsx`) already applies its own `mb-6` (24px) universally and
correctly — every page except Dashboard keeps `PageHeader` as a sibling
*before* any body-level `gap-*`/`mb-*` wrapper, so there's no double-up.
`PageLayout` itself only sets `document.title` and isn't the cause of the
drift; making it own a blanket spacing wrapper (the original plan) would
have *introduced* the Dashboard bug on every other page instead of fixing
it, since their `PageHeader` margin would then stack with a new wrapper
margin.

**Fix (page-local, not a shared-component change):** `DashboardPage.tsx`
currently nests `<PageHeader title="Dashboard" />` as the *first child*
inside its own `<div className="flex flex-col gap-6">`, so flexbox `gap`
adds 24px between the header and `KpiRow` on top of `PageHeader`'s own
`mb-6` — 48px total, double every other page. Fix: make `PageHeader` a
sibling before that wrapper, matching the pattern already used correctly by
Settings/Reports/Outbox:

```tsx
return (
  <>
    <PageHeader title="Dashboard" />
    <div className="flex flex-col gap-6">
      <KpiRow />
      {/* ...rest unchanged... */}
    </div>
  </>
);
```

No changes to `PageLayout.tsx` or `PageHeader.tsx` are needed.

## 3. Component changes

**New components** (`src/components/shared/`):

- **`SearchBar.tsx`** — icon + input, fixed height/padding, single canonical
  width (`w-full sm:w-64`). Replaces the `w-48`/`w-64`/`w-80` variance found
  across Catalog/Stock/Users/Orders.
- **`ProgressBar.tsx`** — height/radius from existing radius tokens, color by
  threshold using the existing `grass`/`amberx`/`rust` tone palette. Replaces
  Stock's inline-`style` hand-rolled bar (`StockPage.tsx:174`).
- **`CardRow.tsx`** — a `{ label, value }` row (`flex items-center
  justify-between py-2`, label in `text-ink-soft`, value right-aligned).
  Reused wherever a page currently hand-rolls a label/value row (e.g.
  UserDetail's Profile card, which repeats
  `<div className="flex justify-between">...</div>` five times).
  `CardDivider` is **not** a new component — it's the existing
  `divide-y divide-line` convention already applied to `CardContent` in
  Settings/Catalog, now used consistently wherever `CardRow`s are stacked.
  `CardFooter` already exists in `components/ui/card.tsx` — reused as-is,
  not rebuilt.

**Extended components:**

- **`StatusBadge`** — tone map widened to cover role, outcome, and
  boolean/checkmark use cases currently misusing shadcn `Badge` or bespoke
  inline pills (Stock's stock-level badge, Users' role/banned badges,
  Vouchers' "Expiring soon" pill, Payments' outcome badge, Admins'
  checkmark badges, UserDetail's role/currency badges, Outbox's status
  pills). `StatusBadge` becomes the only component used for status-like
  values across the app.
- **`FilterBar`** — stops accepting margin via caller-supplied `className`;
  spacing comes for free from being a normal `PageLayout` flex child. This
  removes the `mb-4`/`mb-6`/none inconsistency found across 7 pages using an
  otherwise-identical component.

**Explicitly not created** (per scope decision above): no
`PrimaryButton`/`SecondaryButton`/`StatusSwitch` wrappers — `Button` variants
and `Switch` remain the single source for these concepts.

## 4. Page-by-page fixes

All 12 pages adopt `PageLayout`/`SearchBar`/`StatusBadge`/`Card`/`DataTable`/
`Switch`/`ProgressBar` per the above, removing one-off equivalents. Specific
fixes beyond the mechanical migration:

- **DashboardPage**: remove the double-gap wrapper bug (§2).
- **OutboxPage, ReportsPage**: replace raw `<table>` with shared `DataTable`;
  Reports' hardcoded hex chart colors (`#16a34a`, `#dcfce7`, and the
  `#e5e7eb` fallback) replaced with references to the existing CSS custom
  properties (`--color-grass`, `--color-line`).
- **ReportsPage, OutboxPage, ProductDetailPage**: hand-rolled
  `rounded-lg border border-line bg-card p-4` pseudo-cards replaced with the
  real `Card` component (`rounded-xl`, `shadow-soft`).
- **PaymentsPage, UserDetailPage**: bare `<h2>` + `DataTable` sections
  (underpaid/pending-internal orders, recent orders/wallet ledger) wrapped in
  `Card`/`CardHeader`/`CardContent` for consistent chrome with the rest of
  each page.
- **SettingsPage**: raw `red-*`/`green-*` inline banners migrated to the
  app's existing Sonner toast (already wired app-wide) rather than just
  recolored — this was already a tracked follow-up from the PR #29 pass, not
  a new requirement introduced here.
- **VouchersPage, SettingsPage**: raw `<input type="checkbox">` replaced with
  the shared `Switch` component (active-toggle, payment-method-enabled).
- **AdminsPage**: `FilterBar` margin `mb-6` → `mb-4` to match the other 6
  `FilterBar`-using pages.
- **OrdersPage**: pagination Prev/Next buttons get `size="sm"` to match
  Outbox/Payments' equivalent controls.
- Every status-like pill across all pages converges on `StatusBadge` (§3).

## Non-goals

- No new spacing/color/radius/shadow token system — the existing
  storefront-sourced tokens in `index.css` are sufficient and are the
  source of truth already referenced by both `apps/web-admin` and
  `apps/storefront`.
- No new `PrimaryButton`/`SecondaryButton`/`StatusSwitch` components.
- No functional/business-logic changes to any page — this is a visual
  consistency pass only. (Any orphaned-route issues are tracked separately;
  see the `project-web-admin-orphaned-routes` memory — out of scope here.)
- No dark mode work (removed entirely in PR #30; admin is permanently
  light-only).

## Verification

- `pnpm --filter @app/web-admin-client build` (React SPA build, required
  before dev/test per project convention)
- `pnpm typecheck` and `pnpm test` must stay green
- Manual browser walkthrough of all 12 pages (Dashboard, Catalog, Stock,
  Orders, Users, Vouchers, Settings, Outbox, Reports, Payments, Admins, and
  the UserDetail/ProductDetail detail views) to visually confirm identical
  title→content spacing, card treatment, search bar sizing, status pill
  appearance, and no layout regressions.
