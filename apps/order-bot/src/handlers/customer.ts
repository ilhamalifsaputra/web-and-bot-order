/**
 * Customer-facing navigation handlers — port of customer.py (non-conversation
 * parts; the review + ticket-reply conversations live in src/conversations/).
 *
 * In PTB these were reached either as CommandHandlers or dispatched from
 * callbacks.py. Here they are plain `(ctx) => Promise<void>` functions; the
 * callback router (callbacks.ts) and main.ts wire them up. State that used to
 * live in `context.user_data` now lives on `ctx.session` (scratch + fields).
 */
import { InputFile } from "grammy";
import { config } from "@app/core/config";
import { Decimal } from "@app/core/money";
import { ensureUtc, localize } from "@app/core/datetime";
import { UserRole, OrderStatus, TicketStatus, SenderType } from "@app/core/enums";
import { logger } from "@app/core/logger";
import {
  prisma,
  upsertUser,
  botOverallStats,
  userTotalSpent,
  listAllActiveProducts,
  getProduct,
  countAvailableStock,
  getBulkPricingForProduct,
  countUserOrders,
  listUserOrders,
  getOrder,
  listUserDeliveredOrders,
  getUser,
  setUserLanguage,
  subscribeToRestock,
  productRating,
  getSetting,
  searchProducts,
  listUserTickets,
  getTicket,
  listTicketMessages,
} from "@app/db";
import type { MyContext } from "../context";
import { smartEdit } from "../util/chat";
import { t } from "../util/i18n";
import { esc, formatPrice, statusBadge, groupOrderItems, formatCountdown } from "../util/format";
import * as ckb from "../keyboards/customer";
import { showFaq, showTerms } from "./static";

const PAGE_SIZE = 10;
const price = (v: Decimal.Value, decimals = 2) => formatPrice(v, config.CURRENCY, decimals);

// --- session scratch accessors (mirror context.user_data keys) -------------
interface BrowseScratch {
  browsePage?: number;
  browseProductIds?: number[];
  viewingProductId?: number;
}
const sc = (ctx: MyContext) => ctx.session.scratch as BrowseScratch & Record<string, unknown>;

function requireUser(ctx: MyContext) {
  const u = ctx.session.dbUser;
  if (!u) throw new Error("customer handler reached without a registered user");
  return u;
}

// ---------------------------------------------------------------------------
// /start + dashboard
// ---------------------------------------------------------------------------

async function buildDashboardText(ctx: MyContext): Promise<string> {
  const info = requireUser(ctx);
  const lang = ctx.session.lang;
  const tg = ctx.from!;
  const name = esc([tg.first_name, tg.last_name].filter(Boolean).join(" ") || tg.username || "");

  const stats = await botOverallStats(prisma);
  const spent = await userTotalSpent(prisma, info.id);

  const nowStr = localize(new Date(), "cccc, dd LLLL yyyy HH:mm:ss");

  return t(ctx, "start.dashboard", {
    name,
    now: nowStr,
    tg_id: tg.id,
    username: tg.username ? `@${tg.username}` : "—",
    spent: price(spent),
    items_sold: stats.items_sold,
    total_revenue: price(stats.total_revenue),
    total_users: stats.total_users,
  });
}

async function backToMainFromPersistent(ctx: MyContext): Promise<void> {
  delete sc(ctx).viewingProductId;
  ctx.session.awaitingQtyProductId = undefined;
  const text = await buildDashboardText(ctx);
  await smartEdit(ctx, text, ckb.mainPersistentKb());
}

async function handleBackButton(ctx: MyContext): Promise<void> {
  const qtyPid = ctx.session.awaitingQtyProductId;
  if (qtyPid != null) {
    ctx.session.awaitingQtyProductId = undefined;
    await browseProduct(ctx, qtyPid);
    return;
  }
  if (sc(ctx).viewingProductId != null) {
    await browseProductsFlat(ctx);
    return;
  }
  await backToMainFromPersistent(ctx);
}

