/**
 * Parity check for the `kind: OrderKind.PRODUCT` sales filter (Financial
 * Ledger M8, commits `3c15ba47` + `997fd500`).
 *
 * Task 6a narrowed thirteen Order-level sales aggregates to product orders
 * only, because a settled `WALLET_TOPUP` reaches `DELIVERED` exactly like a
 * sale and was being counted as revenue. That LOWERED historical revenue,
 * order-count and customer-spend figures for any shop with top-up history.
 * This script exists to prove the change did exactly that and nothing else:
 *
 *   for every affected metric, `pre_fix - post_fix` must equal the settled
 *   WALLET_TOPUP volume in that metric's own window, per currency, EXACTLY —
 *   with no unexplained residual.
 *
 * ## How the pre-fix figure is obtained
 *
 * Reverting the code is not practical, so each metric's OLD `where` clause is
 * replicated inline below — the same clause with `kind` left off, which is
 * precisely what `3c15ba47` added. Every figure in the report is computed from
 * REAL rows by a real query. Nothing is estimated, interpolated, or asserted
 * without computation.
 *
 * ## Why the reconciliation is exact rather than plausible
 *
 * `Order.kind` has exactly two values, so for any additive aggregate:
 *
 *     old(no kind filter) == old(kind=PRODUCT) + old(kind=WALLET_TOPUP)
 *
 * Each metric is therefore evaluated THREE times against its old clause —
 * unfiltered, PRODUCT-only, TOPUP-only — alongside the current function's own
 * answer, and two independent residuals are required to be zero:
 *
 *  - `residual = (preFix - postFix) - topupOnly` — proves the whole delta is
 *    top-up volume and not something else that also moved.
 *  - `drift = productOnly - postFix` — proves the current function really is
 *    the old query PLUS the filter. A metric whose body changed in some other
 *    way fails here even when its delta happens to look right.
 *
 * A non-additive aggregate cannot use that identity, and one metric here is
 * non-additive: `shopFulfilmentStats.customers` is a COUNT(DISTINCT userId), a
 * set union rather than a sum, so a customer with both a sale and a top-up
 * counts once either way. Its attribution is the genuine set difference
 * (customers whose only delivered orders are top-ups), computed as such and
 * labelled as such in the report rather than forced through the sum identity.
 *
 * ## What it refuses to do
 *
 * A window with no settled `WALLET_TOPUP` orders makes every delta trivially
 * zero, so the run would "pass" while proving nothing. That exits non-zero
 * with an explanation unless `--allow-empty` is passed — the same refusal
 * `check-detection-engine-purity.ts` makes for an empty denylist.
 *
 * ## Scope
 *
 * Covered: `revenueSummary`, `grossSalesForNetSales`, `ordersByStatus`,
 * `ordersByStatusSince`, `botOverallStats`, `shopFulfilmentStats`,
 * `revenueByDay`, `ordersByDay`, `combinedRevenueByDay`, `revenueByPeriod` and
 * `ordersByPeriod` at all three granularities, and `userTotalSpent` for every
 * customer who owns a settled top-up.
 *
 * Deliberately not covered, each for a stated reason:
 *
 *  - `totalSpentByUserIds` and `orderStatsByUserIds.deliveredOrders` are
 *    batched forms of `userTotalSpent` over the same rows with the same clause;
 *    `users.test.ts` pins that they carry the filter.
 *  - `customersKpis` adds a non-admin-user restriction to the same
 *    `salesRevenueByCurrency`-shaped query, and two of its four fields are not
 *    order-derived at all (they read `User.createdAt`/`lastSeenAt` against a
 *    Jakarta-local midnight). Its revenue half is the `botOverallStats` row
 *    below with one extra join.
 *  - `rankUserIdsBySpend` is private with no exported entry point, and ranks on
 *    IDR-only spend by deliberate design (see its own doc comment).
 *  - `profitSummarySince`, `profitByDay`/`ByPeriod`, `topProducts`,
 *    `topProductsByMargin` and `botOverallStats.items_sold` are rooted at
 *    `OrderItem` and were never changed, because a top-up order carries zero
 *    item rows. That is a STRUCTURAL claim, not a filter, so it is verified
 *    structurally instead: the report asserts that every settled top-up in
 *    scope really does have no `OrderItem` rows.
 *
 * ## Running it
 *
 *   pnpm run parity-check-kind-filter
 *   pnpm run parity-check-kind-filter -- --since 2026-01-01 --until 2026-09-16
 *   pnpm run parity-check-kind-filter -- --allow-empty
 *
 * Read-only: it issues nothing but `groupBy`/`count`/`findMany`. Exit 0 when
 * every metric reconciles exactly, 1 otherwise.
 *
 * `parity-check-kind-filter.test.ts` runs this same `runParityCheck` against a
 * seeded fixture, so the tool is exercised by the regular suite rather than
 * only by hand — the precedent `revenue.sql-crosscheck.test.ts` sets for a
 * computation cross-checked against an independently derived one.
 */
