import type { FastifyInstance } from "fastify";
import { OrderStatus } from "@app/core/enums";
import { ValidationError } from "@app/core/errors";
import { logger } from "@app/core/logger";
import {
  prisma,
  resolveBinanceInternalConfig,
  listProcessedBinanceTx,
  countProcessedBinanceTx,
  processedTxOutcomeCounts,
  getBinancePollHealth,
  TX_OUTCOMES,
  deliverUnderpaidOrder,
  refundUnderpaidOrder,
  manualMatchTx,
  dismissUnmatchedTx,
  creditOrderToBalance,
  listOrders,
  listPendingInternalOrders,
  getOrderByCode,
  cancelOrder,
  logAdminAction,
} from "@app/db";
import { currentAdmin, csrfProtect } from "../../plugins/auth";

const PAGE_SIZE = 50;

class NotFoundError extends Error {}

export default async function paymentsApiRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/payments", { preHandler: currentAdmin }, async (req, reply) => {
    const q = req.query as Record<string, string | undefined>;
    const outcome = q.outcome && (TX_OUTCOMES as readonly string[]).includes(q.outcome) ? q.outcome : null;
    const page = Math.max(Number(q.page) || 1, 1);
    const offset = (page - 1) * PAGE_SIZE;

    const [ledger, total, counts, health, underpaid, pendingInternal] = await Promise.all([
      listProcessedBinanceTx(prisma, { outcome, limit: PAGE_SIZE, offset }),
      countProcessedBinanceTx(prisma, { outcome }),
      processedTxOutcomeCounts(prisma),
      getBinancePollHealth(prisma),
      listOrders(prisma, { status: OrderStatus.UNDERPAID, limit: 50 }),
      listPendingInternalOrders(prisma, new Date()),
    ]);
    const binanceEnabled = (await resolveBinanceInternalConfig(prisma)).enabled;

    return reply.send({
      enabled: binanceEnabled,
      ledger,
      total,
      page,
      pageSize: PAGE_SIZE,
      hasNext: offset + ledger.length < total,
      outcomes: TX_OUTCOMES,
      counts,
      health,
      underpaid,
      pendingInternal,
    });
  });

  app.post("/api/payments/order/:orderId/deliver", { preHandler: csrfProtect }, async (req, reply) => {
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
      if (e instanceof ValidationError) return reply.code(422).send({ error: e.message });
      throw e;
    }
    logger.info(`Admin ${req.admin!.userId} delivered underpaid order ${orderId} anyway via the web panel`);
    return reply.send({ ok: true });
  });

  app.post("/api/payments/order/:orderId/refund", { preHandler: csrfProtect }, async (req, reply) => {
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
      if (e instanceof ValidationError) return reply.code(422).send({ error: e.message });
      throw e;
    }
    return reply.send({ ok: true });
  });

  app.post("/api/payments/order/:orderId/cancel", { preHandler: csrfProtect }, async (req, reply) => {
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
      if (e instanceof ValidationError) return reply.code(422).send({ error: e.message });
      throw e;
    }
    return reply.send({ ok: true });
  });

  app.post("/api/payments/match", { preHandler: csrfProtect }, async (req, reply) => {
    const body = req.body as Record<string, string>;
    const binanceTxId = (body.binance_tx_id ?? "").trim();
    const orderCode = (body.order_code ?? "").trim();
    if (!binanceTxId || !orderCode) {
      return reply.code(400).send({ error: "Both a transfer id and an order code are required." });
    }
    try {
      const target = await getOrderByCode(prisma, orderCode);
      if (!target) return reply.code(404).send({ error: `Order ${orderCode} not found.` });
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
      logger.info(`Admin ${req.admin!.userId} manually matched Binance transfer ${binanceTxId} to order ${orderCode} via the web panel`);
      return reply.send({ ok: true });
    } catch (e) {
      if (e instanceof ValidationError) return reply.code(422).send({ error: e.message });
      throw e;
    }
  });

  app.post("/api/payments/credit", { preHandler: csrfProtect }, async (req, reply) => {
    const body = req.body as Record<string, string>;
    const binanceTxId = (body.binance_tx_id ?? "").trim();
    const orderCode = (body.order_code ?? "").trim();
    if (!binanceTxId || !orderCode) {
      return reply.code(400).send({ error: "Both a transfer id and an order code are required." });
    }
    try {
      await prisma.$transaction(async (tx) => {
        const target = await getOrderByCode(tx, orderCode);
        if (!target) throw new NotFoundError(`Order ${orderCode} not found.`);
        const ledger = await tx.processedBinanceTx.findUnique({ where: { binanceTxId } });
        if (!ledger) throw new NotFoundError("Transfer not found.");
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
      logger.info(`Admin ${req.admin!.userId} credited Binance transfer ${binanceTxId} to order ${orderCode}'s buyer balance via the web panel`);
      return reply.send({ ok: true });
    } catch (e) {
      if (e instanceof NotFoundError) return reply.code(404).send({ error: e.message });
      if (e instanceof ValidationError) return reply.code(422).send({ error: e.message });
      throw e;
    }
  });

  app.post("/api/payments/dismiss", { preHandler: csrfProtect }, async (req, reply) => {
    const binanceTxId = ((req.body as Record<string, string>).binance_tx_id ?? "").trim();
    if (!binanceTxId) return reply.code(400).send({ error: "A payment reference is required." });
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
      logger.info(`Admin ${req.admin!.userId} dismissed unmatched Binance transfer ${binanceTxId} via the web panel`);
      return reply.send({ ok: true });
    } catch (e) {
      if (e instanceof ValidationError) return reply.code(422).send({ error: e.message });
      throw e;
    }
  });
}
