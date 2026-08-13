/**
 * CRUD for the Binance Internal Transfer (UID-based) payment method.
 *
 * Idempotency on SQLite: there is no `SELECT ... FOR UPDATE`. Instead, the
 * `processed_binance_tx.binance_tx_id` UNIQUE constraint is the concurrency
 * gate — claiming a tx id is an atomic insert; a duplicate insert throws and is
 * treated as "already processed". Combined with SQLite's single-writer
 * serialization + busy_timeout, this prevents double-delivery without locks.
 */
import { config } from "@app/core/config";
import { OrderStatus, OrderCurrency, OrderKind, PaymentMethod } from "@app/core/enums";
import { Decimal } from "@app/core/money";
import { logger } from "@app/core/logger";
import { ValidationError } from "@app/core/errors";
import { startOfDayUtc } from "@app/core/datetime";
import type { ProcessedBinanceTx } from "@prisma/client";
import type { PrismaClient, Tx } from "../client";
import type { Db } from "./_types";
import { isUniqueViolation } from "./_types";
import {
  getOrder,
  createOrderDirect,
  approveOrder,
  settlePaidOrder,
  applyUsdtWalletToOrder,
  ORDER_USER_SELECT,
  type SettleResult,
} from "./orders";
import { transitionOrderStatus } from "./orderStatus";
import { adjustWallet } from "./users";
import { getSetting, setSetting } from "./settings";
import { finalizeOrderPayment } from "./pricing";
import { parseMinAmount } from "./_minAmount";
import { enqueueAdminOverpaid } from "./notifications";
import { settleWalletTopup } from "./wallet_topup";
import { POLL_HEALTH_KEYS, getPollHealth, recordPollHealth, type PollHealth } from "./poll_health";

// ---------------------------------------------------------------------------
// Resolved config (web-admin Settings win; .env is the bootstrap/recovery
// fallback, plan.md §16). Read per-request/per-poll so an edit in /settings
// takes effect on the next cycle without a restart (like Bybit/TokoPay).
// ---------------------------------------------------------------------------

export const BINANCE_UID_KEY = "binance_receive_uid";
export const BINANCE_API_KEY_KEY = "binance_api_key";
export const BINANCE_API_SECRET_KEY = "binance_api_secret";
// On/off toggle (web admin). Default ON: only the literal "false" disables.
export const BINANCE_INTERNAL_ENABLED_KEY = "binance_internal_enabled";
// Minimum-payment-amount note shown at checkout (USDT) — blank = no note.
export const BINANCE_INTERNAL_MIN_AMOUNT_KEY = "binance_internal_min_amount";

export interface BinanceInternalConfig {
  /** True only when receiveUid + apiKey + apiSecret are all present. */
  enabled: boolean;
  receiveUid: string;
  apiKey: string;
  apiSecret: string;
  apiBase: string;
  /** Official Binance mirror hosts tried, in order, only after apiBase's own
   * retry budget is exhausted within one poll cycle. Empty = no fallback
   * (today's behavior). Env-only — never web-editable. */
  apiBaseFallbacks: string[];
  currency: string;
  pollIntervalSeconds: number;
  windowMinutes: number;
  minAmount: Decimal | null;
}

/** First non-empty (trimmed) value, else "". DB value wins over the env fallback. */
function pick(dbVal: string | null, envVal?: string): string {
  const a = (dbVal ?? "").trim();
  if (a) return a;
  return (envVal ?? "").trim();
}

/**
 * Resolve the Binance Internal Transfer config from Settings (with .env
 * fallback). `enabled` gates the poller, the watchdog, and the checkout
 * option. The API base, its fallback mirror list, currency, poll interval,
 * and payment window stay env-only (rarely change); only the receive UID and
 * the API key/secret are web-editable.
 */
