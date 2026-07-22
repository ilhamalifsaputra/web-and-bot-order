# 02 — Admin Layout

**Scope:** the page shell (`AppShell`, `Sidebar`, `TopBar`) and the mandatory
top-to-bottom hierarchy every admin page must follow. Tokens referenced here are
defined in `01_DESIGN_SYSTEM.md`.

---

## 1. The shell

Every authenticated route renders inside one shell, mounted once at the router root:

```
AppShell (apps/web-admin/client/src/components/layout/AppShell.tsx)
├── Sidebar (fixed ≥1024px, slide-in drawer <1024px)
├── flex column
│   ├── TopBar (sticky, h-14)
│   └── <main> (scrollable)
│       └── content column (max-w-[1440px], centered, responsive padding)
│           └── <Outlet/> — the current page, wrapped in PageTransition + a
│                            per-route ErrorBoundary keyed by pathname
├── SearchModal (global, opened by Ctrl+K/Cmd+K or the TopBar search trigger)
└── Toaster (sonner, mounted once at shell level)
```

```tsx
<div className="flex h-screen overflow-hidden bg-paper">
  <Sidebar open={sidebarOpen} onClose={...} />
  <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
    <TopBar onMenuClick={...} onSearchOpen={...} />
    <main className="flex flex-1 flex-col overflow-y-auto bg-paper">
      <div className="mx-auto w-full max-w-[1440px] flex-1 px-4 py-4 sm:px-5 sm:py-6 lg:px-6 xl:px-8">
        <PageTransition><ErrorBoundary key={location.pathname}><Outlet/></ErrorBoundary></PageTransition>
      </div>
    </main>
  </div>
</div>
<SearchModal .../>
<Toaster />
```

No page ever re-implements this shell, sets its own max-width, or opts out of the
content-column padding. A page component only ever renders what goes *inside* the
`<Outlet/>`.

## 2. Sidebar

`components/layout/Sidebar.tsx` — fixed width **`w-56`** (224px), both as the
permanent desktop column and the mobile drawer.

- **≥1024px (`lg`):** `<aside className="hidden w-56 flex-shrink-0 lg:block">` —
  always visible, no collapse-to-icons mode. This is a binary shown/hidden sidebar,
  not a resizable or collapsible-width one.
- **<1024px:** a fixed-position drawer (`fixed inset-y-0 left-0 z-40 w-56 lg:hidden`)
  that slides in via `translate-x-0`/`-translate-x-full`
  (`transition-transform duration-200 ease-in-out`), with a semi-transparent backdrop
  (`fixed inset-0 z-30 bg-ink/40 lg:hidden`) that closes it on click. Opened by the
  `TopBar`'s hamburger button. Tapping a nav item auto-closes the drawer.

### Content

- Header row: shop name (from `useShopInfo()`, falls back to `"Shop Admin"`),
  `font-display text-lg font-semibold text-ink`, plus a mobile-only close (`X`)
  button.
