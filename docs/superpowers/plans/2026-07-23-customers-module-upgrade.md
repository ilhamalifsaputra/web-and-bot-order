# Customers Module Upgrade — Task Plan

## Context

The Customers page (`apps/web-admin/client/src/pages/UsersPage.tsx`, nav-labeled
"Customers") is currently the simple CRUD tier: a single search box, no KPIs, no
pagination, no bulk actions, no row-action menu, and a hand-rolled avatar circle
instead of the shared `Avatar` component. This plan upgrades it to the same
operational-grade full tier as `OrdersPage.tsx` — KPI summary, real filters, sort,
bulk export, a row-action menu, compact money/time display — while strictly
reusing the existing design system (`docs/ui/00-10_*.md`) with zero new visual
patterns, and fixes three related real gaps: `lastSeenAt` never updates from web
activity, web registration never collects a name, and `UserDetailPage.tsx` already
fetches ticket data it never renders.

Decisions already confirmed with the product owner (do not re-litigate):
- Admin-role accounts are excluded from Customers KPIs/list/filters.
- Bulk actions ship as Export only (Broadcast/Assign Tag/Send Voucher/Delete have
  no backing capability today).
- Sort is a server-side `orderBy` (Select-driven, no header-click sorting).
- The `lastSeenAt` web-activity gap is fixed at the source, not just labeled.

## Global Constraints (binding on every task)

**Design system (`docs/ui/00-10_*.md`) — read `00_AI_RULES.md`, `01_DESIGN_SYSTEM.md`,
`02_ADMIN_LAYOUT.md`, `03_COMPONENT_LIBRARY.md`, `04_CRUD_TEMPLATE.md`,
`05_TABLE_GUIDELINES.md`, `08_UX_RULES.md`, `09_CODE_STYLE.md` before writing any
UI code:**
- Never invent a new color, spacing value, radius, shadow, icon size, or component
  variant — use only documented tokens (`bg-pine`/`text-ink-soft`/`rounded-xl`/
  `shadow-soft`/etc.) and existing components (`Button`, `DataTable`, `StatusBadge`,
  `Avatar`, `Tooltip`, `Select`, `DropdownMenu`, `Checkbox`, `Pagination`,
  `EmptyState`, `FilterBar`, `SearchBar`, `DateInput`, `StatCard`, `CurrencyStack`).
- Never hand-roll a `<table>`, a `window.confirm()`, a checkbox-styled toggle, or a
  bespoke colored status pill — the existing shared component is mandatory.
- No `react-hook-form`/`zod` — manual `useState` + `canSubmit` validation only.
- No dark-mode classes. No new easing/duration constants — reuse `lib/motion.ts`.
- `OrdersPage.tsx` (full tier: KPIs, `FilterBar` draft+Apply/Clear, sticky bulk
  bar, `DataTable` with row-action `DropdownMenu`, `Pagination`) and
  `OrdersKpiRow.tsx`/`useOrdersKpis.ts` are the exact structural/pattern reference
  for every frontend task below — match their shape, don't improvise a variant.

**Money & data integrity:**
- Money is always `@app/core/money` `Decimal`, never `number`/`float` arithmetic.
- No raw SQL or ad-hoc Prisma queries in route/handler files — all DB logic lives
  in `packages/db/src/crud/*` with colocated Vitest coverage.
- Timestamps: store/compare in UTC; convert to the shop's `TIMEZONE` only at the
  display edge (`displayDate`/`displayDateTime` in `apps/web-admin/src/dateDisplay.ts`,
  `localize` in `@app/core/datetime`).
- SQLite is single-writer — never take a DB write on every request without a
  throttle; keep any `$transaction` short.
- Never log or render a raw payment credential, password hash, `file_id`, or full
  DB URL.

**Web/Fastify conventions:**
- Every mutating route uses the `csrfProtect` preHandler; admin reads use
  `currentAdmin`.
- `apps/web-admin/client` and `apps/storefront/client` are built React SPAs — run
  `pnpm --filter @app/web-admin-client build` / `pnpm --filter @app/storefront-client
  build` after any change under their `client/` directories, before running tests
  that render those pages.
- Neither web app ever calls the Telegram API directly.

**Verification every task must run before reporting DONE:**
`pnpm typecheck` and the specific test file(s) named in the task (via `pnpm --filter
<workspace> test <file>` or `pnpm test <path>` — match the repo's existing vitest
invocation pattern). Rebuild the relevant client (`web-admin-client` and/or
`storefront-client`) if the task touches a `client/` directory.

---

## Task 1: Customers list/count/sort/KPI/order-stats crud functions

**Where this fits:** the new data layer every later task builds on — the routes
(Task 3) and the rewritten Customers page (Task 5) both call these functions.

**File:** `packages/db/src/crud/users.ts` (add to the existing file — do not touch
`getUserByTelegramId`, `getUser`, `upsertUser`, `setUserLanguage`, `adjustWallet`,
`setUserRole`, `setUserBanned`, `searchUsers`, `listRecentUsers`, `userTotalSpent`,
`totalSpentByUserIds`, `listWalletLedger` — all existing behavior is unchanged).

Add imports: `import type { Prisma } from "@prisma/client";`, extend
`import { UserRole, Language } from "@app/core/enums";` to also import
`OrderStatus`, and add `import { startOfDayUtc } from "@app/core/datetime";`.

Add a module constant:
```ts
/** Admins are managed on the separate Admins page — the Customers page's list,
 * filters, and KPIs never include role=ADMIN, filtered or not. */
const NON_ADMIN_ROLES = [UserRole.CUSTOMER, UserRole.RESELLER];
```

Add:

