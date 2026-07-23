# Payments Page Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the Payments page's KPI-correctness bug and bring it structurally in line with the `OrdersPage.tsx` reference pattern (search, bulk actions, shared `Pagination`), while wiring up the already-built-but-unused "credit to buyer's balance" and Binance poll-health surfaces.

**Architecture:** Two small backend additions (a new crud count helper + a `q` search param on the existing ledger listing) feed one existing route (`GET /api/payments`). All remaining work is contained inside `apps/web-admin/client/src/pages/PaymentsPage.tsx`, following patterns already proven on `OrdersPage.tsx` (bulk selection, `DropdownMenu` row actions, shared `Pagination`).

**Tech Stack:** Fastify + Prisma (backend), React + TanStack Query + shadcn/Tailwind (frontend), Vitest + React Testing Library (tests).

## Global Constraints

- Money stays `Decimal` (`@app/core/money`) end to end — no `float`. (Not directly touched here; `creditOrderToBalance`/`adjustWallet` already handle this.)
- No raw SQL — all DB access through `packages/db/src/crud/*`.
- UTC in DB, `TIMEZONE` (`config.TIMEZONE`, Asia/Jakarta) on display/day-boundary math — use `startOfDayUtc` from `packages/core/src/datetime.ts`, never hand-rolled date math.
- Every admin mutation is audited via `logAdminAction` — this plan adds no new mutation routes, so no new audit call sites are needed (bulk dismiss reuses the existing single-dismiss route/audit call once per id; credit-to-balance reuses the existing `/api/payments/credit` route, which already audits).
- Never send Telegram from the web — not applicable here.
- `pnpm typecheck` and `pnpm test` must stay green after every task.
- UI changes follow `docs/ui/00_AI_RULES.md`'s component precedence — reuse `StatCard`, `SearchBar`, `Pagination`, `DropdownMenu`, `Checkbox`, `Dialog`, `UrgencyDot`; never hand-roll a raw `<table>`, `window.confirm()`, or a new pagination control.
- New status values go into `StatusBadge`'s `TONE` map, never a bespoke pill.

---

## Task 1: Backend — `countProcessedBinanceTxToday` crud helper

**Files:**
- Modify: `packages/db/src/crud/binance_internal.ts`
- Create: `packages/db/src/crud/binance_internal_ledger.test.ts`

**Interfaces:**
- Produces: `countProcessedBinanceTxToday(db: Db, now: Date = new Date()): Promise<number>`

- [ ] **Step 1: Write the failing test**

Create `packages/db/src/crud/binance_internal_ledger.test.ts`:

```ts
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { makeTestDb, type TestDb } from "../../../../tests/helpers/testdb";
import { resetDb } from "../../../../tests/helpers/sampleData";
import { recordUnmatchedTx, countProcessedBinanceTxToday } from "@app/db";

let db: TestDb;
let prisma: PrismaClient;

beforeAll(async () => {
  db = await makeTestDb();
  prisma = db.prisma;
});
afterAll(async () => {
  await db.cleanup();
});
beforeEach(async () => {
  await resetDb(prisma);
  await prisma.processedBinanceTx.deleteMany();
});

describe("countProcessedBinanceTxToday", () => {
  it("counts rows created today and excludes rows from other days", async () => {
    await recordUnmatchedTx(prisma, { binanceTxId: "TODAY-1", amount: "1.00" });
    await recordUnmatchedTx(prisma, { binanceTxId: "TODAY-2", amount: "1.00" });
    await recordUnmatchedTx(prisma, { binanceTxId: "YESTERDAY-1", amount: "1.00" });
    await prisma.processedBinanceTx.update({
      where: { binanceTxId: "YESTERDAY-1" },
      data: { createdAt: new Date(Date.now() - 24 * 60 * 60 * 1000) },
    });

    const count = await countProcessedBinanceTxToday(prisma);
    expect(count).toBe(2);
  });

  it("returns 0 when there are no rows today", async () => {
    await recordUnmatchedTx(prisma, { binanceTxId: "OLD-1", amount: "1.00" });
    await prisma.processedBinanceTx.update({
      where: { binanceTxId: "OLD-1" },
      data: { createdAt: new Date(Date.now() - 48 * 60 * 60 * 1000) },
    });

    const count = await countProcessedBinanceTxToday(prisma);
    expect(count).toBe(0);
  });

  it("respects an explicit `now` reference for the day boundary", async () => {
    await recordUnmatchedTx(prisma, { binanceTxId: "FIXED-1", amount: "1.00" });
    const farFuture = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
    const count = await countProcessedBinanceTxToday(prisma, farFuture);
    expect(count).toBe(0); // the row was created "now", not on farFuture's day
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @app/db test binance_internal_ledger -- -t countProcessedBinanceTxToday`
Expected: FAIL — `countProcessedBinanceTxToday is not a function` (not exported yet).

- [ ] **Step 3: Write minimal implementation**