import { pathToFileURL } from "node:url";
import { OrderKind, OrderStatus } from "@app/core/enums";
import { Decimal } from "@app/core/money";
import { addDays } from "@app/core/datetime";
import {
  botOverallStats,
  combinedRevenueByDay,
  grossSalesForNetSales,
  initDb,
  ordersByDay,
  ordersByPeriod,
  ordersByStatus,
  ordersByStatusSince,
  prisma,
  revenueByDay,
  revenueByPeriod,
  revenueSummary,
  shopFulfilmentStats,
  userTotalSpent,
  type Db,
  type PeriodGranularity,
} from "@app/db";

/** The unit a parity row is measured in. Money rows are per currency; the rest
 *  are plain counts, and `IDR-equivalent` is the one deliberate fx blend. */
export type ParityUnit = "IDR" | "USDT" | "IDR-equivalent" | "orders" | "customers";

export interface ParityRow {
  /** The metric, named as `function.field` so it is greppable. */
  metric: string;
  unit: ParityUnit;
  /** The window this metric's own query uses, in words. */
  window: string;
  /** The old, unfiltered clause's answer — what the dashboard used to show. */
  preFix: string;
  /** The current function's answer — what it shows now. */
  postFix: string;
  /** `preFix - postFix`. */
  delta: string;
  /** The old clause restricted to `WALLET_TOPUP`: what the delta should be. */
  attributed: string;
  /** How `attributed` was derived. Everything is `sum` except the one
   *  non-additive distinct count. */
  attributionBasis: "additive" | "set-difference";
  /** `delta - attributed`. Must be zero. */
  residual: string;
  /** `old(kind=PRODUCT) - postFix`. Must be zero. */
  drift: string;
}

export interface ParityReport {
  window: { since: Date; until: Date };
  /** The settled top-ups in the `[since, until]` window — the volume every
   *  windowed money delta below is attributed to. */
  windowedTopups: { count: number; idr: string; usdt: string };
  /** The settled top-ups over all time — the volume the lifetime metrics are
   *  attributed to. */
  lifetimeTopups: { count: number; idr: string; usdt: string };
  /** Settled top-ups carrying `OrderItem` rows. Must be empty: it is what makes
   *  every `OrderItem`-rooted metric structurally immune rather than untested. */
  topupsWithOrderItems: Array<{ orderId: number; orderCode: string; items: number }>;
  rows: ParityRow[];
  /** Rows with a non-zero `residual` or `drift`. Empty means exact parity. */
  failures: ParityRow[];
  /** True when no settled top-up exists at all, so every delta is trivially
   *  zero and the run demonstrates nothing. */
  inconclusive: boolean;
}

const ZERO = new Decimal(0);
const isZero = (v: Decimal.Value) => new Decimal(v).isZero();

/**
 * The rows that do not reconcile: a non-zero `residual` (the delta is not
 * top-up volume) or a non-zero `drift` (the current function is no longer the
 * old query plus the filter). Exported and pure so the pass/fail rule can be
 * tested directly — neither condition is reachable by seeding data, since
 * producing one means breaking a production function.
 */
export function unreconciledRows(rows: readonly ParityRow[]): ParityRow[] {
  return rows.filter((row) => !isZero(row.residual) || !isZero(row.drift));
}

/** A `kind` clause, or nothing at all — which is exactly what the pre-fix
 *  queries had. `undefined` is the unfiltered (old) shape. */
type KindScope = typeof OrderKind.PRODUCT | typeof OrderKind.WALLET_TOPUP | undefined;
const kindClause = (kind: KindScope) => (kind === undefined ? {} : { kind });

/** Money summed per currency over one old-shaped clause. Non-IDR falls into the
 *  USDT bucket, mirroring `salesRevenueByCurrency`'s own convention. */
