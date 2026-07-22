# 07 — Dashboard Guidelines

**Scope:** how `DashboardPage.tsx` and any future dashboard-style page are composed.
Grounded in the live `DashboardPage.tsx` (32 lines, read in full) and its child
components under `components/dashboard/`.

---

## 1. The three questions a dashboard answers

Every section on a dashboard exists to answer one of three questions, in this order
of priority:

```
What happened?          →  KPI numbers, revenue/orders totals, trends
      ↓
What requires attention? →  Operational queue counts, low-stock/expiring items
      ↓
What should I do next?   →  Quick actions, recent activity to act on
```

A section that answers none of these doesn't belong on a dashboard — it belongs on a
dedicated list/report page (see `04_CRUD_TEMPLATE.md`), linked to from a KPI card or
the sidebar instead.

## 2. Live composition (the canonical order)

```tsx
<PageHeader title="Dashboard" />
<div className="flex flex-col gap-6">
  <KpiRow />                                            {/* what happened */}
  <OperationCenter />                                    {/* what needs attention */}
  <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
    <InventoryMonitoringCard />                           {/* what needs attention */}
    <ExpirationsTable />                                  {/* what needs attention */}
  </div>
  <SalesAnalyticsCard />                                  {/* what happened, in detail */}
  <RecentOrdersTable />                                   {/* what to act on */}
  <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
    <BusinessHealthGrid />                                {/* what happened, in detail */}
    <TopProductsList />                                    {/* what happened, in detail */}
  </div>
</div>
```

Note: `PageHeader` is a sibling of the `gap-6` wrapper, **not** nested inside it —
see `02_ADMIN_LAYOUT.md` §5 for why that distinction matters (it's the exact bug
this page's spacing was fixed for).

Section order is: **KPI row → operational attention → supporting detail grids →
analytics → recent activity → more detail grids.** When adding a new dashboard
section, place it according to which of the three questions (§1) it answers, in that
priority order — don't append new sections to the bottom by default without
considering where they actually belong in the reading order.

## 3. KPI row

```tsx
export function KpiRow() {
  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
      <RevenueKpiCard />
      <ProfitKpiCard />
      <OrdersKpiCard />
      <PendingActionsKpiCard />
    </div>
  );
}
```

1/2/4-column responsive grid (`sm:grid-cols-2 lg:grid-cols-4`) — this is the
standard grid for any row of 4 KPI cards; use the same breakpoints for a new KPI
row rather than picking different ones.

### KPI card template

```tsx
<Card>
  <CardHeader><CardTitle>Orders Today</CardTitle></CardHeader>
  <CardContent>
    {isLoading && <p className="text-sm text-ink-soft">Loading…</p>}
    {isError && <p className="text-sm text-rust">Couldn't load orders.</p>}
    {data && (<>
      <p className="font-display text-3xl font-semibold text-ink">{data.orders.total}</p>
      <p className="mt-1 text-xs text-ink-soft">{data.orders.delivered} delivered · {data.orders.pending} pending · {data.orders.failed} failed</p>
    </>)}
  </CardContent>
</Card>
```

Rules for any new KPI card:
- `Card > CardHeader > CardTitle` + `CardContent`, no exceptions.
- Three explicit render branches: loading (`text-sm text-ink-soft`, "Loading…"),
  error (`text-sm text-rust`, "Couldn't load X."), data.
- The headline number is always `font-display text-3xl font-semibold text-ink`.
- A one-line breakdown/subtext directly under it, `mt-1 text-xs text-ink-soft`.
- Where a day-over-day comparison is meaningful, add `StatTrend` (green ↑ / red ↓,
  `03_COMPONENT_LIBRARY.md`) beneath the subtext — omit it if there's no
  historical baseline to compare against, rather than showing a fake/zero trend.
- **Share one query per row of related cards** where possible — all four KPI cards
  in `KpiRow` call the same `useDashboardKpis()` hook and each project a different
  slice of the response, rather than issuing four separate API calls. Follow this
  when a new KPI card's data overlaps with an existing one's endpoint.

## 4. Operational attention (`OperationCenter`)

A responsive grid (2/3/5 columns depending on width) of small `Card`s, each showing
a count + `UrgencyDot` (grass/amberx/rust/ink-faint severity dot,
`03_COMPONENT_LIBRARY.md`), optionally wrapped in a `Link` when the count is
actionable (clicking navigates to the filtered list that explains the number). Use
this pattern — count + severity dot + optional link-through — for any new
operational-queue indicator (e.g. "Awaiting Fulfillment: 4"), rather than a bespoke
alert banner.

## 5. Charts

`SalesAnalyticsCard.tsx` is the live `recharts` example. Chart rules
(`03_COMPONENT_LIBRARY.md` §Charts) apply in full here:
- **Never render a bare chart.** Every chart sits inside a `Card` with a `CardTitle`
  giving it context ("Sales, last 30 days"), and/or a summary number next to it.
- Colors always come from the design tokens (`grass`/`pine`/`amberx`/`rust`/`line`),
  never `recharts` defaults or hardcoded hex.
- Favor a chart type that reads at a glance (line/bar/area) over dense
  multi-series visualizations — a dashboard answers "what happened," not "give me
  every dimension of the data." Deeper analysis belongs on a dedicated Reports page,
  linked to from the dashboard if needed.

## 6. Recent activity

`RecentOrdersTable` is the "what should I do next" surface — a short, recent slice
of actionable rows. **It currently hand-rolls a raw `<table>` instead of using
`DataTable`** — this is documented tech debt (see `05_TABLE_GUIDELINES.md` §1), not a
pattern to copy for a new "recent X" table. Any new recent-activity table should use
`DataTable` (simple tier, no pagination — see `04_CRUD_TEMPLATE.md` §1) from the
start.

## 7. Quick actions

The **live** quick-actions surface is the `TopBar`'s `+` dropdown (Add Product, Add
Stock, Broadcast, Add Customer, Reports — see `02_ADMIN_LAYOUT.md` §3), not a
dashboard section. A `components/dashboard/QuickActionsBar.tsx` component previously
existed but was never rendered anywhere (orphaned/dead code) and has since been
removed (2026-07 consistency pass). Do not reference it as an available pattern. If
dashboard-level quick actions are wanted in the future, build a new component wired
into `DashboardPage.tsx`'s composition (per the same three-question ordering, likely
near the top) as a deliberate change — don't let a half-wired quick-actions surface
persist unused.

## 8. Business health / supporting detail grids

`InventoryMonitoringCard` + `ExpirationsTable`, and `BusinessHealthGrid` +
`TopProductsList`, are both laid out as a **2-column grid at `lg`+, stacked below
it**: `grid grid-cols-1 gap-4 lg:grid-cols-2`. Use this exact grid for any new pair
of related, roughly-equal-weight supporting cards — it's the established pattern for
"two related detail views side by side" on this dashboard.

## 9. Never do

- Never render a chart without a title/context.
- Never add a dashboard section that doesn't answer one of the three questions in §1
  — route it to a dedicated page instead.
- Never build a new "recent activity"-style table as a raw `<table>` — use
  `DataTable` from the start.
- Never assume a dashboard-only component is live without first checking whether
  it's actually rendered in `DashboardPage.tsx` — `QuickActionsBar.tsx` was exactly
  this kind of orphaned component before its removal (see §7).
- Never issue a separate API call per KPI card when the data already lives in a
  shared query response.
