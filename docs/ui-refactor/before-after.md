# Before / After

This file is structure-only for phase 1, per the audit brief — it gets filled
in during phase 2 implementation, one entry per finding actually implemented
(not necessarily every finding in `findings.md`; phase 2 may defer Low-severity
or out-of-scope items).

Each entry implemented in phase 2 should follow this template:

## [Finding ID] — [short title]

**Before**
- Screenshot: `screenshots/<before-file>.png` (reuse the phase-1 screenshot
  where possible, or a fresh one if the flow changed before phase 2 started)
- Description of the prior behavior/layout in 1-3 sentences.

**After**
- Screenshot: `screenshots/<after-file>.png` (new, captured during/after
  phase 2 implementation)
- Description of the new behavior/layout in 1-3 sentences.

**Reason**
- Why this changed — link back to the finding ID and its severity, and the
  specific user-facing problem it solved (not just "per audit").

**Impact**
- Concrete, observable effect: fewer clicks, clearer status, resolved
  accessibility gap, removed duplicate page, etc. Quantify where possible
  (e.g. "sidebar item count: 16 → 15", "Settings section reachable in 1 click
  instead of ~6 scroll-throughs").

---

## Audit closing summary

Phase 1 identified **18 findings** (2 Critical, 5 High, 7 Medium, 4 Low).
Phase 2 implemented **17 of 18**:

- **2 Critical** — F-001 (duplicate sidebar nav), F-002 (broken logout).
- **5 High** — F-003 (raw order-status enums), F-004 (audit log admin id →
  name; triaged during implementation and confirmed resolvable client-side
  with zero backend change, so it shipped as UI-only rather than being
  deferred), F-009 (search button accessible name), F-012 (Settings section
  navigation), F-016 (context-aware Orders empty state).
- **7 Medium** — F-005 (humanized audit Action codes), F-006 (standardized
  Admins/Vouchers inline-create labeling), F-007 (denomination breadcrumb
  product-name bug), F-010 (semantic dashboard headings), F-011 (muted-text
  contrast fix), F-013 (Settings gateway status), F-014 (Voucher form
  labels).
- **3 Low** — F-008 (redundant "← Back" button), F-015 ("Pwd" column
  header), F-018 (chart x-axis label skip — **verified as intentional
  Recharts library behavior, not a bug**; no code change made, see the
  F-018 entry below for the full reasoning).

**1 of 18 deferred**: **F-017** (global search returns no results for an
existing product) is confirmed backend/business-logic — the search request
reaches the API and returns `200 OK` with an empty result set, so the gap is
in the backend matching/indexing logic, not the UI. Out of scope for this
UI-only phase; recommend a separate backend investigation ticket.

**Future recommendations** (noticed during the audit, explicitly out of
scope for this UI-only pass):

- **F-017's backend search gap** (above) — schedule a backend investigation
  into `/api/search`'s matching/indexing logic.
- **F-013's "Enabled" default-`true` business logic** — this phase only
  fixed the *display* of the enabled-but-unconfigured contradiction (one
  combined "Not set up" badge instead of two conflicting labels). Whether a
  payment gateway should default to `enabled: true` before it's even
  configured is still an open product-owner question, unchanged by this
  phase per the task's explicit constraint not to touch the default value.
- **An automated accessibility sweep (e.g. axe-core) across all pages** —
  F-011 (muted-text contrast) and F-009/F-010 (missing accessible names /
  non-semantic headings) were all found via manual measurement/inspection
  during the phase-1 crawl. A scripted axe-core pass over every route would
  systematically catch the rest of this class of issue (contrast, missing
  labels, heading order, landmark regions) instead of relying on what one
  manual pass happened to sample.
- **`packages/web-ui/views/_theme.njk`'s `ink.faint` token** — F-011
  darkened `--color-ink-faint` in `apps/web-admin/client/src/index.css`
  only, since this audit is scoped to the web-admin React SPA. The
  Nunjucks theme file that drives the storefront (and any surviving
  Nunjucks-rendered pages) still has the old, lower-contrast `#97a1b1`
  value — flagged as a known divergence, not fixed here.
- **Bundle size** — `pnpm --filter @app/web-admin-client build` warns that
  the main JS chunk is ~994 kB (278 kB gzipped), above Vite's 500 kB
  default warning threshold. Not a UI/UX finding and not touched by this
  audit, but worth a follow-up (route-level code-splitting) since it
  affects real-world load time, which does bear on UX.

Verification for this final batch: `pnpm typecheck`, `pnpm --filter
@app/web-admin-client build`, and `pnpm test` all pass, with the same 3
pre-existing, unrelated `additionalFields.test.ts` failures noted in every
prior batch's verification notes (not touched by this or any prior phase-2
batch).

---

## F-002 — Logout was completely broken

**Before**
- Screenshot: `screenshots/logout-broken-page-not-found-desktop.png`,
  `screenshots/user-avatar-dropdown-desktop.png`
- Both logout controls (`Sidebar.tsx` footer link, `TopBar.tsx` user-avatar
  dropdown) were plain `<a href="/logout">` anchors. The backend `/logout`
  route only accepts `POST`, so clicking either link fired a browser `GET`
  that fell through to the SPA's catch-all and rendered "Page not found" —
  the session cookie was never cleared, so `/orders` (and every other
  authenticated page) kept loading normally afterward.

**After**
- Screenshot: not captured (no disposable dev DB/session was set up for this
  batch — see Verification notes below).