export async function resolveBinanceInternalConfig(db: Db): Promise<BinanceInternalConfig> {
  const [uid, key, secret, flag, minAmountSetting] = await Promise.all([
    getSetting(db, BINANCE_UID_KEY),
    getSetting(db, BINANCE_API_KEY_KEY),
    getSetting(db, BINANCE_API_SECRET_KEY),
    getSetting(db, BINANCE_INTERNAL_ENABLED_KEY),
    getSetting(db, BINANCE_INTERNAL_MIN_AMOUNT_KEY),
  ]);
  const receiveUid = pick(uid, config.BINANCE_RECEIVE_UID);
  const apiKey = pick(key, config.BINANCE_API_KEY);
  const apiSecret = pick(secret, config.BINANCE_API_SECRET);
  return {
    // Default ON: an unset/empty flag means enabled; only the literal "false"
    // (trimmed, case-insensitive) disables the method without touching creds.
    enabled: Boolean(receiveUid && apiKey && apiSecret) && (flag ?? "").trim().toLowerCase() !== "false",
    receiveUid,
    apiKey,
    apiSecret,
    apiBase: config.BINANCE_API_BASE,
    apiBaseFallbacks: config.BINANCE_API_BASE_FALLBACKS.split(",").map((s) => s.trim()).filter(Boolean),
    currency: config.CURRENCY,
    pollIntervalSeconds: config.POLL_INTERVAL_SECONDS,
    windowMinutes: config.INTERNAL_PAYMENT_WINDOW_MINUTES,
    minAmount: parseMinAmount(minAmountSetting),
  };
}

/**
 * Create a direct order, then stamp it as a USDT/Binance-Internal payment:
 * the central-IDR total converts once at `rate` (rounded 0.1) + unique cents,
 * with a unique transfer note and the short auto-confirm window (plan.md §15.4).
 */
export async function createInternalOrder(
  db: Db,
  args: {
    user: { id: number; role: string };
    productId: number;
    quantity: number;
    voucherCode?: string | null;
    /** Rupiah per 1 USDT (usd_idr_rate) — required for the USDT path. */
    rate: Decimal.Value;
    /** Optional USDT credit balance to spend on this order (clamped to total). */
    walletAmount?: Decimal.Value;
    /** Stringified JSON of the buyer's manual_with_info answers (validated by
     * the caller). Forwarded verbatim to createOrderDirect; null otherwise. */
    customerData?: string | null;
  },
) {
  const { walletAmount, rate, ...baseArgs } = args;
  const created = await createOrderDirect(db, baseArgs);
  if (!created) return null;
  const finalized = await finalizeOrderPayment(db, created.id, {
    currency: OrderCurrency.USDT,
    rate,
    method: PaymentMethod.BINANCE_INTERNAL,
  });
  // Spend the USDT credit balance against the finalized USDT total (no-op when
  // walletAmount is unset). Re-read so callers see the updated walletUsed/total.
  await applyUsdtWalletToOrder(db, created.id, walletAmount);
  return walletAmount != null ? getOrder(db, created.id) : finalized;
}

/** Remember which message holds the payment instructions, so the poller can edit it. */
export async function setOrderPaymentMessage(db: Db, orderId: number, chatId: number | bigint, messageId: number) {
  await db.order.update({
    where: { id: orderId },
    data: { paymentMsgChatId: BigInt(chatId), paymentMsgId: messageId },
  });
}

/** Clear the anchored payment-message pointer (idempotency gate for the success sweep). */
export async function clearOrderPaymentMessage(db: Db, orderId: number): Promise<void> {
  await db.order.update({ where: { id: orderId }, data: { paymentMsgChatId: null, paymentMsgId: null } });
}

/** DELIVERED orders of `method` that still carry an un-edited payment-message
 * anchor, oldest first. `limit`, when given, caps how many rows come back —
 * the QRIS reconcile pollers (TokoPay/PayDisini) pass a bound so one cycle's
 * sweep of grammY edit calls stays bounded regardless of backlog size, the
 * same reasoning as `listPendingTokopayOrders`' own `limit` (Task 11 review
 * follow-up, Important #2); omitted, every other caller keeps today's
 * unbounded behavior. */
