/**
 * Revenue service — the single place delivered-order revenue, profit, and
 * per-day analytics are computed. Split out of reports.ts (2026-07 financial
 * audit) so every consumer (web-admin dashboard, the Reports page, the bot's
 * /admin and customer dashboards) shares one implementation instead of each
 * re-deriving "line revenue" and drifting apart — see orderItemRevenueIdr
 * below for the bug that split prevents from recurring.
 */
import { OrderStatus } from "@app/core/enums";
import { quantizeMoney } from "@app/core/formatters";
import { Decimal } from "@app/core/money";
import { addDays } from "@app/core/datetime";
import type { Db } from "./_types";

const q4 = (v: Decimal.Value) => quantizeMoney(v, 4);

/**
 * IDR revenue for one delivered OrderItem line: unitPrice × quantity, minus
 * this line's prorated share of the order's `bulkDiscountAmount +
 * discountAmount` (voucher). Order-level discounts live only on the `Order`
 * row and are never applied to `OrderItem.unitPrice`, so without this a
 * discounted order's per-line/per-product profit reported the pre-discount
 * (gross) revenue instead of what the shop actually banked — a healthy
 * margin could show even on an order that genuinely lost money (2026-07
 * backend audit, M-1). The discount is split across lines by each line's
 * share of the order's `subtotalAmount`: `lineDiscount = totalDiscount ×
 * (lineSubtotal / orderSubtotal)`, using `Decimal` throughout (never float
 * division — see the multiply-before-divide order below). `walletUsed` is
 * deliberately excluded: it's a payment method (money the shop already
 * holds), not a discount, so it doesn't reduce banked revenue.
 *
 * `order` is optional so callers that only need gross line revenue (e.g.
 * `topProducts`) can omit it and keep the pre-fix behavior; every caller
 * feeding `profitSummarySince`/`topProductsByMargin` must pass it.
 *
 * `OrderItem.unitPrice` is ALWAYS the catalog's central-IDR
 * `Denomination.price`, written once at order creation (orders.ts
 * `unitPrice()`, used by createOrderFromCart/createOrderDirect) and never
 * rewritten afterward — finalizeOrderPayment (pricing.ts) only updates the
 * Order row's currency/totalAmount/fxRate, never OrderItem.unitPrice. So
 * unlike Order.totalAmount, unitPrice does NOT follow Order.currency and
 * must NEVER be multiplied by fxRate. Every function that derives revenue
 * from OrderItem lines goes through this helper so that rule can't be
 * silently reintroduced in just one of them — which is exactly how a past
 * bug inflated USDT-paid orders' reported revenue by ~fxRate (2026-07
 * financial audit).
 */
function orderItemRevenueIdr(item: {
  unitPrice: Decimal.Value;
  quantity: number;
  order?: {
    subtotalAmount: Decimal.Value;
    bulkDiscountAmount: Decimal.Value;
    discountAmount: Decimal.Value;
  };
}): Decimal {
  const lineGross = new Decimal(item.unitPrice).times(item.quantity);
  if (!item.order) return lineGross;
  const totalDiscount = new Decimal(item.order.bulkDiscountAmount).plus(item.order.discountAmount);
  const orderSubtotal = new Decimal(item.order.subtotalAmount);
  if (totalDiscount.isZero() || orderSubtotal.isZero()) return lineGross;
  // Multiply before dividing so the only division happens once, at the end,
  // against the full-precision numerator — avoids compounding rounding from
  // an intermediate (lineSubtotal / orderSubtotal) ratio.
  const lineDiscount = totalDiscount.times(lineGross).div(orderSubtotal);
  return lineGross.minus(lineDiscount);
}

/** Converts an already-IDR amount into a bucket's own currency: unconverted
 * for IDR, divided by THAT order's own fxRate snapshot for USDT (never a
 * live rate). Used to bring both revenue and cost into the same currency
 * bucket with the identical rule, so they can't drift apart. */
function idrToBucketCurrency(idrAmount: Decimal, isUsdt: boolean, fxRate: Decimal.Value | null): Decimal {
  return isUsdt && fxRate != null ? idrAmount.div(fxRate) : idrAmount;
}

