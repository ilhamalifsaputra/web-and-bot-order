# Dashboard Remaining Sections Implementation Plan (Phase 3)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the remaining 7 dashboard sections (Profit/Orders/Pending-Actions KPI cards, Operation Center, Inventory Monitoring, Expirations, Sales Analytics chart, Recent Orders, Business Health, Top Products) plus the Quick Actions bar in the React dashboard SPA, wiring each to its already-merged `/api/dashboard/*` endpoint, then retire the now-orphaned Nunjucks SLA route.

**Architecture:** Each section is a self-contained vertical slice: a TypeScript response type added to `apps/web-admin/client/src/api/types.ts`, a one-line TanStack Query hook in `src/hooks/`, and a presentational component in `src/components/dashboard/` that consumes it — following the exact pattern the Phase-2 `RevenueKpiCard` + `useDashboardKpis` already established. A handful of shared primitives (`StatTrend`, `StatusBadge`, `UrgencyDot`, `EmptyState`) come first since many sections reuse them. The final task assembles everything into `App.tsx`'s responsive grid and rebuilds the client.

**Tech Stack:** React 18, TypeScript, TanStack Query 5, Tailwind v4 (CSS-first), shadcn/ui Card, lucide-react, Recharts (new — for the analytics chart), Vitest + @testing-library/react + jsdom.

## Context

This is the third and final phase of the dashboard redesign (design spec: `docs/superpowers/specs/2026-06-25-admin-dashboard-redesign-design.md`, PR #22). Phase 1 (merged) built all 8 `/api/dashboard/*` JSON endpoints. Phase 2 (merged) stood up the React SPA at `GET /` with the build pipeline, CSRF/auth bridging, the shared `CurrencyStack`/`formatCurrencyDisplay` primitives, TanStack Query, and one proof-of-architecture section (the Revenue KPI card). This phase fills in the remaining 7 sections so the dashboard the admin actually sees is complete — every section is a thin vertical slice over an endpoint that already exists and is already tested, so the work is mechanical and low-risk. The reordered information architecture (urgent/operational content above exploratory analytics) is the whole point of the redesign; assembling it (Task 11) is where that hierarchy lands. The final task removes the last dead Nunjucks remnant the cutover left behind.

## Global Constraints

- **Never render two currencies as one joined string** — the literal bug this whole project fixes. Always use `CurrencyStack` (`apps/web-admin/client/src/components/shared/CurrencyAmount.tsx`) which renders one row per currency; never build a template literal that concatenates two currency displays.
- **No money arithmetic or fx conversion in the browser** — every endpoint already returns final, server-computed strings (e.g. `"10000"`, `"20.25"`, `revenueIdrEquiv: "108880"`). The frontend only formats for display via the existing `formatCurrencyDisplay(value, currency)` — no rounding, no fx, no `Number()` math beyond what that helper already does.
- **Single source of truth for counts** — the Profit/Orders/Pending-Actions KPI cards consume the SAME `useDashboardKpis()` hook `RevenueKpiCard` already uses (the `/kpis` endpoint already returns `profit`, `orders`, `pendingActions`); they do NOT introduce a parallel count source. The Operation Center's `manualReviews`/`failedDeliveries` come from `/operations`, which the backend already guarantees draws from the same crud functions as `/kpis`'s `pendingActions` (verified in the Phase-1 backend review) — do not recompute.
- **Honest "Unmonitored" state** — Business Health renders the backend's literal `"unmonitored"` status as a neutral gray dot; never fabricate green for a provider the backend reports as unmonitored.
- **Auth/serving unchanged** — this plan adds zero backend routes except deleting one orphaned route in the final task; the SPA is still served by the existing `spaShell.ts` route under `currentAdmin`. No new endpoint, no auth change.
- **Every client test file that uses a jest-dom matcher** (`.toBeInTheDocument()` etc.) must start with `import "@testing-library/jest-dom";` — there is no global setup file providing it (established in Phase 2; see `vitest.config.ts`'s `globals: true` comment).
- **The dashboard is a built artifact** — after any change under `apps/web-admin/client/`, run `pnpm --filter @app/web-admin-client build` before the `spaShell` route serves the new bundle (documented in CLAUDE.md).
- **`pnpm typecheck` and `pnpm test` must stay green** after every task (modulo the 2 known-pre-existing `notifications.test.ts` `enqueueOrderPipelineFailed` failures, unrelated to this work).

---

## Backend response shapes (already merged — the contract every hook/type mirrors)

From `apps/web-admin/src/routes/api/dashboard.ts` (read it if in doubt — do not change it):

- `GET /api/dashboard/kpis` → `DashboardKpis` (already typed in `types.ts`): `revenue`, `profit: { idr: CurrencyProfit|null, usdt: CurrencyProfit|null }`, `orders: { total, delivered, pending, failed }`, `pendingActions: { toReview, refundDecisions, failedDeliveries, manualApprovals }`.
- `GET /api/dashboard/operations` → `{ pendingPayments: number; manualReviews: number; failedDeliveries: number; ordersProcessing: number; expiredPayments: number }`
- `GET /api/dashboard/inventory?threshold=` → `Array<{ denominationId: number; productName: string; available: number; threshold: number }>`
- `GET /api/dashboard/expirations?withinDays=` → `Array<{ orderId: number; orderCode: string; productName: string; customerLabel: string; remainingDays: number }>`
- `GET /api/dashboard/orders/recent?limit=` → `Array<{ orderId: number; orderCode: string; productLabel: string; customerLabel: string; amount: string; currency: string; status: string; createdAt: string }>`
- `GET /api/dashboard/health` → `{ telegramBot: string; binance: string; bybit: string; tokopay: string; paydisini: string; nowpayments: string }` (values: `"green" | "yellow" | "red" | "unmonitored"`)
- `GET /api/dashboard/top-products?days=&limit=` → `Array<{ productId: number; name: string; unitsSold: number; revenueIdrEquiv: string; profitIdrEquiv: string | null; costUnknownUnits: number }>`
- `GET /api/dashboard/analytics?range=7d|30d&currency=idr|usdt|combined&metric=revenue|orders` → `Array<{ day: string; value: string | number }>`

---

## File Structure

- `apps/web-admin/client/src/api/types.ts` — add one response interface per remaining endpoint (each task adds its own).
- `apps/web-admin/client/src/hooks/use*.ts` — one tiny TanStack Query hook per endpoint (`useOperations`, `useInventory`, `useExpirations`, `useRecentOrders`, `useHealth`, `useTopProducts`, `useAnalytics`).
- `apps/web-admin/client/src/components/shared/` — new cross-cutting primitives: `StatTrend.tsx`, `StatusBadge.tsx`, `UrgencyDot.tsx`, `EmptyState.tsx`.
- `apps/web-admin/client/src/components/dashboard/` — one component (or small cluster) per section, plus `KpiRow.tsx`.
- `apps/web-admin/client/src/App.tsx` — final assembly into the responsive grid.
- `apps/web-admin/client/package.json` — add `recharts` (Task 9 only).
- `apps/web-admin/src/routes/dashboard.ts`, `apps/web-admin/views/_sla.njk`, `apps/web-admin/test/web.test.ts` — cleanup (Task 12 only).

Every component test file lives beside its component as `*.test.tsx`. Follow the exact mock pattern from the existing `apps/web-admin/client/src/components/dashboard/RevenueKpiCard.test.tsx` (stub global `fetch`, wrap in a fresh `QueryClientProvider`) and `apps/web-admin/client/src/hooks/useDashboardKpis.test.tsx`.

---

### Task 1: Shared presentational primitives (StatTrend, StatusBadge, UrgencyDot, EmptyState)

**Files:**
- Create: `apps/web-admin/client/src/components/shared/StatTrend.tsx` + `StatTrend.test.tsx`
- Create: `apps/web-admin/client/src/components/shared/StatusBadge.tsx` + `StatusBadge.test.tsx`
- Create: `apps/web-admin/client/src/components/shared/UrgencyDot.tsx` + `UrgencyDot.test.tsx`
- Create: `apps/web-admin/client/src/components/shared/EmptyState.tsx` + `EmptyState.test.tsx`

**Interfaces:**
- Produces:
  - `StatTrend({ pct }: { pct: string | null })` — renders an up/down arrow + the percentage; green (`text-grass`) when ≥0, red (`text-rust`) when <0; renders nothing (returns `null`) when `pct` is `null`.
  - `StatusBadge({ status }: { status: string })` — a colored chip mapping a raw order status to a tone (green/amber/red/neutral) and a Title-Case label.
  - `UrgencyDot({ level }: { level: "ok" | "warn" | "critical" | "idle" })` — a small colored dot (grass/amberx/rust/ink-faint).
  - `EmptyState({ message }: { message: string })` — a muted centered line.

- [ ] **Step 1: Write the failing StatTrend test**

Create `apps/web-admin/client/src/components/shared/StatTrend.test.tsx`:

```tsx
import "@testing-library/jest-dom";
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { StatTrend } from "./StatTrend";

describe("StatTrend", () => {
  it("renders a positive percentage in the up-trend color", () => {
    const { container } = render(<StatTrend pct="12.3" />);
    expect(screen.getByText(/12\.3%/)).toBeInTheDocument();
    expect(container.querySelector(".text-grass")).not.toBeNull();
  });

  it("renders a negative percentage in the down-trend color", () => {
    const { container } = render(<StatTrend pct="-4.5" />);
    expect(screen.getByText(/-4\.5%/)).toBeInTheDocument();
    expect(container.querySelector(".text-rust")).not.toBeNull();
  });

  it("renders nothing when pct is null", () => {
    const { container } = render(<StatTrend pct={null} />);
    expect(container).toBeEmptyDOMElement();
  });
});
```

- [ ] **Step 2: Run it (fails — module missing)**

Run: `pnpm vitest run apps/web-admin/client/src/components/shared/StatTrend.test.tsx`
Expected: FAIL — cannot resolve `./StatTrend`.

- [ ] **Step 3: Implement StatTrend**

Create `apps/web-admin/client/src/components/shared/StatTrend.tsx`:

```tsx
import { TrendingDown, TrendingUp } from "lucide-react";

export function StatTrend({ pct }: { pct: string | null }) {
  if (pct === null) return null;
  const n = Number(pct);
  const up = n >= 0;
  const Icon = up ? TrendingUp : TrendingDown;
  return (
    <span className={`inline-flex items-center gap-1 text-xs font-medium ${up ? "text-grass" : "text-rust"}`}>
      <Icon className="h-3.5 w-3.5" />
      {pct}% vs yesterday
    </span>
  );
}
```

- [ ] **Step 4: Run it (passes)**

Run: `pnpm vitest run apps/web-admin/client/src/components/shared/StatTrend.test.tsx`
Expected: PASS (3 tests).

- [ ] **Step 5: Write the failing StatusBadge test**

Create `apps/web-admin/client/src/components/shared/StatusBadge.test.tsx`:

```tsx
import "@testing-library/jest-dom";
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { StatusBadge } from "./StatusBadge";

describe("StatusBadge", () => {
  it("renders a Title-Case label for a raw status", () => {
    render(<StatusBadge status="PENDING_VERIFICATION" />);
    expect(screen.getByText("Pending Verification")).toBeInTheDocument();
  });

  it("uses the green tone for a delivered order", () => {
    const { container } = render(<StatusBadge status="DELIVERED" />);
    expect(container.querySelector(".bg-grass-tint")).not.toBeNull();
  });

  it("uses the red tone for a failed order", () => {
    const { container } = render(<StatusBadge status="FAILED" />);
    expect(container.querySelector(".bg-rust-tint")).not.toBeNull();
  });
});
```

- [ ] **Step 6: Run it (fails)**

Run: `pnpm vitest run apps/web-admin/client/src/components/shared/StatusBadge.test.tsx`
Expected: FAIL — module missing.

- [ ] **Step 7: Implement StatusBadge**

Create `apps/web-admin/client/src/components/shared/StatusBadge.tsx`. The tone map mirrors the existing Nunjucks `status_badge` grouping (delivered/paid = success; the pending-ish states = warning; cancelled/rejected/failed = danger; refunded = neutral):

```tsx
type Tone = "success" | "warning" | "danger" | "neutral";

const TONE: Record<string, Tone> = {
  DELIVERED: "success",
  PAID: "success",
  PENDING_PAYMENT: "warning",
  PAYMENT_DETECTED: "warning",
  CONFIRMING: "warning",
  CONFIRMED: "warning",
  PENDING_VERIFICATION: "warning",
  UNDERPAID: "warning",
  CANCELLED: "danger",
  REJECTED: "danger",
  FAILED: "danger",
  REFUNDED: "neutral",
};

const TONE_CLASS: Record<Tone, string> = {
  success: "bg-grass-tint text-grass-dark",
  warning: "bg-amberx-tint text-amberx",
  danger: "bg-rust-tint text-rust-dark",
  neutral: "bg-sand text-ink-soft",
};

function titleCase(status: string): string {
  return status
    .toLowerCase()
    .split("_")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

export function StatusBadge({ status }: { status: string }) {
  const tone = TONE[status] ?? "neutral";
  return (
    <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-semibold ${TONE_CLASS[tone]}`}>
      {titleCase(status)}
    </span>
  );
}
```

NOTE: the `-tint`/`-dark` color tokens (`grass-tint`, `grass-dark`, `amberx-tint`, `rust-tint`, `rust-dark`, `sand`, `ink-soft`) are all defined in `apps/web-admin/client/src/index.css`'s ported `@theme static` block (verify by grepping `index.css` for `--color-grass-tint` before relying on them; they were ported from `_theme.njk` in Phase 2). If any one is missing, add it to that block from the corresponding `_theme.njk` value rather than substituting a shadcn token.

- [ ] **Step 8: Run it (passes)**

Run: `pnpm vitest run apps/web-admin/client/src/components/shared/StatusBadge.test.tsx`
Expected: PASS (3 tests).

- [ ] **Step 9: Write the failing UrgencyDot test**

Create `apps/web-admin/client/src/components/shared/UrgencyDot.test.tsx`:

```tsx
import "@testing-library/jest-dom";
import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { UrgencyDot } from "./UrgencyDot";

