/**
 * Customer account area (login required): overview, my orders (+credentials on
 * DELIVERED), referral code, my reviews, support tickets. All reads/writes go
 * through the same crud the bot uses; the web NEVER sends Telegram (outbox
 * pattern) and never shows credentials except to the owner of a DELIVERED
 * order (design.md §9).
 */
import type { FastifyPluginAsync } from "fastify";
import { botUsername } from "@app/core/runtime";
import { SenderType, OrderStatus, TicketStatus } from "@app/core/enums";
import { t } from "@app/core/i18n";
import { ValidationError } from "@app/core/errors";
import {
  prisma,
  listUserOrders,
  countUserOrders,
  getOrderByCodeFull,
  listUserDeliveredOrders,
  listUserTickets,
  listTicketMessages,
  getTicket,
  createTicket,
  addTicketMessage,
  createReview,
  listReviews,
  subscribeToRestock,
  getProduct,
} from "@app/db";
import { currentCustomer, csrfProtect } from "../plugins/auth";
import { shopContext } from "../shop";

const accountRoutes: FastifyPluginAsync = async (app) => {
  // ---- Overview ----
  app.get("/account", { preHandler: currentCustomer }, async (req, reply) => {
    const ctx = await shopContext(req, "/account");
    const customer = req.customer!;
    const orderCount = await countUserOrders(prisma, customer.userId);
    return reply.view("account.njk", {
      ...ctx,
      customer,
      order_count: orderCount,
      referral_code: customer.user.referralCode,
    });
  });

  // ---- My orders ----
  app.get("/account/orders", { preHandler: currentCustomer }, async (req, reply) => {
    const ctx = await shopContext(req, "/account");
    const customer = req.customer!;
    const orders = await listUserOrders(prisma, customer.userId, 30, 0);
    return reply.view("orders.njk", {
      ...ctx,
      customer,
      orders: orders.map((o) => ({
        code: o.orderCode,
        status: o.status,
        total: o.totalAmount.toString(),
        created_at: o.createdAt,
        items: o.items.map((i) => i.product.name).join(", "),
      })),
    });
  });

  app.get<{ Params: { code: string } }>(
    "/account/orders/:code",
    { preHandler: currentCustomer },
    async (req, reply) => {
      const ctx = await shopContext(req, "/account");
      const customer = req.customer!;
      const order = await getOrderByCodeFull(prisma, req.params.code);
      // Ownership check — 404 (not 403) so codes can't be probed.
      if (!order || order.userId !== customer.userId) {
        return reply.code(404).view("error.njk", {
          ...ctx,
          status_code: 404,
          message: t("web.not_found", ctx.lang),
        });
      }
      const delivered = order.status === OrderStatus.DELIVERED;
      return reply.view("order_detail.njk", {
        ...ctx,
        customer,
        order: {
          code: order.orderCode,
          status: order.status,
          subtotal: order.subtotalAmount.toString(),
          discount: order.discountAmount.toString(),
          bulk_discount: order.bulkDiscountAmount.toString(),
          total: order.totalAmount.toString(),
          created_at: order.createdAt,
          expires_at: order.expiresAt,
          items: order.items.map((i) => ({
            name: i.product.name,
            duration: i.product.durationLabel,
            unit_price: i.unitPrice.toString(),
            warranty_days: i.warrantyDaysSnapshot,
            // Credentials only for the owner of a DELIVERED order.
            credentials: delivered && i.stockItem ? i.stockItem.credentials : null,
          })),
        },
        delivered,
        pending_payment: order.status === OrderStatus.PENDING_PAYMENT,
      });
    },
  );

  // ---- Referral ----
  app.get("/account/referral", { preHandler: currentCustomer }, async (req, reply) => {
    const ctx = await shopContext(req, "/account");
    const customer = req.customer!;
    const code = customer.user.referralCode;
    return reply.view("referral.njk", {
      ...ctx,
      customer,
      referral_code: code,
      referral_link: `https://t.me/${botUsername() ?? ""}?start=ref_${code}`,
    });
  });

  // ---- My reviews ----
  app.get("/account/reviews", { preHandler: currentCustomer }, async (req, reply) => {
    const ctx = await shopContext(req, "/account");
    const customer = req.customer!;
    const [delivered, myReviews] = await Promise.all([
      listUserDeliveredOrders(prisma, customer.userId, 20),
      listReviews(prisma, { userId: customer.userId, limit: 50 }),
    ]);
    const reviewedOrderIds = new Set(myReviews.map((r) => r.orderId));
    // One review per order (unique userId+orderId) — offer the first product.
    const pending = delivered
      .filter((o) => !reviewedOrderIds.has(o.id))
      .map((o) => ({
        order_id: o.id,
        code: o.orderCode,
        product_id: o.items[0]?.productId ?? null,
        product_name: o.items.map((i) => i.product.name).join(", "),
      }))
      .filter((p) => p.product_id !== null);
    return reply.view("reviews.njk", {
      ...ctx,
      customer,
      pending,
      reviews: myReviews.map((r) => ({
        product_name: r.product.name,
        rating: r.rating,
        comment: r.comment,
        created_at: r.createdAt,
      })),
    });
  });

  app.post<{ Body: { order_id: string; product_id: string; rating: string; comment?: string } }>(
    "/account/reviews",
    { preHandler: csrfProtect },
    async (req, reply) => {
      const customer = req.customer!;
      const rating = Math.min(5, Math.max(1, Number(req.body.rating) || 0));
      try {
        await createReview(prisma, {
          userId: customer.userId,
          orderId: Number(req.body.order_id),
          productId: Number(req.body.product_id),
          rating,
          comment: (req.body.comment ?? "").trim().slice(0, 1000) || null,
        });
      } catch (e) {
        if (!(e instanceof ValidationError)) throw e; // bad order/dupe → just bounce
      }
      return reply.code(303).redirect("/account/reviews");
    },
  );

  // ---- Support ----
  app.get("/account/support", { preHandler: currentCustomer }, async (req, reply) => {
    const ctx = await shopContext(req, "/account");
    const customer = req.customer!;
    const tickets = await listUserTickets(prisma, customer.userId, 20);
    return reply.view("support.njk", {
      ...ctx,
      customer,
      tickets: tickets.map((tk) => ({
        id: tk.id,
        message: tk.message,
        status: tk.status,
        created_at: tk.createdAt,
        admin_reply: tk.adminReply,
      })),
    });
  });

  app.post<{ Body: { message: string } }>(
    "/account/support",
    { preHandler: csrfProtect },
    async (req, reply) => {
      const customer = req.customer!;
      const message = (req.body.message ?? "").trim().slice(0, 2000);
      if (message) {
        await createTicket(prisma, customer.userId, message);
      }
      return reply.code(303).redirect("/account/support");
    },
  );

  app.post<{ Params: { id: string }; Body: { message: string } }>(
    "/account/support/:id/reply",
    { preHandler: csrfProtect },
    async (req, reply) => {
      const customer = req.customer!;
      const ticket = await getTicket(prisma, Number(req.params.id));
      const message = (req.body.message ?? "").trim().slice(0, 2000);
      if (ticket && ticket.userId === customer.userId && ticket.status !== TicketStatus.CLOSED && message) {
        await addTicketMessage(prisma, {
          ticketId: ticket.id,
          senderType: SenderType.USER,
          senderId: customer.userId,
          content: message,
        });
      }
      return reply.code(303).redirect("/account/support");
    },
  );

  // ---- Restock subscription (from product page; works only when logged in) ----
  app.post<{ Params: { id: string } }>(
    "/restock/:id",
    { preHandler: csrfProtect },
    async (req, reply) => {
      const customer = req.customer!;
      const product = await getProduct(prisma, Number(req.params.id));
      if (product?.isActive) {
        await subscribeToRestock(prisma, customer.userId, product.id);
      }
      return reply.code(303).redirect(product ? `/p/${product.id}` : "/");
    },
  );

  // Convenience: GET /account/support etc. handled above; ticket thread detail
  app.get<{ Params: { id: string } }>(
    "/account/support/:id",
    { preHandler: currentCustomer },
    async (req, reply) => {
      const ctx = await shopContext(req, "/account");
      const customer = req.customer!;
      const ticket = await getTicket(prisma, Number(req.params.id));
      if (!ticket || ticket.userId !== customer.userId) {
        return reply.code(404).view("error.njk", {
          ...ctx,
          status_code: 404,
          message: t("web.not_found", ctx.lang),
        });
      }
      const messages = await listTicketMessages(prisma, ticket.id, 30);
      return reply.view("ticket_detail.njk", {
        ...ctx,
        customer,
        ticket: {
          id: ticket.id,
          message: ticket.message,
          status: ticket.status,
          created_at: ticket.createdAt,
          admin_reply: ticket.adminReply,
          closed: ticket.status === TicketStatus.CLOSED,
        },
        messages: messages.map((m) => ({
          from_user: m.senderType === SenderType.USER,
          content: m.content,
          created_at: m.createdAt,
        })),
      });
    },
  );
};

export default accountRoutes;