/** Delivered-order totals split per transaction currency (plan.md §15.8 —
 * reports keep currencies apart instead of pretending one unit). Orders
 * predating the currency column count as USDT (their snapshot currency). */
async function deliveredRevenueByCurrency(
  db: Db,
  extraWhere: Record<string, unknown> = {},
): Promise<{ idr: Decimal; usdt: Decimal; orders: number }> {
  const groups = await db.order.groupBy({
    by: ["currency"],
    where: { status: OrderStatus.DELIVERED, ...extraWhere },
    _sum: { totalAmount: true },
    _count: { _all: true },
  });
  let idr = new Decimal(0);
  let usdt = new Decimal(0);
  let orders = 0;
  for (const g of groups) {
    const sum = new Decimal(g._sum.totalAmount ?? 0);
    if (g.currency === "IDR") idr = idr.plus(sum);
    else usdt = usdt.plus(sum);
    orders += g._count._all;
  }
  return { idr, usdt, orders };
}

export async function botOverallStats(db: Db): Promise<{
  items_sold: number;
  revenue_idr: Decimal;
  revenue_usdt: Decimal;
  total_users: number;
}> {
  const itemsAgg = await db.orderItem.aggregate({
    where: { order: { status: OrderStatus.DELIVERED } },
    _sum: { quantity: true },
  });
  const rev = await deliveredRevenueByCurrency(db);
  const totalUsers = await db.user.count();
  return {
    items_sold: itemsAgg._sum.quantity ?? 0,
    revenue_idr: rev.idr,
    revenue_usdt: rev.usdt,
    total_users: totalUsers,
  };
}

export async function revenueSummary(
  db: Db,
  since: Date,
  until: Date = new Date(),
): Promise<{ revenue_idr: Decimal; revenue_usdt: Decimal; orders: number }> {
  const rev = await deliveredRevenueByCurrency(db, { deliveredAt: { gte: since, lte: until } });
  return { revenue_idr: rev.idr, revenue_usdt: rev.usdt, orders: rev.orders };
}

export interface DayRevenue {
  day: string; // YYYY-MM-DD (UTC)
  revenue_idr: string;
  revenue_usdt: string;
  orders: number;
}

/**
 * Daily delivered revenue for the last `days` days, oldest→newest, with empty
 * days filled with zero so the sparkline has no gaps. Buckets by UTC date; the
 * dashboard is single-operator so a TZ-exact daily cut isn't worth a raw query.
 *
 * Split by `currency` (mirrors `deliveredRevenueByCurrency` above) — summing
 * `totalAmount` across orders regardless of currency would add a USDT order's
 * small decimal total straight into the Rupiah figure, the reports-page
 * equivalent of the "Rp3" display bug.
 */
export async function revenueByDay(db: Db, days = 30): Promise<DayRevenue[]> {
  const now = new Date();
  const since = addDays(now, -(days - 1));
  since.setUTCHours(0, 0, 0, 0);

  const orders = await db.order.findMany({
    where: { status: OrderStatus.DELIVERED, deliveredAt: { gte: since } },
    select: { deliveredAt: true, totalAmount: true, currency: true },
  });

  const buckets = new Map<string, { idr: Decimal; usdt: Decimal; orders: number }>();
  for (let i = 0; i < days; i++) {
    const d = addDays(since, i);
    buckets.set(d.toISOString().slice(0, 10), { idr: new Decimal(0), usdt: new Decimal(0), orders: 0 });
  }
  for (const o of orders) {
    if (!o.deliveredAt) continue;
    const key = o.deliveredAt.toISOString().slice(0, 10);
    const b = buckets.get(key);
    if (!b) continue; // outside the window (shouldn't happen)
    if (o.currency === "IDR") b.idr = b.idr.plus(o.totalAmount);
    else b.usdt = b.usdt.plus(o.totalAmount);
    b.orders += 1;
  }
  return [...buckets.entries()].map(([day, b]) => ({
    day,
    revenue_idr: q4(b.idr).toString(),
    revenue_usdt: q4(b.usdt).toString(),
    orders: b.orders,
  }));
}