In `packages/db/src/crud/binance_internal.ts`, add the import and function right after `processedTxOutcomeCounts` (after line 325's closing brace, before the `underpaidReceived` comment block):

```ts
import { startOfDayUtc } from "@app/core/datetime";
```

Add this import alongside the file's existing top-of-file imports (check the existing import block first — if `@app/core/datetime` or a sibling `@app/core` import already exists there, add `startOfDayUtc` to it instead of a new import line).

```ts
/** Count of ledger rows created today (shop's configured TIMEZONE), for the
 *  Payments page's "Today's Transactions" KPI — always accurate regardless
 *  of ledger pagination, unlike counting rows on the current page. */
export function countProcessedBinanceTxToday(db: Db, now: Date = new Date()): Promise<number> {
  return db.processedBinanceTx.count({ where: { createdAt: { gte: startOfDayUtc(now) } } });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @app/db test binance_internal_ledger`
Expected: PASS (3 tests)

- [ ] **Step 5: Commit**

```bash
git add packages/db/src/crud/binance_internal.ts packages/db/src/crud/binance_internal_ledger.test.ts
git commit -m "feat(db): add countProcessedBinanceTxToday for accurate Payments KPI"
```

---

## Task 2: Backend — `q` search param on the ledger listing

**Files:**
- Modify: `packages/db/src/crud/binance_internal.ts`
- Modify: `packages/db/src/crud/binance_internal_ledger.test.ts`

**Interfaces:**
- Consumes: nothing new from Task 1.
- Produces: `listProcessedBinanceTx(db, opts: { outcome?: string | null; limit?: number; offset?: number; q?: string | null })` and `countProcessedBinanceTx(db, opts: { outcome?: string | null; q?: string | null })` — both backward compatible (existing callers passing no `q` are unaffected).

- [ ] **Step 1: Write the failing test**

Append to `packages/db/src/crud/binance_internal_ledger.test.ts` (add the import, then the new `describe` block):

```ts
import { listProcessedBinanceTx, countProcessedBinanceTx } from "@app/db";
```

```ts
describe("listProcessedBinanceTx / countProcessedBinanceTx — q search", () => {
  it("filters by a substring match on binanceTxId", async () => {
    await recordUnmatchedTx(prisma, { binanceTxId: "ABC-123", amount: "1.00" });
    await recordUnmatchedTx(prisma, { binanceTxId: "XYZ-999", amount: "1.00" });

    const rows = await listProcessedBinanceTx(prisma, { q: "abc" });
    expect(rows.map((r) => r.binanceTxId)).toEqual(["ABC-123"]);

    const count = await countProcessedBinanceTx(prisma, { q: "abc" });
    expect(count).toBe(1);
  });

  it("returns everything when q is empty or omitted", async () => {
    await recordUnmatchedTx(prisma, { binanceTxId: "ROW-1", amount: "1.00" });
    await recordUnmatchedTx(prisma, { binanceTxId: "ROW-2", amount: "1.00" });

    expect((await listProcessedBinanceTx(prisma, {})).length).toBe(2);
    expect((await listProcessedBinanceTx(prisma, { q: "" })).length).toBe(2);
  });

  it("returns an empty array when nothing matches", async () => {
    await recordUnmatchedTx(prisma, { binanceTxId: "ROW-1", amount: "1.00" });
    const rows = await listProcessedBinanceTx(prisma, { q: "no-such-substring" });
    expect(rows).toEqual([]);
  });

  it("combines q with an outcome filter", async () => {
    await recordUnmatchedTx(prisma, { binanceTxId: "COMBO-1", amount: "1.00" });
    await prisma.processedBinanceTx.create({
      data: { binanceTxId: "COMBO-2", amount: "1.00", outcome: "dismissed" },
    });

    const rows = await listProcessedBinanceTx(prisma, { q: "combo", outcome: "unmatched" });
    expect(rows.map((r) => r.binanceTxId)).toEqual(["COMBO-1"]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @app/db test binance_internal_ledger -- -t "q search"`
Expected: FAIL — extra rows returned (the `q` option is silently ignored today).

- [ ] **Step 3: Write minimal implementation**

In `packages/db/src/crud/binance_internal.ts`, replace `listProcessedBinanceTx` and `countProcessedBinanceTx` (lines 293–317 in the current file):

```ts
export async function listProcessedBinanceTx(
  db: Db,
  opts: { outcome?: string | null; limit?: number; offset?: number; q?: string | null } = {},
) {
  const where: Record<string, unknown> = {};
  if (opts.outcome) where.outcome = opts.outcome;
  if (opts.q && opts.q.trim()) where.binanceTxId = { contains: opts.q.trim() };
  const rows = await db.processedBinanceTx.findMany({
    where,
    orderBy: { createdAt: "desc" },
    skip: opts.offset ?? 0,
    take: opts.limit ?? 50,
  });
  const orderIds = [...new Set(rows.map((r) => r.orderId).filter((id): id is number => id != null))];
  const orders = orderIds.length
    ? await db.order.findMany({
        where: { id: { in: orderIds } },
        select: { id: true, orderCode: true, status: true, totalAmount: true },
      })
    : [];
  const byId = new Map(orders.map((o) => [o.id, o as LinkedOrder]));
  return rows.map((r) => ({ ...r, order: r.orderId != null ? byId.get(r.orderId) ?? null : null }));
}

export function countProcessedBinanceTx(db: Db, opts: { outcome?: string | null; q?: string | null } = {}) {
  const where: Record<string, unknown> = {};
  if (opts.outcome) where.outcome = opts.outcome;
  if (opts.q && opts.q.trim()) where.binanceTxId = { contains: opts.q.trim() };
  return db.processedBinanceTx.count({ where });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @app/db test binance_internal_ledger`
Expected: PASS (7 tests total — 3 from Task 1 + 4 new)

- [ ] **Step 5: Commit**

```bash
git add packages/db/src/crud/binance_internal.ts packages/db/src/crud/binance_internal_ledger.test.ts
git commit -m "feat(db): add q substring search to listProcessedBinanceTx/countProcessedBinanceTx"
```

---

## Task 3: Backend route — wire `todayCount` and `q` into `GET /api/payments`

**Files:**
- Modify: `apps/web-admin/src/routes/api/payments.ts`
- Modify: `apps/web-admin/test/web.test.ts`

**Interfaces:**
- Consumes: `countProcessedBinanceTxToday` (Task 1), `listProcessedBinanceTx`/`countProcessedBinanceTx` with `q` (Task 2).
- Produces: `GET /api/payments` response gains `todayCount: number`; accepts an optional `?q=` query param (substring match on Transfer ID).

- [ ] **Step 1: Write the failing test**

Add near the existing `"GET /api/payments lists unmatched transactions"` test in `apps/web-admin/test/web.test.ts` (around line 3620):

```ts
  it("GET /api/payments returns todayCount and honors the q search param", async () => {
    await recordUnmatchedTx(prisma, { binanceTxId: "SEARCHABLE-1", amount: "1.00" });
    await recordUnmatchedTx(prisma, { binanceTxId: "OTHER-2", amount: "1.00" });

    const res = await get("/api/payments", seed.cookie);
    expect(res.statusCode).toBe(200);
    const data = JSON.parse(res.body) as { todayCount: number };
    expect(data.todayCount).toBeGreaterThanOrEqual(2);

    const filtered = await get("/api/payments?q=SEARCHABLE", seed.cookie);
    const filteredData = JSON.parse(filtered.body) as { ledger: Array<{ binanceTxId: string }> };
    expect(filteredData.ledger.map((tx) => tx.binanceTxId)).toEqual(["SEARCHABLE-1"]);
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @app/web-admin test web -- -t "todayCount and honors"`
Expected: FAIL — `data.todayCount` is `undefined`, and the unfiltered `q` request returns both rows.

- [ ] **Step 3: Write minimal implementation**

In `apps/web-admin/src/routes/api/payments.ts`:

Update the import list (add `countProcessedBinanceTxToday`):

```ts
import {
  prisma,
  resolveBinanceInternalConfig,
  listProcessedBinanceTx,
  countProcessedBinanceTx,
  countProcessedBinanceTxToday,
  processedTxOutcomeCounts,
  getBinancePollHealth,
  TX_OUTCOMES,
  deliverUnderpaidOrder,
  refundUnderpaidOrder,
  manualMatchTx,
  dismissUnmatchedTx,
  creditOrderToBalance,
  listOrders,
  listPendingInternalOrders,
  getOrderByCode,
  cancelOrder,
  logAdminAction,
} from "@app/db";
```

Replace the `GET /api/payments` handler body:

```ts
  app.get("/api/payments", { preHandler: currentAdmin }, async (req, reply) => {
    const q = req.query as Record<string, string | undefined>;
    const outcome = q.outcome && (TX_OUTCOMES as readonly string[]).includes(q.outcome) ? q.outcome : null;
    const search = q.q?.trim() || null;
    const page = Math.max(Number(q.page) || 1, 1);
    const offset = (page - 1) * PAGE_SIZE;

    const [ledger, total, todayCount, counts, health, underpaid, pendingInternal] = await Promise.all([
      listProcessedBinanceTx(prisma, { outcome, q: search, limit: PAGE_SIZE, offset }),
      countProcessedBinanceTx(prisma, { outcome, q: search }),
      countProcessedBinanceTxToday(prisma),
      processedTxOutcomeCounts(prisma),
      getBinancePollHealth(prisma),
      listOrders(prisma, { status: OrderStatus.UNDERPAID, limit: 50 }),
      listPendingInternalOrders(prisma, new Date()),
    ]);
    const binanceEnabled = (await resolveBinanceInternalConfig(prisma)).enabled;

    // Ledger rows are named createdAt in the DB/crud layer, but the client
    // reads `processedAt` (an existing "invalid date" bug — the field never
    // actually existed before, so `new Date(tx.processedAt)` always produced
    // Invalid Date client-side). Add it here alongside the pre-formatted
    // display string, fixing that bug in the same pass.
    const ledgerWithDisplay = ledger.map((r) => ({
      ...r,
      processedAt: r.createdAt.toISOString(),
      processedAtDisplay: displayDateTime(r.createdAt),
    }));
    const underpaidWithDisplay = underpaid.map((o) => ({ ...o, createdAtDisplay: displayDateTime(o.createdAt) }));
    const pendingInternalWithDisplay = pendingInternal.map((o) => ({ ...o, expiresAtDisplay: displayDateTime(o.expiresAt) }));

    return reply.send({
      enabled: binanceEnabled,
      ledger: ledgerWithDisplay,
      total,
      todayCount,
      page,
      pageSize: PAGE_SIZE,
      hasNext: offset + ledger.length < total,
      outcomes: TX_OUTCOMES,
      counts,
      health,
      underpaid: underpaidWithDisplay,
      pendingInternal: pendingInternalWithDisplay,
    });
  });
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @app/web-admin test web -- -t "todayCount and honors"`
Expected: PASS

Then run the full Payments route suite to confirm no regressions:
Run: `pnpm --filter @app/web-admin test web -- -t "api/payments\|GET /api/payments\|credit\|dismiss"`
Expected: all PASS

- [ ] **Step 5: Commit**

```bash
git add apps/web-admin/src/routes/api/payments.ts apps/web-admin/test/web.test.ts
git commit -m "feat(web-admin): expose todayCount and q search on GET /api/payments"
```

---

## Task 4: Frontend — `CREDITED_TO_BALANCE` StatusBadge tone

**Files:**
- Modify: `apps/web-admin/client/src/components/shared/StatusBadge.tsx`
- Modify: `apps/web-admin/client/src/components/shared/StatusBadge.test.tsx`

**Interfaces:**
- Produces: `StatusBadge` renders `CREDITED_TO_BALANCE` with the `success` tone instead of falling back to `neutral`.

- [ ] **Step 1: Write the failing test**

Read `apps/web-admin/client/src/components/shared/StatusBadge.test.tsx` first to match its existing assertion style exactly (it very likely renders `<StatusBadge status="X" />` and asserts a class or accessible text), then add a case in the same style:

```tsx
it("renders CREDITED_TO_BALANCE with the success tone", () => {
  render(<StatusBadge status="CREDITED_TO_BALANCE" />);
  expect(screen.getByText("Credited To Balance")).toHaveClass("bg-grass-tint");
});
```

(If the existing file's convention checks a different attribute than `toHaveClass`, e.g. a `data-tone` attribute or text color class, match that convention instead of `bg-grass-tint` — read the file before writing this step for real.)

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @app/web-admin-client test StatusBadge`
Expected: FAIL — badge renders with the neutral tone's class instead.

- [ ] **Step 3: Write minimal implementation**

In `apps/web-admin/client/src/components/shared/StatusBadge.tsx`, add one line to the `TONE` map (after the `PENDING`/`SENDING` entries):

```ts
  // Binance ledger outcome (PaymentsPage) — money successfully resolved to
  // the buyer's credit balance, per docs/superpowers/specs/2026-06-16-dual-credit-balance-design.md.
  CREDITED_TO_BALANCE: "success",
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @app/web-admin-client test StatusBadge`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/web-admin/client/src/components/shared/StatusBadge.tsx apps/web-admin/client/src/components/shared/StatusBadge.test.tsx
git commit -m "fix(web-admin-client): give CREDITED_TO_BALANCE a success StatusBadge tone"
```

---

## Task 5: Frontend — KPI row correctness fix + header description

**Files:**
- Modify: `apps/web-admin/client/src/pages/PaymentsPage.tsx`
- Modify: `apps/web-admin/client/src/pages/PaymentsPage.test.tsx`

**Interfaces:**
- Consumes: `data.todayCount` (Task 3), `data.counts` (already existed, now actually used).
- Produces: no new exports — internal page behavior only.

- [ ] **Step 1: Write the failing test**

Replace the existing `"computes today's total / pending / failed stat cards from the fetched ledger"` test in `PaymentsPage.test.tsx` (lines 78–98) with one that asserts the cards come from the new server fields, not the ledger:

```tsx
  it("shows today's total / pending / failed stat cards from server-provided fields", async () => {
    const ledger = [
      { id: 1, binanceTxId: "TX1", amount: "1", currency: "IDR", outcome: "matched", memo: null, processedAt: "2026-06-26T10:00:00.000Z" },
    ];
    mockPaymentsFetch({
      enabled: true,
      ledger,
      total: 1,
      todayCount: 7,
      page: 1,
      hasNext: false,
      outcomes: ["matched", "unmatched", "delivery_failed"],
      counts: { unmatched: 3, delivery_failed: 2 },
    });
    render(<PaymentsPage />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByText("TX1")).toBeInTheDocument());

    const todayCard = screen.getByText("Today's Transactions").closest('[data-slot="card"]') as HTMLElement;
    expect(within(todayCard).getByText("7")).toBeInTheDocument();

    const pendingCard = screen.getByText("Pending").closest('[data-slot="card"]') as HTMLElement;
    expect(within(pendingCard).getByText("3")).toBeInTheDocument();

    const failedCard = screen.getByText("Failed").closest('[data-slot="card"]') as HTMLElement;
    expect(within(failedCard).getByText("2")).toBeInTheDocument();
  });

  it("shows a page-2 KPI value that differs from what the current page alone would suggest", async () => {
    // Regression guard for the bug this task fixes: with the old client-side
    // computation, a KPI on page 2 could only ever reflect page 2's rows.
    const ledger = [
      { id: 99, binanceTxId: "PAGE2-TX", amount: "1", currency: "IDR", outcome: "matched", memo: null, processedAt: "2026-06-01T10:00:00.000Z" },
    ];
    mockPaymentsFetch({
      enabled: true,
      ledger,
      total: 60,
      todayCount: 12,
      page: 2,
      hasNext: false,
      outcomes: ["matched"],
      counts: { unmatched: 5 },
    });
    render(<PaymentsPage />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByText("PAGE2-TX")).toBeInTheDocument());

    const todayCard = screen.getByText("Today's Transactions").closest('[data-slot="card"]') as HTMLElement;
    expect(within(todayCard).getByText("12")).toBeInTheDocument(); // not 0, not derived from the 1 row on this page
  });
```

Also update `PageHeader` assertion coverage isn't needed as a separate test (no existing test asserts the header has no description), so the description addition needs no dedicated test — it's covered implicitly by any test that renders the page without erroring.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @app/web-admin-client test PaymentsPage -- -t "server-provided fields"`
Expected: FAIL — cards still show client-computed values (0 for all three, since the mocked `ledger` array in the new tests doesn't contain rows matching the old logic's outcomes).

- [ ] **Step 3: Write minimal implementation**

In `PaymentsPage.tsx`:

1. Add imports (StatCard, icons):

```ts
import { StatCard } from "../components/shared/StatCard";
import { CreditCard, ChevronLeft, ChevronRight, PackageCheck, Undo2, X, MoreVertical, Clock, Hourglass, XCircle } from "lucide-react";
```

(This replaces the existing `lucide-react` import line — merge `Clock`, `Hourglass`, `XCircle` into the existing icon list rather than duplicating the import.)

2. Delete the `stats` `useMemo` block and the now-unused `isSameLocalDay`/`PENDING_OUTCOMES`/`FAILED_OUTCOMES` constants (they move to being read directly off `data`, so the client-side derivation is dead code):

Delete:
```ts
const PENDING_OUTCOMES = new Set(["unmatched"]);
const FAILED_OUTCOMES = new Set(["delivery_failed"]);

function isSameLocalDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}
```

and delete the `stats` `useMemo` block:
```ts
  const stats = useMemo(() => {
    const ledger = data?.ledger ?? [];
    const today = new Date();
    let todayTotal = 0, pending = 0, failed = 0;
    for (const tx of ledger) {
      const outcomeLower = tx.outcome.toLowerCase();
      if (isSameLocalDay(new Date(tx.processedAt), today)) todayTotal += 1;
      if (PENDING_OUTCOMES.has(outcomeLower)) pending += 1;
      if (FAILED_OUTCOMES.has(outcomeLower)) failed += 1;
    }
    return { todayTotal, pending, failed };
  }, [data?.ledger]);
```

Remove `useMemo` from the `react` import if nothing else in the file still uses it — check the rest of the file (after all tasks in this plan are applied, `useMemo` is not used elsewhere) before dropping it; if still unused after Task 6, drop it then.

3. Add `todayCount` to the `PaymentsData` interface:

```ts
interface PaymentsData {
  enabled: boolean;
  ledger: TxRow[];
  total: number;
  todayCount: number;
  page: number;
  hasNext: boolean;
  outcomes: readonly string[];
  counts: Record<string, number>;
  underpaid: UnderpaidOrderRow[];
  pendingInternal: PendingInternalOrderRow[];
}
```

4. Replace the KPI section's JSX:

```tsx
      <PageHeader title="Payments" description="Match transfers to orders and resolve payment issues." />

      <div className="mb-6 grid grid-cols-1 gap-4 sm:grid-cols-3">
        <StatCard
          label="Today's Transactions"
          value={data?.todayCount ?? 0}
          icon={Clock}
          isLoading={!data}
        />
        <StatCard
          label="Pending"
          value={data?.counts["unmatched"] ?? 0}
          icon={Hourglass}
          tone="warning"
          isLoading={!data}
        />
        <StatCard
          label="Failed"
          value={data?.counts["delivery_failed"] ?? 0}
          icon={XCircle}
          tone="danger"
          isLoading={!data}
        />
      </div>
```

(This replaces both the old bare `<PageHeader title="Payments" />` line and the old 3-`Card` KPI block in one edit.)

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @app/web-admin-client test PaymentsPage`
Expected: PASS — all tests in the file (the KPI tests plus every pre-existing test, since none of them depended on the old client-side stat computation).

- [ ] **Step 5: Commit**

```bash
git add apps/web-admin/client/src/pages/PaymentsPage.tsx apps/web-admin/client/src/pages/PaymentsPage.test.tsx
git commit -m "fix(web-admin-client): source Payments KPI cards from server aggregates, not the current page"
```

---

## Task 6: Frontend — Binance poll health indicator

**Files:**
- Modify: `apps/web-admin/client/src/pages/PaymentsPage.tsx`
- Modify: `apps/web-admin/client/src/pages/PaymentsPage.test.tsx`

**Interfaces:**
- Consumes: `data.health` (`BinancePollHealth`, already fetched, previously unused), `data.enabled`.
- Produces: no new exports — internal page behavior only.

- [ ] **Step 1: Write the failing test**

Add to `PaymentsPage.test.tsx`:

```tsx
  it("shows a health pill with consecutive failures when the poller is unhealthy", async () => {
    mockPaymentsFetch({
      enabled: true,
      ledger: [],
      total: 0,
      todayCount: 0,
      page: 1,
      hasNext: false,
      outcomes: [],
      counts: {},
      health: { lastRun: "2026-07-24T09:00:00.000Z", lastSuccessAt: null, lastTxCount: null, backoffUntil: null, consecutiveRateLimitHits: null, lastRateLimitAt: null, consecutiveFailures: 4, lastError: "timeout" },
    });
    render(<PaymentsPage />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByText(/no transactions/i)).toBeInTheDocument());
    expect(screen.getByText(/4 consecutive failures/i)).toBeInTheDocument();
  });

  it("shows a synced-recently health pill on a healthy poller", async () => {
    mockPaymentsFetch({
      enabled: true,
      ledger: [],
      total: 0,
      todayCount: 0,
      page: 1,
      hasNext: false,
      outcomes: [],
      counts: {},
      health: { lastRun: new Date().toISOString(), lastSuccessAt: new Date().toISOString(), lastTxCount: 3, backoffUntil: null, consecutiveRateLimitHits: null, lastRateLimitAt: null, consecutiveFailures: 0, lastError: null },
    });
    render(<PaymentsPage />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByText(/no transactions/i)).toBeInTheDocument());
    expect(screen.getByText(/synced/i)).toBeInTheDocument();
  });

  it("shows no health pill when Binance internal is disabled", async () => {
    mockPaymentsFetch({
      enabled: false,
      ledger: [],
      total: 0,
      todayCount: 0,
      page: 1,
      hasNext: false,
      outcomes: [],
      counts: {},
      health: { lastRun: null, lastSuccessAt: null, lastTxCount: null, backoffUntil: null, consecutiveRateLimitHits: null, lastRateLimitAt: null, consecutiveFailures: null, lastError: null },
    });
    render(<PaymentsPage />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByText(/no transactions/i)).toBeInTheDocument());
    expect(screen.queryByText(/synced|consecutive failures|not yet synced|retrying/i)).not.toBeInTheDocument();
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @app/web-admin-client test PaymentsPage -- -t "health pill"`
Expected: FAIL — no such text is rendered anywhere yet.

- [ ] **Step 3: Write minimal implementation**

Add imports (`UrgencyDot`, add `BinancePollHealth`-shaped fields to `PaymentsData`):

```ts
import { UrgencyDot } from "../components/shared/UrgencyDot";
```

Add the `health` field to `PaymentsData`:

```ts
interface PaymentsHealth {
  lastRun: string | null;
  lastSuccessAt: string | null;
  lastTxCount: number | null;
  backoffUntil: string | null;
  consecutiveRateLimitHits: number | null;
  lastRateLimitAt: string | null;
  consecutiveFailures: number | null;
  lastError: string | null;
}
interface PaymentsData {
  enabled: boolean;
  ledger: TxRow[];
  total: number;
  todayCount: number;
  page: number;
  hasNext: boolean;
  outcomes: readonly string[];
  counts: Record<string, number>;
  health: PaymentsHealth;
  underpaid: UnderpaidOrderRow[];
  pendingInternal: PendingInternalOrderRow[];
}
```

Add a small helper function above the `PaymentsPage` component:

```ts
function relativeTime(iso: string): string {
  const ms = new Date(iso).getTime();
  const seconds = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (seconds < 60) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  return `${hours}h ago`;
}

function healthPill(health: PaymentsHealth): { level: "ok" | "warn" | "critical" | "idle"; text: string } {
  if ((health.consecutiveFailures ?? 0) > 0) {
    return { level: "critical", text: `${health.consecutiveFailures} consecutive failures` };
  }
  if (health.backoffUntil && new Date(health.backoffUntil).getTime() > Date.now()) {
    return { level: "warn", text: `Rate-limited, retrying at ${new Date(health.backoffUntil).toLocaleTimeString()}` };
  }
  if (!health.lastRun) {
    return { level: "idle", text: "Not yet synced" };
  }
  return { level: "ok", text: `Synced ${relativeTime(health.lastRun)}` };
}
```

Render the pill next to the KPI row (add just above the `<div className="mb-6 grid ...">` KPI block added in Task 5):

```tsx
      {data?.enabled && (() => {
        const pill = healthPill(data.health);
        return (
          <div className="mb-4 flex items-center gap-2 text-xs text-ink-soft">
            <UrgencyDot level={pill.level} />
            {pill.text}
          </div>
        );
      })()}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @app/web-admin-client test PaymentsPage`
Expected: PASS (all tests, including the 3 new health-pill tests)

- [ ] **Step 5: Commit**

```bash
git add apps/web-admin/client/src/pages/PaymentsPage.tsx apps/web-admin/client/src/pages/PaymentsPage.test.tsx
git commit -m "feat(web-admin-client): surface Binance poll health on the Payments page"
```

---

## Task 7: Frontend — restyle Underpaid/Pending Internal as attention-queue cards

**Files:**
- Modify: `apps/web-admin/client/src/pages/PaymentsPage.tsx`

**Interfaces:** none new — visual-only change, no behavior change.

- [ ] **Step 1: Make the visual change**

Replace the `CardHeader`/`CardTitle` lines for both sections (quieter weight, drop the redundant count from the title since the queue is now visually distinct rather than looking like a primary paginated list — the count is still visible as the number of rows in the table itself):

Underpaid section — replace:
```tsx
          <CardHeader><CardTitle>Underpaid Orders ({underpaid.length})</CardTitle></CardHeader>
```
with:
```tsx
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-1.5 text-sm font-semibold text-ink-soft">
              Underpaid Orders
              <span className="rounded-full bg-amberx-tint px-1.5 py-0.5 text-xs font-semibold text-amberx">{underpaid.length}</span>
            </CardTitle>
          </CardHeader>
```

Pending Internal section — replace:
```tsx
          <CardHeader><CardTitle>Pending Internal Transfers ({pendingInternal.length})</CardTitle></CardHeader>
```
with:
```tsx
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-1.5 text-sm font-semibold text-ink-soft">
              Pending Internal Transfers
              <span className="rounded-full bg-sand px-1.5 py-0.5 text-xs font-semibold text-ink-soft">{pendingInternal.length}</span>
            </CardTitle>
          </CardHeader>
```

- [ ] **Step 2: Run the full Payments test suite to confirm no regression**

Run: `pnpm --filter @app/web-admin-client test PaymentsPage`
Expected: PASS — this is a pure visual change; no test asserts on `CardTitle`'s font size/weight, so the existing "lists underpaid orders...", "refunds an underpaid order...", "cancels an underpaid order...", "lists pending internal transfers..." tests must still pass unmodified.

- [ ] **Step 3: Commit**

```bash
git add apps/web-admin/client/src/pages/PaymentsPage.tsx
git commit -m "style(web-admin-client): restyle Underpaid/Pending Internal as attention-queue cards"
```

---

## Task 8: Frontend — Ledger search (SearchBar wired into the query)

**Files:**
- Modify: `apps/web-admin/client/src/pages/PaymentsPage.tsx`
- Modify: `apps/web-admin/client/src/pages/PaymentsPage.test.tsx`

**Interfaces:**
- Consumes: `q` param on `GET /api/payments` (Task 3).
- Produces: no new exports — internal page behavior only.

- [ ] **Step 1: Write the failing test**

Add to `PaymentsPage.test.tsx`:

```tsx
  it("debounces Ledger search into the query params", async () => {
    vi.useFakeTimers();
    mockPaymentsFetch({ enabled: true, ledger: [], total: 0, todayCount: 0, page: 1, hasNext: false, outcomes: [], counts: {} });
    render(<PaymentsPage />, { wrapper: Wrapper });
    await vi.waitFor(() => expect(screen.getByText(/no transactions/i)).toBeInTheDocument());

    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ enabled: true, ledger: [], total: 0, todayCount: 0, page: 1, hasNext: false, outcomes: [], counts: {} }), { status: 200, headers: { "Content-Type": "application/json" } }),
    );

    const search = screen.getByPlaceholderText(/transfer id/i);
    fireEvent.change(search, { target: { value: "ABC" } });
    expect(fetchSpy).not.toHaveBeenCalled();

    vi.advanceTimersByTime(300);
    await vi.waitFor(() => expect(fetchSpy).toHaveBeenCalledWith(expect.stringContaining("q=ABC")));
    vi.useRealTimers();
  });
```

Note: the `Input` placeholder `"Transfer ID"` is already used by the Manual Match form's Transfer ID field (`screen.getByPlaceholderText("Transfer ID")` — exact match, case-sensitive). The new Ledger SearchBar must use a **different** placeholder text so `getByPlaceholderText` calls (existing and new) stay unambiguous — use `"Search Transfer ID..."` for the new SearchBar and update the test above to match that exact string via a case-insensitive regex (`/search transfer id/i`) rather than reusing `"Transfer ID"`.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @app/web-admin-client test PaymentsPage -- -t "debounces Ledger search"`
Expected: FAIL — no such placeholder exists yet.

- [ ] **Step 3: Write minimal implementation**

Add imports:

```ts
import { SearchBar } from "../components/shared/SearchBar";
```

Add debounced search state and wire it into `usePayments`:

```ts
function usePayments(outcome: string, q: string, page: number) {
  return useQuery<PaymentsData>({
    queryKey: ["payments", outcome, q, page],
    queryFn: async () => {
      const params = new URLSearchParams({ page: String(page) });
      if (outcome) params.set("outcome", outcome);
      if (q) params.set("q", q);
      const res = await fetch(`/api/payments?${params.toString()}`);
      if (!res.ok) throw new Error("Failed to load");
      return res.json() as Promise<PaymentsData>;
    },
  });
}
```

In `PaymentsPage`, add draft/debounced query state (near the other `useState` calls):

```ts
  const [qDraft, setQDraft] = useState("");
  const [q, setQ] = useState("");
  useEffect(() => {
    const timer = setTimeout(() => { setQ(qDraft); setPage(1); }, 300);
    return () => clearTimeout(timer);
  }, [qDraft]);
```

Update the `usePayments` call site:

```ts
  const { data, isError } = usePayments(outcome, q, page);
```

Add the `SearchBar` to the existing outcome `FilterBar` (replace the current Ledger `FilterBar` block):

```tsx
      <FilterBar className="mb-4">
        <SearchBar
          value={qDraft}
          onChange={setQDraft}
          placeholder="Search Transfer ID..."
          className="w-full sm:w-64"
        />
        <div className="flex flex-col gap-1">
          <label className="text-xs text-ink-soft">Outcome</label>
          <Select
            value={outcome || "_all_"}
            onValueChange={v => { setOutcome(v === "_all_" ? "" : v); setPage(1); }}
          >
            <SelectTrigger className="w-40"><SelectValue placeholder="All outcomes" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="_all_">All</SelectItem>
              {(data?.outcomes ?? []).map(o => (
                <SelectItem key={o} value={o}>{o} ({data?.counts[o] ?? 0})</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        {data && <span className="text-sm text-ink-soft self-end">{data.total} transactions</span>}
      </FilterBar>
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @app/web-admin-client test PaymentsPage`
Expected: PASS (all tests)

- [ ] **Step 5: Commit**

```bash
git add apps/web-admin/client/src/pages/PaymentsPage.tsx apps/web-admin/client/src/pages/PaymentsPage.test.tsx
git commit -m "feat(web-admin-client): add debounced Transfer ID search to the Payments Ledger"
```

---

## Task 9: Frontend — Ledger bulk selection + bulk Dismiss

**Files:**
- Modify: `apps/web-admin/client/src/pages/PaymentsPage.tsx`
- Modify: `apps/web-admin/client/src/pages/PaymentsPage.test.tsx`

**Interfaces:**
- Consumes: `POST /api/payments/dismiss` (existing, unchanged route — called once per selected id).
- Produces: no new exports — internal page behavior only.

- [ ] **Step 1: Write the failing test**

Add to `PaymentsPage.test.tsx`:

```tsx
  it("bulk-dismisses selected unmatched transfers", async () => {
    const user = userEvent.setup();
    const ledger = [
      { id: 1, binanceTxId: "BULK1", amount: "1", currency: "IDR", outcome: "unmatched", memo: null, processedAt: "2026-06-26T10:00:00.000Z", processedAtDisplay: "2026-06-26 17:00" },
      { id: 2, binanceTxId: "BULK2", amount: "1", currency: "IDR", outcome: "unmatched", memo: null, processedAt: "2026-06-26T10:00:00.000Z", processedAtDisplay: "2026-06-26 17:00" },
      { id: 3, binanceTxId: "MATCHED1", amount: "1", currency: "IDR", outcome: "matched", memo: null, processedAt: "2026-06-26T10:00:00.000Z", processedAtDisplay: "2026-06-26 17:00" },
    ];
    mockPaymentsFetch({ enabled: true, ledger, total: 3, todayCount: 0, page: 1, hasNext: false, outcomes: ["unmatched", "matched"], counts: {} });
    vi.mocked(apiPost).mockResolvedValue({ ok: true });
    render(<PaymentsPage />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByText("BULK1")).toBeInTheDocument());

    await user.click(screen.getByRole("checkbox", { name: /select transfer bulk1/i }));
    await user.click(screen.getByRole("checkbox", { name: /select transfer bulk2/i }));
    expect(screen.getByText("2 selected")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /dismiss 2 transfers/i }));

    await waitFor(() => {
      expect(apiPost).toHaveBeenCalledWith("/api/payments/dismiss", { binance_tx_id: "BULK1" });
      expect(apiPost).toHaveBeenCalledWith("/api/payments/dismiss", { binance_tx_id: "BULK2" });
    });
  });

  it("only offers a select-all checkbox that selects eligible (unmatched) rows", async () => {
    const user = userEvent.setup();
    const ledger = [
      { id: 1, binanceTxId: "ELIG1", amount: "1", currency: "IDR", outcome: "unmatched", memo: null, processedAt: "2026-06-26T10:00:00.000Z", processedAtDisplay: "2026-06-26 17:00" },
      { id: 2, binanceTxId: "MATCHED2", amount: "1", currency: "IDR", outcome: "matched", memo: null, processedAt: "2026-06-26T10:00:00.000Z", processedAtDisplay: "2026-06-26 17:00" },
    ];
    mockPaymentsFetch({ enabled: true, ledger, total: 2, todayCount: 0, page: 1, hasNext: false, outcomes: ["unmatched", "matched"], counts: {} });
    render(<PaymentsPage />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByText("ELIG1")).toBeInTheDocument());

    await user.click(screen.getByRole("checkbox", { name: /select all eligible transfers/i }));
    expect(screen.getByText("1 selected")).toBeInTheDocument();
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @app/web-admin-client test PaymentsPage -- -t "bulk-dismisses"`
Expected: FAIL — no checkboxes/bulk bar exist yet.

- [ ] **Step 3: Write minimal implementation**

Add imports:

```ts
import { Checkbox } from "@/components/ui/checkbox";
```

Add selection state (near the other `useState` calls) and a clear-on-filter-change effect:

```ts
  const [selected, setSelected] = useState<Set<number>>(new Set());
  useEffect(() => { setSelected(new Set()); }, [outcome, q]);
```

Add selection helpers and the bulk-dismiss mutation (place near the other `useMutation`s):

```ts
  const ledgerRows = data?.ledger ?? [];
  const eligibleRows = ledgerRows.filter(tx => tx.outcome === "unmatched");
  const allEligibleSelected = eligibleRows.length > 0 && eligibleRows.every(tx => selected.has(tx.id));

  function toggleSelected(id: number) {
    setSelected(s => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id); else n.add(id);
      return n;
    });
  }
  function toggleSelectAllEligible() {
    setSelected(prev => {
      const next = new Set(prev);
      if (allEligibleSelected) {
        eligibleRows.forEach(tx => next.delete(tx.id));
      } else {
        eligibleRows.forEach(tx => next.add(tx.id));
      }
      return next;
    });
  }

  const bulkDismiss = useMutation({
    mutationFn: async (ids: number[]) => {
      const rows = ledgerRows.filter(tx => ids.includes(tx.id));
      const results = await Promise.allSettled(rows.map(tx => apiPost("/api/payments/dismiss", { binance_tx_id: tx.binanceTxId })));
      const failed = results.filter(r => r.status === "rejected").length;
      return { succeeded: results.length - failed, failed };
    },
    onSuccess: ({ succeeded, failed }) => {
      void qc.invalidateQueries({ queryKey: ["payments"] });
      setSelected(new Set());
      toast.success(failed > 0 ? `Dismissed ${succeeded} of ${succeeded + failed} transfers — ${failed} failed.` : `Dismissed ${succeeded} transfer${succeeded === 1 ? "" : "s"}.`);
    },
  });
```

Add the sticky bulk-action bar just above the Ledger `DataTable` (after the `FilterBar` block added in Task 8):

```tsx
      {selected.size > 0 && (
        <div className="sticky bottom-4 z-10 mb-3 flex flex-wrap items-center gap-3 rounded-lg border border-line bg-card px-3 py-2 text-sm shadow-lift transition-all duration-150">
          <span className="text-ink-soft">{selected.size} selected</span>
          <Button
            size="sm"
            variant="destructive"
            disabled={bulkDismiss.isPending}
            onClick={() => bulkDismiss.mutate(Array.from(selected))}
          >
            Dismiss {selected.size} transfer{selected.size === 1 ? "" : "s"}
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setSelected(new Set())}>Clear</Button>
        </div>
      )}
```

Add a leading `select` column to the Ledger `DataTable`'s `columns` array (as the first entry, before `"txid"`):

```ts
          {
            key: "select",
            header: (
              <Checkbox
                checked={allEligibleSelected}
                onCheckedChange={toggleSelectAllEligible}
                disabled={eligibleRows.length === 0}
                aria-label="Select all eligible transfers"
              />
            ),
            render: tx => tx.outcome === "unmatched" ? (
              <Checkbox
                checked={selected.has(tx.id)}
                onCheckedChange={() => toggleSelected(tx.id)}
                onClick={e => e.stopPropagation()}
                aria-label={`Select transfer ${tx.binanceTxId}`}
              />
            ) : null,
          },
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @app/web-admin-client test PaymentsPage`
Expected: PASS (all tests)

- [ ] **Step 5: Commit**

```bash
git add apps/web-admin/client/src/pages/PaymentsPage.tsx apps/web-admin/client/src/pages/PaymentsPage.test.tsx
git commit -m "feat(web-admin-client): add bulk selection and bulk Dismiss to the Payments Ledger"
```

---

## Task 10: Frontend — Ledger row actions as DropdownMenu + "Add to buyer's credit balance"

**Files:**
- Modify: `apps/web-admin/client/src/pages/PaymentsPage.tsx`
- Modify: `apps/web-admin/client/src/pages/PaymentsPage.test.tsx`

**Interfaces:**
- Consumes: `POST /api/payments/credit` (existing route, unchanged — `{ binance_tx_id, order_code }`), `useOrderCodeSuggest` (already in this file).
- Produces: no new exports — internal page behavior only.

This task changes how the existing "Dismiss" action is triggered (from a lone `ConfirmDialog`-wrapped button to a `DropdownMenu` item), so it also updates the two pre-existing Dismiss tests.

- [ ] **Step 1: Write the failing test**

Update the existing `"shows a Dismiss action for an unmatched transfer and dismisses it after confirming"` test (around line 170) to go through the menu:

```tsx
  it("shows a Dismiss action for an unmatched transfer and dismisses it after confirming", async () => {
    const user = userEvent.setup();
    const ledger = [
      { id: 1, binanceTxId: "TX1", amount: "1", currency: "IDR", outcome: "unmatched", memo: null, processedAt: "2026-06-26T10:00:00.000Z", processedAtDisplay: "2026-06-26 17:00" },
    ];
    mockPaymentsFetch({ enabled: true, ledger, total: 1, todayCount: 0, page: 1, hasNext: false, outcomes: ["unmatched"], counts: {} });
    vi.mocked(apiPost).mockResolvedValueOnce({ ok: true });
    render(<PaymentsPage />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByText("TX1")).toBeInTheDocument());

    await user.click(screen.getByRole("button", { name: "Actions for transfer TX1" }));
    const menu = await screen.findByRole("menu");
    await user.click(within(menu).getByText("Dismiss"));

    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText(/TX1/)).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole("button", { name: "Dismiss" }));

    await waitFor(() => expect(apiPost).toHaveBeenCalledWith("/api/payments/dismiss", { binance_tx_id: "TX1" }));
  });

  it("does not show an actions menu for a matched transfer", async () => {
    mockPaymentsFetch({ enabled: true, ledger: [TX], total: 1, todayCount: 0, page: 1, hasNext: false, outcomes: ["MATCHED", "UNMATCHED"], counts: { MATCHED: 1 } });
    render(<PaymentsPage />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByText("TX123")).toBeInTheDocument());

    expect(screen.queryByRole("button", { name: /actions for transfer/i })).not.toBeInTheDocument();
  });

  it("adds an unmatched transfer's amount to the buyer's credit balance via order code", async () => {
    const user = userEvent.setup();
    const ledger = [
      { id: 1, binanceTxId: "CREDIT1", amount: "5", currency: "IDR", outcome: "unmatched", memo: null, processedAt: "2026-06-26T10:00:00.000Z", processedAtDisplay: "2026-06-26 17:00" },
    ];
    mockPaymentsFetch({ enabled: true, ledger, total: 1, todayCount: 0, page: 1, hasNext: false, outcomes: ["unmatched"], counts: {} });
    vi.mocked(apiGet).mockResolvedValue({ q: "order-9", exactOrderId: 9 });
    vi.mocked(apiPost).mockResolvedValueOnce({ ok: true });
    render(<PaymentsPage />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByText("CREDIT1")).toBeInTheDocument());

    await user.click(screen.getByRole("button", { name: "Actions for transfer CREDIT1" }));
    const menu = await screen.findByRole("menu");
    await user.click(within(menu).getByText("Add to buyer's credit balance"));

    const dialog = await screen.findByRole("dialog");
    const orderInput = within(dialog).getByPlaceholderText("Order code");
    fireEvent.change(orderInput, { target: { value: "order-9" } });

    await waitFor(() => expect(within(dialog).getByRole("button", { name: "Add to credit balance" })).not.toBeDisabled());
    fireEvent.click(within(dialog).getByRole("button", { name: "Add to credit balance" }));

    await waitFor(() =>
      expect(apiPost).toHaveBeenCalledWith("/api/payments/credit", { binance_tx_id: "CREDIT1", order_code: "order-9" }),
    );
  });
```

Remove/replace the old `"does not show a Dismiss action for a matched transfer"` test (superseded by `"does not show an actions menu for a matched transfer"` above — delete the old one to avoid duplicate coverage of the same fact).

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @app/web-admin-client test PaymentsPage -- -t "Dismiss action\|actions menu\|credit balance"`
Expected: FAIL — there's still a lone Dismiss button, not a menu, and no credit-balance dialog.

- [ ] **Step 3: Write minimal implementation**

Add imports:

```ts
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from "@/components/ui/dropdown-menu";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Wallet } from "lucide-react";
```

Add state for the credit dialog (near `pendingDeliver`/`pendingRefund`/`pendingCancel`):

```ts
  const [pendingCredit, setPendingCredit] = useState<TxRow | null>(null);
  const [creditOrderCode, setCreditOrderCode] = useState("");
  const { suggestion: creditSuggestion, loading: creditSuggestLoading } = useOrderCodeSuggest(creditOrderCode);
