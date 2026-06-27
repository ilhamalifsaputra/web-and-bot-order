# Plan: Admin Panel SaaS Redesign

## Context

The existing `apps/web-admin/client` React SPA has two inconsistent styles:
- **Dashboard (`/`)**: standalone, already well-styled with Tailwind/shadcn
- **Inner pages (16+)**: use `PageLayout` wrapper but bodies are almost entirely `style={{...}}` inline CSS — no Tailwind, no shadcn, no consistent component library

The goal is to modernize the UI into a professional SaaS admin (Stripe/Linear/Vercel feel) while preserving every route, API call, business logic, and database interaction. No backend changes.

**User decisions confirmed:**
- Unified AppShell (sidebar + topbar) for ALL authenticated pages
- All pages including login/setup flow
- Dark mode: toggle only (wire up `.dark` class + localStorage; tokens already in `index.css`)
- Phased approach: Phase 1 → Phase 2 → Phase 3

---

## Existing Assets to Reuse (Do Not Rewrite)

| Asset | Path | Use |
|---|---|---|
| `apiGet`, `apiPost`, `publicPost` | `src/api/client.ts` | All data fetching |
| All dashboard hooks | `src/hooks/use*.ts` | Keep unchanged |
| `StatusBadge` | `src/components/shared/StatusBadge.tsx` | Minor visual polish only |
| `CurrencyAmount`, `CurrencyStack`, `formatCurrencyDisplay` | `src/components/shared/CurrencyAmount.tsx` | Reuse unchanged |
| `StatTrend`, `UrgencyDot` | `src/components/shared/` | Reuse unchanged |
| All dashboard section components | `src/components/dashboard/*.tsx` | Keep working, just move into AppShell |
| `useOperations()` | `src/hooks/useOperations.ts` | Sidebar badge data (React Query caches; no extra fetch) |
| `useInventory()` | `src/hooks/useInventory.ts` | Sidebar stock badge |
| shadcn `Card`, `Badge` | `src/components/ui/` | Already present |

---

## Phase 1 — AppShell + Unified Layout

**Goal:** Every authenticated page shares one sidebar + topbar. Dashboard moves inside the shell.

### New files

| File | Purpose |
|---|---|
| `src/components/layout/ThemeProvider.tsx` | Context + `localStorage` + toggle `.dark` on `<html>` |
| `src/components/layout/AppShell.tsx` | Root shell: `ThemeProvider` → flex row of Sidebar + right column (TopBar + `<Outlet>`) |
| `src/components/layout/Sidebar.tsx` | Grouped nav with icons, badge counters, collapsible groups, responsive hide on mobile |
| `src/components/layout/TopBar.tsx` | Search trigger (Ctrl+K), theme toggle, quick actions menu, user avatar + logout |
| `src/components/layout/SearchModal.tsx` | Ctrl+K modal — calls existing `/api/search?q=` endpoint, navigates to result |

### Sidebar nav structure

```
Dashboard           /           LayoutDashboard icon
─── Sales ──────────────────────
  Orders            /orders     ShoppingCart   [badge: pendingPayments + manualReviews]
  Payments          /payments   CreditCard
─── Products ───────────────────
  Catalog           /catalog    Package
  Stock             /stock      Boxes          [badge: critical stock count]
  Vouchers          /vouchers   Tag
─── Customers ──────────────────
  Customers         /users      Users
─── Support ────────────────────
  Tickets           /support    MessageCircle
  Broadcast         /broadcast  Megaphone
  Reviews           /reviews    Star
─── Reports ────────────────────
  Reports           /reports    BarChart2
  Audit Log         /audit      ClipboardList
  Outbox            /outbox     Send
─── Administration ─────────────
  Admins            /admins     Shield
  Settings          /settings   Settings
  Branding          /branding   Palette
  Search            /search     Search
```

Badge data: reuse cached `useOperations()` result — no extra API call.

### Modify existing files

