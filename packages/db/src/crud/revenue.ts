/**
 * Revenue service — the single place delivered-order revenue, profit, and
 * per-day analytics are computed. Split out of reports.ts (2026-07 financial
 * audit) so every consumer (web-admin dashboard, the Reports page, the bot's
 * /admin and customer dashboards) shares one implementation instead of each
 * re-deriving "line revenue" and drifting apart — see orderItemRevenueIdr
 * below for the bug that split prevents from recurring.
 */
import { OrderStatus, OrderKind, RefundExecutionStatus } from "@app/core/enums";
import { quantizeMoney } from "@app/core/formatters";
import { Decimal } from "@app/core/money";
import { config } from "@app/core/config";
import { DateTime, dayKeyInZone, recentDayWindow } from "@app/core/datetime";
import { idChunks } from "./_idChunks";
import type { Db } from "./_types";

const q4 = (v: Decimal.Value) => quantizeMoney(v, 4);

/**
 * Every Order-level aggregate in this module is a SALES figure, so all of them
 * carry this clause (Financial Ledger M6, Task 6a).
 *
 * A `WALLET_TOPUP` order is a real `Order` row that reaches `DELIVERED` with a
 * `deliveredAt` stamped — `settleWalletTopup` (crud/wallet_topup.ts) writes
 * `PENDING_PAYMENT -> DELIVERED` directly — so before this filter existed, a
 * buyer moving their own money into their own wallet was counted as shop
 * revenue on the dashboard, in the Reports page's charts, and in the bot's
 * shop-wide stats. It is not: the money is still the buyer's (it lands in the
 * `wallet_liability.<ccy>` control account, not a revenue account) and it is
 * counted for real when they later spend it on a product order. Counting both
 * double-counts the same rupiah.
 *
 * Hard-coded rather than caller-optional on purpose: a top-up is never
 * revenue, by definition, so there is no legitimate caller of a function named
 * "revenue" that should get top-ups mixed in. Fixing this LOWERS historical
 * revenue/order-count figures for any shop with top-up history — that is the
 * correction, not a regression.
 *
 * The `OrderItem`-rooted functions below (`topProducts`,
 * `topProductsByMargin`, `profitSummarySince`, and `botOverallStats`'
 * `items_sold`) deliberately do NOT repeat it: a top-up order carries zero
 * `OrderItem` rows, so they were already immune.
 */
const ORDER_KIND_SALES_FILTER = { kind: OrderKind.PRODUCT } as const;

/**
 * SHOP_DAY_BUCKETS — every bucketed series in this module (`*ByDay` and
 * `*ByPeriod`) cuts its days, weeks, months and years on the SHOP's calendar
 * (`config.TIMEZONE`), not UTC: `recentDayWindow`/`dayKeyInZone` for the daily
 * series, `SHOP_ZONE` below for the calendar rollups.
 *
 * Bucketing on the UTC date was wrong twice over for a UTC+7 shop. The keys
 * filed 00:00–06:59 local deliveries under the previous day, AND the `since`
 * bound was UTC midnight, so those same orders fell outside the query on the
 * window's first day entirely. It also meant the "Revenue Today" KPI (which
 * has always used `startOfDayUtc`, i.e. shop-local midnight) and the last bar
 * of the chart beside it covered different windows and could legitimately
 * disagree. They now agree.
 *
 * Note for `docs/sales-metrics-contract.md` readers: that document described
 * the previous UTC behaviour and named the shift as a separate, explicitly
 * scoped change. This is that change — the doc is updated with it.
 */
const SHOP_ZONE = () => config.TIMEZONE;

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
 * `order` is optional so a caller that only needs gross line revenue can omit
 * it; every current caller (`topProducts`, `topProductsByMargin`,
 * `profitSummarySince`) passes it, so they all report the same net figure.
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

/**
 * Wallet credit spent on one order, split per currency — the second half of
 * what that sale was worth.
 *
 * Both fields are POSITIVE magnitudes. Non-IDR wallet rows fall into `usdt`,
 * mirroring `salesRevenueByCurrency`'s own two-bucket convention.
 */
export interface WalletSpend {
  idr: Decimal;
  usdt: Decimal;
}

const emptyWalletSpend = (): WalletSpend => ({ idr: new Decimal(0), usdt: new Decimal(0) });

/** The one `WalletTransaction.reason` that means "credit spent buying this
 *  order" — written by the checkout paths in crud/orders.ts and read by
 *  `postOrderPaymentPosting` to decide what revenue to recognise. Spelled once
 *  so this module and the ledger can never read two different reason codes. */
const ORDER_PAYMENT_REASON = "order_payment";

