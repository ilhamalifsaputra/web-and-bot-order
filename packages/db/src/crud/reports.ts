/**
 * Reports & reconciliation — port of the "Reports" + reconcile_finances
 * sections of crud.py. reconcile_finances detects drift WITHOUT mutating rows.
 * Revenue/profit/analytics-by-day computations live in ./revenue.ts.
 */
import { OrderStatus, OrderKind } from "@app/core/enums";
import { quantizeMoney, usdtFromIdr } from "@app/core/formatters";
import { Decimal } from "@app/core/money";
import { addDays } from "@app/core/datetime";
import type { Db } from "./_types";

const q4 = (v: Decimal.Value) => quantizeMoney(v, 4);

export interface ReconcileFindings {
  order_drift: Array<{ order_id: number; order_code: string; expected: string; actual: string }>;
  voucher_drift: Array<{ voucher_id: number; code: string; recorded_used: number; actual_orders: number }>;
  negative_wallets: Array<{ user_id: number; telegram_id: string | null; balance: string; currency: "IDR" | "USDT" }>;
}

export async function reconcileFinances(db: Db): Promise<ReconcileFindings> {
  const findings: ReconcileFindings = {
    order_drift: [],
    voucher_drift: [],
    negative_wallets: [],
  };

  // 1. Order total integrity (non-cancelled orders).
  const orders = await db.order.findMany({
    where: { status: { not: OrderStatus.CANCELLED }, kind: OrderKind.PRODUCT },
  });

  // Which currency each order's wallet leg was actually paid in, read from the
  // ledger rather than inferred from Order.currency. `Order.walletUsed` is a
  // bare number with no currency of its own: on a USDT order it is USDT
  // (applyUsdtWalletToOrder debits AFTER the IDR→USDT conversion), on an IDR
  // order it is IDR (createOrder* debits BEFORE any conversion). That the two
  // never mix on one order holds today only by caller discipline
  // (createInternalOrder and the wallet_checkout rails each deliberately
  // withhold the IDR walletAmount) — nothing enforces it, and a future caller
  // that passed both would make every affected order look like drift while the
  // real error went unnamed. Reading the WalletTransaction rows, which DO carry
  // a currency, removes the assumption instead of restating it.
  const walletLegs = await db.walletTransaction.findMany({
    where: { reason: "order_payment", orderId: { in: orders.map((o) => o.id) } },
    select: { orderId: true, currency: true, delta: true },
  });
  const walletByOrder = new Map<number, { idr: Decimal; usdt: Decimal; any: boolean }>();
  for (const leg of walletLegs) {
    if (leg.orderId == null) continue;
    const acc = walletByOrder.get(leg.orderId) ?? { idr: new Decimal(0), usdt: new Decimal(0), any: false };
    // Debits are stored negative; the order's wallet leg is their magnitude.
    const spent = new Decimal(leg.delta).negated();
    if (leg.currency === "USDT") acc.usdt = acc.usdt.plus(spent);
    else acc.idr = acc.idr.plus(spent);
    acc.any = true;
    walletByOrder.set(leg.orderId, acc);
  }

  for (const o of orders) {
    // Orders predating the ledger's orderId stamping have no legs to read —
    // fall back to the stored figure, interpreted the historical way.
    const legs = walletByOrder.get(o.id);
    const walletIdr = legs?.any ? legs.idr : o.currency === "USDT" ? new Decimal(0) : new Decimal(o.walletUsed);
    const walletUsdt = legs?.any ? legs.usdt : o.currency === "USDT" ? new Decimal(o.walletUsed) : new Decimal(0);
    const afterDisc = new Decimal(o.subtotalAmount)
      .minus(o.bulkDiscountAmount)
      .minus(o.discountAmount);
    // Subtotals are stored in the central price unit (IDR post-cutover; the
    // pre-cutover snapshot unit before). The CHARGED total depends on the
    // pay-time choice (plan.md §15.1): a USDT order with an fxRate snapshot is
    // round(base/rate, 0.1) + cents; an IDR order is the whole-Rupiah base.
    //
    // Each wallet leg is subtracted in ITS OWN currency and at the right point
    // in the conversion: an IDR leg comes off the central-IDR base BEFORE the
    // IDR→USDT conversion (that is where createOrder* spends it), a USDT leg
    // comes off the already-converted total AFTER it (where
    // applyUsdtWalletToOrder spends it). Written this way the expression is
    // correct for either leg, both, or neither.
    let expected: Decimal;
    if (o.currency === "USDT" && o.fxRate != null) {
      const baseIdr = Decimal.max(new Decimal(0), afterDisc.minus(walletIdr));
      let afterWallet = usdtFromIdr(baseIdr, o.fxRate).minus(walletUsdt);
      if (afterWallet.lessThan(0)) afterWallet = new Decimal(0);
      expected = q4(afterWallet.plus(o.uniqueCents));
    } else if (o.currency === "IDR") {
      let afterWallet = afterDisc.minus(walletIdr);
      if (afterWallet.lessThan(0)) afterWallet = new Decimal(0);
      expected = quantizeMoney(afterWallet, 0);
    } else {
      let afterWallet = afterDisc.minus(walletIdr).minus(walletUsdt);
      if (afterWallet.lessThan(0)) afterWallet = new Decimal(0);
      expected = q4(afterWallet.plus(o.uniqueCents));
    }
    if (expected.minus(o.totalAmount).abs().greaterThan("0.0001")) {
      findings.order_drift.push({
        order_id: o.id,
        order_code: o.orderCode,
        expected: expected.toString(),
        actual: new Decimal(o.totalAmount).toString(),
      });
    }
  }

  // 2. Voucher usage drift.
  const vouchers = await db.voucher.findMany();
  const voucherOrderCounts = await db.order.groupBy({
    by: ["voucherId"],
    where: { voucherId: { in: vouchers.map((v) => v.id) }, status: { not: OrderStatus.CANCELLED } },
    _count: { _all: true },
  });
  const actualByVoucherId = new Map(voucherOrderCounts.map((g) => [g.voucherId, g._count._all]));
  for (const v of vouchers) {
    const actual = actualByVoucherId.get(v.id) ?? 0;
    if (actual !== v.usedCount) {
      findings.voucher_drift.push({
        voucher_id: v.id,
        code: v.code,
        recorded_used: v.usedCount,
        actual_orders: actual,
      });
    }
  }

  // 3. Negative wallet balances (both IDR and USDT).
  const negativesIdr = await db.user.findMany({ where: { walletBalance: { lt: 0 } } });
  for (const u of negativesIdr) {
    findings.negative_wallets.push({
      user_id: u.id,
      telegram_id: u.telegramId ? u.telegramId.toString() : null,
      balance: new Decimal(u.walletBalance).toString(),
      currency: "IDR",
    });
  }

  const negativesUsdt = await db.user.findMany({ where: { walletBalanceUsdt: { lt: 0 } } });
  for (const u of negativesUsdt) {
    findings.negative_wallets.push({
      user_id: u.id,
      telegram_id: u.telegramId ? u.telegramId.toString() : null,
      balance: new Decimal(u.walletBalanceUsdt).toString(),
      currency: "USDT",
    });
  }

  return findings;
}