```

Add the credit mutation (near `dismiss`):

```ts
  const creditToBalance = useMutation({
    mutationFn: () => apiPost("/api/payments/credit", { binance_tx_id: pendingCredit!.binanceTxId, order_code: creditOrderCode.trim() }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["payments"] });
      toast.success("Added to the buyer's credit balance.");
      setPendingCredit(null);
      setCreditOrderCode("");
    },
    onError: (e: Error) => toast.error(describeError(e.message)),
  });
```

Replace the Ledger `actions` column's `render`. Dismiss must still go through a confirm step (matching the existing pre-change behavior, and the test above, which expects a `dialog` after clicking "Dismiss" in the menu) — so the menu item sets `pendingDismiss` rather than calling `dismiss.mutate` directly, mirroring the existing `pendingDeliver`/`pendingRefund`/`pendingCancel` state pattern:

```ts
          {
            key: "actions",
            header: "",
            render: tx => tx.outcome === "unmatched" ? (
              <div onClick={(e) => e.stopPropagation()}>
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button variant="ghost" size="icon-sm" aria-label={`Actions for transfer ${tx.binanceTxId}`}>
                      <MoreVertical className="h-4 w-4" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <DropdownMenuItem onSelect={() => { setPendingCredit(tx); setCreditOrderCode(""); }}>
                      <Wallet className="h-4 w-4" />
                      Add to buyer&apos;s credit balance
                    </DropdownMenuItem>
                    <DropdownMenuItem onSelect={() => setPendingDismiss(tx)}>
                      <X className="h-4 w-4" />
                      Dismiss
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
            ) : null,
          },
