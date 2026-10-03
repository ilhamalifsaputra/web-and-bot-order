/**
 * Reports & reconciliation — port of the "Reports" + reconcile_finances
 * sections of crud.py. reconcile_finances detects drift WITHOUT mutating rows.
 * Revenue/profit/analytics-by-day computations live in ./revenue.ts.
 */
import { OrderStatus, OrderKind, RefundStatus } from "@app/core/enums";
import { quantizeMoney, usdtFromIdr } from "@app/core/formatters";
import { Decimal } from "@app/core/money";
import { addDays, startOfDayUtc } from "@app/core/datetime";
import { getSetting } from "./settings";
import type { Db } from "./_types";

const q4 = (v: Decimal.Value) => quantizeMoney(v, 4);

/**
 * `usdtFromIdr` as it behaved BEFORE M13 / P2-1: the nearest 0.1, half-up.
 *
 * Needed by `reconcileFinances` alone, and only because that check re-derives
 * what a USDT order's total should be and compares it against the total that
 * was actually stored. Orders finalized before the rounding policy changed
 * carry the old figure and are not drift — they are correctly priced under the
 * rule that was in force when they were priced. Without this exemption the
 * first reconciliation run after the change would report the shop's ENTIRE
 * USDT order history as drift, and an alert that fires on every past order is
 * the alert an admin learns to ignore.
 *
 * Deliberately a frozen local copy rather than a parameter on `usdtFromIdr`:
 * nothing may ever PRICE anything with this again. It exists to recognise
 * history, not to produce it, and a future reader must not be able to reach it
 * from the pricing path.
 */
function legacyUsdtFromIdr(idr: Decimal.Value, rate: Decimal.Value): Decimal {
  return new Decimal(idr).div(rate).toDecimalPlaces(1, Decimal.ROUND_HALF_UP);
}

/**
 * Settings key: when this shop switched from the 0.1-half-up USDT rounding to
 * the 0.01-ceil one, as an ISO timestamp. It is the end date of
 * {@link legacyUsdtFromIdr}'s exemption — orders created BEFORE it are history
 * and may match either rule, orders created on or after it must match the
 * current rule alone.
 *
 * The exemption used to have no end date (whole-branch review D8), so a total
 * that happened to land on the old figure was excused forever, including on an
 * order created today. A present-day 0.1-shaped total is not correctly priced
 * history, it is a bug in whatever produced it, and it was the one class of
 * mispricing this report could never see — the only USDT figures it accepted
 * without deriving them were exactly the ones it should have been suspicious of.
 *
 * UNSET (or blank, or unparseable) exempts NOTHING. That is the strict
 * direction on purpose: the value says "here is when my pricing changed", and a
 * shop that has never recorded that cannot show any order predates the change.
 * The permissive reading would quietly keep the open-ended exemption this key
 * exists to remove. The cutoff is seeded to the deploy instant by migration
 * `20260919120000_seed_usdt_rounding_ceil_since`, so an existing shop's history
 * is exempt without an admin touching anything; a shop that clears the field
 * afterwards is asking for every USDT order to be re-derived under the current
 * rule, which is a legitimate thing to ask for once its 0.1-era orders are gone.
 *
 * The boundary is exclusive at the top: an order created at exactly this instant
 * is judged by the new rule. The cutoff names the moment the new rule took
 * effect, and the first order of the new era is the one most worth checking.
 */
export const USDT_ROUNDING_CEIL_SINCE_KEY = "usdt_rounding_ceil_since";

/**
 * {@link USDT_ROUNDING_CEIL_SINCE_KEY} as a Date, or null for "no cutoff
 * recorded" — which {@link reconcileFinances} reads as "exempt nothing".
 * Anything unparseable is treated as unset rather than throwing: a malformed
 * settings row must not take the six-hourly reconciliation job down, and the
 * failure it causes instead (a noisier report) is the visible, self-announcing
 * one.
 */