describe("UrgencyDot", () => {
  it("uses the critical color for level=critical", () => {
    const { container } = render(<UrgencyDot level="critical" />);
    expect(container.querySelector(".bg-rust")).not.toBeNull();
  });

  it("uses the idle color for level=idle", () => {
    const { container } = render(<UrgencyDot level="idle" />);
    expect(container.querySelector(".bg-ink-faint")).not.toBeNull();
  });
});
```

- [ ] **Step 10: Run it (fails), then implement UrgencyDot**

Run: `pnpm vitest run apps/web-admin/client/src/components/shared/UrgencyDot.test.tsx` → FAIL (module missing).

Create `apps/web-admin/client/src/components/shared/UrgencyDot.tsx`:

```tsx
const COLOR: Record<"ok" | "warn" | "critical" | "idle", string> = {
  ok: "bg-grass",
  warn: "bg-amberx",
  critical: "bg-rust",
  idle: "bg-ink-faint",
};

export function UrgencyDot({ level }: { level: "ok" | "warn" | "critical" | "idle" }) {
  return <span className={`inline-block h-2.5 w-2.5 rounded-full ${COLOR[level]}`} aria-hidden="true" />;
}
```

Run again → PASS (2 tests).

- [ ] **Step 11: Write the failing EmptyState test, then implement it**

Create `apps/web-admin/client/src/components/shared/EmptyState.test.tsx`:

```tsx
import "@testing-library/jest-dom";
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { EmptyState } from "./EmptyState";

describe("EmptyState", () => {
  it("renders the given message", () => {
    render(<EmptyState message="Nothing to review." />);
    expect(screen.getByText("Nothing to review.")).toBeInTheDocument();
  });
});
```

Run → FAIL. Create `apps/web-admin/client/src/components/shared/EmptyState.tsx`:

```tsx
export function EmptyState({ message }: { message: string }) {
  return <p className="py-6 text-center text-sm text-ink-faint">{message}</p>;
}
```

Run → PASS.

- [ ] **Step 12: Run all four primitive test files together, then commit**

Run: `pnpm vitest run apps/web-admin/client/src/components/shared`
Expected: PASS (existing `CurrencyAmount.test.tsx` + the 4 new files).

```bash
git add apps/web-admin/client/src/components/shared
git commit -m "feat(web-admin): add StatTrend, StatusBadge, UrgencyDot, EmptyState primitives"
```

---

### Task 2: Complete the KPI row (Profit, Orders, Pending Actions cards + KpiRow)

**Files:**
- Create: `apps/web-admin/client/src/components/dashboard/ProfitKpiCard.tsx` + `.test.tsx`
- Create: `apps/web-admin/client/src/components/dashboard/OrdersKpiCard.tsx` + `.test.tsx`
- Create: `apps/web-admin/client/src/components/dashboard/PendingActionsKpiCard.tsx` + `.test.tsx`
- Modify: `apps/web-admin/client/src/components/dashboard/RevenueKpiCard.tsx` + `.test.tsx` — wire in the `StatTrend` line (Step 4b)
- Create: `apps/web-admin/client/src/components/dashboard/KpiRow.tsx`

**Interfaces:**
- Consumes: `useDashboardKpis` (`../../hooks/useDashboardKpis`), the existing `RevenueKpiCard`, `Card`/`CardHeader`/`CardTitle`/`CardContent` (`../ui/card`), `StatTrend`/`EmptyState` (Task 1), `CurrencyStack` (`../shared/CurrencyAmount`).
- Produces: `ProfitKpiCard`, `OrdersKpiCard`, `PendingActionsKpiCard`, and `KpiRow` (renders all four KPI cards in a responsive 1/2/4-col grid).

All three cards reuse `useDashboardKpis()` — the SAME hook `RevenueKpiCard` uses — so the four KPI cards never disagree (single source of truth).

- [ ] **Step 1: Write the failing ProfitKpiCard test**

Create `apps/web-admin/client/src/components/dashboard/ProfitKpiCard.test.tsx`:

```tsx
import "@testing-library/jest-dom";
import { describe, it, expect, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ProfitKpiCard } from "./ProfitKpiCard";

function renderWithKpis(profit: unknown) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({
      ok: true,
      json: async () => ({
        revenue: { idr: null, usdt: null, usd: null, trendPct: { idr: null, usdt: null } },
        profit,
        orders: { total: 0, delivered: 0, pending: 0, failed: 0 },
        pendingActions: { toReview: 0, refundDecisions: 0, failedDeliveries: 0, manualApprovals: 0 },
      }),
    })),
  );
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <ProfitKpiCard />
    </QueryClientProvider>,
  );
}

describe("ProfitKpiCard", () => {
  it("shows net profit and margin% per currency, never blended", async () => {
    renderWithKpis({
      idr: { netProfit: "8000", marginPct: "40", excludedItemCount: 0 },
      usdt: { netProfit: "8", marginPct: "80", excludedItemCount: 0 },
    });
    await waitFor(() => expect(screen.getByText("Rp8.000")).toBeInTheDocument());
    expect(screen.getByText("8.00 USDT")).toBeInTheDocument();
    expect(screen.getByText(/40% margin/)).toBeInTheDocument();
    expect(screen.getByText(/80% margin/)).toBeInTheDocument();
  });

  it("flags excluded (cost-unknown) items instead of showing a fake margin", async () => {
    renderWithKpis({ idr: { netProfit: "0", marginPct: null, excludedItemCount: 3 }, usdt: null });
    await waitFor(() => expect(screen.getByText(/3 items? without a cost price/i)).toBeInTheDocument());
  });

  it("shows an empty state when there is no profit data", async () => {
    renderWithKpis({ idr: null, usdt: null });
    await waitFor(() => expect(screen.getByText(/no profit yet/i)).toBeInTheDocument());
  });
});
```

- [ ] **Step 2: Run it (fails), then implement ProfitKpiCard**

Run: `pnpm vitest run apps/web-admin/client/src/components/dashboard/ProfitKpiCard.test.tsx` → FAIL.

Create `apps/web-admin/client/src/components/dashboard/ProfitKpiCard.tsx`:

```tsx
import { Card, CardContent, CardHeader, CardTitle } from "../ui/card";
import { CurrencyStack, type CurrencyAmount } from "../shared/CurrencyAmount";
import { useDashboardKpis } from "../../hooks/useDashboardKpis";
import type { CurrencyProfit } from "../../api/types";

function marginLine(label: string, p: CurrencyProfit) {
  const parts: string[] = [];
  if (p.marginPct !== null) parts.push(`${p.marginPct}% margin`);
  if (p.excludedItemCount > 0)
    parts.push(`${p.excludedItemCount} item${p.excludedItemCount === 1 ? "" : "s"} without a cost price`);
  return parts.length ? `${label}: ${parts.join(" · ")}` : null;
}