```

Add `pendingDismiss` state (near `pendingCredit`):

```ts
  const [pendingDismiss, setPendingDismiss] = useState<TxRow | null>(null);
```

Update the `dismiss` mutation's `onSuccess` to also clear `pendingDismiss`:

```ts
  const dismiss = useMutation({
    mutationFn: (txId: string) => apiPost("/api/payments/dismiss", { binance_tx_id: txId }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["payments"] });
      toast.success("Transfer dismissed.");
      setPendingDismiss(null);
    },
    onError: (e: Error) => toast.error(describeError(e.message)),
  });
```

Add the Dismiss `ConfirmDialog`, rendered conditionally alongside the existing `pendingDeliver`/`pendingRefund`/`pendingCancel` dialogs at the bottom of the component:

```tsx
      {pendingDismiss && (
        <ConfirmDialog
          open
          onOpenChange={(open) => { if (!open) setPendingDismiss(null); }}
          title="Dismiss transfer?"
          description={`Mark transfer ${pendingDismiss.binanceTxId} as dismissed.`}
          confirmLabel="Dismiss"
          onConfirm={() => dismiss.mutate(pendingDismiss.binanceTxId)}
        />
      )}
```

Add the credit-to-balance `Dialog`, also alongside the bottom dialogs:

```tsx
      {pendingCredit && (
        <Dialog open onOpenChange={(open) => { if (!open) { setPendingCredit(null); setCreditOrderCode(""); } }}>
          <DialogContent showCloseButton={false}>
            <DialogHeader>
              <DialogTitle>Add to buyer&apos;s credit balance</DialogTitle>
            </DialogHeader>
            <div className="flex flex-col gap-2">
              <p className="text-sm text-ink-soft">
                Adds transfer {pendingCredit.binanceTxId}&apos;s amount to the matching order&apos;s buyer credit balance and cancels the order. Enter the order code this transfer belongs to.
              </p>
              <Input
                placeholder="Order code"
                value={creditOrderCode}
                onChange={e => setCreditOrderCode(e.target.value)}
                autoComplete="off"
              />
              {creditSuggestLoading && <p className="text-xs text-ink-faint">Searching…</p>}
              {!creditSuggestLoading && creditOrderCode.trim() && !creditSuggestion && (
                <p className="text-xs text-ink-faint">No matching order code</p>
              )}
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => { setPendingCredit(null); setCreditOrderCode(""); }}>Back</Button>
              <Button
                disabled={!creditSuggestion || creditToBalance.isPending}
                onClick={() => creditToBalance.mutate()}
              >
                Add to credit balance
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @app/web-admin-client test PaymentsPage`
Expected: PASS (all tests)

- [ ] **Step 5: Commit**

```bash
git add apps/web-admin/client/src/pages/PaymentsPage.tsx apps/web-admin/client/src/pages/PaymentsPage.test.tsx
git commit -m "feat(web-admin-client): move Ledger row actions to a DropdownMenu, wire up credit-to-balance"
```

---

## Task 11: Frontend — swap hand-rolled pagination for the shared `Pagination` component

**Files:**
- Modify: `apps/web-admin/client/src/pages/PaymentsPage.tsx`
- Modify: `apps/web-admin/client/src/pages/PaymentsPage.test.tsx`

**Interfaces:**
- Consumes: `Pagination` (`apps/web-admin/client/src/components/shared/Pagination.tsx`, existing component: `{ page, pageSize, total, onPageChange, onPageSizeChange? }`).
- Produces: no new exports — internal page behavior only.

- [ ] **Step 1: Write the failing test**

Add to `PaymentsPage.test.tsx`:

```tsx
  it("shows result-count text and moves to the next page via the shared Pagination control", async () => {
    const user = userEvent.setup();
    mockPaymentsFetch({ enabled: true, ledger: [TX], total: 120, todayCount: 0, page: 1, hasNext: true, outcomes: ["MATCHED"], counts: {} });
    render(<PaymentsPage />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByText("TX123")).toBeInTheDocument());

    expect(screen.getByText(/showing 1–50 of 120/i)).toBeInTheDocument();

    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ enabled: true, ledger: [], total: 120, todayCount: 0, page: 2, hasNext: true, outcomes: [], counts: {} }), { status: 200, headers: { "Content-Type": "application/json" } }),
    );
    await user.click(screen.getByRole("button", { name: /next/i }));
    await waitFor(() => expect(fetchSpy).toHaveBeenCalledWith(expect.stringContaining("page=2")));
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @app/web-admin-client test PaymentsPage -- -t "shared Pagination control"`
Expected: FAIL — the hand-rolled Prev/Next block shows "Page 1", not "Showing 1–50 of 120".

- [ ] **Step 3: Write minimal implementation**

Add import:

```ts
import { Pagination } from "../components/shared/Pagination";
```

Remove the now-unused `ChevronLeft, ChevronRight` from the `lucide-react` import (check no other usage remains in the file before deleting each).

Replace the hand-rolled pagination block:

```tsx
      {data && (data.hasNext || page > 1) && (
        <div className="mt-4 flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={() => setPage(p => p - 1)} disabled={page === 1}>
            <ChevronLeft className="h-4 w-4" />
            Prev
          </Button>
          <span className="text-sm text-ink-soft">Page {page}</span>
          <Button variant="outline" size="sm" onClick={() => setPage(p => p + 1)} disabled={!data.hasNext}>
            Next
            <ChevronRight className="h-4 w-4" />
          </Button>
        </div>
      )}
