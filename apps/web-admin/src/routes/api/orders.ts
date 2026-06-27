import type { FastifyInstance } from "fastify";
import { OrderStatus } from "@app/core/enums";
import { ValidationError } from "@app/core/errors";
import { logger } from "@app/core/logger";
import {
  prisma,
  listOrders,
  countOrders,
  getOrder,
  approveOrder,
  rejectOrder,
  creditOrderToBalance,
  logAdminAction,
} from "@app/db";
import { currentAdmin, csrfProtect } from "../../plugins/auth";
import { orderMoneyView } from "../orders";

const PAGE_SIZE = 50;
const STATUS_VALUES = Object.values(OrderStatus) as string[];

function parseDate(value: string | undefined): Date | null {
  if (!value) return null;
  const d = new Date(`${value}T00:00:00Z`);
  return Number.isNaN(d.getTime()) ? null : d;
}

function serializeMoneyView(mv: ReturnType<typeof orderMoneyView>) {
  return {
    currency: mv.currency,
    itemsTotal: mv.itemsTotal.toString(),
    bulkDiscount: mv.bulkDiscount?.toString() ?? null,
    discount: mv.discount?.toString() ?? null,
    walletCredit: mv.walletCredit?.toString() ?? null,
    amountMarker: mv.amountMarker?.toString() ?? null,
    totalToPay: mv.totalToPay.toString(),
    equivalentIdr: mv.equivalentIdr?.toString() ?? null,
  };
}

export default async function ordersApiRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/orders", { preHandler: currentAdmin }, async (req, reply) => {
    const q = req.query as Record<string, string | undefined>;
    const statusFilter =
      q.status && STATUS_VALUES.includes(q.status) ? (q.status as OrderStatus) : null;
    const page = Math.max(Number(q.page) || 1, 1);
    const offset = (page - 1) * PAGE_SIZE;
    const since = parseDate(q.since);
    const until = parseDate(q.until);

    const filter = { status: statusFilter, orderCode: q.q || null, since, until };
    const [orders, total] = await Promise.all([
      listOrders(prisma, { ...filter, limit: PAGE_SIZE, offset }),
      countOrders(prisma, filter),
    ]);

    return reply.send({
      orders,
      total,
      page,
      pageSize: PAGE_SIZE,
      hasNext: offset + orders.length < total,
      statuses: STATUS_VALUES,
    });
  });

  app.get("/api/orders/:orderId", { preHandler: currentAdmin }, async (req, reply) => {
    const orderId = Number((req.params as { orderId: string }).orderId);
    const order = await getOrder(prisma, orderId);
    if (!order) return reply.code(404).send({ error: "Order not found." });
    return reply.send({
      order,
      money: serializeMoneyView(orderMoneyView(order)),
      isDelivered: order.status === OrderStatus.DELIVERED,
      canAct: order.status === OrderStatus.PENDING_VERIFICATION,
      canCredit:
        order.status === OrderStatus.PENDING_VERIFICATION ||
        order.status === OrderStatus.UNDERPAID,
    });
  });

  app.post("/api/orders/:orderId/approve", { preHandler: csrfProtect }, async (req, reply) => {
    const orderId = Number((req.params as { orderId: string }).orderId);
    try {
      await prisma.$transaction(async (tx) => {
        const { order } = await approveOrder(tx, orderId, { adminId: req.admin!.userId });
        await logAdminAction(tx, {
          adminId: req.admin!.userId,
          action: "approve_order",
          targetType: "order",
          targetId: orderId,
          details: `Approved order ${order.orderCode}.`,
        });
      });
    } catch (e) {
      if (e instanceof ValidationError) {
        return reply.code(422).send({ error: e.message });
      }
      throw e;
    }
    logger.info(
      `Admin ${req.admin!.userId} approved and delivered order ${orderId} via the web panel`,
    );
    return reply.send({ ok: true });
  });

  app.post("/api/orders/:orderId/reject", { preHandler: csrfProtect }, async (req, reply) => {
    const orderId = Number((req.params as { orderId: string }).orderId);
    const reason = ((req.body as Record<string, string>).reason ?? "").trim();
    if (!reason) {
      return reply.code(400).send({ error: "A rejection reason is required." });
    }
    try {
      await prisma.$transaction(async (tx) => {
        await rejectOrder(tx, orderId, { adminId: req.admin!.userId, reason });
        await logAdminAction(tx, {
          adminId: req.admin!.userId,
          action: "reject_order",
          targetType: "order",
          targetId: orderId,
          details: `Rejected order ${orderId}: ${reason.slice(0, 200)}`,
        });
      });
    } catch (e) {
      if (e instanceof ValidationError) {
        return reply.code(422).send({ error: e.message });
      }
      throw e;
    }
    logger.info(`Admin ${req.admin!.userId} rejected order ${orderId} via the web panel`);
    return reply.send({ ok: true });
  });

  app.post(
    "/api/orders/:orderId/credit-balance",
    { preHandler: csrfProtect },
    async (req, reply) => {
      const orderId = Number((req.params as { orderId: string }).orderId);
      try {
        await prisma.$transaction(async (tx) => {
          const { credited, currency } = await creditOrderToBalance(tx, {
            orderId,
            adminId: req.admin!.userId,
          });
          await logAdminAction(tx, {
            adminId: req.admin!.userId,
            action: "order_credit_balance",
            targetType: "order",
            targetId: orderId,
            details: `Credited order ${orderId}'s paid amount (${credited.toString()} ${currency}) to the buyer's balance.`,
          });
        });
      } catch (e) {
        if (e instanceof ValidationError) {
          return reply.code(422).send({ error: e.message });
        }
        throw e;
      }
      logger.info(
        `Admin ${req.admin!.userId} credited order ${orderId}'s paid amount to the buyer's balance via the web panel`,
      );
      return reply.send({ ok: true });
    },
  );
}
