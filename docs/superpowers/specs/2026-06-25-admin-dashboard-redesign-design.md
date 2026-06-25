# Shop Admin Dashboard Redesign — Design Spec

**Date:** 2026-06-25
**Status:** Design — approved, spec-only (no code yet)
**Supersedes:** `docs/superpowers/specs/2026-06-18-migrasi-nextjs-postgres-design.md`
and its four phase-plans (`docs/superpowers/plans/2026-06-18-fase{0,1,2,3}-*.md`).
That plan called for a full Next.js + Postgres + Auth.js rewrite of both
`web-admin` and `storefront`, gated on a SQLite→Postgres migration that was
approved but never started. This spec replaces it with a lighter,
single-process approach (below) that stays on SQLite and respects CLAUDE.md's
own single-writer rule instead of crossing it. The superseded docs are kept
for history, with their status headers updated to point here.

## Context

The current dashboard (`apps/web-admin/src/routes/dashboard.ts` +
`apps/web-admin/views/dashboard.njk`) leads with raw sales totals and renders
mixed-currency revenue as a single concatenated string via
`dual_currency_value()` in `packages/web-ui/views/_macros.njk` (e.g. "Rp137 +
20.25 USDT") — exactly the bug this brief flags. Operational signals that
actually need fast admin response (stuck verifications, failed deliveries,
underpaid orders, expiring warranties, low stock) are present in the route's
data (`dashboard.ts` already computes SLA context: stale orders >12h,
expiring payments <15m, warranty <3d) but are buried below sales cards
instead of leading the page.

This spec redesigns the dashboard's information architecture and visual
hierarchy, and scopes it as the **first page of a full admin-app migration
from Fastify+Nunjucks+HTMX to React+Tailwind+Shadcn**, establishing the
architecture pattern (auth, API layer, build tooling, component library) that
every other admin page will later follow.

Deliverable for this pass: **this written spec only**. No code changes yet —
implementation gets its own plan after this is reviewed.

## Scope & Rollout Strategy

The end goal is a full React rewrite of the admin app. That's a multi-month,
page-by-page effort (every existing page — products, orders, customers,
vouchers, settings, auth — has its own forms, CSRF flow, and HTMX
interactions to port). Rewriting all of it in one PR isn't realistic to
review or ship safely.

This spec treats the **Dashboard as the pilot page**: it gets a full,
concrete design here, *and* in doing so defines the shared architecture (API
conventions, auth/CSRF bridging, build pipeline, base component library) that
subsequent pages reuse. Each other page becomes its own future spec + plan,
following the pattern established here — not redesigned from scratch each
time.

**Non-goals of this spec:** detailed UI for products/orders/customers/
vouchers/settings pages. They keep rendering as Nunjucks+HTMX, completely
unaffected, until each gets its own migration spec.

## Architecture: React on the existing Fastify composition root

No second process. One Fastify server, as CLAUDE.md requires (the shared
SQLite DB is single-writer; the trigger to move to Postgres is ≥2 concurrent
writers — a second process with its own PrismaClient is exactly what this
spec avoids triggering):

```
Browser → GET /  (Fastify auth-checks the session, then serves the React SPA shell + JS bundle for this one route)
              │
Fastify (apps/server, single process)
  ├─ existing routes: unchanged, still render Nunjucks (every other page)
  └─ new: apps/web-admin/src/routes/api/dashboard.ts → JSON, reuses currentAdmin preHandler
              │
              ▼
   packages/db/src/crud/*  (same helpers other pages use — no parallel data layer)
```

- **Build tool:** Vite, new `apps/web-admin/client/` workspace package, builds
  to a static bundle Fastify already knows how to serve — `apps/web-admin/src/server.ts`
  registers `fastifyStatic` against `STATIC_DIR` (defaults to
  `apps/web-admin/static/`) at `/static/`.
- **Auth:** unchanged. `currentAdmin` (`apps/web-admin/src/plugins/auth.ts:82-88`)
  still runs server-side before the SPA shell is returned — an
  unauthenticated request never gets JS, it gets redirected to `/login`
  exactly like today. The SPA never implements its own auth.
- **CSRF:** the SPA shell embeds the existing CSRF token (`req.admin.csrf`,
  the same value `ui.csrf_field()` injects into forms today —
  `packages/web-ui/views/_macros.njk:5-7`) as `<meta name="csrf-token">`. A
  small `api/client.ts` fetch wrapper reads it and sends it as an
  `X-CSRF-Token` header on mutating requests. `csrfCheck`
  (`apps/web-admin/src/plugins/auth.ts:90-95`) currently only reads
  `req.body.csrf_token` — extend it to also accept the header (one shared
  check, two transports).
- **Styling:** real Tailwind build (PostCSS), not the CDN script
  `packages/web-ui/views/_theme.njk:14` uses today — Shadcn's CLI requires a
  real build. The existing token names (paper/card/sand/line/ink/pine/grass/
  amberx/rust, defined in `_theme.njk:21-31`) carry over into
  `client/tailwind.config.ts` so the React page looks native, not bolted-on.
- **Icons:** Lucide via `lucide-react` (today's pages load
  `unpkg.com/lucide@latest` and render `data-lucide` attributes — same icon
  set, just the React bindings).
- **Data fetching:** TanStack Query — direct replacement for the HTMX
  `hx-trigger="every 30s"` polling the SLA block already uses
  (`apps/web-admin/views/_sla.njk:5`), with the same refetch-interval
  semantics.

## Data Layer Findings (what exists vs. what's new)

| Area | Status | Source |
|---|---|---|
| Revenue by currency, today | exists | `revenueSummary()` / `revenueByDay()` in `packages/db/src/crud/reports.ts:132,159` — needs a thin "since = start of today" wrapper |
| Order status enum | exists | `packages/core/src/enums.ts`: `PENDING_PAYMENT, PAYMENT_DETECTED, CONFIRMING, CONFIRMED, PENDING_VERIFICATION, PAID, DELIVERED, CANCELLED, REJECTED, REFUNDED, UNDERPAID, FAILED` |
| Profit/margin | partial | `Denomination.costPrice` (nullable Decimal, `prisma/schema.prisma:173`) exists; no aggregation query yet |
| Failed deliveries / manual match queue | partial | `outcome` column on **five** tables: `ProcessedBinanceTx`, `ProcessedBybitTx`, `ProcessedTokopayTx`, `ProcessedPaydisiniTx`, `ProcessedNowpaymentsTx` (`prisma/schema.prisma:578-651`) — values `matched`/`underpaid`/`unmatched`/`delivery_failed`/`credited_to_balance`/`stale` — needs one query unioning all five. (`processedTxOutcomeCounts()` in `binance_internal.ts:311` already does this for the dashboard's existing Binance-only banner — generalize it.) |
| Underpaid orders | exists | `Order.status = UNDERPAID` |
| Low stock | exists | `lowStockDenominations(db, threshold)` in `packages/db/src/crud/catalog.ts:355` |
| Warranty expiration | exists, unused on dashboard's main view | `listOrderItemsExpiringWarranty(db, start, end)` in `reports.ts:264` — computed from `deliveredAt + warrantyDaysSnapshot`; currently only feeds the `_sla.njk` HTMX fragment, not a dedicated card |
| Provider health | partial | Only `getBinancePollHealth()`/`recordBinancePollHealth()` (`binance_internal.ts:498,524`, stored in `Setting`) — nothing for Telegram bot, Bybit, TokoPay, Paydisini, NOWPayments, or blockchain pollers |
| Top products | exists | `topProducts(db, limit)` in `reports.ts:200` |
| FX / currency formatting | partial | `packages/core/src/fx.ts` (live rate fetch), `Order.fxRate` (per-order snapshot, `schema.prisma:237`), `packages/core/src/money.ts` (`fmtMoney`) — no "normalize many orders to one display currency" aggregator |
| Charting | none | Current SVG sparkline on `reports.njk` is hand-rolled (`<polyline>`, no library) |

## Design Decisions Carried From Earlier Answers

- **USD card:** USDT revenue is displayed under both a "USDT" stat and a "USD"
  stat (1 USDT ≈ $1, same underlying number, two labels).
- **Provider health & refund requests:** built from heuristics on existing
  data now, not stubbed, not a new workflow model.
- **"Refund requests" redefinition:** there's no refund-request workflow in
  this codebase — refunds today are ad-hoc wallet credits. The closest real
  "pending decision" queue is **underpaid orders** (`Order.status =
  UNDERPAID`): customer paid the wrong amount, admin must decide
  refund/top-up/credit. The Pending Actions and Operation Center cards use
  this, not historical REFUNDED orders (already happened — not "pending").
- **"Manual approvals" vs. "Orders to review" — disambiguated**: "Orders to
  review" = `PENDING_VERIFICATION` count (payment proof submitted, awaiting
  confirmation). "Manual approvals" = `unmatched` outcome rows across the
  **five** processed-tx tables (payment received, couldn't auto-match to any
  order). Both the KPI card and Operation Center read the same underlying
  counts — single source of truth.
- **"Stock Sync Status"** doesn't map to anything in this codebase — there's
  no external stock feed; stock is added manually or via CSV bulk import
  (CLAUDE.md flags bulk/CSV as a risk surface already). Drop this tile for
  v1 rather than fabricating a status with no real signal.
- **Telegram Bot Status** reuses the existing "bot token missing" flag
  `dashboard.ts` already computes (`creds.botToken === null`) — Red if
  missing, Green if present (no granular Yellow state yet).
- **Payment Gateway / Blockchain Status:** Binance gets a real
  Green/Yellow/Red from `getBinancePollHealth()` (`lastSuccessAt`,
  `consecutiveFailures`, `backoffUntil`). **Bybit, TokoPay, Paydisini, and
  NOWPayments** have no health tracker, so rather than fake confidence, all
  four show a neutral **Gray "Unmonitored"** state until each gets its own
  health tracker (future work, not this spec).

## 1. New Dashboard Layout Structure

Reordered so actionable/urgent content sits above exploratory analytics:

```
1. Sticky header: page title + Quick Actions bar
2. KPI Row              (Revenue / Profit / Orders / Pending Actions)
3. Operation Center     (5 clickable status cards — urgent, actionable)
4. Alerts row            Inventory Monitoring | Upcoming Expirations
5. Sales Analytics      (chart — exploratory, now below the fold by design)
6. Recent Orders table
7. Insights row          Business Health grid | Top Products
```

By the time an admin scrolls past #4, every "something is on fire" signal has
already been seen. Sales Analytics is valuable but not urgent.

## 2. Component Hierarchy

```
<DashboardPage>
  <QuickActionsBar />                      sticky, collapses to bottom bar on mobile
  <KpiRow>
    <RevenueKpiCard /> <ProfitKpiCard /> <OrdersKpiCard /> <PendingActionsKpiCard />
  </KpiRow>
  <OperationCenter>
    <OpCard kind="pendingPayments" /> <OpCard kind="manualReviews" />
    <OpCard kind="failedDeliveries" /> <OpCard kind="ordersProcessing" />
    <OpCard kind="expiredPayments" />
  </OperationCenter>
  <AlertsRow>
    <InventoryMonitoringCard />
    <ExpirationsTable />
  </AlertsRow>
  <SalesAnalyticsCard>
    <ChartFilters />                       range / currency / metric
    <RevenueChart />                       Recharts
  </SalesAnalyticsCard>
  <RecentOrdersTable />
  <InsightsRow>
    <BusinessHealthGrid />
    <TopProductsList />
  </InsightsRow>
</DashboardPage>
```

Shared primitives (reused across every card/table above, and later by other
migrated pages): `<CurrencyAmount currency value />`, `<StatusBadge status
/>`, `<StatTrend direction pct />`, `<UrgencyDot level />`, `<DataTable
columns rows />`, `<EmptyState />`.

Data hooks (TanStack Query, one per API endpoint): `useDashboardKpis`,
`useOperationCenter`, `useSalesAnalytics(range, currency, metric)`,
`useRecentOrders`, `useInventoryAlerts`, `useExpirations`,
`useBusinessHealth`, `useTopProducts`.

## 3. Wireframe Description

**Desktop (≥1280px) — 12-col grid:**
```
┌─────────────────────────────────────────────────────────────┐
│ Shop Admin            [+Order][+Product][+Stock][Broadcast]…│ sticky header
├───────────┬───────────┬───────────┬─────────────────────────┤
│ Revenue   │ Profit    │ Orders    │ Pending Actions         │ 4 KPI cards, 3-col each
│ Today     │ Today     │ Today     │                         │
├───────────┴───────────┴───────────┴─────────────────────────┤
│ Pending  │ Manual   │ Failed    │ Orders    │ Expired       │ 5 Op-Center cards
│ Payments │ Reviews  │ Deliveries│ Processing│ Payments      │
├──────────────────────────────┬────────────────────────────────┤
│ Critical Stock (list)         │ Upcoming Expirations (table)  │
├──────────────────────────────┴────────────────────────────────┤
│ Sales Analytics  [7d|30d] [IDR|USDT|USD|Combined] [Rev|Orders]│
│  ▂▃▅▇▆▄▃▅▇█▆▅▃▂▃▅▇  (Recharts)                                │
├─────────────────────────────────────────────────────────────┤
│ Recent Orders (table, 10 rows)                                │
├──────────────────────────────┬────────────────────────────────┤
│ Business Health (status grid) │ Top Products (top 5 list)     │
└──────────────────────────────┴────────────────────────────────┘
```

**Tablet (640–1279px):** KPI row → 2-col; Op-Center → 2-col (one card wraps
to its own row); Alerts row and Insights row stack vertically; chart and
table stay full width.

**Mobile (<640px):** Everything single column. KPI cards stack with
revenue's 3 currency lines visible without truncation (this is the layout
most at risk of recreating the "Rp137 + 20.25 USDT" bug if currency rows
aren't stacked deliberately — see `CurrencyAmount` below). Sales Analytics
chart scrolls horizontally inside its card rather than squishing. Recent
Orders and Expirations tables collapse to stacked "card per row" layout
instead of horizontal scroll. Quick Actions becomes a sticky bottom bar with
icon-only buttons + overflow menu.

## 4. UX Improvements (beyond the brief)

- **Single source of truth for counts.** Operation Center and the Pending
  Actions KPI card read the *same* queries (see Design Decisions above) so an
  admin never sees "3 manual reviews" in one card and "5" in another.
- **Every Operation Center / Alerts card is a filtered link**, not a
  dead-end number — clicking "Failed Deliveries" opens the existing
  orders/transactions list pre-filtered, reusing existing admin pages.
- **Honest "Unmonitored" state** for Business Health instead of fabricating
  Green for providers with no real health signal — false-green is worse than
  no status.
- **Null-cost products show "N/A margin," not "$0 profit."**
  `Denomination.costPrice` is nullable; treating missing cost as zero would
  inflate displayed margin. Profit KPI excludes items with unset cost from
  the margin % and flags how many were excluded.
- **Trend vs. yesterday uses same-time-of-day comparison**, not
  full-yesterday-vs-partial-today, so the trend arrow isn't structurally
  pessimistic at 9am.
- **Stacked currency rows, never inline concatenation** — the actual fix for
  the bug that started this. See `CurrencyAmount` below.

## 5. Responsive Strategy

| Breakpoint | KPI row | Op-Center | Alerts/Insights rows | Table behavior | Quick Actions |
|---|---|---|---|---|---|
| Desktop ≥1280px | 4 cols | 5 cols (wraps to 3+2) | side-by-side | full table | sticky top bar |
| Tablet 640–1279px | 2 cols | 2–3 cols | stacked | full table, horizontal scroll if needed | sticky top bar |
| Mobile <640px | 1 col | 1 col | stacked | card-per-row | sticky bottom bar, icon+label collapses to icon-only |

Chart container uses `overflow-x-auto` with a min-width inner canvas on
mobile rather than compressing data points.

## 6. Database / API Requirements

**New `packages/db/src/crud` functions** (each gets a colocated Vitest per
CLAUDE.md convention):

- `todayKpis(db)` — thin wrapper composing existing `revenueSummary`/
  `ordersByStatus` with a start-of-day (admin `TIMEZONE`) cutoff
- `profitToday(db)` / `topProductsByMargin(db, days, limit)` — uses
  `Denomination.costPrice`, excludes/flags null-cost items
- `manualMatchQueueCounts(db)` — unions `outcome` across **all five**
  `processed_*_tx` tables into `{ unmatched, deliveryFailed }` (generalizes
  the existing Binance-only `processedTxOutcomeCounts()`)
- `underpaidOrdersCount(db)`
- `ordersByDay(db, range, currency)` — count per day per currency/status,
  parallel to existing `revenueByDay`
- `combinedRevenueByDay(db, range)` — normalizes each order to
  USDT-equivalent using that order's *own* snapshot `Order.fxRate` (not a
  live rate), so the "Combined" chart reflects actual settlement value