export function ProfitKpiCard() {
  const { data, isLoading, isError } = useDashboardKpis();

  return (
    <Card>
      <CardHeader>
        <CardTitle>Profit Today</CardTitle>
      </CardHeader>
      <CardContent>
        {isLoading && <p className="text-sm text-ink-soft">Loading…</p>}
        {(isError || (data && !data.profit.idr && !data.profit.usdt)) && (
          <p className="text-sm text-ink-faint">No profit yet today.</p>
        )}
        {data && (data.profit.idr || data.profit.usdt) && (
          <>
            <CurrencyStack
              amounts={
                [
                  data.profit.idr ? { currency: "IDR", value: data.profit.idr.netProfit } : null,
                  data.profit.usdt ? { currency: "USDT", value: data.profit.usdt.netProfit } : null,
                ].filter(Boolean) as CurrencyAmount[]
              }
            />
            <div className="mt-1.5 flex flex-col gap-0.5">
              {data.profit.idr &&
                marginLine("IDR", data.profit.idr) &&
                <p className="text-xs text-ink-soft">{marginLine("IDR", data.profit.idr)}</p>}
              {data.profit.usdt &&
                marginLine("USDT", data.profit.usdt) &&
                <p className="text-xs text-ink-soft">{marginLine("USDT", data.profit.usdt)}</p>}
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}
```

Run again → PASS (3 tests).

- [ ] **Step 3: Write the failing OrdersKpiCard test, then implement it**

Create `apps/web-admin/client/src/components/dashboard/OrdersKpiCard.test.tsx` (same `renderWithKpis` harness shape as Step 1, but stubbing `orders`):

```tsx
import "@testing-library/jest-dom";
import { describe, it, expect, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { OrdersKpiCard } from "./OrdersKpiCard";

function renderWithOrders(orders: unknown) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({
      ok: true,
      json: async () => ({
        revenue: { idr: null, usdt: null, usd: null, trendPct: { idr: null, usdt: null } },
        profit: { idr: null, usdt: null },
        orders,
        pendingActions: { toReview: 0, refundDecisions: 0, failedDeliveries: 0, manualApprovals: 0 },
      }),
    })),
  );
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <OrdersKpiCard />
    </QueryClientProvider>,
  );
}

describe("OrdersKpiCard", () => {
  it("shows the total prominently and the delivered/pending/failed breakdown", async () => {
    renderWithOrders({ total: 12, delivered: 9, pending: 2, failed: 1 });
    await waitFor(() => expect(screen.getByText("12")).toBeInTheDocument());
    expect(screen.getByText(/9 delivered/)).toBeInTheDocument();
    expect(screen.getByText(/2 pending/)).toBeInTheDocument();
    expect(screen.getByText(/1 failed/)).toBeInTheDocument();
  });
});
```

Run → FAIL. Create `apps/web-admin/client/src/components/dashboard/OrdersKpiCard.tsx`:

```tsx
import { Card, CardContent, CardHeader, CardTitle } from "../ui/card";
import { useDashboardKpis } from "../../hooks/useDashboardKpis";

export function OrdersKpiCard() {
  const { data, isLoading, isError } = useDashboardKpis();
  return (
    <Card>
      <CardHeader>
        <CardTitle>Orders Today</CardTitle>
      </CardHeader>
      <CardContent>
        {isLoading && <p className="text-sm text-ink-soft">Loading…</p>}
        {isError && <p className="text-sm text-rust">Couldn't load orders.</p>}
        {data && (
          <>
            <p className="font-display text-3xl font-semibold text-ink">{data.orders.total}</p>
            <p className="mt-1 text-xs text-ink-soft">
              {data.orders.delivered} delivered · {data.orders.pending} pending · {data.orders.failed} failed
            </p>
          </>
        )}
      </CardContent>
    </Card>
  );
}
```

Run → PASS.

- [ ] **Step 4: Write the failing PendingActionsKpiCard test, then implement it**

Create `apps/web-admin/client/src/components/dashboard/PendingActionsKpiCard.test.tsx` (harness stubbing `pendingActions`):

```tsx
import "@testing-library/jest-dom";
import { describe, it, expect, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { PendingActionsKpiCard } from "./PendingActionsKpiCard";

function renderWith(pendingActions: unknown) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({
      ok: true,
      json: async () => ({
        revenue: { idr: null, usdt: null, usd: null, trendPct: { idr: null, usdt: null } },
        profit: { idr: null, usdt: null },
        orders: { total: 0, delivered: 0, pending: 0, failed: 0 },
        pendingActions,
      }),
    })),
  );
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <PendingActionsKpiCard />
    </QueryClientProvider>,
  );
}

describe("PendingActionsKpiCard", () => {
  it("sums the four pending-action counts and lists each", async () => {
    renderWith({ toReview: 3, refundDecisions: 1, failedDeliveries: 2, manualApprovals: 0 });
    await waitFor(() => expect(screen.getByText("6")).toBeInTheDocument()); // 3+1+2+0
    expect(screen.getByText(/3 to review/i)).toBeInTheDocument();
    expect(screen.getByText(/2 failed deliveries/i)).toBeInTheDocument();
  });

  it("shows an all-clear empty state when every count is zero", async () => {
    renderWith({ toReview: 0, refundDecisions: 0, failedDeliveries: 0, manualApprovals: 0 });
    await waitFor(() => expect(screen.getByText(/all caught up/i)).toBeInTheDocument());
  });
});
```

Run → FAIL. Create `apps/web-admin/client/src/components/dashboard/PendingActionsKpiCard.tsx`:

```tsx
import { Card, CardContent, CardHeader, CardTitle } from "../ui/card";
import { useDashboardKpis } from "../../hooks/useDashboardKpis";

export function PendingActionsKpiCard() {
  const { data, isLoading, isError } = useDashboardKpis();
  const pa = data?.pendingActions;
  const total = pa ? pa.toReview + pa.refundDecisions + pa.failedDeliveries + pa.manualApprovals : 0;
  return (
    <Card>
      <CardHeader>
        <CardTitle>Pending Actions</CardTitle>
      </CardHeader>
      <CardContent>
        {isLoading && <p className="text-sm text-ink-soft">Loading…</p>}
        {isError && <p className="text-sm text-rust">Couldn't load pending actions.</p>}
        {pa && total === 0 && <p className="text-sm text-ink-faint">All caught up.</p>}
        {pa && total > 0 && (
          <>
            <p className="font-display text-3xl font-semibold text-ink">{total}</p>
            <p className="mt-1 text-xs text-ink-soft">
              {pa.toReview} to review · {pa.refundDecisions} refund decisions · {pa.failedDeliveries} failed
              deliveries · {pa.manualApprovals} manual approvals
            </p>
          </>
        )}
      </CardContent>
    </Card>
  );
}
```

Run → PASS.

- [ ] **Step 4b: Wire the trend line into the existing RevenueKpiCard**

The Phase-2 `RevenueKpiCard` renders the per-currency amounts but not the "trend vs yesterday" the spec calls for (the data is already in `revenue.trendPct`). Give `StatTrend` its real consumer here.

First add a test to the existing `apps/web-admin/client/src/components/dashboard/RevenueKpiCard.test.tsx` (append inside its `describe`, keeping the existing two tests untouched):

```tsx
  it("shows a per-currency trend line when yesterday had comparable revenue", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({
          revenue: { idr: "10000", usdt: null, usd: null, trendPct: { idr: "12.3", usdt: null } },
          profit: { idr: null, usdt: null },
          orders: { total: 0, delivered: 0, pending: 0, failed: 0 },
          pendingActions: { toReview: 0, refundDecisions: 0, failedDeliveries: 0, manualApprovals: 0 },
        }),
      })),
    );
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <RevenueKpiCard />
      </QueryClientProvider>,
    );
    await waitFor(() => expect(screen.getByText(/12\.3% vs yesterday/)).toBeInTheDocument());
  });
```

Run: `pnpm vitest run apps/web-admin/client/src/components/dashboard/RevenueKpiCard.test.tsx` → the new test FAILS (no trend rendered yet), the existing two still pass.

Then edit `apps/web-admin/client/src/components/dashboard/RevenueKpiCard.tsx`: add the import `import { StatTrend } from "../shared/StatTrend";`, and render the trend lines right after the `<CurrencyStack .../>` (inside the `amounts.length > 0` branch):

```tsx
        {amounts.length > 0 ? (
          <>
            <CurrencyStack amounts={amounts} />
            <div className="mt-1.5 flex flex-col gap-0.5">
              {data.revenue.trendPct.idr !== null && <StatTrend pct={data.revenue.trendPct.idr} />}
              {data.revenue.trendPct.usdt !== null && <StatTrend pct={data.revenue.trendPct.usdt} />}
            </div>
          </>
        ) : (
          <p className="text-sm text-ink-soft">No revenue yet today.</p>
        )}
```

Run again → all three RevenueKpiCard tests PASS.

- [ ] **Step 5: Create the KpiRow assembly (no new test — it's covered by App integration in Task 11)**

Create `apps/web-admin/client/src/components/dashboard/KpiRow.tsx`:

```tsx
import { RevenueKpiCard } from "./RevenueKpiCard";
import { ProfitKpiCard } from "./ProfitKpiCard";
import { OrdersKpiCard } from "./OrdersKpiCard";
import { PendingActionsKpiCard } from "./PendingActionsKpiCard";

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

- [ ] **Step 6: Run the whole dashboard test folder, then commit**

Run: `pnpm vitest run apps/web-admin/client/src/components/dashboard`
Expected: PASS (existing `RevenueKpiCard.test.tsx` + the 3 new card tests).

```bash
git add apps/web-admin/client/src/components/dashboard
git commit -m "feat(web-admin): complete the KPI row (Profit, Orders, Pending Actions cards)"
```

---

### Task 3: Operation Center

**Files:**
- Modify: `apps/web-admin/client/src/api/types.ts` — add `OperationsSummary`
- Create: `apps/web-admin/client/src/hooks/useOperations.ts`
- Create: `apps/web-admin/client/src/components/dashboard/OperationCenter.tsx` + `.test.tsx`

