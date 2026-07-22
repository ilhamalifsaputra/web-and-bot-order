# 00 — AI Development Rules

**Audience:** every AI coding agent (Claude Code, GPT, Copilot, Cursor, or any future
tool) working on `apps/web-admin/client` — the Trustance Admin Dashboard.

**Status of this document:** binding. These rules override an agent's default
instincts about "improving" or "modernizing" the UI. If a rule here conflicts with
what looks like a better idea in the moment, the rule wins. If you believe a rule is
actually wrong, say so and propose a change to this document — do not silently
deviate in a single page.

This file is the entry point into the design system. Docs `01`–`10` are the system
itself; this file tells you how to *use* them.

---

## 1. Before you touch any UI code

1. Read this file in full.
2. Read `01_DESIGN_SYSTEM.md` (tokens) and `02_ADMIN_LAYOUT.md` (page shell) — every
   page depends on both.
3. Read the specific doc(s) for the surface you're changing, using the decision tree
   in §2.
4. Open the closest existing real page as a reference implementation before writing
   new JSX. See §6 for which page to open for which situation.
5. Only then start editing.

Skipping step 1–3 is the single most common cause of design-system drift. Every
inconsistency documented in `docs/ui-refactor/` and the two 2026-07 consistency
passes traces back to a page being built by reading a sibling page instead of the
docs, and copying that sibling's mistakes forward.

## 2. Decision tree — which doc(s) govern this task

| You are about to... | Read |
|---|---|
| Add a brand-new admin page of any kind | `02_ADMIN_LAYOUT.md` (page hierarchy), `09_CODE_STYLE.md` (file placement) |
| Add a list/index page (orders, products, any "manage X" screen) | `04_CRUD_TEMPLATE.md` + `05_TABLE_GUIDELINES.md` |
| Add a create or edit form | `04_CRUD_TEMPLATE.md` §Create/Edit Pattern |
| Add or edit anything under Settings | `06_SETTINGS_GUIDELINES.md` |
| Add or edit anything on the Dashboard | `07_DASHBOARD_GUIDELINES.md` |
| Pick a color, spacing value, radius, shadow, font, icon size | `01_DESIGN_SYSTEM.md` — never invent one |
| Choose a component (button, dialog, badge, etc.) | `03_COMPONENT_LIBRARY.md` |
| Write loading/empty/error/confirm/toast UX | `08_UX_RULES.md` |
| Decide state management, folder placement, naming | `09_CODE_STYLE.md` |
| Open a PR / finish a UI change | `10_UI_REVIEW_CHECKLIST.md` |

If a task spans several of these (it usually does), read all of the relevant docs
before writing code, not one-by-one while coding.

## 3. Always reuse — never invent

The component library in `03_COMPONENT_LIBRARY.md` and the shared helpers in
`apps/web-admin/client/src/components/{ui,shared}/` are the **only** building blocks
for admin UI. Concretely:

- **Always** build buttons with `components/ui/button.tsx` (`Button`). Never write a
  raw `<button className="...">` styled to look like one, and never create a
  `PrimaryButton`/`SecondaryButton` wrapper — this exact anti-pattern was explicitly
  rejected in `docs/superpowers/specs/2026-07-05-admin-ui-consistency-design.md`.
- **Always** build lists with `components/shared/DataTable.tsx`. Never hand-roll a
  raw `<table>` — `components/dashboard/RecentOrdersTable.tsx` does this today and is
  documented as a bug to fix, not a pattern to copy (see `05_TABLE_GUIDELINES.md`).
- **Always** build toggles with `components/ui/switch.tsx` (`Switch`). Never use a
  native `<input type="checkbox">` styled as a toggle, and never build a
  `StatusSwitch` wrapper — also explicitly rejected in the same design doc.
- **Always** build status pills with `components/shared/StatusBadge.tsx` (or the
  domain-specific `OrderStatusBadge`/`PaymentMethodBadge` where those already exist).
  Never invent a new color-coded pill for a new status field — add the status to
  `StatusBadge`'s tone map instead.
- **Always** confirm destructive or state-changing actions with
  `components/shared/ConfirmDialog.tsx` (general) or `SaveConfirmDialog.tsx`
  (Settings-style save/toggle confirmations). Never use `window.confirm()`.
- **Always** check `components/shared/*` and `components/ui/*` for an existing
  component before writing a new one. If two components in the repo do almost the
  same thing, that is a bug (report it), not a precedent to add a third.

If you need a capability that genuinely doesn't exist yet (a Drawer, a Combobox,
sortable table columns — see §4), build it once as a shared component following the
spec in `03_COMPONENT_LIBRARY.md`, not inline in the page that first needed it.

## 4. Components that are specified but not yet built

A few components the task briefs of this repo call for do not exist in the codebase
today. They are still fully specified in `03_COMPONENT_LIBRARY.md` so that when a
page eventually needs one, every agent builds the *same* thing instead of five
different one-offs:

- **Drawer / Sheet** — no `sheet.tsx` exists. Spec: Radix `Dialog` primitive with a
  slide-in-from-edge transform instead of a centered panel. See
  `03_COMPONENT_LIBRARY.md` §Drawer.
- **Combobox** — no searchable-select-with-custom-options component exists. Spec:
  Radix `Popover` + `cmdk`, mirroring the existing global `SearchModal`
  implementation. See `03_COMPONENT_LIBRARY.md` §Combobox.