async function moneyByCurrency(db: Db, where: Record<string, unknown>) {
  const groups = await db.order.groupBy({
    by: ["currency"],
    where,
    _sum: { totalAmount: true },
    _count: { _all: true },
  });
  let idr = ZERO;
  let usdt = ZERO;
  let orders = 0;
  for (const group of groups) {
    const sum = new Decimal(group._sum.totalAmount ?? 0);
    if (group.currency === "IDR") idr = idr.plus(sum);
    else usdt = usdt.plus(sum);
    orders += group._count._all;
  }
  return { idr, usdt, orders };
}

/** Order counts split by currency over one old-shaped clause — `ordersByDay`'s
 *  and `ordersByPeriod`'s own shape. */
async function countsByCurrency(db: Db, where: Record<string, unknown>) {
  const groups = await db.order.groupBy({ by: ["currency"], where, _count: { _all: true } });
  let idr = 0;
  let usdt = 0;
  for (const group of groups) {
    if (group.currency === "IDR") idr += group._count._all;
    else usdt += group._count._all;
  }
  return { idr, usdt, total: idr + usdt };
}

/**
 * IDR-equivalent money over one old-shaped clause: IDR passes through, USDT
 * converts through THAT order's own `fxRate` snapshot, and an fxRate-less USDT
 * order is counted unconverted. Replicated verbatim from
 * `combinedRevenueByDay`/`revenueByPeriod`, including the unconverted wart —
 * this has to mirror the code under comparison, not improve on it.
 */
async function idrEquivalent(db: Db, where: Record<string, unknown>) {
  const rows = await db.order.findMany({
    where,
    select: { totalAmount: true, currency: true, fxRate: true },
  });
  let total = ZERO;
  for (const row of rows) {
    const amount = new Decimal(row.totalAmount);
    total =
      row.currency === "USDT" && row.fxRate != null
        ? total.plus(amount.times(row.fxRate))
        : total.plus(amount);
  }
  return total;
}

/** Distinct buyers with a delivered order under one old-shaped clause. */
async function distinctBuyers(db: Db, where: Record<string, unknown>): Promise<Set<number>> {
  const groups = await db.order.groupBy({ by: ["userId"], where });
  return new Set(groups.map((group) => group.userId));
}

/** `revenueByDay`/`ordersByDay`/`combinedRevenueByDay`'s own rolling window
 *  start, replicated: the last `days` UTC calendar days including today. */
function dayWindowStart(days: number): Date {
  const since = addDays(new Date(), -(days - 1));
  since.setUTCHours(0, 0, 0, 0);
  return since;
}

/**
 * `revenueByPeriod`/`ordersByPeriod`'s own window start, replicated: the first
 * instant of the oldest of the last `count` UTC calendar periods, INCLUDING the
 * period in progress.
 *
 * Those functions use luxon's `DateTime.utc().startOf(granularity)`, which is
 * not resolvable from this script's own `node_modules` (it is a `packages/db`
 * dependency), so the same three boundaries are computed with plain UTC date
 * arithmetic: luxon's week starts Monday (ISO 8601), which `(getUTCDay() + 6) %
 * 7` reproduces, and its month/year boundaries are the calendar ones.
 *
 * A mismatch here does not pass silently. The `drift` column compares the
 * PRODUCT-filtered replication against the real function's own answer, so a
 * window that is off by a period reports a non-zero drift as long as the
 * database has any order outside the window — which is exactly the shape the
 * test fixture seeds.
 */
function periodWindowStart(granularity: PeriodGranularity, count: number): Date {
  const now = new Date();
  const back = count - 1;
  if (granularity === "year") {
    return new Date(Date.UTC(now.getUTCFullYear() - back, 0, 1));
  }
  if (granularity === "month") {
    // Month underflow is well-defined in Date.UTC: month -1 is December of the
    // previous year, so no year arithmetic is needed here.
    return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - back, 1));
  }
  // Monday-based day-of-week index: Monday 0 ... Sunday 6.
  const mondayOffset = (now.getUTCDay() + 6) % 7;
  return new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - mondayOffset - back * 7),
  );
}

/** The defaults `revenueByPeriod`/`ordersByPeriod` use when the caller is
 *  silent — replicated so the script asks for the same window they do. */
const PERIOD_COUNTS: Record<PeriodGranularity, number> = { week: 12, month: 12, year: 5 };
const GRANULARITIES: PeriodGranularity[] = ["week", "month", "year"];