/**
 * Wallet credit spent on each order matching `orderWhere`, per order, per
 * currency (Financial Ledger M8.5 — the F-1 fix).
 *
 * **Why every revenue figure needs this.** `Order.totalAmount` is what the
 * buyer owed EXTERNALLY: the checkout paths write it net of `walletUsed`
 * (`totalAmount = afterDiscount - walletUsed + cents`). Summing it alone
 * therefore reports only the gateway leg of a sale, and an order paid entirely
 * from wallet credit reports as ZERO revenue — while
 * `postOrderPaymentPosting` (crud/ledgerPostings.ts) correctly credits
 * `sales_revenue.<ccy>` with the whole sale, gateway leg AND wallet leg. The
 * credit was already recorded as a LIABILITY when the buyer funded the wallet;
 * spending it on a product is the moment that money becomes the shop's, which
 * is exactly why the top-up itself is not revenue (`ORDER_KIND_SALES_FILTER`)
 * and this is.
 *
 * Grouped by the `WalletTransaction` row's OWN currency, never `Order.walletUsed`
 * (a bare number whose currency depends on which checkout path spent it) and
 * never `Order.currency` — an IDR leg on a USDT-settled order is a real shape
 * (`createOrder*` debits IDR credit BEFORE the IDR→USDT conversion, while
 * `applyUsdtWalletToOrder` debits USDT credit after it), and the ledger books
 * each leg to its own currency's revenue account. See `postOrderPaymentPosting`
 * and `reconcileFinances` for the same reasoning stated at their own call
 * sites.
 *
 * Only `order_payment` rows count. An `order_refund` release is a separate
 * event with its own posting, so netting it in here would quietly turn a refund
 * into a discount on the original sale — the same rule the ledger applies.
 *
 * A currency group that nets to zero or less is skipped rather than subtracted,
 * mirroring `postOrderPaymentPosting`'s own "not a payment, nothing to post"
 * branch exactly. (Unreachable through the app — `order_payment` rows are only
 * ever debits — but the two must agree in the cases the app cannot produce too,
 * or the dashboard and the books would disagree precisely where someone is
 * investigating why.)
 *
 * **Two query shapes, and why the caller picks.** The `WalletTransaction` table
 * has no Prisma relation to `Order` (the column is a bare `order_id` with no FK
 * — see schema.prisma), so the order set can never be expressed as a relation
 * filter; one side or the other has to be listed out by id.
 *
 *   - **`boundOrderIds` given** (the window-scoped callers — `revenueByDay`,
 *     `combinedRevenueByDay`, `revenueByPeriod`): the caller has ALREADY read
 *     the exact orders in its window, so it hands over that id list and the
 *     wallet rows are fetched for those ids alone. Every id in it satisfies
 *     `orderWhere` by construction — the caller derived the list from that very
 *     clause — so no second "which of these qualify" order lookup is needed,
 *     and the read is bounded by the window rather than by all of history.
 *   - **`boundOrderIds` omitted** (the lifetime callers, which have no window to
 *     bound anything by): fall back to reading every `order_payment` leg first
 *     and then asking which of THOSE orders match `orderWhere`. Wallet-first
 *     because the wallet-paid set is the smaller of the two — but it is still a
 *     lifetime-wide read of a table with no index on `reason`. That remains a
 *     known, accepted scaling ceiling, recorded in
 *     docs/sales-metrics-contract.md's open items alongside the other lifetime
 *     reads.
 *
 * BOTH shapes chunk their `IN (...)` list (`idChunks`, `_idChunks.ts`). Neither
 * list is bounded by anything this code chose — one is "every order in the
 * caller's window", the other "every wallet-paid order ever" — so a year view
 * over a busy shop, or a lifetime total, would otherwise blow past Postgres's
 * 65535 bind-parameter ceiling and fail the whole read with a protocol error
 * rather than merely being slow. Chunking is exactly result-preserving here:
 * `foldWalletGroups` nets per (order, currency) and every row of a given order
 * carries that order's id, so no group can straddle two chunks.
 *
 * Callers on either path pass the SAME `where` object their own order query
 * uses, so the two halves of a figure can never scope differently.
 */
async function walletSpendLegs(
  db: Db,
  orderWhere: Record<string, unknown>,
  boundOrderIds?: readonly number[],
): Promise<Array<{ orderId: number; userId: number; spend: WalletSpend }>> {
  if (boundOrderIds !== undefined) {
    if (boundOrderIds.length === 0) return [];
    // Chunked, not one `IN (...)` over the whole window: `boundOrderIds` is
    // every order in the caller's window, so a year view over a busy shop can
    // exceed Postgres's 65535 bind-parameter ceiling and fail the whole
    // dashboard read with a protocol error. See `_idChunks.ts` for why chunking
    // is result-preserving here — `foldWalletGroups` nets per (order, currency)
    // group and a given order's rows all carry that order's id, so no group can
    // straddle two chunks.
    // Assigned to a local rather than passed inline: Prisma's `groupBy` infers
    // its result shape from the contextual type, and feeding it straight into a
    // parameter position makes it try to satisfy that parameter instead.
    const bounded: WalletLegGroup[] = [];
    for (const chunk of idChunks(boundOrderIds)) {
      const page = await db.walletTransaction.groupBy({
        by: ["orderId", "userId", "currency"],
        where: { reason: ORDER_PAYMENT_REASON, orderId: { in: chunk } },
        _sum: { delta: true },
      });
      bounded.push(...page);
    }
    return foldWalletGroups(bounded, null);
  }

  const groups = await db.walletTransaction.groupBy({
    by: ["orderId", "userId", "currency"],
    where: { reason: ORDER_PAYMENT_REASON, orderId: { not: null } },
    _sum: { delta: true },
  });
  if (groups.length === 0) return [];

  // Same ceiling on the other side of the fallback path: this list is every
  // wallet-paid order in the shop's whole history, which is the larger of the
  // two id lists this function can build.
  const candidateIds = [...new Set(groups.map((g) => g.orderId!))];
  const qualifying = new Set<number>();
  for (const chunk of idChunks(candidateIds)) {
    for (const order of await db.order.findMany({
      where: { ...orderWhere, id: { in: chunk } },
      select: { id: true },
    })) {
      qualifying.add(order.id);
    }
  }
  return foldWalletGroups(groups, qualifying);
}

/** One `groupBy` row `walletSpendLegs` folds — named so the chunked accumulator
 *  above has a type to collect into. */
interface WalletLegGroup {
  orderId: number | null;
  userId: number;
  currency: string;
  _sum: { delta: unknown };
}

/** The arithmetic both `walletSpendLegs` query shapes share: net each
 *  (order, currency) group and split it into the two-bucket `WalletSpend`.
 *  `qualifying` is the set of order ids that matched the caller's clause, or
 *  `null` when the query was already restricted to qualifying ids and every row
 *  read is therefore in scope by construction. */
function foldWalletGroups(
  groups: ReadonlyArray<WalletLegGroup>,
  qualifying: ReadonlySet<number> | null,
): Array<{ orderId: number; userId: number; spend: WalletSpend }> {
  const byOrder = new Map<number, { orderId: number; userId: number; spend: WalletSpend }>();
  for (const group of groups) {
    const orderId = group.orderId;
    if (orderId == null || (qualifying !== null && !qualifying.has(orderId))) continue;
    // Wallet debits are stored negative; the amount spent is their magnitude.
    const spent = new Decimal((group._sum.delta as Decimal.Value | null) ?? 0).negated();
    if (!spent.greaterThan(0)) continue;
    const row = byOrder.get(orderId) ?? { orderId, userId: group.userId, spend: emptyWalletSpend() };
    if (group.currency === "IDR") row.spend.idr = row.spend.idr.plus(spent);
    else row.spend.usdt = row.spend.usdt.plus(spent);
    byOrder.set(orderId, row);
  }
  return [...byOrder.values()];
}

/** Total wallet credit spent across every order matching `orderWhere`, per
 *  currency — the figure an unbucketed revenue/spend total adds to its
 *  `Order.totalAmount` sum. See `walletSpendLegs` for what counts and why, and
 *  for what `boundOrderIds` does to the query shape. */
export async function walletSpendByCurrency(
  db: Db,
  orderWhere: Record<string, unknown>,
  boundOrderIds?: readonly number[],
): Promise<WalletSpend> {
  const total = emptyWalletSpend();
  for (const leg of await walletSpendLegs(db, orderWhere, boundOrderIds)) {
    total.idr = total.idr.plus(leg.spend.idr);
    total.usdt = total.usdt.plus(leg.spend.usdt);
  }
  return total;
}