- Both controls are now `<button>` elements that call a shared `logout()`
  helper (`apps/web-admin/client/src/api/client.ts`), which does
  `fetch("/logout", { method: "POST", credentials: "include" })`. On
  settle (success or failure) the caller navigates to `/login` via
  `useNavigate(..., { replace: true })`. No CSRF token is attached because
  the backend `/logout` route (`apps/web-admin/src/routes/auth.ts`) uses
  `optionalAdmin`, not the `currentAdmin` + `csrfProtect` preHandler chain
  the rest of the mutating API surface uses — confirmed by reading the route
  before implementing, per the task's instruction not to assume.

**Reason**
- F-002 (Critical): logout is core account-security functionality, not
  polish — an admin who believes they've logged out (no error shown, just a
  confusing 404) has in fact left their session live on that browser/device.

**Impact**
- Logout now actually clears the session cookie and returns the admin to
  `/login`; navigating to any authenticated route afterward correctly
  redirects to `/login` instead of rendering the dashboard. One shared
  `logout()` implementation instead of two duplicated/broken call sites.

---

## F-001 — Removed duplicate "Awaiting Fulfillment" sidebar entry

**Before**
- Screenshot: `screenshots/orders-list-desktop-empty.png`
- The Sidebar's "Sales" group listed both "Orders" (`/orders`) and "Awaiting
  Fulfillment" (`/orders?status=PROCESSING`) as separate top-level nav items,
  both routing to the same `OrdersPage` component — the second just
  pre-applying a status filter, with its own badge count
  (`operations.awaitingFulfillment`) tied to the nav item.

**After**
- Screenshot: not captured (see Verification notes below).
- The "Awaiting Fulfillment" nav entry is gone from `NAV_GROUPS` in
  `Sidebar.tsx` — one "Orders" entry remains. Inside `OrdersPage.tsx`, a new
  quick-filter chip ("Awaiting Fulfillment", toggleable, styled with the
  existing `Button`/`Badge` components) sits above the filter bar; clicking
  it applies `status=PROCESSING` (click again to clear), carries the same
  badge count the removed nav item used to show, and keeps the URL
  deep-linkable at `?status=PROCESSING` — verified via the existing
  `OrdersPage.test.tsx` "pre-filters by the `?status=` query param on load"
  test, and the Dashboard's Operation Center "Awaiting Fulfillment" KPI card
  (`OperationCenter.tsx`, still linking to `/orders?status=PROCESSING`)
  continues to work unchanged, confirmed by `OperationCenter.test.tsx`.

**Reason**
- F-001 (Critical): two nav items pointing at the same page with only a
  pre-applied filter is the exact duplicate-navigation anti-pattern flagged
  in the audit brief — it inflates the sidebar and implies two distinct
  destinations where there's only one.

**Impact**
- Sidebar "Sales" group: 3 items → 2 items (Orders, Payments). The
  fulfillment-queue count is preserved, now surfaced as an in-page filter
  affordance on Orders instead of a separate nav destination; all existing
  deep links to `/orders?status=PROCESSING` (Dashboard KPI card) keep
  working unchanged.

---

## F-003 — Human-readable order status labels

**Before**
- Screenshot: `screenshots/orders-list-desktop-empty.png` (page context; the
  open-dropdown state with raw values was confirmed via accessibility
  snapshot rather than a saved PNG).
- The Orders Status filter dropdown listed all 13 order statuses verbatim as
  backend enum identifiers (SCREAMING_SNAKE_CASE), e.g. `PAYMENT_DETECTED`,
  `PENDING_VERIFICATION`.

**After**
- Screenshot: not captured (see Verification notes below).
- A new `ORDER_STATUS_LABELS` map (`apps/web-admin/client/src/lib/orderStatus.ts`)
  renders human-readable labels ("Payment Detected", "Pending Verification",
  etc.) in the Status filter dropdown. The table/detail-page Status badge
  (`StatusBadge.tsx`) was checked separately and already title-cases raw
  status strings generically (`PAYMENT_DETECTED` → "Payment Detected"), so it
  already matched every one of the 13 labels in this map — no change needed
  there; `OrderDetailPage.tsx` uses the same `StatusBadge`, so it's covered
  too.

**Reason**
- F-003 (High): raw backend enum identifiers in a filter an admin has to read
  and choose from are unnecessary friction — every other status display in
  the app is already humanized.

**Impact**
- Status filter now reads "Payment Detected" instead of `PAYMENT_DETECTED`
  for all 13 statuses. New `lib/orderStatus.ts` is reusable if another page
  needs the same mapping later. Covered by
  `apps/web-admin/client/src/lib/orderStatus.test.ts` (new).

---

## F-009 — Search button accessible name on small viewports

**Before**
- Screenshot: `screenshots/dashboard-mobile-nav-closed.png`.
- `TopBar.tsx`'s search trigger `<button>` had no `aria-label`; its text
  label and `Ctrl+K` hint are both hidden below the `sm` Tailwind breakpoint,
  leaving screen-reader users with an unnamed icon-only button at mobile
  widths (unlike its "Quick actions" and "Open navigation" siblings, which
  both have `aria-label`s).

**After**
- Screenshot: not captured (see Verification notes below).
- Added `aria-label="Search"` to the button (`apps/web-admin/client/src/components/layout/TopBar.tsx`),
  coexisting with the visually-hidden-until-`sm` text span.

**Reason**
- F-009 (High): an interactive control with no accessible name at any
  viewport width is a WCAG 4.1.2 (Name, Role, Value) failure.

**Impact**
- The search button now has a discoverable accessible name at every
  viewport width, consistent with its sibling buttons in the same TopBar.

---

## F-012 — Settings page section navigation

