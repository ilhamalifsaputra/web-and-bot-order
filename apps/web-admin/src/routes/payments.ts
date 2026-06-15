/**
 * Binance Internal Transfer ops panel — port target of WEB.md roadmap §1.
 *
 * Gives the operator visibility + manual levers over UID-based auto-confirm:
 *  - the processed_binance_tx ledger (matched / underpaid / unmatched / failed),
 *  - one-click UNDERPAID resolution (deliver anyway / refund to wallet / cancel),
 *  - manual match of an UNMATCHED transfer to a forgotten-note order,
 *  - a poller-health card (last run, fetched-tx count, backoff).
 *
 * Like every other web route it NEVER sends Telegram messages — deliver paths
 * go through approveOrder, which enqueues the testimoni outbox row for the
 * notifier to drain. Every mutation is audited.
 */
import type { FastifyInstance } from "fastify";
import { config, isBinanceInternalEnabled } from "@app/core/config";
import { OrderStatus } from "@app/core/enums";
import { ValidationError } from "@app/core/errors";
import { logger } from "@app/core/logger";
import {
  prisma,
  listProcessedBinanceTx,
  countProcessedBinanceTx,
  processedTxOutcomeCounts,
  getBinancePollHealth,
  TX_OUTCOMES,
  deliverUnderpaidOrder,
  refundUnderpaidOrder,
  manualMatchTx,
  dismissUnmatchedTx,
  listOrders,
  listPendingInternalOrders,
  getOrderByCode,
  cancelOrder,
  logAdminAction,
} from "@app/db";
import { currentAdmin, csrfProtect } from "../plugins/auth";
import { redirectWithFlash, humanizeValidationError } from "../flash";

const PAGE_SIZE = 50;