/**
 * The same wallet spend, keyed by order id — what a day/period-bucketed series
 * needs. A wallet leg has no `deliveredAt` of its own (its `createdAt` is the
 * CHECKOUT instant, which can fall days before delivery), so it belongs in the
 * bucket of the ORDER it paid for. Keying by order id lets each caller reuse
 * the `deliveredAt` it has already read for that order rather than inventing a
 * second, weaker rule.
 *
 * Every caller of this view is window-bounded and has that order list in hand
 * already, so all three pass it as `boundOrderIds` — see `walletSpendLegs`.
 */
export async function walletSpendByOrder(
  db: Db,
  orderWhere: Record<string, unknown>,
  boundOrderIds?: readonly number[],
): Promise<Map<number, WalletSpend>> {
  const byOrder = new Map<number, WalletSpend>();
  for (const leg of await walletSpendLegs(db, orderWhere, boundOrderIds)) byOrder.set(leg.orderId, leg.spend);
  return byOrder;
}

/** The same wallet spend, accumulated per buyer — for the customer-spend
 *  figures in crud/users.ts, which ask the same question one row per customer.
 *  The wallet row's `userId` is the buyer's own (a buyer only ever spends their
 *  own credit), so no join back to the order is needed to attribute it. */
export async function walletSpendByUser(
  db: Db,
  orderWhere: Record<string, unknown>,
  boundOrderIds?: readonly number[],
): Promise<Map<number, WalletSpend>> {
  const byUser = new Map<number, WalletSpend>();
  for (const leg of await walletSpendLegs(db, orderWhere, boundOrderIds)) {
    const acc = byUser.get(leg.userId) ?? emptyWalletSpend();
    acc.idr = acc.idr.plus(leg.spend.idr);
    acc.usdt = acc.usdt.plus(leg.spend.usdt);
    byUser.set(leg.userId, acc);
  }
  return byUser;
}

/** Sold-order totals split per transaction currency (plan.md §15.8 — reports
 * keep currencies apart instead of pretending one unit). Orders predating the
 * currency column count as USDT (their snapshot currency).
 *
 * `status`/`kind` are spread AFTER `extraWhere` on purpose: they are this
 * helper's own invariants, and a caller must not be able to widen "sold
 * product revenue" into something else by passing its own `status`/`kind` key
 * (see ORDER_KIND_SALES_FILTER above for why the kind half matters).
 *
 * `statuses` is a separate, explicit parameter for the same reason — the one
 * caller that needs a wider set (`grossSalesForNetSales`, which must keep a
 * sale that was later refunded) has to say so in its own argument list, where
 * it is reviewable, instead of smuggling a `status` key through `extraWhere`.
 * It defaults to DELIVERED alone, so every other caller is delivered-only
 * exactly as before.
 *
 * The wallet leg is ADDED to the `totalAmount` sum, never substituted for it
 * (Financial Ledger M8.5) — the two are the two halves of one sale. It is read
 * over the identical `where` clause, so no order can be in one half and not the
 * other. `orders` is untouched: a wallet-paid order is one sale, already
 * counted by the groupBy. */
