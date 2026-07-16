# Phase 2 Implementation Plan

Prioritized, ordered plan for phase 2. Grouped by severity (Critical → Low).
Each item names the specific file(s) under `apps/web-admin/client/src` likely
to change. Items requiring backend/API/business-logic changes are explicitly
flagged as out-of-scope/deferred — per `CLAUDE.md` and the audit brief, this
phase is UI/UX polish only (branding, colors, typography, and the component
library are preserved).

## Critical (do first — both are broken functionality, not polish)

### 1. F-002 — Fix broken Logout (both entry points)
- **Files:** `apps/web-admin/client/src/components/layout/Sidebar.tsx`,
  `apps/web-admin/client/src/components/layout/TopBar.tsx`
- **Change:** Replace `<a href="/logout">Logout</a>` in both places with a
  button that calls `POST /logout` (backend route already exists and is
  correct — `apps/web-admin/src/routes/auth.ts` line 252), then navigates to
  `/login` on success. Consider one shared `logout()` helper in
  `apps/web-admin/client/src/api/client.ts` so both call sites share one
  implementation instead of duplicating the fetch call.
- **Backend/API change needed:** No — existing `POST /logout` route is
  correct and untouched.

### 2. F-001 — Remove duplicate "Awaiting Fulfillment" sidebar entry
- **Files:** `apps/web-admin/client/src/components/layout/Sidebar.tsx`,
  `apps/web-admin/client/src/pages/OrdersPage.tsx`
- **Change:** Delete the "Awaiting Fulfillment" `NavItemConfig` entry from
  `NAV_GROUPS` in `Sidebar.tsx`. Add a quick-filter/tab affordance inside
  `OrdersPage.tsx` for "Awaiting Fulfillment" (pre-applies
  `?status=PROCESSING`, matching existing deep links from
  `apps/web-admin/client/src/components/dashboard/PendingActionsKpiCard.tsx`
  / Operation Center tiles on the Dashboard — verify those still work
  unchanged). Pair with F-003 (status label cleanup) for a coherent single PR.
- **Backend/API change needed:** No.

## High

### 3. F-003 — Human-readable order status labels
- **Files:** `apps/web-admin/client/src/pages/OrdersPage.tsx` (consider a new
  shared `apps/web-admin/client/src/lib/orderStatus.ts` for the label map, if
  status also needs labeling elsewhere, e.g. Order Detail page)
- **Change:** Add `ORDER_STATUS_LABELS` map; use it for both the filter
  dropdown options and the table's Status column/badge text.
- **Backend/API change needed:** No — pure display mapping.

### 4. F-009 — Search button accessible name
- **Files:** `apps/web-admin/client/src/components/layout/TopBar.tsx`
- **Change:** Add `aria-label="Search"` to the search trigger `<button>`.
- **Backend/API change needed:** No. Trivial, ship alongside anything else in
  this batch.

### 5. F-012 — Settings page section navigation
- **Files:** `apps/web-admin/client/src/pages/SettingsPage.tsx`
- **Change:** Add a sticky section index / tabs (General, Telegram & Bot,
  Payment Gateways [subsections], Exchange Rates, Security) so admins can
  jump directly to a section instead of scrolling through all 9+. Preserve
  every existing field, the whitelist-only edit behavior, and the "Edit"
  button-per-field interaction pattern unchanged — this is a wrapper/layout
  change around existing content, not a content or capability change.
- **Backend/API change needed:** No.

### 6. F-016 — Context-aware Orders empty state
- **Files:** `apps/web-admin/client/src/pages/OrdersPage.tsx`
- **Change:** Branch the empty-state message on whether a filter (status /
  search / date range) is active: "No orders yet" (no data at all) vs. "No
  orders match these filters" + the existing "Clear filters" button (when a
  filter is narrowing an otherwise non-empty set).
- **Backend/API change needed:** No.

### 7. F-004 — Audit Log Admin column shows a name, not a raw ID
- **Files:** `apps/web-admin/client/src/pages/AuditPage.tsx`
- **Change:** Resolve admin username/name for display instead of the raw
  numeric ID.
- **Backend/API change needed:** **Possibly** — depends on whether the
  `/audit` API response already includes enough to resolve the admin's name
  client-side (e.g. by cross-referencing an already-fetched admins list) or
  needs a new field in the audit log API response. **Flag for phase 2 triage
  before starting**: if UI-only (client-side join against existing data), do
  in this batch; if it needs a new API field, defer to a backend-coordinated
  follow-up and note it as out-of-scope for this UI-only phase.

## Medium

### 8. F-005 — Audit Log Action column: human-readable or removed
- **Files:** `apps/web-admin/client/src/pages/AuditPage.tsx`
- **Change:** Add a label map for known action codes, or drop the raw-code
  column since the adjacent Details column already has a readable sentence.
- **Backend/API change needed:** No.

### 9. F-006 — Standardize "create new record" pattern (Vouchers, Admins)
- **Files:** `apps/web-admin/client/src/pages/VouchersPage.tsx`,
  `apps/web-admin/client/src/pages/AdminsPage.tsx`
- **Change:** Bring Admins' inline-add row up to the same `Label`-wrapped
  field treatment Product/Denomination/Voucher (post F-014) use. Confirm
  Vouchers' inline-expand pattern as the standard for "simple record" creation
  going forward (no page navigation needed) vs. dedicated pages for
  multi-field records — this is a documentation/convention decision as much
  as a code change; capture the decision in `design-system.md` once made.
- **Backend/API change needed:** No — same create endpoints, presentation only.