/** Sums a `*ByDay`/`*ByPeriod` series' buckets back into one figure. The
 *  buckets are 4dp-quantized strings and `Order.totalAmount` is stored at 4dp,
 *  so summing them loses nothing a raw SUM would keep. */
function sumSeries<T>(series: readonly T[], pick: (row: T) => Decimal.Value): Decimal {
  return series.reduce<Decimal>((total, row) => total.plus(pick(row)), ZERO);
}

/**
 * One metric's four readings, turned into a row with both residuals computed.
 *
 * `oldShaped` is called three times with three kind scopes — that is the whole
 * mechanism: the unfiltered call is the pre-fix figure, the WALLET_TOPUP call is
 * what the delta must equal, and the PRODUCT call is what the current function
 * must already agree with.
 */
async function buildRow(args: {
  metric: string;
  unit: ParityUnit;
  window: string;
  postFix: Decimal.Value;
  oldShaped: (kind: KindScope) => Promise<Decimal.Value>;
}): Promise<ParityRow> {
  const preFix = new Decimal(await args.oldShaped(undefined));
  const productOnly = new Decimal(await args.oldShaped(OrderKind.PRODUCT));
  const topupOnly = new Decimal(await args.oldShaped(OrderKind.WALLET_TOPUP));
  const postFix = new Decimal(args.postFix);
  const delta = preFix.minus(postFix);
  return {
    metric: args.metric,
    unit: args.unit,
    window: args.window,
    preFix: preFix.toString(),
    postFix: postFix.toString(),
    delta: delta.toString(),
    attributed: topupOnly.toString(),
    attributionBasis: "additive",
    residual: delta.minus(topupOnly).toString(),
    drift: productOnly.minus(postFix).toString(),
  };
}

/**
 * Compute the whole parity report. Read-only, and takes its `Db` so the same
 * code runs against the dev database from `main()` and against a seeded test
 * schema from the test file.
 */