export interface StatusCount {
  status: string;
  count: number;
}

/** Order counts grouped by status (the funnel). */
export async function ordersByStatus(db: Db): Promise<StatusCount[]> {
  const grouped = await db.order.groupBy({ by: ["status"], _count: { _all: true } });
  return grouped
    .map((g) => ({ status: g.status, count: g._count._all }))
    .sort((a, b) => b.count - a.count);
}

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

export interface VoucherUsage {
  id: number;
  code: string;
  usedCount: number;
  usageLimit: number | null;
  isActive: boolean;
}

/** Vouchers ordered by how heavily they've been used. */
export async function voucherUsage(db: Db, limit = 20): Promise<VoucherUsage[]> {
  const rows = await db.voucher.findMany({
    orderBy: { usedCount: "desc" },
    take: limit,
  });
  return rows.map((v) => ({
    id: v.id,
    code: v.code,
    usedCount: v.usedCount,
    usageLimit: v.usageLimit ?? null,
    isActive: v.isActive,
  }));
}

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

/**
 * The five gateway ledger tables `manualMatchQueueCounts`/`listCombinedLedger`
 * cover. There is NOT a sixth `processedBybitBscTx` table: `ProcessedBybitTx`
 * (see its schema doc comment) is shared by BOTH Bybit payment methods —
 * `BYBIT` (off-chain Internal Transfer, `bybit_deposit.ts`) and `BYBIT_BSC`
 * (on-chain BEP20 deposit, `bybit_bsc_deposit.ts`) both write their ledger
 * rows into the same table via the same `db.processedBybitTx.create(...)`
 * calls, and the table has no column recording which of the two sub-rails a
 * given row came from. So "five tables" was already correct and already
 * inclusive of Bybit BSC deposits; audited while adding `listCombinedLedger`
 * below (task 47, backend audit follow-up) and confirmed not a bug.
 */
export type LedgerGateway = "binance" | "bybit" | "tokopay" | "paydisini" | "nowpayments";