**New route file** `apps/web-admin/src/routes/api/dashboard.ts` (JSON,
guarded by existing `currentAdmin` preHandler):

```
GET /api/dashboard/kpis
GET /api/dashboard/operations
GET /api/dashboard/inventory?threshold=
GET /api/dashboard/expirations?withinDays=
GET /api/dashboard/orders/recent?limit=
GET /api/dashboard/health
GET /api/dashboard/top-products?days=&limit=
GET /api/dashboard/analytics?range=7d|30d&currency=idr|usdt|usd|combined&metric=revenue|orders
```

All money values come back as **pre-formatted display strings** (server does
the Decimal math, per CLAUDE.md "Decimal for all money, never float") plus a
raw numeric field for chart plotting — the browser never re-implements money
formatting or fx math.

## 7. Example React + Tailwind Component Architecture

```
apps/web-admin/client/
  index.html
  vite.config.ts
  tailwind.config.ts            # real build; token names ported from _theme.njk
  src/
    main.tsx
    App.tsx
    api/
      client.ts                 # fetch wrapper: credentials include + X-CSRF-Token header
      types.ts
    hooks/
      useDashboardKpis.ts ...   # one per endpoint, TanStack Query
    components/
      ui/                       # shadcn-generated primitives (card, badge, table, tabs)
      dashboard/
        KpiRow.tsx  RevenueKpiCard.tsx  ProfitKpiCard.tsx  OrdersKpiCard.tsx
        PendingActionsKpiCard.tsx  OperationCenter.tsx  OpCard.tsx
        InventoryMonitoringCard.tsx  ExpirationsTable.tsx
        SalesAnalyticsCard.tsx  RevenueChart.tsx  RecentOrdersTable.tsx
        BusinessHealthGrid.tsx  TopProductsList.tsx  QuickActionsBar.tsx
      shared/
        CurrencyAmount.tsx  StatusBadge.tsx  StatTrend.tsx  UrgencyDot.tsx
        DataTable.tsx  EmptyState.tsx
```