export interface TopProduct {
  productId: number;
  name: string;
  qty: number;
  revenue: string;
}

/**
 * Best-selling products since `since`, ranked by delivered quantity — the
 * ranking itself is a bounded, indexed `groupBy` (`ix_order_items_product_id`
 * + `ix_orders_status_delivered`, Task 41) instead of pulling every delivered
 * OrderItem row into JS just to bucket-and-sort the top N (M-33, 2026-07
 * backend audit: this used to be an unbounded `findMany` over the entire
 * order-history table on every Reports-page request).
 *
 * `since` is required and positional, matching `revenueSummary` and
 * `profitSummarySince` in this file — every windowed query in this module
 * takes its bound the same way rather than three different conventions.
 *
 * Revenue is GROSS (unit_price × quantity, no order-level discount proration)
 * — deliberately, not a bug. `orderItemRevenueIdr`'s proration (M-1) needs
 * each line's parent `order.subtotalAmount`/`bulkDiscountAmount`/
 * `discountAmount`, which isn't summable through `groupBy`'s `_sum` (it only
 * sums a stored column, never unitPrice×quantity, let alone a
 * discount-prorated variant of it). Ranking is unaffected either way — it
 * was already by quantity sold, not revenue, before this fix — so this stays
 * consistent with the pre-existing "topProducts is gross, topProductsByMargin
 * is net" split documented on orderItemRevenueIdr above. A caller that needs
 * discount-aware profit per product already has `topProductsByMargin`.
 *
 * The revenue figure is filled in with a second query scoped to just the top
 * N product ids (not the whole table), so the "no full-table scan" property
 * holds for both phases.
 */
export async function topProducts(db: Db, since: Date, limit = 10): Promise<TopProduct[]> {
  const grouped = await db.orderItem.groupBy({
    by: ["productId"],
    where: { order: { status: OrderStatus.DELIVERED, deliveredAt: { gte: since } } },
    _sum: { quantity: true },
    // Secondary key on productId gives deterministic tie-breaking — SQLite
    // does not guarantee a stable order for rows tied on _sum.quantity.
    orderBy: [{ _sum: { quantity: "desc" } }, { productId: "asc" }],
    take: limit,
  });
  if (grouped.length === 0) return [];

  const productIds = grouped.map((g) => g.productId);
  const [items, products] = await Promise.all([
    db.orderItem.findMany({
      where: {
        productId: { in: productIds },
        order: { status: OrderStatus.DELIVERED, deliveredAt: { gte: since } },
      },
      select: { productId: true, quantity: true, unitPrice: true },
    }),
    // OrderItem is keyed by denomination (column is `product_id`).
    db.denomination.findMany({ where: { id: { in: productIds } }, select: { id: true, name: true } }),
  ]);
  const nameById = new Map(products.map((p) => [p.id, p.name]));

  const revenueByProduct = new Map<number, Decimal>();
  for (const it of items) {
    revenueByProduct.set(it.productId, (revenueByProduct.get(it.productId) ?? new Decimal(0)).plus(orderItemRevenueIdr(it)));
  }

  return grouped.map((g) => ({
    productId: g.productId,
    name: nameById.get(g.productId) ?? `#${g.productId}`,
    qty: g._sum.quantity ?? 0,
    revenue: q4(revenueByProduct.get(g.productId) ?? new Decimal(0)).toString(),
  }));
}

export interface TopProductMargin {
  productId: number;
  productLabel: string;
  unitsSold: number;
  revenueIdrEquiv: string;
  profitIdrEquiv: string | null;
  costUnknownUnits: number;
}

/**
 * Best-selling products since `since`, ranked by units sold, with revenue and
 * profit in IDR — `OrderItem.unitPrice` and `Denomination.costPrice` are both
 * always catalog-central IDR already (see orderItemRevenueIdr), so neither
 * needs fxRate conversion regardless of the order's settlement currency. Any
 * cost-unknown unit nulls that product's profit (rather than silently
 * treating unknown cost as zero) while still reporting its revenue and the
 * count of affected units. `productLabel` disambiguates denominations that
 * share a duration label across different products (e.g. two unrelated
 * products both selling a "6 Month" plan).
 */
