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
import { OrderStatus, OrderCurrency, PaymentMethod } from "@app/core/enums";
import { Decimal } from "@app/core/money";
import { logger } from "@app/core/logger";
import { ValidationError } from "@app/core/errors";
import type { PrismaClient, Tx } from "../client";
import type { Db } from "./_types";
import { isUniqueViolation } from "./_types";
import { getOrder, createOrderDirect, approveOrder, applyUsdtWalletToOrder } from "./orders";
import { transitionOrderStatus } from "./orderStatus";
import { adjustWallet } from "./users";
import { getSetting, setSetting } from "./settings";
import { finalizeOrderPayment } from "./pricing";
import { parseMinAmount } from "./_minAmount";

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
  },
) {
  const created = await createOrderDirect(db, args);
  if (!created) return null;
  const finalized = await finalizeOrderPayment(db, created.id, {
    currency: OrderCurrency.USDT,
    rate: args.rate,
    method: PaymentMethod.BINANCE_INTERNAL,
  });
  // Spend the USDT credit balance against the finalized USDT total (no-op when
  // walletAmount is unset). Re-read so callers see the updated walletUsed/total.
  await applyUsdtWalletToOrder(db, created.id, args.walletAmount);
  return args.walletAmount != null ? getOrder(db, created.id) : finalized;
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

/** DELIVERED orders of `method` that still carry an un-edited payment-message anchor. */
export function listDeliveredOrdersAwaitingEdit(db: Db, method: PaymentMethod) {
  return db.order.findMany({
    where: {
      status: OrderStatus.DELIVERED,
      paymentMethod: method,
      paymentMsgChatId: { not: null },
      paymentMsgId: { not: null },
    },
    include: { user: true },
  });
}

/** PENDING, not-yet-expired internal-transfer orders the poller should match against. */
export function listPendingInternalOrders(db: Db, now: Date) {
  return db.order.findMany({
    where: {
      status: OrderStatus.PENDING_PAYMENT,
      paymentMethod: PaymentMethod.BINANCE_INTERNAL,
      paymentRef: { not: null },
      expiresAt: { gt: now },
    },
    include: { user: true },
  });
}

export type DeliverResult =
  | { status: "delivered"; order: NonNullable<Awaited<ReturnType<typeof getOrder>>>; credentials: string[] }
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
  // 1. Claim the tx id. A duplicate means another cycle already handled it.
  try {
    await db.processedBinanceTx.create({
      data: { binanceTxId: args.binanceTxId, orderId: args.orderId, amount: new Decimal(args.amount), outcome: "matched" },
    });
  } catch (e) {
    if (isUniqueViolation(e)) return { status: "already_processed" };
    throw e;
  }

  // 2. Deliver. On failure, flag the ledger row so we don't silently retry
  //    forever (e.g. paid but out of stock) and let the caller alert an admin.
  try {
    return await db.$transaction(async (tx: Tx) => {
      const order = await getOrder(tx, args.orderId);
      if (!order || order.status !== OrderStatus.PENDING_PAYMENT) {
        return { status: "stale" as const };
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
      const { order: delivered, credentials } = await approveOrder(tx, args.orderId, { adminId: 0 });
      logger.info(`Auto-delivered internal-transfer order ${delivered.orderCode} for Binance transaction ${args.binanceTxId}`);
      return { status: "delivered" as const, order: delivered, credentials };
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
  "underpaid",
  "unmatched",
  "delivery_failed",
  "credited_to_balance",
  "dismissed",
] as const;
export type TxOutcome = (typeof TX_OUTCOMES)[number];

type LinkedOrder = { id: number; orderCode: string; status: string; totalAmount: Decimal };

/** Ledger rows (newest first), each enriched with its linked order (if any). */
export async function listProcessedBinanceTx(
  db: Db,
  opts: { outcome?: string | null; limit?: number; offset?: number } = {},
) {
  const where = opts.outcome ? { outcome: opts.outcome } : {};
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

export function countProcessedBinanceTx(db: Db, opts: { outcome?: string | null } = {}) {
  return db.processedBinanceTx.count({ where: opts.outcome ? { outcome: opts.outcome } : {} });
}

/** Count of ledger rows per outcome — drives the summary cards. */
export async function processedTxOutcomeCounts(db: Db): Promise<Record<string, number>> {
  const grouped = await db.processedBinanceTx.groupBy({ by: ["outcome"], _count: { _all: true } });
  const counts: Record<string, number> = {};
  for (const g of grouped) counts[g.outcome] = g._count._all;
  return counts;
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
): Promise<{ order: NonNullable<Awaited<ReturnType<typeof getOrder>>>; credentials: string[] }> {
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
    const { order: delivered, credentials } = await approveOrder(tx, args.orderId, { adminId: args.adminId });
    logger.info(`Manually matched Binance transaction ${args.binanceTxId} to order ${delivered.orderCode} by admin ${args.adminId}`);
    return { order: delivered, credentials };
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

/** Single settings key holding the poller's last-cycle heartbeat as JSON. */
export const BINANCE_POLL_HEALTH_KEY = "binance_poll_health";

export interface BinancePollHealth {
  lastRun: string | null;
  /** Last cycle that completed WITHOUT error (0 new transfers still counts). */
  lastSuccessAt: string | null;
  lastTxCount: number | null;
  backoffUntil: string | null;
  /** Current consecutive rate-limit hit streak (0 when healthy). */
  consecutiveRateLimitHits: number | null;
  /** Sticky — last time a rate-limit hit occurred, even after recovery. */
  lastRateLimitAt: string | null;
  /** Consecutive non-rate-limit failures (network/HTTP errors); 0 when
   * healthy. Tracked separately from rate limits, which already have their
   * own backoff/counter above — `lastRun` alone can't surface this, since it
   * advances on every cycle whether that cycle succeeded or failed. */
  consecutiveFailures: number | null;
  /** Sticky — last error message seen (any failure type), for diagnostics. */
  lastError: string | null;
}

const EMPTY_BINANCE_HEALTH: BinancePollHealth = {
  lastRun: null,
  lastSuccessAt: null,
  lastTxCount: null,
  backoffUntil: null,
  consecutiveRateLimitHits: null,
  lastRateLimitAt: null,
  consecutiveFailures: null,
  lastError: null,
};

/** Read the poller heartbeat; all-null when the poller has never run. */
export async function getBinancePollHealth(db: Db): Promise<BinancePollHealth> {
  const raw = await getSetting(db, BINANCE_POLL_HEALTH_KEY);
  if (!raw) return EMPTY_BINANCE_HEALTH;
  try {
    const p = JSON.parse(raw) as Partial<BinancePollHealth>;
    return {
      lastRun: p.lastRun ?? null,
      lastSuccessAt: p.lastSuccessAt ?? null,
      lastTxCount: typeof p.lastTxCount === "number" ? p.lastTxCount : null,
      backoffUntil: p.backoffUntil ?? null,
      consecutiveRateLimitHits: typeof p.consecutiveRateLimitHits === "number" ? p.consecutiveRateLimitHits : null,
      lastRateLimitAt: p.lastRateLimitAt ?? null,
      consecutiveFailures: typeof p.consecutiveFailures === "number" ? p.consecutiveFailures : null,
      lastError: p.lastError ?? null,
    };
  } catch {
    return EMPTY_BINANCE_HEALTH;
  }
}

/** Record one poll cycle's heartbeat. Called by the poller each tick.
 * `lastRateLimitAt`/`lastError` are sticky (carried forward from the prior
 * heartbeat) so a rare hit stays visible after the poller recovers.
 * `consecutiveFailures` counts non-rate-limit failures only — a rate-limit
 * hit neither increments nor resets it, since that streak already has its own
 * dedicated counter/backoff above. */
export async function recordBinancePollHealth(
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
  const prev = await getBinancePollHealth(db);
  const lastRateLimitAt = args.rateLimited ? new Date().toISOString() : prev.lastRateLimitAt;
  const consecutiveFailures = args.success
    ? 0
    : args.rateLimited
      ? prev.consecutiveFailures ?? 0
      : (prev.consecutiveFailures ?? 0) + 1;
  const nowIso = new Date().toISOString();
  await setSetting(
    db,
    BINANCE_POLL_HEALTH_KEY,
    JSON.stringify({
      lastRun: nowIso,
      lastSuccessAt: args.success ? nowIso : prev.lastSuccessAt,
      lastTxCount: args.lastTxCount,
      backoffUntil: args.backoffUntil ? new Date(args.backoffUntil).toISOString() : null,
      consecutiveRateLimitHits: args.consecutiveRateLimitHits ?? 0,
      lastRateLimitAt,
      consecutiveFailures,
      lastError: args.success ? prev.lastError : (args.error ?? prev.lastError) ?? null,
    } satisfies BinancePollHealth),
  );
}