The component that directly fixes the reported bug — values are always
rendered as separate stacked rows, never joined into one string:

```tsx
// shared/CurrencyAmount.tsx
type CurrencyAmount = { currency: "IDR" | "USDT" | "USD"; display: string };

export function CurrencyStack({ amounts }: { amounts: CurrencyAmount[] }) {
  return (
    <div className="flex flex-col gap-0.5">
      {amounts.map(a => (
        <div key={a.currency} className="flex items-baseline gap-1.5">
          <span className="text-xs font-medium text-ink-muted w-12">{a.currency}</span>
          <span className="font-mono text-sm">{a.display}</span>
        </div>
      ))}
    </div>
  );
}
```

```tsx
// dashboard/RevenueKpiCard.tsx
export function RevenueKpiCard() {
  const { data, isLoading } = useDashboardKpis();
  if (isLoading) return <KpiCardSkeleton />;
  return (
    <Card>
      <CardHeader>Revenue Today</CardHeader>
      <CardContent>
        <CurrencyStack amounts={data.revenue.byCurrency} />
        <StatTrend direction={data.revenue.trendDirection} pct={data.revenue.trendPct} />
      </CardContent>
    </Card>
  );
}
```

## Testing Strategy

- New crud functions: colocated Vitest (`*.test.ts`) per CLAUDE.md, covering
  the null-cost-margin edge case and the five-table outcome union.
- New API routes: happy/auth-fail/bad-csrf trio per CLAUDE.md web-routes
  convention (CSRF case applies to any mutating endpoint added later, e.g.
  inventory refill).
- React components: not covered by this spec — testing approach (RTL/Vitest
  component tests vs. none for v1) is a decision for the implementation
  plan, since it depends on how much interactivity ships in phase 1 vs.
  later.

## Verification (for the eventual implementation, not this spec)

- `pnpm typecheck` and `pnpm test` stay green with the new crud functions and
  route trio.
- Manually load `/` as an admin: confirm no currency string ever
  concatenates two currencies inline, confirm Operation Center counts match
  Pending Actions KPI counts exactly, confirm mobile breakpoint stacks KPI
  cards 1-per-row with full currency rows visible (no truncation).
