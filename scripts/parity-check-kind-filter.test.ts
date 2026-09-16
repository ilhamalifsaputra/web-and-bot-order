/**
 * Tests for `scripts/parity-check-kind-filter.ts` — the tool that proves Task
 * 6a's `kind: OrderKind.PRODUCT` fix changed exactly the wallet-top-up volume
 * and nothing else.
 *
 * A verification tool needs verifying, and this one has a specific failure mode
 * worth defending against: it could pass because everything reconciles, or it
 * could pass because it never actually compared anything. Both look identical
 * from the outside. So every test here is paired —
 *
 *  1. a fixture with REAL top-up history, asserted to reconcile exactly AND to
 *     report non-zero deltas, so a "pass" is evidence the fix works rather than
 *     evidence the script is inert;
 *  2. a deliberately broken world, asserted to FAIL with the right residual, so
 *     the script is known to be able to fail at all.
 *
 * The broken world is built by writing rows the app cannot produce (a settled
 * `WALLET_TOPUP` carrying an `OrderItem`) or by comparing against a
 * hand-computed wrong answer. Neither state is reachable through the app's own
 * API, which is exactly why the script has to be able to detect it.
 *
 * `runParityCheck` is imported rather than the script being shelled out to,
 * for the same reason `check-detection-engine-purity.test.ts` imports
 * `checkFile`: the script guards its own `main()` behind an is-main-module
 * check, so the importable core can be driven against a seeded test schema
 * with no database connection or `process.exit` as a side effect.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { Decimal } from "@app/core/money";
import { OrderKind, OrderStatus } from "@app/core/enums";
import { makeTestDb, type TestDb } from "../tests/helpers/testdb";
import { createCategory, createCatalogProduct, createDenomination } from "@app/db";
import {
  formatParityReport,
  runParityCheck,
  unreconciledRows,
  type ParityReport,
  type ParityRow,
} from "./parity-check-kind-filter";

let db: TestDb;
let prisma: PrismaClient;
let userId: number;
let otherUserId: number;
let denominationId: number;

/**
 * A fixed historical window, deliberately in the past and deliberately closed
 * at both ends: the point of the parity report is that an auditor can re-run it
 * for a named window and get the same numbers, which a window anchored at "now"
 * cannot promise.
 */
const SINCE = new Date("2026-03-01T00:00:00.000Z");
const UNTIL = new Date("2026-03-31T23:59:59.999Z");
const IN_WINDOW = new Date("2026-03-15T09:00:00.000Z");

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

  const buyer = await prisma.user.create({
    data: { telegramId: BigInt(7_000_001), referralCode: `pc${Math.random()}` },
  });
  userId = buyer.id;
  const other = await prisma.user.create({
    data: { telegramId: BigInt(7_000_002), referralCode: `pc${Math.random()}` },
  });
  otherUserId = other.id;

  const category = await createCategory(prisma, `Parity-${Math.random()}`);
  const parent = await createCatalogProduct(prisma, {
    categoryId: category.id,
    name: `Parity Product ${Math.random()}`,
    description: "x",
  });
  const denom = await createDenomination(prisma, {
    productId: parent.id,
    name: "Parity Plan",
    type: "SHARED",
    durationLabel: "1 Month",
    price: "25000",
    costPrice: "10000",
  });
  denominationId = denom.id;
});

// ── Fixture builders ───────────────────────────────────────────────────────

/**
 * A DELIVERED order, written directly. These fixtures deliberately do NOT walk
 * the real settlement path: the script under test reads nothing but `Order`
 * columns, and the shapes that matter here are the ones only a row-level
 * fixture can place precisely — a `deliveredAt` inside a fixed historical
 * window, a REFUNDED sale, a top-up in one currency and a sale in another.
 * `ledger.regression.test.ts` is where the real path is exercised.
 */
async function makeDeliveredOrder(args: {
  kind?: string;
  currency?: string;
  total: string;
  deliveredAt?: Date;
  status?: string;
  fxRate?: string | null;
  owner?: number;
  withItem?: boolean;
}) {
  const at = args.deliveredAt ?? IN_WINDOW;
  const order = await prisma.order.create({
    data: {
      orderCode: `PAR-${Math.random()}`,
      userId: args.owner ?? userId,
      kind: args.kind ?? OrderKind.PRODUCT,
      subtotalAmount: args.total,
      totalAmount: args.total,
      currency: args.currency ?? "IDR",
      fxRate: args.fxRate ?? null,
      status: args.status ?? OrderStatus.DELIVERED,
      createdAt: at,
      paidAt: at,
      deliveredAt: at,
    },
  });
  // A PRODUCT order carries item rows; a WALLET_TOPUP carries none. That
  // asymmetry is what makes every OrderItem-rooted profit metric structurally
  // immune, so the fixture honours it rather than papering over it.
  const withItem = args.withItem ?? (args.kind ?? OrderKind.PRODUCT) === OrderKind.PRODUCT;
  if (withItem) {
    await prisma.orderItem.create({
      data: {
        orderId: order.id,
        productId: denominationId,
        quantity: 1,
        unitPrice: args.total,
        warrantyDaysSnapshot: 30,
      },
    });
  }
  return order;
}