export async function topProductsByMargin(db: Db, since: Date, limit = 5): Promise<TopProductMargin[]> {
  const items = await db.orderItem.findMany({
    where: { order: { status: OrderStatus.DELIVERED, deliveredAt: { gte: since } } },
    select: {
      productId: true,
      quantity: true,
      unitPrice: true,
      product: { select: { name: true, costPrice: true, product: { select: { name: true } } } },
      order: { select: { subtotalAmount: true, bulkDiscountAmount: true, discountAmount: true } },
    },
  });

  const acc = new Map<number, { productLabel: string; units: number; revenue: Decimal; cost: Decimal; costUnknownUnits: number }>();
  for (const item of items) {
    const a = acc.get(item.productId) ?? {
      productLabel: `${item.product.product.name} · ${item.product.name}`,
      units: 0,
      revenue: new Decimal(0),
      cost: new Decimal(0),
      costUnknownUnits: 0,
    };
    a.units += item.quantity;
    a.revenue = a.revenue.plus(orderItemRevenueIdr(item));
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
      productLabel: a.productLabel,
      unitsSold: a.units,
      revenueIdrEquiv: q4(a.revenue).toString(),
      profitIdrEquiv: a.costUnknownUnits > 0 ? null : q4(a.revenue.minus(a.cost)).toString(),
      costUnknownUnits: a.costUnknownUnits,
    }))
    .sort((a, b) => b.unitsSold - a.unitsSold)
    .slice(0, limit);
}

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
 * dashboard exists to fix). Both `OrderItem.unitPrice` and
 * `Denomination.costPrice` are always catalog-central IDR; a USDT-currency
 * line converts BOTH to USDT-equivalent via THAT order's own `fxRate`
 * snapshot (never a live rate) through the shared `idrToBucketCurrency`
 * helper, so revenue and cost can never end up in mismatched units within
 * the same bucket. Items whose Denomination has no costPrice are excluded
 * from both the profit sum and the margin% denominator (counting them at
 * cost=0 would read as a fabricated 100% margin) and counted in
 * `excludedItemCount` instead.
 */
export async function profitSummarySince(db: Db, since: Date): Promise<ProfitSummary> {
  const items = await db.orderItem.findMany({
    where: { order: { status: OrderStatus.DELIVERED, deliveredAt: { gte: since } } },
    select: {
      quantity: true,
      unitPrice: true,
      product: { select: { costPrice: true } },
      order: { select: { currency: true, fxRate: true, subtotalAmount: true, bulkDiscountAmount: true, discountAmount: true } },
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
    const lineRevenueIdr = orderItemRevenueIdr(item);
    const lineCostIdr = new Decimal(item.product.costPrice).times(item.quantity);
    bucket.revenue = bucket.revenue.plus(idrToBucketCurrency(lineRevenueIdr, isUsdt, item.order.fxRate));
    bucket.cost = bucket.cost.plus(idrToBucketCurrency(lineCostIdr, isUsdt, item.order.fxRate));
  }

  const shape = (b: { revenue: Decimal; cost: Decimal; excluded: number }): CurrencyProfit | null => {
    if (b.revenue.isZero() && b.excluded === 0) return null;
    const profit = b.revenue.minus(b.cost);
    const marginPct = b.revenue.isZero() ? null : profit.div(b.revenue).times(100).toDecimalPlaces(2).toString();
    return { netProfit: q4(profit).toString(), marginPct, excludedItemCount: b.excluded };
  };

  return { idr: shape(byCurrency.IDR), usdt: shape(byCurrency.USDT) };
}

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
 * combined total never moves when today's fx rate changes. This operates on
 * `Order.totalAmount` (which genuinely follows `Order.currency`, unlike
 * `OrderItem.unitPrice` — see orderItemRevenueIdr), so multiplying by fxRate
 * here is correct. This is the one place this function intentionally blends
 * currencies — the "Combined" filter the user explicitly opts into, as
 * opposed to revenueByDay's per-currency split.
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
