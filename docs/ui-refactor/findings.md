# Findings — Web Admin UI/UX Audit

18 findings total — **2 Critical, 5 High, 7 Medium, 4 Low**. See `report.json` for the
machine-readable version and `overview.md` for audit scope/methodology.

---

## F-001 — Duplicate nav item: "Orders" and "Awaiting Fulfillment" are the same page

- **Severity:** Critical
- **Page:** All pages (sidebar), most visible on Orders
- **Screenshot:** `screenshots/orders-list-desktop-empty.png`
- **Current behavior:** The sidebar's "Sales" group has two separate entries — "Orders"
  (`/orders`) and "Awaiting Fulfillment" (`/orders?status=PROCESSING`) — that both route to
  the same `OrdersPage` component, the second just pre-applying a status filter. This is the
  exact anti-pattern called out in the audit brief's Navigation Guidelines example. Confirmed
  in `apps/web-admin/client/src/components/layout/Sidebar.tsx` lines 54-60. The Orders page
  already has a full `Status` filter dropdown covering all 13 order statuses (see F-003),
  making the second nav item pure duplication.
- **Expected behavior:** One "Orders" entry; "Awaiting Fulfillment" becomes a status
  filter/tab reachable from inside Orders, not a separate top-level nav item.
- **Recommendation:** Remove the "Awaiting Fulfillment" `NavItemConfig` entry from
  `NAV_GROUPS` in `Sidebar.tsx`. Surface "Awaiting Fulfillment" as a quick-filter chip/tab
  inside `OrdersPage.tsx` instead (it can still deep-link via `?status=PROCESSING`, and the
  dashboard's Operation Center tiles that link to `/orders?status=PROCESSING` keep working
  unchanged).
- **Implementation notes:** UI-only change. No backend/API change needed — the `?status=`
  query param handling already exists in `OrdersPage.tsx`. Keep the Stock-style badge count
  (`fulfillmentBadge`) but move it onto the in-page filter/tab rather than the sidebar item
  once removed, or keep a lightweight badge on the "Orders" sidebar item itself.

---

## F-002 — Logout is broken at both entry points (404, session stays active)

- **Severity:** Critical
- **Page:** Global (Sidebar footer link, TopBar user-avatar dropdown)
- **Screenshot:** `screenshots/logout-broken-page-not-found-desktop.png`,
  `screenshots/user-avatar-dropdown-desktop.png`
- **Current behavior:** Both logout controls are plain anchor tags — `Sidebar.tsx` line ~190
  (`<a href="/logout">Logout</a>`) and `TopBar.tsx` line ~112-117 (identical pattern inside
  the user-avatar dropdown). Clicking either does a normal browser `GET /logout` navigation.
  The backend logout route is POST-only (`apps/web-admin/src/routes/auth.ts` line 252,
  `app.post("/logout", ...)`), so the GET request falls through to the SPA's catch-all and
  renders "Page not found" — while the session cookie is never cleared. Confirmed directly:
  after clicking Logout, navigating to `/orders` still loads the authenticated dashboard with
  no redirect to `/login`.
- **Expected behavior:** Clicking Logout ends the session and returns the admin to `/login`.
- **Recommendation:** Change both logout controls from `<a href="/logout">` to a button that
  issues a `POST /logout` (e.g. `fetch('/logout', { method: 'POST' })` via the same
  `client.ts`/`publicPost`-style helper already used elsewhere, such as `BootstrapPage.tsx`'s
  `publicPost`), then `window.location.href = '/login'` on success.
- **Implementation notes:** UI-only fix — the backend route already exists and is correct;
  only the frontend call needs to change. Files:
  `apps/web-admin/client/src/components/layout/Sidebar.tsx`,
  `apps/web-admin/client/src/components/layout/TopBar.tsx`. Consider a small shared
  `logout()` helper (e.g. in `apps/web-admin/client/src/api/client.ts`) so both call sites use
  one implementation.

---

## F-003 — Orders status filter shows raw backend enum values