export default async function paymentsRoutes(app: FastifyInstance): Promise<void> {
  app.get("/payments", { preHandler: currentAdmin }, async (req, reply) => {
    const q = req.query as Record<string, string | undefined>;
    const outcome = q.outcome && (TX_OUTCOMES as readonly string[]).includes(q.outcome) ? q.outcome : null;
    const page = Math.max(Number(q.page) || 1, 1);
    const offset = (page - 1) * PAGE_SIZE;

    const ledger = await listProcessedBinanceTx(prisma, { outcome, limit: PAGE_SIZE, offset });
    const total = await countProcessedBinanceTx(prisma, { outcome });
    const counts = await processedTxOutcomeCounts(prisma);
    const health = await getBinancePollHealth(prisma);
    const underpaid = await listOrders(prisma, { status: OrderStatus.UNDERPAID, limit: 50 });
    const pendingInternal = await listPendingInternalOrders(prisma, new Date());

    return reply.view("payments.njk", {
      admin: req.admin,
      active_nav: "/payments",
      enabled: isBinanceInternalEnabled(),
      ledger,
      total,
      page,
      page_size: PAGE_SIZE,
      has_next: offset + ledger.length < total,
      outcomes: TX_OUTCOMES,
      counts,
      health,
      underpaid,
      pending_internal: pendingInternal,
      f: { outcome: outcome ?? "" },
      msg: q.msg ?? null,
      kind: q.kind ?? "info",
    });
  });

  // ---- UNDERPAID resolution ----

  app.post("/payments/order/:orderId/deliver", { preHandler: csrfProtect }, async (req, reply) => {
    const orderId = Number((req.params as { orderId: string }).orderId);
    try {
      const { order } = await deliverUnderpaidOrder(prisma, { orderId, adminId: req.admin!.userId });
      await logAdminAction(prisma, {
        adminId: req.admin!.userId,
        action: "underpaid_deliver",
        targetType: "order",
        targetId: orderId,
        details: `order_code=${order.orderCode}`,
      });
    } catch (e) {
      if (e instanceof ValidationError) {
        return redirectWithFlash(reply, "/payments", humanizeValidationError(e), "error");
      }
      throw e;
    }
    logger.info(`Underpaid order ${orderId} delivered via web by admin_id=${req.admin!.userId}`);
    return redirectWithFlash(reply, "/payments", "Underpaid order delivered.", "success");
  });

  app.post("/payments/order/:orderId/refund", { preHandler: csrfProtect }, async (req, reply) => {
    const orderId = Number((req.params as { orderId: string }).orderId);
    try {
      const { refunded } = await refundUnderpaidOrder(prisma, { orderId, adminId: req.admin!.userId });
      await logAdminAction(prisma, {
        adminId: req.admin!.userId,
        action: "underpaid_refund",
        targetType: "order",
        targetId: orderId,
        details: `refunded=${refunded.toString()}`,
      });
    } catch (e) {
      if (e instanceof ValidationError) {
        return redirectWithFlash(reply, "/payments", humanizeValidationError(e), "error");
      }
      throw e;
    }
    return redirectWithFlash(reply, "/payments", "Underpaid order refunded to wallet.", "success");
  });

  app.post("/payments/order/:orderId/cancel", { preHandler: csrfProtect }, async (req, reply) => {
    const orderId = Number((req.params as { orderId: string }).orderId);
    try {
      await cancelOrder(prisma, orderId, `underpaid_cancelled by admin_id=${req.admin!.userId}`);
      await logAdminAction(prisma, {
        adminId: req.admin!.userId,
        action: "underpaid_cancel",
        targetType: "order",
        targetId: orderId,
      });
    } catch (e) {
      if (e instanceof ValidationError) {
        return redirectWithFlash(reply, "/payments", humanizeValidationError(e), "error");
      }
      throw e;
    }
    return redirectWithFlash(reply, "/payments", "Underpaid order cancelled.", "success");
  });

  // ---- Manual match of an UNMATCHED transfer ----

  app.post("/payments/match", { preHandler: csrfProtect }, async (req, reply) => {
    const body = req.body as Record<string, string>;
    const binanceTxId = (body.binance_tx_id ?? "").trim();
    const orderCode = (body.order_code ?? "").trim();
    if (!binanceTxId || !orderCode) {
      return redirectWithFlash(reply, "/payments", "Both a transfer id and an order code are required.", "error");
    }
    try {
      const target = await getOrderByCode(prisma, orderCode);
      if (!target) {
        return redirectWithFlash(reply, "/payments", `Order ${orderCode} not found.`, "error");
      }
      const { order } = await manualMatchTx(prisma, {
        binanceTxId,
        orderId: target.id,
        adminId: req.admin!.userId,
      });
      await logAdminAction(prisma, {
        adminId: req.admin!.userId,
        action: "tx_manual_match",
        targetType: "order",
        targetId: order.id,
        details: `tx=${binanceTxId} order_code=${order.orderCode}`,
      });
    } catch (e) {
      if (e instanceof ValidationError) {
        return redirectWithFlash(reply, "/payments", humanizeValidationError(e), "error");
      }
      throw e;
    }
    logger.info(`Tx ${binanceTxId} manually matched to ${orderCode} via web by admin_id=${req.admin!.userId}`);
    return redirectWithFlash(reply, "/payments", "Transfer matched and order delivered.", "success");
  });

  // ---- Dismiss an UNMATCHED transfer that has no order (e.g. a test deposit) ----

  app.post("/payments/dismiss", { preHandler: csrfProtect }, async (req, reply) => {
    const binanceTxId = ((req.body as Record<string, string>).binance_tx_id ?? "").trim();
    if (!binanceTxId) {
      return redirectWithFlash(reply, "/payments", "A payment reference is required.", "error");
    }
    try {
      await dismissUnmatchedTx(prisma, binanceTxId);
      await logAdminAction(prisma, {
        adminId: req.admin!.userId,
        action: "tx_dismiss",
        targetType: "payment",
        details: `tx=${binanceTxId}`,
      });
    } catch (e) {
      if (e instanceof ValidationError) {
        return redirectWithFlash(reply, "/payments", humanizeValidationError(e), "error");
      }
      throw e;
    }
    logger.info(`Unmatched tx ${binanceTxId} dismissed via web by admin_id=${req.admin!.userId}`);
    return redirectWithFlash(reply, "/payments", "Payment dismissed.", "success");
  });
}