### 10. F-007 — Fix Denomination breadcrumb product-name bug
- **Files:** `apps/web-admin/client/src/pages/DenominationCreatePage.tsx`
  (verify `DenominationEditPage.tsx` for the same bug — same nested route
  shape)
- **Change:** Interpolate the loaded product's `name` into the breadcrumb
  instead of the hardcoded "Product" string; handle the loading state
  gracefully (skeleton or product ID fallback, not a generic label).
- **Backend/API change needed:** No.

### 11. F-010 — Semantic headings on Dashboard
- **Files:** `apps/web-admin/client/src/components/dashboard/InventoryMonitoringCard.tsx`,
  `ExpirationsTable.tsx`, `SalesAnalyticsCard.tsx`, `RecentOrdersTable.tsx`,
  `BusinessHealthGrid.tsx`, `TopProductsList.tsx`
- **Change:** Change section-title elements from `div`/`span` to `<h2>`/`<h3>`
  as appropriate, keeping existing CSS classes/visual styling unchanged.
- **Backend/API change needed:** No.

### 12. F-011 — Fix low-contrast muted text token
- **Files:** Likely a shared Tailwind/theme token (search
  `apps/web-admin/client/src` for the utility class producing
  `rgb(151, 161, 177)` — probably something like a `text-ink-faint` token
  referenced from `apps/web-admin/client/src/components/layout/TopBar.tsx`
  and reused elsewhere)
- **Change:** Darken the token enough to reach ≥4.5:1 contrast against its
  typical background; requires a full-page/full-app sweep for every use of
  the same token before shipping, not just the TopBar instance, since this is
  a shared design token, not a one-off style.
- **Backend/API change needed:** No. **Recommend running an automated
  contrast audit (e.g. axe-core) across all pages before this fix** to catch
  other instances beyond the one measured in this audit.

### 13. F-013 — Settings gateway toggle/status display fix
- **Files:** `apps/web-admin/client/src/pages/SettingsPage.tsx`
- **Change:** Derive one combined status label from
  `enabled && hasRequiredFields` instead of showing the raw toggle state
  next to a separate, seemingly-contradictory "not configured" text.
- **Backend/API change needed:** No — display logic only. Confirm with the
  product owner whether "Enabled" defaulting `true` pre-setup is intentional
  business logic (do not change the default value itself, only its
  presentation) — flag if any behavior change beyond display is proposed.

### 14. F-014 — Add labels to Voucher inline-create form
- **Files:** `apps/web-admin/client/src/pages/VouchersPage.tsx`
- **Change:** Apply the same `Label` + `Input`/`Select` composition already
  used in `ProductCreatePage.tsx` / `DenominationCreatePage.tsx` to every
  field (Code, Type, Currency, Value, Min purchase, Usage limit, Expires).
- **Backend/API change needed:** No.

## Low

### 15. F-008 — Remove redundant "← Back" button
- **Files:** `apps/web-admin/client/src/components/shared/PageHeader.tsx`
  and/or `PageLayout.tsx` (verify which one owns this pattern — likely shared,
  fix once)
- **Change:** Drop the "← Back" button where a breadcrumb already provides
  the same "go back" affordance, or merge into a single control.
- **Backend/API change needed:** No.

### 16. F-015 — Rename "Pwd" column header
- **Files:** `apps/web-admin/client/src/pages/AdminsPage.tsx`
- **Change:** Rename "Pwd" to "Password Set" (or similar) in the Admins table
  header.
- **Backend/API change needed:** No. Trivial — bundle with any other Admins
  page change (e.g. item 9 above) rather than a standalone PR.

### 17. F-017 — Search returns no results for an existing product
- **Files:** N/A for UI phase — investigation needed in the backend search
  implementation (likely `apps/web-admin/src/routes/*` or a `packages/db`
  search query) before any frontend change is relevant.
- **Backend/API change needed:** **Yes — out of scope for this UI-only
  phase.** Recorded here for visibility; recommend a separate backend
  investigation ticket. If backend search remains unreliable for a while, a
  UI-only stopgap (e.g. client-side substring match fallback against
  already-loaded lists) could be considered as a separate, explicitly-scoped
  follow-up — not bundled into this phase's work.

### 18. F-018 — Verify (don't yet fix) chart x-axis label skip
- **Files:** `apps/web-admin/client/src/components/dashboard/SalesAnalyticsCard.tsx`
- **Change:** First verify whether the observed label-thinning at 375px is
  intentional charting-library behavior (many chart libraries auto-thin
  labels to avoid overlap) before changing anything. If confirmed
  unintentional/inconsistent, adjust the tick configuration for even spacing.
- **Backend/API change needed:** No. Lowest priority — verify before
  investing implementation time.

## Out-of-scope summary (backend/business-logic — not phase 2 UI work)

- **F-004** (Audit Log admin name) — *possibly* needs an API field addition;
  triage first, may turn out to be UI-only.
- **F-013** — default-`true` "Enabled" business logic itself (not its
  display) is out of scope to change without product-owner sign-off.
- **F-017** — search backend matching/indexing logic is out of scope for this
  UI-only phase; recommend a separate backend ticket.

## Suggested phase 2 sequencing

1. Critical items (1-2) as one small PR — highest trust/functionality impact,
   lowest implementation risk.
2. High items (3-7, except F-004 pending triage) as a second PR.
3. Medium items (8-14) as a third PR, or split by page (Audit Log: 8;
   Catalog/Denomination: 10; Dashboard: 11; Settings: 13; Vouchers/Admins: 9,
   14) if preferred for smaller reviewable diffs.
4. Low items (15-16, 18) opportunistically alongside whichever PR above
   already touches the same file.
5. F-017 spun out as a separate backend investigation, not blocking the UI
   work above.
