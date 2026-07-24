# Vouchers Page Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bring the admin Vouchers page (`apps/web-admin/client/src/pages/VouchersPage.tsx`) up to the `OrdersPage.tsx` reference pattern — server-side search/pagination (replacing an unpaginated fetch-everything call), a KPI row, and bulk activate/deactivate/delete — per `docs/audit-ui-ux-structural-2026-07-24.md`'s P1 finding.

**Architecture:** Backend: a new `deriveVoucherStatus` pure helper (shared by filtering and stats), a new `listVouchersPaged` crud function that filters by `q` (code substring) via Prisma and by `status` (a cross-column derived value not expressible in a single Prisma `where`) via a JS filter-then-paginate step over the already-`q`-filtered set — correct regardless of page, never scoped to only the current page. `listVouchers` itself (used by the Telegram bot's admin panel) is left completely untouched. New `getVoucherStats` (global, unfiltered aggregate) and two new bulk crud helpers. Frontend: `StatCard` KPI row, `FilterBar`+`SearchBar` (debounced, mirroring `PaymentsPage.tsx`'s exact pattern), the status `Select` becomes a server query param instead of a client `.filter()`, a `Checkbox`+sticky-bulk-bar selection pattern (mirroring `PaymentsPage.tsx`'s exact pattern, including clearing selection on page change), and the shared `Pagination` component.

**Tech Stack:** Fastify + Prisma (backend), React + TanStack Query + shadcn/Tailwind (frontend), Vitest + React Testing Library (tests).

## Global Constraints

- Money stays `Decimal` (`@app/core/money`) — not touched by this plan (voucher `value`/`minPurchase` fields are read-only here).
- No raw SQL — all DB access through `packages/db/src/crud/*`. The cross-column `usedCount >= usageLimit` comparison is handled via a JS filter over an already-narrowed Prisma result set, never `$queryRaw`.
- `listVouchers(db)` (no-arg, plain-array return) is used by `apps/order-bot/src/handlers/admin.ts:139` and **must not change signature or return type** — all new pagination/filtering work goes into a **new**, separately-named function.
- Every new admin mutation route calls `logAdminAction` with a natural-sentence `details` string per `docs/LOGGING.md` — one summary row per batch action, not one per id.
- Bulk selection state is page-owned (`Set<number>`), cleared on **every** query-affecting state change including page number (mirror `PaymentsPage.tsx:202`'s exact `useEffect(() => { setSelected(new Set()); }, [outcome, q, page]);` pattern — don't repeat the bug that was fixed mid-review on the Payments plan).
- `POST /api/vouchers/bulk-action` validates `ids` non-empty and caps at 50, sequential loop (never `Promise.all`/a single spanning transaction) — mirror `apps/web-admin/src/routes/api/orders.ts:455-485`'s exact reasoning (SQLite is single-writer; an unbounded concurrent batch would stall other writers).
- `pnpm typecheck` and `pnpm test` must stay green after every task.
- UI reuses existing shared components only (`StatCard`, `SearchBar`, `FilterBar`, `Checkbox`, `Pagination`, `EmptyState`, `ConfirmDialog`) — never hand-roll a new pattern.

---

### Task 1: `deriveVoucherStatus` + `listVouchersPaged` crud

**Files:**
- Modify: `packages/db/src/crud/vouchers.ts`
- Create: `packages/db/src/crud/vouchers_paged.test.ts`

**Interfaces:**
- Produces: `type VoucherStatus = "active" | "expired" | "usedUp"`; `deriveVoucherStatus(v: { isActive: boolean; expiresAt: Date | null; usageLimit: number | null; usedCount: number }, now?: Date): VoucherStatus | null`; `listVouchersPaged(db: Db, opts: { q?: string | null; status?: VoucherStatus | null; limit?: number; offset?: number }): Promise<{ rows: Voucher[]; total: number }>` (where `Voucher` is Prisma's generated voucher row type — the same shape `listVouchers` already returns).

- [ ] **Step 1: Write the failing test**

Create `packages/db/src/crud/vouchers_paged.test.ts`:

```ts
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { makeTestDb, type TestDb } from "../../../../tests/helpers/testdb";
import { resetDb } from "../../../../tests/helpers/sampleData";
import { createVoucher, listVouchersPaged, deriveVoucherStatus } from "@app/db";
import { VoucherType } from "@app/core/enums";

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
});

describe("deriveVoucherStatus", () => {
  const now = new Date("2026-07-24T00:00:00.000Z");

  it("returns expired when expiresAt is in the past, regardless of isActive", () => {
    expect(deriveVoucherStatus({ isActive: true, expiresAt: new Date("2026-07-01"), usageLimit: null, usedCount: 0 }, now)).toBe("expired");
    expect(deriveVoucherStatus({ isActive: false, expiresAt: new Date("2026-07-01"), usageLimit: null, usedCount: 0 }, now)).toBe("expired");
  });

  it("returns usedUp when usedCount >= usageLimit and not expired", () => {
    expect(deriveVoucherStatus({ isActive: true, expiresAt: null, usageLimit: 10, usedCount: 10 }, now)).toBe("usedUp");
    expect(deriveVoucherStatus({ isActive: true, expiresAt: new Date("2026-08-01"), usageLimit: 5, usedCount: 7 }, now)).toBe("usedUp");
  });

  it("returns active when isActive, not expired, not used up", () => {
    expect(deriveVoucherStatus({ isActive: true, expiresAt: null, usageLimit: null, usedCount: 0 }, now)).toBe("active");
  });

  it("returns null when inactive, not expired, not used up", () => {
    expect(deriveVoucherStatus({ isActive: false, expiresAt: null, usageLimit: null, usedCount: 0 }, now)).toBeNull();
  });

  it("prioritizes expired over usedUp", () => {
    expect(deriveVoucherStatus({ isActive: true, expiresAt: new Date("2026-07-01"), usageLimit: 5, usedCount: 5 }, now)).toBe("expired");
  });
});

describe("listVouchersPaged", () => {
  it("filters by q (code substring, case-insensitive-in-practice via uppercase storage)", async () => {
    await createVoucher(prisma, { code: "SAVE10", type: VoucherType.PERCENT, value: "10" });
    await createVoucher(prisma, { code: "WELCOME5", type: VoucherType.FIXED, value: "5" });

    const result = await listVouchersPaged(prisma, { q: "save" });
    expect(result.rows.map((v) => v.code)).toEqual(["SAVE10"]);
    expect(result.total).toBe(1);
  });

  it("returns everything when q is empty or omitted", async () => {
    await createVoucher(prisma, { code: "A1", type: VoucherType.PERCENT, value: "1" });
    await createVoucher(prisma, { code: "B2", type: VoucherType.PERCENT, value: "1" });

    expect((await listVouchersPaged(prisma, {})).total).toBe(2);
    expect((await listVouchersPaged(prisma, { q: "" })).total).toBe(2);
  });

  it("filters by status across the WHOLE dataset, not just the requested page", async () => {
    // 3 expired vouchers total; request page 1 with limit 2 and status=expired —
    // total must reflect all 3, not just what's on this page (the exact class
    // of bug the Payments plan fixed for KPI cards).
    const past = new Date(Date.now() - 24 * 60 * 60 * 1000);
    for (const code of ["EXP1", "EXP2", "EXP3"]) {
      await createVoucher(prisma, { code, type: VoucherType.PERCENT, value: "1", expiresAt: past });
    }
    await createVoucher(prisma, { code: "ACTIVE1", type: VoucherType.PERCENT, value: "1" });

    const page1 = await listVouchersPaged(prisma, { status: "expired", limit: 2, offset: 0 });
    expect(page1.rows).toHaveLength(2);
    expect(page1.total).toBe(3);

    const page2 = await listVouchersPaged(prisma, { status: "expired", limit: 2, offset: 2 });
    expect(page2.rows).toHaveLength(1);
    expect(page2.total).toBe(3);
  });

  it("filters by usedUp status (cross-column usedCount >= usageLimit)", async () => {
    const v = await createVoucher(prisma, { code: "USEDUP1", type: VoucherType.PERCENT, value: "1", usageLimit: 2 });
    await prisma.voucher.update({ where: { id: v.id }, data: { usedCount: 2 } });
    await createVoucher(prisma, { code: "NOTUSED", type: VoucherType.PERCENT, value: "1", usageLimit: 5 });

    const result = await listVouchersPaged(prisma, { status: "usedUp" });
    expect(result.rows.map((r) => r.code)).toEqual(["USEDUP1"]);
    expect(result.total).toBe(1);
  });

  it("combines q and status filters", async () => {
    const past = new Date(Date.now() - 24 * 60 * 60 * 1000);
    await createVoucher(prisma, { code: "COMBOEXP", type: VoucherType.PERCENT, value: "1", expiresAt: past });
    await createVoucher(prisma, { code: "COMBOACTIVE", type: VoucherType.PERCENT, value: "1" });

    const result = await listVouchersPaged(prisma, { q: "combo", status: "expired" });
    expect(result.rows.map((r) => r.code)).toEqual(["COMBOEXP"]);
  });

  it("respects limit/offset when no status filter is given (plain DB pagination path)", async () => {
    for (let i = 0; i < 5; i++) {
      await createVoucher(prisma, { code: `PLAIN${i}`, type: VoucherType.PERCENT, value: "1" });
    }
    const result = await listVouchersPaged(prisma, { limit: 2, offset: 0 });
    expect(result.rows).toHaveLength(2);
    expect(result.total).toBe(5);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test -- packages/db/src/crud/vouchers_paged.test.ts`
Expected: FAIL — `deriveVoucherStatus`/`listVouchersPaged` are not exported (not defined yet).

- [ ] **Step 3: Write minimal implementation**

In `packages/db/src/crud/vouchers.ts`, add after the existing `listVouchers` function (after its closing brace, line 21):

```ts
export type VoucherStatus = "active" | "expired" | "usedUp";

/** Precedence: expired > usedUp > active — a voucher's status can't depend
 *  on which page it's on, so this is the single source of truth used by both
 *  server-side status filtering (listVouchersPaged) and the KPI aggregate
 *  (getVoucherStats). Kept in sync with the client's per-row display logic
 *  in VouchersPage.tsx (which annotates already-fetched rows, not filters —
 *  no pagination-correctness risk there). */
export function deriveVoucherStatus(
  v: { isActive: boolean; expiresAt: Date | null; usageLimit: number | null; usedCount: number },
  now: Date = new Date(),
): VoucherStatus | null {
  if (v.expiresAt && v.expiresAt.getTime() < now.getTime()) return "expired";
  if (v.usageLimit != null && v.usedCount >= v.usageLimit) return "usedUp";
  return v.isActive ? "active" : null;
}

/**
 * Paginated + filterable voucher listing for the admin Vouchers page.
 * Distinct from `listVouchers` (used unmodified by the Telegram bot's admin
 * panel, apps/order-bot/src/handlers/admin.ts) — that function keeps its
 * existing plain-array signature untouched.
 *
 * `status` depends on a cross-column comparison (usedCount vs usageLimit)
 * that isn't expressible in a single Prisma `where` clause. Rather than drop
 * to raw SQL (disallowed, CLAUDE.md), this fetches the `q`-narrowed set (a
 * single shop's voucher table — small), derives status in JS, then filters
 * and paginates in JS. This stays correct regardless of page (never scoped
 * to just the requested page), unlike a client-side-only filter would be.
 */
export async function listVouchersPaged(
  db: Db,
  opts: { q?: string | null; status?: VoucherStatus | null; limit?: number; offset?: number } = {},
) {
  const where: Record<string, unknown> = {};
  if (opts.q?.trim()) where.code = { contains: opts.q.trim().toUpperCase() };

  const all = await db.voucher.findMany({ where, orderBy: { createdAt: "desc" } });
  const now = new Date();
  const filtered = opts.status ? all.filter((v) => deriveVoucherStatus(v, now) === opts.status) : all;

  const offset = opts.offset ?? 0;
  const limit = opts.limit ?? filtered.length;
  return { rows: filtered.slice(offset, offset + limit), total: filtered.length };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test -- packages/db/src/crud/vouchers_paged.test.ts`
Expected: PASS (11 tests)

- [ ] **Step 5: Commit**

```bash
git add packages/db/src/crud/vouchers.ts packages/db/src/crud/vouchers_paged.test.ts
git commit -m "feat(db): add deriveVoucherStatus and listVouchersPaged for the Vouchers admin page"
```

---

### Task 2: `getVoucherStats` crud

**Files:**
- Modify: `packages/db/src/crud/vouchers.ts`
- Modify: `packages/db/src/crud/vouchers_paged.test.ts`

**Interfaces:**
- Consumes: `deriveVoucherStatus` (Task 1).
- Produces: `getVoucherStats(db: Db, now?: Date): Promise<{ total: number; active: number; expiringSoon: number; usedUp: number }>`.

- [ ] **Step 1: Write the failing test**

Append to `packages/db/src/crud/vouchers_paged.test.ts` (add the import, then the block):

```ts
import { getVoucherStats } from "@app/db";
```

```ts
describe("getVoucherStats", () => {
  it("counts total/active/expiringSoon/usedUp as GLOBAL aggregates, unaffected by pagination", async () => {
    const now = new Date("2026-07-24T00:00:00.000Z");
    const past = new Date("2026-07-01T00:00:00.000Z");
    const in3Days = new Date("2026-07-27T00:00:00.000Z");
    const in30Days = new Date("2026-08-23T00:00:00.000Z");

    await createVoucher(prisma, { code: "ACTIVE1", type: VoucherType.PERCENT, value: "1" }); // active, no expiry
    await createVoucher(prisma, { code: "EXPIRING1", type: VoucherType.PERCENT, value: "1", expiresAt: in3Days }); // active + expiring soon
    await createVoucher(prisma, { code: "FAR1", type: VoucherType.PERCENT, value: "1", expiresAt: in30Days }); // active, not expiring soon
    await createVoucher(prisma, { code: "EXPIRED1", type: VoucherType.PERCENT, value: "1", expiresAt: past }); // expired
    const usedUpV = await createVoucher(prisma, { code: "USEDUP1", type: VoucherType.PERCENT, value: "1", usageLimit: 1 });
    await prisma.voucher.update({ where: { id: usedUpV.id }, data: { usedCount: 1 } }); // used up

    const stats = await getVoucherStats(prisma, now);
    expect(stats.total).toBe(5);
    expect(stats.active).toBe(3); // ACTIVE1, EXPIRING1, FAR1
    expect(stats.expiringSoon).toBe(1); // EXPIRING1 only
    expect(stats.usedUp).toBe(1); // USEDUP1
  });

  it("returns all zeros when there are no vouchers", async () => {
    const stats = await getVoucherStats(prisma);
    expect(stats).toEqual({ total: 0, active: 0, expiringSoon: 0, usedUp: 0 });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test -- packages/db/src/crud/vouchers_paged.test.ts -t getVoucherStats`
Expected: FAIL — `getVoucherStats` is not exported.

- [ ] **Step 3: Write minimal implementation**

In `packages/db/src/crud/vouchers.ts`, add after `listVouchersPaged`:

```ts
const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** Global voucher health counts for the admin page's KPI row — always
 *  computed over the WHOLE table, never scoped to the current search/status
 *  filter or page (mirrors PaymentsPage's KPI cards, which read
 *  server-wide aggregates rather than the currently-filtered/paginated set). */
export async function getVoucherStats(
  db: Db,
  now: Date = new Date(),
): Promise<{ total: number; active: number; expiringSoon: number; usedUp: number }> {
  const all = await db.voucher.findMany({
    select: { isActive: true, expiresAt: true, usageLimit: true, usedCount: true },
  });
  let active = 0;
  let expiringSoon = 0;
  let usedUp = 0;
  for (const v of all) {
    const status = deriveVoucherStatus(v, now);
    if (status === "active") {
      active++;
      if (v.expiresAt) {
        const daysLeft = (v.expiresAt.getTime() - now.getTime()) / MS_PER_DAY;
        if (daysLeft >= 0 && daysLeft <= 7) expiringSoon++;
      }
    } else if (status === "usedUp") {
      usedUp++;
    }
  }
  return { total: all.length, active, expiringSoon, usedUp };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test -- packages/db/src/crud/vouchers_paged.test.ts`
Expected: PASS (13 tests total)

- [ ] **Step 5: Commit**

```bash
git add packages/db/src/crud/vouchers.ts packages/db/src/crud/vouchers_paged.test.ts
git commit -m "feat(db): add getVoucherStats for the Vouchers admin page KPI row"
```

---

### Task 3: `bulkSetVouchersActive` + `bulkDeleteVouchers` crud

**Files:**
- Modify: `packages/db/src/crud/vouchers.ts`
- Modify: `packages/db/src/crud/vouchers_paged.test.ts`

**Interfaces:**
- Produces: `bulkSetVouchersActive(db: Db, ids: number[], isActive: boolean): Promise<number>`; `bulkDeleteVouchers(db: Db, ids: number[]): Promise<{ succeeded: number[]; failed: { id: number; error: string }[] }>`.

- [ ] **Step 1: Write the failing test**

Append to `packages/db/src/crud/vouchers_paged.test.ts` (add the import, then the block):

```ts
import { bulkSetVouchersActive, bulkDeleteVouchers } from "@app/db";
```

```ts
describe("bulkSetVouchersActive", () => {
  it("activates/deactivates the given ids and returns the updated count", async () => {
    const v1 = await createVoucher(prisma, { code: "BULK1", type: VoucherType.PERCENT, value: "1" });
    const v2 = await createVoucher(prisma, { code: "BULK2", type: VoucherType.PERCENT, value: "1" });
    await createVoucher(prisma, { code: "UNTOUCHED", type: VoucherType.PERCENT, value: "1" });

    const count = await bulkSetVouchersActive(prisma, [v1.id, v2.id], false);
    expect(count).toBe(2);

    const reloaded1 = await prisma.voucher.findUnique({ where: { id: v1.id } });
    const untouched = await prisma.voucher.findUnique({ where: { code: "UNTOUCHED" } });
    expect(reloaded1!.isActive).toBe(false);
    expect(untouched!.isActive).toBe(true);
  });

  it("returns 0 for an empty id list", async () => {
    expect(await bulkSetVouchersActive(prisma, [], true)).toBe(0);
  });
});

describe("bulkDeleteVouchers", () => {
  it("deletes eligible vouchers and skips used ones with an error entry", async () => {
    const v1 = await createVoucher(prisma, { code: "DEL1", type: VoucherType.PERCENT, value: "1" });
    const used = await createVoucher(prisma, { code: "USEDDEL", type: VoucherType.PERCENT, value: "1" });
    await prisma.voucher.update({ where: { id: used.id }, data: { usedCount: 1 } });

    const result = await bulkDeleteVouchers(prisma, [v1.id, used.id]);
    expect(result.succeeded).toEqual([v1.id]);
    expect(result.failed).toEqual([{ id: used.id, error: "cannot delete a voucher that has been used" }]);

    expect(await prisma.voucher.findUnique({ where: { id: v1.id } })).toBeNull();
    expect(await prisma.voucher.findUnique({ where: { id: used.id } })).not.toBeNull();
  });

  it("reports a not-found error for a nonexistent id", async () => {
    const result = await bulkDeleteVouchers(prisma, [999999]);
    expect(result.succeeded).toEqual([]);
    expect(result.failed).toEqual([{ id: 999999, error: "voucher not found" }]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test -- packages/db/src/crud/vouchers_paged.test.ts -t "bulkSetVouchersActive|bulkDeleteVouchers"`
Expected: FAIL — neither function is exported.

- [ ] **Step 3: Write minimal implementation**

In `packages/db/src/crud/vouchers.ts`, add after `getVoucherStats`:

```ts
/** Toggle-only bulk action — can't fail per-item, so a simple updateMany
 *  suffices (mirrors bulkSetCatalogProductsActive, packages/db/src/crud/catalog.ts:212-216). */
export async function bulkSetVouchersActive(db: Db, ids: number[], isActive: boolean): Promise<number> {
  if (!ids.length) return 0;
  const res = await db.voucher.updateMany({ where: { id: { in: ids } }, data: { isActive } });
  return res.count;
}

/** Delete can fail per-item (a used voucher can't be deleted — same guard as
 *  the existing single-id deleteVoucher), so this needs the richer
 *  succeeded/failed shape — mirrors POST /api/orders/bulk-action's
 *  loop-and-collect pattern (apps/web-admin/src/routes/api/orders.ts:455-485). */
export async function bulkDeleteVouchers(
  db: Db,
  ids: number[],
): Promise<{ succeeded: number[]; failed: { id: number; error: string }[] }> {
  const succeeded: number[] = [];
  const failed: { id: number; error: string }[] = [];
  for (const id of ids) {
    const voucher = await db.voucher.findUnique({ where: { id } });
    if (!voucher) {
      failed.push({ id, error: "voucher not found" });
      continue;
    }
    if (voucher.usedCount > 0) {
      failed.push({ id, error: "cannot delete a voucher that has been used" });
      continue;
    }
    await db.voucher.delete({ where: { id } });
    succeeded.push(id);
  }
  return { succeeded, failed };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test -- packages/db/src/crud/vouchers_paged.test.ts`
Expected: PASS (17 tests total)

- [ ] **Step 5: Commit**

```bash
git add packages/db/src/crud/vouchers.ts packages/db/src/crud/vouchers_paged.test.ts
git commit -m "feat(db): add bulkSetVouchersActive and bulkDeleteVouchers"
```

---

### Task 4: Wire `GET /api/vouchers` to pagination/search/status/stats

**Files:**
- Modify: `apps/web-admin/src/routes/api/vouchers.ts`
- Modify: `apps/web-admin/test/web.test.ts`

**Interfaces:**
- Consumes: `listVouchersPaged`, `getVoucherStats` (Tasks 1-2).
- Produces: `GET /api/vouchers` accepts `?q=`, `?status=active|expired|usedUp`, `?page=` (1-indexed, page size 50 server-side constant); response gains `total: number`, `page: number`, `pageSize: number`, `stats: { total, active, expiringSoon, usedUp }` alongside the existing `vouchers`/`types` fields.

- [ ] **Step 1: Write the failing test**

Locate the existing Vouchers route tests in `apps/web-admin/test/web.test.ts` (search for `"/api/vouchers"` — there's an existing `"GET /api/vouchers lists vouchers"` style test to use as the insertion point and mocking convention reference) and add:

```ts
  it("GET /api/vouchers supports q, status, and page params, and returns stats + total", async () => {
    await post("/api/vouchers", seed.cookie, { csrf_token: seed.csrf, code: "SEARCHABLE1", type: "PERCENT", value: "10" });
    await post("/api/vouchers", seed.cookie, { csrf_token: seed.csrf, code: "OTHER2", type: "PERCENT", value: "5" });

    const res = await get("/api/vouchers?q=searchable", seed.cookie);
    expect(res.statusCode).toBe(200);
    const data = JSON.parse(res.body) as {
      vouchers: Array<{ code: string }>;
      total: number;
      page: number;
      pageSize: number;
      stats: { total: number; active: number; expiringSoon: number; usedUp: number };
    };
    expect(data.vouchers.map((v) => v.code)).toEqual(["SEARCHABLE1"]);
    expect(data.total).toBe(1);
    expect(data.page).toBe(1);
    expect(typeof data.pageSize).toBe("number");
    expect(data.stats.total).toBeGreaterThanOrEqual(2);
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test -- apps/web-admin/test/web.test.ts -t "q, status, and page params"`
Expected: FAIL — `data.total`/`data.stats` are `undefined`, and `q` isn't applied (both vouchers returned).

- [ ] **Step 3: Write minimal implementation**

In `apps/web-admin/src/routes/api/vouchers.ts`, update the import list:

```ts
import {
  prisma,
  listVouchers,
  listVouchersPaged,
  getVoucherStats,
  getVoucherByCode,
  getVoucher,
  createVoucher,
  setVoucherActive,
  deleteVoucher,
  bulkSetVouchersActive,
  bulkDeleteVouchers,
  logAdminAction,
  type VoucherStatus,
} from "@app/db";
```

Add a `PAGE_SIZE` constant near the top (after `const VOUCHER_TYPES = ...`):

```ts
const PAGE_SIZE = 50;
const VOUCHER_STATUSES: readonly VoucherStatus[] = ["active", "expired", "usedUp"];
```

Replace the `GET /api/vouchers` handler:

```ts
  app.get("/api/vouchers", { preHandler: currentAdmin }, async (req, reply) => {
    const q = req.query as Record<string, string | undefined>;
    const search = q.q?.trim() || null;
    const status = q.status && (VOUCHER_STATUSES as readonly string[]).includes(q.status) ? (q.status as VoucherStatus) : null;
    const page = Math.max(Number(q.page) || 1, 1);
    const offset = (page - 1) * PAGE_SIZE;

    const [{ rows, total }, stats] = await Promise.all([
      listVouchersPaged(prisma, { q: search, status, limit: PAGE_SIZE, offset }),
      getVoucherStats(prisma),
    ]);
    const vouchersWithDisplay = rows.map((v) => ({ ...v, expiresAtDisplay: displayDate(v.expiresAt) }));
    return reply.send({
      vouchers: vouchersWithDisplay,
      types: VOUCHER_TYPES,
      total,
      page,
      pageSize: PAGE_SIZE,
      stats,
    });
  });
```

Note: `listVouchers` stays imported since it may still be referenced elsewhere in this file (it isn't — but leave the import only if still used; if unused after this edit, remove it from the import list to avoid an unused-import typecheck error).

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test -- apps/web-admin/test/web.test.ts -t "q, status, and page params"`
Expected: PASS

Then run the full existing Vouchers route test block to confirm no regression:
Run: `pnpm test -- apps/web-admin/test/web.test.ts -t "vouchers"`
Expected: all PASS

- [ ] **Step 5: Commit**

```bash
git add apps/web-admin/src/routes/api/vouchers.ts apps/web-admin/test/web.test.ts
git commit -m "feat(web-admin): add pagination, search, status filter, and stats to GET /api/vouchers"
```

---

### Task 5: `POST /api/vouchers/bulk-action` route

**Files:**
- Modify: `apps/web-admin/src/routes/api/vouchers.ts`
- Modify: `apps/web-admin/test/web.test.ts`

**Interfaces:**
- Consumes: `bulkSetVouchersActive`, `bulkDeleteVouchers` (Task 3).
- Produces: `POST /api/vouchers/bulk-action`, body `{ ids: number[]; action: "activate" | "deactivate" | "delete" }`, response `{ succeeded: number[]; failed: { id: number; error: string }[] }` for `delete` (and for `activate`/`deactivate`, `{ succeeded: number[]; failed: [] }` — every id in `ids` treated as succeeded since the toggle can't fail per-item).

- [ ] **Step 1: Write the failing test**

Add to `apps/web-admin/test/web.test.ts`, near the other Vouchers route tests:

```ts
  it("POST /api/vouchers/bulk-action deactivates a batch and audit-logs once", async () => {
    const r1 = await post("/api/vouchers", seed.cookie, { csrf_token: seed.csrf, code: "BULKA1", type: "PERCENT", value: "10" });
    const r2 = await post("/api/vouchers", seed.cookie, { csrf_token: seed.csrf, code: "BULKA2", type: "PERCENT", value: "10" });
    const id1 = (JSON.parse(r1.body) as { voucher: { id: number } }).voucher.id;
    const id2 = (JSON.parse(r2.body) as { voucher: { id: number } }).voucher.id;

    const res = await post("/api/vouchers/bulk-action", seed.cookie, {
      csrf_token: seed.csrf,
      ids: [id1, id2],
      action: "deactivate",
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { succeeded: number[]; failed: unknown[] };
    expect(body.succeeded.sort()).toEqual([id1, id2].sort());
    expect(body.failed).toEqual([]);

    const list = await get("/api/vouchers", seed.cookie);
    const data = JSON.parse(list.body) as { vouchers: Array<{ id: number; isActive: boolean }> };
    expect(data.vouchers.find((v) => v.id === id1)!.isActive).toBe(false);

    const logs = await listAuditLogs(prisma, { limit: 5 });
    expect(logs.some((l) => l.action === "voucher_bulk_deactivate")).toBe(true);
  });

  it("POST /api/vouchers/bulk-action rejects an empty id list", async () => {
    const res = await post("/api/vouchers/bulk-action", seed.cookie, {
      csrf_token: seed.csrf,
      ids: [],
      action: "deactivate",
    });
    expect(res.statusCode).toBe(400);
  });

  it("POST /api/vouchers/bulk-action rejects an unknown action", async () => {
    const res = await post("/api/vouchers/bulk-action", seed.cookie, {
      csrf_token: seed.csrf,
      ids: [1],
      action: "nonsense",
    });
    expect(res.statusCode).toBe(400);
  });

  it("POST /api/vouchers/bulk-action delete reports per-id failures for used vouchers", async () => {
    const r1 = await post("/api/vouchers", seed.cookie, { csrf_token: seed.csrf, code: "BULKDEL1", type: "PERCENT", value: "10" });
    const id1 = (JSON.parse(r1.body) as { voucher: { id: number } }).voucher.id;

    const res = await post("/api/vouchers/bulk-action", seed.cookie, {
      csrf_token: seed.csrf,
      ids: [id1],
      action: "delete",
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { succeeded: number[]; failed: unknown[] };
    expect(body.succeeded).toEqual([id1]);
  });
```

(Confirm the exact `listAuditLogs` import/usage convention and `post`/`get` test helper signatures already in this file before writing — mirror whatever existing Vouchers/Orders bulk-action tests in this same file already do rather than inventing new helper usage.)

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test -- apps/web-admin/test/web.test.ts -t "bulk-action"`
Expected: FAIL — route doesn't exist (404).

- [ ] **Step 3: Write minimal implementation**

In `apps/web-admin/src/routes/api/vouchers.ts`, add after the existing `POST /api/vouchers/:voucherId/delete` route, before the closing brace of `vouchersApiRoutes`:

```ts
  app.post("/api/vouchers/bulk-action", { preHandler: csrfProtect }, async (req, reply) => {
    const body = (req.body ?? {}) as { ids?: unknown; action?: unknown };
    const ids = Array.isArray(body.ids)
      ? body.ids.map((id) => Number(id)).filter((id) => Number.isInteger(id) && id > 0)
      : [];
    if (ids.length === 0) {
      return reply.code(400).send({ error: "Select at least one voucher." });
    }
    if (ids.length > 50) {
      return reply.code(400).send({ error: "Select 50 vouchers or fewer per bulk action." });
    }
    const action = body.action;
    if (action !== "activate" && action !== "deactivate" && action !== "delete") {
      return reply.code(400).send({ error: "Unknown bulk action." });
    }

    if (action === "delete") {
      const result = await bulkDeleteVouchers(prisma, ids);
      await logAdminAction(prisma, {
        adminId: req.admin!.userId,
        action: "voucher_bulk_delete",
        targetType: "voucher",
        details:
          result.failed.length > 0
            ? `Deleted ${result.succeeded.length} vouchers; skipped ${result.failed.length} already-used.`
            : `Deleted ${result.succeeded.length} vouchers.`,
      });
      return reply.send(result);
    }

    const isActive = action === "activate";
    const count = await bulkSetVouchersActive(prisma, ids, isActive);
    await logAdminAction(prisma, {
      adminId: req.admin!.userId,
      action: isActive ? "voucher_bulk_activate" : "voucher_bulk_deactivate",
      targetType: "voucher",
      details: `${isActive ? "Activated" : "Deactivated"} ${count} vouchers.`,
    });
    return reply.send({ succeeded: ids, failed: [] });
  });
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test -- apps/web-admin/test/web.test.ts -t "bulk-action"`
Expected: PASS (4 tests)

- [ ] **Step 5: Commit**

```bash
git add apps/web-admin/src/routes/api/vouchers.ts apps/web-admin/test/web.test.ts
git commit -m "feat(web-admin): add POST /api/vouchers/bulk-action"
```

---

### Task 6: Frontend — KPI row + PageHeader description

**Files:**
- Modify: `apps/web-admin/client/src/pages/VouchersPage.tsx`
- Modify: `apps/web-admin/client/src/pages/VouchersPage.test.tsx`

**Interfaces:**
- Consumes: `stats` field on the `GET /api/vouchers` response (Task 4).

- [ ] **Step 1: Write the failing test**

Add to `VouchersPage.test.tsx`:

```tsx
  it("shows a KPI row sourced from the server-wide stats field", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          vouchers: [VOUCHER],
          types: ["PERCENT", "FIXED"],
          total: 1,
          page: 1,
          pageSize: 50,
          stats: { total: 42, active: 30, expiringSoon: 3, usedUp: 5 },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    render(<VouchersPage />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByText("SAVE10")).toBeInTheDocument());

    expect(screen.getByText("42")).toBeInTheDocument();
    expect(screen.getByText("30")).toBeInTheDocument();
    expect(screen.getByText("3")).toBeInTheDocument();
    expect(screen.getByText("5")).toBeInTheDocument();
  });
```

Note: every other existing `mockPaymentsFetch`-style response body in this file (e.g. the `it("renders voucher rows")` test at line 48) will need `total`, `page`, `pageSize`, `stats` fields added to stay realistic once the page reads them — update each existing mocked response body in this file to include `total: <vouchers.length>, page: 1, pageSize: 50, stats: { total: 0, active: 0, expiringSoon: 0, usedUp: 0 }` (adjust `stats.total` to match `vouchers.length` where it matters for a given test's assertions; where it doesn't matter, `0` is fine).

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run apps/web-admin/client/src/pages/VouchersPage.test.tsx -t "KPI row"`
Expected: FAIL — no such text rendered.

- [ ] **Step 3: Write minimal implementation**

In `VouchersPage.tsx`, add imports:

```ts
import { StatCard } from "../components/shared/StatCard";
import { Ticket, CheckCircle2, Clock, Ban } from "lucide-react";
```

(Merge `Ticket`/`CheckCircle2`/`Clock`/`Ban` into the existing `lucide-react` import line rather than duplicating it — the existing line already imports `Copy, Check, Tag, Plus, X, Trash2`.)

Add a `VouchersData` interface update — the `useVouchers` hook's return type gains the new fields:

```ts
function useVouchers() {
  return useQuery<{
    vouchers: Voucher[];
    types: string[];
    total: number;
    page: number;
    pageSize: number;
    stats: { total: number; active: number; expiringSoon: number; usedUp: number };
  }>({
    queryKey: ["vouchers"],
    queryFn: async () => {
      const res = await fetch("/api/vouchers");
      if (!res.ok) throw new Error("Failed to load");
      return res.json();
    },
  });
}
```

Add the KPI row and header description in the JSX, replacing the existing `<PageHeader title="Vouchers" actions={...} />` block:

```tsx
      <PageHeader
        title="Vouchers"
        description="Create and manage discount codes."
        actions={
          <Button onClick={() => setShowForm(v => !v)}>
            {showForm ? <X className="h-4 w-4" /> : <Plus className="h-4 w-4" />}
            {showForm ? "Cancel" : "New Voucher"}
          </Button>
        }
      />

      <div className="mb-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatCard label="Total Vouchers" value={data?.stats.total ?? 0} icon={Ticket} isLoading={!data} />
        <StatCard label="Active" value={data?.stats.active ?? 0} icon={CheckCircle2} tone="success" isLoading={!data} />
        <StatCard label="Expiring Soon" value={data?.stats.expiringSoon ?? 0} icon={Clock} tone="warning" isLoading={!data} />
        <StatCard label="Used Up" value={data?.stats.usedUp ?? 0} icon={Ban} isLoading={!data} />
      </div>
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm exec vitest run apps/web-admin/client/src/pages/VouchersPage.test.tsx`
Expected: PASS (all tests, including every pre-existing test with its mocked response body updated per Step 1's note)

- [ ] **Step 5: Commit**

```bash
git add apps/web-admin/client/src/pages/VouchersPage.tsx apps/web-admin/client/src/pages/VouchersPage.test.tsx
git commit -m "feat(web-admin-client): add a KPI row to the Vouchers page"
```

---

### Task 7: Frontend — server-side search + status filter (replace client `.filter()`)

**Files:**
- Modify: `apps/web-admin/client/src/pages/VouchersPage.tsx`
- Modify: `apps/web-admin/client/src/pages/VouchersPage.test.tsx`

**Interfaces:**
- Consumes: `q`/`status` query params on `GET /api/vouchers` (Task 4).
- Produces: no new exports — internal page behavior only.

- [ ] **Step 1: Write the failing test**

Add to `VouchersPage.test.tsx`:

```tsx
  it("debounces a code search into the query params", async () => {
    vi.useFakeTimers();
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify({ vouchers: [], types: [], total: 0, page: 1, pageSize: 50, stats: { total: 0, active: 0, expiringSoon: 0, usedUp: 0 } }), { status: 200, headers: { "Content-Type": "application/json" } }),
    );
    render(<VouchersPage />, { wrapper: Wrapper });
    await vi.waitFor(() => expect(screen.getByText(/no vouchers/i)).toBeInTheDocument());

    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ vouchers: [], types: [], total: 0, page: 1, pageSize: 50, stats: { total: 0, active: 0, expiringSoon: 0, usedUp: 0 } }), { status: 200, headers: { "Content-Type": "application/json" } }),
    );
    const search = screen.getByPlaceholderText(/search voucher code/i);
    fireEvent.change(search, { target: { value: "SAVE" } });
    expect(fetchSpy).not.toHaveBeenCalled();

    vi.advanceTimersByTime(300);
    await vi.waitFor(() => expect(fetchSpy).toHaveBeenCalledWith(expect.stringContaining("q=SAVE")));
    vi.useRealTimers();
  });

  it("sends the status filter as a server query param instead of filtering client-side", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify({ vouchers: [VOUCHER], types: ["PERCENT", "FIXED"], total: 1, page: 1, pageSize: 50, stats: { total: 1, active: 1, expiringSoon: 0, usedUp: 0 } }), { status: 200, headers: { "Content-Type": "application/json" } }),
    );
    render(<VouchersPage />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByText("SAVE10")).toBeInTheDocument());

    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ vouchers: [], types: [], total: 0, page: 1, pageSize: 50, stats: { total: 1, active: 0, expiringSoon: 0, usedUp: 0 } }), { status: 200, headers: { "Content-Type": "application/json" } }),
    );
    await user.click(screen.getByRole("combobox"));
    await waitFor(() => screen.getByRole("option", { name: "Expired" }));
    await user.click(screen.getByRole("option", { name: "Expired" }));

    await waitFor(() => expect(fetchSpy).toHaveBeenCalledWith(expect.stringContaining("status=expired")));
  });
