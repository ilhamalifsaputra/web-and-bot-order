import type { FastifyInstance } from "fastify";
import { OrderStatus, DeliveryType } from "@app/core/enums";
import { ValidationError } from "@app/core/errors";
import { logger } from "@app/core/logger";
import { nudgeOutboxDispatcher } from "@app/core/nudge";
import { parseAdditionalFields, parseCustomerData } from "@app/core/deliveryFields";
import {
  prisma,
  listOrders,
  countOrders,
  getOrder,
  settlePaidOrder,
  rejectOrder,
  creditOrderToBalance,
  fulfillManualOrder,
  enqueueOrderDeliveredDm,
  enqueueManualDeliveredDm,
  logAdminAction,
} from "@app/db";
import { currentAdmin, csrfProtect } from "../../plugins/auth";
import { orderMoneyView } from "../orderMoneyView";
import { displayDate, displayDateTime } from "../../dateDisplay";

const PAGE_SIZE = 50;
const STATUS_VALUES = Object.values(OrderStatus) as string[];

function parseDate(value: string | undefined): Date | null {
  if (!value) return null;
  const d = new Date(`${value}T00:00:00Z`);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Quotes a CSV field per RFC 4180: wrap in double quotes if it contains a
 * comma, quote, or newline, doubling any embedded quotes. */
function csvField(value: string): string {
  if (/[",\r\n]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

function csvRow(fields: string[]): string {
  return fields.map(csvField).join(",") + "\r\n";
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

    const ordersWithDisplay = orders.map((o) => ({ ...o, createdAtDisplay: displayDate(o.createdAt) }));
    return reply.send({
      orders: ordersWithDisplay,
      total,
      page,
      pageSize: PAGE_SIZE,
      hasNext: offset + orders.length < total,
      statuses: STATUS_VALUES,
    });
  });

  // Exports the full filtered result set (not just the current page) as a CSV
  // download — `listOrders` defaults to `take: 50`, so this must pass an
  // explicit override or the export would silently truncate.
  app.get("/api/orders/export", { preHandler: currentAdmin }, async (req, reply) => {
    const q = req.query as Record<string, string | undefined>;
    const statusFilter =
      q.status && STATUS_VALUES.includes(q.status) ? (q.status as OrderStatus) : null;
    const since = parseDate(q.since);
    const until = parseDate(q.until);

    const filter = { status: statusFilter, orderCode: q.q || null, since, until };
    const orders = await listOrders(prisma, { ...filter, limit: 100000 });

    const header = [
      "Order Code",
      "Customer",
      "Status",
      "Currency",
      "Total Amount",
      "Payment Method",
      "Created At",
    ];
    let csv = csvRow(header);
    for (const order of orders) {
      const customer =
        order.user?.fullName ?? order.user?.username ?? order.user?.loginUsername ?? "";
      csv += csvRow([
        order.orderCode,
        customer,
        order.status,
        order.currency,
        order.totalAmount.toString(),
        order.paymentMethod,
        order.createdAt.toISOString(),
      ]);
    }

    reply.header("Content-Type", "text/csv; charset=utf-8");
    reply.header("Content-Disposition", 'attachment; filename="orders.csv"');
    return reply.send(csv);
  });

  app.get("/api/orders/:orderId", { preHandler: currentAdmin }, async (req, reply) => {
    const orderId = Number((req.params as { orderId: string }).orderId);
    const order = await getOrder(prisma, orderId);
    if (!order) return reply.code(404).send({ error: "Order not found." });
    // The buyer's manual_with_info answers, pre-labeled against the SKU's
    // field spec so the client doesn't need its own JSON-parsing/label-lookup
    // logic — empty arrays for auto orders and manual orders with no custom
    // fields (customerDataFields.length === 0 ⇒ nothing to render).
    const customerDataFields = parseAdditionalFields(order.items[0]?.product.additionalFields ?? null);
    const customerData = parseCustomerData(order.customerData);
    return reply.send({
      order: { ...order, createdAtDisplay: displayDateTime(order.createdAt) },
      money: serializeMoneyView(orderMoneyView(order)),
      isDelivered: order.status === OrderStatus.DELIVERED,
      canAct: order.status === OrderStatus.PENDING_VERIFICATION,
      canCredit:
        order.status === OrderStatus.PENDING_VERIFICATION ||
        order.status === OrderStatus.UNDERPAID,
      // Manual/manual_with_info orders paid and awaiting hand-fulfilment —
      // distinct from canAct/canCredit's PENDING_VERIFICATION gates.
      canFulfill: order.status === OrderStatus.PROCESSING,
      // Reject is legal from PROCESSING too (rejectOrder/LEGAL_TRANSITIONS) —
      // the only way to unstick a paid manual order an admin can't actually
      // source (audit-per-sku-delivery-flows-2026-07-13.md finding #2).
      // Distinct from canAct: PROCESSING has no "Approve & Deliver" action.
      canReject:
        order.status === OrderStatus.PENDING_VERIFICATION ||
        order.status === OrderStatus.PROCESSING,
      customerDataFields,
      customerData,
    });
  });

  app.post("/api/orders/:orderId/approve", { preHandler: csrfProtect }, async (req, reply) => {
    const orderId = Number((req.params as { orderId: string }).orderId);
    let settled: "delivered" | "processing" = "delivered";
    try {
      await prisma.$transaction(async (tx) => {
        const result = await settlePaidOrder(tx, orderId, { adminId: req.admin!.userId });
        settled = result.kind;
        const { order } = result;
        if (result.kind === "delivered") {
          await enqueueOrderDeliveredDm(tx, {
            orderId: order.id,
            orderCode: order.orderCode,
            telegramId: order.user.telegramId,
            language: order.user.language,
          });
        }
        await logAdminAction(tx, {
          adminId: req.admin!.userId,
          action: "approve_order",
          targetType: "order",
          targetId: orderId,
          details:
            result.kind === "delivered"
              ? `Approved order ${order.orderCode}.`
              : `Approved payment for order ${order.orderCode}; queued for manual fulfilment.`,
        });
      });
    } catch (e) {
      if (e instanceof ValidationError) {
        return reply.code(422).send({ error: e.message });
      }
      throw e;
    }
    nudgeOutboxDispatcher();
    logger.info(
      settled === "delivered"
        ? `Admin ${req.admin!.userId} approved and delivered order ${orderId} via the web panel`
        : `Admin ${req.admin!.userId} approved payment for order ${orderId} via the web panel; queued for manual fulfilment`,
    );
    return reply.send({ ok: true });
  });

  // Manual re-send of the buyer's account-credentials DM — the fallback for
  // when the automatic enqueue above never reached the buyer (e.g. the
  // dispatcher hit a permanent Telegram error, or the admin approved before
  // this route enqueued anything). Mirrors the bot's one-tap "Resend" button
  // (apps/order-bot/src/handlers/verification.ts resendCredentials): only
  // works once the order is actually DELIVERED, and only for buyers with a
  // Telegram id — web-only buyers see their order on the storefront instead.
  app.post("/api/orders/:orderId/resend", { preHandler: csrfProtect }, async (req, reply) => {
    const orderId = Number((req.params as { orderId: string }).orderId);
    const order = await getOrder(prisma, orderId);
    if (!order) return reply.code(404).send({ error: "Order not found." });
    if (order.status !== OrderStatus.DELIVERED) {
      return reply.code(422).send({ error: "Only a delivered order's credentials can be resent." });
    }
    if (order.user.telegramId == null) {
      return reply.code(422).send({
        error: "This buyer has no Telegram account to notify — they see their order on the storefront.",
      });
    }
    // Manual/manual_with_info orders never reserve a stockItem (see
    // fulfillManualOrder), so ORDER_DELIVERED_DM's stock-credentials file
    // would come out empty — resend the hand-typed deliveredContent instead
    // (Finding #1, audit-per-sku-delivery-flows-2026-07-13.md).
    const deliveryType = order.items[0]?.product.deliveryType;
    const isManual = deliveryType === DeliveryType.MANUAL || deliveryType === DeliveryType.MANUAL_WITH_INFO;
    await prisma.$transaction(async (tx) => {
      if (isManual) {
        await enqueueManualDeliveredDm(tx, {
          orderId: order.id,
          orderCode: order.orderCode,
          telegramId: order.user.telegramId,
          language: order.user.language,
        });
      } else {
        await enqueueOrderDeliveredDm(tx, {
          orderId: order.id,
          orderCode: order.orderCode,
          telegramId: order.user.telegramId,
          language: order.user.language,
        });
      }
      await logAdminAction(tx, {
        adminId: req.admin!.userId,
        action: "order_resend_credentials",
        targetType: "order",
        targetId: orderId,
        details: `Resent the account-credentials notification for order ${order.orderCode}.`,
      });
    });
    nudgeOutboxDispatcher();
    logger.info(
      `Admin ${req.admin!.userId} requeued the account-credentials DM for order ${orderId} via the web panel`,
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
        const order = await rejectOrder(tx, orderId, { adminId: req.admin!.userId, reason });
        await logAdminAction(tx, {
          adminId: req.admin!.userId,
          action: "reject_order",
          targetType: "order",
          targetId: orderId,
          details: `Rejected order ${order!.orderCode}: "${reason.slice(0, 200)}".`,
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

  // Manual hand-fulfilment: an admin types the account content for a
  // PROCESSING (manual/manual_with_info) order and sends it to the buyer.
  // fulfillManualOrder itself always writes its own logAdminAction row
  // (order.manual_fulfill) — unlike approveOrder, it has no adminId===0
  // auto-caller path, every caller here is a real admin — so this route does
  // NOT write a second audit row (would double-log).
  app.post("/api/orders/:orderId/fulfill", { preHandler: csrfProtect }, async (req, reply) => {
    const orderId = Number((req.params as { orderId: string }).orderId);
    const body = req.body as Record<string, unknown>;
    const content = typeof body.content === "string" ? body.content.trim() : "";
    if (!content) {
      return reply.code(400).send({ error: "Delivery content is required." });
    }
    try {
      await prisma.$transaction(async (tx) => {
        await fulfillManualOrder(tx, orderId, { adminId: req.admin!.userId, content });
      });
    } catch (e) {
      if (e instanceof ValidationError) {
        return reply.code(422).send({ error: e.message });
      }
      throw e;
    }
    nudgeOutboxDispatcher();
    logger.info(`Admin ${req.admin!.userId} manually fulfilled order ${orderId} via the web panel`);
    return reply.send({ ok: true });
  });
}
