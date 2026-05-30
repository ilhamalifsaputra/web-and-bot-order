/**
 * Orders — list/filter, detail, approve/reject. Never sends Telegram messages.
 * Port of routers/orders.py.
 */
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
  logAdminAction,
} from "@app/db";
import { currentAdmin, csrfProtect } from "../plugins/auth";
import { redirectWithFlash, humanizeValidationError, renderError } from "../flash";

const PAGE_SIZE = 50;

function parseDate(value: string | undefined): Date | null {
  if (!value) return null;
  const d = new Date(`${value}T00:00:00Z`);
  return Number.isNaN(d.getTime()) ? null : d;
}

const STATUS_VALUES = Object.values(OrderStatus) as string[];

export default async function ordersRoutes(app: FastifyInstance): Promise<void> {
  app.get("/orders", { preHandler: currentAdmin }, async (req, reply) => {
    const q = req.query as Record<string, string | undefined>;
    const statusFilter = q.status && STATUS_VALUES.includes(q.status) ? (q.status as OrderStatus) : null;
    const page = Math.max(Number(q.page) || 1, 1);
    const offset = (page - 1) * PAGE_SIZE;
    const since = parseDate(q.since);
    const until = parseDate(q.until);

    const filter = {
      status: statusFilter,
      orderCode: q.q || null,
      since,
      until,
    };
    const orders = await listOrders(prisma, { ...filter, limit: PAGE_SIZE, offset });
    const total = await countOrders(prisma, filter);

    return reply.view("orders.njk", {
      admin: req.admin,
      active_nav: "/orders",
      orders,
      total,
      page,
      page_size: PAGE_SIZE,
      has_next: offset + orders.length < total,
      statuses: STATUS_VALUES,
      f: { status: q.status ?? "", q: q.q ?? "", since: q.since ?? "", until: q.until ?? "" },
      msg: q.msg ?? null,
      kind: q.kind ?? "info",
    });
  });

  app.get("/orders/:orderId", { preHandler: currentAdmin }, async (req, reply) => {
    const q = req.query as Record<string, string | undefined>;
    const orderId = Number((req.params as { orderId: string }).orderId);
    const order = await getOrder(prisma, orderId);
    if (!order) {
      return renderError(reply, { statusCode: 404, title: "Not found", message: "Order not found." });
    }
    return reply.view("order_detail.njk", {
      admin: req.admin,
      active_nav: "/orders",
      order,
      is_delivered: order.status === OrderStatus.DELIVERED,
      can_act: order.status === OrderStatus.PENDING_VERIFICATION,
      msg: q.msg ?? null,
      kind: q.kind ?? "info",
    });
  });

  app.post("/orders/:orderId/approve", { preHandler: csrfProtect }, async (req, reply) => {
    const orderId = Number((req.params as { orderId: string }).orderId);
    try {
      const { order } = await approveOrder(prisma, orderId, { adminId: req.admin!.userId });
      await logAdminAction(prisma, {
        adminId: req.admin!.userId,
        action: "approve_order",
        targetType: "order",
        targetId: orderId,
        details: `order_code=${order.orderCode}`,
      });
    } catch (e) {
      if (e instanceof ValidationError) {
        return redirectWithFlash(reply, `/orders/${orderId}`, humanizeValidationError(e), "error");
      }
      throw e;
    }
    // NB: never put credentials in the redirect URL — they'd leak into logs.
    logger.info(`Order ${orderId} approved via web by admin_id=${req.admin!.userId}`);
    return redirectWithFlash(
      reply,
      `/orders/${orderId}`,
      "Order approved and delivered. Credentials are shown below.",
      "success",
    );
  });

  app.post("/orders/:orderId/reject", { preHandler: csrfProtect }, async (req, reply) => {
    const orderId = Number((req.params as { orderId: string }).orderId);
    const reason = ((req.body as Record<string, string>).reason ?? "").trim();
    if (!reason) {
      return redirectWithFlash(reply, `/orders/${orderId}`, "A rejection reason is required.", "error");
    }
    try {
      await rejectOrder(prisma, orderId, { adminId: req.admin!.userId, reason });
      await logAdminAction(prisma, {
        adminId: req.admin!.userId,
        action: "reject_order",
        targetType: "order",
        targetId: orderId,
        details: `reason=${reason.slice(0, 200)}`,
      });
    } catch (e) {
      if (e instanceof ValidationError) {
        return redirectWithFlash(reply, `/orders/${orderId}`, humanizeValidationError(e), "error");
      }
      throw e;
    }
    logger.info(`Order ${orderId} rejected via web by admin_id=${req.admin!.userId}`);
    return redirectWithFlash(reply, `/orders/${orderId}`, "Order rejected.", "success");
  });
}