```ts
export type UserSort = "newest" | "oldest" | "lastSeen" | "spend";

export interface UserFilter {
  role?: UserRole | null;       // CUSTOMER or RESELLER only; null/omitted = both (never ADMIN)
  banned?: boolean | null;      // true=banned only, false=active only, null/omitted=both
  q?: string | null;            // same OR-contains shape as searchUsers
  since?: Date | null;          // createdAt >=
  until?: Date | null;          // createdAt <=
  lastSeenSince?: Date | null;  // lastSeenAt >=
  lastSeenUntil?: Date | null;  // lastSeenAt <=
  ids?: number[] | null;        // restrict to this exact id set (bulk export-selected)
}
```

`userWhere(f: UserFilter): Prisma.UserWhereInput` — top-level `role` always
resolves to `f.role ?? { in: NON_ADMIN_ROLES }` (ADMIN is never reachable through
this function, filtered or not); `banned` exact match when non-null; `since`/
`until` build a `createdAt` range; `lastSeenSince`/`lastSeenUntil` build a
`lastSeenAt` range; `ids` becomes `{ in: f.ids }`; `q` (trimmed) becomes an `OR` of
`username`/`fullName`/`loginUsername`/`email` contains, plus `telegramId` exact
match when `q` is all-digits — same shape `searchUsers` already uses.

`userOrderBy(sort)`: `"oldest"` → `{ createdAt: "asc" }`; `"lastSeen"` →
`{ lastSeenAt: "desc" }`; default (`"newest"` or `"spend"`, spend is handled
separately below) → `{ createdAt: "desc" }`.

**Sort-by-spend — use exactly this two-phase approach** (a single `findMany`
relation-orderBy cannot sort by a child relation's `_sum`, only `_count` — this
was verified against the generated Prisma client during planning; `groupBy` does
support ordering by `_sum`, which is why this needs two phases):

```ts
async function rankUserIdsBySpend(
  db: Db,
  where: Prisma.UserWhereInput,
  offset: number,
  limit: number,
): Promise<number[]> {
  const matched = await db.user.findMany({ where, select: { id: true }, orderBy: { createdAt: "desc" } });
  const matchedIds = matched.map((u) => u.id);
  if (matchedIds.length === 0) return [];

  const ranked = await db.order.groupBy({
    by: ["userId"],
    where: { userId: { in: matchedIds }, status: OrderStatus.DELIVERED, currency: "IDR" },
    _sum: { totalAmount: true },
    orderBy: { _sum: { totalAmount: "desc" } },
  });
  const rankedIds = ranked.map((r) => r.userId);
  const rankedSet = new Set(rankedIds);
  const zeroSpendIds = matchedIds.filter((id) => !rankedSet.has(id)); // already createdAt-desc
  const fullyRankedIds = [...rankedIds, ...zeroSpendIds];
  return fullyRankedIds.slice(offset, offset + limit);
}
```

Ranking is **IDR-only, deliberately** — spend is inherently two numbers (IDR,
USDT) and blending them into one ranking would fabricate a single scalar
(`CurrencyStack` exists specifically to avoid exactly that). The caller-facing
Select option this feeds must be labeled **"Highest Spender (IDR)"**, not just
"Highest Spender" (Task 5).

```ts
export async function listUsers(db: Db, opts: UserFilter & { sort?: UserSort; limit?: number; offset?: number } = {}) {
  const limit = opts.limit ?? 20;
  const offset = opts.offset ?? 0;
  const where = userWhere(opts);

  if (opts.sort === "spend") {
    const pageIds = await rankUserIdsBySpend(db, where, offset, limit);
    if (pageIds.length === 0) return [];
    const rows = await db.user.findMany({ where: { id: { in: pageIds } } });
    const byId = new Map(rows.map((u) => [u.id, u]));
    return pageIds.map((id) => byId.get(id)).filter((u): u is (typeof rows)[number] => u != null);
  }

  return db.user.findMany({ where, orderBy: userOrderBy(opts.sort), skip: offset, take: limit });
}

export function countUsers(db: Db, opts: UserFilter = {}) {
  return db.user.count({ where: userWhere(opts) });
}
```

```ts
export interface CustomersKpis {
  totalCustomers: number;
  newToday: number;
  activeToday: number;
  returningCustomers: number;
  totalRevenue: { idr: Decimal; usdt: Decimal };
}

export async function customersKpis(db: Db): Promise<CustomersKpis> {
  const todayStart = startOfDayUtc();
  const nonAdmin = { role: { in: NON_ADMIN_ROLES } };
  const [totalCustomers, newToday, activeToday, returningGroups, revenueGroups] = await Promise.all([
    db.user.count({ where: nonAdmin }),
    db.user.count({ where: { ...nonAdmin, createdAt: { gte: todayStart } } }),
    db.user.count({ where: { ...nonAdmin, lastSeenAt: { gte: todayStart } } }),
    db.order.groupBy({ by: ["userId"], where: { status: OrderStatus.DELIVERED, user: nonAdmin }, _count: { _all: true } }),
    db.order.groupBy({ by: ["currency"], where: { status: OrderStatus.DELIVERED, user: nonAdmin }, _sum: { totalAmount: true } }),
  ]);

  const returningCustomers = returningGroups.filter((g) => g._count._all >= 2).length;

  let idr = new Decimal(0);
  let usdt = new Decimal(0);
  for (const g of revenueGroups) {
    const sum = new Decimal(g._sum.totalAmount ?? 0);
    if (g.currency === "IDR") idr = idr.plus(sum); else usdt = usdt.plus(sum);
  }
  return { totalCustomers, newToday, activeToday, returningCustomers, totalRevenue: { idr, usdt } };
}
```

