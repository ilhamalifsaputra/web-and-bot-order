import type { FastifyInstance } from "fastify";
import { OrderStatus, DeliveryType } from "@app/core/enums";
import { ValidationError } from "@app/core/errors";
import { logger } from "@app/core/logger";
import { nudgeOutboxDispatcher } from "@app/core/nudge";
import { parseAdditionalFields, parseCustomerData } from "@app/core/deliveryFields";
import { startOfDayUtc } from "@app/core/datetime";
import { Decimal } from "@app/core/money";
import {
  prisma,
  listOrders,
  countOrders,
  getOrder,
  settlePaidOrder,
  rejectOrder,
  cancelOrder,
  creditOrderToBalance,
  fulfillManualOrder,
  enqueueOrderDeliveredDm,
  enqueueManualDeliveredDm,
  logAdminAction,
  computeOrderEligibility,
  revenueSummary,
  countAwaitingManualFulfillment,
  countProcessing,
  countDelivered,
  countCancelled,
  type OrderFilter,
} from "@app/db";
import { currentAdmin, csrfProtect } from "../../plugins/auth";
import { orderMoneyView } from "../orderMoneyView";
import { displayDate, displayDateTime } from "../../dateDisplay";

const STATUS_VALUES = Object.values(OrderStatus) as string[];
const PAGE_SIZE_OPTIONS = [20, 50, 100];
const DEFAULT_PAGE_SIZE = 20;
// Orders "not delivered and not otherwise voided" — the bulk-cancel
// eligibility gate. Mirrors the terminal set `creditOrderToBalance` guards
// against, minus DELIVERED (checked separately via `isDelivered`).
const TERMINAL_NON_DELIVERED_STATUSES: string[] = [OrderStatus.CANCELLED, OrderStatus.REJECTED, OrderStatus.REFUNDED];
const BULK_ACTIONS = ["deliver", "resend", "cancel"] as const;
type BulkAction = (typeof BULK_ACTIONS)[number];

function shapeRevenue(r: { revenue_idr: Decimal; revenue_usdt: Decimal }) {
  const idr = new Decimal(r.revenue_idr);
  const usdt = new Decimal(r.revenue_usdt);
  return {
    idr: idr.isZero() ? null : idr.toString(),
    usdt: usdt.isZero() ? null : usdt.toString(),
    usd: usdt.isZero() ? null : usdt.toString(), // 1 USDT ≈ 1 USD, same figure under a second label
  };
}

/** Comma-separated raw statuses (filtered to known values) → an array filter,
 * or null when nothing valid was passed (matches every status). */
function parseStatusFilter(raw: string | undefined): string[] | null {
  if (!raw) return null;
  const values = raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => STATUS_VALUES.includes(s));
  return values.length ? values : null;
}

/** Comma-separated numeric order ids → an array filter, or null when empty/malformed. */
function parseIdsFilter(raw: string | undefined): number[] | null {
  if (!raw) return null;
  const ids = raw
    .split(",")
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isInteger(n) && n > 0);
  return ids.length ? ids : null;
}

/** Shared by the list and export routes so their filters can't silently
 * diverge (they used to be built independently). */