export interface UnifiedLedgerRow {
  id: number;
  gateway: LedgerGateway;
  /** The gateway's own transaction/callback reference id — `binanceTxId`,
   *  `bybitTxId`, or `trxId` depending on the source table. */
  reference: string;
  amount: string | null;
  /** None of the five ledger tables store a currency column (see each
   *  table's schema) — always null today. Kept in the shape for parity with
   *  the pre-existing (also-always-null) Binance-only response field rather
   *  than inferring one, which is an unrelated pre-existing gap. */
  currency: string | null;
  outcome: string;
  createdAt: Date;
  orderId: number | null;
  /** Human-facing code of the order this payment settled (`ORD-…`), or null
   *  when the row has no `orderId` (unmatched/dismissed transfers) or the
   *  order has since been deleted. Lets an admin trace a ledger row back to
   *  its order instead of staring at a bare numeric id. */
  orderCode: string | null;
  /** `Order.kind` — "PRODUCT" for a sale, "WALLET_TOPUP" for a wallet top-up
   *  (see `OrderKind` in packages/core/src/enums.ts). Null on rows with no
   *  order, same as `orderCode`. Without this the Payments ledger cannot tell
   *  top-up money from product-sale money. */
  orderKind: string | null;
}

export interface CombinedLedgerFilter {
  outcome?: string | null;
  q?: string | null;
  /** Filter to one `Order.kind` ("PRODUCT" | "WALLET_TOPUP"). Rows with no
   *  order are excluded by any non-null value here — they belong to neither
   *  kind. Applied in JS after the order join, because `kind` lives on
   *  `Order` and none of the five ledger tables carry it. */
  kind?: string | null;
  limit?: number;
  offset?: number;
}

export interface CombinedLedgerPage {
  rows: UnifiedLedgerRow[];
  /** Rows the filter yields in total, across every page — NOT just this
   *  page's length. Returned alongside the rows (rather than from a separate
   *  `countCombinedLedger`) precisely because the `kind` filter cannot be
   *  expressed as per-table `count()` calls: it depends on a join that only
   *  exists once the five tables have been merged. Deriving both numbers from
   *  the same merged-and-filtered array is what keeps `total` and the paged
   *  rows from disagreeing. */
  total: number;
}

/**
 * Cross-gateway ledger list — normalizes all five `processed*Tx` idempotency
 * tables (Binance, Bybit [covers both Bybit sub-rails, see the doc comment
 * above `LedgerGateway`], TokoPay, PayDisini, NOWPayments) into one shape so
 * the Payments page's ledger table (and the "Failed Deliveries" Operation
 * Center card link, `?outcome=delivery_failed`) isn't structurally blind to
 * every gateway except Binance.
 *
 * Each table is queried with its own `where` (outcome/`q` applied server-side
 * per table, not fetched unfiltered and filtered in JS) via `Promise.all`,
 * then merged, sorted by `createdAt` descending, and paginated in memory —
 * mirroring `manualMatchQueueCounts`'s existing query-all-combine-in-JS
 * pattern rather than a raw SQL `UNION` (no raw SQL outside the crud layer).
 * This scales linearly with total ledger row count when no `outcome`/`q`
 * filter narrows it (every row across all five tables is fetched and sorted
 * for every unfiltered page) — acceptable for these ledgers' size today, but
 * revisit with a real cross-table paginated query if any one of them grows
 * large.
 *
 * Each row is then enriched with its order's code and kind via ONE extra
 * `order.findMany` over the distinct order ids in the merged set — never one
 * query per row. That single query is the price of being able to tell a
 * wallet top-up from a product sale on this page; anything per-row would
 * multiply the linear cost described above by the page size. Note that its
 * `id IN (...)` list is unbounded for the same reason the merge is: it holds
 * every distinct order referenced anywhere in the whole ledger, not just the
 * requested page. So it grows with the ledger too, and on SQLite it does not
 * merely get slower — past the bind-variable ceiling (~32k) the query throws
 * outright. That ceiling, not the sort cost, is the real deadline for the
 * properly paginated cross-table query mentioned above.
 *
 * Returns `{ rows, total }` rather than rows alone, and there is deliberately
 * no `countCombinedLedger` counterpart: the `kind` filter is applied to the
 * merged, order-joined array (before slicing), so the only correct total is
 * the length of that array. Five per-table `count()` calls cannot see `kind`
 * at all and would report a total that disagrees with what the filter really
 * yields.
 */