- **Sortable table columns** — clicking a column header to sort has never been built
  anywhere in this app. The established, working pattern is a separate `Select`
  control plus a client-side `.sort()` (see `05_TABLE_GUIDELINES.md`). Do not add
  clickable-header sorting to one table without extending `DataTable` for all tables.
- **Column resize** — explicitly out of scope for v1. Do not add it to a single table.

Building any of these ad hoc, once, on a single page is worse than not having them —
it creates a fourth "kind of drawer" for the next agent to be confused by. If a task
genuinely needs one, build the shared component first (per spec), then consume it.

## 5. Never do

These are hard rules, not preferences:

- Never pick a hex color, spacing value (px/rem), border-radius, or shadow that
  isn't in `01_DESIGN_SYSTEM.md`'s token tables. If the token you need doesn't exist,
  that's a signal to re-read the tables more carefully, not to freehand a value.
- Never add a new `Button`/`Badge`/`Card` variant without updating
  `03_COMPONENT_LIBRARY.md` in the same change — an undocumented variant is
  design-system drift on day one.
- Never introduce a different table layout, a different hover state, or a different
  icon size scale on one page "because it looks better here." Consistency across
  hundreds of future pages outranks a local preference.
- Never build a page-specific header/breadcrumb/spacing scheme. Use `PageHeader` +
  `PageLayout` exactly as documented in `02_ADMIN_LAYOUT.md`.
- Never add dark-mode styling (`dark:` classes, a theme toggle, `next-themes`, etc.).
  The admin app is deliberately light-mode-only — see `01_DESIGN_SYSTEM.md` §Dark
  Mode for why.
- Never introduce `react-hook-form`, `zod`, or any other form/validation library
  without a repo-wide decision — the current standard is manual `useState` +
  `canSubmit`, documented in `04_CRUD_TEMPLATE.md`. Adding a schema library to one
  form and not others is worse than the current manual pattern.
- Never log or render a raw payment credential, password hash, `file_id`, or full DB
  URL — this is a repo-wide rule from the root `CLAUDE.md`, not just a UI rule.
- Never widen the Settings field whitelist casually — see `06_SETTINGS_GUIDELINES.md`
  and the root `CLAUDE.md`.
- Never duplicate a component that already exists under a new name because the
  existing one is "in the wrong place" or "needs a small tweak." Extend the existing
  one (add a prop/variant) instead.

## 6. Reference implementations — read these before writing similar code

| If you're building... | Open this file first |
|---|---|
| A full list page with search, filters, bulk actions, pagination, row actions | `apps/web-admin/client/src/pages/OrdersPage.tsx` |
| A simpler list page (no pagination/bulk actions) | `apps/web-admin/client/src/pages/StockPage.tsx` |
| A full-page create/edit form | `apps/web-admin/client/src/pages/ProductCreatePage.tsx` |
| A dialog-based create/edit form | `FlashSalesPage.tsx`'s bulk-apply dialog, or `CatalogPage.tsx`'s `CategoryEditDialog` |
| A Settings section | `apps/web-admin/client/src/pages/SettingsPage.tsx` |
| A dashboard KPI card | `apps/web-admin/client/src/components/dashboard/OrdersKpiCard.tsx` (simple) or `RevenueKpiCard.tsx` (with trend) |
| The overall page shell | `apps/web-admin/client/src/components/layout/AppShell.tsx`, `Sidebar.tsx`, `TopBar.tsx` |

`OrdersPage.tsx` and `SettingsPage.tsx` are the two richest, most fully-realized
pages in the app — when in doubt about how a pattern should look in practice, they
are the ground truth alongside the docs.

## 7. Consistency over creativity

The explicit design goal (see `01_DESIGN_SYSTEM.md`) is a Stripe/Linear/Vercel-grade
admin surface that stays coherent across hundreds of pages built by many different
people and agents over a long period of time. That goal is only achievable if every
contributor optimizes for "this looks like it belongs," not "this is the best
possible design for this one screen." Concretely:

- A boring page that matches the system is a correct outcome.
- A beautiful page that doesn't match the system is a bug, even if no single rule
  technically forbids what it did.
- When a doc doesn't cover your exact situation, extrapolate from the *closest*
  documented pattern rather than inventing a new one, and flag the gap so the docs
  can be extended.
- Optimize for the developer (human or AI) who touches this page next with zero
  context. They should be able to predict every visual and structural decision on
  the page just by having read `01`–`10` once.

## 8. Known, already-flagged inconsistencies — do not copy these

The codebase is not 100% consistent yet. These are known gaps, already identified by
prior audits (`docs/ui-refactor/` and the 2026-07 consistency passes), and must not
be treated as valid alternative patterns:

- A handful of create/reply-form flows (e.g. FlashSales, Vouchers-create,
  Broadcast-send, TicketDetail-reply) still use plain inline `text-rust` error text
  instead of `sonner` toast for their error feedback. Toast is the prescribed
  standard (`08_UX_RULES.md`); most list/detail pages have already been migrated —
  treat any remaining inline-only error text as a gap to close, not a pattern to
  copy into a new page.

`QuickActionsBar.tsx` (previously flagged here as dead code) and the raw-`<table>`
version of `RecentOrdersTable.tsx` have both been removed/migrated as of the 2026-07
consistency pass — see `07_DASHBOARD_GUIDELINES.md` §6–7.

If you touch one of the pages above for an unrelated reason, consider fixing the
inconsistency as part of that change; do not extend it further.