async function salesRevenueByCurrency(
  db: Db,
  extraWhere: Record<string, unknown> = {},
  statuses: readonly OrderStatus[] = [OrderStatus.DELIVERED],
): Promise<{ idr: Decimal; usdt: Decimal; orders: number }> {
  const where = { ...extraWhere, status: { in: [...statuses] }, ...ORDER_KIND_SALES_FILTER };
  const groups = await db.order.groupBy({
    by: ["currency"],
    where,
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
  const walletSpend = await walletSpendByCurrency(db, where);
  return { idr: idr.plus(walletSpend.idr), usdt: usdt.plus(walletSpend.usdt), orders };
}

/**
 * Shop-wide lifetime stats shown on the bot's own customer dashboard
 * ("X items sold · Rp Y total revenue · Z users").
 *
 * `revenue_idr`/`revenue_usdt` are product-sales-only via
 * `salesRevenueByCurrency` (see `ORDER_KIND_SALES_FILTER`) — this is a
 * "total revenue" figure shown to buyers, so a top-up must not inflate it.
 * `items_sold` needs no filter (it aggregates `OrderItem.quantity`, and a
 * top-up order has no items) and `total_users` is not order-derived at all.
 */
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
  const rev = await salesRevenueByCurrency(db);
  const totalUsers = await db.user.count();
  return {
    items_sold: itemsAgg._sum.quantity ?? 0,
    revenue_idr: rev.idr,
    revenue_usdt: rev.usdt,
    total_users: totalUsers,
  };
}

/**
 * Delivered product-sales revenue in the window `[since, until]`, split per
 * currency, plus the order count behind it — the dashboard's "Revenue
 * Today"/"Revenue Yesterday" cards and the Orders page's "Revenue Today" KPI.
 * Excludes wallet top-ups via `salesRevenueByCurrency` (see
 * `ORDER_KIND_SALES_FILTER`), so `orders` here is a count of SALES, not of all
 * delivered order rows.
 */
export async function revenueSummary(
  db: Db,
  since: Date,
  until: Date = new Date(),
): Promise<{ revenue_idr: Decimal; revenue_usdt: Decimal; orders: number }> {
  const rev = await salesRevenueByCurrency(db, { deliveredAt: { gte: since, lte: until } });
  return { revenue_idr: rev.idr, revenue_usdt: rev.usdt, orders: rev.orders };
}

/**
 * Gross product sales in the window `[since, until]`, split per currency, for
 * the ONE purpose of being the figure the day's refund payouts are subtracted
 * from — the dashboard's "Net Sales Today" card (Financial Ledger M6, Task 6b).
 * Nothing else should read this: "Revenue Today", the Reports page and the
 * bot's stats all stay on `revenueSummary` above, which is deliberately
 * unchanged.
 *
 * The only difference from `revenueSummary` is the status set: DELIVERED **and
 * REFUNDED**, where `revenueSummary` is DELIVERED alone. `executeRefund`
 * (crud/refunds.ts) closes a fully-refunded DELIVERED order by moving it to
 * REFUNDED, so a sale that is refunded in full on the same day it was sold
 * disappears from a DELIVERED-only gross figure. Subtracting the payout from
 * that figure charges the same refund twice: an order sold for Rp10,000 today
 * and paid back in full today reported Net Sales of **-Rp10,000**, a number
 * that never happened. Counting the refunded sale in gross makes the same day
 * net to Rp0 — as much was sold as was handed back, which is the honest answer.
 *
 * This does NOT restore a "Revenue Today = Net Sales + Refunds Today" identity,
 * and is not meant to: that identity only ever held as an artifact of the
 * double-counting itself. Gross and Net are supposed to be two different
 * numbers. A PARTIAL same-day refund leaves the order DELIVERED (no legal
 * PARTIALLY_DELIVERED/DELIVERED -> REFUNDED edge fires for it — see
 * orderStatus.ts), so both figures count that sale once and the two differ by
 * exactly the payout; a FULL one moves it to REFUNDED, and this function keeps
 * counting it so the subtraction still happens exactly once.
 *
 * REFUNDED is the only status added. `PARTIALLY_DELIVERED` is deliberately NOT
 * included: it is not a "sold then refunded" state, and a partial refund never
 * moves an order into it. Wallet top-ups stay excluded (`kind: PRODUCT`, via
 * `salesRevenueByCurrency`) exactly as everywhere else — widening the status
 * filter must not quietly reopen that door. No order count is returned: the
 * "orders" KPI is a sales-funnel figure with its own source, and a refunded
 * order does not belong in it.
 */
export async function grossSalesForNetSales(
  db: Db,
  since: Date,
  until: Date = new Date(),
): Promise<{ idr: Decimal; usdt: Decimal }> {
  const rev = await salesRevenueByCurrency(
    db,
    // Same `deliveredAt` window as `revenueSummary`: a refunded order keeps the
    // `deliveredAt` it was sold at (transitionOrderStatus writes only `status`),
    // so it still falls on the day the sale actually happened.
    { deliveredAt: { gte: since, lte: until } },
    [OrderStatus.DELIVERED, OrderStatus.REFUNDED],
  );
  return { idr: rev.idr, usdt: rev.usdt };
}

export interface DayRevenue {
  day: string; // YYYY-MM-DD in the shop's timezone — see SHOP_DAY_BUCKETS
  revenue_idr: string;
  revenue_usdt: string;
  orders: number;
}

/**
 * Daily delivered revenue for the last `days` days, oldest→newest, with empty
 * days filled with zero so the sparkline has no gaps. Days are the shop's own
 * calendar days — see SHOP_DAY_BUCKETS above.
 *
 * Split by `currency` (mirrors `salesRevenueByCurrency` above) — summing
 * `totalAmount` across orders regardless of currency would add a USDT order's
 * small decimal total straight into the Rupiah figure, the reports-page
 * equivalent of the "Rp3" display bug.
 */
export async function revenueByDay(db: Db, days = 30): Promise<DayRevenue[]> {
  const { since, keys } = recentDayWindow(days);

  const where = { status: OrderStatus.DELIVERED, ...ORDER_KIND_SALES_FILTER, deliveredAt: { gte: since } };
  const orders = await db.order.findMany({
    where,
    select: { id: true, deliveredAt: true, totalAmount: true, currency: true },
  });
  // Each order's wallet leg, added to ITS OWN order's day — a wallet row's
  // `createdAt` is the checkout instant and can fall days before delivery, so
  // bucketing on it would misattribute the credit (M8.5). Scoped to the ids
  // just read: this window's orders are the only ones any bucket can hold, so
  // there is nothing to gain from reading the rest of history's wallet legs.
  const walletSpend = await walletSpendByOrder(db, where, orders.map((o) => o.id));

  const buckets = new Map<string, { idr: Decimal; usdt: Decimal; orders: number }>();
  for (const key of keys) buckets.set(key, { idr: new Decimal(0), usdt: new Decimal(0), orders: 0 });
  for (const o of orders) {
    if (!o.deliveredAt) continue;
    const b = buckets.get(dayKeyInZone(o.deliveredAt));
    if (!b) continue; // outside the window (shouldn't happen)
    if (o.currency === "IDR") b.idr = b.idr.plus(o.totalAmount);
    else b.usdt = b.usdt.plus(o.totalAmount);
    const wallet = walletSpend.get(o.id);
    if (wallet) {
      b.idr = b.idr.plus(wallet.idr);
      b.usdt = b.usdt.plus(wallet.usdt);
    }
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
 * Revenue is NET of order-level discounts (`orderItemRevenueIdr` fed with the
 * parent order's discount columns), the same basis as `topProductsByMargin`,
 * so the Reports page's Top Products table and the dashboard's Top Products
 * list report the same revenue for the same product. They disagreed before:
 * this function reported the pre-discount figure under the same column name.
 * The discount can't be summed through `groupBy`'s `_sum` (which only sums a
 * stored column, never unitPrice×quantity, let alone a prorated variant), so
 * the ranking stays a `groupBy` by quantity and only the revenue is filled in
 * from the second query below.
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
      select: {
        productId: true,
        quantity: true,
        unitPrice: true,
        order: { select: { subtotalAmount: true, bulkDiscountAmount: true, discountAmount: true } },
      },
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
 * Sales Analytics chart's "Orders" metric. Empty days are filled with zero,
 * and days are the shop's own calendar days (see SHOP_DAY_BUCKETS). */
export async function ordersByDay(db: Db, days = 30): Promise<DayOrderCounts[]> {
  const { since, keys } = recentDayWindow(days);

  const orders = await db.order.findMany({
    where: { status: OrderStatus.DELIVERED, ...ORDER_KIND_SALES_FILTER, deliveredAt: { gte: since } },
    select: { deliveredAt: true, currency: true },
  });

  const buckets = new Map<string, { idr: number; usdt: number }>();
  for (const key of keys) buckets.set(key, { idr: 0, usdt: 0 });
  for (const o of orders) {
    if (!o.deliveredAt) continue;
    const b = buckets.get(dayKeyInZone(o.deliveredAt));
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
 * opposed to revenueByDay's per-currency split. Days are the shop's own
 * calendar days (see SHOP_DAY_BUCKETS).
 */
export async function combinedRevenueByDay(db: Db, days = 30): Promise<DayCombinedRevenue[]> {
  const { since, keys } = recentDayWindow(days);

  const where = { status: OrderStatus.DELIVERED, ...ORDER_KIND_SALES_FILTER, deliveredAt: { gte: since } };
  const orders = await db.order.findMany({
    where,
    select: { id: true, deliveredAt: true, totalAmount: true, currency: true, fxRate: true },
  });
  // Bounded to the window's own orders — see revenueByDay for why.
  const walletSpend = await walletSpendByOrder(db, where, orders.map((o) => o.id));

  const buckets = new Map<string, Decimal>();
  for (const key of keys) buckets.set(key, new Decimal(0));
  for (const o of orders) {
    if (!o.deliveredAt) continue;
    const key = dayKeyInZone(o.deliveredAt);
    const current = buckets.get(key);
    if (!current) continue;
    const idrEquiv = o.currency === "USDT" && o.fxRate != null
      ? new Decimal(o.totalAmount).times(o.fxRate)
      : new Decimal(o.totalAmount);
    // The wallet leg blends by ITS OWN currency, not the order's: an IDR leg on
    // a USDT order passes through unconverted, a USDT leg converts through that
    // order's own fxRate snapshot — and an fxRate-less USDT leg is counted
    // unconverted, the same pre-existing wart the gateway leg above carries, so
    // the two halves of one sale can never be blended by two different rules.
    // The conversion condition is the gateway leg's verbatim, `o.currency ===
    // "USDT"` half included: today only a USDT order is ever stamped with an
    // fxRate (`finalizeOrderPayment`, crud/pricing.ts), so the two agree — but
    // testing `o.fxRate != null` alone would make that sentence above a promise
    // the code no longer keeps the day anything stamps an fxRate on an IDR
    // order, and would multiply this leg into the Rupiah blend by that rate.
    const wallet = walletSpend.get(o.id);
    const walletIdrEquiv = wallet
      ? wallet.idr.plus(
          o.currency === "USDT" && o.fxRate != null ? wallet.usdt.times(o.fxRate) : wallet.usdt,
        )
      : new Decimal(0);
    buckets.set(key, current.plus(idrEquiv).plus(walletIdrEquiv));
  }
  return [...buckets.entries()].map(([day, total]) => ({ day, revenueIdrEquiv: q4(total).toString() }));
}

/**
 * Refunds actually PAID OUT in the window `[since, until]`, split per currency
 * (Financial Ledger M6, Task 6b) — the figure behind the dashboard's "Refunds
 * Today" card, and the amount "Net Sales Today" subtracts from gross revenue.
 *
 * Reads `RefundExecution.amount`, never `Refund.amount`: the Refund row is the
 * REQUEST ("this buyer is owed 50,000"), while a RefundExecution is one real
 * payout, and the two genuinely differ — a refund may be settled across several
 * attempts, and a request can sit forever without any payout at all. Only money
 * that left the shop reduces what a customer effectively spent.
 *
 * `status: COMPLETED` only, for the same reason: a FAILED attempt is a transfer
 * that bounced and a PENDING one has not happened, so counting either would
 * subtract revenue that was never given back.
 *
 * Buckets on `executedAt` (the payout's own wall-clock instant, stamped by
 * `executeRefund`) rather than `createdAt` — a refund recorded at one moment and
 * paid at another belongs to the day the money moved, which is the day the
 * dashboard's own revenue figures are keyed on too.
 *
 * Grouped by `RefundExecution.currency` directly, with no join to the Order:
 * `executeRefund` snapshots that column from the `Refund`, which `createRefund`
 * pins to the order's own currency, and it re-checks the two agree before paying
 * anything out. Non-IDR falls into the USDT bucket, mirroring
 * `salesRevenueByCurrency`'s own convention above — those are the only two
 * currencies an Order (and therefore a Refund, and therefore a payout) can carry.
 */
export async function refundTotalsSince(
  db: Db,
  since: Date,
  until: Date = new Date(),
): Promise<{ refunds_idr: Decimal; refunds_usdt: Decimal }> {
  const groups = await db.refundExecution.groupBy({
    by: ["currency"],
    where: { status: RefundExecutionStatus.COMPLETED, executedAt: { gte: since, lte: until } },
    _sum: { amount: true },
  });
  let idr = new Decimal(0);
  let usdt = new Decimal(0);
  for (const g of groups) {
    const sum = new Decimal(g._sum.amount ?? 0);
    if (g.currency === "IDR") idr = idr.plus(sum);
    else usdt = usdt.plus(sum);
  }
  return { refunds_idr: idr, refunds_usdt: usdt };
}

export interface DayRefunds {
  day: string; // YYYY-MM-DD in the shop's timezone — see SHOP_DAY_BUCKETS
  refunds_idr: string;
  refunds_usdt: string;
}

/**
 * Daily refund payouts for the last `days` days, oldest→newest, with empty days
 * filled with zero — the refund counterpart to `revenueByDay`, and deliberately
 * the same shape so a chart can line the two series up day-for-day without
 * re-aligning anything. Same shop-calendar day bucketing (see
 * SHOP_DAY_BUCKETS), same per-currency split (a USDT payout's small decimal
 * must never land in the Rupiah figure), same 4dp-quantized string output.
 *
 * See `refundTotalsSince` above for why this reads COMPLETED
 * `RefundExecution.amount` bucketed on `executedAt`, and not `Refund.amount` or
 * `createdAt`.
 *
 * NO PRODUCTION CALLER TODAY — this is exported and covered by tests, but no
 * route, job, bot handler or admin page reads it yet. It was built alongside
 * `refundTotalsSince` (which the Net Sales KPI does use) so the daily series
 * exists the moment a refunds chart is added, and its shape is pinned to
 * `revenueByDay`'s for exactly that. Recorded here rather than left to be
 * rediscovered: a reader tracing "where does the dashboard get its refund
 * series" should not have to grep to learn the answer is "nowhere yet".
 */
export async function refundsByDay(db: Db, days = 30): Promise<DayRefunds[]> {
  const { since, keys } = recentDayWindow(days);

  const executions = await db.refundExecution.findMany({
    where: { status: RefundExecutionStatus.COMPLETED, executedAt: { gte: since } },
    select: { executedAt: true, amount: true, currency: true },
  });

  const buckets = new Map<string, { idr: Decimal; usdt: Decimal }>();
  for (const key of keys) buckets.set(key, { idr: new Decimal(0), usdt: new Decimal(0) });
  for (const e of executions) {
    // Nullable in the schema (it is only stamped once an attempt reaches a
    // terminal status), so a row with no payout time has no day to belong to.
    if (!e.executedAt) continue;
    const b = buckets.get(dayKeyInZone(e.executedAt));
    if (!b) continue; // outside the window (shouldn't happen)
    if (e.currency === "IDR") b.idr = b.idr.plus(e.amount);
    else b.usdt = b.usdt.plus(e.amount);
  }
  return [...buckets.entries()].map(([day, b]) => ({
    day,
    refunds_idr: q4(b.idr).toString(),
    refunds_usdt: q4(b.usdt).toString(),
  }));
}

/* ==========================================================================
 * Calendar-period analytics (Financial Ledger M6, Task 6c)
 *
 * Everything above this line buckets by UTC calendar DAY. The user's ask was
 * for Sales and Profit "per hari, minggu, bulan dan tahun", so the four
 * functions below add the week/month/year rollups (and the Day-granularity
 * PROFIT series, which did not exist in any form — `profitSummarySince` is a
 * single-window aggregate, not a series). The existing `*ByDay` functions are
 * deliberately untouched: they are already shipped and tested, and a rolling
 * "last N days" window is a genuinely different question from a calendar
 * rollup, so retrofitting one into the other would have made both harder to
 * reason about.
 *
 * Boundaries are the SHOP's calendar boundaries — ISO week (Monday 00:00
 * shop-local), calendar month, calendar year — via luxon's `startOf` in
 * `SHOP_ZONE()`, so a week/month/year here starts at the same instant the
 * daily buckets and the "Today" KPIs do (see SHOP_DAY_BUCKETS). Using luxon
 * rather than hand-rolled ISO-week math also avoids getting ISO week
 * NUMBERING subtly wrong around new year: 2027-01-01 belongs to ISO week
 * 2026-W53, which luxon's `kkkk` week-year token handles and a naive
 * `yyyy`-based label would not.
 * ========================================================================== */

export type PeriodGranularity = "week" | "month" | "year";

/**
 * How many buckets each granularity reports when the caller doesn't say.
 * These set the default WIDTH OF THE CHART WINDOW only — never which rows are
 * real — so they are a readability choice, not a correctness one:
 *
 * - `week: 12` — a quarter of weekly history, so a week compares against the
 *   rest of its quarter, at roughly the same number of x-axis labels the
 *   existing 30-day daily view already renders comfortably.
 * - `month: 12` — a full year, so seasonality is visible and this December
 *   sits next to last December.
 * - `year: 5` — enough to read a multi-year trend without an axis of mostly
 *   pre-launch years. A shop younger than that shows real zeros for the years
 *   before it existed (zero-filled, never interpolated).
 *
 * A `year: 5` window is a genuinely unbounded row fetch, not just a wide one:
 * `revenueByPeriod`/`ordersByPeriod`/`profitByPeriod` each issue ONE
 * `findMany` (per this file's own no-per-bucket-query discipline) covering
 * the whole window, so a 5-year-old shop's "year" view pulls every matching
 * `Order`/`OrderItem` row from that whole span into Node memory in one
 * request — `profitByPeriod` is the most expensive of the three, since its
 * rows carry a joined `product.costPrice` select. This is markedly wider
 * than anything else in this file (`revenueByDay`'s widest production window
 * is 30 days; `profitSummarySince`'s only production caller passes a 1-day
 * window), and `useAnalytics.ts`'s `refetchInterval: 30_000` re-issues it
 * every 30 seconds for as long as an admin leaves the Year view open. Not a
 * correctness bug — there is no `take`, so no silent truncation — but a
 * real scaling ceiling, accepted here rather than fixed, because fixing it
 * (a raw `date_trunc`-based `GROUP BY`, which `revenue.sql-crosscheck.test.ts`
 * already establishes a precedent for) is more machinery than a first cut of
 * a chart feature needs. Revisit if `year: 5` history or per-admin
 * dashboard-tab dwell time grows enough for this to matter in practice.
 */
const DEFAULT_PERIOD_COUNT: Record<PeriodGranularity, number> = { week: 12, month: 12, year: 5 };

/**
 * Bucket labels: `"2026-W38"` / `"2026-09"` / `"2026"`. Sortable as plain
 * strings (so the seeded-Map insertion order and lexicographic order agree),
 * deterministic, and readable verbatim as a chart axis tick — the dashboard
 * renders this string with no `tickFormatter`, so it has to be legible as-is.
 * `kkkk` is the ISO WEEK-YEAR (not `yyyy`, the calendar year) — see the
 * 2026-W53 note above for why that distinction is load-bearing.
 */
const PERIOD_LABEL_FORMAT: Record<PeriodGranularity, string> = {
  week: "kkkk-'W'WW",
  month: "yyyy-LL",
  year: "yyyy",
};

/** A luxon duration of `n` of this granularity's own unit. Spelled out per
 *  granularity rather than built from a computed key so it stays type-checked
 *  against luxon's `DurationLikeObject`. */
const periodStep = (granularity: PeriodGranularity, n: number) =>
  granularity === "week" ? { weeks: n } : granularity === "month" ? { months: n } : { years: n };

/** The label of the shop-calendar period `at` falls in. */
function periodLabel(at: Date, granularity: PeriodGranularity): string {
  return DateTime.fromJSDate(at, { zone: "utc" })
    .setZone(SHOP_ZONE())
    .startOf(granularity)
    .toFormat(PERIOD_LABEL_FORMAT[granularity]);
}

/**
 * The query window and the ordered bucket labels for the last `count` periods,
 * oldest→newest and INCLUDING the period in progress — the same convention
 * `revenueByDay(days)` uses for days (its window ends with today, not with
 * yesterday). `since` is the first bucket's own start instant, so one bulk
 * query with `deliveredAt >= since` covers every bucket; the buckets are then
 * filled by reducing in JS, never with a query per bucket.
 *
 * `since` is the shop-local start of the oldest bucket converted to a UTC
 * instant — the same relationship `recentDayWindow.since` has to its first
 * day, so a shop-local boundary is never queried as a UTC one.
 */
function periodWindow(granularity: PeriodGranularity, count: number): { since: Date; labels: string[] } {
  const first = DateTime.now()
    .setZone(SHOP_ZONE())
    .startOf(granularity)
    .plus(periodStep(granularity, -(count - 1)));
  const labels: string[] = [];
  for (let i = 0; i < count; i++) {
    labels.push(first.plus(periodStep(granularity, i)).toFormat(PERIOD_LABEL_FORMAT[granularity]));
  }
  return { since: first.toJSDate(), labels };
}

/** Every period in range pre-seeded with an empty accumulator, so a period with
 *  no activity reports a real zero (or a real `null` for profit) instead of
 *  being missing from the series — the same zero-filled contract every
 *  `*ByDay` function above already honours. */
function seedPeriods<T>(labels: readonly string[], empty: () => T): Map<string, T> {
  const buckets = new Map<string, T>();
  for (const label of labels) buckets.set(label, empty());
  return buckets;
}

export interface PeriodRevenue {
  /**
   * The bucket label — `"2026-W38"`, `"2026-09"` or `"2026"`. Named `day`, not
   * `period`, on purpose: the dashboard's chart point type is `{day, value}`
   * and its `XAxis` is `dataKey="day"`, so keeping this one field name makes
   * every granularity flow through the existing chart and API shape with no
   * per-granularity branching. A deliberate simplicity choice, not an
   * oversight — the same reasoning applies to `PeriodOrderCounts.day` and
   * `PeriodProfit.day` below.
   */
  day: string;
  revenue_idr: string;
  revenue_usdt: string;
  /**
   * The two currencies blended to IDR-equivalent, for the chart's opt-in
   * "Combined" filter — USDT orders converted through THEIR OWN `fxRate`
   * snapshot, exactly as `combinedRevenueByDay` does it (so a past period's
   * combined total never moves when today's rate does). Carried on this row
   * rather than in a separate `combinedRevenueByPeriod` function because the
   * blend is one extra accumulator over rows this query already reads; the Day
   * path keeps its own separate function, untouched.
   */
  revenueIdrEquiv: string;
  orders: number;
}

/**
 * Delivered product-sales revenue per calendar week/month/year, oldest→newest,
 * with empty periods zero-filled — the calendar-rollup counterpart to
 * `revenueByDay`. Currencies are kept apart for the same reason as everywhere
 * else in this module (a USDT order's small decimal total must never land in
 * the Rupiah figure), with the blended figure offered separately.
 *
 * Wallet top-ups are excluded via `ORDER_KIND_SALES_FILTER` — see its comment;
 * this is a revenue figure, and a buyer moving their own money into their own
 * wallet is not revenue at any granularity.
 */
export async function revenueByPeriod(
  db: Db,
  granularity: PeriodGranularity,
  count: number = DEFAULT_PERIOD_COUNT[granularity],
): Promise<PeriodRevenue[]> {
  const { since, labels } = periodWindow(granularity, count);

  const where = { status: OrderStatus.DELIVERED, ...ORDER_KIND_SALES_FILTER, deliveredAt: { gte: since } };
  const orders = await db.order.findMany({
    where,
    select: { id: true, deliveredAt: true, totalAmount: true, currency: true, fxRate: true },
  });
  // Bounded to the window's own orders — see revenueByDay for why.
  const walletSpend = await walletSpendByOrder(db, where, orders.map((o) => o.id));

  const buckets = seedPeriods(labels, () => ({
    idr: new Decimal(0),
    usdt: new Decimal(0),
    idrEquiv: new Decimal(0),
    orders: 0,
  }));
  for (const o of orders) {
    if (!o.deliveredAt) continue;
    const b = buckets.get(periodLabel(o.deliveredAt, granularity));
    if (!b) continue; // outside the window (shouldn't happen)
    const total = new Decimal(o.totalAmount);
    if (o.currency === "IDR") {
      b.idr = b.idr.plus(total);
      b.idrEquiv = b.idrEquiv.plus(total);
    } else {
      b.usdt = b.usdt.plus(total);
      // Same rule as combinedRevenueByDay, including its treatment of an
      // fxRate-less USDT order (counted unconverted rather than dropped), so
      // the Day and period-granularity combined series can never disagree.
      b.idrEquiv = b.idrEquiv.plus(o.fxRate != null ? total.times(o.fxRate) : total);
    }
    // The order's wallet leg, bucketed by the SAME deliveredAt and split by the
    // wallet row's own currency — combinedRevenueByDay's rule verbatim (M8.5),
    // down to the `o.currency === "USDT" && o.fxRate != null` conversion guard
    // the gateway leg above uses, so the two series and the two halves of one
    // sale all blend by the same single rule.
    const wallet = walletSpend.get(o.id);
    if (wallet) {
      b.idr = b.idr.plus(wallet.idr);
      b.usdt = b.usdt.plus(wallet.usdt);
      b.idrEquiv = b.idrEquiv
        .plus(wallet.idr)
        .plus(o.currency === "USDT" && o.fxRate != null ? wallet.usdt.times(o.fxRate) : wallet.usdt);
    }
    b.orders += 1;
  }

  return [...buckets.entries()].map(([day, b]) => ({
    day,
    revenue_idr: q4(b.idr).toString(),
    revenue_usdt: q4(b.usdt).toString(),
    revenueIdrEquiv: q4(b.idrEquiv).toString(),
    orders: b.orders,
  }));
}

export interface PeriodOrderCounts {
  day: string; // bucket label — see PeriodRevenue.day
  ordersIdr: number;
  ordersUsdt: number;
}

/** Delivered product-sale counts per calendar week/month/year, oldest→newest,
 *  split by currency and zero-filled — the calendar-rollup counterpart to
 *  `ordersByDay`, for the Sales Analytics chart's "Orders" metric. Wallet
 *  top-ups excluded, same as `revenueByPeriod` above. */
export async function ordersByPeriod(
  db: Db,
  granularity: PeriodGranularity,
  count: number = DEFAULT_PERIOD_COUNT[granularity],
): Promise<PeriodOrderCounts[]> {
  const { since, labels } = periodWindow(granularity, count);

  const orders = await db.order.findMany({
    where: { status: OrderStatus.DELIVERED, ...ORDER_KIND_SALES_FILTER, deliveredAt: { gte: since } },
    select: { deliveredAt: true, currency: true },
  });

  const buckets = seedPeriods(labels, () => ({ idr: 0, usdt: 0 }));
  for (const o of orders) {
    if (!o.deliveredAt) continue;
    const b = buckets.get(periodLabel(o.deliveredAt, granularity));
    if (!b) continue;
    if (o.currency === "IDR") b.idr += 1;
    else b.usdt += 1;
  }
  return [...buckets.entries()].map(([day, b]) => ({ day, ordersIdr: b.idr, ordersUsdt: b.usdt }));
}

/**
 * The exact `OrderItem` selection both bucketed-profit functions read, kept as
 * one constant so the Day and week/month/year series can never drift apart in
 * what they feed the arithmetic. It is `profitSummarySince`'s own selection
 * plus `order.deliveredAt`, which those two need in order to bucket at all.
 *
 * No `kind: PRODUCT` clause, deliberately: this is rooted at `OrderItem`, and a
 * wallet top-up carries zero item rows — the same structural immunity
 * `ORDER_KIND_SALES_FILTER`'s comment already records for the other
 * OrderItem-rooted functions in this module.
 */
const PROFIT_ITEM_SELECT = {
  quantity: true,
  unitPrice: true,
  product: { select: { costPrice: true } },
  order: {
    select: {
      deliveredAt: true,
      currency: true,
      fxRate: true,
      subtotalAmount: true,
      bulkDiscountAmount: true,
      discountAmount: true,
    },
  },
} as const;

interface ProfitAccumulator {
  revenue: Decimal;
  cost: Decimal;
  /** How many items actually contributed. Zero means "nothing known", which is
   *  what makes a bucket `null` rather than a fabricated 0 — see
   *  `shapeBucketProfit`. */
  costKnownItems: number;
}

/** One bucket's two currency accumulators — never blended, same rule as
 *  `profitSummarySince`. */
interface ProfitBucket {
  idr: ProfitAccumulator;
  usdt: ProfitAccumulator;
}

const emptyProfitBucket = (): ProfitBucket => ({
  idr: { revenue: new Decimal(0), cost: new Decimal(0), costKnownItems: 0 },
  usdt: { revenue: new Decimal(0), cost: new Decimal(0), costKnownItems: 0 },
});

/**
 * Adds one delivered line to its bucket's own currency accumulator, with
 * `profitSummarySince`'s arithmetic verbatim: discount-prorated line revenue
 * via `orderItemRevenueIdr`, cost as catalog-central IDR × quantity, and BOTH
 * brought into the bucket's currency through `idrToBucketCurrency` (that
 * order's own `fxRate` snapshot) so revenue and cost can never end up in
 * mismatched units.
 *
 * A cost-unknown item is excluded from both sums rather than nulling the whole
 * bucket — counting it at cost=0 would read as a fabricated 100% margin, and
 * dropping the bucket would throw away the profit that IS known. Same rule
 * `profitSummarySince` and `topProductsByMargin` already apply.
 */
function accumulateLineProfit(
  bucket: ProfitBucket,
  item: {
    quantity: number;
    unitPrice: Decimal.Value;
    product: { costPrice: Decimal.Value | null };
    order: {
      currency: string;
      fxRate: Decimal.Value | null;
      subtotalAmount: Decimal.Value;
      bulkDiscountAmount: Decimal.Value;
      discountAmount: Decimal.Value;
    };
  },
): void {
  if (item.product.costPrice == null) return;
  const isUsdt = item.order.currency === "USDT";
  const acc = isUsdt ? bucket.usdt : bucket.idr;
  const lineRevenueIdr = orderItemRevenueIdr(item);
  const lineCostIdr = new Decimal(item.product.costPrice).times(item.quantity);
  acc.revenue = acc.revenue.plus(idrToBucketCurrency(lineRevenueIdr, isUsdt, item.order.fxRate));
  acc.cost = acc.cost.plus(idrToBucketCurrency(lineCostIdr, isUsdt, item.order.fxRate));
  acc.costKnownItems += 1;
}

/**
 * One currency's profit for one bucket, or `null` when that bucket has no
 * cost-known delivered item in it — "empty bucket is null, not zero", the same
 * rule `profitSummarySince`'s `shape` helper applies to its whole window.
 *
 * Two deliberate differences from `shape`, both forced by what a chart series
 * can carry: `shape` returns a RICH object (`netProfit` + `marginPct` +
 * `excludedItemCount`), so it can honestly report `netProfit: "0",
 * excludedItemCount: 1` for a window whose only item had unknown cost — the
 * excluded count is what tells the reader the 0 is not a real break-even. A
 * bucket on a line chart is a single number with nowhere to put that caveat, so
 * here an all-cost-unknown bucket is `null` (the chart draws a gap) rather than
 * a 0 that would read as a period that genuinely broke even.
 *
 * And the emptiness test is `costKnownItems === 0` rather than `shape`'s
 * `revenue.isZero() && excluded === 0`: a fully-discounted-to-zero line with a
 * known cost is a real loss, and keying on the counter reports it instead of
 * hiding it behind a zero-revenue check.
 */
const shapeBucketProfit = (acc: ProfitAccumulator): string | null =>
  acc.costKnownItems === 0 ? null : q4(acc.revenue.minus(acc.cost)).toString();

export interface DayProfit {
  day: string; // YYYY-MM-DD, shop timezone — matching revenueByDay exactly
  profit_idr: string | null;
  profit_usdt: string | null;
}

/**
 * Daily net profit for the last `days` days, oldest→newest, split per currency
 * — the profit counterpart to `revenueByDay`, and the Day half of the chart's
 * "Profit" metric. `profitSummarySince` answers "profit since X" as one
 * aggregate and cannot be sliced into a series, so this exists rather than
 * calling it in a loop (which would also have meant one query per day).
 *
 * A day with no cost-known delivered item reports `null`, not `"0"` — see
 * `shapeBucketProfit`.
 */
export async function profitByDay(db: Db, days = 30): Promise<DayProfit[]> {
  const { since, keys } = recentDayWindow(days);

  const items = await db.orderItem.findMany({
    where: { order: { status: OrderStatus.DELIVERED, deliveredAt: { gte: since } } },
    select: PROFIT_ITEM_SELECT,
  });

  const buckets = new Map<string, ProfitBucket>();
  for (const key of keys) buckets.set(key, emptyProfitBucket());
  for (const item of items) {
    const deliveredAt = item.order.deliveredAt;
    if (!deliveredAt) continue;
    const bucket = buckets.get(dayKeyInZone(deliveredAt));
    if (!bucket) continue; // outside the window (shouldn't happen)
    accumulateLineProfit(bucket, item);
  }
  return [...buckets.entries()].map(([day, b]) => ({
    day,
    profit_idr: shapeBucketProfit(b.idr),
    profit_usdt: shapeBucketProfit(b.usdt),
  }));
}

export interface PeriodProfit {
  day: string; // bucket label — see PeriodRevenue.day
  profit_idr: string | null;
  profit_usdt: string | null;
}

/** Net profit per calendar week/month/year, oldest→newest, split per currency —
 *  the calendar-rollup counterpart to `profitByDay` above, sharing its
 *  selection (`PROFIT_ITEM_SELECT`), its per-line arithmetic
 *  (`accumulateLineProfit`) and its null-vs-zero rule (`shapeBucketProfit`), so
 *  the two granularities cannot report different profit for the same data. */
export async function profitByPeriod(
  db: Db,
  granularity: PeriodGranularity,
  count: number = DEFAULT_PERIOD_COUNT[granularity],
): Promise<PeriodProfit[]> {
  const { since, labels } = periodWindow(granularity, count);

  const items = await db.orderItem.findMany({
    where: { order: { status: OrderStatus.DELIVERED, deliveredAt: { gte: since } } },
    select: PROFIT_ITEM_SELECT,
  });

  const buckets = seedPeriods(labels, emptyProfitBucket);
  for (const item of items) {
    const deliveredAt = item.order.deliveredAt;
    if (!deliveredAt) continue;
    const bucket = buckets.get(periodLabel(deliveredAt, granularity));
    if (!bucket) continue;
    accumulateLineProfit(bucket, item);
  }
  return [...buckets.entries()].map(([day, b]) => ({
    day,
    profit_idr: shapeBucketProfit(b.idr),
    profit_usdt: shapeBucketProfit(b.usdt),
  }));
}