**Interfaces:**
- Consumes: `apiGet` (`../api/client`), `Card`/`CardContent` (`../ui/card`), `UrgencyDot` (Task 1).
- Produces: `OperationsSummary` type; `useOperations()` hook; `OperationCenter` component — a row of 5 clickable cards (Pending Payments, Manual Reviews, Failed Deliveries, Orders Processing, Expired Payments), each showing a count, an urgency dot, and linking to the matching existing admin list page.

- [ ] **Step 1: Add the type**

Append to `apps/web-admin/client/src/api/types.ts`:

```ts
export interface OperationsSummary {
  pendingPayments: number;
  manualReviews: number;
  failedDeliveries: number;
  ordersProcessing: number;
  expiredPayments: number;
}
```

- [ ] **Step 2: Add the hook**

Create `apps/web-admin/client/src/hooks/useOperations.ts`:

```ts
import { useQuery } from "@tanstack/react-query";
import { apiGet } from "../api/client";
import type { OperationsSummary } from "../api/types";

export function useOperations() {
  return useQuery({
    queryKey: ["dashboard", "operations"],
    queryFn: () => apiGet<OperationsSummary>("/api/dashboard/operations"),
    refetchInterval: 30_000,
  });
}
```

- [ ] **Step 3: Write the failing test**

Create `apps/web-admin/client/src/components/dashboard/OperationCenter.test.tsx`:

```tsx
import "@testing-library/jest-dom";
import { describe, it, expect, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { OperationCenter } from "./OperationCenter";

function renderWith(ops: unknown) {
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => ops })));
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <OperationCenter />
    </QueryClientProvider>,
  );
}

describe("OperationCenter", () => {
  it("renders all five operation cards with their counts as links", async () => {
    renderWith({ pendingPayments: 4, manualReviews: 2, failedDeliveries: 1, ordersProcessing: 3, expiredPayments: 0 });
    await waitFor(() => expect(screen.getByText("Pending Payments")).toBeInTheDocument());
    expect(screen.getByText("Manual Reviews")).toBeInTheDocument();
    expect(screen.getByText("Failed Deliveries")).toBeInTheDocument();
    expect(screen.getByText("Orders Processing")).toBeInTheDocument();
    expect(screen.getByText("Expired Payments")).toBeInTheDocument();
    // Failed Deliveries card links to the payments ledger filtered to delivery failures.
    const failedLink = screen.getByText("Failed Deliveries").closest("a");
    expect(failedLink).toHaveAttribute("href", "/payments?outcome=delivery_failed");
  });
});
```

- [ ] **Step 4: Run it (fails), then implement OperationCenter**

Run: `pnpm vitest run apps/web-admin/client/src/components/dashboard/OperationCenter.test.tsx` → FAIL.

Create `apps/web-admin/client/src/components/dashboard/OperationCenter.tsx`. Each card is an `<a href>` to an existing admin list page (these pages still render as Nunjucks and already accept these query filters — the old dashboard used `/orders?status=…` and `/payments?outcome=…`):

```tsx
import { Card, CardContent } from "../ui/card";
import { UrgencyDot } from "../shared/UrgencyDot";
import { useOperations } from "../../hooks/useOperations";
import type { OperationsSummary } from "../../api/types";

type OpCardDef = {
  key: keyof OperationsSummary;
  label: string;
  href: string;
  // money-at-risk queues escalate to red; the rest warn; zero is idle.
  critical?: boolean;
};

const CARDS: OpCardDef[] = [
  { key: "pendingPayments", label: "Pending Payments", href: "/orders?status=PENDING_PAYMENT" },
  { key: "manualReviews", label: "Manual Reviews", href: "/orders?status=PENDING_VERIFICATION" },
  { key: "failedDeliveries", label: "Failed Deliveries", href: "/payments?outcome=delivery_failed", critical: true },
  { key: "ordersProcessing", label: "Orders Processing", href: "/orders?status=PAID" },
  { key: "expiredPayments", label: "Expired Payments", href: "/orders?status=PENDING_PAYMENT" },
];

function level(count: number, critical?: boolean): "ok" | "warn" | "critical" | "idle" {
  if (count === 0) return "idle";
  return critical ? "critical" : "warn";
}

export function OperationCenter() {
  const { data, isLoading, isError } = useOperations();

  return (
    <section>
      <h2 className="mb-2 font-display text-lg font-semibold text-ink">Operation Center</h2>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
        {isLoading && <p className="text-sm text-ink-soft">Loading…</p>}
        {isError && <p className="text-sm text-rust">Couldn't load operations.</p>}
        {data &&
          CARDS.map((c) => (
            <a key={c.key} href={c.href} className="block transition-transform hover:-translate-y-0.5">
              <Card>
                <CardContent className="flex items-center justify-between py-3">
                  <div>
                    <p className="font-display text-2xl font-semibold text-ink">{data[c.key]}</p>
                    <p className="text-xs text-ink-soft">{c.label}</p>
                  </div>
                  <UrgencyDot level={level(data[c.key], c.critical)} />
                </CardContent>
              </Card>
            </a>
          ))}
      </div>
    </section>
  );
}
```

Run again → PASS.

- [ ] **Step 5: Typecheck + commit**

Run: `pnpm --filter @app/web-admin-client typecheck`
Expected: PASS.

```bash
git add apps/web-admin/client/src/api/types.ts apps/web-admin/client/src/hooks/useOperations.ts apps/web-admin/client/src/components/dashboard/OperationCenter.tsx apps/web-admin/client/src/components/dashboard/OperationCenter.test.tsx
git commit -m "feat(web-admin): add the Operation Center section"
```

---

### Task 4: Inventory Monitoring card

**Files:**
- Modify: `apps/web-admin/client/src/api/types.ts` — add `InventoryRow`
- Create: `apps/web-admin/client/src/hooks/useInventory.ts`
- Create: `apps/web-admin/client/src/components/dashboard/InventoryMonitoringCard.tsx` + `.test.tsx`

**Interfaces:**
- Consumes: `apiGet`, `Card`/`CardHeader`/`CardTitle`/`CardContent`, `EmptyState` (Task 1).
- Produces: `InventoryRow` type; `useInventory()` hook; `InventoryMonitoringCard` — lists each low-stock denomination with its current count and threshold, plus a "View inventory" link to `/stock`.

- [ ] **Step 1: Add the type to `types.ts`**

```ts
export interface InventoryRow {
  denominationId: number;
  productName: string;
  available: number;
  threshold: number;
}
```

- [ ] **Step 2: Add the hook**

Create `apps/web-admin/client/src/hooks/useInventory.ts`:

```ts
import { useQuery } from "@tanstack/react-query";
import { apiGet } from "../api/client";
import type { InventoryRow } from "../api/types";

export function useInventory() {
  return useQuery({
    queryKey: ["dashboard", "inventory"],
    queryFn: () => apiGet<InventoryRow[]>("/api/dashboard/inventory"),
    refetchInterval: 30_000,
  });
}
```

- [ ] **Step 3: Write the failing test**

Create `apps/web-admin/client/src/components/dashboard/InventoryMonitoringCard.test.tsx`:

```tsx
import "@testing-library/jest-dom";
import { describe, it, expect, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { InventoryMonitoringCard } from "./InventoryMonitoringCard";

function renderWith(rows: unknown) {
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => rows })));
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <InventoryMonitoringCard />
    </QueryClientProvider>,
  );
}

describe("InventoryMonitoringCard", () => {
  it("lists each critical-stock product with its count, worst first", async () => {
    renderWith([
      { denominationId: 1, productName: "CapCut Pro 30 Day", available: 2, threshold: 3 },
      { denominationId: 2, productName: "Netflix Premium", available: 0, threshold: 3 },
    ]);
    await waitFor(() => expect(screen.getByText("CapCut Pro 30 Day")).toBeInTheDocument());
    expect(screen.getByText("Netflix Premium")).toBeInTheDocument();
    expect(screen.getByText("View inventory").closest("a")).toHaveAttribute("href", "/stock");
  });

  it("shows an all-stocked empty state when nothing is low", async () => {
    renderWith([]);
    await waitFor(() => expect(screen.getByText(/stock levels are healthy/i)).toBeInTheDocument());
  });
});
```

- [ ] **Step 4: Run it (fails), then implement InventoryMonitoringCard**

Run → FAIL. Create `apps/web-admin/client/src/components/dashboard/InventoryMonitoringCard.tsx`:

```tsx
import { Card, CardContent, CardHeader, CardTitle } from "../ui/card";
import { EmptyState } from "../shared/EmptyState";
import { useInventory } from "../../hooks/useInventory";

export function InventoryMonitoringCard() {
  const { data, isLoading, isError } = useInventory();
  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between">
        <CardTitle>Critical Stock</CardTitle>
        <a href="/stock" className="text-xs font-semibold text-pine hover:underline">
          View inventory
        </a>
      </CardHeader>
      <CardContent>
        {isLoading && <p className="text-sm text-ink-soft">Loading…</p>}
        {isError && <p className="text-sm text-rust">Couldn't load inventory.</p>}
        {data && data.length === 0 && <EmptyState message="Stock levels are healthy." />}
        {data && data.length > 0 && (
          <ul className="flex flex-col divide-y divide-line">
            {data.map((r) => (
              <li key={r.denominationId} className="flex items-center justify-between py-2">
                <span className="text-sm text-ink">{r.productName}</span>
                <span className={`text-sm font-semibold ${r.available === 0 ? "text-rust" : "text-amberx"}`}>
                  {r.available} left
                  <span className="ml-1 text-xs font-normal text-ink-faint">/ {r.threshold}</span>
                </span>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
```

The backend already returns rows sorted worst-first (`lowStockDenominations` sorts ascending by `available`), so no client-side sort is needed.

Run → PASS.

- [ ] **Step 5: Typecheck + commit**

```bash
git add apps/web-admin/client/src/api/types.ts apps/web-admin/client/src/hooks/useInventory.ts apps/web-admin/client/src/components/dashboard/InventoryMonitoringCard.tsx apps/web-admin/client/src/components/dashboard/InventoryMonitoringCard.test.tsx
git commit -m "feat(web-admin): add the Inventory Monitoring card"
```

---

### Task 5: Upcoming Expirations table

**Files:**
- Modify: `apps/web-admin/client/src/api/types.ts` — add `ExpirationRow`
- Create: `apps/web-admin/client/src/hooks/useExpirations.ts`
- Create: `apps/web-admin/client/src/components/dashboard/ExpirationsTable.tsx` + `.test.tsx`