export async function startCommand(ctx: MyContext): Promise<void> {
  const tg = ctx.from!;
  ctx.session.awaitingQtyProductId = undefined;

  const args = (ctx.match && typeof ctx.match === "string" ? ctx.match : "").trim().split(/\s+/).filter(Boolean);
  if (args.length && args[0]!.startsWith("ref_")) {
    const code = args[0]!.slice(4);
    await upsertUser(prisma, {
      telegramId: tg.id,
      username: tg.username ?? null,
      fullName: [tg.first_name, tg.last_name].filter(Boolean).join(" ") || null,
      referredByCode: code,
    });
  }

  delete sc(ctx).browseProductIds;
  delete sc(ctx).browsePage;

  const text = await buildDashboardText(ctx);
  const msg = await ctx.reply(text, { parse_mode: "HTML", reply_markup: ckb.mainPersistentKb() });
  ctx.session.menuMsgId = msg.message_id;
}

export async function showMainMenu(ctx: MyContext): Promise<void> {
  const text = await buildDashboardText(ctx);
  await smartEdit(ctx, text, ckb.mainPersistentKb());
}

// Universal /cancel when no conversation is active.
export async function cancelCommand(ctx: MyContext): Promise<void> {
  ctx.session.scratch = {};
  ctx.session.awaitingQtyProductId = undefined;
  await ctx.reply(t(ctx, "conv.cancelled_idle"));
  await startCommand(ctx);
}

// ---------------------------------------------------------------------------
// Browse — flat product list with persistent reply keyboard
// ---------------------------------------------------------------------------

export async function browseProductsFlat(ctx: MyContext, page = 0): Promise<void> {
  const lang = ctx.session.lang;
  const info = ctx.session.dbUser;
  const tg = ctx.from!;
  const name = esc([tg.first_name, tg.last_name].filter(Boolean).join(" ") || tg.username || "");

  const products = await listAllActiveProducts(prisma);
  if (!products.length) {
    await smartEdit(ctx, t(ctx, "browse.no_products"), ckb.backToMain(lang));
    return;
  }

  const totalPages = Math.max(1, Math.ceil(products.length / PAGE_SIZE));
  page = Math.max(0, Math.min(page, totalPages - 1));
  const start = page * PAGE_SIZE;
  const pageProducts = products.slice(start, start + PAGE_SIZE);

  sc(ctx).browsePage = page;
  sc(ctx).browseProductIds = pageProducts.map((p) => p.id);
  delete sc(ctx).viewingProductId;

  // Numbered list (compact for large catalogs — 5 number buttons per row) with
  // the reseller-aware price on each line so buyers can compare without opening
  // each one. Selection by number is resolved against the browseProductIds
  // snapshot above (see handleProductNumber).
  const isReseller = info?.role === UserRole.RESELLER;
  const itemLines = pageProducts.map((p, i) => {
    const unit = isReseller && p.resellerPrice != null ? p.resellerPrice : p.price;
    return `┊ [ ${i + 1} ] ${esc(p.name).toUpperCase()} — ${price(unit)}`;
  });

  const text = t(ctx, "browse.list_decorated", {
    name,
    page: page + 1,
    total: totalPages,
    items: itemLines.join("\n"),
  });

  // The numbered keyboard is a reply keyboard; smartEdit sends a fresh message
  // carrying it (an edit can't bear a reply keyboard).
  await smartEdit(
    ctx,
    text,
    ckb.productsPersistentKb(pageProducts.length, {
      showPrev: page > 0,
      showNext: page < totalPages - 1,
      showBack: false,
    }),
  );
}