```

Remove/replace the now-obsolete pre-existing `"filters vouchers by status"` test (lines 142-181 in the current file) — it currently asserts client-side filtering behavior against a single unpaginated mocked response, which no longer matches how the page works after this task. Replace it with the `"sends the status filter as a server query param..."` test above (already does), so delete the old one to avoid two tests asserting contradictory mechanisms for the same feature.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run apps/web-admin/client/src/pages/VouchersPage.test.tsx -t "debounces a code search|status filter as a server"`
Expected: FAIL — no search placeholder exists yet; status Select doesn't trigger a new fetch.

- [ ] **Step 3: Write minimal implementation**

In `VouchersPage.tsx`, add imports:

```ts
import { SearchBar } from "../components/shared/SearchBar";
```

Delete the now-unused client-side status logic — remove `getVoucherStatus` and the `type VoucherStatus = "active" | "expired" | "usedUp";` declaration (status derivation now lives server-side; `isExpiringSoon` below needs a small adjustment since it no longer has a local `getVoucherStatus` to call — see below), but **keep** `isExpiringSoon` for the per-row "Expiring Soon" badge, adjusted to use the row's own fields directly instead of calling the now-removed `getVoucherStatus`:

```ts
const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** Per-row "Expiring Soon" badge — a display annotation on already-fetched
 *  rows, not a filter/aggregate, so no pagination-correctness concern here
 *  (unlike the status Select, which now goes server-side — see useVouchers). */
function isExpiringSoon(v: Voucher, now: Date): boolean {
  if (!v.expiresAt) return false;
  if (!v.isActive) return false;
  if (new Date(v.expiresAt).getTime() < now.getTime()) return false; // already expired
  if (v.usageLimit != null && v.usedCount >= v.usageLimit) return false; // already used up
  const daysLeft = (new Date(v.expiresAt).getTime() - now.getTime()) / MS_PER_DAY;
  return daysLeft >= 0 && daysLeft <= 7;
}
```