export function listDeliveredOrdersAwaitingEdit(db: Db, method: PaymentMethod, limit?: number) {
  return db.order.findMany({
    where: {
      status: OrderStatus.DELIVERED,
      paymentMethod: method,
      paymentMsgChatId: { not: null },
      paymentMsgId: { not: null },
    },
    include: { user: true },
    orderBy: { createdAt: "asc" },
    ...(limit != null ? { take: limit } : {}),
  });
}

/** PENDING, not-yet-expired internal-transfer orders the poller should match
 * against. Also the direct data source for web-admin's Payments page
 * "pending internal transfers" list (apps/web-admin/src/routes/api/
 * payments.ts spreads these straight into JSON) — `user` is therefore
 * projected through orders.ts's ORDER_USER_SELECT, never `include: { user:
 * true }`, so a raw passwordHash/email can't ship in that response
 * (backend audit finding H-4). */
export function listPendingInternalOrders(db: Db, now: Date) {
  return db.order.findMany({
    where: {
      status: OrderStatus.PENDING_PAYMENT,
      paymentMethod: PaymentMethod.BINANCE_INTERNAL,
      paymentRef: { not: null },
      expiresAt: { gt: now },
    },
    include: { user: { select: ORDER_USER_SELECT } },
  });
}

export type DeliverResult =
  | { status: "delivered"; order: NonNullable<Awaited<ReturnType<typeof getOrder>>>; credentials: string[] }
  | { status: "processing"; order: NonNullable<Awaited<ReturnType<typeof getOrder>>> }
  | { status: "already_processed" }
  | { status: "stale" };

/**
 * Idempotently confirm + deliver a matched internal-transfer order.
 * Claims the Binance tx id (UNIQUE gate) then runs the normal approve/deliver
 * path. Returns "already_processed" if the tx was seen before, "stale" if the
 * order is no longer awaiting payment (delivered/expired elsewhere).
 */