/**
 * The scenario every assertion below is made against: real product sales in
 * both currencies and real settled top-ups in both currencies, inside the fixed
 * window; plus history outside it, a REFUNDED sale, a non-delivered order, and
 * a customer whose ONLY delivered order is a top-up (which is what makes the
 * distinct-customer count non-additive and therefore worth its own attribution).
 *
 * Top-up amounts are deliberately much larger than the sales, so a figure that
 * still counted them is obviously wrong rather than marginally so.
 */
async function seedMixedHistory() {
  // Product sales in the window.
  await makeDeliveredOrder({ total: "25000" });
  await makeDeliveredOrder({ total: "50000" });
  await makeDeliveredOrder({ total: "4", currency: "USDT", fxRate: "16000" });
  // A sale in the window that was later refunded in full — in `revenueSummary`
  // it is gone, in `grossSalesForNetSales` it is still counted, and the script
  // has to replicate each of those status sets separately.
  await makeDeliveredOrder({ total: "30000", status: OrderStatus.REFUNDED });
  // Never settled: in neither figure, and its presence proves the status clause
  // is being replicated rather than ignored.
  await makeDeliveredOrder({ total: "999000", status: OrderStatus.PENDING_PAYMENT });

  // Settled top-ups in the window, both currencies.
  await makeDeliveredOrder({ kind: OrderKind.WALLET_TOPUP, total: "2000000" });
  await makeDeliveredOrder({ kind: OrderKind.WALLET_TOPUP, total: "500000" });
  await makeDeliveredOrder({
    kind: OrderKind.WALLET_TOPUP,
    total: "100",
    currency: "USDT",
    fxRate: "16000",
  });
  // A top-up belonging to a customer who has never bought anything — the
  // set-difference case for `shopFulfilmentStats.customers`.
  await makeDeliveredOrder({
    kind: OrderKind.WALLET_TOPUP,
    total: "750000",
    owner: otherUserId,
  });

  // History outside the fixed window, so the windowed metrics have something
  // they must exclude and the lifetime metrics have something they must include.
  const longAgo = new Date("2025-06-01T00:00:00.000Z");
  await makeDeliveredOrder({ total: "11000", deliveredAt: longAgo });
  await makeDeliveredOrder({ kind: OrderKind.WALLET_TOPUP, total: "900000", deliveredAt: longAgo });
}

// ── Assertion helpers ──────────────────────────────────────────────────────

const row = (report: ParityReport, metric: string): ParityRow => {
  const found = report.rows.find((candidate) => candidate.metric === metric);
  expect(found, `no parity row for "${metric}" — rows: ${report.rows.map((r) => r.metric).join(", ")}`).toBeDefined();
  return found!;
};

const run = () => runParityCheck(prisma, { since: SINCE, until: UNTIL });

// ── 1. The tool reconciles, and is demonstrably not inert ──────────────────