- **`src/App.tsx`**: Add `<AppShell>` wrapping all authenticated routes via a layout route. Auth/setup pages (`/login`, `/forgot`, `/reset`, `/bootstrap`, `/setup/*`) remain outside AppShell (their own standalone wrapper). Remove the standalone Dashboard `<header>` — TopBar replaces it.
- **`src/components/shared/PageLayout.tsx`**: Simplify to just render `children` inside a `<main className="flex-1 p-4 sm:p-6">` — sidebar/header now come from AppShell. Keep the `title` prop for `<document.title>` only.

### TopBar quick actions

Dropdown with: + Add Product (`/catalog/new`), + Add Stock (`/stock`), + Broadcast (`/broadcast`), + Add Customer (`/users/new`), Reports (`/reports`).
> Route targets that don't have a "new" page yet navigate to the list page — no new routes created.

### Dark mode

`ThemeProvider` reads `localStorage.getItem('theme')`, applies `document.documentElement.classList.toggle('dark', ...)`. Toggle button in TopBar switches and persists. The CSS variables for `.dark` are already defined in `src/index.css` — no CSS changes needed.

---

## Phase 2 — Design System Components

**Goal:** Shared Tailwind/shadcn primitives to be used in Phase 3 page rewrites. Install missing shadcn components first.

### shadcn primitives to add (`pnpm dlx shadcn add …`)

`button`, `input`, `select`, `dialog`, `skeleton`, `dropdown-menu`, `tooltip`, `separator`, `textarea`, `label`, `table`

All install to `src/components/ui/`. No custom logic — shadcn defaults.

### New shared components

| File | What it does |
|---|---|
| `src/components/shared/PageHeader.tsx` | `title` + optional `breadcrumb` + `actions` slot. Used at top of every page's `<main>`. |
| `src/components/shared/DataTable.tsx` | Generic `<Table>` wrapper: `columns` + `data` + `isLoading` (skeleton rows) + `empty` slot. Uses shadcn `Table`. |
| `src/components/shared/FilterBar.tsx` | Flex row of filter controls + Apply/Clear buttons. Accepts `children` slots. |
| `src/components/shared/ConfirmDialog.tsx` | Wraps shadcn `Dialog` — `trigger`, `title`, `description`, `onConfirm`. Replaces native `confirm()` calls. |
| `src/components/shared/EmptyState.tsx` | **Replace existing** (currently just centered text). Add: Lucide icon prop, title, description, optional CTA `<Button>`. |
| `src/components/shared/SkeletonRow.tsx` | `<Skeleton>` row for table loading states. |

---

## Phase 3A — High-Traffic Inner Pages

Convert from inline `style={{...}}` to Tailwind + shared components. Business logic, API calls, and state are untouched — only JSX/styling changes.

### Pages (in order of admin usage frequency)

**`OrdersPage.tsx`**
- Replace native `<select>/<input>/<button>` filter bar → `FilterBar` + shadcn `Select`, `Input`, `Button`
- Replace `<table style=...>` → `DataTable` with columns: Code, Customer, Status (`StatusBadge`), Amount (`CurrencyAmount`), Date
- Loading skeleton via `DataTable` `isLoading` prop
- Pagination → shadcn `Button` prev/next
- Empty state → `EmptyState` with "No orders yet" + filter clear CTA

**`CatalogPage.tsx`**
- Filter bar → `FilterBar` + `Input`
- Table → `DataTable`; CSV import section → `ConfirmDialog` (preview step inside dialog)
- Empty state → `EmptyState` with "Add your first product" CTA

**`StockPage.tsx`**
- Filter bar → `FilterBar` + `Input`
- Table rows: add progress bar (`<div>` bar, Tailwind width %) for available/reserved/sold
- Critical badge (`<Badge variant="destructive">`) on rows below threshold
- Empty state → `EmptyState`

**`UsersPage.tsx`**
- Search bar → `FilterBar` + `Input` + `Button`
- Table → `DataTable`; clickable rows preserved via `useNavigate`

