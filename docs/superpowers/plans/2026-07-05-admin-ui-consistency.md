# Admin UI Consistency Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make all 12 admin SPA pages (`apps/web-admin/client`) share identical spacing rhythm, card treatment, typography, and control sizing by consolidating onto the shared component library that already exists (from PR #29), fixing the concrete drift found in a full-codebase audit, and deleting the one-off patterns that caused it.

**Architecture:** No new design-token system — the existing storefront-sourced tokens (`index.css`) and shared components (`PageHeader`, `FilterBar`, `DataTable`, `StatusBadge`, `Card`, `Button`, `Switch`, `Badge`) are the foundation. This plan adds three small new components (`SearchBar`, `ProgressBar`, `CardRow`), extends `StatusBadge`'s tone map, fixes one real spacing bug, and migrates all 12 pages onto the shared components, deleting hand-rolled equivalents.

**Tech Stack:** React 18 + TypeScript, Tailwind v4 (CSS-first tokens in `index.css`), shadcn/radix-ui primitives, Vitest + `@testing-library/react`, TanStack Query.

**Spec:** `docs/superpowers/specs/2026-07-05-admin-ui-consistency-design.md` (as corrected after this planning pass's source review).

## Global Constraints

- No new spacing/color/radius/shadow tokens — reuse the existing `index.css` tokens and Tailwind's default 4/8/12/16/24/32px scale exactly as documented in the spec.
- Do **not** create `PrimaryButton`, `SecondaryButton`, or `StatusSwitch` components — reuse the existing `Button` variants and `Switch` component everywhere.
- `CardFooter` already exists in `components/ui/card.tsx` — do not recreate it. "CardDivider" is not a component — it's the existing `divide-y divide-line` class applied to `CardContent`.
- This is a visual-consistency pass only — no business-logic or API changes. If a task appears to require one, stop and flag it instead of improvising.
- All work lands in one branch/PR (per the user's chosen rollout scope) — do not split into multiple PRs.
- `pnpm --filter @app/web-admin-client build`, `pnpm typecheck`, and `pnpm test` must stay green throughout (per `CLAUDE.md`).
- These tasks are refactors of already-tested pages (behavior is unchanged, only markup/classes move) — the per-page tasks below use a **regression-test cycle** (run the page's existing test file before and after the edit) rather than a new-feature RED/GREEN cycle. Genuinely new components (`SearchBar`, `ProgressBar`, `CardRow`, and the `StatusBadge` extension) do use full TDD.

## Scope notes (decided during planning, not in the original spec)

- **`SearchBar` is used only for the three pages with a single freestanding text filter** (Catalog, Stock, Users). Orders' "Search" field is one of four labeled fields in a structured filter form (Status/Search/From/To) — forcing it into the icon-adorned `SearchBar` would look inconsistent next to its Select/DateInput siblings, so it stays a plain labeled `Input`.
- **Two badge cases are deliberately left as shadcn `Badge`, not `StatusBadge`:** AdminsPage's "You" self-tag (a decorative flag, not a status) and its Pwd/2FA `✓` checkmark columns (converting a checkmark into a `StatusBadge` would force a fake status string like `"✓"` through a title-casing pipeline built for real status words — no visual or semantic win, real risk of an awkward render). Every other Badge-for-status-like-value case found in the audit does convert to `StatusBadge`.
- **`UsersPage`'s avatar-initial chip uses `bg-teal`**, a raw Tailwind default color that isn't part of the app's ported palette at all (not `pine`/`grass`/`amberx`/`rust`/etc.) — this is fixed to `bg-pine` alongside the page's other changes.

---

### Task 1: Fix DashboardPage's double-gap bug

**Files:**
- Modify: `apps/web-admin/client/src/pages/DashboardPage.tsx:11-29`

**Interfaces:**
- Consumes: `PageHeader` (unchanged), `KpiRow`/`OperationCenter`/etc. (unchanged)
- Produces: nothing new — this is a structural JSX fix only

- [ ] **Step 1: Confirm the current baseline test passes**

Run: `pnpm --filter @app/web-admin-client test -- DashboardPage`
Expected: no test file exists for `DashboardPage` today (it has no `.test.tsx`) — command reports no matching tests. This is expected; there is no regression baseline to protect here, so proceed directly to the fix.

- [ ] **Step 2: Move `PageHeader` outside the `gap-6` wrapper**

Replace the full component body:

```tsx
import { KpiRow } from "../components/dashboard/KpiRow";
import { OperationCenter } from "../components/dashboard/OperationCenter";
import { InventoryMonitoringCard } from "../components/dashboard/InventoryMonitoringCard";
import { ExpirationsTable } from "../components/dashboard/ExpirationsTable";
import { SalesAnalyticsCard } from "../components/dashboard/SalesAnalyticsCard";
import { RecentOrdersTable } from "../components/dashboard/RecentOrdersTable";
import { BusinessHealthGrid } from "../components/dashboard/BusinessHealthGrid";
import { TopProductsList } from "../components/dashboard/TopProductsList";
import { PageHeader } from "../components/shared/PageHeader";

export function DashboardPage() {
  return (
    <>
      <PageHeader title="Dashboard" />
      <div className="flex flex-col gap-6">
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
      </div>
    </>
  );
}
```

- [ ] **Step 3: Run typecheck**

Run: `pnpm typecheck`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add apps/web-admin/client/src/pages/DashboardPage.tsx
git commit -m "fix(web-admin): stop doubling Dashboard's title-to-content gap"
```

---

### Task 2: Extend StatusBadge's tone map

**Files:**
- Modify: `apps/web-admin/client/src/components/shared/StatusBadge.tsx:1-16`
- Test: `apps/web-admin/client/src/components/shared/StatusBadge.test.tsx`

**Interfaces:**
- Consumes: nothing new
- Produces: `StatusBadge({ status: string })` unchanged signature; `TONE` map gains: `BANNED`, `OUT_OF_STOCK`, `LOW_STOCK`, `EXPIRING_SOON`, `MATCHED`, `DELIVERY_FAILED`, `UNMATCHED`, `SENT` (tasks 7, 9, 10, 12, 14 rely on these exact keys existing).

- [ ] **Step 1: Write the failing tests**

Add to `apps/web-admin/client/src/components/shared/StatusBadge.test.tsx`:

```tsx
  it("uses the red tone for a banned user", () => {
    const { container } = render(<StatusBadge status="BANNED" />);
    expect(container.querySelector(".bg-rust-tint")).not.toBeNull();
  });

  it("uses the red tone for out-of-stock", () => {
    const { container } = render(<StatusBadge status="OUT_OF_STOCK" />);
    expect(container.querySelector(".bg-rust-tint")).not.toBeNull();
  });

  it("uses the amber tone for low stock", () => {
    const { container } = render(<StatusBadge status="LOW_STOCK" />);
    expect(container.querySelector(".bg-amberx-tint")).not.toBeNull();
  });

  it("uses the amber tone for a voucher expiring soon", () => {
    const { container } = render(<StatusBadge status="EXPIRING_SOON" />);
    expect(container.querySelector(".bg-amberx-tint")).not.toBeNull();
  });

  it("uses the green tone for a matched payment", () => {
    const { container } = render(<StatusBadge status="MATCHED" />);
    expect(container.querySelector(".bg-grass-tint")).not.toBeNull();
  });

  it("uses the red tone for a payment delivery failure", () => {
    const { container } = render(<StatusBadge status="DELIVERY_FAILED" />);
    expect(container.querySelector(".bg-rust-tint")).not.toBeNull();
  });

  it("uses the amber tone for an unmatched payment", () => {
    const { container } = render(<StatusBadge status="UNMATCHED" />);
    expect(container.querySelector(".bg-amberx-tint")).not.toBeNull();
  });

  it("uses the green tone for a sent outbox notification", () => {
    const { container } = render(<StatusBadge status="SENT" />);
    expect(container.querySelector(".bg-grass-tint")).not.toBeNull();
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @app/web-admin-client test -- StatusBadge`
Expected: the 8 new tests FAIL (unmapped statuses fall back to the `neutral`/`bg-sand` tone), existing tests still pass.

- [ ] **Step 3: Add the new tone entries**

In `apps/web-admin/client/src/components/shared/StatusBadge.tsx`, replace the `TONE` map:

```tsx
const TONE: Record<string, Tone> = {
  DELIVERED: "success",
  PAID: "success",
  MATCHED: "success",
  SENT: "success",
  PENDING_PAYMENT: "warning",
  PAYMENT_DETECTED: "warning",
  CONFIRMING: "warning",
  CONFIRMED: "warning",
  PENDING_VERIFICATION: "warning",
  UNDERPAID: "warning",
  LOW_STOCK: "warning",
  EXPIRING_SOON: "warning",
  UNMATCHED: "warning",
  CANCELLED: "danger",
  REJECTED: "danger",
  FAILED: "danger",
  BANNED: "danger",
  OUT_OF_STOCK: "danger",
  DELIVERY_FAILED: "danger",
  REFUNDED: "neutral",
};
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @app/web-admin-client test -- StatusBadge`
Expected: PASS (all tests, old and new).

- [ ] **Step 5: Commit**

```bash
git add apps/web-admin/client/src/components/shared/StatusBadge.tsx apps/web-admin/client/src/components/shared/StatusBadge.test.tsx
git commit -m "feat(web-admin): extend StatusBadge tones for stock/voucher/payment/outbox statuses"
```

---

### Task 3: Create the SearchBar component

**Files:**
- Create: `apps/web-admin/client/src/components/shared/SearchBar.tsx`
- Test: `apps/web-admin/client/src/components/shared/SearchBar.test.tsx`

**Interfaces:**
- Consumes: `Input` (`@/components/ui/input`), `cn` (`@/lib/utils`), `Search` icon (`lucide-react`)
- Produces: `SearchBar({ value: string; onChange: (value: string) => void; placeholder?: string; className?: string })` — tasks 6, 7, 9 import this exact signature.

- [ ] **Step 1: Write the failing test**

```tsx
import "@testing-library/jest-dom";
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { SearchBar } from "./SearchBar";

describe("SearchBar", () => {
  it("renders the placeholder and current value", () => {
    render(<SearchBar value="socks" onChange={() => {}} placeholder="Search…" />);
    expect(screen.getByPlaceholderText("Search…")).toHaveValue("socks");
  });

  it("calls onChange with the new value on typing", () => {
    const onChange = vi.fn();
    render(<SearchBar value="" onChange={onChange} placeholder="Search…" />);
    fireEvent.change(screen.getByPlaceholderText("Search…"), { target: { value: "hi" } });
    expect(onChange).toHaveBeenCalledWith("hi");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @app/web-admin-client test -- SearchBar`
Expected: FAIL — `Cannot find module './SearchBar'`.

- [ ] **Step 3: Write the component**

```tsx
import { Search } from "lucide-react";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

interface SearchBarProps {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  className?: string;
}

export function SearchBar({ value, onChange, placeholder, className }: SearchBarProps): JSX.Element {
  return (
    <div className={cn("relative w-full sm:w-64", className)}>
      <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-faint" />
      <Input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="pl-8"
      />
    </div>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @app/web-admin-client test -- SearchBar`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web-admin/client/src/components/shared/SearchBar.tsx apps/web-admin/client/src/components/shared/SearchBar.test.tsx
git commit -m "feat(web-admin): add shared SearchBar component"
```

---

### Task 4: Create the ProgressBar component

**Files:**
- Create: `apps/web-admin/client/src/components/shared/ProgressBar.tsx`
- Test: `apps/web-admin/client/src/components/shared/ProgressBar.test.tsx`

**Interfaces:**
- Consumes: `cn` (`@/lib/utils`)
- Produces: `ProgressBar({ value: number; tone: "grass" | "amberx" | "rust"; className?: string })` — task 7 imports this exact signature. `value` is clamped to `[0, 100]` internally.

- [ ] **Step 1: Write the failing test**

```tsx
import "@testing-library/jest-dom";
import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { ProgressBar } from "./ProgressBar";

describe("ProgressBar", () => {
  it("renders the fill at the given percentage width", () => {
    const { container } = render(<ProgressBar value={42} tone="grass" />);
    const fill = container.querySelector(".bg-grass") as HTMLElement;
    expect(fill.style.width).toBe("42%");
  });

  it("clamps values above 100", () => {
    const { container } = render(<ProgressBar value={150} tone="rust" />);
    const fill = container.querySelector(".bg-rust") as HTMLElement;
    expect(fill.style.width).toBe("100%");
  });

  it("clamps negative values to 0", () => {
    const { container } = render(<ProgressBar value={-10} tone="amberx" />);
    const fill = container.querySelector(".bg-amberx") as HTMLElement;
    expect(fill.style.width).toBe("0%");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @app/web-admin-client test -- ProgressBar`
Expected: FAIL — `Cannot find module './ProgressBar'`.

- [ ] **Step 3: Write the component**

```tsx
import { cn } from "@/lib/utils";

type ProgressBarTone = "grass" | "amberx" | "rust";

interface ProgressBarProps {
  value: number;
  tone: ProgressBarTone;
  className?: string;
}

const TONE_CLASS: Record<ProgressBarTone, string> = {
  grass: "bg-grass",
  amberx: "bg-amberx",
  rust: "bg-rust",
};

export function ProgressBar({ value, tone, className }: ProgressBarProps): JSX.Element {
  const pct = Math.max(0, Math.min(100, value));
  return (
    <div className={cn("h-1.5 w-full overflow-hidden rounded-full bg-sand", className)}>
      <div
        className={cn("h-full rounded-full transition-all", TONE_CLASS[tone])}
        style={{ width: `${pct}%` }}
      />
    </div>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @app/web-admin-client test -- ProgressBar`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web-admin/client/src/components/shared/ProgressBar.tsx apps/web-admin/client/src/components/shared/ProgressBar.test.tsx
git commit -m "feat(web-admin): add shared ProgressBar component"
```

---

### Task 5: Create the CardRow component

**Files:**
- Create: `apps/web-admin/client/src/components/shared/CardRow.tsx`
- Test: `apps/web-admin/client/src/components/shared/CardRow.test.tsx`

**Interfaces:**
- Consumes: `cn` (`@/lib/utils`)
- Produces: `CardRow({ label: ReactNode; value: ReactNode; className?: string })` — task 16 imports this exact signature. Intended to be stacked inside a `CardContent` that has `className="divide-y divide-line"`.

- [ ] **Step 1: Write the failing test**

```tsx
import "@testing-library/jest-dom";
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { CardRow } from "./CardRow";

describe("CardRow", () => {
  it("renders the label and value", () => {
    render(<CardRow label="Telegram ID" value="123456" />);
    expect(screen.getByText("Telegram ID")).toBeInTheDocument();
    expect(screen.getByText("123456")).toBeInTheDocument();
  });

  it("accepts a ReactNode as the value", () => {
    render(<CardRow label="Role" value={<span data-testid="role-value">Admin</span>} />);
    expect(screen.getByTestId("role-value")).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @app/web-admin-client test -- CardRow`
Expected: FAIL — `Cannot find module './CardRow'`.

- [ ] **Step 3: Write the component**

```tsx
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

interface CardRowProps {
  label: ReactNode;
  value: ReactNode;
  className?: string;
}

export function CardRow({ label, value, className }: CardRowProps): JSX.Element {
  return (
    <div className={cn("flex items-center justify-between py-2", className)}>
      <span className="text-sm text-ink-soft">{label}</span>
      <div className="text-sm text-ink">{value}</div>
    </div>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @app/web-admin-client test -- CardRow`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web-admin/client/src/components/shared/CardRow.tsx apps/web-admin/client/src/components/shared/CardRow.test.tsx
git commit -m "feat(web-admin): add shared CardRow component"
```

---

### Task 6: Migrate CatalogPage onto SearchBar

**Files:**
- Modify: `apps/web-admin/client/src/pages/CatalogPage.tsx:345-355`

**Interfaces:**
- Consumes: `SearchBar` from Task 3 (`{ value, onChange, placeholder, className }`)

- [ ] **Step 1: Confirm baseline**

Run: `pnpm --filter @app/web-admin-client test -- CatalogPage`
Expected: PASS (record this as the regression baseline; there is no `CatalogPage.test.tsx` behavior change planned).

- [ ] **Step 2: Replace the filter Input with SearchBar**

Add the import:

```tsx
import { SearchBar } from "../components/shared/SearchBar";
```

Replace:

```tsx
      <FilterBar
        onClear={filter ? () => setFilter("") : undefined}
        className="mb-4"
      >
        <Input
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="Filter by product or category…"
          className="w-64"
        />
      </FilterBar>
```

with:

```tsx
      <FilterBar
        onClear={filter ? () => setFilter("") : undefined}
        className="mb-4"
      >
        <SearchBar
          value={filter}
          onChange={setFilter}
          placeholder="Filter by product or category…"
        />
      </FilterBar>
```

(The `Input` import stays — it's still used by `CategoryEditDialog` and the CSV-import textarea's neighboring fields elsewhere in the file.)

- [ ] **Step 3: Run tests and typecheck**

Run: `pnpm --filter @app/web-admin-client test -- CatalogPage && pnpm typecheck`
Expected: PASS, no errors.

- [ ] **Step 4: Commit**

```bash
git add apps/web-admin/client/src/pages/CatalogPage.tsx
git commit -m "refactor(web-admin): use shared SearchBar on CatalogPage"
```

---

### Task 7: Migrate StockPage onto SearchBar, ProgressBar, and StatusBadge

**Files:**
- Modify: `apps/web-admin/client/src/pages/StockPage.tsx`

**Interfaces:**
- Consumes: `SearchBar` (Task 3), `ProgressBar` (Task 4), `StatusBadge` with `OUT_OF_STOCK`/`LOW_STOCK` tones (Task 2)

- [ ] **Step 1: Confirm baseline**

Run: `pnpm --filter @app/web-admin-client test -- StockPage`
Expected: PASS (3 existing tests: shows rows, empty state, error state — none inspect exact classNames, so they remain valid after this markup change).

- [ ] **Step 2: Swap imports**

Replace:

```tsx
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Boxes } from "lucide-react";
```

with:

```tsx
import { Button } from "@/components/ui/button";
import { Boxes } from "lucide-react";
import { SearchBar } from "../components/shared/SearchBar";
import { ProgressBar } from "../components/shared/ProgressBar";
import { StatusBadge } from "../components/shared/StatusBadge";
```

- [ ] **Step 3: Replace the filter Input with SearchBar**

Replace:

```tsx
      <FilterBar
        onClear={filter ? () => setFilter("") : undefined}
        className="mb-4"
      >
        <Input
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="Filter by denomination, product, or category…"
          className="w-80"
        />
      </FilterBar>
```

with:

```tsx
      <FilterBar
        onClear={filter ? () => setFilter("") : undefined}
        className="mb-4"
      >
        <SearchBar
          value={filter}
          onChange={setFilter}
          placeholder="Filter by denomination, product, or category…"
        />
      </FilterBar>
```

- [ ] **Step 4: Replace the hand-rolled stock bar with ProgressBar**

Replace the `stock` column's `render`:

```tsx
          {
            key: "stock",
            header: "Stock",
            render: (row) => {
              const cnt = data?.counts[String(row.id)];
              const available = cnt?.available ?? 0;
              const reserved = cnt?.reserved ?? 0;
              const sold = cnt?.sold ?? 0;
              const total = available + reserved + sold;
              const pct = total > 0 ? Math.round((available / total) * 100) : 0;
              return (
                <div className="min-w-[120px]">
                  <div className="flex justify-between text-xs mb-1">
                    <span className="text-ink-soft">{available} ready</span>
                    <span className="text-ink-soft">{pct}%</span>
                  </div>
                  <div className="h-1.5 w-full rounded-full bg-sand overflow-hidden">
                    <div
                      className={`h-full rounded-full transition-all ${
                        pct < 20 ? "bg-rust" : pct < 50 ? "bg-amberx" : "bg-grass"
                      }`}
                      style={{ width: `${pct}%` }}
                    />
                  </div>
                </div>
              );
            },
          },
```

with:

```tsx
          {
            key: "stock",
            header: "Stock",
            render: (row) => {
              const cnt = data?.counts[String(row.id)];
              const available = cnt?.available ?? 0;
              const reserved = cnt?.reserved ?? 0;
              const sold = cnt?.sold ?? 0;
              const total = available + reserved + sold;
              const pct = total > 0 ? Math.round((available / total) * 100) : 0;
              const tone = pct < 20 ? "rust" : pct < 50 ? "amberx" : "grass";
              return (
                <div className="min-w-[120px]">
                  <div className="flex justify-between text-xs mb-1">
                    <span className="text-ink-soft">{available} ready</span>
                    <span className="text-ink-soft">{pct}%</span>
                  </div>
                  <ProgressBar value={pct} tone={tone} />
                </div>
              );
            },
          },
```

- [ ] **Step 5: Replace the destructive Badge with StatusBadge**

Replace:

```tsx
          {
            key: "status",
            header: "Status",
            render: (row) => {
              const cnt = data?.counts[String(row.id)];
              const available = cnt?.available ?? 0;
              if (available === 0) {
                return <Badge variant="destructive">Out of Stock</Badge>;
              }
              if (available < 5) {
                return <Badge variant="destructive">Low Stock</Badge>;
              }
              return null;
            },
          },
```

with:

```tsx
          {
            key: "status",
            header: "Status",
            render: (row) => {
              const cnt = data?.counts[String(row.id)];
              const available = cnt?.available ?? 0;
              if (available === 0) {
                return <StatusBadge status="OUT_OF_STOCK" />;
              }
              if (available < 5) {
                return <StatusBadge status="LOW_STOCK" />;
              }
              return null;
            },
          },
```

- [ ] **Step 6: Run tests and typecheck**

Run: `pnpm --filter @app/web-admin-client test -- StockPage && pnpm typecheck`
Expected: PASS, no errors.

- [ ] **Step 7: Commit**

```bash
git add apps/web-admin/client/src/pages/StockPage.tsx
git commit -m "refactor(web-admin): use shared SearchBar/ProgressBar/StatusBadge on StockPage"
```

---

### Task 8: Fix OrdersPage's pagination button sizing

**Files:**
- Modify: `apps/web-admin/client/src/pages/OrdersPage.tsx:248-267`

**Interfaces:** none — pure className fix, matches the `size="sm"` convention already used by Outbox/Payments' equivalent Prev/Next controls.

- [ ] **Step 1: Confirm baseline**

Run: `pnpm --filter @app/web-admin-client test -- OrdersPage`
Expected: PASS.

- [ ] **Step 2: Add `size="sm"` to both pagination buttons**

Replace:

```tsx
      {data && (
        <div className="flex gap-2 mt-4">
          {data.page > 1 && (
            <Button
              variant="outline"
              onClick={() => setFilters((f) => ({ ...f, page: f.page - 1 }))}
            >
              ← Prev
            </Button>
          )}
          {data.hasNext && (
            <Button
              variant="outline"
              onClick={() => setFilters((f) => ({ ...f, page: f.page + 1 }))}
            >
              Next →
            </Button>
          )}
        </div>
      )}
```

with:

```tsx
      {data && (
        <div className="flex gap-2 mt-4">
          {data.page > 1 && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => setFilters((f) => ({ ...f, page: f.page - 1 }))}
            >
              ← Prev
            </Button>
          )}
          {data.hasNext && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => setFilters((f) => ({ ...f, page: f.page + 1 }))}
            >
              Next →
            </Button>
          )}
        </div>
      )}
```

- [ ] **Step 3: Run tests**

Run: `pnpm --filter @app/web-admin-client test -- OrdersPage`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add apps/web-admin/client/src/pages/OrdersPage.tsx
git commit -m "fix(web-admin): match OrdersPage pagination button size to Outbox/Payments"
```

---

### Task 9: Migrate UsersPage onto SearchBar and StatusBadge

**Files:**
- Modify: `apps/web-admin/client/src/pages/UsersPage.tsx`

**Interfaces:**
- Consumes: `SearchBar` (Task 3), `StatusBadge` with `BANNED` tone (Task 2)

- [ ] **Step 1: Confirm baseline**

Run: `pnpm --filter @app/web-admin-client test -- UsersPage`
Expected: PASS.

- [ ] **Step 2: Swap imports**

Replace:

```tsx
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Users } from "lucide-react";
```

with:

```tsx
import { Button } from "@/components/ui/button";
import { Users } from "lucide-react";
import { SearchBar } from "../components/shared/SearchBar";
import { StatusBadge } from "../components/shared/StatusBadge";
```

- [ ] **Step 3: Replace the search form's Input with SearchBar**

Replace:

```tsx
      <form
        onSubmit={(e) => {
          e.preventDefault();
          setQ(input.trim());
        }}
        className="mb-4"
      >
        <FilterBar>
          <Input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="Search by name, username, Telegram ID…"
            className="w-80"
          />
```

with:

```tsx
      <form
        onSubmit={(e) => {
          e.preventDefault();
          setQ(input.trim());
        }}
        className="mb-4"
      >
        <FilterBar>
          <SearchBar
            value={input}
            onChange={setInput}
            placeholder="Search by name, username, Telegram ID…"
          />
```

- [ ] **Step 4: Fix the avatar chip's off-palette color and convert role/banned Badges**

Replace:

```tsx
                <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-teal text-xs font-semibold text-white">
```

with:

```tsx
                <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-pine text-xs font-semibold text-white">
```

Replace:

```tsx
          {
            key: "role",
            header: "Role",
            render: (row) => <Badge variant="outline">{row.role}</Badge>,
          },
          {
            key: "status",
            header: "Status",
            render: (row) =>
              row.banned ? (
                <Badge variant="destructive">Banned</Badge>
              ) : null,
          },
```

with:

```tsx
          {
            key: "role",
            header: "Role",
            render: (row) => <StatusBadge status={row.role} />,
          },
          {
            key: "status",
            header: "Status",
            render: (row) => (row.banned ? <StatusBadge status="BANNED" /> : null),
          },
```

- [ ] **Step 5: Run tests and typecheck**

Run: `pnpm --filter @app/web-admin-client test -- UsersPage && pnpm typecheck`
Expected: PASS, no errors.

- [ ] **Step 6: Commit**

```bash
git add apps/web-admin/client/src/pages/UsersPage.tsx
git commit -m "refactor(web-admin): use shared SearchBar/StatusBadge on UsersPage, fix off-palette avatar color"
```

---

### Task 10: Migrate VouchersPage onto StatusBadge and Switch

**Files:**
- Modify: `apps/web-admin/client/src/pages/VouchersPage.tsx`

**Interfaces:**
- Consumes: `StatusBadge` with `EXPIRING_SOON` tone (Task 2), existing `Switch` (`@/components/ui/switch`)

- [ ] **Step 1: Confirm baseline**

Run: `pnpm --filter @app/web-admin-client test -- VouchersPage`
Expected: PASS.

- [ ] **Step 2: Swap imports**

Replace:

```tsx
import { Badge } from "@/components/ui/badge";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
```

with:

```tsx
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { StatusBadge } from "../components/shared/StatusBadge";
```

(`Badge` stays imported — it's still used for the Type column, which is a plain category tag, not converted per the "no exceptions" rule not applying to non-status tags... actually per spec, Type should also route through the same visual system. See Step 3.)

- [ ] **Step 3: Convert Type badge and the "Expiring soon" pill to StatusBadge**

Replace:

```tsx
          {
            key: "type",
            header: "Type",
            render: v => <Badge variant="outline">{v.type}</Badge>,
          },
```

with:

```tsx
          {
            key: "type",
            header: "Type",
            render: v => <StatusBadge status={v.type} />,
          },
```

Replace:

```tsx
          {
            key: "expires",
            header: "Expires",
            render: v => (
              <div className="flex flex-col items-start gap-1">
                <span>{v.expiresAt ? v.expiresAt.slice(0, 10) : "—"}</span>
                {isExpiringSoon(v, now) && (
                  <span className="inline-flex w-fit items-center rounded-full bg-amberx-tint px-1.5 py-0.5 text-[10px] font-semibold text-amberx">
                    Expiring soon
                  </span>
                )}
              </div>
            ),
          },
```

with:

```tsx
          {
            key: "expires",
            header: "Expires",
            render: v => (
              <div className="flex flex-col items-start gap-1">
                <span>{v.expiresAt ? v.expiresAt.slice(0, 10) : "—"}</span>
                {isExpiringSoon(v, now) && <StatusBadge status="EXPIRING_SOON" />}
              </div>
            ),
          },
```

Now `Badge` is unused — remove its import entirely (replace the import block from Step 2 with just `Switch`, `Card`/etc., and `StatusBadge`, no `Badge`).

- [ ] **Step 4: Replace the raw checkbox with Switch**

Replace:

```tsx
          {
            key: "active",
            header: "Active",
            render: v => (
              <input
                type="checkbox"
                checked={v.isActive}
                onChange={e => toggle.mutate({ id: v.id, active: e.target.checked })}
                className="h-4 w-4"
              />
            ),
          },
```

with:

```tsx
          {
            key: "active",
            header: "Active",
            render: v => (
              <Switch
                checked={v.isActive}
                onCheckedChange={(checked) => toggle.mutate({ id: v.id, active: checked })}
              />
            ),
          },
```

- [ ] **Step 5: Run tests and typecheck**

Run: `pnpm --filter @app/web-admin-client test -- VouchersPage && pnpm typecheck`
Expected: PASS, no errors.

- [ ] **Step 6: Commit**

```bash
git add apps/web-admin/client/src/pages/VouchersPage.tsx
git commit -m "refactor(web-admin): use shared StatusBadge/Switch on VouchersPage"
```

---

### Task 11: Migrate SettingsPage banners onto Sonner toast and fix the raw checkbox

**Files:**
- Modify: `apps/web-admin/client/src/pages/SettingsPage.tsx`

**Interfaces:**
- Consumes: `toast` from `"sonner"` (the app's `<Toaster />` is already mounted globally in `AppShell.tsx`), existing `Switch` (`@/components/ui/switch`)

- [ ] **Step 1: Confirm baseline**

Run: `pnpm --filter @app/web-admin-client test -- SettingsPage`
Expected: PASS (record baseline before touching state logic).

- [ ] **Step 2: Add the sonner import**

Add to the top of the file:

```tsx
import { toast } from "sonner";
```

- [ ] **Step 3: Replace the payment-toggle success/error state with toast calls**

Replace the `togglePayment` mutation and its surrounding `paymentError`/`paymentSuccess` state:

```tsx
  const [paymentError, setPaymentError] = useState<string | null>(null);
  const [paymentSuccess, setPaymentSuccess] = useState<string | null>(null);

  useEffect(() => {
    if (!paymentSuccess) return;
    const timer = setTimeout(() => setPaymentSuccess(null), 2500);
    return () => clearTimeout(timer);
  }, [paymentSuccess]);

  useEffect(() => {
    if (!paymentError) return;
    const timer = setTimeout(() => setPaymentError(null), 2500);
    return () => clearTimeout(timer);
  }, [paymentError]);

  const togglePayment = useMutation({
    mutationFn: ({ method, enabled }: { method: string; enabled: boolean }) =>
      apiPost("/api/settings/payments/toggle", { method, enabled: enabled ? "true" : "false" }),
    onSuccess: () => {
      invalidate();
      setPaymentSuccess("Payment method updated");
      setPaymentError(null);
    },
    onError: (error: Error) => {
      setPaymentError(error.message || "Failed to update payment method");
      setPaymentSuccess(null);
    },
  });
```

with:

```tsx
  const togglePayment = useMutation({
    mutationFn: ({ method, enabled }: { method: string; enabled: boolean }) =>
      apiPost("/api/settings/payments/toggle", { method, enabled: enabled ? "true" : "false" }),
    onSuccess: () => {
      invalidate();
      toast.success("Payment method updated");
    },
    onError: (error: Error) => {
      toast.error(error.message || "Failed to update payment method");
    },
  });
```

Remove the now-unused banner JSX:

```tsx
          {/* Payment Credentials — one card per method */}
          {paymentError && (
            <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
              {paymentError}
            </div>
          )}
          {paymentSuccess && (
            <div className="rounded-lg border border-green-200 bg-green-50 px-4 py-3 text-sm text-green-700">
              {paymentSuccess}
            </div>
          )}
```

becomes just the comment line:

```tsx
          {/* Payment Credentials — one card per method */}
```

- [ ] **Step 4: Replace the FX refresh success/error banners with toast calls**

Replace:

```tsx
  const [fxSuccess, setFxSuccess] = useState<string | null>(null);
  const [fxError, setFxError] = useState<string | null>(null);
  const [fxRefreshing, setFxRefreshing] = useState(false);

  useEffect(() => {
    if (!fxSuccess) return;
    const timer = setTimeout(() => setFxSuccess(null), 2500);
    return () => clearTimeout(timer);
  }, [fxSuccess]);

  useEffect(() => {
    if (!fxError) return;
    const timer = setTimeout(() => setFxError(null), 2500);
    return () => clearTimeout(timer);
  }, [fxError]);

  const invalidate = () => { void qc.invalidateQueries({ queryKey: ["settings"] }); };

  async function refreshFx() {
    setFxRefreshing(true);
    setFxSuccess(null);
    setFxError(null);
    try {
      const result = await apiPost<{ ok: boolean; status: string; rate: string }>(
        "/api/settings/fx/refresh",
        {},
      );
      setFxSuccess(`Rate updated to ${result.rate} (${result.status})`);
      invalidate();
    } catch (e) {
      setFxError(e instanceof Error ? e.message : "Failed to refresh rate");
    } finally {
      setFxRefreshing(false);
    }
  }
```

with:

```tsx
  const [fxRefreshing, setFxRefreshing] = useState(false);

  const invalidate = () => { void qc.invalidateQueries({ queryKey: ["settings"] }); };

  async function refreshFx() {
    setFxRefreshing(true);
    try {
      const result = await apiPost<{ ok: boolean; status: string; rate: string }>(
        "/api/settings/fx/refresh",
        {},
      );
      toast.success(`Rate updated to ${result.rate} (${result.status})`);
      invalidate();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to refresh rate");
    } finally {
      setFxRefreshing(false);
    }
  }
```

Remove the now-unused FX banner JSX inside the Exchange Rates card:

```tsx
              {fxError && (
                <div className="mt-4 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
                  {fxError}
                </div>
              )}
              {fxSuccess && (
                <div className="mt-4 rounded-lg border border-green-200 bg-green-50 px-4 py-3 text-sm text-green-700">
                  {fxSuccess}
                </div>
              )}
```

(delete entirely — no replacement JSX needed, the toast covers it).

- [ ] **Step 5: Replace the password-change success/error banners with toast calls**

Replace:

```tsx
  const [pwCurrent, setPwCurrent] = useState("");
  const [pwNew, setPwNew] = useState("");
  const [pwError, setPwError] = useState<string | null>(null);
  const [pwSuccess, setPwSuccess] = useState(false);
  const [pwSaving, setPwSaving] = useState(false);

  useEffect(() => {
    if (!pwSuccess) return;
    const timer = setTimeout(() => setPwSuccess(false), 2500);
    return () => clearTimeout(timer);
  }, [pwSuccess]);
```

with:

```tsx
  const [pwCurrent, setPwCurrent] = useState("");
  const [pwNew, setPwNew] = useState("");
  const [pwSaving, setPwSaving] = useState(false);
```

Replace:

```tsx
  async function changePassword(e: React.FormEvent) {
    e.preventDefault();
    setPwSaving(true);
    setPwError(null);
    setPwSuccess(false);
    try {
      await apiPost("/api/settings/password", {
        current_password: pwCurrent,
        new_password: pwNew,
      });
      setPwSuccess(true);
      setPwCurrent("");
      setPwNew("");
    } catch (err) {
      setPwError(err instanceof Error ? err.message : "Failed to change password");
    } finally {
      setPwSaving(false);
    }
  }
```

with:

```tsx
  async function changePassword(e: React.FormEvent) {
    e.preventDefault();
    setPwSaving(true);
    try {
      await apiPost("/api/settings/password", {
        current_password: pwCurrent,
        new_password: pwNew,
      });
      toast.success("Password changed successfully.");
      setPwCurrent("");
      setPwNew("");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to change password");
    } finally {
      setPwSaving(false);
    }
  }
```

Remove the now-unused banner JSX in the Security card's Change Password section:

```tsx
                {pwError && (
                  <div className="mb-4 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
                    {pwError}
                  </div>
                )}
                {pwSuccess && (
                  <div className="mb-4 rounded-lg border border-green-200 bg-green-50 px-4 py-3 text-sm text-green-700">
                    Password changed successfully.
                  </div>
                )}
```

(delete entirely).

- [ ] **Step 6: Replace the raw payment-enabled checkbox with Switch**

Replace:

```tsx
                  {methodState && (
                    <label className="flex items-center gap-2 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={methodState.enabled}
                        onChange={(e) =>
                          togglePayment.mutate({ method: methodKey, enabled: e.target.checked })
                        }
                        className="h-4 w-4"
                      />
                      <span className="text-sm text-ink-soft">
                        {methodState.enabled ? "Enabled" : "Disabled"}
                      </span>
                    </label>
                  )}
```

with:

```tsx
                  {methodState && (
                    <label className="flex items-center gap-2 cursor-pointer">
                      <Switch
                        checked={methodState.enabled}
                        onCheckedChange={(checked) =>
                          togglePayment.mutate({ method: methodKey, enabled: checked })
                        }
                      />
                      <span className="text-sm text-ink-soft">
                        {methodState.enabled ? "Enabled" : "Disabled"}
                      </span>
                    </label>
                  )}
```

Add the `Switch` import alongside the existing `Button`/`Input`/`Card` imports:

```tsx
import { Switch } from "@/components/ui/switch";
```

- [ ] **Step 7: Run tests and typecheck**

Run: `pnpm --filter @app/web-admin-client test -- SettingsPage && pnpm typecheck`
Expected: PASS, no errors. If `SettingsPage.test.tsx` asserts on the old inline banner text (e.g. `getByText("Password changed successfully.")`), update those assertions to `screen.findByText` against the toast region instead, since `sonner` renders toasts into a portal — read the existing test file first and adjust only the assertions that reference the removed banner DOM, not the mutation/API behavior.

- [ ] **Step 8: Commit**

```bash
git add apps/web-admin/client/src/pages/SettingsPage.tsx apps/web-admin/client/src/pages/SettingsPage.test.tsx
git commit -m "refactor(web-admin): migrate SettingsPage banners to Sonner toast, use shared Switch"
```

---

### Task 12: Migrate OutboxPage onto DataTable and StatusBadge

**Files:**
- Modify: `apps/web-admin/client/src/pages/OutboxPage.tsx`

**Interfaces:**
- Consumes: `DataTable` (`../components/shared/DataTable`), `StatusBadge` with `SENT` tone (Task 2)

- [ ] **Step 1: Confirm baseline**

Run: `pnpm --filter @app/web-admin-client test -- OutboxPage`
Expected: PASS (5 existing tests covering rows/empty/error/retry/retry-failure — none inspect the raw `<table>` markup directly, they query by text/role, so DataTable is a safe drop-in).

- [ ] **Step 2: Add imports**

Replace:

```tsx
import { PageLayout } from "../components/shared/PageLayout";
import { PageHeader } from "../components/shared/PageHeader";
import { FilterBar } from "../components/shared/FilterBar";
import { EmptyState } from "../components/shared/EmptyState";
```

with:

```tsx
import { PageLayout } from "../components/shared/PageLayout";
import { PageHeader } from "../components/shared/PageHeader";
import { FilterBar } from "../components/shared/FilterBar";
import { EmptyState } from "../components/shared/EmptyState";
import { DataTable } from "../components/shared/DataTable";
import { StatusBadge } from "../components/shared/StatusBadge";
```

- [ ] **Step 3: Replace the raw table with DataTable**

Replace:

```tsx
        {isLoading && <p className="text-sm text-ink-soft">Loading…</p>}
        {isError && <p className="text-sm text-rust">Failed to load outbox.</p>}

        {data && data.rows.length === 0 && <EmptyState title="No notifications found." />}

        {data && data.rows.length > 0 && (
          <div className="overflow-x-auto rounded-lg border border-line bg-card">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-line text-left text-ink-soft">
                  <th className="px-4 py-3 font-medium">ID</th>
                  <th className="px-4 py-3 font-medium">Event</th>
                  <th className="px-4 py-3 font-medium">Status</th>
                  <th className="px-4 py-3 font-medium">Attempts</th>
                  <th className="px-4 py-3 font-medium">Created</th>
                  <th className="px-4 py-3 font-medium">Sent</th>
                  <th className="px-4 py-3 font-medium"></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {data.rows.map((row) => (
                  <tr key={row.id} className="hover:bg-sand/40">
                    <td className="px-4 py-2 font-mono text-xs text-ink-soft">{row.id}</td>
                    <td className="px-4 py-2 text-ink">{row.event}</td>
                    <td className="px-4 py-2">
                      <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${
                        row.status === "SENT" ? "bg-pine-tint text-pine" :
                        row.status === "FAILED" ? "bg-rust/10 text-rust" :
                        "bg-sand text-ink"
                      }`}>
                        {row.status}
                      </span>
                    </td>
                    <td className="px-4 py-2 text-ink-soft">{row.attempts}</td>
                    <td className="whitespace-nowrap px-4 py-2 text-ink-soft">{formatTs(row.createdAt)}</td>
                    <td className="whitespace-nowrap px-4 py-2 text-ink-soft">{formatTs(row.sentAt)}</td>
                    <td className="px-4 py-2">
                      {row.status === "FAILED" && (
                        <Button
                          variant="outline"
                          size="sm"
                          disabled={retrying.has(row.id)}
                          onClick={() => retry(row.id)}
                        >
                          Retry
                        </Button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
```

with:

```tsx
        {isLoading && <p className="text-sm text-ink-soft">Loading…</p>}
        {isError && <p className="text-sm text-rust">Failed to load outbox.</p>}

        {data && (
          <DataTable
            columns={[
              { key: "id", header: "ID", render: (row) => <span className="font-mono text-xs text-ink-soft">{row.id}</span> },
              { key: "event", header: "Event", render: (row) => <span className="text-ink">{row.event}</span> },
              { key: "status", header: "Status", render: (row) => <StatusBadge status={row.status} /> },
              { key: "attempts", header: "Attempts", render: (row) => <span className="text-ink-soft">{row.attempts}</span> },
              { key: "created", header: "Created", render: (row) => <span className="whitespace-nowrap text-ink-soft">{formatTs(row.createdAt)}</span> },
              { key: "sent", header: "Sent", render: (row) => <span className="whitespace-nowrap text-ink-soft">{formatTs(row.sentAt)}</span> },
              {
                key: "actions",
                header: "",
                render: (row) =>
                  row.status === "FAILED" ? (
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={retrying.has(row.id)}
                      onClick={() => retry(row.id)}
                    >
                      Retry
                    </Button>
                  ) : null,
              },
            ]}
            data={data.rows}
            keyExtractor={(row) => row.id}
            empty={<EmptyState title="No notifications found." />}
          />
        )}
```

(The per-status count chips just above the `FilterBar`, e.g. `SENT: 12`, are a distinct "count summary" concept — not a per-row status pill — and are left as their existing `bg-sand` chip unchanged, per the scope notes.)

- [ ] **Step 4: Run tests and typecheck**

Run: `pnpm --filter @app/web-admin-client test -- OutboxPage && pnpm typecheck`
Expected: PASS, no errors.

- [ ] **Step 5: Commit**

```bash
git add apps/web-admin/client/src/pages/OutboxPage.tsx
git commit -m "refactor(web-admin): use shared DataTable/StatusBadge on OutboxPage"
```

---

### Task 13: Migrate ReportsPage onto Card/DataTable and fix hardcoded colors

**Files:**
- Modify: `apps/web-admin/client/src/pages/ReportsPage.tsx`

**Interfaces:**
- Consumes: `Card`/`CardHeader`/`CardTitle`/`CardContent` (`@/components/ui/card`), `DataTable` (`../components/shared/DataTable`)

- [ ] **Step 1: Confirm baseline**

Run: `pnpm --filter @app/web-admin-client test -- ReportsPage`
Expected: PASS.

- [ ] **Step 2: Add imports**

Replace:

```tsx
import { useQuery } from "@tanstack/react-query";
import { AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid } from "recharts";
import { PageLayout } from "../components/shared/PageLayout";
import { PageHeader } from "../components/shared/PageHeader";
import { EmptyState } from "../components/shared/EmptyState";
import { formatCurrencyDisplay } from "../components/shared/CurrencyAmount";
import { Button } from "@/components/ui/button";
```

with:

```tsx
import { useQuery } from "@tanstack/react-query";
import { AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid } from "recharts";
import { PageLayout } from "../components/shared/PageLayout";
import { PageHeader } from "../components/shared/PageHeader";
import { EmptyState } from "../components/shared/EmptyState";
import { DataTable } from "../components/shared/DataTable";
import { formatCurrencyDisplay } from "../components/shared/CurrencyAmount";
import { Button } from "@/components/ui/button";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
```

- [ ] **Step 3: Replace the whole data-rendering block**

Replace everything from `{data && (` through its matching `)}` (the revenue totals, daily chart, funnel, top products, and voucher usage blocks) with:

```tsx
        {data && (
          <>
            {/* Revenue totals */}
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <Card>
                <CardContent>
                  <p className="text-xs font-medium uppercase tracking-wider text-ink-soft">30-day Revenue (IDR)</p>
                  <p className="mt-1 font-display text-2xl font-semibold text-ink">
                    {formatCurrencyDisplay(data.totalIdr, "IDR")}
                  </p>
                </CardContent>
              </Card>
              {data.totalUsdt && (
                <Card>
                  <CardContent>
                    <p className="text-xs font-medium uppercase tracking-wider text-ink-soft">30-day Revenue (USDT)</p>
                    <p className="mt-1 font-display text-2xl font-semibold text-ink">
                      {formatCurrencyDisplay(data.totalUsdt, "USDT")}
                    </p>
                  </CardContent>
                </Card>
              )}
            </div>

            {/* Daily revenue chart */}
            {data.daily.length > 0 ? (
              <Card>
                <CardHeader><CardTitle>Daily Revenue (IDR) — Last {data.days} days</CardTitle></CardHeader>
                <CardContent>
                  <ResponsiveContainer width="100%" height={180}>
                    <AreaChart data={data.daily}>
                      <CartesianGrid strokeDasharray="3 3" stroke="var(--color-line)" />
                      <XAxis dataKey="day" tick={{ fontSize: 11 }} />
                      <YAxis tick={{ fontSize: 11 }} />
                      <Tooltip />
                      <Area type="monotone" dataKey="revenue_idr" stroke="var(--color-grass)" fill="var(--color-grass-tint)" />
                    </AreaChart>
                  </ResponsiveContainer>
                </CardContent>
              </Card>
            ) : (
              <EmptyState title="No revenue data yet." />
            )}

            {/* Order funnel */}
            <Card>
              <CardHeader><CardTitle>Orders by Status</CardTitle></CardHeader>
              <CardContent>
                <div className="flex flex-wrap gap-2">
                  {Object.entries(data.funnel).map(([status, count]) => (
                    <span key={status} className="rounded bg-sand px-3 py-1.5 text-sm text-ink">
                      {status}: <strong>{count}</strong>
                    </span>
                  ))}
                </div>
              </CardContent>
            </Card>

            {/* Top products */}
            {data.products.length > 0 && (
              <Card>
                <CardHeader><CardTitle>Top Products</CardTitle></CardHeader>
                <CardContent>
                  <DataTable
                    columns={[
                      { key: "product", header: "Product", render: (p) => <span className="text-ink">{p.productName}</span> },
                      { key: "sold", header: "Sold", render: (p) => <span className="text-ink-soft">{p.sold}</span> },
                      { key: "revenue", header: "Revenue (IDR)", render: (p) => <span className="text-ink">{formatCurrencyDisplay(p.revenue_idr, "IDR")}</span> },
                    ]}
                    data={data.products}
                    keyExtractor={(p) => p.productName}
                    empty={<EmptyState title="No product sales yet." />}
                  />
                </CardContent>
              </Card>
            )}

            {/* Voucher usage */}
            {data.vouchers.length > 0 && (
              <Card>
                <CardHeader><CardTitle>Voucher Usage</CardTitle></CardHeader>
                <CardContent>
                  <DataTable
                    columns={[
                      { key: "code", header: "Code", render: (v) => <span className="font-mono text-xs text-ink">{v.code}</span> },
                      { key: "uses", header: "Uses", render: (v) => <span className="text-ink-soft">{v.uses}</span> },
                      { key: "discount", header: "Discount (IDR)", render: (v) => <span className="text-ink">{formatCurrencyDisplay(v.discountIdr, "IDR")}</span> },
                    ]}
                    data={data.vouchers}
                    keyExtractor={(v) => v.code}
                    empty={<EmptyState title="No voucher usage yet." />}
                  />
                </CardContent>
              </Card>
            )}
          </>
        )}
```

- [ ] **Step 4: Run tests and typecheck**

Run: `pnpm --filter @app/web-admin-client test -- ReportsPage && pnpm typecheck`
Expected: PASS, no errors.

- [ ] **Step 5: Commit**

```bash
git add apps/web-admin/client/src/pages/ReportsPage.tsx
git commit -m "refactor(web-admin): use shared Card/DataTable on ReportsPage, drop hardcoded chart colors"
```

---

### Task 14: Migrate PaymentsPage's underpaid/pending sections onto Card, outcome onto StatusBadge

**Files:**
- Modify: `apps/web-admin/client/src/pages/PaymentsPage.tsx`

**Interfaces:**
- Consumes: `Card`/`CardHeader`/`CardTitle`/`CardContent` (`@/components/ui/card`, already imported), `StatusBadge` with `MATCHED`/`DELIVERY_FAILED`/`UNMATCHED` tones (Task 2)

- [ ] **Step 1: Confirm baseline**

Run: `pnpm --filter @app/web-admin-client test -- PaymentsPage`
Expected: PASS.

- [ ] **Step 2: Add the StatusBadge import**

Add:

```tsx
import { StatusBadge } from "../components/shared/StatusBadge";
```

- [ ] **Step 3: Wrap the Underpaid Orders section in Card**

Replace:

```tsx
      {underpaid.length > 0 && (
        <div className="mb-6">
          <h2 className="text-sm font-semibold text-ink mb-3">Underpaid Orders ({underpaid.length})</h2>
          <DataTable
```

with:

```tsx
      {underpaid.length > 0 && (
        <Card className="mb-6">
          <CardHeader><CardTitle>Underpaid Orders ({underpaid.length})</CardTitle></CardHeader>
          <CardContent>
          <DataTable
```

and its closing:

```tsx
            empty={<EmptyState title="No underpaid orders" />}
          />
        </div>
      )}
```

with:

```tsx
            empty={<EmptyState title="No underpaid orders" />}
          />
          </CardContent>
        </Card>
      )}
```

- [ ] **Step 4: Wrap the Pending Internal Transfers section in Card**

Replace:

```tsx
      {pendingInternal.length > 0 && (
        <div className="mb-6">
          <h2 className="text-sm font-semibold text-ink mb-3">Pending Internal Transfers ({pendingInternal.length})</h2>
          <DataTable
```

with:

```tsx
      {pendingInternal.length > 0 && (
        <Card className="mb-6">
          <CardHeader><CardTitle>Pending Internal Transfers ({pendingInternal.length})</CardTitle></CardHeader>
          <CardContent>
          <DataTable
```

and its closing:

```tsx
            empty={<EmptyState title="No pending internal transfers" />}
          />
        </div>
      )}
```

with:

```tsx
            empty={<EmptyState title="No pending internal transfers" />}
          />
          </CardContent>
        </Card>
      )}
```

- [ ] **Step 5: Convert the outcome Badge to StatusBadge**

Replace:

```tsx
          {
            key: "outcome",
            header: "Outcome",
            render: tx => <Badge variant="outline">{tx.outcome}</Badge>,
          },
```

with:

```tsx
          {
            key: "outcome",
            header: "Outcome",
            render: tx => <StatusBadge status={tx.outcome.toUpperCase()} />,
          },
```

- [ ] **Step 6: Run tests and typecheck**

Run: `pnpm --filter @app/web-admin-client test -- PaymentsPage && pnpm typecheck`
Expected: PASS, no errors.

- [ ] **Step 7: Commit**

```bash
git add apps/web-admin/client/src/pages/PaymentsPage.tsx
git commit -m "refactor(web-admin): wrap Payments list sections in Card, use StatusBadge for outcome"
```

---

### Task 15: Fix AdminsPage's FilterBar margin

**Files:**
- Modify: `apps/web-admin/client/src/pages/AdminsPage.tsx:80`

**Interfaces:** none — pure className fix, matches the `mb-4` convention used by Catalog/Stock/Vouchers/Payments' `FilterBar`.

Note: AdminsPage's "You" self-tag Badge and Pwd/2FA `✓` checkmark Badges are intentionally left unchanged — see "Scope notes" at the top of this plan.

- [ ] **Step 1: Confirm baseline**

Run: `pnpm --filter @app/web-admin-client test -- AdminsPage`
Expected: PASS.

- [ ] **Step 2: Change the margin**

Replace:

```tsx
      <FilterBar className="mb-6">
```

with:

```tsx
      <FilterBar className="mb-4">
```

- [ ] **Step 3: Run tests**

Run: `pnpm --filter @app/web-admin-client test -- AdminsPage`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add apps/web-admin/client/src/pages/AdminsPage.tsx
git commit -m "fix(web-admin): match AdminsPage filter bar margin to the other FilterBar pages"
```

---

### Task 16: Migrate UserDetailPage onto CardRow, Card-wrapped list sections, and StatusBadge

**Files:**
- Modify: `apps/web-admin/client/src/pages/UserDetailPage.tsx`

**Interfaces:**
- Consumes: `CardRow` (Task 5), `Card`/`CardHeader`/`CardTitle`/`CardContent` (already imported), `StatusBadge` (already imported, no new tones needed here — `role`/`currency` fall back to the existing `neutral` tone, which is correct)

- [ ] **Step 1: Confirm baseline**

Run: `pnpm --filter @app/web-admin-client test -- UserDetailPage`
Expected: PASS.

- [ ] **Step 2: Add the CardRow import**

Add:

```tsx
import { CardRow } from "../components/shared/CardRow";
```

- [ ] **Step 3: Replace the Profile card's hand-rolled rows with CardRow, fix the banned banner's color, convert the Role Badge to StatusBadge**

Replace:

```tsx
        <Card>
          <CardHeader><CardTitle>Profile</CardTitle></CardHeader>
          <CardContent className="flex flex-col gap-1 text-sm">
            {user.banned && (
              <div className="mb-2 rounded bg-rust/10 px-3 py-2 text-xs font-medium text-rust">
                BANNED{user.banReason ? ` — ${user.banReason}` : ""}
              </div>
            )}
            <div className="flex justify-between"><span className="text-ink-soft">Telegram ID</span><span className="font-mono text-xs">{user.telegramId}</span></div>
            <div className="flex justify-between"><span className="text-ink-soft">Username</span><span>{user.username ? `@${user.username}` : "—"}</span></div>
            <div className="flex justify-between items-center">
              <span className="text-ink-soft">Role</span>
              {user.role === "ADMIN" ? (
                <Badge variant="outline">{user.role}</Badge>
              ) : (
                <Select value={user.role} onValueChange={(role) => setRole.mutate(role)} disabled={setRole.isPending}>
                  <SelectTrigger className="w-28"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {data.roles.map((r) => (
                      <SelectItem key={r} value={r}>{r}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            </div>
            <div className="flex justify-between"><span className="text-ink-soft">Wallet</span><CurrencyStack amounts={[{ currency: "IDR", value: user.walletBalance }, { currency: "USDT", value: user.walletBalanceUsdt }]} /></div>
            <div className="flex justify-between"><span className="text-ink-soft">Total spent</span><CurrencyStack amounts={[{ currency: "IDR", value: data.totalSpent.idr }, { currency: "USDT", value: data.totalSpent.usdt }]} /></div>
          </CardContent>
        </Card>
```

with:

```tsx
        <Card>
          <CardHeader><CardTitle>Profile</CardTitle></CardHeader>
          <CardContent className="divide-y divide-line">
            {user.banned && (
              <div className="mb-2 rounded bg-rust-tint px-3 py-2 text-xs font-medium text-rust-dark">
                BANNED{user.banReason ? ` — ${user.banReason}` : ""}
              </div>
            )}
            <CardRow label="Telegram ID" value={<span className="font-mono text-xs">{user.telegramId}</span>} />
            <CardRow label="Username" value={user.username ? `@${user.username}` : "—"} />
            <CardRow
              label="Role"
              value={
                user.role === "ADMIN" ? (
                  <StatusBadge status={user.role} />
                ) : (
                  <Select value={user.role} onValueChange={(role) => setRole.mutate(role)} disabled={setRole.isPending}>
                    <SelectTrigger className="w-28"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {data.roles.map((r) => (
                        <SelectItem key={r} value={r}>{r}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )
              }
            />
            <CardRow label="Wallet" value={<CurrencyStack amounts={[{ currency: "IDR", value: user.walletBalance }, { currency: "USDT", value: user.walletBalanceUsdt }]} />} />
            <CardRow label="Total spent" value={<CurrencyStack amounts={[{ currency: "IDR", value: data.totalSpent.idr }, { currency: "USDT", value: data.totalSpent.usdt }]} />} />
          </CardContent>
        </Card>
```

- [ ] **Step 4: Wrap the Orders and Ledger sections in Card, convert the currency Badge to StatusBadge**

Replace:

```tsx
      {/* Orders */}
      <h2 className="text-sm font-semibold text-ink mb-3">Recent Orders ({data.orders.length})</h2>
      <DataTable
        columns={[
          { key: "code", header: "Code", render: o => <span className="font-mono text-xs">{o.orderCode}</span> },
          { key: "status", header: "Status", render: o => <StatusBadge status={o.status} /> },
          { key: "total", header: "Total", render: o => <span className="text-sm">{o.totalIdr}</span> },
          { key: "date", header: "Date", render: o => <span className="text-xs text-ink-soft">{new Date(o.createdAt).toLocaleDateString()}</span> },
        ]}
        data={data.orders}
        keyExtractor={o => o.id}
        onRowClick={o => navigate(`/orders/${o.id}`)}
        empty={<EmptyState title="No orders" />}
      />

      {/* Wallet ledger */}
      <h2 className="text-sm font-semibold text-ink mb-3 mt-6">Wallet Ledger ({data.ledger.length})</h2>
      <DataTable
        columns={[
          { key: "delta", header: "Delta", render: l => <span className={`font-mono text-sm ${l.delta.startsWith("-") ? "text-rust" : "text-grass"}`}>{l.delta}</span> },
          { key: "currency", header: "Currency", render: l => <Badge variant="outline">{l.currency}</Badge> },
          { key: "balance", header: "Balance", render: l => <span className="font-mono text-sm">{l.balanceAfter}</span> },
          { key: "reason", header: "Reason", render: l => <span className="text-sm">{l.reason}</span> },
          { key: "note", header: "Note", render: l => <span className="text-xs text-ink-soft">{l.note ?? "—"}</span> },
          { key: "date", header: "Date", render: l => <span className="text-xs text-ink-soft">{new Date(l.createdAt).toLocaleDateString()}</span> },
        ]}
        data={data.ledger.map((l, i) => ({ ...l, _key: i }))}
        keyExtractor={l => l._key}
        empty={<EmptyState title="No ledger entries" />}
      />
```

with:

```tsx
      {/* Orders */}
      <Card className="mb-6">
        <CardHeader><CardTitle>Recent Orders ({data.orders.length})</CardTitle></CardHeader>
        <CardContent>
          <DataTable
            columns={[
              { key: "code", header: "Code", render: o => <span className="font-mono text-xs">{o.orderCode}</span> },
              { key: "status", header: "Status", render: o => <StatusBadge status={o.status} /> },
              { key: "total", header: "Total", render: o => <span className="text-sm">{o.totalIdr}</span> },
              { key: "date", header: "Date", render: o => <span className="text-xs text-ink-soft">{new Date(o.createdAt).toLocaleDateString()}</span> },
            ]}
            data={data.orders}
            keyExtractor={o => o.id}
            onRowClick={o => navigate(`/orders/${o.id}`)}
            empty={<EmptyState title="No orders" />}
          />
        </CardContent>
      </Card>

      {/* Wallet ledger */}
      <Card>
        <CardHeader><CardTitle>Wallet Ledger ({data.ledger.length})</CardTitle></CardHeader>
        <CardContent>
          <DataTable
            columns={[
              { key: "delta", header: "Delta", render: l => <span className={`font-mono text-sm ${l.delta.startsWith("-") ? "text-rust" : "text-grass"}`}>{l.delta}</span> },
              { key: "currency", header: "Currency", render: l => <StatusBadge status={l.currency} /> },
              { key: "balance", header: "Balance", render: l => <span className="font-mono text-sm">{l.balanceAfter}</span> },
              { key: "reason", header: "Reason", render: l => <span className="text-sm">{l.reason}</span> },
              { key: "note", header: "Note", render: l => <span className="text-xs text-ink-soft">{l.note ?? "—"}</span> },
              { key: "date", header: "Date", render: l => <span className="text-xs text-ink-soft">{new Date(l.createdAt).toLocaleDateString()}</span> },
            ]}
            data={data.ledger.map((l, i) => ({ ...l, _key: i }))}
            keyExtractor={l => l._key}
            empty={<EmptyState title="No ledger entries" />}
          />
        </CardContent>
      </Card>
```

- [ ] **Step 5: Remove the now-unused `Badge` import if nothing else in the file uses it**

Check remaining `Badge` usages in the file (`grep -n "Badge" UserDetailPage.tsx` after the edits above) — if none remain, remove `import { Badge } from "@/components/ui/badge";` from the top of the file.

- [ ] **Step 6: Run tests and typecheck**

Run: `pnpm --filter @app/web-admin-client test -- UserDetailPage && pnpm typecheck`
Expected: PASS, no errors.

- [ ] **Step 7: Commit**

```bash
git add apps/web-admin/client/src/pages/UserDetailPage.tsx
git commit -m "refactor(web-admin): use shared CardRow/Card/StatusBadge on UserDetailPage"
```

---

### Task 17: Migrate ProductDetailPage's info bar and edit form onto Card

**Files:**
- Modify: `apps/web-admin/client/src/pages/ProductDetailPage.tsx`

**Interfaces:**
- Consumes: `Card`/`CardContent` (`@/components/ui/card`)

- [ ] **Step 1: Confirm baseline**

Run: `pnpm --filter @app/web-admin-client test -- ProductDetailPage`
Expected: PASS.

- [ ] **Step 2: Add the Card import**

Add:

```tsx
import { Card, CardContent } from "@/components/ui/card";
```

- [ ] **Step 3: Wrap the category/active/edit info bar in Card**

Replace:

```tsx
      <div className="mb-4 flex items-center gap-4 text-sm">
        <span className="text-ink-soft">Category: <span className="text-ink">{product.category?.name ?? "—"}</span></span>
        <div className="flex items-center gap-2">
          <Switch
            checked={product.isActive}
            onCheckedChange={(checked) => void toggleProductActive(product.id, checked)}
            disabled={togglingProduct.has(product.id)}
          />
          <span className="text-ink-soft">{product.isActive ? "Active" : "Inactive"}</span>
        </div>
        {!editingProduct && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              setNameDraft(product.name);
              setDescriptionDraft(product.description ?? "");
              setEditingProduct(true);
            }}
          >
            Edit name/description
          </Button>
        )}
      </div>
```

with:

```tsx
      <Card className="mb-4">
        <CardContent className="flex items-center gap-4 text-sm">
          <span className="text-ink-soft">Category: <span className="text-ink">{product.category?.name ?? "—"}</span></span>
          <div className="flex items-center gap-2">
            <Switch
              checked={product.isActive}
              onCheckedChange={(checked) => void toggleProductActive(product.id, checked)}
              disabled={togglingProduct.has(product.id)}
            />
            <span className="text-ink-soft">{product.isActive ? "Active" : "Inactive"}</span>
          </div>
          {!editingProduct && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                setNameDraft(product.name);
                setDescriptionDraft(product.description ?? "");
                setEditingProduct(true);
              }}
            >
              Edit name/description
            </Button>
          )}
        </CardContent>
      </Card>
```

- [ ] **Step 4: Wrap the inline edit form in Card**

Replace:

```tsx
      {editingProduct && (
        <div className="mb-4 max-w-lg flex flex-col gap-3 rounded-lg border border-line bg-card p-4">
          <div>
            <label className="text-sm font-medium text-ink">Name</label>
            <Input className="mt-1" value={nameDraft} onChange={(e) => setNameDraft(e.target.value)} />
          </div>
          <div>
            <label className="text-sm font-medium text-ink">Description</label>
            <Textarea className="mt-1" rows={3} value={descriptionDraft} onChange={(e) => setDescriptionDraft(e.target.value)} />
          </div>
          {productError && <p className="text-sm text-rust">{productError}</p>}
          <div className="flex gap-2">
            <Button size="sm" disabled={!nameDraft.trim() || savingProduct} onClick={() => void saveProduct()}>
              {savingProduct ? "Saving…" : "Save"}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => { setEditingProduct(false); setProductError(null); }}>
              Cancel
            </Button>
          </div>
        </div>
      )}
```

with:

```tsx
      {editingProduct && (
        <Card className="mb-4 max-w-lg">
          <CardContent className="flex flex-col gap-3">
            <div>
              <label className="text-sm font-medium text-ink">Name</label>
              <Input className="mt-1" value={nameDraft} onChange={(e) => setNameDraft(e.target.value)} />
            </div>
            <div>
              <label className="text-sm font-medium text-ink">Description</label>
              <Textarea className="mt-1" rows={3} value={descriptionDraft} onChange={(e) => setDescriptionDraft(e.target.value)} />
            </div>
            {productError && <p className="text-sm text-rust">{productError}</p>}
            <div className="flex gap-2">
              <Button size="sm" disabled={!nameDraft.trim() || savingProduct} onClick={() => void saveProduct()}>
                {savingProduct ? "Saving…" : "Save"}
              </Button>
              <Button size="sm" variant="ghost" onClick={() => { setEditingProduct(false); setProductError(null); }}>
                Cancel
              </Button>
            </div>
          </CardContent>
        </Card>
      )}
```

- [ ] **Step 5: Run tests and typecheck**

Run: `pnpm --filter @app/web-admin-client test -- ProductDetailPage && pnpm typecheck`
Expected: PASS, no errors.

- [ ] **Step 6: Commit**

```bash
git add apps/web-admin/client/src/pages/ProductDetailPage.tsx
git commit -m "refactor(web-admin): use shared Card for ProductDetailPage info bar and edit form"
```

---

### Task 18: Full verification pass

**Files:** none modified — verification only.

**Interfaces:** none.

- [ ] **Step 1: Rebuild the SPA**

Run: `pnpm --filter @app/web-admin-client build`
Expected: builds with no errors (this regenerates `apps/web-admin/static/dashboard-app/`, required per `CLAUDE.md` before `pnpm dev:web`/`pnpm test` will serve current code).

- [ ] **Step 2: Full typecheck**

Run: `pnpm typecheck`
Expected: no errors across the whole monorepo.

- [ ] **Step 3: Full test suite**

Run: `pnpm test`
Expected: all tests pass, including every test file touched in Tasks 1–17.

- [ ] **Step 4: Manual browser walkthrough**

Run: `pnpm dev:web` and open the admin panel. Visit, in order: Dashboard, Catalog (toggle "Manage categories" and "Import CSV" open), a Product Detail page, Stock, Orders, Users, a User Detail page, Vouchers, Settings, Outbox, Reports, Payments, Admins. For each, confirm:
- Title→content spacing looks identical across pages (no double gap on Dashboard).
- All search inputs (Catalog/Stock/Users) share the same height, icon, and width behavior.
- All cards share the same corner radius and shadow (no flat/no-shadow panels on Reports/Outbox/ProductDetail).
- All status-like pills (order status, stock level, voucher type/expiring, payment outcome, banned, role) render as the same pill shape/tone family.
- Settings' password/FX/payment-toggle actions show a toast instead of an inline banner.
- Stock's stock-level bar renders correctly for a few different percentages.

- [ ] **Step 5: Commit only if verification uncovered fixes**

If Step 4 surfaces any visual regression, fix it in the relevant page file, re-run that page's test file, and commit as `fix(web-admin): <description>`. If nothing needs fixing, this task produces no commit — it's a verification gate, not a code change.

---

## Self-Review

**Spec coverage:**
- §1 spacing convention → codified via the per-task `mb-4`/`mb-6` fixes (Tasks 8, 15) and left-alone-because-already-correct pages; no page ends up with a value outside the table.
- §2 Dashboard bug → Task 1.
- §3 new/extended components → Tasks 2 (StatusBadge), 3 (SearchBar), 4 (ProgressBar), 5 (CardRow).
- §4 page-by-page fixes → Tasks 6 (Catalog), 7 (Stock), 8 (Orders), 9 (Users), 10 (Vouchers), 11 (Settings), 12 (Outbox), 13 (Reports), 14 (Payments), 15 (Admins), 16 (UserDetail), 17 (ProductDetail).
- Verification section → Task 18.
- Non-goals (no new tokens, no `PrimaryButton`/`SecondaryButton`/`StatusSwitch`, no functional changes, no dark mode) → respected throughout; no task introduces any of these.

**Placeholder scan:** no `TBD`/`TODO`/"add appropriate handling" phrases anywhere in the plan; every step shows the actual before/after code.

**Type consistency:** `SearchBar({ value, onChange, placeholder?, className? })`, `ProgressBar({ value, tone, className? })`, and `CardRow({ label, value, className? })` are defined once in Tasks 3–5 and every consuming task (6, 7, 9, 16) uses those exact prop names. `StatusBadge`'s signature (`{ status: string }`) is unchanged — only its internal `TONE` map grows — so every existing call site keeps compiling.