export async function deliverPaidInternalOrder(
  db: PrismaClient,
  args: { orderId: number; binanceTxId: string; amount: Decimal.Value },
): Promise<DeliverResult> {
  // 1. Claim the tx id. A duplicate normally means another cycle already
  //    handled it — UNLESS the prior claim's outcome is one of
  //    NON_DELIVERING_OUTCOMES ("delivery_failed" or "unmatched"): neither of
  //    those ever actually delivered anything, so the tx id must stay
  //    re-claimable, or the buyer's payment is silently lost forever behind a
  //    stuck idempotency row (delivery_failed: H-3, backend audit
  //    2026-07-31; unmatched: Task 15). The read-then-update runs inside its
  //    own short $transaction so SQLite serializes the pair atomically: if
  //    two retries race, exactly one transaction sees a still-matching
  //    outcome and reclaims it; the other sees none and correctly reports
  //    already_processed. `reclaimedFrom` remembers exactly what the reclaim
  //    overwrote (outcome/orderId/amount) so step 2 can put it back if this
  //    turns out to be a stale match — unlike the three QRIS rails, one
  //    Binance transfer can be re-tried against ANY pending order by amount,
  //    so a reclaim that turns out stale here must not strand the row
  //    outside the manual-match queue (Task 15 review, Important #1).
  let reclaimedFrom: Pick<ProcessedBinanceTx, "outcome" | "orderId" | "amount"> | null = null;
  try {
    await db.processedBinanceTx.create({
      data: { binanceTxId: args.binanceTxId, orderId: args.orderId, amount: new Decimal(args.amount), outcome: "matched" },
    });
  } catch (e) {
    if (!isUniqueViolation(e)) throw e;
    reclaimedFrom = await db.$transaction(async (tx: Tx) => {
      const prior = await tx.processedBinanceTx.findUnique({ where: { binanceTxId: args.binanceTxId } });
      if (!prior || !(NON_DELIVERING_OUTCOMES as readonly string[]).includes(prior.outcome)) return null;
      await tx.processedBinanceTx.update({
        where: { binanceTxId: args.binanceTxId },
        data: { orderId: args.orderId, amount: new Decimal(args.amount), outcome: "matched" },
      });
      return { outcome: prior.outcome, orderId: prior.orderId, amount: prior.amount };
    });
    if (!reclaimedFrom) return { status: "already_processed" };
  }

  // 2. Deliver. On failure, flag the ledger row so we don't silently retry
  //    forever (e.g. paid but out of stock) and let the caller alert an admin.
  try {
    return await db.$transaction(async (tx: Tx) => {
      const order = await getOrder(tx, args.orderId);
      if (!order || order.status !== OrderStatus.PENDING_PAYMENT) {
        // If step 1 re-claimed this row from a non-delivering outcome, undo
        // that claim — restore the outcome/orderId/amount it overwrote —
        // instead of leaving the row "matched" against an order that never
        // got delivered. Left as "matched", the transfer would become
        // permanently unreachable: "matched" is excluded from
        // NON_DELIVERING_OUTCOMES (so it can never be re-claimed again), and
        // both manualMatchTx and dismissUnmatchedTx refuse anything whose
        // outcome isn't "unmatched" — an admin's own recovery tooling would
        // refuse the very row their alert points at. A fresh claim
        // (reclaimedFrom === null) has nothing to undo — that row simply
        // stays "matched" against this now-stale order, the same pre-existing
        // behavior as before Task 15 and out of scope here (see the "tx
        // already delivered is never re-claimed" test).
        if (reclaimedFrom) {
          await tx.processedBinanceTx.update({
            where: { binanceTxId: args.binanceTxId },
            data: { outcome: reclaimedFrom.outcome, orderId: reclaimedFrom.orderId, amount: reclaimedFrom.amount },
          });
        }
        return { status: "stale" as const };
      }
      if (order.kind === OrderKind.WALLET_TOPUP) {
        const { order: settled } = await settleWalletTopup(tx, args.orderId, { amount: args.amount });
        // No outbox enqueue here (unlike TokoPay/PayDisini/NOWPayments): this
        // function only ever runs inside the bot process's own internal-
        // transfer poller (never a web request), so the buyer is DM'd
        // directly by that poller's `onDelivered` handler
        // (apps/order-bot/src/payments/binanceInternal.ts) right after this
        // call returns — enqueueing to the outbox here too would double-notify.
        logger.info(`Auto-delivered internal-transfer wallet top-up order ${settled.orderCode} for Binance transaction ${args.binanceTxId}`);
        return { status: "delivered" as const, order: settled, credentials: [] };
      }
      await tx.order.update({
        where: { id: args.orderId },
        data: { binanceTxid: args.binanceTxId, paidAt: new Date() },
      });
      await transitionOrderStatus(tx, {
        orderId: args.orderId,
        from: OrderStatus.PENDING_PAYMENT,
        to: OrderStatus.PENDING_VERIFICATION,
        meta: `binanceTxId=${args.binanceTxId}`,
      });
      const result = await settlePaidOrder(tx, args.orderId, { adminId: 0 });
      // Overpayment: the buyer sent more USDT than the order total. Still
      // deliver (handled above) but flag the ledger row and alert admins so
      // the excess can be refunded/credited manually — never auto-refunded.
      // Mirrors TokoPay/PayDisini/NOWPayments (M-13, backend audit
      // 2026-07-31): Binance Internal's match tolerance already lets an
      // overpaid transfer through to delivery, but until now it left no
      // ledger flag and no admin alert, so the excess had no operational
      // trail for a later refund request.
      const paidAmount = new Decimal(args.amount);
      const excess = paidAmount.minus(order.totalAmount);
      if (excess.greaterThan(0)) {
        await tx.processedBinanceTx.update({ where: { binanceTxId: args.binanceTxId }, data: { outcome: "overpaid" } });
        await enqueueAdminOverpaid(tx, {
          orderId: result.order.id,
          orderCode: result.order.orderCode,
          paid: paidAmount,
          expected: order.totalAmount,
          excess,
          currency: order.currency,
        });
        logger.warn(
          `Binance Internal order ${result.order.orderCode} was overpaid — got ${paidAmount.toString()}, expected ${order.totalAmount.toString()} (excess ${excess.toString()} ${order.currency}) — flagged for manual refund/credit, an admin alert was enqueued`,
        );
      }
      if (result.kind === "delivered") {
        logger.info(`Auto-delivered internal-transfer order ${result.order.orderCode} for Binance transaction ${args.binanceTxId}`);
        return { status: "delivered" as const, order: result.order, credentials: result.credentials };
      }
      logger.info(`Internal-transfer order ${result.order.orderCode} paid — queued for manual fulfilment (Binance transaction ${args.binanceTxId})`);
      return { status: "processing" as const, order: result.order };
    }, { timeout: 15000 });
  } catch (e) {
    await db.processedBinanceTx
      .update({ where: { binanceTxId: args.binanceTxId }, data: { outcome: "delivery_failed" } })
      .catch(() => undefined);
    throw e;
  }
}