- **Severity:** High
- **Page:** Orders (`/orders`)
- **Screenshot:** `screenshots/orders-list-desktop-empty.png` (page context; the open-dropdown
  state with raw values was confirmed via accessibility snapshot rather than a saved PNG —
  options observed: `PENDING_PAYMENT`, `PAYMENT_DETECTED`, `CONFIRMING`, `CONFIRMED`,
  `PENDING_VERIFICATION`, `PAID`, `PROCESSING`, `DELIVERED`, `CANCELLED`, `REJECTED`,
  `REFUNDED`, `UNDERPAID`, `FAILED`)
- **Current behavior:** The Status filter combobox on Orders lists all 13 order statuses
  verbatim as their backend enum identifiers (SCREAMING_SNAKE_CASE), e.g.
  "PAYMENT_DETECTED", "PENDING_VERIFICATION".
- **Expected behavior:** Human-readable labels, e.g. "Payment Detected", "Pending
  Verification", ideally grouped/ordered by the customer journey.
- **Recommendation:** Add a label map (`ORDER_STATUS_LABELS: Record<string, string>`) in
  `OrdersPage.tsx` (or a shared `lib/orderStatus.ts`) and render labels instead of raw enum
  values in both the filter dropdown and the table's Status column/badges. Given 13 statuses,
  also consider collapsing rarely-used ones into a secondary "More filters" or reordering the
  list so common ones (Paid, Processing, Delivered) are near the top.
- **Implementation notes:** UI-only. File: `apps/web-admin/client/src/pages/OrdersPage.tsx`.
  No backend change — this is purely a display-label mapping.

---

## F-004 — Audit Log "Admin" column shows raw numeric user ID

- **Severity:** High
- **Page:** Audit Log (`/audit`)
- **Screenshot:** `screenshots/audit-log-desktop.png`
- **Current behavior:** Every row's "Admin" column renders the raw internal user id (e.g.
  `1`) instead of the admin's name/username. An audit log meant to be read by shop admins (per
  `CLAUDE.md`'s logging convention) is much harder to scan when admins are identified only by
  opaque numeric IDs.
- **Expected behavior:** Show the admin's username/name (e.g. "ui_audit_admin"), with the
  numeric ID available as a tooltip or secondary detail if needed.
- **Recommendation:** Join admin username/name into the audit log API response (or resolve
  client-side from an already-fetched admins list) and render that instead of the bare ID in
  `AuditPage.tsx`.
- **Implementation notes:** May need a small backend change (include admin name in the audit
  log query/response) — flag as borderline in-scope: if the API already returns enough to
  resolve it client-side, this is UI-only; otherwise it needs an API response field addition.
  Flagging for phase 2 triage. File: `apps/web-admin/client/src/pages/AuditPage.tsx`.

---

## F-009 — Search button has no accessible name on small viewports

- **Severity:** High
- **Page:** Global TopBar, mobile/small viewport
- **Screenshot:** `screenshots/dashboard-mobile-nav-closed.png`
- **Current behavior:** `TopBar.tsx` renders the search trigger as a `<button>` with a
  `Search` icon, a `<span className="hidden sm:inline">Search...</span>` label, and a
  `<kbd className="hidden ... sm:inline-block">Ctrl+K</kbd>` hint — but the `<button>` itself
  has no `aria-label`. Below the `sm` breakpoint both the label and the kbd hint are hidden
  via Tailwind, leaving a screen-reader user with an unnamed icon-only button. Confirmed via
  accessibility snapshot at 375px width: the element renders as `button` with no accessible
  name (contrast with the `Quick actions` and `Open navigation` buttons right next to it,
  which do have `aria-label`s). Source:
  `apps/web-admin/client/src/components/layout/TopBar.tsx` lines 41-51.
- **Expected behavior:** The search button always has a discoverable accessible name,
  regardless of viewport.
- **Recommendation:** Add `aria-label="Search"` to the button element itself (it can coexist
  with the visually-hidden-until-`sm` text span).
- **Implementation notes:** One-line UI fix. File:
  `apps/web-admin/client/src/components/layout/TopBar.tsx`.

---