**Before**
- Screenshot: `screenshots/settings-desktop.png`, `screenshots/settings-mobile.png`.
- `SettingsPage.tsx` rendered 9+ sections (General, Telegram & Bot, TokoPay,
  PayDisini, NOWPayments, Bybit, Bybit BSC, Binance Internal Transfer,
  Exchange Rates, Security) as one long top-to-bottom scroll with no
  in-page navigation — reaching Security (change password / 2FA) meant
  scrolling past every other section.

**After**
- Screenshot: not captured (see Verification notes below).
- Added a sticky section nav that mirrors `Sidebar.tsx`'s own grouped-nav
  visual style: a left-hand sticky column of anchor links on `lg+` viewports
  (General / Telegram & Bot / a "Payment Gateways" group with the 6 gateways
  indented as sub-items / Exchange Rates / Security), collapsing to a sticky
  horizontally-scrollable pill row on narrower viewports. Each existing
  `<Card>` section just gained an `id` (e.g. `settings-security`) that the
  matching nav link's `href="#settings-security"` jumps to via native anchor
  navigation — no new component library, no unmounting/remounting of
  sections (so no risk to in-progress edits), no JS scroll-tracking. Every
  field, the whitelist-only edit behavior, and the per-field "Edit" button
  interaction are byte-for-byte unchanged; this is purely a layout wrapper
  around the existing content, per the task's explicit constraint. Checked
  `apps/web-admin/client/src/components/ui/tabs.tsx` (a Radix Tabs
  primitive) as a possible reuse candidate first, but a full Tabs-based
  switcher would unmount inactive sections' `FieldRow` state on tab switch
  and was a bigger behavior change than the finding called for — the sticky
  anchor-nav (the recommendation's primary option) achieves the same
  "jump to a section" outcome with none of that risk.

**Reason**
- F-012 (High): 9+ sections with zero in-page navigation forces a long
  scroll to reach Security or a specific payment gateway, one of the
  audit brief's explicit anti-patterns.

**Impact**
- Security (or any of the 10 sections) is now reachable in one click from
  anywhere on the page instead of scrolling past up to 9 other sections.
  Covered by a new test in `SettingsPage.test.tsx` asserting the nav renders
  with correct `href`s and that the target section `id`s exist in the DOM.

---

## F-016 — Context-aware Orders empty state

**Before**
- Screenshot: `screenshots/orders-list-desktop-empty.png`.
- The Orders empty state always read "No orders found / Try adjusting your
  filters." + a "Clear filters" button, even with zero filters active on a
  fresh/empty database — confusing, since there's nothing to adjust.

**After**
- Screenshot: not captured (see Verification notes below).
- `OrdersPage.tsx` now branches on whether any filter (status, search, or
  date range) is currently applied: no filter → "No orders yet" / "Orders
  placed by customers will show up here." (no action button, since there's
  nothing to clear); a filter narrowing the view → the original "No orders
  found" / "Try adjusting your filters." + "Clear filters" button.

**Reason**
- F-016 (High): the exact "Empty States" anti-pattern named in the audit
  brief — the same page as F-001, in contrast with Catalog's ("No products
  yet") and Vouchers' ("No vouchers found... Create your first voucher")
  already-contextual empty states.

**Impact**
- An admin looking at a genuinely-empty Orders page no longer sees a
  "try adjusting filters" prompt with no filters to adjust. Covered by two
  tests in `OrdersPage.test.tsx`: one confirming "No orders yet" with no
  filter, one confirming the original filtered-empty copy + Clear filters
  button still appears when a status filter narrows an empty result.

---

## F-004 — Audit Log "Admin" column shows a name instead of a raw ID

**Before**
- Screenshot: `screenshots/audit-log-desktop.png`.
- The Admin column in `AuditPage.tsx` rendered the raw internal admin
  `User.id` (e.g. `42`) instead of a name/username.

**After**
- Screenshot: not captured (see Verification notes below).
- **Triaged first, as instructed, before writing any code**: read
  `apps/web-admin/src/routes/api/admins.ts` and confirmed `logAdminAction`
  records `adminId: req.admin!.userId` — the exact same internal `User.id`
  that `GET /api/admins` already returns per admin as its `id` field
  (`apps/web-admin/src/routes/api/admins.ts` line 26, alongside `telegramId`
  and `name`). This is resolvable client-side with zero backend changes, so
  it was implemented in this batch rather than deferred. Extracted the
  admins-fetching logic that used to live only inside `AdminsPage.tsx` into
  a new shared `apps/web-admin/client/src/hooks/useAdmins.ts` (same
  `queryKey: ["admins"]`, so the two pages share one react-query cache entry
  when both are visited in a session) and used it in `AuditPage.tsx` to
  build an `id → name` map, falling back to `Admin #<id>` when the id isn't
  in the map. `GET /api/admins` is super-admin-only on the backend
  (`requireSuper`), so a non-super admin viewing Audit Log simply doesn't
  get the name map (react-query surfaces the 403 as a normal error state,
  not a thrown exception) and every row falls back to the same `Admin #<id>`
  display — no worse than before, just labeled.

**Reason**
- F-004 (High): an audit log meant to be read by shop admins (per
  `CLAUDE.md`'s logging convention) is much harder to scan when every row
  identifies the actor only by an opaque numeric id.

**Impact**
- Audit Log rows now show the acting admin's name (or Telegram-ID fallback
  if they have no name on file) instead of a bare internal id, with the raw
  id still available via a `title` tooltip. No backend route or schema was
  touched. Covered by two new tests in `AuditPage.test.tsx` (resolves a
  matching id to a name; falls back to `Admin #<id>` when `/api/admins`
  403s) plus the existing `AdminsPage.test.tsx` (unaffected — same
  behavior, now backed by the shared hook).