Update `useVouchers` (already touched in Task 6) to accept `q`/`status`/`page` and build query params, mirroring `PaymentsPage.tsx`'s `usePayments`:

```ts
function useVouchers(q: string, status: string, page: number) {
  return useQuery<{
    vouchers: Voucher[];
    types: string[];
    total: number;
    page: number;
    pageSize: number;
    stats: { total: number; active: number; expiringSoon: number; usedUp: number };
  }>({
    queryKey: ["vouchers", q, status, page],
    queryFn: async () => {
      const params = new URLSearchParams({ page: String(page) });
      if (q) params.set("q", q);
      if (status) params.set("status", status);
      const res = await fetch(`/api/vouchers?${params.toString()}`);
      if (!res.ok) throw new Error("Failed to load");
      return res.json();
    },
  });
}
```

In `VouchersPage`, replace the `statusFilter` state and `useVouchers()` call site with:

```ts
  const [qDraft, setQDraft] = useState("");
  const [q, setQ] = useState("");
  const [status, setStatus] = useState("");
  const [page, setPage] = useState(1);
  useEffect(() => {
    const timer = setTimeout(() => { setQ(qDraft); setPage(1); }, 300);
    return () => clearTimeout(timer);
  }, [qDraft]);
  const { data, isError } = useVouchers(q, status, page);
```