/** Note matched but amount short: flag UNDERPAID for admin review (idempotent). */
export async function markUnderpaid(
  db: Db,
  args: { orderId: number; binanceTxId: string; amount: Decimal.Value },
): Promise<boolean> {
  try {
    await db.processedBinanceTx.create({
      data: { binanceTxId: args.binanceTxId, orderId: args.orderId, amount: new Decimal(args.amount), outcome: "underpaid" },
    });
  } catch (e) {
    if (isUniqueViolation(e)) return false;
    throw e;
  }
  await db.order.update({
    where: { id: args.orderId },
    data: {
      binanceTxid: args.binanceTxId,
      adminNote: `[underpaid] received ${new Decimal(args.amount).toString()} via tx ${args.binanceTxId}`,
    },
  });
  await transitionOrderStatus(db, {
    orderId: args.orderId,
    from: OrderStatus.PENDING_PAYMENT,
    to: OrderStatus.UNDERPAID,
    meta: `binanceTxId=${args.binanceTxId}`,
  });
  return true;
}

/** A transfer that matched no PENDING order — record once for manual review. */
export async function recordUnmatchedTx(db: Db, args: { binanceTxId: string; amount: Decimal.Value }): Promise<boolean> {
  try {
    await db.processedBinanceTx.create({
      data: { binanceTxId: args.binanceTxId, amount: new Decimal(args.amount), outcome: "unmatched" },
    });
    return true;
  } catch (e) {
    if (isUniqueViolation(e)) return false;
    throw e;
  }
}

// ===========================================================================
// Ops panel (web-admin /payments) — ledger, UNDERPAID resolution, manual match,
// poller health. `processed_binance_tx` has no Prisma relation to `orders`
// (orderId is a bare FK-less column), so order rows are stitched in by id here.
// ===========================================================================

/** Known ledger outcomes, in the order the ops panel lists them. */
export const TX_OUTCOMES = [
  "matched",
  "overpaid",
  "underpaid",
  "unmatched",
  "delivery_failed",
  "credited_to_balance",
  "dismissed",
] as const;
export type TxOutcome = (typeof TX_OUTCOMES)[number];