---

## Verification notes (F-003, F-004, F-009, F-012, F-016)

- `pnpm typecheck` — passed.
- `pnpm --filter @app/web-admin-client build` — passed.
- `pnpm test` — 2011 passed / 3 failed, all 3 failures in
  `apps/web-admin/client/src/lib/additionalFields.test.ts`, pre-existing and
  unrelated to this batch (not touched by any of these 5 findings).
- No live browser/Playwright verification was performed against a running
  dev server in this batch, for the same reason noted in the F-001/F-002
  verification notes above (no disposable DB set up for this session); all
  five changes are covered by updated/new component tests instead
  (`OrdersPage.test.tsx`, `SettingsPage.test.tsx`, `AuditPage.test.tsx`,
  `orderStatus.test.ts`) plus manual review of the rendered JSX structure
  and, for F-004, of the backend route source to confirm the id match
  before writing any code.

---

## F-005 — Audit Log Action column: humanized instead of raw backend codes

**Before**
- Screenshot: `screenshots/audit-log-desktop.png`.
- The Action column rendered raw backend action codes verbatim
  (`denomination_create`, `catalog_product_create`, `category_create`,
  `web_setup_completed`, …), redundant next to the adjacent Details
  column's already-readable sentence.

**After**
- Screenshot: not captured (see Verification notes below).
- **Chose to keep the column but humanize it**, rather than remove it: a
  new `ACTION_LABELS` map in `AuditPage.tsx` covers every action code
  currently emitted by `logAdminAction(...)` across
  `apps/web-admin/src/routes/**` (53 codes, grepped for `action: "..."`
  call sites), e.g. `denomination_create` → "Denomination created". Any
  code not in the map — future codes, or ones missed by the grep — falls
  back to a generic humanizer (`some_new_action` → "Some New Action")
  instead of showing blank, crashing, or leaking the raw snake_case. The
  raw code is still available via a `title` tooltip on hover, mirroring the
  `Admin #<id>` tooltip pattern already used for the Admin column (F-004).
  Reasoning for keeping the column: Details is a full sentence (good for
  reading one row), while Action is a short, glanceable category (good for
  scanning many rows at once, and the page's existing "Action" filter
  input already searches this exact field) — removing it would lose that
  scan-ability, so humanizing was the better fix than deleting.

**Reason**
- F-005 (Medium): raw snake_case codes next to a full readable sentence
  read as noise/inconsistent with the audit log's stated purpose (read by
  shop admins, per `CLAUDE.md`'s logging convention), not developers.

**Impact**
- Every known action code now reads as a short English phrase; unknown
  future codes degrade gracefully instead of looking broken. Covered by
  two new tests in `AuditPage.test.tsx` (known-code mapping, unknown-code
  fallback) and an update to the existing "shows audit rows" test (now
  asserts the humanized label plus the raw-code tooltip).

---

## F-006 — Standardized "simple record" inline-create pattern (Admins ↔ Vouchers)

**Before**
- Screenshot: `screenshots/admins-list-desktop.png`,
  `screenshots/voucher-create-inline-form-desktop.png`.