`returningCustomers` counts non-admin users with **≥2 DELIVERED** orders — a user
with 1 DELIVERED + 3 PENDING does not count. `totalRevenue` is **all-time**
(distinct from Orders' "Revenue Today"), DELIVERED-only, non-admin only.

```ts
export interface UserOrderStats {
  totalOrders: number;       // any status
  lastOrderAt: Date | null;  // max createdAt, any status
  deliveredOrders: number;   // DELIVERED only — feeds the per-row "Returning" badge in Task 5
}

export async function orderStatsByUserIds(db: Db, userIds: number[]): Promise<Map<number, UserOrderStats>> {
  const result = new Map<number, UserOrderStats>();
  if (userIds.length === 0) return result;

  const [counts, lastOrders, delivered] = await Promise.all([
    db.order.groupBy({ by: ["userId"], where: { userId: { in: userIds } }, _count: { _all: true } }),
    db.order.groupBy({ by: ["userId"], where: { userId: { in: userIds } }, _max: { createdAt: true } }),
    db.order.groupBy({ by: ["userId"], where: { userId: { in: userIds }, status: OrderStatus.DELIVERED }, _count: { _all: true } }),
  ]);
  const lastMap = new Map(lastOrders.map((r) => [r.userId, r._max.createdAt]));
  const deliveredMap = new Map(delivered.map((r) => [r.userId, r._count._all]));
  for (const c of counts) {
    result.set(c.userId, {
      totalOrders: c._count._all,
      lastOrderAt: lastMap.get(c.userId) ?? null,
      deliveredOrders: deliveredMap.get(c.userId) ?? 0,
    });
  }
  return result;
}
```

This must never issue one query per user (N+1) — exactly 3 `groupBy` calls total
for the whole page, mirroring `totalSpentByUserIds`'s existing batching
discipline. **Do not add an "Average Order Value" function** — spend and orders
both split IDR/USDT, so a single AOV scalar would either pick one currency
arbitrarily or blend two currencies into a meaningless number; this is
deliberately out of scope.

**Tests — add to `packages/db/src/crud/users.test.ts`** (follow its existing
describe-block-per-function convention, using `makeTestDb`/`upsertUser`/
`prisma.order.create` exactly as the existing tests in that file do):
- `listUsers`/`countUsers`: a user with `role: "ADMIN"` is excluded from results
  even when no `role` filter is passed; `role: "RESELLER"` filter returns only
  RESELLER rows; `banned: true`/`false` filters correctly; `since`/`until`
  (createdAt) range; `lastSeenSince`/`lastSeenUntil` range; `q` still matches
  username/fullName/loginUsername/email/telegramId (regression check — same
  behavior `searchUsers` already has, now paginated); `ids` restricts to the given
  set; `sort: "newest"`/`"oldest"`/`"lastSeen"` produce the expected order;
  `limit`/`offset` paginate correctly.
- `rankUserIdsBySpend` (via `listUsers({sort: "spend", ...})`): ranks users by
  DELIVERED IDR total descending; a user with only DELIVERED USDT orders (no IDR)
  ranks as a zero-IDR-spender, appended after every real IDR spender; zero-spend
  users keep their relative createdAt-desc order; a page boundary that splits
  ranked-vs-zero-spend users still returns the correct slice.
- `customersKpis`: `totalCustomers` excludes ADMIN; `newToday`/`activeToday`
  respect the `startOfDayUtc()` boundary (a user created/last-seen just before
  today's start is excluded); `returningCustomers` requires ≥2 DELIVERED orders
  specifically (a user with 1 DELIVERED + 2 PENDING does not count, a user with 2
  DELIVERED does); `totalRevenue` sums DELIVERED orders only, split by currency,
  and excludes orders placed by an ADMIN-role user.
- `orderStatsByUserIds`: `totalOrders` counts every status; `lastOrderAt` is the
  max `createdAt` across all statuses (not just DELIVERED — a non-DELIVERED order
  placed after the last DELIVERED one must still be reflected); `deliveredOrders`
  counts DELIVERED only and can differ from `totalOrders`; an empty `userIds`
  array returns an empty Map without querying the DB; a user with zero orders is
  absent from the returned Map (not present with zero values).

**Verification:** `pnpm --filter @app/db test users.test.ts` (or the repo's
equivalent invocation — check `package.json` scripts if unsure), `pnpm typecheck`.

---

## Task 2: `touchLastSeen` + wire into the storefront

**Where this fits:** fixes the real gap that `lastSeenAt` never updates from web
activity — only the Telegram bot path (`upsertUser`) refreshes it today. This
directly feeds the "Active Today" KPI from Task 1/5.

**File 1: `packages/db/src/crud/users.ts`** (same file as Task 1 — this task runs
after Task 1 is committed, so just add to the already-updated file; do not modify
anything Task 1 added). Add:

```ts
/** In-memory throttle for touchLastSeen — same TTL/pattern as
 * warmUserCache.ts's cache, so a busy storefront session doesn't take a
 * lastSeenAt write on every single page view (SQLite is single-writer). */
const LAST_SEEN_TOUCH_TTL_MS = 5 * 60 * 1000;
const lastSeenTouchedAt = new Map<number, number>();

/**
 * Refresh a user's lastSeenAt from web activity, throttled to at most once
 * per LAST_SEEN_TOUCH_TTL_MS per user. The bot already keeps lastSeenAt
 * fresh on every message via upsertUser; the storefront never touched it at
 * all before this, so web-only customers looked permanently inactive after
 * registration. Called from the storefront's per-request customer
 * resolution — fire-and-forget, not awaited by the caller.
 */
export async function touchLastSeen(db: Db, userId: number): Promise<void> {
  const lastTouch = lastSeenTouchedAt.get(userId);
  const now = Date.now();
  if (lastTouch != null && now - lastTouch < LAST_SEEN_TOUCH_TTL_MS) return;
  lastSeenTouchedAt.set(userId, now);
  await db.user.update({ where: { id: userId }, data: { lastSeenAt: new Date(now) } });
}
```

Read `packages/db/src/crud/warmUserCache.ts` first — mirror its exact TTL
constant style and comment tone.

**File 2: `apps/storefront/src/plugins/auth.ts`** — inside `optionalCustomer(req)`,
right after `const user = await getUser(prisma, data.userId);` succeeds (i.e. once
you know the session is valid and the user is not banned), call
`void touchLastSeen(prisma, user.id);` — fire-and-forget, do not `await` it inline
in a way that blocks the request. Import `touchLastSeen` from `@app/db`. This
function is called on nearly every authenticated storefront request, which is
exactly why the throttle exists.

**Tests:**
- `packages/db/src/crud/users.test.ts`: `touchLastSeen` writes `lastSeenAt` when
  the user has no prior throttle entry or the last touch was >5 minutes ago (use
  a fake/injected clock or directly manipulate the throttle map's exposed
  behavior via two calls with a controlled time gap — check how other time-based
  tests in this file, if any, handle this; if the throttle map isn't testable
  without exporting it, add a minimal test-only export or a second parameter for
  injecting "now", whichever keeps the production API clean); does NOT write
  (no-op) when called again immediately after a real write.
- No dedicated test file exists for `apps/storefront/src/plugins/auth.ts` — do not
  create one speculatively; if you can find an existing storefront route test
  that already exercises an authenticated request path (search for `optionalCustomer`
  or `currentCustomer` usage in `apps/storefront/src/routes/*.test.ts` if any
  exist), you may add an assertion there that `lastSeenAt` advances after a
  request; if no such test file exists, rely on the crud-level test above and
  note this in your report.

**Verification:** `pnpm --filter @app/db test users.test.ts`, `pnpm typecheck`.

---

## Task 3: `apps/web-admin/src/routes/api/users.ts` — list/export/kpis routes

**Where this fits:** the HTTP layer consuming Task 1's crud functions; the
rewritten `UsersPage.tsx` (Task 5) calls these endpoints.

**File:** `apps/web-admin/src/routes/api/users.ts`. Read
`apps/web-admin/src/routes/api/orders.ts` first — the list/export/kpis routes
here mirror its `buildOrderFilter`/pagination/CSV-export/kpis shape exactly.

Add to the `@app/db` import: `listUsers, countUsers, customersKpis,
orderStatsByUserIds, type UserFilter, type UserSort` (alongside the existing
imports). Add module constants:

```ts
const PAGE_SIZE_OPTIONS = [20, 50, 100];
const DEFAULT_PAGE_SIZE = 20;
const SORT_VALUES: UserSort[] = ["newest", "oldest", "lastSeen", "spend"];
```

Add `parseDate`, `parseIdsFilter` helpers (copy the exact shape from
`orders.ts`), a `parseBannedFilter(status)` (`"banned"` → `true`, `"active"` →
`false`, else `null`), a shared `buildUserFilter(q)` (mirrors `buildOrderFilter`,
used by both the list and export routes so their filters can never diverge), and
`csvField`/`csvRow` RFC-4180 helpers (copy from `orders.ts`, or import if they've
already been factored into a shared module — check first rather than duplicating
if a shared location already exists).

**Replace the current `GET /api/users` handler body** with: parse
`page`/`pageSize` from the existing allow-list pattern, validate `sort` against
`SORT_VALUES` (default `"newest"`), build the filter via `buildUserFilter(q)`,
`Promise.all([listUsers(...), countUsers(...)])`, then batch
`totalSpentByUserIds` and `orderStatsByUserIds` for the resulting page of user
ids, and respond with
`{ users: usersWithDisplay, total, page, pageSize, hasNext, roles: ROLES }` where
each user row gets `createdAtDisplay`, `lastSeenAtDisplay`, `totalSpent`,
`totalOrders`, `deliveredOrders`, `lastOrderAt`, `lastOrderAtDisplay` attached
(use `displayDate`/`displayDateTime` from `../../dateDisplay`, already imported
in this file).

**Add `GET /api/users/export`** (new route): same `buildUserFilter(q)`,
`listUsers(prisma, { ...filter, sort: "newest", limit: 100000 })`, batch
`totalSpentByUserIds`/`orderStatsByUserIds`, stream a CSV with header row
`["Telegram ID", "Full Name", "Username", "Role", "Status", "Joined", "Last Seen",
"Total Spent (IDR)", "Total Spent (USDT)", "Orders", "Last Order"]` (raw ISO
timestamps in the CSV, not the localized display strings — a CSV consumer should
get the unambiguous form), `Content-Type: text/csv; charset=utf-8`,
`Content-Disposition: attachment; filename="customers.csv"`.

**Add `GET /api/users/kpis`** (new route): calls `customersKpis(prisma)`, shapes
`totalRevenue` the same null-if-zero way `orders.ts`'s `shapeRevenue` does (each
currency is `null` when its Decimal sum `.isZero()`, else `.toString()`).

Leave `GET /api/users/:userId`, `POST .../role`, `.../ban`, `.../wallet`
completely unchanged.

**Tests:** no route-level Fastify test file exists today for
`apps/web-admin/src/routes/api/users.ts` or `orders.ts` (confirm this is still
true before skipping — if one has been added since this plan was written, follow
its existing pattern and add the new routes' happy-path coverage there). If none
exists, do not create one speculatively — route correctness is exercised through
Task 1's crud tests plus Task 5's client-page tests with mocked `fetch`. State
this explicitly in your report rather than silently skipping test coverage
without explanation.

**Verification:** `pnpm typecheck` (this task has no direct test file to run,
but typecheck must catch any signature mismatch against Task 1's exports — if
Task 1 isn't committed yet in your view of the repo, stop and report
NEEDS_CONTEXT rather than guessing at signatures).

---

## Task 4: Frontend infra — relative time, Customers KPI hook/row, StatusBadge, Tooltip mount

**Where this fits:** small, low-risk prerequisites the rewritten `UsersPage.tsx`
(Task 5) depends on. Bundled into one task because each piece is a handful of
lines with no interaction between the pieces.

**1. `apps/web-admin/client/src/lib/relativeTime.ts` (new file):**

```ts
/**
 * Human relative phrasing for a UTC ISO timestamp, for the Joined/Last Seen
 * columns — "Just now" / "N minutes ago" / "N hours ago" / "Yesterday" /
 * "N days ago", falling back to `display` (the shop-timezone-correct string
 * every route already sends as `*Display`, see dateDisplay.ts) once the gap
 * exceeds 30 days.
 *
 * Takes `display` as a required second argument rather than re-deriving an
 * absolute date from `iso` itself: computing a fallback date in the
 * client's local timezone would reintroduce the exact bug dateDisplay.ts's
 * server-side formatting exists to avoid. `display` is always already
 * correct.
 *
 * `now` is an injectable clock for tests; defaults to the real Date.now().
 * A future `iso` (clock skew / bad data) clamps to "Just now" rather than
 * showing a negative duration.
 */
export function formatRelativeTime(iso: string, display: string, now: Date = new Date()): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return display;
  const diffMs = Math.max(0, now.getTime() - then);
  const minute = 60_000, hour = 3_600_000, day = 86_400_000;

  if (diffMs < minute) return "Just now";
  if (diffMs < hour) {
    const m = Math.floor(diffMs / minute);
    return `${m} minute${m === 1 ? "" : "s"} ago`;
  }
  if (diffMs < day) {
    const h = Math.floor(diffMs / hour);
    return `${h} hour${h === 1 ? "" : "s"} ago`;
  }
  const days = Math.floor(diffMs / day);
  if (days === 1) return "Yesterday";
  if (days < 30) return `${days} days ago`;
  return display;
}
```

Callers handle `null`/`undefined` inputs themselves before calling this (Task 5).

**Test — new `apps/web-admin/client/src/lib/relativeTime.test.ts`:** every
threshold: `<60s` → "Just now"; `5*60_000` → "5 minutes ago"; `2*3_600_000` → "2
hours ago"; `1*86_400_000` (+ a small epsilon) → "Yesterday"; `5*86_400_000` → "5
days ago"; `31*86_400_000` → returns the `display` string verbatim; a future
`iso` (negative diff) → "Just now" (clamped, not a negative number); an invalid
`iso` string → returns `display`.

**2. `apps/web-admin/client/src/hooks/useCustomersKpis.ts` (new file)** — read
`apps/web-admin/client/src/hooks/useOrdersKpis.ts` first and mirror its shape
exactly:

```ts
import { useQuery } from "@tanstack/react-query";
import { apiGet } from "../api/client";

export interface CustomersKpis {
  totalCustomers: number;
  newToday: number;
  activeToday: number;
  returningCustomers: number;
  totalRevenue: { idr: string | null; usdt: string | null };
}

export function useCustomersKpis() {
  return useQuery({
    queryKey: ["users", "kpis"],
    queryFn: () => apiGet<CustomersKpis>("/api/users/kpis"),
    refetchInterval: 30_000,
  });
}
```

**Test — new `apps/web-admin/client/src/hooks/useCustomersKpis.test.tsx`:**
mirror whatever test pattern `useOrdersKpis`'s hook test (if one exists) or
another existing hook test in `hooks/*.test.tsx` uses — stub `fetch`, assert the
hook calls `/api/users/kpis`, assert the parsed shape comes through.

**3. `apps/web-admin/client/src/pages/customers/CustomersKpiRow.tsx` (new file)**
— read `apps/web-admin/client/src/pages/orders/OrdersKpiRow.tsx` first and mirror
its shape (including the currency-filter idiom for `CurrencyStack`):

```tsx
import { Users, UserPlus, Activity, Repeat, Wallet } from "lucide-react";
import { StatCard } from "../../components/shared/StatCard";
import { CurrencyStack, type CurrencyAmount } from "../../components/shared/CurrencyAmount";
import { useCustomersKpis } from "../../hooks/useCustomersKpis";

export function CustomersKpiRow(): JSX.Element {
  const { data, isLoading } = useCustomersKpis();

  const revenueAmounts: CurrencyAmount[] = [
    data?.totalRevenue.idr != null ? ({ currency: "IDR", value: data.totalRevenue.idr } as CurrencyAmount) : null,
    data?.totalRevenue.usdt != null ? ({ currency: "USDT", value: data.totalRevenue.usdt } as CurrencyAmount) : null,
  ].filter((a): a is CurrencyAmount => a !== null);

  return (
    <div className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
      <StatCard label="Total Customers" value={data?.totalCustomers ?? 0} icon={Users} isLoading={isLoading} />
      <StatCard label="New Today" value={data?.newToday ?? 0} icon={UserPlus} isLoading={isLoading} />
      <StatCard label="Active Today" value={data?.activeToday ?? 0} icon={Activity} isLoading={isLoading} />
      <StatCard label="Returning Customers" value={data?.returningCustomers ?? 0} icon={Repeat} tone="success" isLoading={isLoading} />
      <StatCard
        label="Total Revenue"
        value={revenueAmounts.length > 0 ? <CurrencyStack amounts={revenueAmounts} /> : "—"}
        icon={Wallet}
        isLoading={isLoading}
      />
    </div>
  );
}
```

No dedicated test file for this component — following the exact precedent that
`OrdersKpiRow.tsx` has no standalone test file either (its rendering is covered
through the page test in Task 5, matching Orders' own pattern).

**4. `apps/web-admin/client/src/components/shared/StatusBadge.tsx`** — add
exactly one line to the existing `TONE` map: `RETURNING: "success",` (placed
logically among the other success-tone entries). This is the only edit to this
file — do not touch anything else in it. Update
`apps/web-admin/client/src/components/shared/StatusBadge.test.tsx` with one new
case asserting `<StatusBadge status="RETURNING" />` renders the success tone
class and the title-cased label "Returning".

**5. `apps/web-admin/client/src/main.tsx`** — mount `TooltipProvider` (from
`@/components/ui/tooltip`) once at the app root, wrapping `<App />` alongside the
existing `QueryClientProvider`/`BrowserRouter` nesting (exact placement doesn't
matter as long as it wraps everything that might render a `Tooltip` — the whole
app is simplest and matches how `QueryClientProvider` is already mounted
app-wide). `Tooltip` is already fully specified in `03_COMPONENT_LIBRARY.md` but
has no live consumer anywhere yet — this is its first real use, not a new
pattern requiring a doc update.

**Verification:** `pnpm --filter @app/web-admin-client build`, `pnpm typecheck`,
`pnpm test relativeTime.test.ts useCustomersKpis.test.tsx StatusBadge.test.tsx`
(or the repo's equivalent per-file vitest invocation).

---

## Task 5: `apps/web-admin/client/src/pages/UsersPage.tsx` — full rewrite

**Where this fits:** the primary deliverable — depends on Task 3 (routes), Task 4
(relativeTime, CustomersKpiRow, StatusBadge RETURNING tone, TooltipProvider
mount). Read `apps/web-admin/client/src/pages/OrdersPage.tsx` in full first — this
rewrite mirrors its structure line-for-line where the pattern applies.

**Identity-block decision (already made — do not redesign):** keep Telegram ID as
its own table column, not folded into the Customer identity cell. It's already a
dedicated row-action target ("Copy Telegram ID") and a scannable `font-mono`
column; merging it into the name cell would leave ragged rows wherever `fullName`
is null, for no space benefit since `DataTable`'s mobile card-stack already gives
every column its own labeled line regardless of desktop layout.

**Full page structure** (`PageLayout` → `PageHeader` with an Export CSV `actions`
link → `CustomersKpiRow` → `FilterBar` (draft+Apply/Clear) → conditional sticky
bulk bar → `DataTable` → `Pagination`):

```tsx
import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { toast } from "sonner";
import { PageLayout } from "../components/shared/PageLayout";
import { PageHeader } from "../components/shared/PageHeader";
import { FilterBar } from "../components/shared/FilterBar";
import { SearchBar } from "../components/shared/SearchBar";
import { DataTable } from "../components/shared/DataTable";
import { EmptyState } from "../components/shared/EmptyState";
import { StatusBadge } from "../components/shared/StatusBadge";
import { Pagination } from "../components/shared/Pagination";
import { CurrencyStack, type CurrencyAmount } from "../components/shared/CurrencyAmount";
import { CustomersKpiRow } from "./customers/CustomersKpiRow";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { DateInput } from "../components/shared/DateInput";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from "@/components/ui/select";
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { Users, MoreVertical, Eye, ShoppingBag, Wallet, LifeBuoy, Copy } from "lucide-react";
import { formatRelativeTime } from "../lib/relativeTime";
import { apiGet } from "../api/client";
```

(Confirm `apiGet` exists in `../api/client` with this call shape — if the file
uses a different helper name, match what's actually there rather than inventing
`apiGet`.)

```tsx
interface CustomerRow {
  id: number;
  username: string | null;
  fullName: string | null;
  telegramId: string | null;
  role: string;
  banned: boolean;
  createdAt: string;
  createdAtDisplay: string | null;
  lastSeenAt: string | null;
  lastSeenAtDisplay: string | null;
  totalSpent: { idr: string; usdt: string };
  totalOrders: number;
  deliveredOrders: number;
  lastOrderAt: string | null;
  lastOrderAtDisplay: string | null;
}

interface CustomersData {
  users: CustomerRow[];
  total: number;
  page: number;
  pageSize: number;
  hasNext: boolean;
  roles: string[];
}

interface Filters {
  q: string;
  role: string;           // "" | "CUSTOMER" | "RESELLER"
  status: string;         // "" | "active" | "banned"
  since: string;
  until: string;
  lastSeenSince: string;
  lastSeenUntil: string;
  sort: string;            // "newest" | "oldest" | "lastSeen" | "spend"
  page: number;
  pageSize: number;
}

function initialFor(row: CustomerRow): string {
  const source = row.fullName ?? row.username;
  return source && source.length > 0 ? source[0]!.toUpperCase() : "?";
}

const EMPTY_FILTERS: Filters = {
  q: "", role: "", status: "", since: "", until: "", lastSeenSince: "", lastSeenUntil: "", sort: "newest", page: 1, pageSize: 20,
};

function useCustomers(filters: Filters) {
  return useQuery<CustomersData>({
    queryKey: ["users", filters],
    queryFn: () => {
      const params = new URLSearchParams();
      if (filters.q) params.set("q", filters.q);
      if (filters.role) params.set("role", filters.role);
      if (filters.status) params.set("status", filters.status);
      if (filters.since) params.set("since", filters.since);
      if (filters.until) params.set("until", filters.until);
      if (filters.lastSeenSince) params.set("lastSeenSince", filters.lastSeenSince);
      if (filters.lastSeenUntil) params.set("lastSeenUntil", filters.lastSeenUntil);
      if (filters.sort !== "newest") params.set("sort", filters.sort);
      if (filters.page > 1) params.set("page", String(filters.page));
      if (filters.pageSize !== 20) params.set("pageSize", String(filters.pageSize));
      return apiGet<CustomersData>(`/api/users?${params.toString()}`);
    },
  });
}
```

Component body: `draft`/`filters` state (`EMPTY_FILTERS`), `selected: Set<number>`
cleared via `useEffect` on `filters` change (identical discipline to
`OrdersPage.tsx`), `applyFilters`/`clearFilters`, `hasActiveFilter` (true if any
filter differs from `EMPTY_FILTERS`, including `sort !== "newest"`), an
`exportParams` URLSearchParams built from the committed `filters` (for the
page-level Export CSV button), `toggleSelected`/`allOnPageSelected`/
`toggleSelectAllOnPage`, and a `targetForOrders(row)` helper returning
`row.telegramId ?? row.username ?? row.fullName ?? null` for the "View Orders"
row action's target.

**`PageHeader`**: title "Customers", description "Browse and manage every
registered customer and reseller.", `actions` = an `<a href="/api/users/export?
${exportParams}">` wrapping `<Button variant="outline" size="sm">Export CSV</Button>`.

**`CustomersKpiRow`** directly below the header.

**`FilterBar`** (`onApply={applyFilters}` `onClear={clearFilters}`): `SearchBar`
(placeholder "Search by name, username, Telegram ID…"), Role `Select`
(All/Customer/Reseller — no Admin option, ever), Status `Select`
(All/Active/Banned), Joined From/To `DateInput` pair, Last Seen From/To
`DateInput` pair, Sort `Select` (Newest/Oldest/Last Seen/"Highest Spender
(IDR)") — each filter field in its own
`<div className="flex flex-col gap-1"><label className="text-xs text-ink-soft">Label</label>...</div>`
block, matching `OrdersPage.tsx`'s exact filter-field markup.

**Sticky bulk bar** (only when `selected.size > 0`, exact markup from
`OrdersPage.tsx`): `{selected.size} selected`, an `<a href="/api/users/export?
ids=...">` wrapped Export `Button`, a ghost "Clear" `Button`. No other bulk
actions.

**`DataTable`** (`stickyHeader`), columns in this order: select checkbox → 
Customer (real `Avatar`/`AvatarFallback` with `initialFor(row)`, default size, +
Full Name `text-sm font-medium text-ink` + `@username` `text-xs text-ink-soft`) →
Telegram ID (`font-mono text-xs text-ink-soft`) → Role (`StatusBadge`) → Status
(`StatusBadge status="BANNED"` when banned, else `StatusBadge status="RETURNING"`
when `deliveredOrders >= 2`, else nothing) → Joined (relative time wrapped in
`Tooltip`/`TooltipTrigger asChild`/`TooltipContent` showing `createdAtDisplay`) →
Last Seen (same treatment with `lastSeenAtDisplay`) → Total Spent (`CurrencyStack`
with zero-valued currencies filtered out of the `amounts` array before
rendering — if both are zero, render a plain `—`) → Orders (`totalOrders`) → Last
Order (`lastOrderAtDisplay ?? "—"`) → action column (`header: ""`, a
`DropdownMenu` wrapped in `<div onClick={(e) => e.stopPropagation()}>`): "View
Customer" (always, `navigate('/users/' + row.id)`), "View Orders" (only when
`targetForOrders(row)` is non-null, `navigate('/orders?q=' + encodeURIComponent(target))`),
"Transactions" (`navigate('/users/' + row.id + '#ledger')`), "Support Tickets"
(`navigate('/users/' + row.id + '#tickets')`), "Copy Telegram ID" (only when
`row.telegramId` is non-null — `navigator.clipboard.writeText(row.telegramId)`
then `toast.success("Telegram ID copied.")`).

`onRowClick`: `navigate('/users/' + row.id)`.

**Empty state**: `EmptyState` with `icon={Users}`, title/description branching on
`hasActiveFilter` — genuinely empty: "No customers yet" / "Customers will appear
here once they interact with the shop." with a `Refresh` `action`; filtered-to-
empty: "No customers match these filters." / "Try widening the date range or
clearing a filter." with `action: Refresh` and `secondaryAction: Clear Filters`.

**Pagination** below the table, driven by `filters.page`/`filters.pageSize`/
`data.total`, matching `OrdersPage.tsx`'s exact usage.

**Error state**: `if (isError) return <PageLayout title="Customers"><p
className="text-rust">Failed to load customers.</p></PageLayout>;` before the
main return.

**Test — rewrite `apps/web-admin/client/src/pages/UsersPage.test.tsx`** (read the
current file first for its existing mock-`fetch` pattern, and
`OrdersPage.test.tsx` for the dual-endpoint-mock pattern this page now also
needs):
- Mock both `/api/users` and `/api/users/kpis` responses (the KPI row renders
  unconditionally, so both must be mocked or the render will error/hang).
- Row renders: full name, `@username`, avatar fallback initial (still plain text,
  `getByText("A")` style assertion continues to work), Telegram ID as its own
  cell/column.
- Zero-currency filtering: a fixture with `totalSpent: { idr: "0", usdt: "20.5" }`
  shows the USDT line but no "Rp0" text.
- FilterBar fields (Role/Status/Joined From-To/Last Seen From-To/Sort) only take
  effect after "Apply" is clicked — assert the underlying fetch/query isn't
  re-triggered on every keystroke/selection, only after Apply, with the expected
  query params present.
- Row checkbox selection surfaces the sticky bulk bar with an Export link
  containing `ids=`; "Clear" empties the selection and hides the bar.
- Row action menu: "View Customer" always present; "View Orders" present only
  when telegramId/username/fullName resolves to something and navigates to
  `/orders?q=...`; "Copy Telegram ID" present only when telegramId is non-null,
  calls a mocked `navigator.clipboard.writeText`, and shows a success toast.
- Empty-state branches: no active filter → "No customers yet" copy, no "Clear
  Filters" action; with an active filter → "No customers match these filters."
  copy with a working "Clear Filters" action.
- `Pagination` renders once `data.total` is present; changing page size resets to
  page 1.
- Error and loading states still work (adapt the existing tests for these to the
  new dual-mock setup).

**Verification:** `pnpm --filter @app/web-admin-client build`, `pnpm typecheck`,
`pnpm test UsersPage.test.tsx`.

---

## Task 6: `apps/web-admin/client/src/pages/UserDetailPage.tsx` — render tickets + anchors

**Where this fits:** gives the Task 5 row actions "Transactions"/"Support
Tickets" a real destination, and closes a pre-existing gap (the detail page
already fetches `tickets` from the API but never renders them).

**File:** `apps/web-admin/client/src/pages/UserDetailPage.tsx`. Two additive
changes only — do not touch the Profile/Wallet Adjustment/Ban cards, the role
`Select`, or any `ConfirmDialog` usage.

1. Add a new "Support Tickets (n)" `Card` + `DataTable`, placed after the
   existing Wallet Ledger `Card`, mirroring the existing Orders/Ledger cards'
   shape exactly:

```tsx
{/* Support Tickets */}
<Card className="mt-6 scroll-mt-20" id="tickets">
  <CardHeader><CardTitle>Support Tickets ({data.tickets.length})</CardTitle></CardHeader>
  <CardContent>
    <DataTable
      columns={[
        { key: "subject", header: "Subject", render: t => <span className="text-sm text-ink">{t.subject}</span> },
        { key: "status", header: "Status", render: t => <StatusBadge status={t.status} /> },
        { key: "date", header: "Date", render: t => <span className="text-xs text-ink-soft">{t.createdAtDisplay ?? "—"}</span> },
      ]}
      data={data.tickets}
      keyExtractor={t => t.id}
      onRowClick={t => navigate(`/support/${t.id}`)}
      empty={<EmptyState title="No support tickets" />}
    />
  </CardContent>
</Card>
```

`/support/:ticketId` is the confirmed real route (see `App.tsx`'s route table —
verify it's still `/support/:ticketId` before wiring `onRowClick`; if it has
changed, match whatever it actually is).

2. Add `id="ledger" className="scroll-mt-20"` to the existing Wallet Ledger
   `Card` (currently a bare `<Card>` with no id) — same anchor convention
   `SettingsPage.tsx` already uses for its jump-nav targets, so the two new
   row-action deep links from Task 5 land cleanly below any sticky header.

**Test — update `apps/web-admin/client/src/pages/UserDetailPage.test.tsx`:**
- A fixture with a populated `tickets: [...]` array renders the new "Support
  Tickets (n)" card with subject/status/date visible.
- `container.querySelector("#ledger")` and `"#tickets"` both resolve to an
  element (confirms the anchors are present).
- Re-run the existing role-change/ban/wallet tests unmodified to confirm no
  regression from the new card (no code path there should have changed).

**Verification:** `pnpm --filter @app/web-admin-client build`, `pnpm typecheck`,
`pnpm test UserDetailPage.test.tsx`.

---

## Task 7: Storefront — require Full Name at registration

**Where this fits:** fixes the second confirmed real gap — `RegisterPage.tsx`
never collects a name and `createWebUser` has no `fullName` param, which is why
web-only signups show "—"/"?" in the Customers table forever. This only affects
**new** registrations going forward — existing null-name accounts are left alone
(no fabricated data).

**File 1: `packages/core/locales/en.json` and `packages/core/locales/id.json`** —
add two matching keys to both files (keep the key sets identical, per the
repo-wide i18n rule):
- `web.register_fullname` — label, e.g. en: "Full Name", id: "Nama Lengkap".
- `web.register_fullname_invalid` — error, e.g. en: "Please enter your full
  name.", id: "Mohon masukkan nama lengkap Anda." (adjust to match the existing
  tone/style of neighboring `web.register_*` keys in both files — read them
  first).

**File 2: `apps/storefront/client/src/pages/RegisterPage.tsx`** — add a
`fullName` state (`useState("")`) and a labeled input block, placed as the first
field (above Username), matching the exact existing field-block markup for
username/email (`<div><label className="text-sm font-semibold" htmlFor="fullName">
{t("web.register_fullname")}</label><input className="field mt-1" type="text"
id="fullName" name="fullName" value={fullName} onChange={...} autoComplete="name"
required minLength={2} maxLength={100} /></div>`). Include `fullName` in the
`registerMutation.mutate({...})` payload and in the `mutationFn`'s `vars` type.

**File 3: `apps/storefront/src/routes/apiAuth.ts`**'s `/auth/register` handler —
add `fullName` to the route's `Body` type, trim it, validate non-empty (e.g.
`fullName.trim().length < 2`) and return `reply.code(400).send({ error:
"web.register_fullname_invalid" })` if invalid, pass `fullName: fullName.trim()`
through to `createWebUser(...)`.

**File 4: `packages/db/src/crud/webauth.ts`**'s `createWebUser` — add a required
`fullName: string` to the function's `args` type (not optional — this guarantees
no future caller can silently skip it), pass it through to `db.user.create({data:
{..., fullName: args.fullName}})`.