export async function listCombinedLedger(db: Db, opts: CombinedLedgerFilter = {}): Promise<CombinedLedgerPage> {
  const q = opts.q && opts.q.trim() ? opts.q.trim() : null;
  const outcomeWhere = opts.outcome ? { outcome: opts.outcome } : {};

  const [binance, bybit, tokopay, paydisini, nowpayments] = await Promise.all([
    db.processedBinanceTx.findMany({
      where: { ...outcomeWhere, ...(q ? { binanceTxId: { contains: q, mode: "insensitive" } } : {}) },
    }),
    db.processedBybitTx.findMany({
      where: { ...outcomeWhere, ...(q ? { bybitTxId: { contains: q, mode: "insensitive" } } : {}) },
    }),
    db.processedTokopayTx.findMany({
      where: { ...outcomeWhere, ...(q ? { trxId: { contains: q, mode: "insensitive" } } : {}) },
    }),
    db.processedPaydisiniTx.findMany({
      where: { ...outcomeWhere, ...(q ? { trxId: { contains: q, mode: "insensitive" } } : {}) },
    }),
    db.processedNowpaymentsTx.findMany({
      where: { ...outcomeWhere, ...(q ? { trxId: { contains: q, mode: "insensitive" } } : {}) },
    }),
  ]);

  // Pre-join shape: everything the ledger tables themselves can supply.
  // `orderCode`/`orderKind` are filled in from the single order query below.
  type PreJoinRow = Omit<UnifiedLedgerRow, "orderCode" | "orderKind">;
  const merged: PreJoinRow[] = [
    ...binance.map((r) => ({
      id: r.id,
      gateway: "binance" as const,
      reference: r.binanceTxId,
      amount: r.amount != null ? r.amount.toString() : null,
      currency: null,
      outcome: r.outcome,
      createdAt: r.createdAt,
      orderId: r.orderId,
    })),
    ...bybit.map((r) => ({
      id: r.id,
      gateway: "bybit" as const,
      reference: r.bybitTxId,
      amount: r.amount != null ? r.amount.toString() : null,
      currency: null,
      outcome: r.outcome,
      createdAt: r.createdAt,
      orderId: r.orderId,
    })),
    ...tokopay.map((r) => ({
      id: r.id,
      gateway: "tokopay" as const,
      reference: r.trxId,
      amount: r.amount != null ? r.amount.toString() : null,
      currency: null,
      outcome: r.outcome,
      createdAt: r.createdAt,
      orderId: r.orderId,
    })),
    ...paydisini.map((r) => ({
      id: r.id,
      gateway: "paydisini" as const,
      reference: r.trxId,
      amount: r.amount != null ? r.amount.toString() : null,
      currency: null,
      outcome: r.outcome,
      createdAt: r.createdAt,
      orderId: r.orderId,
    })),
    ...nowpayments.map((r) => ({
      id: r.id,
      gateway: "nowpayments" as const,
      reference: r.trxId,
      amount: r.amount != null ? r.amount.toString() : null,
      currency: null,
      outcome: r.outcome,
      createdAt: r.createdAt,
      orderId: r.orderId,
    })),
  ];
  merged.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());

  // ONE query for every order referenced anywhere in the merged set — not one
  // per row. Rows whose `orderId` is null (unmatched or dismissed transfers),
  // and rows pointing at an order that no longer exists, keep null code/kind
  // and are still returned; dropping them would hide exactly the transfers an
  // admin most needs to see.
  const orderIds = [...new Set(merged.map((r) => r.orderId).filter((id): id is number => id != null))];
  const orders = orderIds.length
    ? await db.order.findMany({ where: { id: { in: orderIds } }, select: { id: true, orderCode: true, kind: true } })
    : [];
  const orderById = new Map(orders.map((o) => [o.id, o]));

  let joined: UnifiedLedgerRow[] = merged.map((r) => {
    const order = r.orderId != null ? orderById.get(r.orderId) : undefined;
    return { ...r, orderCode: order?.orderCode ?? null, orderKind: order?.kind ?? null };
  });

  // Applied to the whole merged set BEFORE slicing, so the filter spans every
  // page and `total` below counts exactly the rows the filter yields.
  if (opts.kind) joined = joined.filter((r) => r.orderKind === opts.kind);

  const offset = opts.offset ?? 0;
  const limit = opts.limit ?? 50;
  return { rows: joined.slice(offset, offset + limit), total: joined.length };
}

/** OrderItems whose warranty (delivered_at + snapshot days) falls in [start,end]. */
export async function listOrderItemsExpiringWarranty(
  db: Db,
  start: Date,
  end: Date,
) {
  const lookback = addDays(end, -400);
  const rows = await db.orderItem.findMany({
    where: {
      order: {
        status: OrderStatus.DELIVERED,
        deliveredAt: { not: null, gte: lookback },
      },
    },
    include: { product: true, order: { include: { user: true } } },
  });
  return rows.filter((item) => {
    const deliveredAt = item.order.deliveredAt;
    if (!deliveredAt) return false;
    const expiry = addDays(deliveredAt, item.warrantyDaysSnapshot);
    return start.getTime() <= expiry.getTime() && expiry.getTime() <= end.getTime();
  });
}

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