export async function runParityCheck(
  db: Db,
  opts: { since: Date; until: Date },
): Promise<ParityReport> {
  const { since, until } = opts;
  const rows: ParityRow[] = [];

  const windowLabel = `deliveredAt in [${since.toISOString()}, ${until.toISOString()}]`;
  const createdLabel = `createdAt >= ${since.toISOString()}`;

  // ── The top-up volume every delta below is attributed to ──
  const settledTopup = { status: OrderStatus.DELIVERED, kind: OrderKind.WALLET_TOPUP };
  const windowedTopupTotals = await moneyByCurrency(db, {
    ...settledTopup,
    deliveredAt: { gte: since, lte: until },
  });
  const lifetimeTopupTotals = await moneyByCurrency(db, settledTopup);

  // ── Structural immunity: a settled top-up must carry no OrderItem rows ──
  // Every profit/top-products figure was left unfiltered on exactly this
  // premise, so it is checked rather than assumed.
  const topupsWithItems = await db.order.findMany({
    where: { ...settledTopup, items: { some: {} } },
    select: { id: true, orderCode: true, _count: { select: { items: true } } },
  });
  const topupsWithOrderItems = topupsWithItems.map((order) => ({
    orderId: order.id,
    orderCode: order.orderCode,
    items: order._count.items,
  }));

  // ── 1. revenueSummary — "Revenue Today" / Gross Sales, and its order count ──
  const currentRevenue = await revenueSummary(db, since, until);
  const revenueWhere = (kind: KindScope) => ({
    deliveredAt: { gte: since, lte: until },
    status: OrderStatus.DELIVERED,
    ...kindClause(kind),
  });
  rows.push(
    await buildRow({
      metric: "revenueSummary.revenue_idr",
      unit: "IDR",
      window: windowLabel,
      postFix: currentRevenue.revenue_idr,
      oldShaped: async (kind) => (await moneyByCurrency(db, revenueWhere(kind))).idr,
    }),
    await buildRow({
      metric: "revenueSummary.revenue_usdt",
      unit: "USDT",
      window: windowLabel,
      postFix: currentRevenue.revenue_usdt,
      oldShaped: async (kind) => (await moneyByCurrency(db, revenueWhere(kind))).usdt,
    }),
    await buildRow({
      metric: "revenueSummary.orders",
      unit: "orders",
      window: windowLabel,
      postFix: currentRevenue.orders,
      oldShaped: async (kind) => (await moneyByCurrency(db, revenueWhere(kind))).orders,
    }),
  );

  // ── 2. grossSalesForNetSales — the basis Net Sales subtracts refunds from ──
  // Its status set is wider by exactly REFUNDED, so the replication widens too.
  const currentGross = await grossSalesForNetSales(db, since, until);
  const grossWhere = (kind: KindScope) => ({
    deliveredAt: { gte: since, lte: until },
    status: { in: [OrderStatus.DELIVERED, OrderStatus.REFUNDED] },
    ...kindClause(kind),
  });
  rows.push(
    await buildRow({
      metric: "grossSalesForNetSales.idr",
      unit: "IDR",
      window: windowLabel,
      postFix: currentGross.idr,
      oldShaped: async (kind) => (await moneyByCurrency(db, grossWhere(kind))).idr,
    }),
    await buildRow({
      metric: "grossSalesForNetSales.usdt",
      unit: "USDT",
      window: windowLabel,
      postFix: currentGross.usdt,
      oldShaped: async (kind) => (await moneyByCurrency(db, grossWhere(kind))).usdt,
    }),
  );

  // ── 3. The order funnel, lifetime and windowed ──
  const statusCount = (series: { status: string; count: number }[], status: string) =>
    series.find((row) => row.status === status)?.count ?? 0;
  const statusTotal = (series: { status: string; count: number }[]) =>
    series.reduce((total, row) => total + row.count, 0);

  const lifetimeFunnel = await ordersByStatus(db);
  rows.push(
    await buildRow({
      metric: "ordersByStatus.DELIVERED",
      unit: "orders",
      window: "lifetime",
      postFix: statusCount(lifetimeFunnel, OrderStatus.DELIVERED),
      oldShaped: async (kind) =>
        db.order.count({ where: { status: OrderStatus.DELIVERED, ...kindClause(kind) } }),
    }),
    await buildRow({
      metric: "ordersByStatus.total",
      unit: "orders",
      window: "lifetime",
      postFix: statusTotal(lifetimeFunnel),
      oldShaped: async (kind) => db.order.count({ where: { ...kindClause(kind) } }),
    }),
  );

  const windowedFunnel = await ordersByStatusSince(db, since);
  rows.push(
    await buildRow({
      metric: "ordersByStatusSince.DELIVERED",
      unit: "orders",
      window: createdLabel,
      postFix: statusCount(windowedFunnel, OrderStatus.DELIVERED),
      oldShaped: async (kind) =>
        db.order.count({
          where: { createdAt: { gte: since }, status: OrderStatus.DELIVERED, ...kindClause(kind) },
        }),
    }),
    await buildRow({
      metric: "ordersByStatusSince.total",
      unit: "orders",
      window: createdLabel,
      postFix: statusTotal(windowedFunnel),
      oldShaped: async (kind) =>
        db.order.count({ where: { createdAt: { gte: since }, ...kindClause(kind) } }),
    }),
  );

  // ── 4. botOverallStats — the bot's own customer-facing shop stats ──
  const bot = await botOverallStats(db);
  const lifetimeDelivered = (kind: KindScope) => ({
    status: OrderStatus.DELIVERED,
    ...kindClause(kind),
  });
  rows.push(
    await buildRow({
      metric: "botOverallStats.revenue_idr",
      unit: "IDR",
      window: "lifetime",
      postFix: bot.revenue_idr,
      oldShaped: async (kind) => (await moneyByCurrency(db, lifetimeDelivered(kind))).idr,
    }),
    await buildRow({
      metric: "botOverallStats.revenue_usdt",
      unit: "USDT",
      window: "lifetime",
      postFix: bot.revenue_usdt,
      oldShaped: async (kind) => (await moneyByCurrency(db, lifetimeDelivered(kind))).usdt,
    }),
  );

  // ── 5. shopFulfilmentStats — the storefront home page ──
  const storefront = await shopFulfilmentStats(db);
  rows.push(
    await buildRow({
      metric: "shopFulfilmentStats.deliveredOrders",
      unit: "orders",
      window: "lifetime",
      postFix: storefront.deliveredOrders,
      oldShaped: async (kind) => db.order.count({ where: lifetimeDelivered(kind) }),
    }),
  );
  // `customers` is a COUNT(DISTINCT userId), so the additive identity does not
  // apply: a buyer with both a sale and a top-up is one customer either way.
  // Its attribution is the real set difference — customers whose only delivered
  // orders are top-ups — computed from the two sets rather than assumed.
  const allBuyers = await distinctBuyers(db, lifetimeDelivered(undefined));
  const productBuyers = await distinctBuyers(db, lifetimeDelivered(OrderKind.PRODUCT));
  const topupOnlyBuyers = [...allBuyers].filter((userId) => !productBuyers.has(userId));
  {
    const preFix = new Decimal(allBuyers.size);
    const postFix = new Decimal(storefront.customers);
    const delta = preFix.minus(postFix);
    const attributed = new Decimal(topupOnlyBuyers.length);
    rows.push({
      metric: "shopFulfilmentStats.customers",
      unit: "customers",
      window: "lifetime",
      preFix: preFix.toString(),
      postFix: postFix.toString(),
      delta: delta.toString(),
      attributed: attributed.toString(),
      attributionBasis: "set-difference",
      residual: delta.minus(attributed).toString(),
      drift: new Decimal(productBuyers.size).minus(postFix).toString(),
    });
  }

  // ── 6. The Day series (Sales Analytics, rolling last-N-days) ──
  const DAYS = 30;
  const daySince = dayWindowStart(DAYS);
  const dayLabel = `deliveredAt >= ${daySince.toISOString()} (rolling ${DAYS} UTC days)`;
  const dayWhere = (kind: KindScope) => ({
    status: OrderStatus.DELIVERED,
    deliveredAt: { gte: daySince },
    ...kindClause(kind),
  });
  const dailyRevenue = await revenueByDay(db, DAYS);
  const dailyOrders = await ordersByDay(db, DAYS);
  const dailyCombined = await combinedRevenueByDay(db, DAYS);
  rows.push(
    await buildRow({
      metric: "revenueByDay.revenue_idr (series total)",
      unit: "IDR",
      window: dayLabel,
      postFix: sumSeries(dailyRevenue, (row) => row.revenue_idr),
      oldShaped: async (kind) => (await moneyByCurrency(db, dayWhere(kind))).idr,
    }),
    await buildRow({
      metric: "revenueByDay.revenue_usdt (series total)",
      unit: "USDT",
      window: dayLabel,
      postFix: sumSeries(dailyRevenue, (row) => row.revenue_usdt),
      oldShaped: async (kind) => (await moneyByCurrency(db, dayWhere(kind))).usdt,
    }),
    await buildRow({
      metric: "revenueByDay.orders (series total)",
      unit: "orders",
      window: dayLabel,
      postFix: dailyRevenue.reduce((total, row) => total + row.orders, 0),
      oldShaped: async (kind) => (await moneyByCurrency(db, dayWhere(kind))).orders,
    }),
    await buildRow({
      metric: "ordersByDay.ordersIdr (series total)",
      unit: "orders",
      window: dayLabel,
      postFix: dailyOrders.reduce((total, row) => total + row.ordersIdr, 0),
      oldShaped: async (kind) => (await countsByCurrency(db, dayWhere(kind))).idr,
    }),
    await buildRow({
      metric: "ordersByDay.ordersUsdt (series total)",
      unit: "orders",
      window: dayLabel,
      postFix: dailyOrders.reduce((total, row) => total + row.ordersUsdt, 0),
      oldShaped: async (kind) => (await countsByCurrency(db, dayWhere(kind))).usdt,
    }),
    await buildRow({
      metric: "combinedRevenueByDay.revenueIdrEquiv (series total)",
      unit: "IDR-equivalent",
      window: dayLabel,
      postFix: sumSeries(dailyCombined, (row) => row.revenueIdrEquiv),
      oldShaped: (kind) => idrEquivalent(db, dayWhere(kind)),
    }),
  );

  // ── 7. The calendar-period series (Week / Month / Year) ──
  // These shipped in Task 6c, AFTER the filter existed, so they never had a
  // pre-fix production form. The comparison is the same one regardless — what
  // they would report with the filter off — and it is what proves the new
  // granularities did not reopen the door Task 6a closed.
  for (const granularity of GRANULARITIES) {
    const count = PERIOD_COUNTS[granularity];
    const periodSince = periodWindowStart(granularity, count);
    const label = `deliveredAt >= ${periodSince.toISOString()} (last ${count} UTC ${granularity}s)`;
    const periodWhere = (kind: KindScope) => ({
      status: OrderStatus.DELIVERED,
      deliveredAt: { gte: periodSince },
      ...kindClause(kind),
    });
    const periodRevenue = await revenueByPeriod(db, granularity, count);
    const periodOrders = await ordersByPeriod(db, granularity, count);
    rows.push(
      await buildRow({
        metric: `revenueByPeriod(${granularity}).revenue_idr (series total)`,
        unit: "IDR",
        window: label,
        postFix: sumSeries(periodRevenue, (row) => row.revenue_idr),
        oldShaped: async (kind) => (await moneyByCurrency(db, periodWhere(kind))).idr,
      }),
      await buildRow({
        metric: `revenueByPeriod(${granularity}).revenue_usdt (series total)`,
        unit: "USDT",
        window: label,
        postFix: sumSeries(periodRevenue, (row) => row.revenue_usdt),
        oldShaped: async (kind) => (await moneyByCurrency(db, periodWhere(kind))).usdt,
      }),
      await buildRow({
        metric: `revenueByPeriod(${granularity}).revenueIdrEquiv (series total)`,
        unit: "IDR-equivalent",
        window: label,
        postFix: sumSeries(periodRevenue, (row) => row.revenueIdrEquiv),
        oldShaped: (kind) => idrEquivalent(db, periodWhere(kind)),
      }),
      await buildRow({
        metric: `revenueByPeriod(${granularity}).orders (series total)`,
        unit: "orders",
        window: label,
        postFix: periodRevenue.reduce((total, row) => total + row.orders, 0),
        oldShaped: async (kind) => (await moneyByCurrency(db, periodWhere(kind))).orders,
      }),
      await buildRow({
        metric: `ordersByPeriod(${granularity}).ordersIdr (series total)`,
        unit: "orders",
        window: label,
        postFix: periodOrders.reduce((total, row) => total + row.ordersIdr, 0),
        oldShaped: async (kind) => (await countsByCurrency(db, periodWhere(kind))).idr,
      }),
      await buildRow({
        metric: `ordersByPeriod(${granularity}).ordersUsdt (series total)`,
        unit: "orders",
        window: label,
        postFix: periodOrders.reduce((total, row) => total + row.ordersUsdt, 0),
        oldShaped: async (kind) => (await countsByCurrency(db, periodWhere(kind))).usdt,
      }),
    );
  }

  // ── 8. Customer spend, per customer who owns a settled top-up ──
  // Scoped to those customers on purpose: they are the only ones whose "Total
  // Spent" could have moved, and a shop-wide loop would issue one query per
  // customer for no new information.
  const topupOwners = await db.order.groupBy({ by: ["userId"], where: settledTopup });
  for (const owner of topupOwners) {
    const userId = owner.userId;
    const spent = await userTotalSpent(db, userId);
    const spendWhere = (kind: KindScope) => ({
      userId,
      status: OrderStatus.DELIVERED,
      ...kindClause(kind),
    });
    rows.push(
      await buildRow({
        metric: `userTotalSpent(user ${userId}).idr`,
        unit: "IDR",
        window: "lifetime",
        postFix: spent.idr,
        oldShaped: async (kind) => (await moneyByCurrency(db, spendWhere(kind))).idr,
      }),
      await buildRow({
        metric: `userTotalSpent(user ${userId}).usdt`,
        unit: "USDT",
        window: "lifetime",
        postFix: spent.usdt,
        oldShaped: async (kind) => (await moneyByCurrency(db, spendWhere(kind))).usdt,
      }),
    );
  }

  const failures = unreconciledRows(rows);

  return {
    window: { since, until },
    windowedTopups: {
      count: windowedTopupTotals.orders,
      idr: windowedTopupTotals.idr.toString(),
      usdt: windowedTopupTotals.usdt.toString(),
    },
    lifetimeTopups: {
      count: lifetimeTopupTotals.orders,
      idr: lifetimeTopupTotals.idr.toString(),
      usdt: lifetimeTopupTotals.usdt.toString(),
    },
    topupsWithOrderItems,
    rows,
    failures,
    inconclusive: lifetimeTopupTotals.orders === 0,
  };
}

