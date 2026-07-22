# 10 — UI Review Checklist

**Scope:** the checklist every contributor (human or AI) completes before merging a
UI change to `apps/web-admin/client`. Each item cross-references the document that
defines the rule — if an item fails, go read that section, don't guess.

Copy the relevant sections into a PR description, or run through this mentally
before opening the PR. Not every section applies to every change (a pure copy fix
doesn't need the Table Rules section) — but check the ones that do apply, honestly.

---

## Layout (`02_ADMIN_LAYOUT.md`)

- [ ] The page renders inside the standard shell — no custom max-width, padding, or
      duplicated sidebar/topbar.
- [ ] The page follows the mandatory hierarchy: Title → Description → Summary Cards
      (optional) → Toolbar → Bulk Actions (conditional) → Table → Pagination.
- [ ] `PageHeader` is a **sibling** of the rest of the page body, not nested inside
      the same `gap-*` flex container (the documented double-spacing bug).
- [ ] No redundant breadcrumb + separate "← Back" button on the same page.

## Typography (`01_DESIGN_SYSTEM.md` §4)

- [ ] The page `<h1>` comes from `PageHeader`, not a hand-styled element.
- [ ] Font sizes/weights match the documented scale (`font-display text-2xl/text-3xl`
      for titles/big numbers, `text-sm`/`text-xs` for body/captions) — no new size
      introduced.
- [ ] Section headings use real heading elements (`<h2>`/`<h3>`, or `CardTitle
      as="h2"`), not a styled `<div>`/`<span>`.
- [ ] `font-mono` used for codes/identifiers, not applied elsewhere.

## Spacing (`01_DESIGN_SYSTEM.md` §5)

- [ ] All spacing values are tokens from the scale (4/8/12/16/24/32px) — no
      arbitrary `[13px]`-style values.
- [ ] Section-to-section gaps match the documented transitions (title→content 24px,
      toolbar→list 16px, list→pagination 16px, card grid 16px).

## Responsiveness (`02_ADMIN_LAYOUT.md` §6, `08_UX_RULES.md` §17)

- [ ] Checked at mobile (<640px), tablet (640–1023px), and desktop (≥1024px).
- [ ] Tables switch to card-stack layout below `md` (768px) via `DataTable` — not a
      custom mobile rendering path.
- [ ] Sidebar/topbar responsive behavior wasn't touched/duplicated.
- [ ] No horizontal scroll on the page body itself (only inside a table's own
      `overflow-x-auto` wrapper).

## Accessibility (`08_UX_RULES.md` §8)

- [ ] Every icon-only control has an `aria-label`, at every breakpoint.
- [ ] Every `Input` has an associated `Label` (or `aria-label`).
- [ ] Focus is visible on every interactive element (`focus-visible` ring not
      stripped).
- [ ] Tab order follows visual order.
- [ ] New/changed text meets WCAG AA contrast (4.5:1) against its background.
- [ ] Custom (non-Tailwind-utility) animations are `motion-safe:`-gated.
- [ ] Tap targets on frequently-tapped small controls are ≥44×44px.

## Loading (`08_UX_RULES.md` §1)

- [ ] Loading uses a skeleton shaped like the eventual content (table → `SkeletonRow`
      via `DataTable`; KPI card → its own `Loading…` branch) — not a full-page
      spinner.
- [ ] A pending mutation disables its trigger button and shows a pending label
      ("Creating…", etc.).

## Empty State (`03_COMPONENT_LIBRARY.md` §Empty State, `08_UX_RULES.md` §2)

- [ ] Uses `EmptyState` with a bold headline + specific, actionable subline.
- [ ] Genuinely-empty state offers the primary create action; filtered-to-empty
      state offers "Clear Filters"/"Refresh" instead — not generic copy that assumes
      the wrong cause.

## Error State (`04_CRUD_TEMPLATE.md` §Error State, `08_UX_RULES.md` §3)

- [ ] A failed initial load renders `text-rust` error copy inside the page shell,
      not a blank/crashed page.
- [ ] A failed mutation surfaces feedback (toast or inline `text-rust`) — never
      silent.
- [ ] Error messages route through `describeError()` where applicable, not a raw
      server message.

## Performance

- [ ] No unnecessary duplicate API calls for data another component on the same page
      already fetches (KPI cards sharing one query is the model — see
      `07_DASHBOARD_GUIDELINES.md` §3).
- [ ] Large lists use server pagination (full tier) rather than fetching an unbounded
      result set client-side, once the dataset is expected to grow (see
      `04_CRUD_TEMPLATE.md` §1).
- [ ] `pnpm --filter @app/web-admin-client build` succeeds (`09_CODE_STYLE.md` §9).

## Consistency / Component Reuse (`00_AI_RULES.md` §3, `09_CODE_STYLE.md` §8)

- [ ] No new one-off component was written where an existing `components/ui/*` or
      `components/shared/*` component already covers the need.
- [ ] No `PrimaryButton`/`SecondaryButton`/`StatusSwitch`-style wrapper was added.
- [ ] No raw `<table>` was hand-rolled — `DataTable` used instead.
- [ ] No `window.confirm()` — `ConfirmDialog`/`SaveConfirmDialog` used instead.
- [ ] No native `<input type="checkbox">` used as a settings-style toggle —
      `Switch` used instead.
- [ ] Any new status value was added to `StatusBadge`'s tone map, not given a
      bespoke pill.

## Design Tokens (`01_DESIGN_SYSTEM.md`)

- [ ] No raw Tailwind palette color (`red-500`, `green-100`, `teal-*`, etc.) used
      for anything semantic — `pine`/`grass`/`amberx`/`rust` used instead.
- [ ] No hardcoded hex value anywhere (including chart colors) — CSS variables/
      Tailwind utilities used instead.
- [ ] No new radius/shadow value introduced outside the documented scale.
- [ ] No new icon size outside the documented scale (`h-3.5`/`h-4`/`h-5`/`size-3`).
- [ ] No `dark:` classes or dark-mode toggle added (admin is light-only, §12).

## Animation (`01_DESIGN_SYSTEM.md` §8, `08_UX_RULES.md` §15–16)

- [ ] Reuses `lib/motion.ts`'s shared variants/constants — no new easing curve or
      duration defined inline.
- [ ] Animation communicates a state change, not pure decoration.
- [ ] No second press/tap animation added to a `Button` (it's automatic).

## CRUD Rules (`04_CRUD_TEMPLATE.md`)

- [ ] The correct tier was chosen (simple client-filtered vs. full server-paginated
      + bulk) for the dataset size/need.
- [ ] Create/edit uses either the full-page pattern (primary entities) or the dialog
      pattern (secondary/bulk edits) — not a bare unlabeled inline table row.
- [ ] Form validation follows the manual `useState` + `canSubmit` pattern — no new
      schema-validation library introduced.
- [ ] Selection state (if any) is page-owned, cleared when filters change.
- [ ] Sorting (if any) uses a `Select` + client-side `.sort()`, not clickable column
      headers.

## Table Rules (`05_TABLE_GUIDELINES.md`)

- [ ] Built on `DataTable`, not a raw `<table>`.
- [ ] No abbreviated column headers.
- [ ] Status-like cell values render through `StatusBadge` (or a domain-specific
      sibling), not a bespoke colored span.
- [ ] No raw enum/snake_case value or bare numeric ID rendered as a cell value
      without a human-readable label.
- [ ] Row actions use a `DropdownMenu` with `stopPropagation()` on its container when
      the row also has `onRowClick`.
- [ ] No clickable-header sorting or column-resize added.

## Dashboard Rules (`07_DASHBOARD_GUIDELINES.md`)

- [ ] Every new section answers one of "what happened / what needs attention / what
      to do next," and is placed in that priority order.
- [ ] Every chart has a title/context — never bare.
- [ ] Dashboard-only components are not assumed to be live without verifying
      they're actually rendered in `DashboardPage.tsx` (see
      `07_DASHBOARD_GUIDELINES.md` §7 for the `QuickActionsBar` cautionary
      example — removed as dead code, now a historical reference only).

## Settings Rules (`06_SETTINGS_GUIDELINES.md`)

- [ ] New settings fields were added to the matching client-side grouping constant,
      kept in sync with the server's `EDITABLE` whitelist — not left to fall through
      to "Other Settings" by default.
- [ ] No accordion/collapse pattern introduced — flat cards + jump-nav used instead.
- [ ] Every settings mutation (field save, toggle, action button) goes through
      `SaveConfirmDialog` before firing.
- [ ] Secret fields stay masked in view mode; the reveal/copy pattern (not the
      settings mask) is used only for credentials the admin legitimately needs to
      read back.
- [ ] A gateway/integration's displayed status can't contradict itself
      (configured always gates the label, regardless of the raw toggle value).

## Final check

- [ ] `pnpm typecheck` and `pnpm test` are green (repo-wide, per root `CLAUDE.md`).
- [ ] The change was actually opened in a browser at least once (dev server or
      build output), not just type-checked — see the golden-path testing guidance in
      the root `CLAUDE.md`.
- [ ] If this change establishes a new pattern not covered by `01`–`09`, those docs
      were updated in the same PR — don't let a new precedent go undocumented.