```

with:

```tsx
      {data && (
        <div className="mt-4">
          <Pagination
            page={page}
            pageSize={50}
            total={data.total}
            onPageChange={setPage}
          />
        </div>
      )}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @app/web-admin-client test PaymentsPage`
Expected: PASS (all tests)

- [ ] **Step 5: Commit**

```bash
git add apps/web-admin/client/src/pages/PaymentsPage.tsx apps/web-admin/client/src/pages/PaymentsPage.test.tsx
git commit -m "refactor(web-admin-client): use the shared Pagination component on the Payments Ledger"
```

---

## Final verification (after Task 11)

- [ ] Run the full monorepo check:

```bash
pnpm typecheck
pnpm test
pnpm --filter @app/web-admin-client build
```

Expected: all exit 0.

- [ ] Manual check (`pnpm dev:web`, browse `http://127.0.0.1:8000/payments`), per `docs/ui/10_UI_REVIEW_CHECKLIST.md`'s "Final check" and the design spec's own verification list:
  1. KPI numbers match `data.counts`/`data.todayCount` regardless of which ledger page you're on.
  2. Search a known Transfer ID substring, confirm the Ledger filters correctly.
  3. Select 2+ unmatched rows, bulk-dismiss, confirm both disappear and a summary toast shows.
  4. Use "Add to buyer's credit balance" on an unmatched row end-to-end (needs a real unmatched transfer + a real order code in a dev DB) — confirm the order becomes CANCELLED and the ledger row's outcome badge shows "Credited To Balance" in green.
  5. Confirm the health pill renders correctly with Binance internal enabled vs. disabled (toggle via Settings if available in the dev environment).
  6. Confirm the Underpaid/Pending Internal cards read as compact attention queues, not full list sections.
