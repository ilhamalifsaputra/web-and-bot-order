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
import { localize, addDays } from "@app/core/datetime";
import { CategoryGroup, SenderType, OrderStatus, OrderKind, TicketStatus, zTicketCategory } from "@app/core/enums";
import { ValidationError } from "@app/core/errors";
import { hashPassword, verifyPassword } from "@app/core/password";
import { Decimal } from "@app/core/money";
import { parseCustomerData } from "@app/core/deliveryFields";
import { orderInputConfig, parseInputFields } from "@app/core/playerInput";
import { getOrderFulfillment, toBuyerDigiflazzStatus } from "@app/core/orderFulfillment";
import { buyerOrderSummary } from "./buyerOrderSummary";
import {
  parseTicketMultipart,
  parseNewTicketMultipart,
  writeAttachments,
  type ParsedAttachment,
} from "../lib/ticketAttachments";
import {
  prisma,
  setSetting,
  listUserOrders,
  countUserOrders,
  getOrderByCode,
  getOrderByCodeFull,
  getOrderByCodeFullForDisplay,
  updateOrderCustomerData,
  listUserDeliveredOrders,
  listUserTickets,
  listUserTicketsPaged,
  getUserTicketStats,
  listTicketMessages,
  getTicket,
  getTicketWithOrder,
  createTicket,
  addTicketMessage,
  getOpenTicketForOrder,
  closeTicketByUser,
  reopenTicket,
  TICKET_REOPEN_WINDOW_DAYS,
  createReview,
  listReviews,
  subscribeToRestock,
  getDenominationWithProduct,
  setLoginCredentials,
  adoptUserPreferredCurrencyIfUnset,
  LOGIN_USERNAME_RE,
  getReferralSummary,
  isServiceActive,
  listActiveProductOptions,
  getCatalogProduct,
} from "@app/db";
import type { SupportTicketListSort, SupportTicketStatusFilter } from "@app/db";
import {
  newJti,
  shopSessionJtiKey,
  makeCustomerSession,
  SHOP_COOKIE_NAME,
  SHOP_SESSION_TTL_HOURS,
} from "../auth";
import { optionalCustomer, type Customer } from "../plugins/auth";
import { resolveBotId, resolveBotUsername, requestCurrency } from "../shop";
import { constantTimeEqual } from "../auth";
import { errorBody } from "@app/core/errorBody";
import { originOk } from "./cart";
import { startTelegramLinkIntent } from "../telegramLinkIntent";
import { guestClaimLockedOut, recordGuestClaimFailure } from "../rateLimit";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Stored-UTC → shop-timezone display, byte-identical to the localdt filter. */
const dt = (d: Date, fmt = "yyyy-LL-dd HH:mm"): string => localize(d, fmt);

/** `attachment_urls` is stored as a comma-joined string (same convention as photo_file_ids). */
const splitAttachments = (v: string | null): string[] => (v ? v.split(",").filter(Boolean) : []);

/** The /help list-control query vocabularies (Task 11). An unrecognized value
 * on either falls back to the default (mirrors apiPages.ts's `isSortKey`
 * handling — a bad `?sort=` there just falls through, it doesn't 400). */
const SUPPORT_LIST_SORTS: readonly SupportTicketListSort[] = [
  "latest_update",
  "created_desc",
  "created_asc",
];
const SUPPORT_STATUS_FILTERS: readonly SupportTicketStatusFilter[] = [
  "all",
  "waiting_for_you",
  "waiting_for_support",
  "in_progress",
  "resolved",
  "closed",
];

/** Newest activity instant across a ticket's lifecycle stamps, as an ISO
 * string — the /help list's "last updated" value. `messages[0]` is only
 * present on rows from `listUserTicketsPaged` (the paged branch); the plain
 * `listUserTickets` rows just omit that candidate and fall back to
 * `createdAt` at worst (which is always set, so the result is never
 * `-Infinity`). */