export async function handleProductNumber(ctx: MyContext): Promise<void> {
  const lang = ctx.session.lang;
  const text = (ctx.message?.text ?? "").trim();

  const MENU_LABELS = new Set([
    ckb.BTN_BROWSE, ckb.BTN_ORDERS, ckb.BTN_WALLET, ckb.BTN_REFERRAL, ckb.BTN_LANGUAGE,
    ckb.BTN_SUPPORT, ckb.BTN_FAQ, ckb.BTN_TERMS, ckb.BTN_TICKETS, ckb.BTN_MAIN, ckb.BTN_BACK,
    ckb.BTN_PREV, ckb.BTN_NEXT,
  ]);

  // Manual quantity input mode.
  const qtyProductId = ctx.session.awaitingQtyProductId;
  if (qtyProductId != null && !MENU_LABELS.has(text)) {
    await handleQtyTextInput(ctx, qtyProductId, text);
    return;
  }

  if (text === ckb.BTN_BACK) {
    await handleBackButton(ctx);
    return;
  }

  if (MENU_LABELS.has(text)) {
    ctx.session.awaitingQtyProductId = undefined;
    delete sc(ctx).viewingProductId;
  }

  if (text === ckb.BTN_PREV) {
    await browseProductsFlat(ctx, Math.max(0, (sc(ctx).browsePage ?? 0) - 1));
    return;
  }
  if (text === ckb.BTN_NEXT) {
    await browseProductsFlat(ctx, (sc(ctx).browsePage ?? 0) + 1);
    return;
  }
  if (text === ckb.BTN_BROWSE) return void (await browseProductsFlat(ctx));
  if (text === ckb.BTN_ORDERS) return void (await listMyOrders(ctx));
  if (text === ckb.BTN_WALLET) return void (await viewWallet(ctx));
  if (text === ckb.BTN_REFERRAL) return void (await viewReferral(ctx));
  if (text === ckb.BTN_LANGUAGE) return void (await showLanguageMenu(ctx));
  if (text === ckb.BTN_FAQ) return void (await showFaq(ctx));
  if (text === ckb.BTN_TERMS) return void (await showTerms(ctx));
  if (text === ckb.BTN_TICKETS) return void (await listMyTickets(ctx));
  if (text === ckb.BTN_MAIN) return void (await backToMainFromPersistent(ctx));

  // Number buttons — product selection. Only short digit strings.
  if (!/^\d+$/.test(text) || text.length > 4) return;

  // Resolve the tapped number against the SNAPSHOT captured when the list was
  // last rendered (browseProductIds), so a catalog change between render and tap
  // can't shift the numbering and open the wrong product. Fall back to a fresh
  // page slice only when there's no snapshot yet (e.g. a number typed before
  // browsing this session).
  let productIds = sc(ctx).browseProductIds ?? [];
  if (!productIds.length) {
    const products = await listAllActiveProducts(prisma);
    const page = sc(ctx).browsePage ?? 0;
    const start = page * PAGE_SIZE;
    productIds = products.slice(start, start + PAGE_SIZE).map((p) => p.id);
    sc(ctx).browseProductIds = productIds;
  }

  if (!productIds.length) {
    await smartEdit(ctx, t(ctx, "browse.no_products"));
    return;
  }

  const idx = parseInt(text, 10);
  if (idx < 1 || idx > productIds.length) {
    await smartEdit(ctx, t(ctx, "browse.invalid_number", { max: productIds.length }));
    return;
  }

  const productId = productIds[idx - 1]!;
  logger.debug(`handle_product_number: user selected idx=${idx} product_id=${productId}`);
  await browseProduct(ctx, productId);
}

export async function browseProduct(ctx: MyContext, productId: number, qty = 1): Promise<void> {
  const info = requireUser(ctx);
  const lang = ctx.session.lang;

  let p: Awaited<ReturnType<typeof getProduct>>;
  let stock: number;
  let ratingStr: string;
  let bulkRule: Awaited<ReturnType<typeof getBulkPricingForProduct>>;
  try {
    p = await getProduct(prisma, productId);
    if (p === null) {
      logger.warn(`browse_product: product_id=${productId} not found`);
      if (ctx.callbackQuery) await ctx.answerCallbackQuery({ text: t(ctx, "error.generic"), show_alert: true });
      else await smartEdit(ctx, t(ctx, "error.generic"));
      return;
    }
    stock = await countAvailableStock(prisma, p.id);
    const { avg, count } = await productRating(prisma, p.id);
    ratingStr = avg ? `${avg.toFixed(1)}/5 (${count})` : "—";
    bulkRule = await getBulkPricingForProduct(prisma, p.id);
  } catch (err) {
    logger.error({ err }, `browse_product: DB error for product_id=${productId}`);
    if (ctx.callbackQuery) await ctx.answerCallbackQuery({ text: t(ctx, "error.generic"), show_alert: true });
    else await smartEdit(ctx, t(ctx, "error.generic"));
    return;
  }

  const isReseller = info.role === UserRole.RESELLER;
  const unit = isReseller && p.resellerPrice != null ? p.resellerPrice : p.price;

  let text = t(ctx, "browse.product_detail", {
    name: esc(p.name),
    price: price(unit),
    duration: esc(p.durationLabel),
    type: p.type.toLowerCase(),
    warranty: p.warrantyDays,
    stock,
    rating: ratingStr,
  });
  if (bulkRule) {
    text +=
      "\n\n" +
      t(ctx, "browse.bulk_deal", {
        min_qty: bulkRule.minQuantity,
        percent: bulkRule.discountPercent,
      });
  }

  await smartEdit(ctx, text, ckb.productDetailKb(p, stock, lang, qty));
  sc(ctx).viewingProductId = productId;
}