/** Outcomes that never delivered anything, so the trx/tx id they're stamped
 * on must stay re-claimable by a later callback/poller pass — otherwise a
 * real payment that merely arrived while its order was temporarily
 * un-matchable (wrong method/currency, a short payment later topped up) gets
 * permanently stuck behind the trxId UNIQUE gate (Task 15). The terminal set
 * that must NEVER be re-claimable *includes* "matched", "overpaid", and
 * "stale" (each means a delivery attempt actually ran, so re-claiming risks
 * a second attempt racing/duplicating a settlement that already happened) —
 * but it is not exactly the complement of NON_DELIVERING_OUTCOMES:
 * TX_OUTCOMES below also lists "underpaid", "credited_to_balance", and
 * "dismissed", which are equally terminal/non-re-claimable but out of this
 * fix's scope (see the "underpaid" note below).
 *
 * "stale" is deliberately NOT a member of TX_OUTCOMES: it's a QRIS-only
 * label — tokopay.ts/paydisini.ts/nowpayments.ts each stamp their ledger row
 * "stale" (through `tx`, inside the $transaction) when the trxId's order is
 * no longer PENDING_PAYMENT, because on those rails a trxId binds 1:1 to one
 * order, so "stale" there just means that order already left
 * PENDING_PAYMENT. deliverPaidInternalOrder never stamps "stale": it matches
 * one transfer against ANY pending order by amount, so a stale outcome here
 * can follow a genuine re-claim — instead of a generic terminal label, the
 * stale branch restores the exact outcome/orderId/amount the re-claim
 * overwrote, keeping the row in the manual-match queue rather than
 * stranding it as an unreachable "matched" (Task 15 review, Important #1).
 *
 * bybit_deposit.ts and bybit_bsc_deposit.ts do NOT use this set yet — they
 * still gate re-claim on the narrower `outcome: "delivery_failed"` alone.
 * Their trxId binds 1:1 to one order like the QRIS rails, so the same
 * widening applies there too; folding them into NON_DELIVERING_OUTCOMES is
 * deliberately deferred to the next task, not an oversight here.
 *
 * "underpaid" (written by markUnderpaid below) was considered and left out
 * on purpose: nothing is delivered for it either, so by this fix's own logic
 * that trxId is blocked the same way — but it already has its own admin
 * recovery path (UNDERPAID order status → deliver-anyway or refund-to-wallet)
 * that doesn't depend on the trxId ever being re-claimable, so it isn't the
 * same money-loss shape this fix addresses. */
export const NON_DELIVERING_OUTCOMES = ["unmatched", "delivery_failed"] as const;

type LinkedOrder = { id: number; orderCode: string; status: string; totalAmount: Decimal };

/** Ledger rows (newest first), each enriched with its linked order (if any). */
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

/** Count of ledger rows per outcome — drives the summary cards. */
export async function processedTxOutcomeCounts(db: Db): Promise<Record<string, number>> {
  const grouped = await db.processedBinanceTx.groupBy({ by: ["outcome"], _count: { _all: true } });
  const counts: Record<string, number> = {};
  for (const g of grouped) counts[g.outcome] = g._count._all;
  return counts;
}

/** Count of ledger rows created today (shop's configured TIMEZONE), for the
 *  Payments page's "Today's Transactions" KPI — always accurate regardless
 *  of ledger pagination, unlike counting rows on the current page. */
export function countProcessedBinanceTxToday(db: Db, now: Date = new Date()): Promise<number> {
  return db.processedBinanceTx.count({ where: { createdAt: { gte: startOfDayUtc(now) } } });
}

/** The amount actually received for an UNDERPAID order, from its ledger row. */
async function underpaidReceived(db: Db, orderId: number): Promise<Decimal | null> {
  const row = await db.processedBinanceTx.findFirst({
    where: { orderId, outcome: "underpaid" },
    orderBy: { createdAt: "desc" },
  });
  return row?.amount != null ? new Decimal(row.amount) : null;
}

/**
 * Resolve UNDERPAID by delivering anyway (operator eats the shortfall).
 * Flips UNDERPAID → PENDING_VERIFICATION then runs the normal approve/deliver
 * path (allocates stock, enqueues the testimoni outbox row). Same shape as
 * deliverPaidInternalOrder so the caller can show credentials.
 */
