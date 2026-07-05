/**
 * JSON twins of the account area (routes/account.ts) + settings
 * (routes/settings.ts) for the React SPA. Same crud calls, same validation,
 * same ownership checks (404 — never 403 — so ids/codes can't be probed).
 * Reads return 401 JSON when anonymous (the SPA redirects to /login?next=…,
 * replacing the HTML routes' 303). Mutations additionally require the
 * x-csrf-token header. Errors are i18n KEYS rendered by the client's t().
 *
 * Dates are pre-formatted server-side with the SAME localize() the Nunjucks
 * localdt filter used (shop timezone), plus ISO fields where the client needs
 * to compute (none today, kept for forward-compat).
 *
 * GET /account/settings/link-telegram (Telegram widget redirect) stays a
 * server-side route in routes/settings.ts — it's a whole-page redirect flow.
 */
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import { config } from "@app/core/config";
import { localize } from "@app/core/datetime";
import { SenderType, OrderStatus, TicketStatus } from "@app/core/enums";
import { ValidationError } from "@app/core/errors";
import { hashPassword, verifyPassword } from "@app/core/password";
import { Decimal } from "@app/core/money";
import {
  prisma,
  setSetting,
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
  getDenominationWithProduct,
  setLoginCredentials,
  LOGIN_USERNAME_RE,
} from "@app/db";
import {
  newJti,
  shopSessionJtiKey,
  makeCustomerSession,
  SHOP_COOKIE_NAME,
  SHOP_SESSION_TTL_HOURS,
} from "../auth";
import { optionalCustomer, type Customer } from "../plugins/auth";
import { resolveBotUsername } from "../shop";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Stored-UTC → shop-timezone display, byte-identical to the localdt filter. */
const dt = (d: Date, fmt = "yyyy-LL-dd HH:mm"): string => localize(d, fmt);

/** JSON-flavored auth gate: 401 body instead of the HTML routes' 303. */
async function requireCustomer(req: FastifyRequest, reply: FastifyReply): Promise<Customer | null> {
  const customer = await optionalCustomer(req);
  if (!customer) {
    void reply.code(401).send({ error: "unauthorized" });
    return null;
  }
  return customer;
}

/** x-csrf-token header check for signed-in JSON mutations. */
function csrfHeaderOk(req: FastifyRequest, customer: Customer): boolean {
  const token = req.headers["x-csrf-token"];
  return Boolean(token) && token === customer.csrf;
}