function buildOrderFilter(q: Record<string, string | undefined>): OrderFilter {
  return {
    status: parseStatusFilter(q.status) as OrderStatus[] | null,
    q: q.q || null,
    paymentMethod: q.paymentMethod || null,
    ids: parseIdsFilter(q.ids),
    since: parseDate(q.since),
    until: parseDate(q.until),
  };
}

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
    const page = Math.max(Number(q.page) || 1, 1);
    const requestedPageSize = Number(q.pageSize);
    const pageSize = PAGE_SIZE_OPTIONS.includes(requestedPageSize) ? requestedPageSize : DEFAULT_PAGE_SIZE;
    const offset = (page - 1) * pageSize;

    const filter = buildOrderFilter(q);
    const [orders, total] = await Promise.all([
      listOrders(prisma, { ...filter, limit: pageSize, offset }),
      countOrders(prisma, filter),
    ]);

    const ordersWithDisplay = orders.map((o) => ({
      ...o,
      createdAtDisplay: displayDate(o.createdAt),
      eligibility: computeOrderEligibility(o.status, o.user?.telegramId ?? null),
    }));
    return reply.send({
      orders: ordersWithDisplay,
      total,
      page,
      pageSize,
      hasNext: offset + orders.length < total,
      statuses: STATUS_VALUES,
    });
  });

  // Exports the full filtered result set (not just the current page) as a CSV
  // download — `listOrders` defaults to `take: 50`, so this must pass an
  // explicit override or the export would silently truncate.
  app.get("/api/orders/export", { preHandler: currentAdmin }, async (req, reply) => {
    const q = req.query as Record<string, string | undefined>;
    const filter = buildOrderFilter(q);
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
      // isDelivered/canAct/canCredit/canFulfill/canReject/canResend — one
      // shared eligibility function (packages/db/src/crud/orders.ts) so the
      // list, detail, and bulk-action routes can't drift apart.
      ...computeOrderEligibility(order.status, order.user.telegramId),
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

  // Global snapshot for the Orders page's KPI row — deliberately ignores
  // whatever list filters/tab are active, so it always reads as "the whole
  // store today," not "the current view."
  app.get("/api/orders/kpis", { preHandler: currentAdmin }, async (_req, reply) => {
    const todayStart = startOfDayUtc();
    const [totalOrders, revenueToday, awaitingFulfillment, processing, delivered, cancelled] = await Promise.all([
      countOrders(prisma, {}),
      revenueSummary(prisma, todayStart),
      countAwaitingManualFulfillment(prisma),
      countProcessing(prisma),
      countDelivered(prisma),
      countCancelled(prisma),
    ]);
    return reply.send({
      totalOrders,
      revenueToday: shapeRevenue(revenueToday),
      awaitingFulfillment,
      processing,
      delivered,
      cancelled,
    });
  });

  // Store-side void via cancelOrder — releases wallet/stock/voucher holds,
  // no external payment-gateway call (none of the current rails expose a
  // refund API). Modeled on /reject: a reason is required, ValidationError
  // (e.g. an already-DELIVERED order) maps to 422.
  app.post("/api/orders/:orderId/cancel", { preHandler: csrfProtect }, async (req, reply) => {
    const orderId = Number((req.params as { orderId: string }).orderId);
    const reason = ((req.body as Record<string, string>).reason ?? "").trim();
    if (!reason) {
      return reply.code(400).send({ error: "A cancellation reason is required." });
    }
    try {
      await prisma.$transaction(async (tx) => {
        const order = await cancelOrder(tx, orderId, `admin_cancelled: ${reason}`);
        await logAdminAction(tx, {
          adminId: req.admin!.userId,
          action: "cancel_order",
          targetType: "order",
          targetId: orderId,
          details: `Cancelled order ${order!.orderCode}: "${reason.slice(0, 200)}".`,
        });
      });
    } catch (e) {
      if (e instanceof ValidationError) {
        return reply.code(422).send({ error: e.message });
      }
      throw e;
    }
    logger.info(`Admin ${req.admin!.userId} cancelled order ${orderId} via the web panel`);
    return reply.send({ ok: true });
  });

  // Bulk row-selection actions from the Orders page toolbar. One endpoint
  // with an action discriminator (not three routes) since deliver/resend/
  // cancel all share the same loop-over-ids/aggregate-result shape. Runs one
  // short $transaction per order SEQUENTIALLY (never Promise.all, never one
  // transaction spanning all ids) — SQLite is single-writer (CLAUDE.md), and
  // an unbounded concurrent batch would stall other writers (bot, storefront
  // checkout) for the request's duration; the 50-id cap below bounds how
  // long that serialization can run.
  app.post("/api/orders/bulk-action", { preHandler: csrfProtect }, async (req, reply) => {
    const body = (req.body ?? {}) as { ids?: unknown; action?: unknown; reason?: unknown };
    const ids = Array.isArray(body.ids)
      ? body.ids.map((id) => Number(id)).filter((id) => Number.isInteger(id) && id > 0)
      : [];
    if (ids.length === 0) {
      return reply.code(400).send({ error: "Select at least one order." });
    }
    if (ids.length > 50) {
      return reply.code(400).send({ error: "Select 50 orders or fewer per bulk action." });
    }
    const action = body.action as BulkAction;
    if (!BULK_ACTIONS.includes(action)) {
      return reply.code(400).send({ error: "Unknown bulk action." });
    }
    const reason = typeof body.reason === "string" ? body.reason.trim() : "";
    if (action === "cancel" && !reason) {
      return reply.code(400).send({ error: "A cancellation reason is required." });
    }

    const succeeded: number[] = [];
    const failed: { id: number; error: string }[] = [];

    for (const orderId of ids) {
      const order = await getOrder(prisma, orderId);
      if (!order) {
        failed.push({ id: orderId, error: "error.order_not_found" });
        continue;
      }
      const eligibility = computeOrderEligibility(order.status, order.user.telegramId);

      try {
        if (action === "deliver") {
          // NOT canFulfill — a PROCESSING (manual-fulfilment) order needs an
          // admin to type real content; it can never be blindly bulk-delivered.
          if (!eligibility.canAct) {
            failed.push({ id: orderId, error: "error.not_eligible" });
            continue;
          }
          await prisma.$transaction(async (tx) => {
            const result = await settlePaidOrder(tx, orderId, { adminId: req.admin!.userId });
            if (result.kind === "delivered") {
              await enqueueOrderDeliveredDm(tx, {
                orderId: result.order.id,
                orderCode: result.order.orderCode,
                telegramId: result.order.user.telegramId,
                language: result.order.user.language,
              });
            }
          });
        } else if (action === "resend") {
          if (!eligibility.canResend) {
            failed.push({ id: orderId, error: "error.not_eligible" });
            continue;
          }
          // Same manual-vs-auto DM branch as the single-order /resend route
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
          });
        } else {
          // "cancel"
          if (eligibility.isDelivered || TERMINAL_NON_DELIVERED_STATUSES.includes(order.status)) {
            failed.push({ id: orderId, error: "error.not_eligible" });
            continue;
          }
          await prisma.$transaction(async (tx) => {
            await cancelOrder(tx, orderId, `admin_bulk_cancel: ${reason}`);
          });
        }
        succeeded.push(orderId);
      } catch (e) {
        failed.push({ id: orderId, error: e instanceof ValidationError ? e.message : "error.unexpected" });
      }
    }

    // One summary audit row per bulk call, not one per order (would flood
    // the audit log the shop admins actually read — CLAUDE.md logging convention).
    await logAdminAction(prisma, {
      adminId: req.admin!.userId,
      action: `order_bulk_${action}`,
      targetType: "order",
      targetId: null,
      details: `Bulk ${action}: ${succeeded.length} succeeded, ${failed.length} failed (of ${ids.length} selected).`,
    });

    if ((action === "deliver" || action === "resend") && succeeded.length > 0) {
      nudgeOutboxDispatcher();
    }
    logger.info(
      `Admin ${req.admin!.userId} ran a bulk ${action} action on ${ids.length} orders via the web panel: ${succeeded.length} succeeded, ${failed.length} failed`,
    );
    return reply.send({ succeeded, failed });
  });
}