export async function deliverUnderpaidOrder(
  db: PrismaClient,
  args: { orderId: number; adminId: number },
): Promise<{ order: NonNullable<Awaited<ReturnType<typeof getOrder>>>; credentials: string[] }> {
  return db.$transaction(async (tx: Tx) => {
    const order = await getOrder(tx, args.orderId);
    if (!order) throw new ValidationError("error.order_not_found");
    if (order.status !== OrderStatus.UNDERPAID) {
      throw new ValidationError("error.order_not_underpaid");
    }
    await tx.order.update({
      where: { id: args.orderId },
      data: { paidAt: new Date() },
    });
    await transitionOrderStatus(tx, {
      orderId: args.orderId,
      from: OrderStatus.UNDERPAID,
      to: OrderStatus.PENDING_VERIFICATION,
      meta: `deliver_underpaid_anyway by admin_id=${args.adminId}`,
    });
    // NOTE: a manual-delivery SKU CAN reach UNDERPAID (markUnderpaid triggers
    // purely on received-amount vs order-total, independent of deliveryType)
    // — but this path deliberately stays on approveOrder, not settlePaidOrder.
    // For a manual SKU that means approveOrder's stock-allocation step throws
    // error.cannot_deliver_out_of_stock (no stock was ever reserved for it),
    // failing closed: the admin sees a clear error and can refund instead of
    // "delivering anyway." Accepted scope exclusion — see the per-SKU
    // delivery flows plan — not a silent gap.
    const { order: delivered, credentials } = await approveOrder(tx, args.orderId, { adminId: args.adminId });
    logger.info(`Underpaid order ${delivered.orderCode} delivered anyway by admin ${args.adminId} — operator absorbed the shortfall`);
    return { order: delivered, credentials };
  });
}

/**
 * Resolve UNDERPAID by refunding the received USDT to the buyer's wallet and
 * marking the order REFUNDED. Rolls back voucher usage so reconciliation stays
 * clean. (UNDERPAID orders never reserved stock, so there is nothing to release.)
 */
export async function refundUnderpaidOrder(
  db: PrismaClient,
  args: { orderId: number; adminId: number },
): Promise<{ refunded: Decimal }> {
  return db.$transaction(async (tx: Tx) => {
    const order = await getOrder(tx, args.orderId);
    if (!order) throw new ValidationError("error.order_not_found");
    if (order.status !== OrderStatus.UNDERPAID) {
      throw new ValidationError("error.order_not_underpaid");
    }
    const received = (await underpaidReceived(tx, args.orderId)) ?? new Decimal(0);
    if (received.greaterThan(0)) {
      await adjustWallet(tx, order.userId, received, { reason: "underpaid_refund", orderId: order.id, adminId: args.adminId });
    }
    if (order.voucherId) {
      const v = await tx.voucher.findUnique({ where: { id: order.voucherId } });
      if (v && v.usedCount > 0) {
        await tx.voucher.update({ where: { id: v.id }, data: { usedCount: { decrement: 1 } } });
      }
    }
    await tx.order.update({
      where: { id: args.orderId },
      data: {
        adminNote: `${order.adminNote ?? ""}\n[refund] ${received.toString()} to wallet by admin_id=${args.adminId}`,
      },
    });
    await transitionOrderStatus(tx, {
      orderId: args.orderId,
      from: OrderStatus.UNDERPAID,
      to: OrderStatus.REFUNDED,
      meta: `refund ${received.toString()} by admin_id=${args.adminId}`,
    });
    logger.info(`Refunded underpaid order ${order.orderCode} (${received.toString()}) to wallet by admin ${args.adminId}`);
    return { refunded: received };
  });
}

/**
 * Manually attach an UNMATCHED transfer to a PENDING internal-transfer order
 * (buyer forgot the note) and run the same deliver path. Updates the existing
 * ledger row (it was already claimed as "unmatched") rather than inserting,
 * so the binance_tx_id UNIQUE gate is never tripped.
 */