const apiAccountRoutes: FastifyPluginAsync = async (app) => {
  // ---- Overview ----
  app.get("/account", async (req, reply) => {
    const customer = await requireCustomer(req, reply);
    if (!customer) return;
    const orderCount = await countUserOrders(prisma, customer.userId);
    return reply.send({
      name: customer.user.fullName ?? customer.user.username ?? String(customer.telegramId ?? ""),
      order_count: orderCount,
      referral_code: customer.user.referralCode,
      wallet_idr: new Decimal(customer.user.walletBalance).toString(),
      wallet_usdt: new Decimal(customer.user.walletBalanceUsdt).toString(),
    });
  });

  // ---- My orders ----
  app.get("/account/orders", async (req, reply) => {
    const customer = await requireCustomer(req, reply);
    if (!customer) return;
    const orders = await listUserOrders(prisma, customer.userId, 30, 0);
    return reply.send({
      orders: orders.map((o) => ({
        code: o.orderCode,
        status: o.status,
        total: o.totalAmount.toString(),
        created_at_display: dt(o.createdAt),
        items: o.items.map((i) => i.product.name).join(", "),
      })),
    });
  });

  app.get<{ Params: { code: string } }>("/account/orders/:code", async (req, reply) => {
    const customer = await requireCustomer(req, reply);
    if (!customer) return;
    const order = await getOrderByCodeFull(prisma, req.params.code);
    // Ownership check — 404 (not 403) so codes can't be probed.
    if (!order || order.userId !== customer.userId) {
      return reply.code(404).send({ error: "not_found" });
    }
    const delivered = order.status === OrderStatus.DELIVERED;
    return reply.send({
      order: {
        code: order.orderCode,
        status: order.status,
        subtotal: order.subtotalAmount.toString(),
        discount: order.discountAmount.toString(),
        bulk_discount: order.bulkDiscountAmount.toString(),
        total: order.totalAmount.toString(),
        created_at_display: dt(order.createdAt),
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
  });

  // ---- Referral ----
  app.get("/account/referral", async (req, reply) => {
    const customer = await requireCustomer(req, reply);
    if (!customer) return;
    const code = customer.user.referralCode;
    const username = await resolveBotUsername();
    return reply.send({
      referral_code: code,
      referral_link: username ? `https://t.me/${username}?start=ref_${code}` : null,
    });
  });

  // ---- My reviews ----
  app.get("/account/reviews", async (req, reply) => {
    const customer = await requireCustomer(req, reply);
    if (!customer) return;
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
    return reply.send({
      pending,
      reviews: myReviews.map((r) => ({
        product_name: r.product.name,
        rating: r.rating,
        comment: r.comment,
        created_at_display: dt(r.createdAt, "yyyy-LL-dd"),
      })),
    });
  });

  app.post<{ Body: { order_id?: number; product_id?: number; rating?: number; comment?: string } }>(
    "/account/reviews",
    async (req, reply) => {
      const customer = await requireCustomer(req, reply);
      if (!customer) return;
      if (!csrfHeaderOk(req, customer)) return reply.code(403).send({ error: "csrf_failed" });
      const rating = Math.min(5, Math.max(1, Number(req.body?.rating) || 0));
      try {
        await createReview(prisma, {
          userId: customer.userId,
          orderId: Number(req.body?.order_id),
          productId: Number(req.body?.product_id),
          rating,
          comment: (req.body?.comment ?? "").trim().slice(0, 1000) || null,
        });
      } catch (e) {
        if (!(e instanceof ValidationError)) throw e; // bad order/dupe → just bounce
      }
      return reply.send({ ok: true });
    },
  );

  // ---- Support ----
  app.get("/account/support", async (req, reply) => {
    const customer = await requireCustomer(req, reply);
    if (!customer) return;
    const tickets = await listUserTickets(prisma, customer.userId, 20);
    return reply.send({
      tickets: tickets.map((tk) => ({
        id: tk.id,
        message: tk.message,
        status: tk.status,
        created_at_display: dt(tk.createdAt),
        admin_reply: tk.adminReply,
      })),
    });
  });

  app.post<{ Body: { message?: string } }>("/account/support", async (req, reply) => {
    const customer = await requireCustomer(req, reply);
    if (!customer) return;
    if (!csrfHeaderOk(req, customer)) return reply.code(403).send({ error: "csrf_failed" });
    const message = (req.body?.message ?? "").trim().slice(0, 2000);
    if (message) {
      await createTicket(prisma, customer.userId, message);
    }
    return reply.send({ ok: true });
  });

  app.post<{ Params: { id: string }; Body: { message?: string } }>(
    "/account/support/:id/reply",
    async (req, reply) => {
      const customer = await requireCustomer(req, reply);
      if (!customer) return;
      if (!csrfHeaderOk(req, customer)) return reply.code(403).send({ error: "csrf_failed" });
      const ticket = await getTicket(prisma, Number(req.params.id));
      const message = (req.body?.message ?? "").trim().slice(0, 2000);
      if (ticket && ticket.userId === customer.userId && ticket.status !== TicketStatus.CLOSED && message) {
        await addTicketMessage(prisma, {
          ticketId: ticket.id,
          senderType: SenderType.USER,
          senderId: customer.userId,
          content: message,
        });
      }
      return reply.send({ ok: true });
    },
  );

  app.get<{ Params: { id: string } }>("/account/support/:id", async (req, reply) => {
    const customer = await requireCustomer(req, reply);
    if (!customer) return;
    const ticket = await getTicket(prisma, Number(req.params.id));
    if (!ticket || ticket.userId !== customer.userId) {
      return reply.code(404).send({ error: "not_found" });
    }
    const messages = await listTicketMessages(prisma, ticket.id, 30);
    return reply.send({
      ticket: {
        id: ticket.id,
        message: ticket.message,
        status: ticket.status,
        created_at_display: dt(ticket.createdAt),
        admin_reply: ticket.adminReply,
        closed: ticket.status === TicketStatus.CLOSED,
      },
      messages: messages.map((m) => ({
        from_user: m.senderType === SenderType.USER,
        content: m.content,
        created_at_display: dt(m.createdAt),
      })),
    });
  });

  // ---- Restock subscription (from product page; works only when logged in) ----
  app.post<{ Params: { id: string } }>("/restock/:id", async (req, reply) => {
    const customer = await requireCustomer(req, reply);
    if (!customer) return;
    if (!csrfHeaderOk(req, customer)) return reply.code(403).send({ error: "csrf_failed" });
    const denom = await getDenominationWithProduct(prisma, Number(req.params.id));
    if (denom?.isActive) {
      await subscribeToRestock(prisma, customer.userId, denom.id);
    }
    // The SPA bounces back to the parent product detail (slug URL).
    return reply.send({ ok: true, redirect: denom ? `/p/${denom.product.slug}` : "/" });
  });

  // ---- Settings ----
  app.get("/account/settings", async (req, reply) => {
    const customer = await requireCustomer(req, reply);
    if (!customer) return;
    return reply.send({
      bot_username: await resolveBotUsername(),
      values: {
        username: customer.user.loginUsername ?? "",
        email: customer.user.email ?? "",
      },
      has_password: Boolean(customer.user.passwordHash),
      tg_linked: customer.user.telegramId != null,
      tg_name:
        customer.user.username ??
        customer.user.fullName ??
        String(customer.user.telegramId ?? ""),
    });
  });

  app.post<{
    Body: { username?: string; email?: string; current_password?: string; new_password?: string };
  }>("/account/settings/credentials", async (req, reply) => {
    const customer = await requireCustomer(req, reply);
    if (!customer) return;
    if (!csrfHeaderOk(req, customer)) return reply.code(403).send({ error: "csrf_failed" });
    const username = (req.body?.username ?? "").trim().toLowerCase();
    const email = (req.body?.email ?? "").trim().toLowerCase();
    const newPassword = req.body?.new_password ?? "";

    if (username && !LOGIN_USERNAME_RE.test(username))
      return reply.code(400).send({ error: "web.register_username_invalid" });
    if (email && !EMAIL_RE.test(email))
      return reply.code(400).send({ error: "web.register_email_invalid" });
    if (newPassword && newPassword.length < 8)
      return reply.code(400).send({ error: "web.register_password_short" });

    const changes: { loginUsername?: string; email?: string; passwordHash?: string } = {};
    if (username && username !== customer.user.loginUsername) changes.loginUsername = username;
    if (email && email !== customer.user.email) changes.email = email;

    // Re-auth via current_password for ANY credential change (username,
    // email, or password) — same Storefront-3 guard as the HTML route.
    // Skipped only when the account has no password yet (Telegram-login-only).
    const changingCredentials = Boolean(changes.loginUsername || changes.email || newPassword);
    if (changingCredentials && customer.user.passwordHash) {
      if (!verifyPassword(req.body?.current_password ?? "", customer.user.passwordHash)) {
        return reply.code(400).send({ error: "web.settings_wrong_password" });
      }
    }
    if (newPassword) changes.passwordHash = hashPassword(newPassword);

    try {
      await setLoginCredentials(prisma, customer.userId, changes);
    } catch (e) {
      if (e instanceof ValidationError) return reply.code(400).send({ error: e.message });
      throw e;
    }

    // Rotate the session jti on password change (Storefront-2 guard) and
    // refresh THIS session's cookie so the user isn't logged out by their own
    // action — every OTHER device's session is what gets invalidated. The SPA
    // does a full reload after this so the shell re-serves the rotated CSRF.
    let passwordChanged = false;
    if (changes.passwordHash) {
      passwordChanged = true;
      const jti = newJti();
      await setSetting(prisma, shopSessionJtiKey(customer.userId), jti);
      const { raw } = makeCustomerSession(customer.userId, customer.user.telegramId, jti);
      void reply.setCookie(SHOP_COOKIE_NAME, raw, {
        path: "/",
        httpOnly: true,
        sameSite: "lax",
        secure: config.WEB_COOKIE_SECURE,
        maxAge: SHOP_SESSION_TTL_HOURS * 3600,
      });
    }
    return reply.send({ ok: true, password_changed: passwordChanged });
  });
};

export default apiAccountRoutes;
