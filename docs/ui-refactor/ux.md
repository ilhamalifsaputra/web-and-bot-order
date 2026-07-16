# UX Recommendations

Cross-cutting recommendations synthesized from the findings gathered during
the crawl (see `findings.md` for the itemized list with screenshots — note:
due to a tooling restriction encountered mid-audit, `findings.md` content is
included in this agent's final response text for the coordinator to persist;
this file assumes that content exists at `docs/ui-refactor/findings.md`).

## 1. Fix the two broken core actions first

Before any polish, two things are outright broken and should be treated as
blocking: **Logout doesn't log out** (F-002) and the **sidebar has a
duplicate page** for Orders (F-001). Both are cheap, UI-only fixes with
outsized trust impact — an admin who thinks they've logged out (e.g. on a
shared machine) but hasn't is a real risk, not just a cosmetic bug.

## 2. Replace raw backend identifiers with human labels, everywhere

A recurring pattern across the app: raw backend strings leak into the UI
verbatim instead of being translated to a label a shop admin would recognize:
- Order status enum values in the Orders filter (F-003):
  `PENDING_VERIFICATION` instead of "Pending Verification".
- Audit Log's Admin column shows a raw numeric ID (F-004) and its Action
  column shows raw action codes like `catalog_product_create` (F-005).

**Recommendation:** establish one small shared labeling convention/utility
(e.g. `apps/web-admin/client/src/lib/labels.ts`) with a
`humanize(SNAKE_CASE_OR_ENUM)` fallback plus explicit override maps per
domain (order status, audit action), so future enum values added on the
backend degrade gracefully to a readable label instead of a raw code, rather
than needing a new hardcoded map entry every time.

## 3. Make empty states context-aware, not just "present"

Most list pages already have a *reasonable* empty state (Catalog, Vouchers,
Stock, Admins, Broadcast all show a specific, on-brand "nothing here yet"
message). Orders is the outlier (F-016): its empty-state copy talks about
"adjusting your filters" even when nothing is filtered. Apply the same
context-aware pattern Catalog/Vouchers already use — check whether a filter
is active before choosing which message to show.

## 4. Pick one "add a new record" pattern and use it consistently

Three different patterns currently exist for conceptually the same action
(F-006): a dedicated full page (Products/Denominations), an inline
expand-in-place section above the table (Vouchers), and a bare single-field
inline table row (Admins). None of these are wrong in isolation, but having
three for one action type adds cognitive load — an admin has to relearn "how
do I add one of these" per page. Recommend keeping two tiers: dedicated page
for multi-field/complex records, inline expand-in-place (Vouchers' current
pattern) for simple ones — and bring Admins' inline row up to the same
labeled-field standard as the rest (it currently has no visible labels beyond
"Telegram ID").

## 5. Settings needs wayfinding, not more content

Settings (F-012) is comprehensive and each individual field/row is
well-presented (clear current-value display, "not set" placeholder styling,
consistent "Edit" affordance) — the problem is purely structural: 9+ sections
in one scroll with no way to jump to one. This is the single highest-leverage
layout fix in the audit: Security (password/2FA — arguably the
highest-stakes section) is the very last thing on the page today.

## 6. Small-viewport icon-only controls need names, not just icons

F-009 (search button) is one instance of a broader pattern worth checking in
phase 2: any control that hides its text label below a breakpoint needs an
`aria-label` on the interactive element itself, not just visually-hidden text
that also happens to disappear from the accessibility tree. Worth a quick
sweep of `TopBar.tsx` and `Sidebar.tsx` for other `hidden ... sm:inline` /
`lg:hidden` text-label patterns while this is being fixed.

## 7. Breadcrumb correctness and redundancy

F-007 (breadcrumb shows the literal word "Product" instead of the loaded
product's name) and F-008 (breadcrumb + separate "← Back" button doing the
same job) both point at the same underlying page-header/breadcrumb component
being worth a single pass in phase 2 — likely one shared component
(`PageHeader.tsx`/`PageLayout.tsx` — verify) used across Catalog, Stock, and
Customers detail/create pages, so fixing it once should propagate.

## 8. Search reliability

F-017 (search modal returns no results for an existing, correctly-named
product) undermines trust in a headline power-user feature (`Ctrl+K`). This
is flagged as likely backend, but from a pure UX standpoint: if backend
search stays imperfect for a while, consider surfacing a lower-confidence "did
you mean" or falling back to a simple substring match client-side against
already-loaded data as a stopgap — a call for phase 2 planning, not a
mandate.

## What's already working well (preserve these)

- The create/edit forms that *do* have the full treatment (Product,
  Denomination) are genuinely good: clear required-field asterisks, helper
  text under fields explaining consequences ("For margin reports only —
  buyers never see this."), disabled submit until valid, inline
  category-creation without leaving the form.
- The Setup Wizard (`/setup` → `/setup/owner` → `/setup/shop` → `/setup/done`)
  is a clean, low-friction first-run flow with sensible "Skip for now"
  escape hatches at each optional step.
- Dashboard's Operation Center tiles linking straight into a pre-filtered
  Orders/Payments view (e.g. "Pending Payments" → `/orders?status=PENDING_PAYMENT`)
  is a good pattern — worth explicitly keeping (and extending to the
  post-F-001 in-page Orders filter/tabs) rather than accidentally losing it
  while fixing F-001.
- Character counters (Broadcast's "0 / 4000"), disabled-until-valid submit
  buttons, and the "+" prefix convention on primary creation buttons are
  consistent and good across the app.
