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
import { OrderStatus, PaymentMethod } from "@app/core/enums";
import { Decimal } from "@app/core/money";
import { addMinutes } from "@app/core/datetime";
import { generatePaymentRef } from "@app/core/formatters";
import { logger } from "@app/core/logger";
import { ValidationError } from "@app/core/errors";
import type { PrismaClient, Tx } from "../client";
import type { Db } from "./_types";
import { isUniqueViolation } from "./_types";
import { getOrder, createOrderDirect, approveOrder } from "./orders";
import { adjustWallet } from "./users";
import { getSetting, setSetting } from "./settings";

/** Create a direct order, then mark it BINANCE_INTERNAL with a unique note + 15-min expiry. */
export async function createInternalOrder(
  db: Db,
  args: { user: { id: number; role: string }; productId: number; quantity: number; voucherCode?: string | null },
) {
  const created = await createOrderDirect(db, args);
  if (!created) return null;

  // Pick a payment ref free of (the astronomically unlikely) collision.
  let ref = generatePaymentRef();
  for (let i = 0; i < 5; i++) {
    const clash = await db.order.findUnique({ where: { paymentRef: ref } });
    if (!clash) break;
    ref = generatePaymentRef();
  }

  await db.order.update({
    where: { id: created.id },
    data: {
      paymentMethod: PaymentMethod.BINANCE_INTERNAL,
      paymentRef: ref,
      expiresAt: addMinutes(new Date(), config.INTERNAL_PAYMENT_WINDOW_MINUTES),
    },
  });
  return getOrder(db, created.id);
}

/** Remember which message holds the payment instructions, so the poller can edit it. */
export async function setOrderPaymentMessage(db: Db, orderId: number, chatId: number | bigint, messageId: number) {
  await db.order.update({
    where: { id: orderId },
    data: { paymentMsgChatId: BigInt(chatId), paymentMsgId: messageId },
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
        data: { status: OrderStatus.PENDING_VERIFICATION, binanceTxid: args.binanceTxId, paidAt: new Date() },
      });
      const { order: delivered, credentials } = await approveOrder(tx, args.orderId, { adminId: 0 });
      logger.info(`Auto-delivered internal-transfer order ${delivered.orderCode} (tx ${args.binanceTxId})`);
      return { status: "delivered" as const, order: delivered, credentials };
    });
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
      status: OrderStatus.UNDERPAID,
      binanceTxid: args.binanceTxId,
      adminNote: `[underpaid] received ${new Decimal(args.amount).toString()} via tx ${args.binanceTxId}`,
    },
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
export const TX_OUTCOMES = ["matched", "underpaid", "unmatched", "delivery_failed"] as const;
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
      data: { status: OrderStatus.PENDING_VERIFICATION, paidAt: new Date() },
    });
    const { order: delivered, credentials } = await approveOrder(tx, args.orderId, { adminId: args.adminId });
    logger.info(`Underpaid order ${delivered.orderCode} delivered anyway by admin=${args.adminId}`);
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
        status: OrderStatus.REFUNDED,
        adminNote: `${order.adminNote ?? ""}\n[refund] ${received.toString()} to wallet by admin_id=${args.adminId}`,
      },
    });
    logger.info(`Refunded underpaid order ${order.orderCode} (${received.toString()}) by admin=${args.adminId}`);
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
        status: OrderStatus.PENDING_VERIFICATION,
        binanceTxid: args.binanceTxId,
        paidAt: new Date(),
      },
    });
    const { order: delivered, credentials } = await approveOrder(tx, args.orderId, { adminId: args.adminId });
    logger.info(`Manual-matched tx ${args.binanceTxId} → order ${delivered.orderCode} by admin=${args.adminId}`);
    return { order: delivered, credentials };
  });
}

// ---- Poller heartbeat (written by the order-bot poller, read by the web) ----

/** Single settings key holding the poller's last-cycle heartbeat as JSON. */
export const BINANCE_POLL_HEALTH_KEY = "binance_poll_health";

export interface BinancePollHealth {
  lastRun: string | null;
  lastTxCount: number | null;
  backoffUntil: string | null;
}

/** Read the poller heartbeat; all-null when the poller has never run. */
export async function getBinancePollHealth(db: Db): Promise<BinancePollHealth> {
  const raw = await getSetting(db, BINANCE_POLL_HEALTH_KEY);
  if (!raw) return { lastRun: null, lastTxCount: null, backoffUntil: null };
  try {
    const p = JSON.parse(raw) as Partial<BinancePollHealth>;
    return {
      lastRun: p.lastRun ?? null,
      lastTxCount: typeof p.lastTxCount === "number" ? p.lastTxCount : null,
      backoffUntil: p.backoffUntil ?? null,
    };
  } catch {
    return { lastRun: null, lastTxCount: null, backoffUntil: null };
  }
}

/** Record one poll cycle's heartbeat. Called by the poller each tick. */
export async function recordBinancePollHealth(
  db: Db,
  args: { lastTxCount: number; backoffUntil?: number | null },
): Promise<void> {
  await setSetting(
    db,
    BINANCE_POLL_HEALTH_KEY,
    JSON.stringify({
      lastRun: new Date().toISOString(),
      lastTxCount: args.lastTxCount,
      backoffUntil: args.backoffUntil ? new Date(args.backoffUntil).toISOString() : null,
    }),
  );
}