**Tests:**
- `apps/storefront/client/src/pages/RegisterPage.test.tsx` — add: the fullName
  field is required (form won't submit without it, matching how the existing
  test likely checks username/email required-ness); the submit payload includes
  `fullName`.
- `packages/db/src/crud/webauth.test.ts` — add: `createWebUser` requires
  `fullName` in its args (TypeScript should already enforce this at compile
  time — the runtime test just confirms the created user row has the given
  `fullName` value stored, not null).
- If a route-level test exists for `/auth/register` (check for
  `apps/storefront/src/routes/apiAuth.test.ts` or similar — confirmed absent as
  of plan-writing, but re-check), add a case asserting a missing/blank
  `fullName` returns 400 with `web.register_fullname_invalid`; if no such test
  file exists, do not create one speculatively — state this in your report.

**Verification:** `pnpm --filter @app/storefront-client build`, `pnpm typecheck`,
`pnpm test RegisterPage.test.tsx webauth.test.ts`.

---

## Final Verification (after all tasks, whole-branch review)

```
pnpm --filter @app/web-admin-client build
pnpm --filter @app/storefront-client build
pnpm typecheck
pnpm test
```

Then manual verification per `docs/ui/10_UI_REVIEW_CHECKLIST.md`:
1. `/users` at desktop (≥1024px): KPI row, FilterBar round-trip (including both
   date-range pairs and Sort), "Highest Spender (IDR)" actually reorders rows,
   sticky header, bulk-select → Export CSV downloads with the new columns, every
   row-action item, pagination.
2. Tablet (~768px) and mobile (<768px): `DataTable` card-stack legibility for
   every new column, relative-time + tooltip behavior (verify touch behavior,
   don't assume it matches desktop hover).
3. Row actions "Transactions"/"Support Tickets" land on the correct anchor below
   the detail page's sticky chrome; the new Support Tickets card shows real data.
4. Register a new storefront account — Full Name is required and shows up
   correctly on the resulting Customers row; log in as that customer and browse a
   page, then confirm `lastSeenAt`/"Active Today" updates (respecting the 5-min
   throttle — don't expect it to move on every single click).
5. A customer with only one currency's spend shows a single `CurrencyStack` line,
   not two.
