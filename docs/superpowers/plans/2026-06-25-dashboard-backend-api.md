# Dashboard Backend API Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the data layer and JSON API (`/api/dashboard/*`) that the React dashboard (Plans 2-3) will consume — every new crud function and route fully Vitest-tested, zero React, zero UI changes. The existing Nunjucks dashboard at `/` keeps working unmodified throughout.

**Architecture:** New crud functions live in `packages/db/src/crud/reports.ts` and `packages/db/src/crud/orders.ts`, reusing the existing `Db` (PrismaClient | Tx) parameter convention. A new route file `apps/web-admin/src/routes/api/dashboard.ts` registers 8 read-only GET endpoints guarded by the existing `currentAdmin` preHandler — no CSRF needed (nothing here mutates). Money math stays server-side and Decimal-based throughout; every response returns pre-formatted strings, never floats.

**Tech Stack:** Fastify, Prisma, decimal.js (`@app/core/money`), luxon (`@app/core/datetime`), Vitest.

## Global Constraints

- **Decimal for all money** — every Decimal arithmetic op uses `@app/core/money`'s `Decimal` (decimal.js), quantized to 4dp via the existing `q4`/`quantizeMoney` helpers. Never `Number()` a money field except for percentages.
- **Never blend IDR and USDT into one number on a per-currency display** (the bug this whole project fixes) — `revenueSummary`/`profitSummarySince`/`revenueByDay`/`ordersByDay` always return IDR and USDT as separate fields. The two *explicit, labeled* exceptions are `combinedRevenueByDay` and `topProductsByMargin`, which normalize to IDR-equivalent using each order's own `fxRate` snapshot — never a live rate — because the user explicitly opted into a blended view there (the "Combined" chart filter; product ranking).
- **No raw SQL / no bare `prisma.*` calls in route handlers** — every route composes calls to `packages/db/src/crud/*` functions only.
- **UTC in DB, `config.TIMEZONE` on display/day-boundary math** — "today" always means start-of-day in `config.TIMEZONE`, computed via the new `startOfDayUtc` helper, not UTC midnight.
- **`pnpm typecheck` and `pnpm test` must stay green after every task.**

---

## File Structure

- Modify `packages/core/src/datetime.ts` — add `startOfDayUtc`.
- Create `packages/core/src/datetime.test.ts` — new file, tests `startOfDayUtc`.
- Modify `packages/db/src/crud/reports.ts` — add `ordersByStatusSince`, `profitSummarySince`, `manualMatchQueueCounts`, `recentOrders`, `topProductsByMargin`, `ordersByDay`, `combinedRevenueByDay`; extend `revenueSummary` with an optional `until` param.
- Modify `packages/db/src/crud/reports.test.ts` — extend with describe blocks for everything above, plus a richer shared `beforeEach` (category/product fixture).
- Modify `packages/db/src/crud/orders.ts` — add `countPendingPaymentLike`, `countProcessing`, `countPendingVerifications`, `countUnderpaid`, `countExpiredPending`.
- Create `packages/db/src/crud/orders.test.ts` — new file (orders.ts has no test file today).
- Create `apps/web-admin/src/routes/api/dashboard.ts` — 8 GET endpoints.
- Modify `apps/web-admin/src/server.ts` — register the new route file.
- Create `apps/web-admin/test/dashboard-api.test.ts` — HTTP-level tests (`app.inject`), auth-fail + happy path per endpoint.

---

### Task 1: `startOfDayUtc` datetime helper

**Files:**
- Modify: `packages/core/src/datetime.ts`
- Test: `packages/core/src/datetime.test.ts` (new)

**Interfaces:**
- Produces: `startOfDayUtc(from?: Date, zone?: string): Date` — start of the calendar day in `zone` (default `config.TIMEZONE`), returned as a UTC `Date`.

- [ ] **Step 1: Write the failing test**

```ts
// packages/core/src/datetime.test.ts
import { describe, it, expect } from "vitest";
import { startOfDayUtc } from "./datetime";

describe("startOfDayUtc", () => {
  it("returns local midnight in the given zone, converted to UTC", () => {
    // 2026-06-25T10:00:00Z is 2026-06-25T17:00:00 in Asia/Jakarta (+7) —
    // local midnight that day is 2026-06-24T17:00:00Z.
    const from = new Date("2026-06-25T10:00:00.000Z");
    const result = startOfDayUtc(from, "Asia/Jakarta");
    expect(result.toISOString()).toBe("2026-06-24T17:00:00.000Z");
  });

  it("defaults to config.TIMEZONE (Asia/Jakarta) when no zone is given", () => {
    const from = new Date("2026-06-25T10:00:00.000Z");
    expect(startOfDayUtc(from).toISOString()).toBe("2026-06-24T17:00:00.000Z");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run packages/core/src/datetime.test.ts`
Expected: FAIL — `startOfDayUtc is not a function` / module has no exported member.

- [ ] **Step 3: Write minimal implementation**

Add to `packages/core/src/datetime.ts` (after `addDays`, before `export { DateTime };`):