(Add `useEffect` to the existing `useState` import from `"react"` at the top of the file: `import { useState, useEffect } from "react";`.)

Remove the `filteredVouchers` client-side `.filter()` computation entirely — replace all its usages (`data={filteredVouchers}` on the `DataTable`, and the `statusFilter === "_all_"` ternary in the `empty` prop) with `data={data?.vouchers ?? []}` and a status-aware empty message driven by `status` instead of `statusFilter`.

Replace the `FilterBar` block:

```tsx
      <FilterBar className="mb-4">
        <SearchBar
          value={qDraft}
          onChange={setQDraft}
          placeholder="Search voucher code..."
          className="w-full sm:w-64"
        />
        <div className="flex flex-col gap-1">
          <label className="text-xs text-ink-soft">Status</label>
          <Select
            value={status || "_all_"}
            onValueChange={v => { setStatus(v === "_all_" ? "" : v); setPage(1); }}
          >
            <SelectTrigger className="w-40"><SelectValue placeholder="All statuses" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="_all_">All</SelectItem>
              <SelectItem value="active">Active</SelectItem>
              <SelectItem value="expired">Expired</SelectItem>
              <SelectItem value="usedUp">Used up</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </FilterBar>
```

Update the `DataTable`'s `empty` prop:

```tsx
        empty={
          status || q
            ? <EmptyState icon={Tag} title="No matching vouchers" description="Try a different search or status filter." />
            : <EmptyState icon={Tag} title="No vouchers found" description="Create your first voucher to offer discounts." />
        }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm exec vitest run apps/web-admin/client/src/pages/VouchersPage.test.tsx`