## F-012 — Settings page is a single unnavigable scroll across 9+ sections

- **Severity:** High
- **Page:** Settings (`/settings`)
- **Screenshot:** `screenshots/settings-desktop.png`, `screenshots/settings-mobile.png`
- **Current behavior:** Settings renders 9+ sections top to bottom in a single column with no
  in-page navigation: General, Telegram & Bot, TokoPay, PayDisini, NOWPayments, Bybit, Bybit
  BSC, Binance Internal Transfer, Exchange Rates, Security. Each field is its own row with a
  label, current value (or "not set"), and an "Edit" button. To reach Security (change
  password / enable 2FA) an admin must scroll past 8 other sections. There are no anchor
  links, tabs, or a sticky section index.
- **Expected behavior:** Sectioned navigation (tabs, a sticky in-page sidebar, or at minimum
  anchor links/a "jump to" control) so admins can reach Security or a specific payment gateway
  without scrolling through everything else.
- **Recommendation:** Add a left-hand or top sticky section nav (mirrors the existing
  sidebar's own grouped-nav pattern) that scrolls to/highlights the active section; or split
  into tabs (General / Payments / Security) matching the "reduce duplicate pages, use tabs"
  principle from the audit brief, applied here to reduce scroll depth instead. Preserve the
  current whitelist-only edit behavior (`CLAUDE.md` — do not widen it), this is purely a
  navigation/layout change around the same fields.
- **Implementation notes:** UI-only, structural. File:
  `apps/web-admin/client/src/pages/SettingsPage.tsx`. No new fields, no whitelist change —
  same "Edit" affordances, just organized behind navigable sections.

---

## F-016 — Orders empty state says "try adjusting your filters" even with no filter active

- **Severity:** High
- **Page:** Orders (`/orders`)
- **Screenshot:** `screenshots/orders-list-desktop-empty.png`
- **Current behavior:** With no filter applied (fresh DB, zero orders), the empty state reads
  "No orders found / Try adjusting your filters." — generic, and specifically wrong/confusing
  when there is no filter active at all (there is nothing to adjust). This is the exact
  anti-pattern flagged in the audit brief's Empty States example, in contrast with Catalog's
  empty state ("No products yet / Add your first product to start selling.") and Vouchers'
  ("No vouchers found / Create your first voucher to offer discounts."), both of which are
  contextual and actionable.
- **Expected behavior:** Context-aware messaging: "No orders yet" (no data at all, no CTA
  needed since orders come from customers) vs. "No orders match these filters" + a "Clear
  filters" action (already present as a button, just needs the right message) when a filter is
  actually narrowing an otherwise-populated set.
- **Recommendation:** Branch the empty-state copy in `OrdersPage.tsx` on whether any filter
  (`status`, search, date range) is currently active.
- **Implementation notes:** UI-only. File: `apps/web-admin/client/src/pages/OrdersPage.tsx`.

---

## F-005 — Audit Log "Action" column duplicates the readable Details sentence

- **Severity:** Medium
- **Page:** Audit Log (`/audit`)
- **Screenshot:** `screenshots/audit-log-desktop.png`
- **Current behavior:** The Action column renders backend action codes verbatim:
  `denomination_create`, `catalog_product_create`, `category_create`,
  `web_setup_completed`. The adjacent "Details" column already has a well-written
  natural-language sentence per `CLAUDE.md`'s logging convention (e.g. `Created product
  "Netflix Premium".`), making the raw Action code redundant noise next to it.
- **Expected behavior:** A human-readable action label (e.g. "Product created"), or simply
  de-emphasize/remove the raw code column since Details already carries the readable sentence.
- **Recommendation:** Add a label map for known action codes in `AuditPage.tsx`, or drop the
  column in favor of a small icon/badge derived from the action category (product / order /
  admin / setting) plus the existing Details sentence.
- **Implementation notes:** UI-only. File: `apps/web-admin/client/src/pages/AuditPage.tsx`.

---

## F-006 — Three different "create new record" UI patterns across similar pages

- **Severity:** Medium
- **Page:** Catalog vs. Vouchers vs. Admins
- **Screenshot:** `screenshots/product-create-desktop.png` (dedicated full page),
  `screenshots/voucher-create-inline-form-desktop.png` (inline expand-in-place section),
  `screenshots/admins-list-desktop.png` (inline row form directly in the table)
- **Current behavior:** "Add a new X" is implemented three different ways across otherwise-
  similar list pages: Products/Denominations navigate to a dedicated full page (`/catalog/new`,
  `ProductCreatePage.tsx`, `DenominationCreatePage.tsx`); Vouchers expands an inline form
  section in place of the "+ New Voucher" button, above the table (`VouchersPage.tsx`); Admins
  uses a single-row inline form built directly into the table header (`AdminsPage.tsx`, just a
  Telegram ID textbox + "+ Add Admin" button, no labels on additional fields).
- **Expected behavior:** One consistent creation pattern for records of similar complexity (or
  at minimum, two clear tiers — e.g. "simple record → inline form" vs. "complex record with
  many fields → dedicated page" — applied consistently, not per-page ad hoc).
- **Recommendation:** Standardize: keep the dedicated-page pattern for multi-field records
  (Product, Denomination), and use the inline expand-in-place pattern (Vouchers' current
  approach) for simpler ones (Voucher, Admin) rather than Admins' single-field table-row
  variant, which also lacks the label/helper-text treatment the other create forms have (see
  F-014).
- **Implementation notes:** UI-only. Files:
  `apps/web-admin/client/src/pages/VouchersPage.tsx`,
  `apps/web-admin/client/src/pages/AdminsPage.tsx`. No backend change — same create endpoints,
  different presentation only.

---

## F-007 — Denomination-create breadcrumb shows literal word "Product" instead of product name

- **Severity:** Medium
- **Page:** New Denomination (`/catalog/:productId/denominations/new`)
- **Screenshot:** `screenshots/denomination-create-desktop.png`
- **Current behavior:** The breadcrumb reads "Catalog / Product" — the literal word "Product"
  is rendered as the link text instead of the actual product name ("Netflix Premium" in this
  test). Confirmed via accessibility snapshot: `link "Product" [cursor=pointer]: /url:
  /catalog/1`.
- **Expected behavior:** Breadcrumb shows the real product name, e.g. "Catalog / Netflix
  Premium / New Denomination".
- **Recommendation:** Pass the loaded product's `name` into the breadcrumb component instead
  of a hardcoded "Product" string; handle the loading state (e.g. show a skeleton or the
  product ID) rather than a generic label.
- **Implementation notes:** UI-only. File:
  `apps/web-admin/client/src/pages/DenominationCreatePage.tsx` (likely also affects
  `DenominationEditPage.tsx` — verify in phase 2).

---

## F-010 — Dashboard section titles are not semantic heading elements

- **Severity:** Medium
- **Page:** Dashboard (`/`)
- **Screenshot:** `screenshots/dashboard-desktop-empty.png`
- **Current behavior:** Confirmed via `document.querySelectorAll('h1,h2,h3,h4,h5,h6')` on the
  Dashboard: only two heading elements exist on the entire page — `H1: Dashboard` and `H2:
  Operation Center`. Visually-heading-styled section titles ("Critical Stock", "Upcoming
  Expirations", "Sales Analytics", "Recent Orders", "Business Health", "Top Products · Last 30
  Days") are plain `div`/`span` elements, not `<h2>`/`<h3>` tags.
- **Expected behavior:** Each dashboard card/section title is a real heading (`<h2>` or `<h3>`
  as appropriate) so screen-reader users can navigate the page by heading structure, matching
  what's visually implied.
- **Recommendation:** Change these section-title elements to semantic heading tags in the
  relevant dashboard card components (keep existing visual styling via the same CSS classes,
  just change the tag).
- **Implementation notes:** UI-only. Files under
  `apps/web-admin/client/src/components/dashboard/`: `InventoryMonitoringCard.tsx`,
  `ExpirationsTable.tsx`, `SalesAnalyticsCard.tsx`, `RecentOrdersTable.tsx`,
  `BusinessHealthGrid.tsx`, `TopProductsList.tsx`.

---

## F-011 — Muted "Search..." text fails WCAG AA contrast

- **Severity:** Medium
- **Page:** Global (TopBar), likely recurring wherever the same muted text utility class is
  reused
- **Screenshot:** `screenshots/dashboard-desktop-empty.png` (topbar "Search..." text)
- **Current behavior:** Measured via `getComputedStyle` on the live page: the "Search..."
  label renders as `rgb(151, 161, 177)` on a transparent/light background. Computed WCAG
  contrast ratio against a white/near-white background is approximately 2.6:1 — well below
  the 4.5:1 minimum for normal text (or 3:1 for large text/UI) under WCAG AA.
- **Expected behavior:** Muted/secondary text meets at least 4.5:1 contrast against its
  background (or the text is large/bold enough to qualify for the 3:1 large-text threshold).
- **Recommendation:** Darken the muted text color token used here (and audit other uses of the
  same `text-ink-faint`-style utility for the same issue) with an actual contrast-checker pass
  in phase 2 — this finding identifies the pattern and one concrete instance; a full sweep is
  needed before implementing.
- **Implementation notes:** Likely a Tailwind/theme token change (shared color variable), not a
  one-off. Needs a broader grep for the same utility class across
  `apps/web-admin/client/src` before fixing, to avoid a partial fix. Preserve existing brand
  colors per constraints — adjust only the specific token's lightness enough to pass contrast,
  not the whole palette.

---

## F-013 — Payment gateway sections show contradictory "Enabled" + "not configured" state

- **Severity:** Medium
- **Page:** Settings (`/settings`)
- **Screenshot:** `screenshots/settings-desktop.png`
- **Current behavior:** Every payment gateway section (TokoPay, PayDisini, NOWPayments,
  Bybit, Bybit BSC, Binance Internal Transfer) shows a "not configured" label right next to a
  switch labeled "Enabled" that is already toggled on by default, with all the gateway's
  credential fields showing "not set". This reads as contradictory: the gateway is "Enabled"
  but simultaneously "not configured", which is confusing about whether it's actually active.
- **Expected behavior:** Visual state should make it obvious that "Enabled + not configured"
  effectively means "inactive" — e.g. dim/disable the toggle until required fields are set, or
  show a clearer combined status like "Not set up" instead of two conflicting labels.
- **Recommendation:** Purely a presentation change: derive a single combined status
  label/badge from `enabled && hasRequiredFields` instead of showing the raw toggle state and
  the "not configured" text as two separate, seemingly contradictory signals.
- **Implementation notes:** UI-only. File: `apps/web-admin/client/src/pages/SettingsPage.tsx`.
  Confirm with product owner whether "Enabled" defaulting to true pre-setup is intentional
  business logic (out of scope to change) — this finding is about the display of that state,
  not the default value itself.

---

## F-014 — Voucher inline-create form relies on placeholder-only / missing labels

- **Severity:** Medium
- **Page:** Vouchers (`/vouchers`, inline "New Voucher" form)
- **Screenshot:** `screenshots/voucher-create-inline-form-desktop.png`
- **Current behavior:** The inline voucher-creation form (Code, Type, Currency, Value, Min
  purchase, Usage limit, Expires) relies on placeholder-only text (or, for one combobox,
  nothing at all — confirmed via accessibility snapshot showing an unlabeled `combobox`). This
  is inconsistent with the Product and Denomination create forms, which use a clear "Label *"
  + helper-text pattern for every field.
- **Expected behavior:** Every field has a persistent visible label (not just a placeholder
  that disappears on input), consistent with the rest of the app's forms.
- **Recommendation:** Apply the same `Label` + `Input`/`Select` composition already used in
  `ProductCreatePage.tsx`/`DenominationCreatePage.tsx` to the voucher inline form.
- **Implementation notes:** UI-only. File: `apps/web-admin/client/src/pages/VouchersPage.tsx`.

---

## F-008 — Redundant "Back" button duplicates the breadcrumb's job

- **Severity:** Low
- **Page:** Product Create, Denomination Create, Product Detail (and likely other
  detail/create pages)
- **Screenshot:** `screenshots/product-create-desktop.png`,
  `screenshots/denomination-create-desktop.png`
- **Current behavior:** These pages show both a breadcrumb link (e.g. "Catalog") in the
  top-left and a separate "← Back" button in the top-right, which do the same job (return to
  the previous list page).
- **Expected behavior:** One clear way back — either rely on the breadcrumb, or the Back
  button, not both competing for the same action.
- **Recommendation:** Keep the breadcrumb (it also communicates hierarchy, not just "back")
  and drop the redundant "← Back" button, or merge them into a single top-left back
  affordance.
- **Implementation notes:** UI-only, low risk. Likely a shared page-header component — check
  `apps/web-admin/client/src/components/shared/PageHeader.tsx` and/or `PageLayout.tsx` for
  where this pattern is defined once and reused.

---

## F-015 — Admins table column header abbreviated to "Pwd"

- **Severity:** Low
- **Page:** Admins (`/admins`)
- **Screenshot:** `screenshots/admins-list-desktop.png`
- **Current behavior:** The Admins table has a column header literally labeled "Pwd" (showing
  a checkmark/dash for whether a password is set).
- **Expected behavior:** A clearer label, e.g. "Password Set" or a tooltip-bearing icon.
- **Recommendation:** Rename the header text (and/or add a title attribute / tooltip) in
  `AdminsPage.tsx`.
- **Implementation notes:** UI-only, trivial. File:
  `apps/web-admin/client/src/pages/AdminsPage.tsx`.

---

## F-017 — Global search doesn't find an existing product by name (likely backend)

- **Severity:** Low (flagged, likely backend — see notes)
- **Page:** Global search modal (`Ctrl+K`)
- **Screenshot:** `screenshots/search-modal-results-desktop.png`
- **Current behavior:** Searching "Netflix" in the `Ctrl+K` search modal (with a product named
  "Netflix Premium" existing in the DB) returned "No results for 'Netflix'". Confirmed the
  request actually reached the backend and returned 200 OK with an empty result set (`GET
  /api/search?q=Netflix` → `200`), so this isn't a frontend rendering bug — the search
  endpoint itself isn't matching an existing product by name substring.
- **Expected behavior:** The product appears in search results.
- **Recommendation:** Investigate the `/api/search` backend implementation
  (indexing/matching logic). This is flagged as likely backend/business-logic work, out of
  scope for this UI-only phase — recorded here because it was directly observed during the
  crawl and materially affects the perceived reliability of the search feature, but the fix
  (if confirmed backend-side) should be scheduled separately from the UI polish work in phase
  2.
- **Implementation notes:** Needs backend investigation first to confirm root cause before any
  UI change is even relevant.

---

## F-018 — Sales chart may drop a date label on narrow viewports (needs verification)

- **Severity:** Low (needs verification)
- **Page:** Dashboard (`/`), mobile viewport
- **Screenshot:** `screenshots/dashboard-mobile.png`
- **Current behavior:** On the 7-day Sales Analytics chart at 375px width, the x-axis date
  labels observed were `2026-07-08, 07-09, 07-10, 07-11, 07-12, 07-14` — `07-13` does not
  appear in the accessibility tree at that viewport, while all 7 dates render at desktop
  width. This may be intentional responsive label-thinning (common in chart libraries to
  avoid crowding) or a genuine off-by-one — the pattern of which date drops looked
  inconsistent with even a simple "skip every other" thinning rule.
- **Expected behavior:** Either a clearly intentional, evenly-spaced label thinning strategy
  on narrow viewports, or all 7 labels retained with smaller text/rotation.
- **Recommendation:** Re-verify directly in the chart library's own responsive tick logic in
  phase 2 before changing anything — may already be library-default behavior, not a bug worth
  altering.
- **Implementation notes:** File:
  `apps/web-admin/client/src/components/dashboard/SalesAnalyticsCard.tsx`. Low priority —
  verify before investing implementation time.