// ---------------------------------------------------------------------------
// Manual quantity input
// ---------------------------------------------------------------------------

export async function qtyInputStart(ctx: MyContext, productId: number): Promise<void> {
  const lang = ctx.session.lang;
  const p = await getProduct(prisma, productId);
  if (p === null) {
    await smartEdit(ctx, t(ctx, "error.generic"));
    return;
  }
  const stock = await countAvailableStock(prisma, p.id);
  if (stock <= 0) {
    if (ctx.callbackQuery) await ctx.answerCallbackQuery({ text: t(ctx, "browse.out_of_stock"), show_alert: true });
    return;
  }
  await smartEdit(ctx, t(ctx, "browse.qty_input_prompt", { max: stock }), ckb.qtyInputCancelKb(productId, lang));
  ctx.session.awaitingQtyProductId = productId;
}

export async function qtyInputCancel(ctx: MyContext, productId: number): Promise<void> {
  ctx.session.awaitingQtyProductId = undefined;
  await browseProduct(ctx, productId);
}

async function handleQtyTextInput(ctx: MyContext, productId: number, rawText: string): Promise<void> {
  const lang = ctx.session.lang;
  const p = await getProduct(prisma, productId);
  if (p === null) {
    ctx.session.awaitingQtyProductId = undefined;
    await smartEdit(ctx, t(ctx, "error.generic"));
    return;
  }
  const stock = await countAvailableStock(prisma, p.id);

  const isValid = /^\d+$/.test(rawText) && parseInt(rawText, 10) >= 1;
  if (!isValid || parseInt(rawText, 10) > stock) {
    await smartEdit(ctx, t(ctx, "browse.qty_input_invalid", { max: stock }), ckb.qtyInputCancelKb(productId, lang));
    ctx.session.awaitingQtyProductId = productId;
    return;
  }

  ctx.session.awaitingQtyProductId = undefined;
  await browseProduct(ctx, productId, parseInt(rawText, 10));
}

export async function qtyChange(
  ctx: MyContext,
  productId: number,
  qty: number,
  action: string,
): Promise<void> {
  const p = await getProduct(prisma, productId);
  if (p === null) {
    if (ctx.callbackQuery) await ctx.answerCallbackQuery();
    return;
  }
  const stock = await countAvailableStock(prisma, p.id);
  const newQty = action === "inc" ? Math.min(qty + 1, stock) : Math.max(qty - 1, 1);
  await browseProduct(ctx, productId, newQty);
}

// ---------------------------------------------------------------------------
// My orders
// ---------------------------------------------------------------------------

export async function listMyOrders(ctx: MyContext, page = 0): Promise<void> {
  const info = requireUser(ctx);
  const lang = ctx.session.lang;
  const perPage = 5;

  const total = await countUserOrders(prisma, info.id);
  const orders = await listUserOrders(prisma, info.id, perPage, page * perPage);
  const totalPages = Math.max(1, Math.ceil(total / perPage));

  if (!orders.length && page === 0) {
    await smartEdit(ctx, t(ctx, "order.list_empty"), ckb.backToMain(lang));
    return;
  }

  const lines = [t(ctx, "order.list_title"), ""];
  for (const o of orders) {
    lines.push(
      t(ctx, "order.list_line", {
        code: o.orderCode,
        status: statusBadge(o.status),
        total: price(o.totalAmount),
        date: ensureUtc(o.createdAt).toFormat("yyyy-LL-dd"),
      }),
    );
  }
  lines.push("");
  lines.push(t(ctx, "order.page_info", { page: page + 1, total: totalPages }));
  await smartEdit(ctx, lines.join("\n"), ckb.ordersListKb(orders, lang, page, totalPages));
}