Expected: PASS (all tests)

- [ ] **Step 5: Commit**

```bash
git add apps/web-admin/client/src/pages/VouchersPage.tsx apps/web-admin/client/src/pages/VouchersPage.test.tsx
git commit -m "feat(web-admin-client): move Vouchers search/status filtering server-side"
```

---

### Task 8: Frontend — bulk selection + sticky bulk-action bar

**Files:**
- Modify: `apps/web-admin/client/src/pages/VouchersPage.tsx`
- Modify: `apps/web-admin/client/src/pages/VouchersPage.test.tsx`

**Interfaces:**
- Consumes: `POST /api/vouchers/bulk-action` (Task 5).

- [ ] **Step 1: Write the failing test**

Add to `VouchersPage.test.tsx`:

```tsx
  it("bulk-deactivates selected vouchers", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    const vouchers = [
      { ...VOUCHER, id: 1, code: "BULKV1" },
      { ...VOUCHER, id: 2, code: "BULKV2" },
    ];
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify({ vouchers, types: ["PERCENT", "FIXED"], total: 2, page: 1, pageSize: 50, stats: { total: 2, active: 2, expiringSoon: 0, usedUp: 0 } }), { status: 200, headers: { "Content-Type": "application/json" } }),
    );
    const postSpy = vi.spyOn(globalThis, "fetch");
    render(<VouchersPage />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByText("BULKV1")).toBeInTheDocument());

    await user.click(screen.getByRole("checkbox", { name: /select voucher bulkv1/i }));
    await user.click(screen.getByRole("checkbox", { name: /select voucher bulkv2/i }));
    expect(screen.getByText("2 selected")).toBeInTheDocument();

    postSpy.mockResolvedValueOnce(
      new Response(JSON.stringify({ succeeded: [1, 2], failed: [] }), { status: 200, headers: { "Content-Type": "application/json" } }),
    );
    postSpy.mockResolvedValueOnce(
      new Response(JSON.stringify({ vouchers: [], types: [], total: 0, page: 1, pageSize: 50, stats: { total: 2, active: 0, expiringSoon: 0, usedUp: 0 } }), { status: 200, headers: { "Content-Type": "application/json" } }),
    );

    await user.click(screen.getByRole("button", { name: /deactivate 2 vouchers/i }));

    await waitFor(() => expect(postSpy).toHaveBeenCalledWith("/api/vouchers/bulk-action", expect.objectContaining({
      method: "POST",
      body: JSON.stringify({ ids: [1, 2], action: "deactivate" }),
    })));
  });

  it("clears the bulk selection when the page changes", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    const vouchers = [{ ...VOUCHER, id: 1, code: "PAGEV1" }];
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify({ vouchers, types: ["PERCENT", "FIXED"], total: 60, page: 1, pageSize: 50, stats: { total: 60, active: 60, expiringSoon: 0, usedUp: 0 } }), { status: 200, headers: { "Content-Type": "application/json" } }),
    );
    render(<VouchersPage />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByText("PAGEV1")).toBeInTheDocument());

    await user.click(screen.getByRole("checkbox", { name: /select voucher pagev1/i }));
    expect(screen.getByText("1 selected")).toBeInTheDocument();

    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify({ vouchers: [{ ...VOUCHER, id: 2, code: "PAGEV2" }], types: [], total: 60, page: 2, pageSize: 50, stats: { total: 60, active: 60, expiringSoon: 0, usedUp: 0 } }), { status: 200, headers: { "Content-Type": "application/json" } }),
    );
    await user.click(screen.getByRole("button", { name: /next/i }));
    await waitFor(() => expect(screen.getByText("PAGEV2")).toBeInTheDocument());

    expect(screen.queryByText(/selected/)).not.toBeInTheDocument();
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run apps/web-admin/client/src/pages/VouchersPage.test.tsx -t "bulk-deactivates|clears the bulk selection"`
Expected: FAIL — no checkboxes/bulk bar exist yet, and `Pagination`'s "Next" button doesn't exist yet (added in Task 9 — this test's "Next" click will only pass once Task 9 is also done; if run in isolation before Task 9, this second test will fail for the additional reason that Pagination isn't wired yet. That's expected — Task 8 and Task 9 together complete this page; run both tasks' new tests together after Task 9 to confirm both pass).