/** The report as a plain-text table, for a terminal or a pasted audit trail. */
export function formatParityReport(report: ParityReport): string {
  const lines: string[] = [];
  lines.push("kind:PRODUCT sales-filter parity check (Financial Ledger M8)");
  lines.push("");
  lines.push(`Window: ${report.window.since.toISOString()} .. ${report.window.until.toISOString()}`);
  lines.push(
    `Settled WALLET_TOPUP orders in window: ${report.windowedTopups.count} ` +
      `(IDR ${report.windowedTopups.idr}, USDT ${report.windowedTopups.usdt})`,
  );
  lines.push(
    `Settled WALLET_TOPUP orders lifetime:  ${report.lifetimeTopups.count} ` +
      `(IDR ${report.lifetimeTopups.idr}, USDT ${report.lifetimeTopups.usdt})`,
  );
  lines.push("");

  const header = ["metric", "unit", "pre-fix", "post-fix", "delta", "attributed", "residual", "drift"];
  const table = report.rows.map((row) => [
    row.metric,
    row.unit,
    row.preFix,
    row.postFix,
    row.delta,
    row.attributionBasis === "set-difference" ? `${row.attributed} (set diff)` : row.attributed,
    row.residual,
    row.drift,
  ]);
  const widths = header.map((cell, column) =>
    Math.max(cell.length, ...table.map((line) => line[column]!.length)),
  );
  const render = (cells: string[]) =>
    cells.map((cell, column) => cell.padEnd(widths[column]!)).join("  ").trimEnd();
  lines.push(render(header));
  lines.push(widths.map((width) => "-".repeat(width)).join("  "));
  for (const line of table) lines.push(render(line));
  lines.push("");

  if (report.topupsWithOrderItems.length > 0) {
    lines.push(
      "STRUCTURAL CLAIM VIOLATED: a settled WALLET_TOPUP order carries OrderItem rows, " +
        "so the OrderItem-rooted profit/top-products metrics are NOT structurally immune " +
        "to top-ups and genuinely need their own kind filter:",
    );
    for (const order of report.topupsWithOrderItems) {
      lines.push(`  order ${order.orderId} (${order.orderCode}): ${order.items} item row(s)`);
    }
    lines.push("");
  }

  if (report.failures.length > 0) {
    lines.push(`FAILED: ${report.failures.length} metric(s) do not reconcile exactly.`);
    for (const row of report.failures) {
      lines.push(
        `  ${row.metric} [${row.unit}]: residual ${row.residual}, drift ${row.drift} ` +
          `(pre-fix ${row.preFix}, post-fix ${row.postFix}, attributed ${row.attributed})`,
      );
    }
    lines.push("");
    lines.push(
      "A non-zero residual means the delta between the old and new figures is NOT " +
        "explained by wallet top-up volume alone. A non-zero drift means the current " +
        "function is not the old query plus the kind filter — something else in it " +
        "changed. Either way the difference is real and needs explaining, not rounding away.",
    );
  } else if (report.inconclusive) {
    lines.push(
      "INCONCLUSIVE: this database has no settled WALLET_TOPUP order at all, so every " +
        "delta above is trivially zero and the run demonstrates nothing about the fix. " +
        "Point it at data with top-up history, or pass --allow-empty to accept that.",
    );
  } else {
    lines.push(
      `PASSED: all ${report.rows.length} metric(s) reconcile exactly — every pre-fix/post-fix ` +
        "delta equals the settled wallet top-up volume in that metric's own window, per " +
        "currency, with no residual, and every current function still matches its old " +
        "query plus the kind filter.",
    );
  }
  return lines.join("\n");
}