```ts
/** Start of the calendar day in `zone` (default config.TIMEZONE), as a UTC Date. */
export const startOfDayUtc = (from: Date = new Date(), zone: string = config.TIMEZONE): Date =>
  DateTime.fromJSDate(from, { zone: "utc" }).setZone(zone).startOf("day").toUTC().toJSDate();
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run packages/core/src/datetime.test.ts`
Expected: PASS (2 tests)

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/datetime.ts packages/core/src/datetime.test.ts
git commit -m "feat(core): add startOfDayUtc for timezone-aware day boundaries"
```

---

### Task 2: extend `revenueSummary` with an optional `until` bound

**Files:**
- Modify: `packages/db/src/crud/reports.ts:132-138`
- Test: `packages/db/src/crud/reports.test.ts`

**Interfaces:**
- Consumes: `deliveredRevenueByCurrency(db, extraWhere)` (existing, same file, line 90).
- Produces: `revenueSummary(db: Db, since: Date, until?: Date): Promise<{ revenue_idr: Decimal; revenue_usdt: Decimal; orders: number }>` — `until` defaults to `new Date()`, so every existing caller (`apps/web-admin/src/routes/dashboard.ts:72-74`) is unaffected.

- [ ] **Step 1: Write the failing test**

Add to `packages/db/src/crud/reports.test.ts` (add `revenueSummary` to the existing import line: `import { revenueByDay, revenueSummary } from "./reports";`):

```ts
describe("revenueSummary", () => {
  it("excludes orders delivered after `until`", async () => {
    const now = new Date();
    const before = new Date(now.getTime() - 60_000);
    await prisma.order.create({
      data: { orderCode: `ORD-a-${Math.random()}`, userId, subtotalAmount: "10000", totalAmount: "10000", currency: "IDR", status: "DELIVERED", deliveredAt: before },
    });
    await prisma.order.create({
      data: { orderCode: `ORD-b-${Math.random()}`, userId, subtotalAmount: "20000", totalAmount: "20000", currency: "IDR", status: "DELIVERED", deliveredAt: now },
    });

    const result = await revenueSummary(prisma, new Date(now.getTime() - 120_000), before);
    expect(result.revenue_idr.toString()).toBe("10000");
    expect(result.orders).toBe(1);
  });

  it("defaults `until` to now when omitted", async () => {
    const now = new Date();
    await prisma.order.create({
      data: { orderCode: `ORD-c-${Math.random()}`, userId, subtotalAmount: "5000", totalAmount: "5000", currency: "IDR", status: "DELIVERED", deliveredAt: now },
    });
    const result = await revenueSummary(prisma, new Date(now.getTime() - 60_000));
    expect(result.revenue_idr.toString()).toBe("5000");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run packages/db/src/crud/reports.test.ts`
Expected: FAIL on the first new test — both orders counted (no upper bound applied yet).

- [ ] **Step 3: Write minimal implementation**

Replace in `packages/db/src/crud/reports.ts`:

```ts
export async function revenueSummary(
  db: Db,
  since: Date,
  until: Date = new Date(),
): Promise<{ revenue_idr: Decimal; revenue_usdt: Decimal; orders: number }> {
  const rev = await deliveredRevenueByCurrency(db, { deliveredAt: { gte: since, lte: until } });
  return { revenue_idr: rev.idr, revenue_usdt: rev.usdt, orders: rev.orders };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run packages/db/src/crud/reports.test.ts`
Expected: PASS (all tests, including the pre-existing `revenueByDay` ones — confirms the change is backward compatible)

- [ ] **Step 5: Commit**

```bash
git add packages/db/src/crud/reports.ts packages/db/src/crud/reports.test.ts
git commit -m "feat(db): add an optional until bound to revenueSummary"
```

---

### Task 3: `ordersByStatusSince`

**Files:**
- Modify: `packages/db/src/crud/reports.ts` (after `ordersByStatus`, line ~238)
- Test: `packages/db/src/crud/reports.test.ts`

**Interfaces:**
- Produces: `ordersByStatusSince(db: Db, since: Date): Promise<StatusCount[]>` (reuses the existing `StatusCount` interface, line 227).

- [ ] **Step 1: Write the failing test**

```ts
import { ordersByStatusSince } from "./reports"; // add to existing import line

describe("ordersByStatusSince", () => {
  it("only counts orders created since the cutoff", async () => {
    const now = new Date();
    const old = new Date(now.getTime() - 86_400_000 * 2);
    await prisma.order.create({
      data: { orderCode: `ORD-old-${Math.random()}`, userId, subtotalAmount: "1", totalAmount: "1", status: "DELIVERED", createdAt: old },
    });
    await prisma.order.create({
      data: { orderCode: `ORD-new-${Math.random()}`, userId, subtotalAmount: "1", totalAmount: "1", status: "PENDING_PAYMENT", createdAt: now },
    });

    const result = await ordersByStatusSince(prisma, new Date(now.getTime() - 60_000));
    expect(result).toEqual([{ status: "PENDING_PAYMENT", count: 1 }]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run packages/db/src/crud/reports.test.ts`
Expected: FAIL — `ordersByStatusSince is not a function`

- [ ] **Step 3: Write minimal implementation**

```ts
/** Order counts grouped by status, restricted to orders created since `since` — the dashboard's "today" funnel. */
export async function ordersByStatusSince(db: Db, since: Date): Promise<StatusCount[]> {
  const grouped = await db.order.groupBy({
    by: ["status"],
    where: { createdAt: { gte: since } },
    _count: { _all: true },
  });
  return grouped
    .map((g) => ({ status: g.status, count: g._count._all }))
    .sort((a, b) => b.count - a.count);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run packages/db/src/crud/reports.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/db/src/crud/reports.ts packages/db/src/crud/reports.test.ts
git commit -m "feat(db): add ordersByStatusSince for the dashboard's today funnel"
```

---

### Task 4: shared test fixture — category + parent product

Every remaining `reports.ts` task needs a `Denomination` (with `costPrice`), which needs a parent `Product`/`Category`. Add this once, before writing more tests.

**Files:**
- Modify: `packages/db/src/crud/reports.test.ts`

- [ ] **Step 1: Update imports and `beforeEach`**

Replace the top of `packages/db/src/crud/reports.test.ts` (imports + `beforeEach`) with:

```ts
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { makeTestDb, type TestDb } from "../../../../tests/helpers/testdb";
import { createCategory, createCatalogProduct, createDenomination } from "./catalog";
import {
  revenueByDay,
  revenueSummary,
  ordersByStatusSince,
} from "./reports"; // remaining new imports added in later tasks of this plan

let db: TestDb;
let prisma: PrismaClient;
let userId: number;
let parentProductId: number;

beforeAll(async () => {
  db = await makeTestDb();
  prisma = db.prisma;
});
afterAll(async () => {
  await db.cleanup();
});
beforeEach(async () => {
  await prisma.orderItem.deleteMany();
  await prisma.order.deleteMany();
  await prisma.denomination.deleteMany();
  await prisma.product.deleteMany();
  await prisma.category.deleteMany();
  await prisma.user.deleteMany();
  await prisma.processedBinanceTx.deleteMany();
  await prisma.processedBybitTx.deleteMany();
  await prisma.processedTokopayTx.deleteMany();
  await prisma.processedPaydisiniTx.deleteMany();
  await prisma.processedNowpaymentsTx.deleteMany();

  const user = await prisma.user.create({
    data: { telegramId: BigInt(Math.floor(Math.random() * 1e15)), referralCode: `r${Math.random()}` },
  });
  userId = user.id;
  const category = await createCategory(prisma, `Cat-${Math.random()}`);
  const parentProduct = await createCatalogProduct(prisma, { categoryId: category.id, name: `Prod-${Math.random()}`, description: "x" });
  parentProductId = parentProduct.id;
});
```

- [ ] **Step 2: Run the full file to verify nothing broke**

Run: `pnpm vitest run packages/db/src/crud/reports.test.ts`
Expected: PASS (all existing + Task 2/3 tests still green — the fixture change is additive)

- [ ] **Step 3: Commit**

```bash
git add packages/db/src/crud/reports.test.ts
git commit -m "test(db): add a category/product fixture to reports.test.ts"
```

---

### Task 5: `profitSummarySince`

**Files:**
- Modify: `packages/db/src/crud/reports.ts`
- Test: `packages/db/src/crud/reports.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface CurrencyProfit {
    netProfit: string;        // q4 Decimal string
    marginPct: string | null; // 2dp percentage string; null when revenueConsidered is zero
    excludedItemCount: number;
  }
  export interface ProfitSummary {
    idr: CurrencyProfit | null;
    usdt: CurrencyProfit | null;
  }
  export async function profitSummarySince(db: Db, since: Date): Promise<ProfitSummary>
  ```

- [ ] **Step 1: Write the failing tests**

```ts
import { createDenomination } from "./catalog"; // already imported in Task 4
import { profitSummarySince } from "./reports"; // add to existing import line

describe("profitSummarySince", () => {
  it("splits net profit and margin% by currency, converting a USDT bucket's IDR-native cost via the order's own fxRate — never blending IDR and USDT", async () => {
    const now = new Date();
    const idrProduct = await createDenomination(prisma, { productId: parentProductId, name: "IDR item", type: "SHARED", durationLabel: "1 Month", price: "10000", costPrice: "6000" });
    const usdtProduct = await createDenomination(prisma, { productId: parentProductId, name: "USDT item", type: "SHARED", durationLabel: "1 Month", price: "160000", costPrice: "32000" });

    const idrOrder = await prisma.order.create({ data: { orderCode: `ORD-idr-${Math.random()}`, userId, subtotalAmount: "20000", totalAmount: "20000", currency: "IDR", status: "DELIVERED", deliveredAt: now } });
    await prisma.orderItem.create({ data: { orderId: idrOrder.id, productId: idrProduct.id, quantity: 2, unitPrice: "10000", warrantyDaysSnapshot: 30 } });

    const usdtOrder = await prisma.order.create({ data: { orderCode: `ORD-usdt-${Math.random()}`, userId, subtotalAmount: "10", totalAmount: "10", currency: "USDT", fxRate: "16000", status: "DELIVERED", deliveredAt: now } });
    await prisma.orderItem.create({ data: { orderId: usdtOrder.id, productId: usdtProduct.id, quantity: 1, unitPrice: "10", warrantyDaysSnapshot: 30 } });

    const result = await profitSummarySince(prisma, new Date(now.getTime() - 60_000));
    // IDR: revenue 2x10000=20000, cost 2x6000=12000 -> profit 8000, margin 40%
    expect(result.idr).toEqual({ netProfit: "8000", marginPct: "40", excludedItemCount: 0 });
    // USDT: revenue 10 USDT, cost 32000 IDR / fxRate 16000 = 2 USDT-equiv -> profit 8, margin 80%
    expect(result.usdt).toEqual({ netProfit: "8", marginPct: "80", excludedItemCount: 0 });
  });

  it("excludes items with no costPrice from profit and margin%, but still counts them", async () => {
    const now = new Date();
    const noCostProduct = await createDenomination(prisma, { productId: parentProductId, name: "No cost item", type: "SHARED", durationLabel: "1 Month", price: "10000" });
    const order = await prisma.order.create({ data: { orderCode: `ORD-nc-${Math.random()}`, userId, subtotalAmount: "10000", totalAmount: "10000", currency: "IDR", status: "DELIVERED", deliveredAt: now } });
    await prisma.orderItem.create({ data: { orderId: order.id, productId: noCostProduct.id, quantity: 1, unitPrice: "10000", warrantyDaysSnapshot: 30 } });

    const result = await profitSummarySince(prisma, new Date(now.getTime() - 60_000));
    expect(result.idr).toEqual({ netProfit: "0", marginPct: null, excludedItemCount: 1 });
  });

  it("returns null for a currency with no delivered items in range", async () => {
    const result = await profitSummarySince(prisma, new Date());
    expect(result.idr).toBeNull();
    expect(result.usdt).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run packages/db/src/crud/reports.test.ts`
Expected: FAIL — `profitSummarySince is not a function`

- [ ] **Step 3: Write minimal implementation**

Add to `packages/db/src/crud/reports.ts`:

```ts
export interface CurrencyProfit {
  netProfit: string;
  marginPct: string | null;
  excludedItemCount: number;
}

export interface ProfitSummary {
  idr: CurrencyProfit | null;
  usdt: CurrencyProfit | null;
}

/**
 * Net profit + margin for delivered OrderItems since `since`, split by the
 * order's currency — never blended (the "Rp137 + 20.25 USDT" bug this
 * dashboard exists to fix). `Denomination.costPrice` is always catalog-
 * central IDR; a USDT-currency line converts it to USDT-equivalent via THAT
 * order's own `fxRate` snapshot (never a live rate) before subtracting it
 * from the USDT revenue it corresponds to. Items whose Denomination has no
 * costPrice are excluded from both the profit sum and the margin%
 * denominator (counting them at cost=0 would read as a fabricated 100%
 * margin) and counted in `excludedItemCount` instead.
 */
export async function profitSummarySince(db: Db, since: Date): Promise<ProfitSummary> {
  const items = await db.orderItem.findMany({
    where: { order: { status: OrderStatus.DELIVERED, deliveredAt: { gte: since } } },
    select: {
      quantity: true,
      unitPrice: true,
      product: { select: { costPrice: true } },
      order: { select: { currency: true, fxRate: true } },
    },
  });

  const byCurrency: Record<"IDR" | "USDT", { revenue: Decimal; cost: Decimal; excluded: number }> = {
    IDR: { revenue: new Decimal(0), cost: new Decimal(0), excluded: 0 },
    USDT: { revenue: new Decimal(0), cost: new Decimal(0), excluded: 0 },
  };

  for (const item of items) {
    const isUsdt = item.order.currency === "USDT";
    const bucket = isUsdt ? byCurrency.USDT : byCurrency.IDR;
    if (item.product.costPrice == null) {
      bucket.excluded += 1;
      continue;
    }
    const lineRevenue = new Decimal(item.unitPrice).times(item.quantity);
    const lineCostIdr = new Decimal(item.product.costPrice).times(item.quantity);
    const lineCost = isUsdt && item.order.fxRate != null ? lineCostIdr.div(item.order.fxRate) : lineCostIdr;
    bucket.revenue = bucket.revenue.plus(lineRevenue);
    bucket.cost = bucket.cost.plus(lineCost);
  }

  const shape = (b: { revenue: Decimal; cost: Decimal; excluded: number }): CurrencyProfit | null => {
    if (b.revenue.isZero() && b.excluded === 0) return null;
    const profit = b.revenue.minus(b.cost);
    const marginPct = b.revenue.isZero() ? null : profit.div(b.revenue).times(100).toDecimalPlaces(2).toString();
    return { netProfit: q4(profit).toString(), marginPct, excludedItemCount: b.excluded };
  };

  return { idr: shape(byCurrency.IDR), usdt: shape(byCurrency.USDT) };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run packages/db/src/crud/reports.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/db/src/crud/reports.ts packages/db/src/crud/reports.test.ts
git commit -m "feat(db): add profitSummarySince with per-currency margin and cost-unknown handling"
```

---

### Task 6: `manualMatchQueueCounts`

**Files:**
- Modify: `packages/db/src/crud/reports.ts`
- Test: `packages/db/src/crud/reports.test.ts`

**Interfaces:**
- Produces: `manualMatchQueueCounts(db: Db): Promise<{ unmatched: number; deliveryFailed: number }>`

- [ ] **Step 1: Write the failing test**

```ts
import { manualMatchQueueCounts } from "./reports"; // add to existing import line

describe("manualMatchQueueCounts", () => {
  it("sums unmatched and delivery_failed rows across all five processed-tx tables", async () => {
    await prisma.processedBinanceTx.create({ data: { binanceTxId: `bn-${Math.random()}`, amount: "1", outcome: "unmatched" } });
    await prisma.processedBybitTx.create({ data: { bybitTxId: `by-${Math.random()}`, amount: "1", outcome: "delivery_failed" } });
    await prisma.processedTokopayTx.create({ data: { trxId: `tp-${Math.random()}`, amount: "1", outcome: "unmatched" } });
    await prisma.processedPaydisiniTx.create({ data: { trxId: `pd-${Math.random()}`, amount: "1", outcome: "matched" } });
    await prisma.processedNowpaymentsTx.create({ data: { trxId: `np-${Math.random()}`, amount: "1", outcome: "delivery_failed" } });

    const result = await manualMatchQueueCounts(prisma);
    expect(result).toEqual({ unmatched: 2, deliveryFailed: 2 });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run packages/db/src/crud/reports.test.ts`
Expected: FAIL — `manualMatchQueueCounts is not a function`

- [ ] **Step 3: Write minimal implementation**

```ts
export interface ManualMatchQueueCounts {
  unmatched: number;
  deliveryFailed: number;
}

/**
 * Counts of `unmatched` / `delivery_failed` ledger rows across all five
 * payment-method idempotency tables (Binance, Bybit, TokoPay, Paydisini,
 * NOWPayments) — generalizes the Binance-only `processedTxOutcomeCounts()`
 * (binance_internal.ts) for the dashboard's cross-provider "manual
 * approvals" / "failed deliveries" counts.
 */
export async function manualMatchQueueCounts(db: Db): Promise<ManualMatchQueueCounts> {
  const groups = await Promise.all([
    db.processedBinanceTx.groupBy({ by: ["outcome"], _count: { _all: true } }),
    db.processedBybitTx.groupBy({ by: ["outcome"], _count: { _all: true } }),
    db.processedTokopayTx.groupBy({ by: ["outcome"], _count: { _all: true } }),
    db.processedPaydisiniTx.groupBy({ by: ["outcome"], _count: { _all: true } }),
    db.processedNowpaymentsTx.groupBy({ by: ["outcome"], _count: { _all: true } }),
  ]);

  let unmatched = 0;
  let deliveryFailed = 0;
  for (const grouped of groups) {
    for (const g of grouped) {
      if (g.outcome === "unmatched") unmatched += g._count._all;
      if (g.outcome === "delivery_failed") deliveryFailed += g._count._all;
    }
  }
  return { unmatched, deliveryFailed };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run packages/db/src/crud/reports.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/db/src/crud/reports.ts packages/db/src/crud/reports.test.ts
git commit -m "feat(db): add manualMatchQueueCounts across all five processed-tx tables"
```

---

### Task 7: order-status count helpers (`orders.ts`)

**Files:**
- Modify: `packages/db/src/crud/orders.ts` (near `listExpiredPendingOrders`, line ~500)
- Test: `packages/db/src/crud/orders.test.ts` (new file)

**Interfaces:**
- Produces: `countPendingPaymentLike(db: Db): Promise<number>`, `countProcessing(db: Db): Promise<number>`, `countPendingVerifications(db: Db): Promise<number>`, `countUnderpaid(db: Db): Promise<number>`, `countExpiredPending(db: Db, now: Date): Promise<number>`

- [ ] **Step 1: Write the failing test (new file)**

```ts
// packages/db/src/crud/orders.test.ts
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { makeTestDb, type TestDb } from "../../../../tests/helpers/testdb";
import {
  countPendingPaymentLike,
  countProcessing,
  countPendingVerifications,
  countUnderpaid,
  countExpiredPending,
} from "./orders";

let db: TestDb;
let prisma: PrismaClient;
let userId: number;

beforeAll(async () => {
  db = await makeTestDb();
  prisma = db.prisma;
});
afterAll(async () => {
  await db.cleanup();
});
beforeEach(async () => {
  await prisma.order.deleteMany();
  await prisma.user.deleteMany();
  const user = await prisma.user.create({
    data: { telegramId: BigInt(Math.floor(Math.random() * 1e15)), referralCode: `r${Math.random()}` },
  });
  userId = user.id;
});

function makeOrder(status: string, extra: Record<string, unknown> = {}) {
  return prisma.order.create({
    data: { orderCode: `ORD-${Math.random()}`, userId, subtotalAmount: "1", totalAmount: "1", status, ...extra },
  });
}

describe("order status counts", () => {
  it("countPendingPaymentLike counts PENDING_PAYMENT, PAYMENT_DETECTED, and CONFIRMING", async () => {
    await makeOrder("PENDING_PAYMENT");
    await makeOrder("PAYMENT_DETECTED");
    await makeOrder("CONFIRMING");
    await makeOrder("DELIVERED");
    expect(await countPendingPaymentLike(prisma)).toBe(3);
  });

  it("countProcessing counts CONFIRMED and PAID", async () => {
    await makeOrder("CONFIRMED");
    await makeOrder("PAID");
    await makeOrder("DELIVERED");
    expect(await countProcessing(prisma)).toBe(2);
  });

  it("countPendingVerifications counts every PENDING_VERIFICATION row, with no page-size cap", async () => {
    for (let i = 0; i < 5; i++) await makeOrder("PENDING_VERIFICATION");
    expect(await countPendingVerifications(prisma)).toBe(5);
  });

  it("countUnderpaid counts UNDERPAID orders", async () => {
    await makeOrder("UNDERPAID");
    await makeOrder("PAID");
    expect(await countUnderpaid(prisma)).toBe(1);
  });

  it("countExpiredPending counts only PENDING_PAYMENT orders whose expiresAt has passed", async () => {
    const now = new Date();
    await makeOrder("PENDING_PAYMENT", { expiresAt: new Date(now.getTime() - 60_000) });
    await makeOrder("PENDING_PAYMENT", { expiresAt: new Date(now.getTime() + 60_000) });
    await makeOrder("PENDING_PAYMENT", { expiresAt: null });
    expect(await countExpiredPending(prisma, now)).toBe(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run packages/db/src/crud/orders.test.ts`
Expected: FAIL — none of the 5 functions exist yet.

- [ ] **Step 3: Write minimal implementation**

Add to `packages/db/src/crud/orders.ts` (after `listExpiredPendingOrders`):

```ts
/** Orders awaiting payment confirmation right now — covers every payment
 * method's pre-confirmation states, including the Bybit BSC on-chain
 * milestones ("Pending Payments" on the dashboard). */
export function countPendingPaymentLike(db: Db): Promise<number> {
  return db.order.count({
    where: { status: { in: [OrderStatus.PENDING_PAYMENT, OrderStatus.PAYMENT_DETECTED, OrderStatus.CONFIRMING] } },
  });
}

/** Orders confirmed-paid but not yet delivered ("Orders Processing"). */
export function countProcessing(db: Db): Promise<number> {
  return db.order.count({ where: { status: { in: [OrderStatus.CONFIRMED, OrderStatus.PAID] } } });
}

/** Orders awaiting admin payment-proof confirmation — the true count, unlike
 * `listPendingVerifications(db, limit)`, which is capped at its page size. */
export function countPendingVerifications(db: Db): Promise<number> {
  return db.order.count({ where: { status: OrderStatus.PENDING_VERIFICATION } });
}

/** Orders an admin must manually resolve (paid short of the expected total). */
export function countUnderpaid(db: Db): Promise<number> {
  return db.order.count({ where: { status: OrderStatus.UNDERPAID } });
}

/** PENDING_PAYMENT orders whose window has already lapsed — the count form of `listExpiredPendingOrders`. */
export function countExpiredPending(db: Db, now: Date): Promise<number> {
  return db.order.count({ where: { status: OrderStatus.PENDING_PAYMENT, expiresAt: { not: null, lt: now } } });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run packages/db/src/crud/orders.test.ts`
Expected: PASS (5 tests)

- [ ] **Step 5: Commit**

```bash
git add packages/db/src/crud/orders.ts packages/db/src/crud/orders.test.ts
git commit -m "feat(db): add order-status count helpers for the dashboard"
```

---

### Task 8: `recentOrders`

**Files:**
- Modify: `packages/db/src/crud/reports.ts`
- Test: `packages/db/src/crud/reports.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface RecentOrderRow {
    orderId: number;
    orderCode: string;
    productLabel: string;
    customerLabel: string;
    amount: string;
    currency: string;
    status: string;
    createdAt: string; // ISO
  }
  export async function recentOrders(db: Db, limit?: number): Promise<RecentOrderRow[]>
  ```

- [ ] **Step 1: Write the failing tests**

```ts
import { recentOrders } from "./reports"; // add to existing import line

describe("recentOrders", () => {
  it("returns newest first, with the first item's product name and an overflow count when there are more", async () => {
    const now = new Date();
    const productA = await createDenomination(prisma, { productId: parentProductId, name: "Product A", type: "SHARED", durationLabel: "1 Month", price: "10000" });
    const productB = await createDenomination(prisma, { productId: parentProductId, name: "Product B", type: "SHARED", durationLabel: "1 Month", price: "10000" });

    const order1 = await prisma.order.create({ data: { orderCode: "ORD-1", userId, subtotalAmount: "1", totalAmount: "10000", currency: "IDR", status: "DELIVERED", createdAt: new Date(now.getTime() - 60_000) } });
    await prisma.orderItem.create({ data: { orderId: order1.id, productId: productA.id, quantity: 1, unitPrice: "10000", warrantyDaysSnapshot: 30 } });
    await prisma.orderItem.create({ data: { orderId: order1.id, productId: productB.id, quantity: 1, unitPrice: "10000", warrantyDaysSnapshot: 30 } });

    const order2 = await prisma.order.create({ data: { orderCode: "ORD-2", userId, subtotalAmount: "1", totalAmount: "5000", currency: "IDR", status: "PENDING_PAYMENT", createdAt: now } });
    await prisma.orderItem.create({ data: { orderId: order2.id, productId: productA.id, quantity: 1, unitPrice: "5000", warrantyDaysSnapshot: 30 } });

    const result = await recentOrders(prisma, 10);
    expect(result).toHaveLength(2);
    expect(result[0]).toMatchObject({ orderId: order2.id, orderCode: "ORD-2", productLabel: "Product A", amount: "5000", currency: "IDR", status: "PENDING_PAYMENT" });
    expect(result[1]).toMatchObject({ orderId: order1.id, orderCode: "ORD-1", productLabel: "Product A +1 more", amount: "10000" });
  });

  it("falls back to a Telegram-id label when the user has no username", async () => {
    const product = await createDenomination(prisma, { productId: parentProductId, name: "Solo product", type: "SHARED", durationLabel: "1 Month", price: "10000" });
    const order = await prisma.order.create({ data: { orderCode: "ORD-solo", userId, subtotalAmount: "1", totalAmount: "10000", currency: "IDR", status: "DELIVERED" } });
    await prisma.orderItem.create({ data: { orderId: order.id, productId: product.id, quantity: 1, unitPrice: "10000", warrantyDaysSnapshot: 30 } });

    const result = await recentOrders(prisma, 10);
    const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
    expect(result[0]!.customerLabel).toBe(`Telegram ${user.telegramId}`);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run packages/db/src/crud/reports.test.ts`
Expected: FAIL — `recentOrders is not a function`

- [ ] **Step 3: Write minimal implementation**

```ts
export interface RecentOrderRow {
  orderId: number;
  orderCode: string;
  productLabel: string;
  customerLabel: string;
  amount: string;
  currency: string;
  status: string;
  createdAt: string;
}

/** Latest orders for the dashboard's Recent Orders table, newest first. */
export async function recentOrders(db: Db, limit = 10): Promise<RecentOrderRow[]> {
  const orders = await db.order.findMany({
    orderBy: { createdAt: "desc" },
    take: limit,
    include: {
      user: { select: { username: true, telegramId: true } },
      items: { select: { product: { select: { name: true } } }, orderBy: { id: "asc" }, take: 1 },
      _count: { select: { items: true } },
    },
  });
  return orders.map((o) => {
    const firstItemName = o.items[0]?.product.name ?? "—";
    const extra = o._count.items - 1;
    return {
      orderId: o.id,
      orderCode: o.orderCode,
      productLabel: extra > 0 ? `${firstItemName} +${extra} more` : firstItemName,
      customerLabel: o.user.username ?? (o.user.telegramId != null ? `Telegram ${o.user.telegramId}` : "Unknown customer"),
      amount: new Decimal(o.totalAmount).toString(),
      currency: o.currency,
      status: o.status,
      createdAt: o.createdAt.toISOString(),
    };
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run packages/db/src/crud/reports.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/db/src/crud/reports.ts packages/db/src/crud/reports.test.ts
git commit -m "feat(db): add recentOrders for the dashboard's Recent Orders table"
```

---

### Task 9: `topProductsByMargin`

**Files:**
- Modify: `packages/db/src/crud/reports.ts`
- Test: `packages/db/src/crud/reports.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface TopProductMargin {
    productId: number;
    name: string;
    unitsSold: number;
    revenueIdrEquiv: string;
    profitIdrEquiv: string | null;
    costUnknownUnits: number;
  }
  export async function topProductsByMargin(db: Db, since: Date, limit?: number): Promise<TopProductMargin[]>
  ```
  Distinct from the existing `topProducts` (all-time, no profit, still used unmodified by `apps/web-admin/src/routes/reports.ts:47`) — do not change that function.

- [ ] **Step 1: Write the failing tests**

```ts
import { topProductsByMargin } from "./reports"; // add to existing import line

describe("topProductsByMargin", () => {
  it("ranks by units sold and normalizes USDT lines to IDR-equivalent via the order's own fxRate", async () => {
    const now = new Date();
    const productA = await createDenomination(prisma, { productId: parentProductId, name: "Product A", type: "SHARED", durationLabel: "1 Month", price: "10000", costPrice: "6000" });
    const productB = await createDenomination(prisma, { productId: parentProductId, name: "Product B", type: "SHARED", durationLabel: "1 Month", price: "80000", costPrice: "32000" });

    const idrOrder = await prisma.order.create({ data: { orderCode: `ORD-a-${Math.random()}`, userId, subtotalAmount: "30000", totalAmount: "30000", currency: "IDR", status: "DELIVERED", deliveredAt: now } });
    await prisma.orderItem.create({ data: { orderId: idrOrder.id, productId: productA.id, quantity: 3, unitPrice: "10000", warrantyDaysSnapshot: 30 } });

    const usdtOrder = await prisma.order.create({ data: { orderCode: `ORD-b-${Math.random()}`, userId, subtotalAmount: "5", totalAmount: "5", currency: "USDT", fxRate: "16000", status: "DELIVERED", deliveredAt: now } });
    await prisma.orderItem.create({ data: { orderId: usdtOrder.id, productId: productB.id, quantity: 1, unitPrice: "5", warrantyDaysSnapshot: 30 } });

    const result = await topProductsByMargin(prisma, new Date(now.getTime() - 60_000), 5);
    expect(result).toEqual([
      { productId: productA.id, name: "Product A", unitsSold: 3, revenueIdrEquiv: "30000", profitIdrEquiv: "12000", costUnknownUnits: 0 },
      { productId: productB.id, name: "Product B", unitsSold: 1, revenueIdrEquiv: "80000", profitIdrEquiv: "48000", costUnknownUnits: 0 },
    ]);
  });

  it("nulls profit for a product with any cost-unknown units, but still reports its revenue", async () => {
    const now = new Date();
    const product = await createDenomination(prisma, { productId: parentProductId, name: "No cost", type: "SHARED", durationLabel: "1 Month", price: "10000" });
    const order = await prisma.order.create({ data: { orderCode: `ORD-nc-${Math.random()}`, userId, subtotalAmount: "10000", totalAmount: "10000", currency: "IDR", status: "DELIVERED", deliveredAt: now } });
    await prisma.orderItem.create({ data: { orderId: order.id, productId: product.id, quantity: 1, unitPrice: "10000", warrantyDaysSnapshot: 30 } });

    const result = await topProductsByMargin(prisma, new Date(now.getTime() - 60_000), 5);
    expect(result[0]).toEqual({ productId: product.id, name: "No cost", unitsSold: 1, revenueIdrEquiv: "10000", profitIdrEquiv: null, costUnknownUnits: 1 });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run packages/db/src/crud/reports.test.ts`
Expected: FAIL — `topProductsByMargin is not a function`

- [ ] **Step 3: Write minimal implementation**

```ts
export interface TopProductMargin {
  productId: number;
  name: string;
  unitsSold: number;
  revenueIdrEquiv: string;
  profitIdrEquiv: string | null;
  costUnknownUnits: number;
}

/**
 * Best-selling products since `since`, ranked by units sold, with revenue and
 * profit normalized to IDR-equivalent — USDT lines convert via each order's
 * own `fxRate` snapshot, the same "Combined" conversion `combinedRevenueByDay`
 * uses, never a live rate. `costPrice` is always catalog-central IDR, so it
 * needs no conversion. Any cost-unknown unit nulls that product's profit
 * (rather than silently treating unknown cost as zero) while still reporting
 * its revenue and the count of affected units.
 */
export async function topProductsByMargin(db: Db, since: Date, limit = 5): Promise<TopProductMargin[]> {
  const items = await db.orderItem.findMany({
    where: { order: { status: OrderStatus.DELIVERED, deliveredAt: { gte: since } } },
    select: {
      productId: true,
      quantity: true,
      unitPrice: true,
      product: { select: { name: true, costPrice: true } },
      order: { select: { currency: true, fxRate: true } },
    },
  });

  const acc = new Map<number, { name: string; units: number; revenue: Decimal; cost: Decimal; costUnknownUnits: number }>();
  for (const item of items) {
    const idrUnitPrice = item.order.currency === "USDT" && item.order.fxRate != null
      ? new Decimal(item.unitPrice).times(item.order.fxRate)
      : new Decimal(item.unitPrice);
    const a = acc.get(item.productId) ?? { name: item.product.name, units: 0, revenue: new Decimal(0), cost: new Decimal(0), costUnknownUnits: 0 };
    a.units += item.quantity;
    a.revenue = a.revenue.plus(idrUnitPrice.times(item.quantity));
    if (item.product.costPrice == null) {
      a.costUnknownUnits += item.quantity;
    } else {
      a.cost = a.cost.plus(new Decimal(item.product.costPrice).times(item.quantity));
    }
    acc.set(item.productId, a);
  }

  return [...acc.entries()]
    .map(([productId, a]) => ({
      productId,
      name: a.name,
      unitsSold: a.units,
      revenueIdrEquiv: q4(a.revenue).toString(),
      profitIdrEquiv: a.costUnknownUnits > 0 ? null : q4(a.revenue.minus(a.cost)).toString(),
      costUnknownUnits: a.costUnknownUnits,
    }))
    .sort((a, b) => b.unitsSold - a.unitsSold)
    .slice(0, limit);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run packages/db/src/crud/reports.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/db/src/crud/reports.ts packages/db/src/crud/reports.test.ts
git commit -m "feat(db): add topProductsByMargin with IDR-equivalent normalization"
```

---

### Task 10: `ordersByDay` and `combinedRevenueByDay`

**Files:**
- Modify: `packages/db/src/crud/reports.ts`
- Test: `packages/db/src/crud/reports.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface DayOrderCounts { day: string; ordersIdr: number; ordersUsdt: number }
  export async function ordersByDay(db: Db, days?: number): Promise<DayOrderCounts[]>

  export interface DayCombinedRevenue { day: string; revenueIdrEquiv: string }
  export async function combinedRevenueByDay(db: Db, days?: number): Promise<DayCombinedRevenue[]>
  ```

- [ ] **Step 1: Write the failing tests**

```ts
import { ordersByDay, combinedRevenueByDay } from "./reports"; // add to existing import line

describe("ordersByDay", () => {
  it("counts delivered orders per day, split by currency", async () => {
    const now = new Date();
    await prisma.order.create({ data: { orderCode: `ORD-a-${Math.random()}`, userId, subtotalAmount: "1", totalAmount: "1", currency: "IDR", status: "DELIVERED", deliveredAt: now } });
    await prisma.order.create({ data: { orderCode: `ORD-b-${Math.random()}`, userId, subtotalAmount: "1", totalAmount: "1", currency: "IDR", status: "DELIVERED", deliveredAt: now } });
    await prisma.order.create({ data: { orderCode: `ORD-c-${Math.random()}`, userId, subtotalAmount: "1", totalAmount: "1", currency: "USDT", status: "DELIVERED", deliveredAt: now } });

    const days = await ordersByDay(prisma, 1);
    expect(days).toEqual([{ day: days[0]!.day, ordersIdr: 2, ordersUsdt: 1 }]);
  });

  it("fills empty days with zero counts", async () => {
    const days = await ordersByDay(prisma, 3);
    expect(days).toHaveLength(3);
    for (const d of days) expect(d).toMatchObject({ ordersIdr: 0, ordersUsdt: 0 });
  });
});

describe("combinedRevenueByDay", () => {
  it("converts a USDT order's total to IDR-equivalent via its own fxRate, and leaves IDR orders unconverted", async () => {
    const now = new Date();
    await prisma.order.create({ data: { orderCode: `ORD-idr-${Math.random()}`, userId, subtotalAmount: "1", totalAmount: "54000", currency: "IDR", status: "DELIVERED", deliveredAt: now } });
    await prisma.order.create({ data: { orderCode: `ORD-usdt-${Math.random()}`, userId, subtotalAmount: "1", totalAmount: "3.43", currency: "USDT", fxRate: "16000", status: "DELIVERED", deliveredAt: now } });

    const days = await combinedRevenueByDay(prisma, 1);
    expect(days).toHaveLength(1);
    // 54000 (IDR, unconverted) + 3.43 * 16000 = 54880 (USDT, via its own snapshot rate)
    expect(days[0]!.revenueIdrEquiv).toBe("108880");
  });

  it("fills empty days with zero", async () => {
    const days = await combinedRevenueByDay(prisma, 2);
    expect(days).toHaveLength(2);
    for (const d of days) expect(d.revenueIdrEquiv).toBe("0");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run packages/db/src/crud/reports.test.ts`
Expected: FAIL — `ordersByDay`/`combinedRevenueByDay` are not functions

- [ ] **Step 3: Write minimal implementation**

```ts
export interface DayOrderCounts {
  day: string;
  ordersIdr: number;
  ordersUsdt: number;
}

/** Daily delivered-order counts for the last `days` days, oldest→newest,
 * split by currency — the order-count counterpart to revenueByDay, for the
 * Sales Analytics chart's "Orders" metric. Empty days are filled with zero. */
export async function ordersByDay(db: Db, days = 30): Promise<DayOrderCounts[]> {
  const now = new Date();
  const since = addDays(now, -(days - 1));
  since.setUTCHours(0, 0, 0, 0);

  const orders = await db.order.findMany({
    where: { status: OrderStatus.DELIVERED, deliveredAt: { gte: since } },
    select: { deliveredAt: true, currency: true },
  });

  const buckets = new Map<string, { idr: number; usdt: number }>();
  for (let i = 0; i < days; i++) {
    buckets.set(addDays(since, i).toISOString().slice(0, 10), { idr: 0, usdt: 0 });
  }
  for (const o of orders) {
    if (!o.deliveredAt) continue;
    const key = o.deliveredAt.toISOString().slice(0, 10);
    const b = buckets.get(key);
    if (!b) continue;
    if (o.currency === "IDR") b.idr += 1;
    else b.usdt += 1;
  }
  return [...buckets.entries()].map(([day, b]) => ({ day, ordersIdr: b.idr, ordersUsdt: b.usdt }));
}

export interface DayCombinedRevenue {
  day: string;
  revenueIdrEquiv: string;
}

/**
 * Daily delivered revenue for the last `days` days, oldest→newest, normalized
 * to IDR-equivalent: IDR orders pass through unconverted, USDT orders
 * convert via THEIR OWN fxRate snapshot — never a live rate, so a past day's
 * combined total never moves when today's fx rate changes. This is the one
 * place this function intentionally blends currencies — the "Combined"
 * filter the user explicitly opts into, as opposed to revenueByDay's
 * per-currency split.
 */
export async function combinedRevenueByDay(db: Db, days = 30): Promise<DayCombinedRevenue[]> {
  const now = new Date();
  const since = addDays(now, -(days - 1));
  since.setUTCHours(0, 0, 0, 0);

  const orders = await db.order.findMany({
    where: { status: OrderStatus.DELIVERED, deliveredAt: { gte: since } },
    select: { deliveredAt: true, totalAmount: true, currency: true, fxRate: true },
  });

  const buckets = new Map<string, Decimal>();
  for (let i = 0; i < days; i++) {
    buckets.set(addDays(since, i).toISOString().slice(0, 10), new Decimal(0));
  }
  for (const o of orders) {
    if (!o.deliveredAt) continue;
    const key = o.deliveredAt.toISOString().slice(0, 10);
    const current = buckets.get(key);
    if (!current) continue;
    const idrEquiv = o.currency === "USDT" && o.fxRate != null
      ? new Decimal(o.totalAmount).times(o.fxRate)
      : new Decimal(o.totalAmount);
    buckets.set(key, current.plus(idrEquiv));
  }
  return [...buckets.entries()].map(([day, total]) => ({ day, revenueIdrEquiv: q4(total).toString() }));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run packages/db/src/crud/reports.test.ts`
Expected: PASS — run the whole file once more here to confirm every describe block added in Tasks 2-10 is still green together.

- [ ] **Step 5: Commit**

```bash
git add packages/db/src/crud/reports.ts packages/db/src/crud/reports.test.ts
git commit -m "feat(db): add ordersByDay and combinedRevenueByDay for the Sales Analytics chart"
```

---

### Task 11: route scaffold + `GET /api/dashboard/kpis`

**Files:**
- Create: `apps/web-admin/src/routes/api/dashboard.ts`
- Modify: `apps/web-admin/src/server.ts` (register the new route)
- Create: `apps/web-admin/test/dashboard-api.test.ts`

**Interfaces:**
- Consumes: `revenueSummary`, `profitSummarySince`, `ordersByStatusSince`, `manualMatchQueueCounts`, `countPendingVerifications`, `countUnderpaid` (all from `@app/db`), `startOfDayUtc` (`@app/core/datetime`), `currentAdmin` (`../../plugins/auth`).
- Produces: `GET /api/dashboard/kpis` → `{ revenue: { idr: string|null, usdt: string|null, usd: string|null, trendPct: { idr: string|null, usdt: string|null } }, profit: ProfitSummary, orders: { total: number, delivered: number, pending: number, failed: number }, pendingActions: { toReview: number, refundDecisions: number, failedDeliveries: number, manualApprovals: number } }`

- [ ] **Step 1: Write the failing test (new file)**

```ts
// apps/web-admin/test/dashboard-api.test.ts
import "./setup-env";
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import type { FastifyInstance } from "fastify";
import { config } from "@app/core/config";
import {
  prisma,
  initDb,
  upsertUser,
  setSetting,
  createCategory,
  createCatalogProduct,
  createDenomination,
  bulkAddStock,
} from "@app/db";
import { resetDb } from "../../../tests/helpers/sampleData";
import { buildApp } from "../src/server";
import { makeSession, newJti, sessionJtiKey } from "../src/auth";

const ADMIN_TG = 999;
const COOKIE = config.WEB_COOKIE_NAME;
let app: FastifyInstance;
let cookie: string;

beforeAll(async () => {
  await initDb();
  app = await buildApp();
  await app.ready();
});
afterAll(async () => {
  await app.close();
  await prisma.$disconnect();
});
beforeEach(async () => {
  await resetDb(prisma);
  const admin = await upsertUser(prisma, { telegramId: ADMIN_TG, username: "admin", fullName: "Admin" });
  const jti = newJti();
  await setSetting(prisma, sessionJtiKey(ADMIN_TG), jti);
  const { raw } = makeSession(admin.id, ADMIN_TG, jti);
  cookie = raw;
  await setSetting(prisma, "setup_completed", "true");
});

function get(url: string, withCookie: string | null) {
  return app.inject({ method: "GET", url, cookies: withCookie ? { [COOKIE]: withCookie } : {} });
}

describe("GET /api/dashboard/kpis", () => {
  it("anon is redirected to /login", async () => {
    const res = await get("/api/dashboard/kpis", null);
    expect(res.statusCode).toBe(303);
    expect(res.headers.location).toBe("/login");
  });

  it("returns today's revenue, profit, order funnel, and pending actions", async () => {
    const user = await upsertUser(prisma, { telegramId: 42, username: "buyer", fullName: "Buyer" });
    const order = await prisma.order.create({
      data: { orderCode: "ORD-1", userId: user.id, subtotalAmount: "10000", totalAmount: "10000", currency: "IDR", status: "DELIVERED", deliveredAt: new Date() },
    });
    void order;

    const res = await get("/api/dashboard/kpis", cookie);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.revenue.idr).toBe("10000");
    expect(body.revenue.usdt).toBeNull();
    expect(body.orders.total).toBe(1);
    expect(body.orders.delivered).toBe(1);
    expect(body.pendingActions).toEqual({ toReview: 0, refundDecisions: 0, failedDeliveries: 0, manualApprovals: 0 });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run apps/web-admin/test/dashboard-api.test.ts`
Expected: FAIL — 404 (route doesn't exist yet)

- [ ] **Step 3: Write minimal implementation**

Create `apps/web-admin/src/routes/api/dashboard.ts`:

```ts
/**
 * JSON API for the React dashboard pilot page (docs/superpowers/specs/
 * 2026-06-25-admin-dashboard-redesign-design.md). Every endpoint is a
 * read-only GET guarded by the same currentAdmin preHandler the Nunjucks
 * pages use — no separate auth model, no CSRF (nothing here mutates).
 */
import type { FastifyInstance } from "fastify";
import { startOfDayUtc } from "@app/core/datetime";
import { Decimal } from "@app/core/money";
import {
  prisma,
  revenueSummary,
  profitSummarySince,
  ordersByStatusSince,
  manualMatchQueueCounts,
  countPendingVerifications,
  countUnderpaid,
} from "@app/db";
import { currentAdmin } from "../../plugins/auth";

function shapeRevenue(r: { revenue_idr: Decimal; revenue_usdt: Decimal }) {
  const idr = new Decimal(r.revenue_idr);
  const usdt = new Decimal(r.revenue_usdt);
  return {
    idr: idr.isZero() ? null : idr.toString(),
    usdt: usdt.isZero() ? null : usdt.toString(),
    usd: usdt.isZero() ? null : usdt.toString(), // 1 USDT ≈ 1 USD, same figure under a second label
  };
}

function trendPct(curr: Decimal, prev: Decimal): string | null {
  if (prev.isZero()) return null;
  return curr.minus(prev).div(prev).times(100).toDecimalPlaces(1).toString();
}

export default async function dashboardApiRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/dashboard/kpis", { preHandler: currentAdmin }, async () => {
    const todayStart = startOfDayUtc();
    const yesterdayStart = startOfDayUtc(new Date(todayStart.getTime() - 1));
    const now = new Date();
    const yesterdaySameClock = new Date(yesterdayStart.getTime() + (now.getTime() - todayStart.getTime()));

    const todayRevenue = await revenueSummary(prisma, todayStart);
    const yesterdayRevenue = await revenueSummary(prisma, yesterdayStart, yesterdaySameClock);
    const profit = await profitSummarySince(prisma, todayStart);
    const orderStatus = await ordersByStatusSince(prisma, todayStart);
    const manualQueue = await manualMatchQueueCounts(prisma);
    const toReview = await countPendingVerifications(prisma);
    const underpaid = await countUnderpaid(prisma);

    const ordersTotal = orderStatus.reduce((sum, s) => sum + s.count, 0);
    const byStatus = (statuses: string[]) =>
      orderStatus.filter((s) => statuses.includes(s.status)).reduce((sum, s) => sum + s.count, 0);

    return {
      revenue: {
        ...shapeRevenue(todayRevenue),
        trendPct: {
          idr: trendPct(new Decimal(todayRevenue.revenue_idr), new Decimal(yesterdayRevenue.revenue_idr)),
          usdt: trendPct(new Decimal(todayRevenue.revenue_usdt), new Decimal(yesterdayRevenue.revenue_usdt)),
        },
      },
      profit,
      orders: {
        total: ordersTotal,
        delivered: byStatus(["DELIVERED"]),
        pending: byStatus(["PENDING_PAYMENT", "PAYMENT_DETECTED", "CONFIRMING", "PENDING_VERIFICATION", "UNDERPAID"]),
        failed: byStatus(["CANCELLED", "REJECTED", "FAILED"]),
      },
      pendingActions: {
        toReview,
        refundDecisions: underpaid,
        failedDeliveries: manualQueue.deliveryFailed,
        manualApprovals: manualQueue.unmatched,
      },
    };
  });
}
```

Modify `apps/web-admin/src/server.ts`: add the import alongside the other route imports —

```ts
import dashboardApiRoutes from "./routes/api/dashboard";
```

— and register it alongside `dashboardRoutes`:

```ts
  await app.register(dashboardRoutes);
  await app.register(dashboardApiRoutes);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run apps/web-admin/test/dashboard-api.test.ts`
Expected: PASS (2 tests)

- [ ] **Step 5: Commit**

```bash
git add apps/web-admin/src/routes/api/dashboard.ts apps/web-admin/src/server.ts apps/web-admin/test/dashboard-api.test.ts
git commit -m "feat(web-admin): add GET /api/dashboard/kpis"
```

---

### Task 12: `GET /api/dashboard/operations`, `/inventory`, `/expirations`

**Files:**
- Modify: `apps/web-admin/src/routes/api/dashboard.ts`
- Modify: `apps/web-admin/test/dashboard-api.test.ts`

**Interfaces:**
- Consumes: `countPendingPaymentLike`, `countProcessing`, `countExpiredPending`, `lowStockDenominations`, `listOrderItemsExpiringWarranty` (`@app/db`), `addDays` (`@app/core/datetime`), `config.LOW_STOCK_THRESHOLD` (`@app/core/config`).
- Produces:
  - `GET /api/dashboard/operations` → `{ pendingPayments: number, manualReviews: number, failedDeliveries: number, ordersProcessing: number, expiredPayments: number }`
  - `GET /api/dashboard/inventory?threshold=` → `Array<{ denominationId: number, productName: string, available: number, threshold: number }>`
  - `GET /api/dashboard/expirations?withinDays=` → `Array<{ orderId: number, orderCode: string, productName: string, customerLabel: string, remainingDays: number }>`

- [ ] **Step 1: Write the failing tests**

Add to `apps/web-admin/test/dashboard-api.test.ts`:

```ts
describe("GET /api/dashboard/operations", () => {
  it("anon is redirected to /login", async () => {
    const res = await get("/api/dashboard/operations", null);
    expect(res.statusCode).toBe(303);
  });

  it("reports the operation-center counts", async () => {
    const buyer = await upsertUser(prisma, { telegramId: 42, username: "buyer", fullName: "Buyer" });
    await prisma.order.create({ data: { orderCode: "ORD-pp", userId: buyer.id, subtotalAmount: "1", totalAmount: "1", status: "PENDING_PAYMENT" } });
    await prisma.order.create({ data: { orderCode: "ORD-proc", userId: buyer.id, subtotalAmount: "1", totalAmount: "1", status: "PAID" } });

    const res = await get("/api/dashboard/operations", cookie);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ pendingPayments: 1, ordersProcessing: 1 });
  });
});

describe("GET /api/dashboard/inventory", () => {
  it("anon is redirected to /login", async () => {
    const res = await get("/api/dashboard/inventory", null);
    expect(res.statusCode).toBe(303);
  });

  it("lists denominations at or below the threshold", async () => {
    const category = await createCategory(prisma, "Cat");
    const parent = await createCatalogProduct(prisma, { categoryId: category.id, name: "Parent", description: "x" });
    const denom = await createDenomination(prisma, { productId: parent.id, name: "Low item", type: "SHARED", durationLabel: "1 Month", price: "1" });
    await bulkAddStock(prisma, denom.id, ["a@b.com:pw"]);

    const res = await get("/api/dashboard/inventory?threshold=3", cookie);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual([{ denominationId: denom.id, productName: "Low item", available: 1, threshold: 3 }]);
  });
});

describe("GET /api/dashboard/expirations", () => {
  it("anon is redirected to /login", async () => {
    const res = await get("/api/dashboard/expirations", null);
    expect(res.statusCode).toBe(303);
  });

  it("lists order items whose warranty expires within the window", async () => {
    const buyer = await upsertUser(prisma, { telegramId: 42, username: "buyer", fullName: "Buyer" });
    const category = await createCategory(prisma, "Cat");
    const parent = await createCatalogProduct(prisma, { categoryId: category.id, name: "Parent", description: "x" });
    const denom = await createDenomination(prisma, { productId: parent.id, name: "Expiring item", type: "SHARED", durationLabel: "1 Month", price: "1", warrantyDays: 1 });
    const deliveredAt = new Date(); // expires in 1 day, well inside a 7-day window
    const order = await prisma.order.create({ data: { orderCode: "ORD-exp", userId: buyer.id, subtotalAmount: "1", totalAmount: "1", status: "DELIVERED", deliveredAt } });
    await prisma.orderItem.create({ data: { orderId: order.id, productId: denom.id, quantity: 1, unitPrice: "1", warrantyDaysSnapshot: 1 } });

    const res = await get("/api/dashboard/expirations?withinDays=7", cookie);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toHaveLength(1);
    expect(body[0]).toMatchObject({ orderId: order.id, orderCode: "ORD-exp", productName: "Expiring item", customerLabel: "buyer" });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run apps/web-admin/test/dashboard-api.test.ts`
Expected: FAIL — 404 on all three new routes

- [ ] **Step 3: Write minimal implementation**

Add to the import block in `apps/web-admin/src/routes/api/dashboard.ts`:

```ts
import { config } from "@app/core/config";
import { addDays } from "@app/core/datetime";
import {
  prisma,
  revenueSummary,
  profitSummarySince,
  ordersByStatusSince,
  manualMatchQueueCounts,
  countPendingVerifications,
  countUnderpaid,
  countPendingPaymentLike,
  countProcessing,
  countExpiredPending,
  lowStockDenominations,
  listOrderItemsExpiringWarranty,
} from "@app/db";
```

Add inside `dashboardApiRoutes`, after the `/kpis` handler:

```ts
  app.get("/api/dashboard/operations", { preHandler: currentAdmin }, async () => {
    const now = new Date();
    const [pendingPayments, manualReviews, manualQueue, ordersProcessing, expiredPayments] = await Promise.all([
      countPendingPaymentLike(prisma),
      countPendingVerifications(prisma),
      manualMatchQueueCounts(prisma),
      countProcessing(prisma),
      countExpiredPending(prisma, now),
    ]);
    return {
      pendingPayments,
      manualReviews,
      failedDeliveries: manualQueue.deliveryFailed,
      ordersProcessing,
      expiredPayments,
    };
  });

  app.get("/api/dashboard/inventory", { preHandler: currentAdmin }, async (req) => {
    const q = req.query as Record<string, string | undefined>;
    const threshold = q.threshold ? Number(q.threshold) : config.LOW_STOCK_THRESHOLD;
    const rows = await lowStockDenominations(prisma, threshold);
    return rows.map((r) => ({
      denominationId: r.denomination.id,
      productName: r.denomination.name,
      available: r.available,
      threshold,
    }));
  });

  app.get("/api/dashboard/expirations", { preHandler: currentAdmin }, async (req) => {
    const q = req.query as Record<string, string | undefined>;
    const withinDays = q.withinDays ? Number(q.withinDays) : 7;
    const now = new Date();
    const rows = await listOrderItemsExpiringWarranty(prisma, now, addDays(now, withinDays));
    return rows.map((item) => ({
      orderId: item.order.id,
      orderCode: item.order.orderCode,
      productName: item.product.name,
      customerLabel: item.order.user.username ?? `Telegram ${item.order.user.telegramId}`,
      remainingDays: Math.max(
        0,
        Math.ceil((addDays(item.order.deliveredAt!, item.warrantyDaysSnapshot).getTime() - now.getTime()) / 86_400_000),
      ),
    }));
  });
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run apps/web-admin/test/dashboard-api.test.ts`
Expected: PASS (8 tests)

- [ ] **Step 5: Commit**

```bash
git add apps/web-admin/src/routes/api/dashboard.ts apps/web-admin/test/dashboard-api.test.ts
git commit -m "feat(web-admin): add operations/inventory/expirations dashboard API endpoints"
```

---

### Task 13: `GET /api/dashboard/orders/recent`, `/health`, `/top-products`

**Files:**
- Modify: `apps/web-admin/src/routes/api/dashboard.ts`
- Modify: `apps/web-admin/test/dashboard-api.test.ts`

**Interfaces:**
- Consumes: `recentOrders`, `topProductsByMargin`, `resolveBotCredentials`, `resolveBinanceInternalConfig`, `getBinancePollHealth` (`@app/db`).
- Produces:
  - `GET /api/dashboard/orders/recent?limit=` → `RecentOrderRow[]`
  - `GET /api/dashboard/health` → `{ telegramBot: "red"|"green", binance: "red"|"yellow"|"green"|"unmonitored", bybit: "unmonitored", tokopay: "unmonitored", paydisini: "unmonitored", nowpayments: "unmonitored" }`
  - `GET /api/dashboard/top-products?days=&limit=` → `TopProductMargin[]`

- [ ] **Step 1: Write the failing tests**

Add to `apps/web-admin/test/dashboard-api.test.ts`:

```ts
describe("GET /api/dashboard/orders/recent", () => {
  it("anon is redirected to /login", async () => {
    const res = await get("/api/dashboard/orders/recent", null);
    expect(res.statusCode).toBe(303);
  });

  it("returns the newest orders first", async () => {
    const buyer = await upsertUser(prisma, { telegramId: 42, username: "buyer", fullName: "Buyer" });
    await prisma.order.create({ data: { orderCode: "ORD-1", userId: buyer.id, subtotalAmount: "1", totalAmount: "1", status: "DELIVERED" } });

    const res = await get("/api/dashboard/orders/recent?limit=5", cookie);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toHaveLength(1);
  });
});

describe("GET /api/dashboard/health", () => {
  it("anon is redirected to /login", async () => {
    const res = await get("/api/dashboard/health", null);
    expect(res.statusCode).toBe(303);
  });

  it("reports the bot token-missing flag and an unmonitored status for unhealthed providers", async () => {
    const res = await get("/api/dashboard/health", cookie);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.telegramBot).toBe("red"); // no token configured in this test env
    expect(body.bybit).toBe("unmonitored");
    expect(body.tokopay).toBe("unmonitored");
    expect(body.paydisini).toBe("unmonitored");
    expect(body.nowpayments).toBe("unmonitored");
  });
});

describe("GET /api/dashboard/top-products", () => {
  it("anon is redirected to /login", async () => {
    const res = await get("/api/dashboard/top-products", null);
    expect(res.statusCode).toBe(303);
  });

  it("returns delivered products ranked by units sold", async () => {
    const buyer = await upsertUser(prisma, { telegramId: 42, username: "buyer", fullName: "Buyer" });
    const category = await createCategory(prisma, "Cat");
    const parent = await createCatalogProduct(prisma, { categoryId: category.id, name: "Parent", description: "x" });
    const denom = await createDenomination(prisma, { productId: parent.id, name: "Top item", type: "SHARED", durationLabel: "1 Month", price: "10000", costPrice: "5000" });
    const order = await prisma.order.create({ data: { orderCode: "ORD-top", userId: buyer.id, subtotalAmount: "10000", totalAmount: "10000", currency: "IDR", status: "DELIVERED", deliveredAt: new Date() } });
    await prisma.orderItem.create({ data: { orderId: order.id, productId: denom.id, quantity: 1, unitPrice: "10000", warrantyDaysSnapshot: 30 } });

    const res = await get("/api/dashboard/top-products?days=30&limit=5", cookie);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual([{ productId: denom.id, name: "Top item", unitsSold: 1, revenueIdrEquiv: "10000", profitIdrEquiv: "5000", costUnknownUnits: 0 }]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run apps/web-admin/test/dashboard-api.test.ts`
Expected: FAIL — 404 on all three new routes

- [ ] **Step 3: Write minimal implementation**

Add to the `@app/db` import block:

```ts
  recentOrders,
  topProductsByMargin,
  resolveBotCredentials,
  resolveBinanceInternalConfig,
  getBinancePollHealth,
```

Add inside `dashboardApiRoutes`, after `/expirations`:

```ts
  app.get("/api/dashboard/orders/recent", { preHandler: currentAdmin }, async (req) => {
    const q = req.query as Record<string, string | undefined>;
    const limit = q.limit ? Number(q.limit) : 10;
    return recentOrders(prisma, limit);
  });

  app.get("/api/dashboard/health", { preHandler: currentAdmin }, async () => {
    const creds = await resolveBotCredentials(prisma);
    const binanceEnabled = (await resolveBinanceInternalConfig(prisma)).enabled;
    const binanceHealth = binanceEnabled ? await getBinancePollHealth(prisma) : null;

    const binanceStatus = !binanceEnabled
      ? "unmonitored"
      : (binanceHealth!.consecutiveFailures ?? 0) > 0
        ? "red"
        : binanceHealth!.backoffUntil
          ? "yellow"
          : "green";

    return {
      telegramBot: creds.botToken === null ? "red" : "green",
      binance: binanceStatus,
      bybit: "unmonitored",
      tokopay: "unmonitored",
      paydisini: "unmonitored",
      nowpayments: "unmonitored",
    };
  });

  app.get("/api/dashboard/top-products", { preHandler: currentAdmin }, async (req) => {
    const q = req.query as Record<string, string | undefined>;
    const days = q.days ? Number(q.days) : 30;
    const limit = q.limit ? Number(q.limit) : 5;
    return topProductsByMargin(prisma, addDays(new Date(), -days), limit);
  });
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run apps/web-admin/test/dashboard-api.test.ts`
Expected: PASS (14 tests)

- [ ] **Step 5: Commit**

```bash
git add apps/web-admin/src/routes/api/dashboard.ts apps/web-admin/test/dashboard-api.test.ts
git commit -m "feat(web-admin): add recent-orders/health/top-products dashboard API endpoints"
```

---

### Task 14: `GET /api/dashboard/analytics`

**Files:**
- Modify: `apps/web-admin/src/routes/api/dashboard.ts`
- Modify: `apps/web-admin/test/dashboard-api.test.ts`

**Interfaces:**
- Consumes: `revenueByDay`, `ordersByDay`, `combinedRevenueByDay` (`@app/db`).
- Produces: `GET /api/dashboard/analytics?range=7d|30d&currency=idr|usdt|combined&metric=revenue|orders` → `Array<{ day: string; value: string | number }>`

- [ ] **Step 1: Write the failing tests**

Add to `apps/web-admin/test/dashboard-api.test.ts`:

```ts
describe("GET /api/dashboard/analytics", () => {
  it("anon is redirected to /login", async () => {
    const res = await get("/api/dashboard/analytics", null);
    expect(res.statusCode).toBe(303);
  });

  it("defaults to a 7-day IDR revenue series", async () => {
    const buyer = await upsertUser(prisma, { telegramId: 42, username: "buyer", fullName: "Buyer" });
    await prisma.order.create({ data: { orderCode: "ORD-1", userId: buyer.id, subtotalAmount: "1", totalAmount: "5000", currency: "IDR", status: "DELIVERED", deliveredAt: new Date() } });

    const res = await get("/api/dashboard/analytics", cookie);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toHaveLength(7);
    expect(body[6].value).toBe("5000"); // today is the last bucket
  });

  it("switches to order counts when metric=orders", async () => {
    const buyer = await upsertUser(prisma, { telegramId: 42, username: "buyer", fullName: "Buyer" });
    await prisma.order.create({ data: { orderCode: "ORD-1", userId: buyer.id, subtotalAmount: "1", totalAmount: "5000", currency: "IDR", status: "DELIVERED", deliveredAt: new Date() } });

    const res = await get("/api/dashboard/analytics?metric=orders", cookie);
    expect(res.json()[6].value).toBe(1);
  });

  it("switches to the IDR-equivalent combined series when currency=combined", async () => {
    const buyer = await upsertUser(prisma, { telegramId: 42, username: "buyer", fullName: "Buyer" });
    await prisma.order.create({ data: { orderCode: "ORD-1", userId: buyer.id, subtotalAmount: "1", totalAmount: "3", currency: "USDT", fxRate: "16000", status: "DELIVERED", deliveredAt: new Date() } });

    const res = await get("/api/dashboard/analytics?currency=combined", cookie);
    expect(res.json()[6].value).toBe("48000");
  });

  it("accepts range=30d", async () => {
    const res = await get("/api/dashboard/analytics?range=30d", cookie);
    expect(res.json()).toHaveLength(30);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run apps/web-admin/test/dashboard-api.test.ts`
Expected: FAIL — 404 on `/api/dashboard/analytics`

- [ ] **Step 3: Write minimal implementation**

Add to the `@app/db` import block: `revenueByDay, ordersByDay, combinedRevenueByDay,`

Add inside `dashboardApiRoutes`, after `/top-products`:

```ts
  app.get("/api/dashboard/analytics", { preHandler: currentAdmin }, async (req) => {
    const q = req.query as Record<string, string | undefined>;
    const days = q.range === "30d" ? 30 : 7;
    const currency = q.currency ?? "idr";
    const metric = q.metric ?? "revenue";

    if (metric === "orders") {
      const rows = await ordersByDay(prisma, days);
      return rows.map((r) => ({ day: r.day, value: currency === "usdt" ? r.ordersUsdt : r.ordersIdr }));
    }
    if (currency === "combined") {
      const rows = await combinedRevenueByDay(prisma, days);
      return rows.map((r) => ({ day: r.day, value: r.revenueIdrEquiv }));
    }
    const rows = await revenueByDay(prisma, days);
    return rows.map((r) => ({ day: r.day, value: currency === "usdt" ? r.revenue_usdt : r.revenue_idr }));
  });
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run apps/web-admin/test/dashboard-api.test.ts`
Expected: PASS (18 tests)

- [ ] **Step 5: Run the full test suite + typecheck**

Run: `pnpm typecheck`
Expected: PASS, no new errors

Run: `pnpm test`
Expected: PASS, plus the 2 pre-existing unrelated failures in `notifications.test.ts` noted in PR #22 (not introduced by this plan)

- [ ] **Step 6: Commit**

```bash
git add apps/web-admin/src/routes/api/dashboard.ts apps/web-admin/test/dashboard-api.test.ts
git commit -m "feat(web-admin): add GET /api/dashboard/analytics"
```

---

## Verification

- After Task 14, run `pnpm typecheck && pnpm test` from the repo root — both must be green (modulo the 2 pre-existing `notifications.test.ts` failures already flagged in PR #22, unrelated to this plan).
- Manually smoke-test with `pnpm --filter @app/server dev` (or however the app is normally started) and `curl`/browser-hit each of the 8 endpoints while logged in as an admin; confirm a 303 redirect when hit without a session cookie.
- Confirm the existing Nunjucks dashboard at `/` still renders unchanged — this plan never touches `apps/web-admin/src/routes/dashboard.ts` or `dashboard.njk`.