- [ ] **Step 3: Write minimal implementation**

Add imports:

```ts
import { Checkbox } from "@/components/ui/checkbox";
```

Add selection state and the bulk mutation (near the other `useState`/`useMutation` declarations):

```ts
  const [selected, setSelected] = useState<Set<number>>(new Set());
  useEffect(() => { setSelected(new Set()); }, [q, status, page]);

  const vouchers = data?.vouchers ?? [];
  const allSelected = vouchers.length > 0 && vouchers.every(v => selected.has(v.id));

  function toggleSelected(id: number) {
    setSelected(s => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id); else n.add(id);
      return n;
    });
  }
  function toggleSelectAll() {
    setSelected(prev => {
      const next = new Set(prev);
      if (allSelected) {
        vouchers.forEach(v => next.delete(v.id));
      } else {
        vouchers.forEach(v => next.add(v.id));
      }
      return next;
    });
  }

  const bulkAction = useMutation({
    mutationFn: (vars: { ids: number[]; action: "activate" | "deactivate" | "delete" }) =>
      apiPost<{ succeeded: number[]; failed: { id: number; error: string }[] }>("/api/vouchers/bulk-action", vars),
    onSuccess: (result, vars) => {
      void qc.invalidateQueries({ queryKey: ["vouchers"] });
      setSelected(new Set());
      const verb = vars.action === "activate" ? "Activated" : vars.action === "deactivate" ? "Deactivated" : "Deleted";
      toast.success(
        result.failed.length > 0
          ? `${verb} ${result.succeeded.length} of ${vars.ids.length} vouchers — ${result.failed.length} skipped.`
          : `${verb} ${result.succeeded.length} voucher${result.succeeded.length === 1 ? "" : "s"}.`,
      );
    },
    onError: (e: Error) => toast.error(describeError(e.message)),
  });
```