export async function viewOrder(ctx: MyContext, orderId: number): Promise<void> {
  const info = requireUser(ctx);
  const lang = ctx.session.lang;
  const order = await getOrder(prisma, orderId);
  if (order === null || order.userId !== info.id) {
    await smartEdit(ctx, t(ctx, "error.order_not_found"));
    return;
  }

  const itemLines = groupOrderItems(order.items).map(
    (g) => `• ${esc(g.product.name)} × ${g.quantity} — ${price(g.lineTotal)}`,
  );

  let text: string;
  if (order.status === OrderStatus.PENDING_PAYMENT) {
    const binanceId = (await getSetting(prisma, "binance_pay_id")) || config.BINANCE_PAY_ID;
    const countdown = order.expiresAt ? formatCountdown(order.expiresAt) : `${config.PAYMENT_WINDOW_MINUTES}:00`;
    text = t(ctx, "order.pending_payment_detail", {
      code: order.orderCode,
      lines: itemLines.join("\n"),
      total: price(order.totalAmount, 4),
      binance_id: esc(binanceId),
      countdown,
    });
  } else {
    text = t(ctx, "order.detail", {
      code: order.orderCode,
      status: statusBadge(order.status),
      total: price(order.totalAmount),
      created: ensureUtc(order.createdAt).toFormat("yyyy-LL-dd HH:mm 'UTC'"),
      lines: itemLines.join("\n"),
    });
  }
  await smartEdit(ctx, text, ckb.orderDetailKb(order, lang));
}

export async function downloadHistory(ctx: MyContext): Promise<void> {
  const info = requireUser(ctx);
  const lang = ctx.session.lang;
  const orders = await listUserDeliveredOrders(prisma, info.id, 50);

  if (!orders.length) {
    if (ctx.callbackQuery) await ctx.answerCallbackQuery({ text: t(ctx, "order.history_empty"), show_alert: true });
    return;
  }

  const lines: string[] = ["=== Transaction History ===", `Total: ${orders.length} orders`, ""];
  for (const o of orders) {
    lines.push(`Order   : ${o.orderCode}`);
    lines.push(`Date    : ${ensureUtc(o.createdAt).toFormat("yyyy-LL-dd HH:mm 'UTC'")}`);
    lines.push(`Total   : ${price(o.totalAmount, 4)}`);
    lines.push("Items   :");
    for (const g of groupOrderItems(o.items)) {
      lines.push(`  - ${g.product.name} x${g.quantity}  ${price(g.lineTotal)}`);
    }
    lines.push("-".repeat(36));
  }

  const buf = Buffer.from(lines.join("\n"), "utf-8");
  if (ctx.callbackQuery) await ctx.answerCallbackQuery();
  await ctx.api.sendDocument(ctx.chat!.id, new InputFile(buf, "transaction_history.txt"), {
    caption: `📥 ${orders.length} transaction(s)`,
  });
}

// ---------------------------------------------------------------------------
// Wallet / Referral / Language / Restock
// ---------------------------------------------------------------------------

export async function viewWallet(ctx: MyContext): Promise<void> {
  const info = requireUser(ctx);
  const lang = ctx.session.lang;
  const user = await getUser(prisma, info.id);
  const balance = user ? user.walletBalance : new Decimal(0);
  let text = t(ctx, "wallet.balance", { balance: price(balance) });
  text += "\n\n" + t(ctx, "wallet.topup_info");
  await smartEdit(ctx, text, ckb.backToMain(lang));
}

export async function viewReferral(ctx: MyContext): Promise<void> {
  const info = requireUser(ctx);
  const lang = ctx.session.lang;
  const code = info.referralCode ?? "";
  const link = `https://t.me/${config.BOT_USERNAME}?start=ref_${code}`;

  const agg = await prisma.referral.aggregate({
    where: { referrerId: info.id },
    _count: { id: true },
    _sum: { commission: true },
  });

  const text = t(ctx, "referral.info", {
    percent: String(config.REFERRAL_COMMISSION_PERCENT),
    link,
    count: agg._count.id ?? 0,
    earned: price(new Decimal(agg._sum.commission ?? 0)),
  });
  await smartEdit(ctx, text, ckb.backToMain(lang));
}

export async function showLanguageMenu(ctx: MyContext): Promise<void> {
  await smartEdit(ctx, t(ctx, "language.choose"), ckb.languageKb());
}

export async function setLanguage(ctx: MyContext, code: string): Promise<void> {
  const info = requireUser(ctx);
  await setUserLanguage(prisma, info.id, code);
  info.language = code.toUpperCase();
  ctx.session.lang = code.toLowerCase();
  if (ctx.callbackQuery) await ctx.answerCallbackQuery({ text: t(ctx, "language.set") });
  await showMainMenu(ctx);
}