export async function manualMatchTx(
  db: PrismaClient,
  args: { binanceTxId: string; orderId: number; adminId: number },
): Promise<SettleResult> {
  return db.$transaction(async (tx: Tx) => {
    const ledger = await tx.processedBinanceTx.findUnique({ where: { binanceTxId: args.binanceTxId } });
    if (!ledger) throw new ValidationError("error.tx_not_found");
    if (ledger.outcome !== "unmatched") throw new ValidationError("error.tx_not_unmatched");

    const order = await getOrder(tx, args.orderId);
    if (!order) throw new ValidationError("error.order_not_found");
    if (order.status !== OrderStatus.PENDING_PAYMENT) {
      throw new ValidationError("error.order_not_pending");
    }

    await tx.processedBinanceTx.update({
      where: { binanceTxId: args.binanceTxId },
      data: { orderId: args.orderId, outcome: "matched" },
    });
    await tx.order.update({
      where: { id: args.orderId },
      data: {
        binanceTxid: args.binanceTxId,
        paidAt: new Date(),
      },
    });
    await transitionOrderStatus(tx, {
      orderId: args.orderId,
      from: OrderStatus.PENDING_PAYMENT,
      to: OrderStatus.PENDING_VERIFICATION,
      meta: `manual_match binanceTxId=${args.binanceTxId} by admin_id=${args.adminId}`,
    });
    const result = await settlePaidOrder(tx, args.orderId, { adminId: args.adminId });
    logger.info(`Manually matched Binance transaction ${args.binanceTxId} to order ${result.order.orderCode} by admin ${args.adminId}`);
    return result;
  });
}

/**
 * Acknowledge an UNMATCHED transfer that belongs to no order (e.g. a test
 * deposit, or money sent with no order behind it): flip its ledger row
 * unmatched → dismissed so it stops showing up as an open problem. The row is
 * kept (auditable, still listable under the "dismissed" filter); only rows that
 * are currently `unmatched` can be dismissed.
 */
export async function dismissUnmatchedTx(db: Db, binanceTxId: string): Promise<void> {
  const ledger = await db.processedBinanceTx.findUnique({ where: { binanceTxId } });
  if (!ledger) throw new ValidationError("error.tx_not_found");
  if (ledger.outcome !== "unmatched") throw new ValidationError("error.tx_not_unmatched");
  await db.processedBinanceTx.update({
    where: { binanceTxId },
    data: { outcome: "dismissed" },
  });
}

// ---- Poller heartbeat (written by the order-bot poller, read by the web) ----
// Delegates to the generic per-rail store (packages/db/src/crud/poll_health.ts,
// Task 10) — see that module for the JSON-parse / sticky-field /
// consecutive-failure rules this used to carry directly, including why a
// rate-limit hit neither increments nor resets `consecutiveFailures`.

/** Single settings key holding the poller's last-cycle heartbeat as JSON. */
export const BINANCE_POLL_HEALTH_KEY = POLL_HEALTH_KEYS.binance;

/** Alias of the generic `PollHealth` shape — byte-identical to the old
 * standalone interface, kept as a named type so existing imports resolve
 * unchanged. */
export type BinancePollHealth = PollHealth;

/** Read the poller heartbeat; all-null when the poller has never run. */
export function getBinancePollHealth(db: Db): Promise<BinancePollHealth> {
  return getPollHealth(db, "binance");
}

/** Record one poll cycle's heartbeat. Called by the poller each tick. */
export function recordBinancePollHealth(
  db: Db,
  args: {
    lastTxCount: number;
    backoffUntil?: number | null;
    consecutiveRateLimitHits?: number;
    rateLimited?: boolean;
    success: boolean;
    error?: string | null;
  },
): Promise<void> {
  return recordPollHealth(db, "binance", args);
}