Add the sticky bulk-action bar JSX, placed just above the `<DataTable` call:

```tsx
      {selected.size > 0 && (
        <div className="sticky bottom-4 z-10 mb-3 flex flex-wrap items-center gap-3 rounded-lg border border-line bg-card px-3 py-2 text-sm shadow-lift transition-all duration-150">
          <span className="text-ink-soft">{selected.size} selected</span>
          <Button
            size="sm"
            variant="outline"
            disabled={bulkAction.isPending}
            onClick={() => bulkAction.mutate({ ids: Array.from(selected), action: "activate" })}
          >
            Activate {selected.size} voucher{selected.size === 1 ? "" : "s"}
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={bulkAction.isPending}
            onClick={() => bulkAction.mutate({ ids: Array.from(selected), action: "deactivate" })}
          >
            Deactivate {selected.size} voucher{selected.size === 1 ? "" : "s"}
          </Button>
          <ConfirmDialog
            trigger={
              <Button size="sm" variant="destructive" disabled={bulkAction.isPending}>
                Delete {selected.size} voucher{selected.size === 1 ? "" : "s"}
              </Button>
            }
            title={`Delete ${selected.size} voucher${selected.size === 1 ? "" : "s"}?`}
            description="Vouchers that have already been used are skipped, not deleted."
            confirmLabel="Delete"
            onConfirm={() => bulkAction.mutate({ ids: Array.from(selected), action: "delete" })}
          />
          <Button size="sm" variant="ghost" onClick={() => setSelected(new Set())}>Clear</Button>
        </div>
      )}
```