- Nav, grouped (live structure — treat this list itself as canonical, not the
  original redesign spec's proposed list, which differs):
  - Dashboard (ungrouped)
  - **Sales** — Orders, Payments
  - **Products** — Catalog, Stock, Flash Sales, Vouchers
  - **Customers** — Customers
  - **Support** — Tickets, Broadcast, Reviews
  - **Reports** — Reports, Audit Log, Outbox
  - **Administration** — Admins, Settings, Branding
  - Group headers (when present): `text-xs font-semibold uppercase tracking-wider
    text-ink-soft`.
- Nav items are `react-router-dom` `NavLink`s. Active state: `bg-pine-tint
  text-pine`. Inactive: `text-ink-soft hover:bg-sand hover:text-ink`.
- Two items (Orders, Stock) carry small live count badges (red `bg-rust` for
  urgent/orders-needing-action, amber `bg-amberx` for stock warnings), computed from
  the relevant query hook. Add a badge the same way if a new nav item needs one — do
  not invent a different badge shape or color meaning.
- Footer: plain-text "Logout" (`text-xs text-ink-soft hover:text-rust`).

### Adding a new nav item

1. Add it to the existing `NAV_GROUPS` structure inside the group it semantically
   belongs to — do not create a new top-level group unless the item genuinely doesn't
   fit any existing one.
2. If it needs a live count badge, follow the existing `ordersBadge`/`stockBadge`
   pattern (a query hook feeding a small pill), not a new visual treatment.
3. Never add a standalone "Search" nav item — global search is already reachable via
   `Ctrl+K`/the TopBar search trigger.

## 3. TopBar

`components/layout/TopBar.tsx` — fixed height **`h-14`** (56px), `sticky top-0 z-40`,
`border-b border-line`, `bg-card` (white).

Left → right:
1. Mobile-only hamburger (`Menu` icon, `lg:hidden`) — opens the sidebar drawer.
2. Global search trigger — opens `SearchModal`; shows a `Ctrl+K` kbd hint (hidden
   below `sm`).
3. Flexible spacer.
4. **Quick Actions** — a `+` button opening a dropdown: Add Product → `/catalog`,
   Add Stock → `/stock`, Broadcast → `/broadcast`, Add Customer → `/users`, Reports →
   `/reports`. This is the live, canonical "quick actions" surface for the whole app —
   see `07_DASHBOARD_GUIDELINES.md` §7 for the removed dashboard-local alternative.
5. User avatar menu — initials in a `bg-pine-tint text-pine` circle, name hidden
   below `md`, dropdown containing Logout.

Dropdown panels here are custom `framer-motion` `AnimatePresence` panels (the shared
`fadeIn` variant, `01_DESIGN_SYSTEM.md` §8) styled `rounded-md border border-line
bg-card shadow-lift` — not Radix `DropdownMenu` (that primitive is used for in-page
row-action menus, see `05_TABLE_GUIDELINES.md`). **There is no breadcrumb in the
TopBar** — breadcrumbs are per-page, via `PageHeader` (§5 below).

## 4. Standard page hierarchy

Every CRUD/list/detail admin page follows this vertical order. Do not reorder it or
invent a different one unless there is a documented, strong UX reason (and if so,
update this doc).

```
Page Title              →  PageHeader's <h1> (+ optional breadcrumb above, description below)
      ↓
Description             →  PageHeader's description line (optional)
      ↓
Summary Cards            →  KPI/stat Card grid, optional — e.g. OrdersKpiRow above OrdersPage's table
      ↓
Toolbar                  →  FilterBar (SearchBar + filter controls)
      ↓
Bulk Actions              →  conditional sticky bar, only rendered when selection is non-empty
      ↓
Table                    →  DataTable
      ↓
Pagination                →  Pagination, when the dataset is server-paginated
```

Mapped onto real components (from `OrdersPage.tsx`, the fullest example):

```tsx
<PageLayout title="Orders">
  <PageHeader title="Orders" description="..." actions={<ExportButton/>} />

  {/* Summary Cards — optional */}
  <OrdersKpiRow />

  {/* Toolbar */}
  <FilterBar onApply={applyFilters} onClear={clearFilters}>
    <SearchBar .../>
    <Select ... />   {/* Status, Payment Method, etc. */}
    <DateInput .../>
  </FilterBar>

  {/* Bulk Actions — conditional */}
  {selected.size > 0 && (
    <div className="sticky bottom-4 z-10 mb-3 flex items-center gap-3 rounded-lg
                     border border-line bg-card px-3 py-2 text-sm shadow-lift">
      ...
    </div>
  )}

  {/* Table */}
  <DataTable columns={...} data={...} isLoading={...} empty={<EmptyState .../>} />

  {/* Pagination */}
  {data && <div className="mt-4"><Pagination .../></div>}
</PageLayout>
```

## 5. `PageHeader` and `PageLayout`

- **`PageLayout`** (`components/shared/PageLayout.tsx`) is intentionally thin — it
  only sets `document.title` (format: `"{title} — Shop Admin"`) and renders
  `children`. It carries **no visual layout logic**. Some simple pages (e.g.
  `DashboardPage`) skip it entirely and render `PageHeader` directly — both are
  valid; `PageLayout` is for `document.title`, not spacing.
- **`PageHeader`** (`components/shared/PageHeader.tsx`) owns:
  - An optional breadcrumb row (`text-xs text-ink-soft`, `ChevronRight` separators
    `h-3.5 w-3.5 text-ink-faint`).
  - The page `<h1>` — `font-display text-2xl font-semibold text-ink`.
  - An optional description paragraph — `mt-0.5 text-sm text-ink-soft`.
  - An optional `actions` slot, right-aligned.
  - Its own `mb-6` bottom margin.
  - Responsive: stacked (`flex-col`) below `sm`, `sm:flex-row sm:items-center
    sm:justify-between` at `sm`+.

### Critical spacing rule

**`PageHeader` must be a direct sibling of the page body, never nested inside a
`gap-*` flex container alongside it.** `PageHeader` supplies its own `mb-6`; if it's
placed as a child of a `flex flex-col gap-6` wrapper together with the rest of the
page, the header's `mb-6` *and* the wrapper's `gap-6` both apply, doubling the
title-to-content spacing. This exact bug was found and fixed on `DashboardPage.tsx`
during the July 2026 consistency pass — treat it as the canonical cautionary example.
Correct pattern:

```tsx
<PageHeader title="..." />              {/* sibling, not inside the gap wrapper */}
<div className="flex flex-col gap-6">   {/* everything BELOW the header */}
  ...
</div>
```

### Breadcrumbs

Use `PageHeader`'s `breadcrumb` prop for hierarchical navigation (e.g. Catalog →
Product → Denomination). Do not also render a separate "← Back" button on the same
page alongside a breadcrumb — that duplicates the same navigational affordance twice.
Pick one: breadcrumb for pages reached via a clear hierarchy, a single back
action for pages reached via a flatter flow.

## 6. Responsive behavior summary

| Element | <640px (mobile) | 640–1023px (tablet) | ≥1024px (desktop) |
|---|---|---|---|
| Sidebar | Hidden, opens as slide-in drawer via hamburger | Same as mobile | Fixed `w-56` column, always visible |
| TopBar | Hamburger + search icon only | + search label/kbd hint | + user name label (at `md`) |
| PageHeader | Title/description/actions stacked | Title+description left, actions right (`sm:flex-row`) | Same |
| Content padding | `px-4 py-4` | `sm:px-5 sm:py-6` | `lg:px-6` (≥1024px), `xl:px-8` (≥1280px) |
| DataTable | Card-stack (one card per row) | Table layout from `md` (768px) up | Table layout |
| FilterBar | Wraps (`flex-wrap`) | Wraps as needed | Single row where it fits |

See `05_TABLE_GUIDELINES.md` for the table-specific mobile card-stack behavior in
detail, and `01_DESIGN_SYSTEM.md` §11 for the raw breakpoint values.

## 7. Never do

- Never set a different content max-width or padding scheme on a single page — it
  comes free from `AppShell`.
- Never render a page's `<h1>` outside `PageHeader`.
- Never add a second global nav surface (a second sidebar, a second topbar) for a
  feature area — extend the existing `Sidebar`/`TopBar`.
- Never nest `PageHeader` inside a `gap-*` container with the rest of the page body
  (§5).
- Never pair a breadcrumb with a redundant separate back button.