describe("runParityCheck — against real top-up history", () => {
  it("reconciles every metric exactly, with no residual and no drift", async () => {
    await seedMixedHistory();

    const report = await run();

    expect(report.failures).toEqual([]);
    expect(report.inconclusive).toBe(false);
    expect(report.topupsWithOrderItems).toEqual([]);
    // Every row's two residuals are zero. Asserted over all rows rather than a
    // few named ones: the point of the tool is that NOTHING is unexplained.
    for (const parityRow of report.rows) {
      expect(parityRow.residual, `${parityRow.metric} residual`).toBe("0");
      expect(parityRow.drift, `${parityRow.metric} drift`).toBe("0");
    }
    // There is a real report to read, not an empty one.
    expect(report.rows.length).toBeGreaterThan(20);
  });

  it("reconciles the rolling and calendar series too, on data that actually falls in their windows", async () => {
    // `seedMixedHistory` is anchored in a fixed PAST month, which is what makes
    // the windowed-vs-lifetime arithmetic in the other tests checkable by hand —
    // but it also means the rolling 30-day and 12-week windows contain none of
    // it, so those rows reconcile at zero and prove nothing on their own. This
    // case adds today-dated history so every series row has a real figure in it,
    // and asserts that none of them is left vacuous.
    const now = new Date();
    await seedMixedHistory();
    await makeDeliveredOrder({ total: "40000", deliveredAt: now });
    await makeDeliveredOrder({ total: "3", currency: "USDT", fxRate: "16000", deliveredAt: now });
    // A top-up in EACH currency, because the series rows are split per currency:
    // an IDR-only top-up would leave every `*_usdt` row reconciling at zero.
    await makeDeliveredOrder({ kind: OrderKind.WALLET_TOPUP, total: "600000", deliveredAt: now });
    await makeDeliveredOrder({
      kind: OrderKind.WALLET_TOPUP,
      total: "25",
      currency: "USDT",
      fxRate: "15500",
      deliveredAt: now,
    });

    const report = await run();

    expect(report.failures).toEqual([]);
    for (const parityRow of report.rows) {
      expect(parityRow.residual, `${parityRow.metric} residual`).toBe("0");
      expect(parityRow.drift, `${parityRow.metric} drift`).toBe("0");
    }
    // Every rolling/calendar series row moved by a real amount. Without this,
    // the loop above would pass on a report whose series rows were all zeroes.
    const seriesRows = report.rows.filter((parityRow) => parityRow.metric.includes("series total"));
    expect(seriesRows.length).toBeGreaterThan(0);
    for (const parityRow of seriesRows) {
      expect(
        new Decimal(parityRow.delta).isZero(),
        `${parityRow.metric} has a zero delta, so it reconciles vacuously`,
      ).toBe(false);
    }
  });

  it("reports non-zero deltas, so a clean run is evidence and not silence", async () => {
    await seedMixedHistory();

    const report = await run();

    // The whole value of a zero residual is that the delta it explains is real.
    // A script that computed pre-fix == post-fix everywhere would also report
    // zero residuals, and would be worthless.
    const movedMetrics = report.rows.filter((parityRow) => !new Decimal(parityRow.delta).isZero());
    expect(movedMetrics.length).toBeGreaterThan(0);
    // The headline figure moved by exactly the in-window IDR top-up volume.
    const revenueIdr = row(report, "revenueSummary.revenue_idr");
    expect(revenueIdr.delta).toBe(new Decimal("2000000").plus("500000").plus("750000").toString());
    expect(revenueIdr.attributed).toBe(revenueIdr.delta);
    expect(revenueIdr.postFix).toBe(new Decimal("25000").plus("50000").toString());
    // ...and the USDT figure by exactly the USDT top-up, never blended with IDR.
    const revenueUsdt = row(report, "revenueSummary.revenue_usdt");
    expect(revenueUsdt.delta).toBe("100");
    expect(revenueUsdt.postFix).toBe("4");
    // The order count moved by the number of in-window settled top-ups, not by
    // their value.
    const orderCount = row(report, "revenueSummary.orders");
    expect(orderCount.delta).toBe("4");
    expect(orderCount.postFix).toBe("3");
  });

  it("replicates each metric's own status set, not one status set for all of them", async () => {
    await seedMixedHistory();

    const report = await run();

    // `grossSalesForNetSales` counts DELIVERED *and* REFUNDED, `revenueSummary`
    // DELIVERED alone. If the script replicated one clause for both, these two
    // post-fix figures would be equal — and the refunded sale is the whole
    // difference between them.
    const gross = row(report, "grossSalesForNetSales.idr");
    const revenue = row(report, "revenueSummary.revenue_idr");
    expect(new Decimal(gross.postFix).minus(revenue.postFix).toString()).toBe("30000");
    expect(gross.residual).toBe("0");
    expect(gross.drift).toBe("0");
  });

  it("windows each metric the way the metric itself windows, lifetime and bounded apart", async () => {
    await seedMixedHistory();

    const report = await run();

    // The out-of-window sale is in the lifetime figure and not in the windowed
    // one. If both used one window, these would be equal.
    const windowed = row(report, "revenueSummary.revenue_idr");
    const lifetime = row(report, "botOverallStats.revenue_idr");
    expect(new Decimal(lifetime.postFix).minus(windowed.postFix).toString()).toBe("11000");
    // ...and the same separation holds on the pre-fix side, by the out-of-window
    // top-up as well as the out-of-window sale.
    expect(new Decimal(lifetime.preFix).minus(windowed.preFix).toString()).toBe(
      new Decimal("11000").plus("900000").toString(),
    );
    expect(report.windowedTopups.count).toBe(4);
    expect(report.lifetimeTopups.count).toBe(5);
  });

  it("attributes the distinct-customer count by set difference, not by summing", async () => {
    await seedMixedHistory();

    const report = await run();

    const customers = row(report, "shopFulfilmentStats.customers");
    expect(customers.attributionBasis).toBe("set-difference");
    // Two accounts have delivered orders; only one of them ever bought
    // anything. Summing top-up orders instead would have attributed 5, not 1 —
    // which is exactly why this row does not use the additive identity.
    expect(customers.preFix).toBe("2");
    expect(customers.postFix).toBe("1");
    expect(customers.delta).toBe("1");
    expect(customers.attributed).toBe("1");
    expect(customers.residual).toBe("0");
    // The buyer who has BOTH a sale and top-ups is not double-counted: the
    // delivered-order count moved by all five top-ups while the customer count
    // moved by one.
    const deliveredOrders = row(report, "shopFulfilmentStats.deliveredOrders");
    expect(deliveredOrders.delta).toBe("5");
    expect(deliveredOrders.attributionBasis).toBe("additive");
  });

  it("covers the Week, Month and Year granularities, not only the Day series", async () => {
    // Placed today rather than in the fixed historical window, because the
    // calendar-period series anchor their own windows at now — a sale in March
    // would fall outside a 12-week window and the rows would all be zero,
    // proving nothing about those granularities.
    const now = new Date();
    await makeDeliveredOrder({ total: "40000", deliveredAt: now });
    await makeDeliveredOrder({ kind: OrderKind.WALLET_TOPUP, total: "600000", deliveredAt: now });

    const report = await run();

    expect(report.failures).toEqual([]);
    for (const granularity of ["week", "month", "year"] as const) {
      const revenue = row(report, `revenueByPeriod(${granularity}).revenue_idr (series total)`);
      expect(revenue.postFix).toBe("40000");
      expect(revenue.delta).toBe("600000");
      expect(revenue.residual).toBe("0");
      expect(revenue.drift).toBe("0");
      const counts = row(report, `ordersByPeriod(${granularity}).ordersIdr (series total)`);
      expect(counts.postFix).toBe("1");
      expect(counts.delta).toBe("1");
      expect(counts.residual).toBe("0");
    }
    // The Day series sees the same thing, so a granularity that leaked would
    // stand out against its siblings rather than against nothing.
    const daily = row(report, "revenueByDay.revenue_idr (series total)");
    expect(daily.postFix).toBe("40000");
    expect(daily.delta).toBe("600000");
  });

  it("converts the one deliberate fx blend through each order's own snapshot rate", async () => {
    const now = new Date();
    await makeDeliveredOrder({ total: "40000", deliveredAt: now });
    await makeDeliveredOrder({ total: "5", currency: "USDT", fxRate: "16000", deliveredAt: now });
    await makeDeliveredOrder({
      kind: OrderKind.WALLET_TOPUP,
      total: "20",
      currency: "USDT",
      fxRate: "15000",
      deliveredAt: now,
    });

    const report = await run();

    const combined = row(report, "combinedRevenueByDay.revenueIdrEquiv (series total)");
    // Post-fix: the IDR sale plus the USDT sale at ITS OWN rate.
    expect(combined.postFix).toBe(new Decimal("40000").plus(new Decimal("5").times("16000")).toString());
    // The delta is the top-up at ITS OWN rate — a different rate from the sale's,
    // so a script using one shared rate would get this wrong.
    expect(combined.delta).toBe(new Decimal("20").times("15000").toString());
    expect(combined.residual).toBe("0");
    expect(combined.drift).toBe("0");
    expect(report.failures).toEqual([]);
  });
});