/** `--since`/`--until` as ISO dates (or anything `Date` parses). Defaults to
 *  all of recorded history up to now, so a bare run audits everything. */
function parseArgs(argv: string[]) {
  const value = (flag: string) => {
    const index = argv.indexOf(flag);
    return index >= 0 ? argv[index + 1] : undefined;
  };
  const parse = (raw: string | undefined, fallback: Date, flag: string) => {
    if (raw === undefined) return fallback;
    const parsed = new Date(raw);
    if (Number.isNaN(parsed.getTime())) {
      throw new Error(`${flag} is not a date this script can read: "${raw}"`);
    }
    return parsed;
  };
  return {
    since: parse(value("--since"), new Date(0), "--since"),
    until: parse(value("--until"), new Date(), "--until"),
    allowEmpty: argv.includes("--allow-empty"),
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  await initDb();
  const report = await runParityCheck(prisma, { since: args.since, until: args.until });
  console.log(formatParityReport(report));

  const structurallyBroken = report.topupsWithOrderItems.length > 0;
  const failed =
    report.failures.length > 0 ||
    structurallyBroken ||
    (report.inconclusive && !args.allowEmpty);
  process.exit(failed ? 1 : 0);
}

// Guarded so `main()` only runs when this file is executed directly, not when
// the test file imports `runParityCheck` from it — an unguarded call would open
// a database connection and `process.exit` as a side effect of that import.
// Same guard, same reason, as check-detection-engine-purity.ts.
const isMainModule =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMainModule) {
  main();
}