async function usdtRoundingCeilSince(db: Db): Promise<Date | null> {
  const raw = (await getSetting(db, USDT_ROUNDING_CEIL_SINCE_KEY))?.trim();
  if (!raw) return null;
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

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

  // When the USDT rounding rule changed, so the legacy exemption below can be
  // limited to orders that actually predate it (D8). Read once for the whole
  // run: the answer cannot change mid-report, and one read keeps the job's
  // query count flat in the number of orders.
  const roundingCeilSince = await usdtRoundingCeilSince(db);

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
    // ceil(base/rate, 0.01) + cents; an IDR order is the whole-Rupiah base.
    // (M13 / P2-1 changed that step from a half-up 0.1. This expression reads
    // the rule out of `usdtFromIdr`, so it followed automatically — but an order
    // finalized BEFORE the change carries the old figure, so the derivation is
    // done BOTH ways below for those orders and a match on either one clears
    // them. "Those orders" is the point of D8: the second derivation happens
    // only for an order created before `usdt_rounding_ceil_since`, because on a
    // present-day order the old figure is a bug and not history. See
    // `legacyUsdtFromIdr` and `USDT_ROUNDING_CEIL_SINCE_KEY`.)
    //
    // Each wallet leg is subtracted in ITS OWN currency and at the right point
    // in the conversion: an IDR leg comes off the central-IDR base BEFORE the
    // IDR→USDT conversion (that is where createOrder* spends it), a USDT leg
    // comes off the already-converted total AFTER it (where
    // applyUsdtWalletToOrder spends it). Written this way the expression is
    // correct for either leg, both, or neither.
    let expected: Decimal;
    // What the same order would total if it had been priced under the PREVIOUS
    // rounding policy. Null for anything that policy cannot explain: an order
    // the policy never touched, and — since D8 — any order created on or after
    // the recorded cutoff, which was priced by the current rule and has no claim
    // on the old one.
    let legacyExpected: Decimal | null = null;
    if (o.currency === "USDT" && o.fxRate != null) {
      const baseIdr = Decimal.max(new Decimal(0), afterDisc.minus(walletIdr));
      const convert = (converted: Decimal) => {
        const afterWallet = converted.minus(walletUsdt);
        return q4((afterWallet.lessThan(0) ? new Decimal(0) : afterWallet).plus(o.uniqueCents));
      };
      expected = convert(usdtFromIdr(baseIdr, o.fxRate));
      if (roundingCeilSince != null && o.createdAt < roundingCeilSince) {
        legacyExpected = convert(legacyUsdtFromIdr(baseIdr, o.fxRate));
      }
    } else if (o.currency === "IDR") {
      let afterWallet = afterDisc.minus(walletIdr);
      if (afterWallet.lessThan(0)) afterWallet = new Decimal(0);
      expected = quantizeMoney(afterWallet, 0);
    } else {
      let afterWallet = afterDisc.minus(walletIdr).minus(walletUsdt);
      if (afterWallet.lessThan(0)) afterWallet = new Decimal(0);
      expected = q4(afterWallet.plus(o.uniqueCents));
    }
    const matches = (candidate: Decimal) => candidate.minus(o.totalAmount).abs().lessThanOrEqualTo("0.0001");
    // M13 / P2-1: a USDT order matching the PREVIOUS rounding policy exactly is
    // correctly priced history, not drift (see `legacyUsdtFromIdr`). The
    // exemption is an exact match on the legacy figure, not a widened
    // tolerance — an order that is 0.1 off for any OTHER reason still gets
    // reported, and the figure reported is always the CURRENT rule's, because
    // that is the only one this code considers correct. D8 added the other half
    // of "history": `legacyExpected` is null unless the order predates
    // `usdt_rounding_ceil_since`, so the exemption cannot outlive the era it
    // describes.
    if (!matches(expected) && !(legacyExpected != null && matches(legacyExpected))) {
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

/**
 * Order counts grouped by status (the funnel) — product sales only.
 *
 * Its one caller is the Reports page's order funnel (GET /api/reports,
 * alongside `revenueByDay`, `topProducts` and `voucherUsage`), so this is a
 * sales report, not an operational queue view. A settled `WALLET_TOPUP` order
 * reaches `DELIVERED` like any sale (`settleWalletTopup`) and would otherwise
 * inflate the funnel's delivered leg with money the buyer has not spent —
 * Financial Ledger M6, Task 6a. Sibling `ordersByStatusSince` below carries
 * the same filter for the same reason.
 *
 * Kind-agnostic status counters live in crud/orders.ts (`countDelivered`,
 * `countPendingVerifications`, ...) and deliberately do NOT carry this filter:
 * they feed admin work queues and the Orders page's own tab badges, where a
 * top-up is real, actionable work. See that file's
 * "operational order counters stay kind-agnostic" test for the full reasoning.
 */
export async function ordersByStatus(db: Db): Promise<StatusCount[]> {
  const grouped = await db.order.groupBy({
    by: ["status"],
    where: { kind: OrderKind.PRODUCT },
    _count: { _all: true },
  });
  return grouped
    .map((g) => ({ status: g.status, count: g._count._all }))
    .sort((a, b) => b.count - a.count);
}

/** Order counts grouped by status, restricted to product orders created since
 * `since` — the dashboard's "Orders Today" funnel (GET /api/dashboard/kpis ->
 * OrdersKpiCard). Product-sales-only for the same reason as `ordersByStatus`
 * above. */
export async function ordersByStatusSince(db: Db, since: Date): Promise<StatusCount[]> {
  const grouped = await db.order.groupBy({
    by: ["status"],
    where: { kind: OrderKind.PRODUCT, createdAt: { gte: since } },
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
 * Ledger rows per outcome across all five payment-method idempotency tables
 * (Binance, Bybit, TokoPay, PayDisini, NOWPayments) — the same set of tables
 * `listCombinedLedger` merges, so a count here and a filter of that ledger by
 * the same outcome always agree. The Payments tiles and outcome
 * dropdown read this (they once read a Binance-only helper while the ledger
 * spanned every gateway). Includes outcomes outside `TX_OUTCOMES` (e.g. the QRIS-only
 * "stale") under their own key.
 */
export async function ledgerOutcomeCounts(db: Db): Promise<Record<string, number>> {
  const groups = await Promise.all([
    db.processedBinanceTx.groupBy({ by: ["outcome"], _count: { _all: true } }),
    db.processedBybitTx.groupBy({ by: ["outcome"], _count: { _all: true } }),
    db.processedTokopayTx.groupBy({ by: ["outcome"], _count: { _all: true } }),
    db.processedPaydisiniTx.groupBy({ by: ["outcome"], _count: { _all: true } }),
    db.processedNowpaymentsTx.groupBy({ by: ["outcome"], _count: { _all: true } }),
  ]);

  const counts: Record<string, number> = {};
  for (const grouped of groups) {
    for (const g of grouped) counts[g.outcome] = (counts[g.outcome] ?? 0) + g._count._all;
  }
  return counts;
}

/**
 * Ledger rows of ANY outcome recorded today (the shop's `TIMEZONE` day, via
 * `startOfDayUtc` — the same "today" the dashboard uses) across all five
 * gateway tables. The Payments page's "Today's Transactions" tile: how many
 * payment records the gateways wrote today, not how many were delivered.
 * Counted in the database, so it is unaffected by ledger pagination.
 */
export async function countLedgerRowsToday(db: Db, now: Date = new Date()): Promise<number> {
  const where = { createdAt: { gte: startOfDayUtc(now) } };
  const counts = await Promise.all([
    db.processedBinanceTx.count({ where }),
    db.processedBybitTx.count({ where }),
    db.processedTokopayTx.count({ where }),
    db.processedPaydisiniTx.count({ where }),
    db.processedNowpaymentsTx.count({ where }),
  ]);
  return counts.reduce((sum, n) => sum + n, 0);
}

/**
 * The only ledger outcomes that mean "an admin still has to do something":
 * a payment nobody matched to an order, and a paid order whose delivery threw.
 * The `actionable` rule below is applied to these two alone — for `matched`,
 * `stale`, `dismissed` and the rest, "is its order still open?" says nothing
 * about pending work, so the flag leaves them alone.
 */
export const ACTIONABLE_LEDGER_OUTCOMES = ["unmatched", "delivery_failed"] as const;

function isActionableLedgerOutcome(outcome: string | null | undefined): boolean {
  return outcome != null && (ACTIONABLE_LEDGER_OUTCOMES as readonly string[]).includes(outcome);
}

/**
 * Order statuses that close out a `delivery_failed` / `unmatched` ledger row on
 * their own. Nothing ever rewrites a ledger row's `outcome` once the admin
 * fulfils the order by hand or refunds it, so the row itself cannot say
 * whether it still needs attention — its order's status can.
 *
 * CANCELLED is deliberately NOT here: a gateway settle whose delivery throws
 * rewrites only the ledger row to `delivery_failed` and leaves the order
 * PENDING_PAYMENT with no `paidAt`, so the expiry sweep (`autoCancelExpiredOrders`)
 * or the buyer can later cancel it — the buyer paid, got nothing, and the order
 * reads CANCELLED. A cancelled order closes its row only with proof the money
 * went back (see `cancelledOrderIdsWithMoneyReturned`).
 *
 * REJECTED (and every other status) stays actionable for the same reason: no
 * status other than these two proves the payment on the row was settled, and
 * an admin double-checking a resolved row is cheap while a paid-but-hidden row
 * is lost money.
 */
const RESOLVED_LEDGER_ORDER_STATUSES: string[] = [OrderStatus.DELIVERED, OrderStatus.REFUNDED];

/**
 * Of the given CANCELLED order ids, the ones with proof the buyer's money was
 * handed back after the cancel:
 *  - an `unfulfilled_credit` wallet movement for the order — what
 *    `creditOrderToBalance` writes when an admin credits a paid-but-unfulfilled
 *    order to the buyer's balance (and which then leaves it CANCELLED); or
 *  - a COMPLETED `Refund` for the order — a refund that was actually paid out.
 *    PENDING/PROCESSING refunds have not paid anyone yet, and FAILED/CANCELLED
 *    ones never will, so they prove nothing (the same line
 *    `refundableAmountForOrder` in ./refunds draws).
 * Wallet movements of other reasons do not count: `order_refund`, for one, is
 * just the `walletUsed` portion `releaseOrderHolds` returns on ANY cancel, not
 * the external payment the ledger row recorded.
 *
 * One batched query per evidence table over the whole id set, never one per row.
 */
export async function cancelledOrderIdsWithMoneyReturned(db: Db, cancelledIds: number[]): Promise<Set<number>> {
  if (cancelledIds.length === 0) return new Set();
  const [credits, refunds] = await Promise.all([
    db.walletTransaction.findMany({
      where: { orderId: { in: cancelledIds }, reason: "unfulfilled_credit" },
      select: { orderId: true },
    }),
    db.refund.findMany({
      where: { orderId: { in: cancelledIds }, status: RefundStatus.COMPLETED },
      select: { orderId: true },
    }),
  ]);
  const ids = new Set<number>();
  for (const c of credits) if (c.orderId != null) ids.add(c.orderId);
  for (const r of refunds) ids.add(r.orderId);
  return ids;
}

/** True when at least one of the five processed*Tx ledger tables has a row
 *  linked to this order whose outcome is one of `ACTIONABLE_LEDGER_OUTCOMES`
 *  (`delivery_failed` or `unmatched`) — proof a full gateway payment arrived
 *  for it and was never settled, independent of `Order.paidAt` (which a
 *  rolled-back delivery transaction can leave null even though money arrived —
 *  see the comment on creditOrderToBalance's CANCELLED path).
 *
 *  Only those two outcomes count because they are exactly what the
 *  CANCELLED-order credit exists to close out. Every other outcome has its own
 *  resolution path or owes nothing, and folding it in here would double- or
 *  over-credit: an `underpaid` row records only the PART that arrived, and its
 *  order resolves through `creditUnderpaidTopupAnyway` (which credits via
 *  `admin_adjust` and cancels — so the order then looks "paid, nothing returned
 *  yet") or the underpaid cancel/refund routes; a `matched`, `stale`,
 *  `dismissed` or `credited_to_balance` row was already settled or deliberately
 *  closed. Single-order form: used where one order is being looked at or acted
 *  on, never per list row. */
export async function orderHasIncomingLedgerPayment(db: Db, orderId: number): Promise<boolean> {
  const where = { orderId, outcome: { in: [...ACTIONABLE_LEDGER_OUTCOMES] } };
  const [binance, bybit, tokopay, paydisini, nowpayments] = await Promise.all([
    db.processedBinanceTx.findFirst({ where, select: { id: true } }),
    db.processedBybitTx.findFirst({ where, select: { id: true } }),
    db.processedTokopayTx.findFirst({ where, select: { id: true } }),
    db.processedPaydisiniTx.findFirst({ where, select: { id: true } }),
    db.processedNowpaymentsTx.findFirst({ where, select: { id: true } }),
  ]);
  return binance != null || bybit != null || tokopay != null || paydisini != null || nowpayments != null;
}

/** The enforcing form of `orderHasIncomingLedgerPayment`: re-tags every row in
 *  the five processed*Tx ledger tables linked to this order whose outcome is
 *  one of `ACTIONABLE_LEDGER_OUTCOMES` as `credited_to_balance`, and returns
 *  how many it re-tagged (0 = no proof a payment ever arrived).
 *
 *  Reading the evidence is not enough for a credit: a row left at
 *  `delivery_failed`/`unmatched` is still reclaimable by the gateways' own
 *  settle paths (QRIS_RECLAIMABLE_OUTCOMES / AMOUNT_MATCHED_RECLAIMABLE_OUTCOMES
 *  in ./binance_internal), so a duplicate callback or a later amount-match
 *  would pay the same money out a second time. `credited_to_balance` is in
 *  neither reclaimable set. Each `UPDATE ... WHERE outcome IN (...)` row-locks
 *  what it matches, so a concurrent reclaim of the same row serialises against
 *  the caller's transaction and, once this commits, no longer matches its own
 *  outcome gate. Must run inside the caller's transaction (the credit it
 *  justifies has to roll back with it). Sequential on purpose — one
 *  interactive transaction runs one statement at a time anyway. */
export async function consumeIncomingLedgerPayment(db: Db, orderId: number): Promise<number> {
  const where = { orderId, outcome: { in: [...ACTIONABLE_LEDGER_OUTCOMES] } };
  const data = { outcome: "credited_to_balance" };
  let consumed = 0;
  consumed += (await db.processedBinanceTx.updateMany({ where, data })).count;
  consumed += (await db.processedBybitTx.updateMany({ where, data })).count;
  consumed += (await db.processedTokopayTx.updateMany({ where, data })).count;
  consumed += (await db.processedPaydisiniTx.updateMany({ where, data })).count;
  consumed += (await db.processedNowpaymentsTx.updateMany({ where, data })).count;
  return consumed;
}

/**
 * Builds the one rule shared by `actionableLedgerOutcomeCounts` and
 * `listCombinedLedger`'s `actionable` filter, so the dashboard card and the
 * Payments list it links to agree. Given the statuses of every order the rows
 * reference, returns a predicate over a row's `orderId`: true when the row is
 * still work for an admin. A row with no order, or whose order no longer
 * exists, still needs a human.
 */
async function actionableLedgerRowPredicate(
  db: Db,
  statusById: ReadonlyMap<number, string>,
): Promise<(orderId: number | null) => boolean> {
  const cancelledIds = [...statusById].filter(([, s]) => s === OrderStatus.CANCELLED).map(([id]) => id);
  const settledCancelled = await cancelledOrderIdsWithMoneyReturned(db, cancelledIds);
  return (orderId) => {
    if (orderId == null) return true;
    const status = statusById.get(orderId);
    if (status === undefined) return true;
    if (RESOLVED_LEDGER_ORDER_STATUSES.includes(status)) return false;
    if (status === OrderStatus.CANCELLED) return !settledCancelled.has(orderId);
    return true;
  };
}

/**
 * Like `ledgerOutcomeCounts`, but only rows that still need an admin: a row
 * counts unless its order is DELIVERED or REFUNDED, or CANCELLED with proof the
 * money was returned (`actionableLedgerRowPredicate`, the same rule
 * `listCombinedLedger`'s `actionable` filter applies).
 *
 * Pass `onlyOutcomes` (normally `ACTIONABLE_LEDGER_OUTCOMES`) to read just
 * those outcomes; without it every ledger row is scanned and the rule applied
 * to every outcome, which is only meaningful for the two actionable ones.
 *
 * None of the five ledger tables has a Prisma relation to `Order` (a bare
 * `orderId` column only), so this is: fetch the rows' order ids, ONE
 * `order.findMany` for their statuses, then one batched evidence lookup for the
 * cancelled ones.
 */
export async function actionableLedgerOutcomeCounts(
  db: Db,
  onlyOutcomes?: readonly string[],
): Promise<Record<string, number>> {
  const args = {
    ...(onlyOutcomes ? { where: { outcome: { in: [...onlyOutcomes] } } } : {}),
    select: { outcome: true, orderId: true },
  };
  const tables = await Promise.all([
    db.processedBinanceTx.findMany(args),
    db.processedBybitTx.findMany(args),
    db.processedTokopayTx.findMany(args),
    db.processedPaydisiniTx.findMany(args),
    db.processedNowpaymentsTx.findMany(args),
  ]);
  const rows = tables.flat();

  const orderIds = [...new Set(rows.map((r) => r.orderId).filter((id): id is number => id != null))];
  const orders = orderIds.length
    ? await db.order.findMany({ where: { id: { in: orderIds } }, select: { id: true, status: true } })
    : [];
  const isActionable = await actionableLedgerRowPredicate(db, new Map(orders.map((o) => [o.id, o.status])));

  const counts: Record<string, number> = {};
  for (const r of rows) {
    if (!isActionable(r.orderId)) continue;
    counts[r.outcome] = (counts[r.outcome] ?? 0) + 1;
  }
  return counts;
}

/**
 * The dashboard's cross-provider "Pending actions" figures: `unmatched` /
 * `delivery_failed` ledger rows across all five gateway tables that still need
 * an admin (see `actionableLedgerOutcomeCounts`).
 */
export async function actionableManualMatchQueueCounts(db: Db): Promise<ManualMatchQueueCounts> {
  const counts = await actionableLedgerOutcomeCounts(db, ACTIONABLE_LEDGER_OUTCOMES);
  return { unmatched: counts["unmatched"] ?? 0, deliveryFailed: counts["delivery_failed"] ?? 0 };
}

/**
 * The Payments page's tile and outcome-dropdown counts. Without `actionable`
 * this is the lifetime `ledgerOutcomeCounts`. With it, only the two
 * `ACTIONABLE_LEDGER_OUTCOMES` are replaced by their actionable figures —
 * always set, 0 when every such row is resolved, so a stale lifetime figure can
 * never show through — and every other outcome keeps its lifetime count, the
 * same way `listCombinedLedger` ignores the flag for those outcomes. So each
 * count equals the list total for that outcome under the same flag.
 */
export async function ledgerOutcomeCountsForView(db: Db, actionable: boolean): Promise<Record<string, number>> {
  if (!actionable) return ledgerOutcomeCounts(db);
  const [lifetime, pending] = await Promise.all([
    ledgerOutcomeCounts(db),
    actionableLedgerOutcomeCounts(db, ACTIONABLE_LEDGER_OUTCOMES),
  ]);
  const counts = { ...lifetime };
  for (const outcome of ACTIONABLE_LEDGER_OUTCOMES) counts[outcome] = pending[outcome] ?? 0;
  return counts;
}

/**
 * The five gateway ledger tables `ledgerOutcomeCounts`/`listCombinedLedger`
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
  /** `Order.status` of the order this row points at, null like `orderCode`.
   *  Lets the Payments list show at a glance whether a delivery_failed /
   *  unmatched row's order is already closed out (e.g. CANCELLED) without
   *  opening it. */
  orderStatus: string | null;
}

export interface CombinedLedgerFilter {
  outcome?: string | null;
  q?: string | null;
  /** Filter to one `Order.kind` ("PRODUCT" | "WALLET_TOPUP"). Rows with no
   *  order are excluded by any non-null value here — they belong to neither
   *  kind. Applied in JS after the order join, because `kind` lives on
   *  `Order` and none of the five ledger tables carry it. */
  kind?: string | null;
  /** Drop rows that no longer need an admin — order DELIVERED or REFUNDED, or
   *  CANCELLED with proof the money was returned — the same rule
   *  `actionableManualMatchQueueCounts` counts by, so the dashboard's
   *  "Pending actions" card and this list agree. Rows with no order (or a
   *  deleted one) are kept. Only takes effect when `outcome` is one of
   *  `ACTIONABLE_LEDGER_OUTCOMES`; with any other (or no) outcome filter the
   *  rows are returned unchanged. Applied in JS after the order join, like
   *  `kind`. */
  actionable?: boolean;
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
 * mirroring `ledgerOutcomeCounts`'s query-every-table-combine-in-JS
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
 * requested page. So it grows with the ledger too, and it does not
 * merely get slower — the `IN (...)` list grows with the number of distinct
 * orders. That growth, not the sort cost, is the real deadline for the
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
  // `orderCode`/`orderKind`/`orderStatus` are filled in from the single order
  // query below.
  type PreJoinRow = Omit<UnifiedLedgerRow, "orderCode" | "orderKind" | "orderStatus">;
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
    ? await db.order.findMany({
        where: { id: { in: orderIds } },
        select: { id: true, orderCode: true, kind: true, status: true },
      })
    : [];
  const orderById = new Map(orders.map((o) => [o.id, o]));

  // `actionable` only means something for the two outcomes that are admin work
  // (see `ACTIONABLE_LEDGER_OUTCOMES`); for any other outcome filter, or none,
  // the flag leaves the rows alone.
  let kept = merged;
  if (opts.actionable && isActionableLedgerOutcome(opts.outcome)) {
    const isActionable = await actionableLedgerRowPredicate(db, new Map(orders.map((o) => [o.id, o.status])));
    kept = merged.filter((r) => isActionable(r.orderId));
  }

  let joined: UnifiedLedgerRow[] = kept.map((r) => {
    const order = r.orderId != null ? orderById.get(r.orderId) : undefined;
    return {
      ...r,
      orderCode: order?.orderCode ?? null,
      orderKind: order?.kind ?? null,
      orderStatus: order?.status ?? null,
    };
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
    // Narrowed to exactly what this function and its one caller
    // (apps/web-admin/src/routes/api/dashboard.ts's /api/dashboard/expirations)
    // read off the rows — see task-9-report.md for the caller trace.
    select: {
      warrantyDaysSnapshot: true,
      product: { select: { name: true } },
      order: {
        select: {
          id: true,
          orderCode: true,
          deliveredAt: true,
          user: { select: { username: true, telegramId: true } },
        },
      },
    },
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