**Interfaces:**
- Consumes: `apiGet`, `Card`/`CardHeader`/`CardTitle`/`CardContent`, `EmptyState`.
- Produces: `ExpirationRow` type; `useExpirations()` hook; `ExpirationsTable` — Product / Customer / Remaining-days / Order columns, each row linking to its order.

- [ ] **Step 1: Add the type**

```ts
export interface ExpirationRow {
  orderId: number;
  orderCode: string;
  productName: string;
  customerLabel: string;
  remainingDays: number;
}
```

- [ ] **Step 2: Add the hook**

Create `apps/web-admin/client/src/hooks/useExpirations.ts`:

```ts
import { useQuery } from "@tanstack/react-query";
import { apiGet } from "../api/client";
import type { ExpirationRow } from "../api/types";

export function useExpirations() {
  return useQuery({
    queryKey: ["dashboard", "expirations"],
    queryFn: () => apiGet<ExpirationRow[]>("/api/dashboard/expirations"),
    refetchInterval: 30_000,
  });
}
```

- [ ] **Step 3: Write the failing test**

Create `apps/web-admin/client/src/components/dashboard/ExpirationsTable.test.tsx`:

```tsx
import "@testing-library/jest-dom";
import { describe, it, expect, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ExpirationsTable } from "./ExpirationsTable";

function renderWith(rows: unknown) {
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => rows })));
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <ExpirationsTable />
    </QueryClientProvider>,
  );
}

describe("ExpirationsTable", () => {
  it("lists upcoming expirations with remaining days, each linking to its order", async () => {
    renderWith([
      { orderId: 7, orderCode: "ORD-AAA", productName: "Netflix 1M", customerLabel: "buyer", remainingDays: 1 },
    ]);
    await waitFor(() => expect(screen.getByText("Netflix 1M")).toBeInTheDocument());
    expect(screen.getByText("buyer")).toBeInTheDocument();
    expect(screen.getByText(/1 day/)).toBeInTheDocument();
    expect(screen.getByText("ORD-AAA").closest("a")).toHaveAttribute("href", "/orders/7");
  });

  it("shows an empty state when nothing is expiring soon", async () => {
    renderWith([]);
    await waitFor(() => expect(screen.getByText(/no upcoming expirations/i)).toBeInTheDocument());
  });
});
```

- [ ] **Step 4: Run it (fails), then implement ExpirationsTable**

Run → FAIL. Create `apps/web-admin/client/src/components/dashboard/ExpirationsTable.tsx`:

```tsx
import { Card, CardContent, CardHeader, CardTitle } from "../ui/card";
import { EmptyState } from "../shared/EmptyState";
import { useExpirations } from "../../hooks/useExpirations";

export function ExpirationsTable() {
  const { data, isLoading, isError } = useExpirations();
  return (
    <Card>
      <CardHeader>
        <CardTitle>Upcoming Expirations</CardTitle>
      </CardHeader>
      <CardContent>
        {isLoading && <p className="text-sm text-ink-soft">Loading…</p>}
        {isError && <p className="text-sm text-rust">Couldn't load expirations.</p>}
        {data && data.length === 0 && <EmptyState message="No upcoming expirations." />}
        {data && data.length > 0 && (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs uppercase tracking-wide text-ink-faint">
                  <th className="py-1.5 pr-3 font-semibold">Product</th>
                  <th className="py-1.5 pr-3 font-semibold">Customer</th>
                  <th className="py-1.5 pr-3 font-semibold">Remaining</th>
                  <th className="py-1.5 font-semibold">Order</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {data.map((r) => (
                  <tr key={r.orderId}>
                    <td className="py-2 pr-3 text-ink">{r.productName}</td>
                    <td className="py-2 pr-3 text-ink-soft">{r.customerLabel}</td>
                    <td className="py-2 pr-3">
                      <span className={r.remainingDays <= 1 ? "font-semibold text-rust" : "text-amberx"}>
                        {r.remainingDays} day{r.remainingDays === 1 ? "" : "s"}
                      </span>
                    </td>
                    <td className="py-2">
                      <a href={`/orders/${r.orderId}`} className="font-mono text-xs text-pine hover:underline">
                        {r.orderCode}
                      </a>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
```

Run → PASS.

- [ ] **Step 5: Typecheck + commit**

```bash
git add apps/web-admin/client/src/api/types.ts apps/web-admin/client/src/hooks/useExpirations.ts apps/web-admin/client/src/components/dashboard/ExpirationsTable.tsx apps/web-admin/client/src/components/dashboard/ExpirationsTable.test.tsx
git commit -m "feat(web-admin): add the Upcoming Expirations table"
```

---

### Task 6: Recent Orders table

**Files:**
- Modify: `apps/web-admin/client/src/api/types.ts` — add `RecentOrderRow`
- Create: `apps/web-admin/client/src/hooks/useRecentOrders.ts`
- Create: `apps/web-admin/client/src/components/dashboard/RecentOrdersTable.tsx` + `.test.tsx`

**Interfaces:**
- Consumes: `apiGet`, `Card`/`CardHeader`/`CardTitle`/`CardContent`, `StatusBadge` (Task 1), `formatCurrencyDisplay` (`../shared/CurrencyAmount`), `EmptyState`.
- Produces: `RecentOrderRow` type; `useRecentOrders()` hook; `RecentOrdersTable` — latest 10 orders: Order ID / Product / Customer / Amount / Status / Created. The amount renders via `formatCurrencyDisplay(amount, currency)` so a USDT order never shows as "Rp…".