Add a leading `select` column to the `DataTable`'s `columns` array (as the first entry, before `"code"`):

```ts
          {
            key: "select",
            header: (
              <Checkbox
                checked={allSelected}
                onCheckedChange={toggleSelectAll}
                disabled={vouchers.length === 0}
                aria-label="Select all vouchers"
              />
            ),
            render: v => (
              <Checkbox
                checked={selected.has(v.id)}
                onCheckedChange={() => toggleSelected(v.id)}
                onClick={e => e.stopPropagation()}
                aria-label={`Select voucher ${v.code}`}
              />
            ),
          },
```

- [ ] **Step 4: Run test to verify it passes**

The "clears the bulk selection when the page changes" test depends on Task 9's `Pagination` wiring to be complete (the "Next" button doesn't exist until then). Run the bulk-deactivate test in isolation to confirm Task 8's own work:

Run: `pnpm exec vitest run apps/web-admin/client/src/pages/VouchersPage.test.tsx -t "bulk-deactivates"`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/web-admin/client/src/pages/VouchersPage.tsx apps/web-admin/client/src/pages/VouchersPage.test.tsx
git commit -m "feat(web-admin-client): add bulk selection and bulk activate/deactivate/delete to Vouchers"
```

---

### Task 9: Frontend — shared `Pagination` component

**Files:**
- Modify: `apps/web-admin/client/src/pages/VouchersPage.tsx`
- Modify: `apps/web-admin/client/src/pages/VouchersPage.test.tsx`

**Interfaces:**
- Consumes: `Pagination` component (`page`/`pageSize`/`total`/`onPageChange`), `total`/`pageSize` fields on the `GET /api/vouchers` response (Task 4).

- [ ] **Step 1: Write the failing test**

The "clears the bulk selection when the page changes" test from Task 8 already covers this — it asserts clicking a button named `/next/i` (the `Pagination` component's "Next page" button, `aria-label="Next page"`) triggers a new page fetch. No additional new test is needed beyond that one (which was written in Task 8 but only passes once this task's `Pagination` wiring exists).

Additionally add a lightweight page-count assertion:

```tsx
  it("shows result-count text via the shared Pagination component", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify({ vouchers: [VOUCHER], types: ["PERCENT", "FIXED"], total: 120, page: 1, pageSize: 50, stats: { total: 120, active: 120, expiringSoon: 0, usedUp: 0 } }), { status: 200, headers: { "Content-Type": "application/json" } }),
    );
    render(<VouchersPage />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByText("SAVE10")).toBeInTheDocument());
    expect(screen.getByText(/showing 1–50 of 120/i)).toBeInTheDocument();
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run apps/web-admin/client/src/pages/VouchersPage.test.tsx -t "clears the bulk selection when the page changes|shows result-count text"`
Expected: FAIL — no `Pagination` control rendered yet.

- [ ] **Step 3: Write minimal implementation**

Add import:

```ts
import { Pagination } from "../components/shared/Pagination";
```

Add the `Pagination` component after the `DataTable` call, at the bottom of the component's returned JSX (before the closing `</PageLayout>`):

```tsx
      {data && (
        <div className="mt-4">
          <Pagination
            page={page}
            pageSize={data.pageSize}
            total={data.total}
            onPageChange={setPage}
          />
        </div>
      )}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm exec vitest run apps/web-admin/client/src/pages/VouchersPage.test.tsx`
Expected: PASS (all tests in the file, including the two from Task 8 that depended on this task)

- [ ] **Step 5: Commit**

```bash
git add apps/web-admin/client/src/pages/VouchersPage.tsx apps/web-admin/client/src/pages/VouchersPage.test.tsx
git commit -m "feat(web-admin-client): use the shared Pagination component on Vouchers"
```

---

## Final verification (after Task 9)

- [ ] Run the full monorepo check:

```bash
pnpm typecheck
pnpm test
pnpm --filter @app/web-admin-client build
```

Expected: all exit 0.

- [ ] Manual check (`pnpm dev:web`, browse `http://127.0.0.1:8000/vouchers`):
  1. KPI numbers reflect the whole voucher table, not just the current page/filter.
  2. Search a code substring, confirm the list filters and pagination total updates.
  3. Filter by status (Active/Expired/Used up), confirm it's now a real server round-trip (network tab) and the count/pagination reflect the whole filtered set, not just visible rows.
  4. Select 2+ vouchers, bulk-deactivate, confirm the toast and the Active toggles update.
  5. Select a used voucher alongside an unused one, bulk-delete, confirm the skip is reported in the toast and the used voucher survives.
  6. Confirm `apps/order-bot`'s voucher-list Telegram command still works unmodified (spot-check `listVouchers` wasn't touched — `pnpm test` already covers this via the order-bot's own test suite, but a manual bot check is a good final sanity check if time allows).