function newestActivityIso(tk: {
  createdAt: Date;
  repliedAt: Date | null;
  lastStatusChangeAt: Date;
  resolvedAt: Date | null;
  closedAt: Date | null;
  messages?: { createdAt: Date }[];
}): string {
  const stamps: Array<Date | null | undefined> = [
    tk.createdAt,
    tk.repliedAt,
    tk.lastStatusChangeAt,
    tk.resolvedAt,
    tk.closedAt,
    tk.messages?.[0]?.createdAt,
  ];
  const newest = Math.max(...stamps.map((d) => d?.getTime() ?? -Infinity));
  return new Date(newest).toISOString();
}

/** Buyer-facing support ticket row — shared by the no-query-param branch of
 * `GET /account/support` (rows from `listUserTickets`) and the paged branch
 * (rows from `listUserTicketsPaged`). `order`/`product`/`messages` are only
 * included on the paged rows; on the plain rows `order_code`/`product_name`
 * resolve to `null`, which is correct — neither existing consumer
 * (SupportPage.tsx, TicketDetailPage.tsx's sidebar) reads them, and adding a
 * relation-fetch to the plain path would cost every unaffected caller an
 * extra query for nothing. */
function mapSupportTicketRow(tk: {
  id: number;
  message: string;
  status: string;
  subject: string | null;
  adminReply: string | null;
  attachmentUrls: string | null;
  createdAt: Date;
  repliedAt: Date | null;
  lastStatusChangeAt: Date;
  resolvedAt: Date | null;
  closedAt: Date | null;
  order?: { orderCode: string } | null;
  product?: { name: string } | null;
  messages?: { createdAt: Date }[];
}) {
  return {
    id: tk.id,
    message: tk.message,
    status: tk.status,
    created_at_display: dt(tk.createdAt),
    admin_reply: tk.adminReply,
    attachments: splitAttachments(tk.attachmentUrls),
    // Additive (Task 11) — see mapSupportTicketRow's own doc comment.
    subject: tk.subject ?? null,
    order_code: tk.order?.orderCode ?? null,
    product_name: tk.product?.name ?? null,
    updated_at_iso: newestActivityIso(tk),
  };
}

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
  return typeof token === "string" && constantTimeEqual(token, customer.csrf) && originOk(req);
}