- Three different "add a new record" patterns existed: Products/
  Denominations (dedicated page), Vouchers (inline expand-in-place form
  above the table, but with placeholder-only labels — see F-014), and
  Admins (a bare single Telegram ID textbox with no label, built directly
  into the table's `FilterBar`).

**After**
- Screenshot: not captured (see Verification notes below).
- Admins' inline-add field now uses the same visible
  `<label className="text-xs font-medium text-ink">` + `<Input>`
  composition as the (now-also-fixed, F-014) Vouchers form — a "Telegram
  ID *" label sits above the input instead of relying on placeholder text
  alone. Did **not** change Admins from an inline row to Vouchers' full
  expand-in-place `Card` treatment (Admins only has one field, so a whole
  card section would be disproportionate) — the standardization is at the
  "every field has a persistent visible label" level the finding actually
  complains about, not the container shape. Product/Denomination remain
  the separate "complex record → dedicated page" tier, per the
  recommendation. Same `/api/admins/add` endpoint and `add` mutation —
  presentation only.

**Reason**
- F-006 (Medium): Admins' unlabeled inline textbox was the least
  accessible/consistent of the three create patterns; bringing it to the
  same labeled-field standard as Vouchers (post F-014) makes the two
  "simple record" pages feel like the same product instead of ad hoc
  per-page decisions.

**Impact**
- The Telegram ID field is now programmatically associated with its label
  (`getByLabelText` finds it), matching every other create form in the
  app. Covered by a new test in `AdminsPage.test.tsx`.

---

## F-007 — Denomination breadcrumb shows the real product name

**Before**
- Screenshot: `screenshots/denomination-create-desktop.png`.
- Both `DenominationCreatePage.tsx` and `DenominationEditPage.tsx`
  (confirmed the same bug exists in both — same nested route shape, same
  hardcoded string) rendered a breadcrumb reading "Catalog / Product" — the
  word "Product" was a literal hardcoded string, not the loaded product's
  actual name.

**After**
- Screenshot: not captured (see Verification notes below).
- `DenominationEditPage.tsx` already fetched the full product via
  `useQuery(["catalog", productId])` for its form fields — added `name:
  string` to that query's `ProductDetailForEdit.product` type and used
  `data?.product.name` in the breadcrumb, falling back to `Product
  #<id>` while loading (never a hardcoded generic label).
  `DenominationCreatePage.tsx` didn't fetch product data at all before
  this fix — added a small `useProductName` hook using the *same*
  `["catalog", productId]` query key and `GET /api/catalog/:id` endpoint,
  so react-query shares one cache entry with `ProductDetailPage.tsx` /
  `DenominationEditPage.tsx` when navigating between them in one session
  (no duplicate request in the common "product detail → new denomination"
  path). Same `Product #<id>` loading fallback as the Edit page.

**Reason**
- F-007 (Medium): a breadcrumb reading the literal word "Product" instead
  of the product's actual name is confusing/looks broken, especially with
  multiple products open across browser tabs.

**Impact**
- Breadcrumb now reads e.g. "Catalog / Netflix Premium / New Denomination"
  on both the Create and Edit pages. Covered by two new tests per page in
  `DenominationCreatePage.test.tsx` / `DenominationEditPage.test.tsx`
  (real name renders; loading state falls back to the product id, not the
  literal word "Product").

---

## F-010 — Dashboard section titles are real headings

**Before**
- Screenshot: `screenshots/dashboard-desktop-empty.png`.
- Section titles ("Critical Stock", "Upcoming Expirations", "Sales
  Analytics", "Recent Orders", "Business Health", "Top Products · Last 30
  Days") were all rendered via the shared `CardTitle` component, which is
  a plain `<div>` — only `<h1>Dashboard</h1>` and `<h2>Operation
  Center</h2>` existed as real headings anywhere on the page.

**After**
- Screenshot: not captured (see Verification notes below).
- `CardTitle` (`apps/web-admin/client/src/components/ui/card.tsx`) gained
  an optional `as` prop (`"div" | "h2" | "h3" | "h4"`, defaulting to
  `"div"` — every other `CardTitle` call site across the app, e.g.
  Settings/Vouchers/Orders/Support/Payments, is untouched and still
  renders a `<div>`). The 6 Dashboard card components
  (`InventoryMonitoringCard.tsx`, `ExpirationsTable.tsx`,
  `SalesAnalyticsCard.tsx`, `RecentOrdersTable.tsx`,
  `BusinessHealthGrid.tsx`, `TopProductsList.tsx`) now pass `as="h2"` —
  the same level as the existing "Operation Center" `<h2>`, since all of
  them are siblings/top-level sections directly under the page's `<h1>`,
  not nested under Operation Center. CSS classes are byte-for-byte
  identical — only the rendered tag changes. Deliberately scoped to just
  these 6 files rather than changing `CardTitle`'s default globally: 21
  files use `CardTitle`, most as an in-page section label where the page
  already has its own single logical heading, and blanket-converting all
  of them risked incoherent heading nesting elsewhere (out of scope for a
  Dashboard-only finding).

**Reason**
- F-010 (Medium): visually-heading-styled section titles that are actually
  `<div>`s break screen-reader heading-based navigation — a sighted user
  scans the page by section title, a screen-reader user relying on the
  heading outline couldn't do the equivalent.

**Impact**
- `document.querySelectorAll('h1,h2,h3,h4,h5,h6')` on the Dashboard now
  returns 8 headings instead of 2 (`Dashboard` h1, plus 7 h2s: `Operation
  Center` and the 6 card titles). No visual change (same classes, same
  render). No existing dashboard component test asserted on tag name, so
  none needed updating; typecheck/build confirm the `as` prop's type
  narrowing compiles cleanly.

---

## F-011 — Low-contrast muted text token darkened to meet WCAG AA

**Before**
- Screenshot: `screenshots/dashboard-desktop-empty.png` (TopBar
  "Search..." text).
- The shared Tailwind token `--color-ink-faint` (`text-ink-faint` /
  `bg-ink-faint` utility classes, defined in
  `apps/web-admin/client/src/index.css`) was `#97a1b1` — measured
  `rgb(151, 161, 177)` on a white/near-white background, ~2.6:1 contrast,
  below the 4.5:1 WCAG AA minimum for normal text. Grepped every use
  across `apps/web-admin/client/src`: the TopBar "Search..." label, the
  global search modal's placeholder/hint text, `EmptyState`'s icon,
  `SearchBar`'s icon, the Admins table's "—" dash for unset
  password/2FA, an inactive-denomination row's name text, and
  `UrgencyDot`'s "idle" fill color — all small secondary text or
  small/decorative icons, no large-text-only uses that would already have
  passed at the lighter shade.

**After**
- Screenshot: not captured (see Verification notes below).
- Darkened `--color-ink-faint` to `#626f83` — same hue/saturation (~217°,
  14%), lightness reduced from 64% to 45%, which measures ~5.1:1 against
  white (comfortable margin above the 4.5:1 minimum). Left the hue/brand
  family untouched, per the task's "adjust only lightness" constraint.
  **Scoped to `apps/web-admin/client/src/index.css` only** — this token is
  also defined in `packages/web-ui/views/_theme.njk` (`ink.faint:
  "#97a1b1"`), which drives the storefront's and any surviving
  Nunjucks-rendered admin pages' styling, per that file's own "keep
  byte-for-byte in sync" comment. Left that file unchanged since this
  audit is explicitly scoped to `apps/web-admin`'s React SPA — flagging
  the now-intentional divergence here rather than silently leaving it
  undocumented; if a future audit covers the storefront/Nunjucks surface,
  `packages/web-ui/views/_theme.njk`'s `ink.faint` should get the same
  `#626f83` value for consistency.

**Reason**
- F-011 (Medium): failing WCAG AA contrast on a common, frequently-used
  utility text color is a real accessibility gap for low-vision users, not
  a cosmetic nitpick — and being a shared token means the fix helps every
  one of its ~10 use sites at once.

**Impact**
- The TopBar search label (and every other `text-ink-faint` use in the
  admin SPA) now meets 4.5:1 contrast. No component/behavior change, no
  test assertions on color values existed to update; verified by manual
  contrast calculation (documented inline in `index.css`) rather than an
  automated contrast-checker run (none was available in this session).

---

## F-013 — Settings gateway status: one combined label instead of two conflicting ones

**Before**
- Screenshot: `screenshots/settings-desktop.png`.
- Every payment gateway card (TokoPay, PayDisini, NOWPayments, Bybit,
  Bybit BSC, Binance Internal Transfer) showed two independent signals
  side by side: a "not configured" text next to the title (only when
  `!methodState.configured`) and, separately, the raw toggle state next to
  the Switch ("Enabled"/"Disabled") — so an unconfigured-but-toggled-on
  gateway showed "not configured" and "Enabled" simultaneously, reading as
  contradictory about whether it was actually active.

**After**
- Screenshot: not captured (see Verification notes below).
- Added a `gatewayStatus()` helper in `SettingsPage.tsx` that derives one
  combined badge: **"Not set up"** whenever `!configured` (regardless of
  the raw `enabled` value — an unconfigured gateway can't process a
  payment no matter what the toggle says), otherwise **"Enabled"** /
  **"Disabled"** reflecting the real toggle state. This single badge now
  sits next to the card title, replacing both the old "not configured"
  text and the old Enabled/Disabled text next to the switch. The Switch
  itself is untouched — same `checked={methodState.enabled}`, same
  `togglePayment.mutate(...)` call, same backend default — only gained an
  `aria-label` (e.g. "Disable PayDisini") since it no longer has adjacent
  visible text naming it, plus a `title` tooltip on the unconfigured case
  explaining why toggling won't do anything yet. **Did not touch the
  `enabled` default value or any toggle business logic**, per the task's
  explicit constraint — confirmed by re-reading
  `apps/web-admin/src/routes/api/settings.ts`'s toggle route before
  editing, which is unchanged.

**Reason**
- F-013 (Medium): showing "Enabled" and "not configured" as two
  independent, non-reconciled signals about the same gateway is
  confusing about whether it will actually process a payment — collapsing
  to one derived status removes the apparent contradiction without
  changing what data drives it.

**Impact**
- Each gateway card now shows exactly one status word ("Not set up" /
  "Enabled" / "Disabled") instead of up to two, some times conflicting,
  labels. Covered by a new test in `SettingsPage.test.tsx` asserting an
  enabled-but-unconfigured gateway shows "Not set up" (not "not
  configured" text), a configured-and-enabled gateway still shows
  "Enabled", and the switch itself keeps its real checked state and gains
  an accessible name.

---

## F-014 — Voucher inline-create form: every field has a persistent visible label

**Before**
- Screenshot: `screenshots/voucher-create-inline-form-desktop.png`.
- The inline "New Voucher" form (Code, Type, Value, Min purchase, Usage
  limit, Expires — note: no separate "Currency" field exists in the
  current form; the audit brief's field list appears to have been
  slightly imprecise here, consistent with `findings.md`'s own caveat that
  file/field lists "may not be 100% exact") relied on placeholder-only
  text for every `Input`, and the Type `Select` had no label or
  `aria-label` at all — confirmed as an unlabeled `combobox` in the
  original accessibility snapshot.

**After**
- Screenshot: not captured (see Verification notes below).
- Every field now has a persistent `<label className="text-xs font-medium
  text-ink" htmlFor="...">` above it (matching the label style already
  used elsewhere in this same file, e.g. the Status filter's "Status"
  label, rather than introducing a third label style into one page),
  including the Type `Select` — its `SelectTrigger` now has a matching
  `id` + `aria-label="Type"`, closing the "no label at all" gap the audit
  specifically called out. Required fields (Code, Type, Value) keep the
  `<span className="text-rust">*</span>` marker used on Product/
  Denomination's dedicated-page forms; placeholders were kept as example
  text (e.g. "e.g. SAVE10") rather than removed, now that they're no
  longer the only labeling mechanism. Same `create` mutation / `/api/vouchers`
  endpoint — presentation only.

**Reason**
- F-014 (Medium): placeholder-only labels disappear the moment a user
  types, and the missing Type label was a real WCAG 3.3.2 (Labels or
  Instructions) / 4.1.2 (Name, Role, Value) gap, not just inconsistency
  with Product/Denomination's forms.

**Impact**
- All 6 fields (Code, Type, Value, Min purchase, Usage limit, Expires) are
  now programmatically associated with a visible label via `getByLabelText`
  / `getByRole("combobox", { name: "Type" })`. Covered by a new test in
  `VouchersPage.test.tsx`.

---

## Verification notes (F-005, F-006, F-007, F-010, F-011, F-013, F-014)

- `pnpm typecheck` — passed.
- `pnpm --filter @app/web-admin-client build` — passed.
- `pnpm test` — 2019 passed / 3 failed, all 3 failures in
  `apps/web-admin/client/src/lib/additionalFields.test.ts`, pre-existing
  and unrelated to this batch (not touched by any of these 7 findings; the
  task explicitly says not to fix them).
- No live browser/Playwright verification was performed against a running
  dev server in this batch (same constraint as the earlier Critical/High
  batches — no disposable DB set up this session); all seven changes are
  covered by updated/new component tests instead (`AuditPage.test.tsx`,
  `AdminsPage.test.tsx`, `VouchersPage.test.tsx`,
  `DenominationCreatePage.test.tsx`, `DenominationEditPage.test.tsx`,
  `SettingsPage.test.tsx`) plus manual review of rendered JSX/CSS for the
  two findings with no direct test surface (F-010's heading tags, F-011's
  contrast token — the latter verified by manual WCAG contrast-ratio
  calculation, documented inline in `index.css`).

---

## Verification notes (both F-001 and F-002)

- `pnpm typecheck` — passed.
- `pnpm --filter @app/web-admin-client build` — passed.
- `pnpm test` — passed for every file touched by this batch
  (`OrdersPage.test.tsx`, `OperationCenter.test.tsx`, and the full suite
  otherwise green); 3 pre-existing failures in
  `apps/web-admin/client/src/lib/additionalFields.test.ts` are unrelated —
  that file was already modified by other in-progress work before this
  batch started and this batch never touched it.
- No live browser/Playwright verification was performed against a running
  dev server in this batch — doing so would need a disposable
  `DATABASE_URL_PRISMA` SQLite file per `docs/ui-refactor/overview.md`, which
  was out of scope for the time available; the fixes are covered by the
  updated component tests and manual code review of the request/response
  contract (`apps/web-admin/src/routes/auth.ts`) instead.

## F-008 — Removed redundant "← Back" button where a breadcrumb already goes back

**Before**
- Screenshot: `screenshots/product-create-desktop.png`,
  `screenshots/denomination-create-desktop.png`.
- 8 pages showed both a breadcrumb link in the top-left and a separate
  "← Back" button in the top-right `PageHeader` `actions` slot, navigating
  to the exact same destination as the breadcrumb's last crumb: Product
  Create, Denomination Create, Denomination Edit, Product Detail, Stock
  Product Detail, User Detail, Order Detail, and Ticket Detail. There is no
  shared `PageHeader`/`PageLayout` "Back button" prop — each page built its
  own `<Button onClick={() => navigate(...)}>← Back</Button>` inline inside
  its own `actions` JSX, duplicating both the affordance and the
  implementation 8 times.

**After**
- Screenshot: not captured (see Verification notes below).
- Removed the "← Back" `Button` from all 8 pages' `PageHeader`, keeping the
  breadcrumb (it still communicates hierarchy and remains the one way back).
  Checked every call site first, as instructed, before touching anything —
  confirmed all 8 Back-button targets were byte-identical to their
  breadcrumb's last-crumb `href`, so no navigation behavior changed, only
  the duplicate control was removed. `apps/web-admin/client/src/pages/StockProductPage.tsx`
  kept its other `actions` item ("Download credentials") — only the Back
  button was dropped, not the whole `actions` slot. In
  `OrderDetailPage.tsx` and `StockProductPage.tsx`, `navigate`/`useNavigate`
  had no other call site once the Back button was removed, so the now-dead
  `const navigate = useNavigate()` and its import were removed too rather
  than left as unused (avoids a lint/dead-code smell); the other 6 pages
  use `navigate` elsewhere (e.g. on form submit) so it was left in place.
  Two pages with a superficially similar "Back to login" link
  (`ResetPage.tsx`, `ForgotPage.tsx`) were deliberately left alone — they
  have no breadcrumb at all (pre-login screens, outside the authenticated
  `PageHeader` layout), so removing their only way back would strand the
  user, exactly the risk the task called out to check for before changing
  a shared pattern's default behavior.

**Reason**
- F-008 (Low): a breadcrumb link and a "← Back" button pointing at the same
  destination are two competing controls for one action — extra visual
  noise with no added capability.

**Impact**
- 8 pages now have exactly one way back (the breadcrumb) instead of two
  redundant ones pointing at the same place; no navigation destination
  changed. No test referenced the "← Back" button text in any of the 8
  pages' `*.test.tsx` files (confirmed via grep before editing), so no
  test updates were needed; `pnpm typecheck` catches any accidentally
  orphaned `navigate`/`useNavigate` reference.

---

## F-015 — Renamed the Admins table's "Pwd" column header

**Before**
- Screenshot: `screenshots/admins-list-desktop.png`.
- The Admins table (`apps/web-admin/client/src/pages/AdminsPage.tsx`) had a
  column literally headed "Pwd", showing a ✓ badge or a "—" dash for
  whether that admin has a password set.

**After**
- Screenshot: not captured (see Verification notes below).
- Renamed the header from `"Pwd"` to `"Password Set"`. Checked the other
  column headers in the same table first ("Telegram ID", "Role", "2FA",
  "Session") — "Telegram ID" is already an 11-character header in this
  table, so "Password Set" (13 characters) fits the table's existing
  width conventions without needing a tooltip-only fallback. Left the "2FA"
  header as-is (it's a standard abbreviation/initialism, not a truncation
  like "Pwd", so it doesn't have the same clarity problem the finding
  called out).

**Reason**
- F-015 (Low): "Pwd" is an unexplained abbreviation in a security-relevant
  column (whether an admin account has a password set) — clarity matters
  more here than saving a few characters of header width.

**Impact**
- The column now reads "Password Set" instead of the ambiguous "Pwd". No
  test referenced the header text "Pwd" (confirmed via grep before
  editing), so no test updates were needed.

---

## F-018 — Verified: chart x-axis label skip is intentional Recharts behavior, not a bug

**Before**
- Screenshot: `screenshots/dashboard-mobile.png`.
- At 375px width, the Sales Analytics chart's x-axis accessibility tree
  showed 6 of 7 date labels (`07-13` missing from the middle of the
  sequence), while all 7 rendered at desktop width.

**After**
- Screenshot: none — **no code was changed**. This finding was a
  "verify, don't blindly fix" task, and the verification concluded the
  behavior is intentional.
- Read `apps/web-admin/client/src/components/dashboard/SalesAnalyticsCard.tsx`:
  the chart is Recharts (`^2.13.3` in `apps/web-admin/client/package.json`,
  resolved `2.15.4` in `node_modules`), rendered via `<XAxis dataKey="day"
  tick={{ fontSize: 11 }} .../>` with no `interval` prop set — meaning it
  uses Recharts' own default. Read the installed library source directly
  (`node_modules/.pnpm/recharts@2.15.4.../recharts/lib/cartesian/CartesianAxis.js`,
  `defaultProps`): `interval: 'preserveEnd'` and `minTickGap: 5` are
  Recharts' own built-in defaults, not anything this codebase configured.
  `'preserveEnd'` is Recharts' auto-thinning algorithm: it measures each
  tick label's actual rendered text width against the axis's available
  pixel width and drops just enough interior ticks (keeping the last one)
  to maintain at least `minTickGap` between adjacent labels — it does not
  guarantee an evenly-spaced "skip every Nth" pattern, which is exactly
  why the drop looked "inconsistent with even a simple skip-every-other
  rule" per the phase-1 note. Also relevant: the chart's container is
  `<div className="h-64 w-full overflow-x-auto"><div className="h-full
  min-w-[480px]">`, so the actual SVG the axis measures against is at
  least 480px wide even inside a 375px viewport (the outer div scrolls
  rather than the chart shrinking below 480px) — desktop's wider card
  gives the axis more room per tick than the 480px floor does, which is
  why desktop fits all 7 labels and the narrower 480px rendering doesn't.
  This fully explains the observed behavior as Recharts working as
  designed, not an off-by-one bug in this codebase.

**Reason**
- F-018 (Low, "needs verification"): the task explicitly required
  confirming library-default behavior vs. a genuine bug before touching
  anything, since many chart libraries auto-thin axis labels by design.
  This is exactly that case — changing it (e.g. forcing `interval={0}` to
  show all 7 labels) would fight the library's overlap-prevention on
  narrow/scrolled widths and risk crowded, overlapping text instead.

**Impact**
- No behavior change. Documented here as the audit's explicit verdict:
  **verified as expected Recharts library behavior** (`interval:
  'preserveEnd'`, Recharts' own default), not a bug — closing out F-018
  without a code change, per the task's instruction not to "blindly fix"
  a finding that turns out to be by-design.

---

## Verification notes (F-008, F-015, F-018)

- `pnpm typecheck` — passed.
- `pnpm --filter @app/web-admin-client build` — passed.
- `pnpm test` — 2019 passed / 3 failed, all 3 failures in
  `apps/web-admin/client/src/lib/additionalFields.test.ts`, pre-existing
  and unrelated to this batch (F-008/F-015/F-018 never touch that file).
- F-018 involved no code change, so nothing new needed test coverage there.
  F-008 and F-015 are pure text/JSX-removal changes with no new behavior to
  assert; existing tests for all 8 touched pages (`ProductCreatePage`,
  `DenominationCreatePage`, `DenominationEditPage`, `ProductDetailPage`,
  `UserDetailPage`, `OrderDetailPage`, `TicketDetailPage`, `StockProductPage`,
  `AdminsPage`) continued to pass unmodified.
- No live browser/Playwright verification was performed against a running
  dev server in this batch (same constraint noted in every prior batch —
  no disposable DB set up this session); F-018's verdict instead rests on
  reading the actual installed Recharts source in `node_modules` (not just
  its public docs), which pins down the exact default responsible.

---

## Planned entries (to be filled in during phase 2, in priority order)

- [x] F-001 — Duplicate Orders/Awaiting Fulfillment sidebar entries
- [x] F-002 — Broken logout
- [x] F-003 — Raw enum values in Orders status filter
- [x] F-004 — Raw admin ID in Audit Log (resolved client-side, no backend change needed — triaged as UI-only per the task instructions, not deferred)
- [x] F-009 — Icon-only Search button missing accessible name
- [x] F-012 — Settings page navigation/sectioning
- [x] F-016 — Orders empty state not context-aware
- [x] F-005 — Raw action codes in Audit Log (kept the column, humanized with a fallback for unknown codes)
- [x] F-006 — Inconsistent create-record patterns (Admins' inline field labeled to match Vouchers)
- [x] F-007 — Denomination breadcrumb bug (fixed on both Create and Edit pages)
- [x] F-010 — Dashboard headings not semantic (CardTitle gained an `as` prop, used only on the 6 Dashboard cards)
- [x] F-011 — Low-contrast muted text (`--color-ink-faint` darkened in the web-admin SPA's index.css)
- [x] F-013 — Settings gateway toggle/status contradiction (one combined status badge)
- [x] F-014 — Voucher form missing field labels (including the previously-unlabeled Type combobox)
- [x] F-008 — Redundant breadcrumb + Back button (removed the Back button on all 8 affected pages, kept the breadcrumb)
- [x] F-015 — "Pwd" column header abbreviation (renamed to "Password Set")
- [ ] F-017 — Search returns no results (confirmed backend/business-logic — deferred, out of scope for this UI-only phase)
- [x] F-018 — Chart x-axis label skip on mobile (verified as intentional Recharts `interval: 'preserveEnd'` default behavior — no code change)

**Final tally: 17 of 18 findings implemented in phase 2; 1 deferred (F-017, backend search matching/indexing — out of scope for this UI-only phase).**