// ── 2. The tool can actually fail ──────────────────────────────────────────

describe("runParityCheck — when the world is genuinely broken", () => {
  it("refuses to pass vacuously on a database with no top-up history", async () => {
    // Sales only. Every delta is zero, every residual is zero — and the run
    // proves nothing whatsoever about a fix for top-ups.
    await makeDeliveredOrder({ total: "25000" });

    const report = await run();

    expect(report.failures).toEqual([]);
    expect(report.inconclusive).toBe(true);
    expect(report.lifetimeTopups.count).toBe(0);
    for (const parityRow of report.rows) {
      expect(new Decimal(parityRow.delta).isZero()).toBe(true);
    }
    // The distinction has to reach the reader, not just the return value: this
    // is the difference between "verified" and "nothing to verify".
    expect(formatParityReport(report)).toContain("INCONCLUSIVE");
    expect(formatParityReport(report)).not.toContain("PASSED");
  });

  it("detects a settled top-up carrying OrderItem rows, which breaks the structural-immunity claim", async () => {
    await seedMixedHistory();
    // Every OrderItem-rooted profit/top-products metric was deliberately left
    // unfiltered on the premise that a top-up order has no item rows. Write one
    // that does — unreachable through the app, which is the point — and the
    // premise is false and those metrics genuinely need their own filter.
    const rogue = await makeDeliveredOrder({
      kind: OrderKind.WALLET_TOPUP,
      total: "123456",
      withItem: true,
    });

    const report = await run();

    expect(report.topupsWithOrderItems).toHaveLength(1);
    expect(report.topupsWithOrderItems[0]).toMatchObject({ orderId: rogue.id, items: 1 });
    const text = formatParityReport(report);
    expect(text).toContain("STRUCTURAL CLAIM VIOLATED");
    expect(text).toContain(rogue.orderCode);
    // The kind-filtered money metrics still reconcile — this rogue row is a
    // top-up like any other as far as they are concerned. Reported separately
    // for exactly that reason: it is a different failure, and collapsing it into
    // the residual column would name the wrong problem.
    expect(report.failures).toEqual([]);
  });

  it("reports a non-zero residual when a delta is not top-up volume", async () => {
    await seedMixedHistory();

    // The residual is `(preFix - postFix) - topupOnly`. Make it non-zero the
    // only way a real bug could: leave a DELIVERED order that the old clause
    // counts and the new one does not, whose kind is NEITHER of the two the
    // identity assumes. `Order.kind` is a plain string column, so a value
    // written around the app's enum is exactly the drift a parity check exists
    // to refuse to explain away.
    await prisma.order.create({
      data: {
        orderCode: `PAR-rogue-${Math.random()}`,
        userId,
        kind: "SOMETHING_ELSE",
        subtotalAmount: "70000",
        totalAmount: "70000",
        currency: "IDR",
        status: OrderStatus.DELIVERED,
        createdAt: IN_WINDOW,
        paidAt: IN_WINDOW,
        deliveredAt: IN_WINDOW,
      },
    });

    const report = await run();

    expect(report.failures.length).toBeGreaterThan(0);
    const revenueIdr = row(report, "revenueSummary.revenue_idr");
    // 70,000 of the old figure is explained by neither the product filter nor
    // the top-up volume, and the script says so in that exact amount rather
    // than reporting a vague mismatch.
    expect(revenueIdr.residual).toBe("70000");
    const text = formatParityReport(report);
    expect(text).toContain("FAILED");
    expect(text).toContain("revenueSummary.revenue_idr");
    expect(text).not.toContain("PASSED");
  });

  it("treats drift as a failure in its own right, independently of the residual", async () => {
    // `drift` is `old(kind=PRODUCT) - postFix` — the check that catches a
    // current function that is no longer its old query plus the filter. Unlike
    // a residual, no fixture can produce it: making it non-zero means breaking
    // a production function, not writing an odd row. So the pass/fail rule
    // itself is what gets tested, directly, via the pure `unreconciledRows`.
    const base: ParityRow = {
      metric: "revenueSummary.revenue_idr",
      unit: "IDR",
      window: "lifetime",
      preFix: "100",
      postFix: "60",
      delta: "40",
      attributed: "40",
      attributionBasis: "additive",
      residual: "0",
      drift: "0",
    };
    // Both zero: reconciled.
    expect(unreconciledRows([base])).toEqual([]);
    // A clean residual must NOT excuse drift. This is the case that would slip
    // through a single-residual check, which is why there are two columns.
    const drifted: ParityRow = { ...base, drift: "-5000" };
    expect(unreconciledRows([drifted])).toEqual([drifted]);
    // ...and a clean drift must not excuse a residual either.
    const residual: ParityRow = { ...base, residual: "7" };
    expect(unreconciledRows([residual])).toEqual([residual]);
    // The reader is told which column failed and by how much.
    const text = formatParityReport({
      window: { since: SINCE, until: UNTIL },
      windowedTopups: { count: 1, idr: "40", usdt: "0" },
      lifetimeTopups: { count: 1, idr: "40", usdt: "0" },
      topupsWithOrderItems: [],
      rows: [drifted],
      failures: unreconciledRows([drifted]),
      inconclusive: false,
    });
    expect(text).toContain("FAILED");
    expect(text).toContain("drift -5000");
    expect(text).not.toContain("PASSED");
  });
});