const apiAccountRoutes: FastifyPluginAsync = async (app) => {
  // ---- Overview ----
  app.get("/account", async (req, reply) => {
    const customer = await requireCustomer(req, reply);
    if (!customer) return;
    const orderCount = await countUserOrders(prisma, customer.userId);
    return reply.send({
      name:
        customer.user.fullName ??
        customer.user.username ??
        customer.user.loginUsername ??
        String(customer.telegramId ?? ""),
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
        fulfillment: getOrderFulfillment(o),
        // Task 5 fix pass: `total` is denominated in the order's OWN
        // settlement currency ("IDR" | "USDT"), not always IDR — the client
        // formats it natively (formatOrderAmount), never display-converts it.
        currency: o.currency,
        total: o.totalAmount.toString(),
        created_at_display: dt(o.createdAt),
        items: o.items.map((i) => i.product.name).join(", "),
      })),
    });
  });

  app.get<{ Params: { code: string } }>("/account/orders/:code", async (req, reply) => {
    const customer = await requireCustomer(req, reply);
    if (!customer) return;
    // Display-only reader: one unreadable credential shows as null, not a 500.
    const order = await getOrderByCodeFullForDisplay(prisma, req.params.code);
    // Ownership check — 404 (not 403) so codes can't be probed. A
    // WALLET_TOPUP order is also 404'd here: it's not a "My Orders" purchase
    // (it's already visible via the wallet ledger), so it should not be
    // reachable by code on this buyer-facing product-order detail route
    // either — same exclusion listUserOrders/countUserOrders apply.
    if (!order || order.userId !== customer.userId || order.kind !== OrderKind.PRODUCT) {
      return reply.code(404).send({ error: "not_found" });
    }
    const delivered = order.status === OrderStatus.DELIVERED;
    // Purchased input fields are authoritative; legacy orders without a
    // snapshot use their denomination's configuration, as the edit path does.
    const denomination = order.items[0]?.product;
    const inputConfig = orderInputConfig({
      additionalFields: denomination?.additionalFields ?? null,
      providerInputMapping: denomination?.providerInputMapping ?? null,
    }, order.inputConfigSnapshot);
    const customerDataFields = parseInputFields(inputConfig.additionalFields);
    const customerData = parseCustomerData(order.customerData);
    const money = buyerOrderSummary(order);
    return reply.send({
      order: {
        code: order.orderCode,
        status: order.status,
        subtotal: money.subtotal.toString(),
        discount: money.discount.toString(),
        bulk_discount: money.bulkDiscount.toString(),
        wallet_credit: money.walletCredit.toString(),
        // Task 5 fix pass: the currency `total` is denominated in (the order's
        // own settlement rail). subtotal/discount/bulk_discount/unit_price
        // above/below stay central-IDR for every order — see
        // buyerOrderSummary.ts's "IDR ONLY, DELIBERATELY" note.
        currency: order.currency,
        total: order.totalAmount.toString(),
        created_at_display: dt(order.createdAt),
        customer_data_fields: customerDataFields,
        customer_data: customerData,
        delivered_content: order.deliveredContent,
        digiflazz_status: toBuyerDigiflazzStatus(order.digiflazzStatus),
        fulfillment: getOrderFulfillment(order),
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
      processing: order.status === OrderStatus.PROCESSING,
    });
  });

  // Edit buyer-submitted manual_with_info answers while the order is still
  // PROCESSING (paid, awaiting hand fulfilment) — the storefront twin of the
  // bot's editCustomerInfoConversation (Task 9). updateOrderCustomerData is
  // the final authority: it re-validates against the SKU's field spec and
  // throws error.order_not_processing if the order left PROCESSING between
  // the buyer loading the page and submitting (e.g. an admin fulfilled it
  // mid-edit) — the client re-syncs to the server's real state on that error
  // rather than silently dropping the edit.
  app.patch<{ Params: { code: string }; Body: { customer_data?: unknown } }>(
    "/account/orders/:code/info",
    async (req, reply) => {
      const customer = await requireCustomer(req, reply);
      if (!customer) return;
      if (!csrfHeaderOk(req, customer)) return reply.code(403).send({ error: "csrf_failed" });
      // Ownership + kind only — no secret needed, so no decrypting reader (a
      // decrypt here turned one unreadable row into a 500 on this edit).
      const order = await getOrderByCode(prisma, req.params.code);
      if (!order || order.userId !== customer.userId || order.kind !== OrderKind.PRODUCT) {
        return reply.code(404).send({ error: "not_found" });
      }
      try {
        await updateOrderCustomerData(prisma, order.id, req.body?.customer_data);
      } catch (e) {
        if (e instanceof ValidationError) return reply.code(400).send(errorBody(e));
        throw e;
      }
      return reply.send({ ok: true });
    },
  );

  // ---- Referral ----
  app.get("/account/referral", async (req, reply) => {
    const customer = await requireCustomer(req, reply);
    if (!customer) return;
    const code = customer.user.referralCode;
    const username = await resolveBotUsername();
    // Same aggregate the bot's viewReferral handler reads (packages/db/src/crud/referrals.ts
    // getReferralSummary, mirroring apps/order-bot/src/handlers/customer.ts) — the web and
    // the bot must never disagree about a buyer's commission balance.
    const summary = await getReferralSummary(prisma, customer.userId);
    return reply.send({
      referral_code: code,
      referral_link: username ? `https://t.me/${username}?start=ref_${code}` : null,
      referred_count: summary.referredCount,
      earned_usdt: summary.earnedUsdt.toString(),
      commission_percent: config.REFERRAL_COMMISSION_PERCENT,
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
        // Bad order, not delivered, wrong product or a dupe: tell the form so it can
        // say so — answering ok:true made a refused review look sent.
        if (e instanceof ValidationError) return reply.code(400).send(errorBody(e));
        throw e;
      }
      return reply.send({ ok: true });
    },
  );

  // ---- Support ----
  // GET /account/support has TWO shapes (Task 11), chosen by whether ANY
  // list-control query param is present:
  //  - none present  → byte-compatible with the pre-Task-11 response
  //    (`{ tickets: [...] }`, the simple unpaged `listUserTickets` call) so
  //    SupportPage.tsx / TicketDetailPage.tsx's sidebar keep working
  //    unchanged. The per-row mapping gains the additive
  //    subject/order_code/product_name/updated_at_iso fields (order_code /
  //    product_name always null on this branch — see mapSupportTicketRow).
  //  - any of status/q/sort/page/page_size present → the /help page's paged
  //    view: `{ tickets, total, page, page_size, stats }`.
  app.get<{
    Querystring: { status?: string; q?: string; sort?: string; page?: string; page_size?: string };
  }>("/account/support", async (req, reply) => {
    const customer = await requireCustomer(req, reply);
    if (!customer) return;

    const { status, q, sort, page, page_size } = req.query;
    const hasListControls =
      status !== undefined ||
      q !== undefined ||
      sort !== undefined ||
      page !== undefined ||
      page_size !== undefined;

    if (!hasListControls) {
      const tickets = await listUserTickets(prisma, customer.userId, 20);
      return reply.send({ tickets: tickets.map((tk) => mapSupportTicketRow(tk)) });
    }

    // An unrecognized status/sort value falls back to its default rather than
    // 400ing (mirrors apiPages.ts's `isSortKey` handling).
    const statusFilter: SupportTicketStatusFilter = SUPPORT_STATUS_FILTERS.includes(
      status as SupportTicketStatusFilter,
    )
      ? (status as SupportTicketStatusFilter)
      : "all";
    const sortValue: SupportTicketListSort = SUPPORT_LIST_SORTS.includes(sort as SupportTicketListSort)
      ? (sort as SupportTicketListSort)
      : "latest_update";
    // Fastify querystring values are always strings — parse + guard NaN.
    const pageNum = Number(page) || 1;
    const pageSizeNum = Number(page_size) || 10;

    const [{ rows, total }, stats] = await Promise.all([
      listUserTicketsPaged(prisma, customer.userId, {
        status: statusFilter,
        q: q?.trim() || undefined,
        sort: sortValue,
        page: pageNum,
        pageSize: pageSizeNum,
      }),
      getUserTicketStats(prisma, customer.userId),
    ]);

    return reply.send({
      tickets: rows.map((tk) => mapSupportTicketRow(tk)),
      total,
      page: pageNum,
      page_size: pageSizeNum,
      stats,
    });
  });

  app.post<{ Body: { message?: string; order_code?: string } }>("/account/support", async (req, reply) => {
    const customer = await requireCustomer(req, reply);
    if (!customer) return;
    if (!csrfHeaderOk(req, customer)) return reply.code(403).send({ error: "csrf_failed" });
    let message: string;
    let attachments: ParsedAttachment[] = [];
    let orderCodeInput: string | null = null;
    if (req.isMultipart()) {
      try {
        ({ message, attachments, orderCode: orderCodeInput } = await parseTicketMultipart(req));
      } catch (e) {
        if (e instanceof ValidationError) return reply.code(400).send(errorBody(e));
        throw e;
      }
    } else {
      message = (req.body?.message ?? "").trim().slice(0, 2000);
      orderCodeInput = (req.body?.order_code ?? "").trim() || null;
    }
    let orderId: number | null = null;
    if (orderCodeInput) {
      const order = await getOrderByCodeFull(prisma, orderCodeInput);
      if (!order || order.userId !== customer.userId) {
        return reply.code(400).send({ error: "error.order_not_found" });
      }
      orderId = order.id;
    }
    if (orderId !== null) {
      const existingTicket = await getOpenTicketForOrder(prisma, orderId);
      if (existingTicket) {
        return reply.send({ ok: false, duplicate: true, ticket_id: existingTicket.id });
      }
    }
    // M-18 fix (backend audit 2026-07-31): attachments are only written to
    // disk here, after ownership + the message guard below have both passed
    // — never during multipart parsing. An empty-message request with
    // attachments (or one against an order the caller doesn't own) now
    // leaves nothing on disk for storageCleanupJob to never find.
    let ticketId: number | null = null;
    if (message) {
      const attachmentUrls = await writeAttachments(attachments);
      const ticket = await createTicket(prisma, customer.userId, message, null, attachmentUrls, orderId);
      ticketId = ticket.id;
    }
    // STO-020: the client shows a "Ticket #N created" success toast — needs
    // the new ticket's id, which `{ ok: true }` alone never carried.
    return reply.send({ ok: true, ticket_id: ticketId });
  });

  // Form-bootstrap for the /help create-ticket form's Product dropdown (Task
  // 11). Auth-gated like every other /account/* route here even though the
  // data isn't sensitive — consistent with this file's "gate the whole
  // /account/* surface behind requireCustomer" pattern. Static path, so
  // Fastify routes it ahead of GET /account/support/:id.
  app.get("/account/support/new", async (req, reply) => {
    const customer = await requireCustomer(req, reply);
    if (!customer) return;
    const products = await listActiveProductOptions(prisma);
    return reply.send({ products });
  });

  // POST /account/support/new — the /help create-ticket form's own endpoint
  // (Task 11), a SIBLING of the legacy POST /account/support above (left
  // byte-identical so SupportPage.tsx's bare-`{ message }` composer keeps
  // working). This one hard-requires the /help form's triage fields:
  // subject + category + product_id + description. Multipart uses the field
  // name `description` (not the legacy `message`) and is read by
  // `parseNewTicketMultipart` — `parseTicketMultipart` is untouched.
  app.post<{
    Body: {
      subject?: string;
      category?: string;
      product_id?: number | string;
      description?: string;
      order_code?: string;
    };
  }>("/account/support/new", async (req, reply) => {
    const customer = await requireCustomer(req, reply);
    if (!customer) return;
    if (!csrfHeaderOk(req, customer)) return reply.code(403).send({ error: "csrf_failed" });

    let subjectInput: string;
    let categoryInput: string;
    let productIdInput: string;
    let descriptionInput: string;
    let orderCodeInput: string | null = null;
    let attachments: ParsedAttachment[] = [];

    if (req.isMultipart()) {
      try {
        const parsed = await parseNewTicketMultipart(req);
        subjectInput = parsed.subject;
        categoryInput = parsed.category;
        productIdInput = parsed.productId;
        descriptionInput = parsed.description;
        orderCodeInput = parsed.orderCode;
        attachments = parsed.attachments;
      } catch (e) {
        if (e instanceof ValidationError) return reply.code(400).send(errorBody(e));
        throw e;
      }
    } else {
      subjectInput = String(req.body?.subject ?? "");
      categoryInput = String(req.body?.category ?? "");
      productIdInput =
        req.body?.product_id === undefined || req.body?.product_id === null
          ? ""
          : String(req.body.product_id);
      descriptionInput = String(req.body?.description ?? "");
      orderCodeInput = (req.body?.order_code ?? "").trim() || null;
    }

    // Validation runs BEFORE any DB write or attachment write (M-18
    // deferred-write discipline): subject/category/product_id/description all
    // hard-required, then order resolution, then the duplicate check, then
    // create. `writeAttachments` only runs once every check has passed.
    const subject = subjectInput.trim();
    if (subject.length < 1 || subject.length > 100) {
      return reply.code(400).send({ error: "web.support_subject_required" });
    }
    const categoryParsed = zTicketCategory.safeParse(categoryInput.trim());
    if (!categoryParsed.success) {
      return reply.code(400).send({ error: "web.support_category_required" });
    }
    const category = categoryParsed.data;
    const productId = Number(productIdInput);
    if (!Number.isInteger(productId) || productId <= 0) {
      return reply.code(400).send({ error: "web.support_product_invalid" });
    }
    const description = descriptionInput.trim().slice(0, 2000);
    if (description.length < 1) {
      return reply.code(400).send({ error: "web.support_description_required" });
    }
    // "Does this product id exist at all" — active-or-not (a ticket about a
    // since-archived product is still valid). `isActive`/`isArchived` are
    // deliberately NOT checked here.
    const product = await getCatalogProduct(prisma, productId);
    if (!product) {
      return reply.code(400).send({ error: "web.support_product_invalid" });
    }

    let orderId: number | null = null;
    if (orderCodeInput) {
      const order = await getOrderByCodeFull(prisma, orderCodeInput);
      if (!order || order.userId !== customer.userId) {
        return reply.code(400).send({ error: "error.order_not_found" });
      }
      orderId = order.id;
    }

    if (orderId !== null) {
      const existingTicket = await getOpenTicketForOrder(prisma, orderId);
      if (existingTicket) {
        return reply.send({ ok: false, duplicate: true, ticket_id: existingTicket.id });
      }
    }

    const attachmentUrls = await writeAttachments(attachments);
    const ticket = await createTicket(
      prisma,
      customer.userId,
      description,
      null,
      attachmentUrls,
      orderId,
      { subject, category, productId },
    );
    return reply.send({ ok: true, ticket_id: ticket.id });
  });

  app.post<{ Params: { id: string }; Body: { message?: string } }>(
    "/account/support/:id/reply",
    async (req, reply) => {
      const customer = await requireCustomer(req, reply);
      if (!customer) return;
      if (!csrfHeaderOk(req, customer)) return reply.code(403).send({ error: "csrf_failed" });
      const ticket = await getTicket(prisma, Number(req.params.id));
      let message: string;
      let attachments: ParsedAttachment[] = [];
      if (req.isMultipart()) {
        try {
          ({ message, attachments } = await parseTicketMultipart(req));
        } catch (e) {
          if (e instanceof ValidationError) return reply.code(400).send(errorBody(e));
          throw e;
        }
      } else {
        message = (req.body?.message ?? "").trim().slice(0, 2000);
      }
      // M-18 fix: same deferred-write rule as ticket creation above — nothing
      // hits disk until ownership/status/message have all been checked.
      if (ticket && ticket.userId === customer.userId && ticket.status !== TicketStatus.CLOSED && message) {
        const attachmentUrls = await writeAttachments(attachments);
        await addTicketMessage(prisma, {
          ticketId: ticket.id,
          senderType: SenderType.USER,
          senderId: customer.userId,
          content: message,
          attachmentUrls,
        });
      }
      return reply.send({ ok: true });
    },
  );

  app.get<{ Params: { id: string } }>("/account/support/:id", async (req, reply) => {
    const customer = await requireCustomer(req, reply);
    if (!customer) return;
    const ticket = await getTicketWithOrder(prisma, Number(req.params.id));
    if (!ticket || ticket.userId !== customer.userId) {
      return reply.code(404).send({ error: "not_found" });
    }
    const messages = await listTicketMessages(prisma, ticket.id, 30);
    const order = ticket.order;
    const reopenable =
      ticket.status === TicketStatus.CLOSED && ticket.closedAt != null
        ? addDays(ticket.closedAt, TICKET_REOPEN_WINDOW_DAYS).getTime() >= Date.now()
        : false;
    return reply.send({
      ticket: {
        id: ticket.id,
        message: ticket.message,
        status: ticket.status,
        created_at_display: dt(ticket.createdAt),
        admin_reply: ticket.adminReply,
        replied_at_display: ticket.repliedAt ? dt(ticket.repliedAt) : null,
        closed: ticket.status === TicketStatus.CLOSED,
        closed_at_display: ticket.closedAt ? dt(ticket.closedAt) : null,
        reopenable,
        attachments: splitAttachments(ticket.attachmentUrls),
      },
      messages: messages.map((m) => ({
        from_user: m.senderType === SenderType.USER,
        content: m.content,
        created_at_display: dt(m.createdAt),
        attachments: splitAttachments(m.attachmentUrls),
      })),
      order: order
        ? {
            code: order.orderCode,
            status: order.status,
            created_at_display: dt(order.createdAt),
            paid_at_display: order.paidAt ? dt(order.paidAt) : null,
            payment_method: order.paymentMethod,
            // Task 5 (multi-currency display client): already on the Order
            // row (`currency` — see prisma/schema.prisma), just not exposed
            // here before. `total` above is denominated in THIS, not always
            // IDR — the client's TicketOrderSummaryCard branches on it via
            // formatOrderAmount() rather than assuming Rupiah.
            currency: order.currency,
            total: order.totalAmount.toString(),
            voucher_code: order.voucher?.code ?? null,
            delivered: order.status === OrderStatus.DELIVERED,
            items: order.items.map((i) => ({
              name: i.product.name,
              duration: i.product.durationLabel,
              warranty_days: i.warrantyDaysSnapshot,
              warranty_expires_at_display: order.deliveredAt
                ? dt(addDays(order.deliveredAt, i.warrantyDaysSnapshot))
                : null,
              warranty_active: order.deliveredAt
                ? addDays(order.deliveredAt, i.warrantyDaysSnapshot).getTime() > Date.now()
                : false,
            })),
          }
        : null,
    });
  });

  app.post<{ Params: { id: string } }>("/account/support/:id/close", async (req, reply) => {
    const customer = await requireCustomer(req, reply);
    if (!customer) return;
    if (!csrfHeaderOk(req, customer)) return reply.code(403).send({ error: "csrf_failed" });
    const ticket = await getTicket(prisma, Number(req.params.id));
    if (!ticket || ticket.userId !== customer.userId) {
      return reply.code(404).send({ error: "not_found" });
    }
    const closed = await closeTicketByUser(prisma, ticket.id);
    if (!closed) return reply.code(409).send({ error: "error.ticket_already_closed" });
    return reply.send({ ok: true });
  });

  app.post<{ Params: { id: string } }>("/account/support/:id/reopen", async (req, reply) => {
    const customer = await requireCustomer(req, reply);
    if (!customer) return;
    if (!csrfHeaderOk(req, customer)) return reply.code(403).send({ error: "csrf_failed" });
    const ticket = await getTicket(prisma, Number(req.params.id));
    if (!ticket || ticket.userId !== customer.userId) {
      return reply.code(404).send({ error: "not_found" });
    }
    const result = await reopenTicket(prisma, ticket.id);
    if (!result.ok) {
      const key = result.reason === "window_expired" ? "error.ticket_reopen_expired" : "error.ticket_not_closed";
      return reply.code(400).send({ error: key });
    }
    return reply.send({ ok: true });
  });

  // ---- Restock subscription (from product page; works only when logged in) ----
  app.post<{ Params: { id: string } }>("/restock/:id", async (req, reply) => {
    const customer = await requireCustomer(req, reply);
    if (!customer) return;
    if (!csrfHeaderOk(req, customer)) return reply.code(403).send({ error: "csrf_failed" });
    const denom = await getDenominationWithProduct(prisma, Number(req.params.id));
    // The SPA bounces back to the parent product detail (slug URL).
    const redirect = denom ? `/p/${denom.product.slug}` : "/";
    if (!denom?.isActive || !(await isServiceActive(prisma, denom.product.category.group as CategoryGroup | null, "web"))) {
      return reply.send({ ok: false, result: "unavailable", redirect });
    }
    // Restock DMs go out over Telegram, so a web-only account can never be served.
    if (customer.user.telegramId == null) return reply.send({ ok: false, result: "needs_telegram", redirect });
    const isNew = await subscribeToRestock(prisma, customer.userId, denom.id);
    return reply.send({ ok: true, result: isNew ? "subscribed" : "already", redirect });
  });

  // ---- Settings ----
  app.get("/account/settings", async (req, reply) => {
    const customer = await requireCustomer(req, reply);
    if (!customer) return;
    return reply.send({
      bot_username: await resolveBotUsername(),
      bot_id: await resolveBotId(),
      values: {
        username: customer.user.loginUsername ?? "",
        email: customer.user.email ?? "",
      },
      has_password: Boolean(customer.user.passwordHash),
      // A guest row must confirm its order contact email to set credentials
      // (see the credentials route below) — the client shows that field.
      is_guest: customer.user.isGuest === true,
      tg_linked: customer.user.telegramId != null,
      tg_name:
        customer.user.username ??
        customer.user.fullName ??
        String(customer.user.telegramId ?? ""),
    });
  });

  // Arms ONE Telegram link for this account (telegramLinkIntent.ts): the SPA
  // calls this right before sending the browser to oauth.telegram.org, so the
  // cookie-authenticated GET /account/settings/link-telegram callback can't
  // be driven by a cross-site navigation. Guest rows can't link at all.
  app.post("/account/settings/link-telegram/start", async (req, reply) => {
    const customer = await requireCustomer(req, reply);
    if (!customer) return;
    if (!csrfHeaderOk(req, customer)) return reply.code(403).send({ error: "csrf_failed" });
    if (customer.user.isGuest) return reply.code(400).send({ error: "web.settings_tg_guest" });
    startTelegramLinkIntent(customer.userId);
    return reply.send({ ok: true });
  });

  app.post<{
    Body: {
      username?: string;
      email?: string;
      current_password?: string;
      new_password?: string;
      guest_email?: string;
    };
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
    // Guest rows (backend audit Task C1): a guest session can be minted from
    // the order code alone (POST /api/v1/track), and the code is short enough
    // to guess. Without this, whoever guessed it could set a password — or
    // just an email, then use forgot-password — and keep the row for good.
    // So ANY credential change on a guest row also needs the contact email
    // the buyer typed at checkout (`guestEmail`), which the guest knows and a
    // code-guesser does not. Compared after the same trim/lowercase
    // createGuestUser applied when storing it.
    if (changingCredentials && customer.user.isGuest) {
      // Capped per guest row (GUEST_CLAIM_FAILURE_MAX misses / 15 min), so
      // the session holder can't keep guessing the contact email.
      if (guestClaimLockedOut(customer.userId)) {
        return reply.code(429).send({ error: "web.settings_guest_email_locked" });
      }
      const proof = typeof req.body?.guest_email === "string" ? req.body.guest_email.trim().toLowerCase() : "";
      const expected = customer.user.guestEmail ?? "";
      if (!proof || !expected || !constantTimeEqual(proof, expected)) {
        recordGuestClaimFailure(customer.userId);
        return reply.code(400).send({ error: "web.settings_guest_email_mismatch" });
      }
    }
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
      // A guest converting to a real account keeps this session (no
      // establishSession), so adopt the shop_currency cookie here too — same
      // one-time, never-overwrite rule as sign-in.
      const cookieCurrency = requestCurrency(req);
      if (cookieCurrency) await adoptUserPreferredCurrencyIfUnset(prisma, customer.userId, cookieCurrency);
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
