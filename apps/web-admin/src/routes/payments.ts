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
import { ValidationError } from "@app/core/errors";
import { logger } from "@app/core/logger";
import {
  prisma,
  deliverUnderpaidOrder,
  refundUnderpaidOrder,
  manualMatchTx,
  dismissUnmatchedTx,
  creditOrderToBalance,
  getOrderByCode,
  cancelOrder,
  logAdminAction,
} from "@app/db";
import { csrfProtect } from "../plugins/auth";
import { redirectWithFlash, humanizeValidationError } from "../flash";

const PAGE_SIZE = 50;

/**
 * Carries a literal "not found" flash message out of a `prisma.$transaction`
 * callback. Thrown instead of `return`ing early from inside the callback
 * (Prisma rolls back cleanly on any throw — nothing commits), then unwrapped
 * in the route's catch block to reproduce the exact pre-existing flash text
 * (not `humanizeValidationError`'s generic key-to-text formatting).
 */
class NotFoundFlash extends Error {
  constructor(public readonly flash: string) {
    super(flash);
  }
}

export default async function paymentsRoutes(app: FastifyInstance): Promise<void> {
  // GET /payments retired — now served by React SPA via GET /api/payments.

  app.post("/payments/order/:orderId/deliver", { preHandler: csrfProtect }, async (req, reply) => {
    const orderId = Number((req.params as { orderId: string }).orderId);
    try {
      const { order } = await deliverUnderpaidOrder(prisma, { orderId, adminId: req.admin!.userId });
      await logAdminAction(prisma, {
        adminId: req.admin!.userId,
        action: "underpaid_deliver",
        targetType: "order",
        targetId: orderId,
        details: `Delivered underpaid order ${order.orderCode} anyway.`,
      });
    } catch (e) {
      if (e instanceof ValidationError) {
        return redirectWithFlash(reply, "/payments", humanizeValidationError(e), "error");
      }
      throw e;
    }
    logger.info(`Admin ${req.admin!.userId} delivered underpaid order ${orderId} anyway via the web panel`);
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
        details: `Refunded ${refunded.toString()} to the buyer's wallet for an underpaid order.`,
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
      await prisma.$transaction(async (tx) => {
        await cancelOrder(tx, orderId, `underpaid_cancelled by admin_id=${req.admin!.userId}`);
        await logAdminAction(tx, {
          adminId: req.admin!.userId,
          action: "underpaid_cancel",
          targetType: "order",
          targetId: orderId,
        });
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
        details: `Matched transfer ${binanceTxId} to order ${order.orderCode}.`,
      });
    } catch (e) {
      if (e instanceof ValidationError) {
        return redirectWithFlash(reply, "/payments", humanizeValidationError(e), "error");
      }
      throw e;
    }
    logger.info(`Admin ${req.admin!.userId} manually matched Binance transfer ${binanceTxId} to order ${orderCode} via the web panel`);
    return redirectWithFlash(reply, "/payments", "Transfer matched and order delivered.", "success");
  });

  // ---- Add an UNMATCHED transfer to the buyer's credit balance ----
  // The admin identifies the buyer's order (the money can't be fulfilled there,
  // e.g. it expired); we credit the paid amount to their credit balance in the
  // order's currency, void the order, and re-tag the tx as credited_to_balance.

  app.post("/payments/credit", { preHandler: csrfProtect }, async (req, reply) => {
    const body = req.body as Record<string, string>;
    const binanceTxId = (body.binance_tx_id ?? "").trim();
    const orderCode = (body.order_code ?? "").trim();
    if (!binanceTxId || !orderCode) {
      return redirectWithFlash(reply, "/payments", "Both a transfer id and an order code are required.", "error");
    }
    try {
      await prisma.$transaction(async (tx) => {
        const target = await getOrderByCode(tx, orderCode);
        if (!target) {
          throw new NotFoundFlash(`Order ${orderCode} not found.`);
        }
        // The amount actually received, from the unmatched ledger row.
        const ledger = await tx.processedBinanceTx.findUnique({ where: { binanceTxId } });
        if (!ledger) {
          throw new NotFoundFlash("Transfer not found.");
        }
        const { credited, currency } = await creditOrderToBalance(tx, {
          orderId: target.id,
          amount: ledger.amount ?? undefined,
          adminId: req.admin!.userId,
          binanceTxId,
        });
        await logAdminAction(tx, {
          adminId: req.admin!.userId,
          action: "tx_credit_balance",
          targetType: "order",
          targetId: target.id,
          details: `Credited transfer ${binanceTxId} (${credited.toString()} ${currency}) to order ${target.orderCode}'s buyer balance.`,
        });
      });
    } catch (e) {
      if (e instanceof NotFoundFlash) {
        return redirectWithFlash(reply, "/payments", e.flash, "error");
      }
      if (e instanceof ValidationError) {
        return redirectWithFlash(reply, "/payments", humanizeValidationError(e), "error");
      }
      throw e;
    }
    logger.info(`Admin ${req.admin!.userId} credited Binance transfer ${binanceTxId} to order ${orderCode}'s buyer balance via the web panel`);
    return redirectWithFlash(reply, "/payments", "Payment added to the buyer's credit balance.", "success");
  });

  // ---- Dismiss an UNMATCHED transfer that has no order (e.g. a test deposit) ----

  app.post("/payments/dismiss", { preHandler: csrfProtect }, async (req, reply) => {
    const binanceTxId = ((req.body as Record<string, string>).binance_tx_id ?? "").trim();
    if (!binanceTxId) {
      return redirectWithFlash(reply, "/payments", "A payment reference is required.", "error");
    }
    try {
      await prisma.$transaction(async (tx) => {
        await dismissUnmatchedTx(tx, binanceTxId);
        await logAdminAction(tx, {
          adminId: req.admin!.userId,
          action: "tx_dismiss",
          targetType: "payment",
          details: `Dismissed unmatched transfer ${binanceTxId}.`,
        });
      });
    } catch (e) {
      if (e instanceof ValidationError) {
        return redirectWithFlash(reply, "/payments", humanizeValidationError(e), "error");
      }
      throw e;
    }
    logger.info(`Admin ${req.admin!.userId} dismissed unmatched Binance transfer ${binanceTxId} via the web panel`);
    return redirectWithFlash(reply, "/payments", "Payment dismissed.", "success");
  });
}