**`SettingsPage.tsx`** (most complex page)
- Group settings fields into sections using `Card` containers:
  - General, Shop Info, Payment (crypto credentials), Telegram, Security (password + 2FA), Exchange Rates
- Each section: `Card` > `CardHeader` (section title) > `CardContent` (field rows)
- Inline `FieldRow` editing pattern preserved exactly — only wrapping CSS changes
- Payment method toggles → their own `Card` section
- 2FA flow (3 states) unchanged in logic

---

## Phase 3B — Operational Pages

Same pattern: preserve all state/logic/API, replace inline styles with Tailwind + shared components.

Pages: `PaymentsPage`, `VouchersPage`, `AdminsPage`, `BroadcastPage`, `SupportPage`, `OutboxPage`, `ReviewsPage`, `ReportsPage`, `AuditPage`, `SearchPage`, `BrandingPage`

Key notes:
- `ReportsPage` and `AuditPage` already use Tailwind — enhance cards/table polish only
- `OutboxPage` already uses Tailwind — minor consistency pass
- `BroadcastPage` schedule form: shadcn `Textarea`, `Select`, `Input` (datetime)
- `BrandingPage`: existing `ImageUploadRow`/`TextFieldRow` custom components kept; wrap in `Card` sections

---

## Phase 3C — Detail Pages + Auth/Setup Polish

**Detail pages**: `OrderDetailPage`, `UserDetailPage`, `ProductDetailPage`, `StockProductPage`, `TicketDetailPage`
- Replace inline style tables with `DataTable`
- Action buttons (Approve/Reject/Ban/etc.) → shadcn `Button` with variant (destructive/default)
- Replace `window.confirm()` → `ConfirmDialog` where present
- Replace `<p style={{color:'red'}}>` error states → inline `text-rust` class

**Auth pages** (`LoginPage`, `ForgotPage`, `ResetPage`, `BootstrapPage`):
- Already use Tailwind. Add a centered card layout (`Card` container, max-w-sm, centered on full-screen bg-paper)
- Keep all form logic and `publicPost` calls unchanged

**Setup pages** (`SetupBotPage`, `SetupOwnerPage`, `SetupShopPage`, `SetupDonePage`):
- Multi-step wizard: add a step indicator (progress dots or step number)
- Each step in a `Card` container, centered layout
- Logic unchanged

---

## File Change Summary

### New files (~10)
```
src/components/layout/ThemeProvider.tsx
src/components/layout/AppShell.tsx
src/components/layout/Sidebar.tsx
src/components/layout/TopBar.tsx
src/components/layout/SearchModal.tsx
src/components/shared/PageHeader.tsx
src/components/shared/DataTable.tsx
src/components/shared/FilterBar.tsx
src/components/shared/ConfirmDialog.tsx
src/components/shared/SkeletonRow.tsx
```

### shadcn additions (~10 components, auto-generated into `src/components/ui/`)
`button`, `input`, `select`, `dialog`, `skeleton`, `dropdown-menu`, `tooltip`, `separator`, `textarea`, `label`, `table`

### Modified files (~30)
- `src/App.tsx` — add AppShell layout route
- `src/components/shared/PageLayout.tsx` — simplify to thin wrapper
- `src/components/shared/EmptyState.tsx` — replace with richer version
- All pages in `src/pages/*.tsx` — styling only, logic untouched

---

## Verification

After each phase, run:
```bash
pnpm --filter @app/web-admin-client build    # must exit 0
pnpm typecheck                               # must exit 0
pnpm test                                    # vitest must stay green
```

Visual checks:
1. Open `http://127.0.0.1:8000` — sidebar visible, Dashboard inside shell
2. Ctrl+K → search modal opens
3. Theme toggle → dark mode applies to all tokens
4. Mobile viewport (375px) → sidebar hidden, hamburger shows it
5. Navigate to `/orders`, `/stock`, `/settings` — content renders, filters work
6. Check badge counters on sidebar nav items