- [ ] **Step 1: Add the type** (`currency` is the raw `Order.currency`, `"IDR"` or `"USDT"`; type it as the formatter's accepted union)

```ts
export interface RecentOrderRow {
  orderId: number;
  orderCode: string;
  productLabel: string;
  customerLabel: string;
  amount: string;
  currency: "IDR" | "USDT" | "USD";
  status: string;
  createdAt: string;
}
```

- [ ] **Step 2: Add the hook**

Create `apps/web-admin/client/src/hooks/useRecentOrders.ts`:

```ts
import { useQuery } from "@tanstack/react-query";
import { apiGet } from "../api/client";
import type { RecentOrderRow } from "../api/types";

export function useRecentOrders() {
  return useQuery({
    queryKey: ["dashboard", "recent-orders"],
    queryFn: () => apiGet<RecentOrderRow[]>("/api/dashboard/orders/recent"),
    refetchInterval: 30_000,
  });
}
```

- [ ] **Step 3: Write the failing test** — the headline assertion is that a USDT order's amount never renders with an "Rp" prefix (the bug-shape, applied to the orders table):

Create `apps/web-admin/client/src/components/dashboard/RecentOrdersTable.test.tsx`:

```tsx
import "@testing-library/jest-dom";
import { describe, it, expect, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RecentOrdersTable } from "./RecentOrdersTable";

function renderWith(rows: unknown) {
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => rows })));
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <RecentOrdersTable />
    </QueryClientProvider>,
  );
}

describe("RecentOrdersTable", () => {
  it("formats each order's amount in its own currency — a USDT order never shows Rp", async () => {
    renderWith([
      { orderId: 1, orderCode: "ORD-IDR", productLabel: "Netflix", customerLabel: "a", amount: "54000", currency: "IDR", status: "DELIVERED", createdAt: "2026-06-25T03:00:00.000Z" },
      { orderId: 2, orderCode: "ORD-USDT", productLabel: "Spotify", customerLabel: "b", amount: "3.43", currency: "USDT", status: "PENDING_VERIFICATION", createdAt: "2026-06-25T04:00:00.000Z" },
    ]);
    await waitFor(() => expect(screen.getByText("Rp54.000")).toBeInTheDocument());
    expect(screen.getByText("3.43 USDT")).toBeInTheDocument();
    expect(screen.queryByText("Rp3")).not.toBeInTheDocument();
    expect(screen.getByText("Delivered")).toBeInTheDocument(); // StatusBadge label
  });

  it("shows an empty state when there are no recent orders", async () => {
    renderWith([]);
    await waitFor(() => expect(screen.getByText(/no orders yet/i)).toBeInTheDocument());
  });
});
```

- [ ] **Step 4: Run it (fails), then implement RecentOrdersTable**

Run → FAIL. Create `apps/web-admin/client/src/components/dashboard/RecentOrdersTable.tsx`:

```tsx
import { Card, CardContent, CardHeader, CardTitle } from "../ui/card";
import { StatusBadge } from "../shared/StatusBadge";
import { EmptyState } from "../shared/EmptyState";
import { formatCurrencyDisplay } from "../shared/CurrencyAmount";
import { useRecentOrders } from "../../hooks/useRecentOrders";

function shortTime(iso: string): string {
  return new Date(iso).toLocaleString();
}

export function RecentOrdersTable() {
  const { data, isLoading, isError } = useRecentOrders();
  return (
    <Card>
      <CardHeader>
        <CardTitle>Recent Orders</CardTitle>
      </CardHeader>
      <CardContent>
        {isLoading && <p className="text-sm text-ink-soft">Loading…</p>}
        {isError && <p className="text-sm text-rust">Couldn't load recent orders.</p>}
        {data && data.length === 0 && <EmptyState message="No orders yet." />}
        {data && data.length > 0 && (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs uppercase tracking-wide text-ink-faint">
                  <th className="py-1.5 pr-3 font-semibold">Order</th>
                  <th className="py-1.5 pr-3 font-semibold">Product</th>
                  <th className="py-1.5 pr-3 font-semibold">Customer</th>
                  <th className="py-1.5 pr-3 font-semibold">Amount</th>
                  <th className="py-1.5 pr-3 font-semibold">Status</th>
                  <th className="py-1.5 font-semibold">Created</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {data.map((o) => (
                  <tr key={o.orderId}>
                    <td className="py-2 pr-3">
                      <a href={`/orders/${o.orderId}`} className="font-mono text-xs text-pine hover:underline">
                        {o.orderCode}
                      </a>
                    </td>
                    <td className="py-2 pr-3 text-ink">{o.productLabel}</td>
                    <td className="py-2 pr-3 text-ink-soft">{o.customerLabel}</td>
                    <td className="py-2 pr-3 font-mono text-ink">{formatCurrencyDisplay(o.amount, o.currency)}</td>
                    <td className="py-2 pr-3"><StatusBadge status={o.status} /></td>
                    <td className="py-2 text-xs text-ink-faint">{shortTime(o.createdAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
```

Run → PASS.

- [ ] **Step 5: Typecheck + commit**

```bash
git add apps/web-admin/client/src/api/types.ts apps/web-admin/client/src/hooks/useRecentOrders.ts apps/web-admin/client/src/components/dashboard/RecentOrdersTable.tsx apps/web-admin/client/src/components/dashboard/RecentOrdersTable.test.tsx
git commit -m "feat(web-admin): add the Recent Orders table"
```

---

### Task 7: Business Health grid

**Files:**
- Modify: `apps/web-admin/client/src/api/types.ts` — add `HealthStatus`
- Create: `apps/web-admin/client/src/hooks/useHealth.ts`
- Create: `apps/web-admin/client/src/components/dashboard/BusinessHealthGrid.tsx` + `.test.tsx`

**Interfaces:**
- Consumes: `apiGet`, `Card`/`CardHeader`/`CardTitle`/`CardContent`, `UrgencyDot` (Task 1).
- Produces: `HealthStatus` type; `useHealth()` hook; `BusinessHealthGrid` — one labeled row per service with a colored dot mapping `green→ok`, `yellow→warn`, `red→critical`, `unmonitored→idle` (honest gray, never fake-green).

- [ ] **Step 1: Add the type** (values are open strings from the backend; keep the union loose but documented)

```ts
export type HealthLevel = "green" | "yellow" | "red" | "unmonitored";

export interface HealthStatus {
  telegramBot: HealthLevel;
  binance: HealthLevel;
  bybit: HealthLevel;
  tokopay: HealthLevel;
  paydisini: HealthLevel;
  nowpayments: HealthLevel;
}
```

- [ ] **Step 2: Add the hook**

Create `apps/web-admin/client/src/hooks/useHealth.ts`:

```ts
import { useQuery } from "@tanstack/react-query";
import { apiGet } from "../api/client";
import type { HealthStatus } from "../api/types";

export function useHealth() {
  return useQuery({
    queryKey: ["dashboard", "health"],
    queryFn: () => apiGet<HealthStatus>("/api/dashboard/health"),
    refetchInterval: 30_000,
  });
}
```

- [ ] **Step 3: Write the failing test**

Create `apps/web-admin/client/src/components/dashboard/BusinessHealthGrid.test.tsx`:

```tsx
import "@testing-library/jest-dom";
import { describe, it, expect, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BusinessHealthGrid } from "./BusinessHealthGrid";

function renderWith(health: unknown) {
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => health })));
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <BusinessHealthGrid />
    </QueryClientProvider>,
  );
}

describe("BusinessHealthGrid", () => {
  it("labels each service and renders an honest 'Unmonitored' state, not a fake green", async () => {
    renderWith({ telegramBot: "green", binance: "red", bybit: "unmonitored", tokopay: "unmonitored", paydisini: "unmonitored", nowpayments: "unmonitored" });
    await waitFor(() => expect(screen.getByText("Telegram Bot")).toBeInTheDocument());
    expect(screen.getByText("Binance")).toBeInTheDocument();
    // Bybit row shows the literal Unmonitored label, with an idle (gray) dot.
    const bybitRow = screen.getByText("Bybit").closest("li")!;
    expect(bybitRow.textContent).toMatch(/Unmonitored/);
    expect(bybitRow.querySelector(".bg-ink-faint")).not.toBeNull();
  });
});
```

- [ ] **Step 4: Run it (fails), then implement BusinessHealthGrid**

Run → FAIL. Create `apps/web-admin/client/src/components/dashboard/BusinessHealthGrid.tsx`:

```tsx
import { Card, CardContent, CardHeader, CardTitle } from "../ui/card";
import { UrgencyDot } from "../shared/UrgencyDot";
import { useHealth } from "../../hooks/useHealth";
import type { HealthLevel, HealthStatus } from "../../api/types";

const SERVICES: Array<{ key: keyof HealthStatus; label: string }> = [
  { key: "telegramBot", label: "Telegram Bot" },
  { key: "binance", label: "Binance" },
  { key: "bybit", label: "Bybit" },
  { key: "tokopay", label: "TokoPay" },
  { key: "paydisini", label: "PayDisini" },
  { key: "nowpayments", label: "NOWPayments" },
];

const DOT: Record<HealthLevel, "ok" | "warn" | "critical" | "idle"> = {
  green: "ok",
  yellow: "warn",
  red: "critical",
  unmonitored: "idle",
};

const LABEL: Record<HealthLevel, string> = {
  green: "Healthy",
  yellow: "Warning",
  red: "Critical",
  unmonitored: "Unmonitored",
};

export function BusinessHealthGrid() {
  const { data, isLoading, isError } = useHealth();
  return (
    <Card>
      <CardHeader>
        <CardTitle>Business Health</CardTitle>
      </CardHeader>
      <CardContent>
        {isLoading && <p className="text-sm text-ink-soft">Loading…</p>}
        {isError && <p className="text-sm text-rust">Couldn't load service health.</p>}
        {data && (
          <ul className="flex flex-col divide-y divide-line">
            {SERVICES.map((s) => {
              const level = data[s.key];
              return (
                <li key={s.key} className="flex items-center justify-between py-2">
                  <span className="text-sm text-ink">{s.label}</span>
                  <span className="inline-flex items-center gap-1.5 text-xs text-ink-soft">
                    <UrgencyDot level={DOT[level]} />
                    {LABEL[level]}
                  </span>
                </li>
              );
            })}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
```

Run → PASS.

- [ ] **Step 5: Typecheck + commit**

```bash
git add apps/web-admin/client/src/api/types.ts apps/web-admin/client/src/hooks/useHealth.ts apps/web-admin/client/src/components/dashboard/BusinessHealthGrid.tsx apps/web-admin/client/src/components/dashboard/BusinessHealthGrid.test.tsx
git commit -m "feat(web-admin): add the Business Health grid"
```

---

### Task 8: Top Products list

**Files:**
- Modify: `apps/web-admin/client/src/api/types.ts` — add `TopProductRow`
- Create: `apps/web-admin/client/src/hooks/useTopProducts.ts`
- Create: `apps/web-admin/client/src/components/dashboard/TopProductsList.tsx` + `.test.tsx`

**Interfaces:**
- Consumes: `apiGet`, `Card`/`CardHeader`/`CardTitle`/`CardContent`, `formatCurrencyDisplay`, `EmptyState`.
- Produces: `TopProductRow` type; `useTopProducts()` hook; `TopProductsList` — top 5 by units sold, each showing units, IDR-equivalent revenue, and profit (or "N/A" when `profitIdrEquiv` is null because some units had unknown cost).

- [ ] **Step 1: Add the type**

```ts
export interface TopProductRow {
  productId: number;
  name: string;
  unitsSold: number;
  revenueIdrEquiv: string;
  profitIdrEquiv: string | null;
  costUnknownUnits: number;
}
```

- [ ] **Step 2: Add the hook**

Create `apps/web-admin/client/src/hooks/useTopProducts.ts`:

```ts
import { useQuery } from "@tanstack/react-query";
import { apiGet } from "../api/client";
import type { TopProductRow } from "../api/types";

export function useTopProducts() {
  return useQuery({
    queryKey: ["dashboard", "top-products"],
    queryFn: () => apiGet<TopProductRow[]>("/api/dashboard/top-products"),
    refetchInterval: 30_000,
  });
}
```

- [ ] **Step 3: Write the failing test**

Create `apps/web-admin/client/src/components/dashboard/TopProductsList.test.tsx`:

```tsx
import "@testing-library/jest-dom";
import { describe, it, expect, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { TopProductsList } from "./TopProductsList";

function renderWith(rows: unknown) {
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => rows })));
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <TopProductsList />
    </QueryClientProvider>,
  );
}

describe("TopProductsList", () => {
  it("shows units, IDR-equivalent revenue, and profit per product", async () => {
    renderWith([
      { productId: 1, name: "Product A", unitsSold: 3, revenueIdrEquiv: "30000", profitIdrEquiv: "12000", costUnknownUnits: 0 },
    ]);
    await waitFor(() => expect(screen.getByText("Product A")).toBeInTheDocument());
    expect(screen.getByText(/3 sold/)).toBeInTheDocument();
    expect(screen.getByText(/Rp30\.000 revenue/)).toBeInTheDocument();
    expect(screen.getByText(/Rp12\.000 profit/)).toBeInTheDocument();
  });

  it("shows N/A profit when some units have unknown cost", async () => {
    renderWith([
      { productId: 2, name: "Product B", unitsSold: 1, revenueIdrEquiv: "10000", profitIdrEquiv: null, costUnknownUnits: 1 },
    ]);
    await waitFor(() => expect(screen.getByText(/N\/A profit/)).toBeInTheDocument());
  });

  it("shows an empty state with no sales", async () => {
    renderWith([]);
    await waitFor(() => expect(screen.getByText(/no sales in this period/i)).toBeInTheDocument());
  });
});
```

- [ ] **Step 4: Run it (fails), then implement TopProductsList**

Run → FAIL. Create `apps/web-admin/client/src/components/dashboard/TopProductsList.tsx` (revenue/profit are already IDR-equivalent server-side, so format them as IDR):

```tsx
import { Card, CardContent, CardHeader, CardTitle } from "../ui/card";
import { EmptyState } from "../shared/EmptyState";
import { formatCurrencyDisplay } from "../shared/CurrencyAmount";
import { useTopProducts } from "../../hooks/useTopProducts";

export function TopProductsList() {
  const { data, isLoading, isError } = useTopProducts();
  return (
    <Card>
      <CardHeader>
        <CardTitle>Top Products · Last 30 Days</CardTitle>
      </CardHeader>
      <CardContent>
        {isLoading && <p className="text-sm text-ink-soft">Loading…</p>}
        {isError && <p className="text-sm text-rust">Couldn't load top products.</p>}
        {data && data.length === 0 && <EmptyState message="No sales in this period." />}
        {data && data.length > 0 && (
          <ol className="flex flex-col divide-y divide-line">
            {data.map((p) => (
              <li key={p.productId} className="flex items-center justify-between py-2">
                <span className="text-sm text-ink">{p.name}</span>
                <span className="text-right text-xs text-ink-soft">
                  {p.unitsSold} sold · {formatCurrencyDisplay(p.revenueIdrEquiv, "IDR")} revenue ·{" "}
                  {p.profitIdrEquiv === null
                    ? "N/A profit"
                    : `${formatCurrencyDisplay(p.profitIdrEquiv, "IDR")} profit`}
                </span>
              </li>
            ))}
          </ol>
        )}
      </CardContent>
    </Card>
  );
}
```

Run → PASS.

- [ ] **Step 5: Typecheck + commit**

```bash
git add apps/web-admin/client/src/api/types.ts apps/web-admin/client/src/hooks/useTopProducts.ts apps/web-admin/client/src/components/dashboard/TopProductsList.tsx apps/web-admin/client/src/components/dashboard/TopProductsList.test.tsx
git commit -m "feat(web-admin): add the Top Products list"
```

---

### Task 9: Sales Analytics chart (Recharts)

**Files:**
- Modify: `apps/web-admin/client/package.json` — add `recharts`
- Modify: `apps/web-admin/client/src/api/types.ts` — add `AnalyticsPoint`, `AnalyticsRange`, `AnalyticsCurrency`, `AnalyticsMetric`
- Create: `apps/web-admin/client/src/hooks/useAnalytics.ts`
- Create: `apps/web-admin/client/src/components/dashboard/SalesAnalyticsCard.tsx` + `.test.tsx`

**Interfaces:**
- Consumes: `apiGet`, `Card`/`CardHeader`/`CardTitle`/`CardContent`, `EmptyState`, Recharts.
- Produces: `AnalyticsPoint` type + the 3 filter-param union types; `useAnalytics(range, currency, metric)` hook; `SalesAnalyticsCard` — filter buttons (7d/30d · IDR/USDT/Combined · Revenue/Orders) above a Recharts line chart.

- [ ] **Step 1: Add the dependency**

Run: `pnpm add recharts@^2.13.3 --filter @app/web-admin-client`
Expected: `recharts` added to `apps/web-admin/client/package.json` `dependencies`.

- [ ] **Step 2: Add the types**

Append to `apps/web-admin/client/src/api/types.ts`:

```ts
export type AnalyticsRange = "7d" | "30d";
export type AnalyticsCurrency = "idr" | "usdt" | "combined";
export type AnalyticsMetric = "revenue" | "orders";

export interface AnalyticsPoint {
  day: string; // YYYY-MM-DD
  value: string | number; // string for money series, number for order-count series
}
```

- [ ] **Step 3: Add the parametrized hook**

Create `apps/web-admin/client/src/hooks/useAnalytics.ts`:

```ts
import { useQuery } from "@tanstack/react-query";
import { apiGet } from "../api/client";
import type { AnalyticsCurrency, AnalyticsMetric, AnalyticsPoint, AnalyticsRange } from "../api/types";

export function useAnalytics(range: AnalyticsRange, currency: AnalyticsCurrency, metric: AnalyticsMetric) {
  return useQuery({
    queryKey: ["dashboard", "analytics", range, currency, metric],
    queryFn: () =>
      apiGet<AnalyticsPoint[]>(
        `/api/dashboard/analytics?range=${range}&currency=${currency}&metric=${metric}`,
      ),
    refetchInterval: 30_000,
  });
}
```

- [ ] **Step 4: Write the failing test** — assert the filter state drives the request URL and that switching a filter refetches with new params. (Recharts renders into an SVG that jsdom can't measure, so wrap the chart in a fixed-size container and assert on the filter buttons + the fetched URL, not on chart pixels.)

Create `apps/web-admin/client/src/components/dashboard/SalesAnalyticsCard.test.tsx`:

```tsx
import "@testing-library/jest-dom";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { SalesAnalyticsCard } from "./SalesAnalyticsCard";

const fetchMock = vi.fn(async (_url: string) => ({
  ok: true,
  json: async () => [
    { day: "2026-06-24", value: "1000" },
    { day: "2026-06-25", value: "2000" },
  ],
}));

beforeEach(() => {
  fetchMock.mockClear();
  vi.stubGlobal("fetch", fetchMock);
});

function renderCard() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <SalesAnalyticsCard />
    </QueryClientProvider>,
  );
}

describe("SalesAnalyticsCard", () => {
  it("requests the default 7d / idr / revenue series on first render", async () => {
    renderCard();
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/dashboard/analytics?range=7d&currency=idr&metric=revenue",
      expect.anything(),
    );
  });

  it("refetches with new params when a filter button is clicked", async () => {
    renderCard();
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    fireEvent.click(screen.getByRole("button", { name: "30d" }));
    fireEvent.click(screen.getByRole("button", { name: "Orders" }));
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/dashboard/analytics?range=30d&currency=idr&metric=orders",
        expect.anything(),
      ),
    );
  });
});
```

- [ ] **Step 5: Run it (fails), then implement SalesAnalyticsCard**

Run → FAIL. Create `apps/web-admin/client/src/components/dashboard/SalesAnalyticsCard.tsx`:

```tsx
import { useState } from "react";
import { Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { Card, CardContent, CardHeader, CardTitle } from "../ui/card";
import { EmptyState } from "../shared/EmptyState";
import { useAnalytics } from "../../hooks/useAnalytics";
import type { AnalyticsCurrency, AnalyticsMetric, AnalyticsRange } from "../../api/types";

function FilterGroup<T extends string>({
  options,
  value,
  onChange,
}: {
  options: Array<{ value: T; label: string }>;
  value: T;
  onChange: (v: T) => void;
}) {
  return (
    <div className="inline-flex rounded-lg border border-line p-0.5">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          onClick={() => onChange(o.value)}
          className={`rounded-md px-2 py-1 text-xs font-medium ${
            value === o.value ? "bg-pine text-white" : "text-ink-soft hover:text-ink"
          }`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function SalesAnalyticsCard() {
  const [range, setRange] = useState<AnalyticsRange>("7d");
  const [currency, setCurrency] = useState<AnalyticsCurrency>("idr");
  const [metric, setMetric] = useState<AnalyticsMetric>("revenue");
  const { data, isLoading, isError } = useAnalytics(range, currency, metric);

  // Recharts needs numeric y-values; the money series arrives as strings.
  const chartData = (data ?? []).map((p) => ({ day: p.day, value: Number(p.value) }));

  return (
    <Card>
      <CardHeader className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <CardTitle>Sales Analytics</CardTitle>
        <div className="flex flex-wrap gap-2">
          <FilterGroup
            options={[
              { value: "7d", label: "7d" },
              { value: "30d", label: "30d" },
            ]}
            value={range}
            onChange={setRange}
          />
          <FilterGroup
            options={[
              { value: "idr", label: "IDR" },
              { value: "usdt", label: "USDT" },
              { value: "combined", label: "Combined" },
            ]}
            value={currency}
            onChange={setCurrency}
          />
          <FilterGroup
            options={[
              { value: "revenue", label: "Revenue" },
              { value: "orders", label: "Orders" },
            ]}
            value={metric}
            onChange={setMetric}
          />
        </div>
      </CardHeader>
      <CardContent>
        {isLoading && <p className="text-sm text-ink-soft">Loading…</p>}
        {isError && <p className="text-sm text-rust">Couldn't load analytics.</p>}
        {data && chartData.length === 0 && <EmptyState message="No data for this range." />}
        {data && chartData.length > 0 && (
          <div className="h-64 w-full overflow-x-auto">
            <div className="h-full min-w-[480px]">
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={chartData} margin={{ top: 8, right: 12, bottom: 8, left: 12 }}>
                  <XAxis dataKey="day" tick={{ fontSize: 11 }} stroke="#97a1b1" />
                  <YAxis tick={{ fontSize: 11 }} stroke="#97a1b1" width={56} />
                  <Tooltip />
                  <Line type="monotone" dataKey="value" stroke="#2563eb" strokeWidth={2} dot={false} />
                </LineChart>
              </ResponsiveContainer>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
```

Run → PASS.

NOTE: if jsdom logs a benign `ResponsiveContainer`-needs-dimensions warning during the test, that's expected (the assertions are on filter buttons + fetched URLs, not chart geometry) — but the warning must not be an actual error/throw. If it throws, give the inner div an explicit `style={{ width: 480, height: 256 }}` in the test by rendering inside a sized parent, or assert with the chart container mocked. Do NOT mock Recharts away entirely — the URL-driving filter behavior is the real thing under test and doesn't depend on the chart rendering.

- [ ] **Step 6: Build the client (proves recharts bundles), typecheck, commit**

Run: `pnpm --filter @app/web-admin-client build`
Expected: build succeeds; the bundle now includes recharts.

Run: `pnpm --filter @app/web-admin-client typecheck`
Expected: PASS.

```bash
git add apps/web-admin/client/package.json apps/web-admin/client/src/api/types.ts apps/web-admin/client/src/hooks/useAnalytics.ts apps/web-admin/client/src/components/dashboard/SalesAnalyticsCard.tsx apps/web-admin/client/src/components/dashboard/SalesAnalyticsCard.test.tsx
git commit -m "feat(web-admin): add the Sales Analytics chart with range/currency/metric filters"
```

If `pnpm-lock.yaml` changed, include it in this commit.

---

### Task 10: Quick Actions bar

**Files:**
- Create: `apps/web-admin/client/src/components/dashboard/QuickActionsBar.tsx` + `.test.tsx`

**Interfaces:**
- Consumes: lucide-react icons only.
- Produces: `QuickActionsBar` — a sticky row of action links to the existing admin pages. Each link points to a verified-existing route (the implementer must confirm each target route is registered in `apps/web-admin/src/server.ts` before including it; drop any action whose target doesn't exist rather than linking to a 404).

- [ ] **Step 1: Confirm the target routes exist**

Read `apps/web-admin/src/server.ts`'s `app.register(...)` calls. The registered route modules include `catalogRoutes` (`/catalog`), `stockRoutes` (`/stock`), `broadcastRoutes` (`/broadcast`), `usersRoutes` (`/users`), `reportsRoutes` (`/reports`), `ordersRoutes` (`/orders`). There is **no admin "create order" form** (orders originate from the bot/storefront), so the Quick Actions set is: Add Product (`/catalog`), Add Stock (`/stock`), Broadcast (`/broadcast`), Add Customer (`/users`), View Reports (`/reports`), and View Orders (`/orders`). Do not include a "+Create Order" action — there is no target.

- [ ] **Step 2: Write the failing test**

Create `apps/web-admin/client/src/components/dashboard/QuickActionsBar.test.tsx`:

```tsx
import "@testing-library/jest-dom";
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { QuickActionsBar } from "./QuickActionsBar";

describe("QuickActionsBar", () => {
  it("renders each quick action as a link to an existing admin page", () => {
    render(<QuickActionsBar />);
    expect(screen.getByText("Add Product").closest("a")).toHaveAttribute("href", "/catalog");
    expect(screen.getByText("Add Stock").closest("a")).toHaveAttribute("href", "/stock");
    expect(screen.getByText("Broadcast").closest("a")).toHaveAttribute("href", "/broadcast");
    expect(screen.getByText("Add Customer").closest("a")).toHaveAttribute("href", "/users");
    expect(screen.getByText("Reports").closest("a")).toHaveAttribute("href", "/reports");
    expect(screen.getByText("Orders").closest("a")).toHaveAttribute("href", "/orders");
  });
});
```

- [ ] **Step 3: Run it (fails), then implement QuickActionsBar**

Run → FAIL. Create `apps/web-admin/client/src/components/dashboard/QuickActionsBar.tsx`:

```tsx
import { Boxes, Megaphone, Package, Receipt, UserPlus, LineChart } from "lucide-react";
import type { ComponentType } from "react";

const ACTIONS: Array<{ label: string; href: string; Icon: ComponentType<{ className?: string }> }> = [
  { label: "Add Product", href: "/catalog", Icon: Package },
  { label: "Add Stock", href: "/stock", Icon: Boxes },
  { label: "Broadcast", href: "/broadcast", Icon: Megaphone },
  { label: "Add Customer", href: "/users", Icon: UserPlus },
  { label: "Reports", href: "/reports", Icon: LineChart },
  { label: "Orders", href: "/orders", Icon: Receipt },
];

export function QuickActionsBar() {
  return (
    <div className="flex flex-wrap gap-2">
      {ACTIONS.map(({ label, href, Icon }) => (
        <a
          key={href}
          href={href}
          className="inline-flex items-center gap-1.5 rounded-lg border border-line bg-card px-3 py-1.5 text-sm font-medium text-ink shadow-soft transition-colors hover:bg-sand"
        >
          <Icon className="h-4 w-4 text-pine" />
          {label}
        </a>
      ))}
    </div>
  );
}
```

Run → PASS.

- [ ] **Step 4: Commit**

```bash
git add apps/web-admin/client/src/components/dashboard/QuickActionsBar.tsx apps/web-admin/client/src/components/dashboard/QuickActionsBar.test.tsx
git commit -m "feat(web-admin): add the Quick Actions bar"
```

---

### Task 11: Assemble the full dashboard in App.tsx

**Files:**
- Modify: `apps/web-admin/client/src/App.tsx`

**Interfaces:**
- Consumes: `KpiRow` (Task 2), `OperationCenter` (Task 3), `InventoryMonitoringCard` (Task 4), `ExpirationsTable` (Task 5), `SalesAnalyticsCard` (Task 9), `RecentOrdersTable` (Task 6), `BusinessHealthGrid` (Task 7), `TopProductsList` (Task 8), `QuickActionsBar` (Task 10).
- Produces: the complete dashboard page in the responsive layout from the spec's wireframe (KPI row → Operation Center → Alerts row → Sales Analytics → Recent Orders → Insights row), with the Quick Actions bar in a sticky header.

- [ ] **Step 1: Replace App.tsx with the full assembly**

```tsx
import { QuickActionsBar } from "./components/dashboard/QuickActionsBar";
import { KpiRow } from "./components/dashboard/KpiRow";
import { OperationCenter } from "./components/dashboard/OperationCenter";
import { InventoryMonitoringCard } from "./components/dashboard/InventoryMonitoringCard";
import { ExpirationsTable } from "./components/dashboard/ExpirationsTable";
import { SalesAnalyticsCard } from "./components/dashboard/SalesAnalyticsCard";
import { RecentOrdersTable } from "./components/dashboard/RecentOrdersTable";
import { BusinessHealthGrid } from "./components/dashboard/BusinessHealthGrid";
import { TopProductsList } from "./components/dashboard/TopProductsList";

export default function App() {
  return (
    <div className="min-h-screen bg-paper">
      <header className="sticky top-0 z-10 flex flex-col gap-3 border-b border-line bg-paper/90 px-4 py-3 backdrop-blur sm:flex-row sm:items-center sm:justify-between sm:px-6">
        <h1 className="font-display text-2xl font-semibold tracking-tight text-ink">Shop Admin</h1>
        <QuickActionsBar />
      </header>

      <main className="flex flex-col gap-6 p-4 sm:p-6">
        <KpiRow />
        <OperationCenter />
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          <InventoryMonitoringCard />
          <ExpirationsTable />
        </div>
        <SalesAnalyticsCard />
        <RecentOrdersTable />
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          <BusinessHealthGrid />
          <TopProductsList />
        </div>
      </main>
    </div>
  );
}
```

- [ ] **Step 2: Build the client**

Run: `pnpm --filter @app/web-admin-client build`
Expected: build succeeds with all sections bundled.

- [ ] **Step 3: Re-verify the shell route still serves the built page**

Run: `pnpm vitest run apps/web-admin/test/web.test.ts`
(From Phase 2, the test that exercises `GET /` serving the SPA shell with the injected CSRF token lives in `web.test.ts`. If a grep shows the SPA-shell test landed in a different file, run that one instead.)
Expected: PASS — the shell route still injects the real CSRF token and serves the now-fuller bundle.

- [ ] **Step 4: Full repo verification**

Run: `pnpm typecheck`
Expected: PASS across all workspace projects + the client.

Run: `pnpm test`
Expected: PASS except the 2 known-pre-existing `notifications.test.ts` `enqueueOrderPipelineFailed` failures (confirm no NEW failures, and that all new client component tests are green).

- [ ] **Step 5: Commit**

```bash
git add apps/web-admin/client/src/App.tsx
git commit -m "feat(web-admin): assemble the full dashboard layout"
```

---

### Task 12: Retire the orphaned Nunjucks SLA route

The Phase-2 cutover removed the `GET /` Nunjucks dashboard but intentionally left `GET /partials/dashboard-sla` (and its `slaContext`/`shapeRevenue` helpers + `_sla.njk` template) in place as now-unreachable code (its only caller was the removed dashboard page). The React Operation Center + Expirations sections now cover those signals, so this dead route can go.

**Files:**
- Modify: `apps/web-admin/src/routes/dashboard.ts` — remove the `/partials/dashboard-sla` handler + `slaContext` + `shapeRevenue` + now-unused imports
- Delete: `apps/web-admin/views/_sla.njk`
- Modify: `apps/web-admin/test/web.test.ts` — remove any test that asserts on `/partials/dashboard-sla` (if present)

**Interfaces:**
- Produces: nothing new; removes dead code. After this task `dashboard.ts` should either be empty of routes (delete the file + its `server.ts` registration) or contain only still-live handlers.

- [ ] **Step 1: Find every reference before deleting**

Run (Git Bash):
```bash
grep -rn "dashboard-sla\|slaContext\|shapeRevenue\|_sla.njk" apps/web-admin/src apps/web-admin/views apps/web-admin/test
```
Record every hit. The expected hits are: the route + helpers in `dashboard.ts`, the `_sla.njk` template, and possibly a poll target reference. If `grep` finds a reference in any file NOT listed in this task's Files section, STOP and report it — something still depends on this and the task's assumption is wrong.

- [ ] **Step 2: Check whether `dashboard.ts` has any remaining live route**

Read `apps/web-admin/src/routes/dashboard.ts`. After Phase 2 removed `GET /`, the only remaining handler should be `GET /partials/dashboard-sla`. If so, removing it leaves the file with no routes — in that case, delete `apps/web-admin/src/routes/dashboard.ts` entirely and remove its `import dashboardRoutes from "./routes/dashboard"` + `await app.register(dashboardRoutes);` lines from `apps/web-admin/src/server.ts`. If `dashboard.ts` still has another live handler, only remove the SLA handler + the two now-unused helpers (`slaContext`, `shapeRevenue`) + their now-unused imports.

- [ ] **Step 3: Apply the removals**

Delete `apps/web-admin/views/_sla.njk`. Apply the `dashboard.ts`/`server.ts` edits decided in Step 2. Remove any `/partials/dashboard-sla` test block from `web.test.ts`.

- [ ] **Step 4: Verify nothing broke**

Run: `pnpm --filter @app/web-admin typecheck`
Expected: PASS (no dangling import of a deleted symbol).

Run: `pnpm vitest run apps/web-admin/test/web.test.ts`
Expected: PASS — every remaining route test still green; no test references the removed route.

Run: `pnpm test`
Expected: PASS except the 2 known-pre-existing `notifications.test.ts` failures.

- [ ] **Step 5: Commit**

```bash
git add -A apps/web-admin
git commit -m "chore(web-admin): retire the orphaned Nunjucks SLA partial route"
```

---

## Verification (end-to-end, after all tasks)

- `pnpm --filter @app/web-admin-client build` succeeds, and `pnpm typecheck` + `pnpm test` are green from the repo root (modulo the 2 pre-existing `notifications.test.ts` failures).
- Start the app (`pnpm dev:web` after building the client) and log in as an admin at `/`. Confirm the full dashboard renders: 4 KPI cards, 5 Operation Center cards, Inventory + Expirations row, the Sales Analytics chart with working 7d/30d · IDR/USDT/Combined · Revenue/Orders filter buttons, the Recent Orders table, and the Business Health + Top Products row, with the Quick Actions bar in a sticky header.
- **The currency check:** confirm no card or table ever renders two currencies joined into one string — Revenue/Profit KPI cards stack per-currency rows; a USDT order in Recent Orders shows e.g. "3.43 USDT", never "Rp3".
- Click an Operation Center card (e.g. Failed Deliveries) and an order code in a table — confirm they navigate to the correct existing admin page (`/payments?outcome=delivery_failed`, `/orders/:id`).
- Confirm Business Health shows "Unmonitored" (gray) for Bybit/TokoPay/PayDisini/NOWPayments, not a fabricated green.
- Confirm `GET /partials/dashboard-sla` now 404s (route retired) and every other admin page is unaffected.

## Out of scope (future work)

- Refill / Renew / Contact-Customer action buttons on the Inventory and Expirations sections (the spec lists them, but they require new mutating endpoints — this plan's `apiPost` CSRF bridge is ready for them, but the endpoints and their tests are a separate plan).
- Migrating any other admin page (products, orders, customers, etc.) off Nunjucks — each is its own future spec + plan.