export async function subscribeRestock(ctx: MyContext, productId: number): Promise<void> {
  const info = requireUser(ctx);
  const lang = ctx.session.lang;
  const isNew = await subscribeToRestock(prisma, info.id, productId);
  const msg = t(ctx, isNew ? "browse.subscribed_restock" : "browse.already_subscribed");
  if (ctx.callbackQuery) await ctx.answerCallbackQuery({ text: msg });
  // Edit the product bubble into a confirmation so the tap leaves a visible
  // trace, instead of an ephemeral toast that vanishes on the next interaction.
  await smartEdit(ctx, msg, ckb.restockSubscribedKb(productId, lang));
}

// ---------------------------------------------------------------------------
// My Tickets (user-side ticket history)
// ---------------------------------------------------------------------------

export async function listMyTickets(ctx: MyContext): Promise<void> {
  const info = requireUser(ctx);
  const lang = ctx.session.lang;
  const tickets = await listUserTickets(prisma, info.id);
  if (!tickets.length) {
    await smartEdit(ctx, t(ctx, "ticket.list_empty"), ckb.backToMain(lang));
    return;
  }
  await smartEdit(ctx, t(ctx, "ticket.list_title"), ckb.myTicketsKb(tickets, lang));
}

export async function viewMyTicket(ctx: MyContext, ticketId: number): Promise<void> {
  const info = requireUser(ctx);
  const lang = ctx.session.lang;

  const ticket = await getTicket(prisma, ticketId);
  if (ticket === null || ticket.userId !== info.id) {
    await smartEdit(ctx, t(ctx, "error.order_not_found"));
    return;
  }
  const messages = await listTicketMessages(prisma, ticketId, 10);

  const statusLabels: Record<string, string> = {
    [TicketStatus.OPEN]: "Open",
    [TicketStatus.REPLIED]: "Replied",
    [TicketStatus.CLOSED]: "Closed",
  };
  const header = t(ctx, "ticket.view_title", {
    id: ticketId,
    status: statusLabels[ticket.status] ?? ticket.status,
    date: ensureUtc(ticket.createdAt).toFormat("yyyy-LL-dd HH:mm"),
  });

  const parts = [header, ""];
  if (messages.length) {
    for (const msg of messages) {
      const timeStr = ensureUtc(msg.createdAt).toFormat("HH:mm dd/LL");
      const key = msg.senderType === SenderType.USER ? "ticket.message_user" : "ticket.message_admin";
      parts.push(t(ctx, key, { time: timeStr, content: esc(msg.content) }));
    }
  } else {
    parts.push(
      t(ctx, "ticket.message_user", {
        time: ensureUtc(ticket.createdAt).toFormat("HH:mm dd/LL"),
        content: esc(ticket.message),
      }),
    );
    if (ticket.adminReply) {
      const replyTime = ticket.repliedAt ? ensureUtc(ticket.repliedAt).toFormat("HH:mm dd/LL") : "—";
      parts.push(t(ctx, "ticket.message_admin", { time: replyTime, content: esc(ticket.adminReply) }));
    }
  }

  await smartEdit(ctx, parts.join("\n\n"), ckb.ticketViewKb(ticketId, ticket.status, lang));
}

// ---------------------------------------------------------------------------
// Shortcut commands
// ---------------------------------------------------------------------------

export async function listprodukCommand(ctx: MyContext): Promise<void> {
  ctx.session.awaitingQtyProductId = undefined;
  await browseProductsFlat(ctx, 0);
}

export async function languageCommand(ctx: MyContext): Promise<void> {
  ctx.session.awaitingQtyProductId = undefined;
  await showLanguageMenu(ctx);
}

export async function searchCommand(ctx: MyContext): Promise<void> {
  const lang = ctx.session.lang;
  const query = (typeof ctx.match === "string" ? ctx.match : "").trim();
  if (!query) {
    await smartEdit(ctx, t(ctx, "search.no_query"));
    return;
  }
  const products = await searchProducts(prisma, query);
  if (!products.length) {
    await smartEdit(ctx, t(ctx, "search.no_results", { query: esc(query) }), ckb.backToMain(lang));
    return;
  }
  await smartEdit(
    ctx,
    t(ctx, "search.results", { query: esc(query), count: products.length }),
    ckb.searchResultsKb(products, lang),
  );
}
