/**
 * Admin panel handlers — port of admin.py (non-conversation parts + the
 * `handleAdminCallback` sub-router). The multi-step admin flows (stock upload,
 * voucher create, broadcast, user search, setting edit, product create/edit,
 * bulk pricing, ticket reply) live in src/conversations/.
 *
 * Entry points: `/admin` → adminCommand; every `v1:adm:*` callback →
 * handleAdminCallback (called by the central router in callbacks.ts).
 */
import { InputFile } from "grammy";
import { config } from "@app/core/config";
import { isAdmin } from "@app/core/runtime";
import { Decimal } from "@app/core/money";
import { ensureUtc } from "@app/core/datetime";
import { UserRole, langCode } from "@app/core/enums";
import { logger } from "@app/core/logger";
import {
  prisma,
  listPendingVerifications,
  revenueSummary,
  lowStockProducts,
  countAvailableStock,
  listVouchers,
  getUser,
  getUserByTelegramId,
  setUserBanned,
  setUserRole,
  adjustWallet,
  getSetting,
  setSetting,
  updateProduct,
  listStockItemsForProduct,
  markStockDead,
  getBulkPricingForProduct,
  deleteBulkPricing,
  listOpenTickets,
  closeTicket,
  logAdminAction,
  listRestockSubscribers,
} from "@app/db";
import type { MyContext } from "../context";
import { adminEdit } from "../util/chat";
import { coreT, t } from "../util/i18n";
import { esc, formatPrice, formatIdr, mixedAmount } from "../util/format";
import * as akb from "../keyboards/admin";
import * as verification from "./verification";

// USDT figures only (wallet balances). Catalog prices and voucher FIXED values
// are central Rupiah → formatIdr; mixed revenue totals → mixedAmount.
const price = (v: Decimal.Value, decimals = 2) => formatPrice(v, "USDT", decimals);
const adminId = (admin: { id: number } | null) => (admin ? admin.id : 0);

// ===========================================================================
// /admin command + main menu
// ===========================================================================

export async function adminCommand(ctx: MyContext): Promise<void> {
  const lang = ctx.session.lang;
  if (ctx.message) ctx.session.adminMsgId = undefined; // drop the old anchor
  logger.info(`admin_command: user=${ctx.from?.id} via=${ctx.callbackQuery ? "cb" : "cmd"}`);

  const pending = await listPendingVerifications(prisma, 200);
  await adminEdit(ctx, t(ctx, "admin.menu"), akb.adminMenu(lang, pending.length));
}

// ===========================================================================
// Dashboard
// ===========================================================================

async function showDashboard(ctx: MyContext): Promise<void> {
  const lang = ctx.session.lang;
  const todayStart = ensureUtc(new Date()).startOf("day").toJSDate();

  const today = await revenueSummary(prisma, todayStart);
  const pending = await listPendingVerifications(prisma, 200);
  const lowStock = await lowStockProducts(prisma, config.LOW_STOCK_THRESHOLD);

  let text = t(ctx, "admin.dashboard_text", {
    today_revenue: mixedAmount(today.revenue_idr, today.revenue_usdt),
    today_orders: today.orders,
    pending: pending.length,
    low_stock: lowStock.length,
  });
  if (lowStock.length) {
    text += "\n\n<b>Low stock:</b>\n";
    for (const { product, available } of lowStock.slice(0, 10)) {
      if (product) text += `• ${esc(product.name)} — ${available}\n`;
    }
  }
  await adminEdit(ctx, text, akb.backToAdminKb(lang));
}

// ===========================================================================
// Products: list view
// ===========================================================================

async function showProducts(ctx: MyContext): Promise<void> {
  const lang = ctx.session.lang;
  const allProducts = await prisma.product.findMany({ orderBy: { name: "asc" } });
  if (!allProducts.length) {
    await adminEdit(ctx, t(ctx, "admin.empty_products"), akb.backToAdminKb(lang));
    return;
  }
  const stockMap = new Map<number, number>();
  for (const p of allProducts) stockMap.set(p.id, await countAvailableStock(prisma, p.id));

  const lines = ["🛍 <b>Products</b>", ""];
  for (const p of allProducts) {
    const status = p.isActive ? "🟢" : "⚪";
    lines.push(`${status} <b>${esc(p.name)}</b> — ${formatIdr(p.price)} • stock ${stockMap.get(p.id)}`);
  }
  await adminEdit(ctx, lines.join("\n"), akb.productsAdminKb(allProducts, lang));
}

// ===========================================================================
// Stock / Vouchers menus
// ===========================================================================

async function showStockMenu(ctx: MyContext): Promise<void> {
  const lang = ctx.session.lang;
  const products = await prisma.product.findMany({ where: { isActive: true }, orderBy: { name: "asc" } });
  await adminEdit(ctx, t(ctx, "admin.hdr_stock_pick"), akb.stockProductsKb(products, lang));
}

async function showVouchersMenu(ctx: MyContext): Promise<void> {
  const lang = ctx.session.lang;
  await adminEdit(ctx, t(ctx, "admin.hdr_vouchers"), akb.vouchersAdminKb(lang));
}

async function listVouchersView(ctx: MyContext): Promise<void> {
  const lang = ctx.session.lang;
  const rows = await listVouchers(prisma);
  if (!rows.length) {
    await adminEdit(ctx, t(ctx, "admin.empty_vouchers"), akb.backToAdminKb(lang));
    return;
  }
  const lines = ["🎟 <b>Vouchers</b>", ""];
  for (const v of rows) {
    const active = v.isActive ? "🟢" : "🔴";
    const used = `${v.usedCount}/${v.usageLimit ?? "∞"}`;
    const val = v.type === "PERCENT" ? `${v.value}%` : formatIdr(v.value);
    lines.push(`${active} <code>${esc(v.code)}</code> — ${val} — used ${used}`);
  }
  await adminEdit(ctx, lines.join("\n"), akb.backToAdminKb(lang));
}

// ===========================================================================
// Users
// ===========================================================================

async function showUsersMenu(ctx: MyContext): Promise<void> {
  const lang = ctx.session.lang;
  await adminEdit(ctx, t(ctx, "admin.hdr_users"), akb.usersAdminKb(lang));
}

async function renderUserCard(ctx: MyContext, userId: number): Promise<void> {
  const lang = ctx.session.lang;
  const u = await getUser(prisma, userId);
  if (u === null) return;
  const text =
    `👤 <b>${esc(u.fullName ?? "-")}</b> (@${esc(u.username ?? "-")})\n` +
    `TG ID: <code>${u.telegramId}</code>\n` +
    `DB ID: <code>${u.id}</code>\n` +
    `Role: ${u.role} | Banned: ${u.banned}\n` +
    `Wallet: ${price(u.walletBalance)}\n` +
    `Referral code: <code>${esc(u.referralCode)}</code>`;
  await adminEdit(
    ctx,
    text,
    akb.userActionsKb(u.id, { banned: u.banned, isReseller: u.role === UserRole.RESELLER, lang }),
  );
}

async function userBan(ctx: MyContext, userId: number, banned: boolean): Promise<void> {
  const adminTg = ctx.from!.id;
  await prisma.$transaction(async (tx) => {
    await setUserBanned(tx, userId, banned, "set by admin");
    const admin = await getUserByTelegramId(tx, adminTg);
    await logAdminAction(tx, {
      adminId: adminId(admin),
      action: banned ? "user_ban" : "user_unban",
      targetType: "user",
      targetId: userId,
    });
  });
  await ctx.answerCallbackQuery({ text: t(ctx, banned ? "admin.toast.user_banned" : "admin.toast.user_unbanned"), show_alert: true });
  await renderUserCard(ctx, userId);
}

async function userSetReseller(ctx: MyContext, userId: number, on: boolean): Promise<void> {
  const adminTg = ctx.from!.id;
  const newRole = on ? UserRole.RESELLER : UserRole.CUSTOMER;
  await prisma.$transaction(async (tx) => {
    await setUserRole(tx, userId, newRole);
    const admin = await getUserByTelegramId(tx, adminTg);
    await logAdminAction(tx, {
      adminId: adminId(admin),
      action: "user_set_reseller",
      targetType: "user",
      targetId: userId,
      details: `role=${newRole}`,
    });
  });
  await ctx.answerCallbackQuery({ text: t(ctx, "admin.toast.role_set", { role: newRole }), show_alert: true });
  await renderUserCard(ctx, userId);
}

async function userWalletPrompt(ctx: MyContext, userId: number): Promise<void> {
  await ctx.answerCallbackQuery({
    text: `Use /wallet ${userId} <amount> to adjust (negative to deduct).`,
    show_alert: true,
  });
}

/** `/wallet <user_db_id> <amount>` — manual wallet adjustment by admin. */
export async function adminWalletCommand(ctx: MyContext): Promise<void> {
  ctx.session.adminMsgId = undefined;
  const lang = ctx.session.lang;
  const args = (typeof ctx.match === "string" ? ctx.match : "").trim().split(/\s+/).filter(Boolean);
  logger.info(`admin_wallet_command: user=${ctx.from?.id} args=${args.join(" ")}`);
  if (args.length !== 2) {
    await adminEdit(ctx, t(ctx, "admin.wallet_usage"), akb.backToAdminKb(lang));
    return;
  }
  let uid: number;
  let amt: Decimal;
  try {
    uid = parseInt(args[0]!, 10);
    amt = new Decimal(args[1]!);
    if (Number.isNaN(uid)) throw new Error("bad uid");
  } catch {
    await adminEdit(ctx, t(ctx, "admin.wallet_bad_args"), akb.backToAdminKb(lang));
    return;
  }

  const adminTg = ctx.from!.id;
  let newBal: Decimal;
  try {
    newBal = await prisma.$transaction(async (tx) => {
      const admin = await getUserByTelegramId(tx, adminTg);
      const actingId = adminId(admin);
      const bal = await adjustWallet(tx, uid, amt, { allowNegative: true, reason: "admin_adjust", adminId: actingId });
      await logAdminAction(tx, {
        adminId: actingId,
        action: "wallet_adjust",
        targetType: "user",
        targetId: uid,
        details: `delta=${amt} new_balance=${bal}`,
      });
      return bal;
    });
  } catch (err) {
    logger.error({ err }, "wallet adjust failed");
    await adminEdit(ctx, t(ctx, "admin.wallet_failed"), akb.backToAdminKb(lang));
    return;
  }
  await adminEdit(ctx, t(ctx, "admin.wallet_adjusted", { uid, balance: price(newBal) }), akb.backToAdminKb(lang));
}

// ===========================================================================
// Reports (CSV export)
// ===========================================================================

async function showReports(ctx: MyContext): Promise<void> {
  const lang = ctx.session.lang;
  await adminEdit(ctx, t(ctx, "admin.hdr_reports"), akb.reportsKb(lang));
}

async function exportReport(ctx: MyContext, period: string): Promise<void> {
  const now = new Date();
  let since: Date;
  if (period === "today") since = ensureUtc(now).startOf("day").toJSDate();
  else if (period === "week") since = new Date(now.getTime() - 7 * 86_400_000);
  else if (period === "month") since = new Date(now.getTime() - 30 * 86_400_000);
  else {
    await ctx.answerCallbackQuery({ text: t(ctx, "admin.toast.unknown_period"), show_alert: true });
    return;
  }

  const rows = await prisma.order.findMany({
    where: { status: "DELIVERED", deliveredAt: { gte: since } },
    orderBy: { deliveredAt: "desc" },
  });

  const csvLines = [
    "order_code,user_id,subtotal,discount,wallet_used,unique_cents,total,txid,delivered_at",
  ];
  const cell = (v: unknown) => {
    const s = String(v ?? "");
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  for (const o of rows) {
    csvLines.push(
      [
        o.orderCode,
        o.userId,
        o.subtotalAmount,
        o.discountAmount,
        o.walletUsed,
        o.uniqueCents,
        o.totalAmount,
        o.binanceTxid ?? "",
        o.deliveredAt ? ensureUtc(o.deliveredAt).toISO() : "",
      ]
        .map(cell)
        .join(","),
    );
  }

  const data = Buffer.from(csvLines.join("\r\n"), "utf-8");
  const filename = `orders_${period}_${ensureUtc(now).toFormat("yyyyLLdd")}.csv`;
  await ctx.answerCallbackQuery();
  await ctx.replyWithDocument(new InputFile(data, filename), {
    caption: `📊 ${rows.length} delivered orders (${period}).`,
  });
}

// ===========================================================================
// Settings (runtime DB-backed)
// ===========================================================================

async function showSettings(ctx: MyContext): Promise<void> {
  const lang = ctx.session.lang;
  const binance = (await getSetting(prisma, "binance_pay_id")) || config.BINANCE_PAY_ID;
  const support = await getSetting(prisma, "support_contact");
  const qr = await getSetting(prisma, "qr");
  const banner = await getSetting(prisma, "banner_image");
  const welcome = await getSetting(prisma, "welcome");

  const text =
    "⚙️ <b>Settings</b>\n\n" +
    `💳 Binance Pay ID: <code>${esc(binance)}</code>\n` +
    `🖼 QR image: ${qr ? "✅ uploaded" : "❌ not set"}\n` +
    `📢 Banner: ${banner ? "✅ on" : "❌ off"}\n` +
    `👋 Welcome message: ${welcome ? "✏️ custom" : "⚙️ default"}\n` +
    `📞 Support contact: <code>${support ? esc(support) : "(not set)"}</code>\n`;
  await adminEdit(ctx, text, akb.settingsKb(lang));
}

// ===========================================================================
// Product view / toggle
// ===========================================================================

async function viewProductAdmin(ctx: MyContext, productId: number): Promise<void> {
  const lang = ctx.session.lang;
  const p = await prisma.product.findUnique({ where: { id: productId } });
  if (p === null) {
    await ctx.answerCallbackQuery({ text: t(ctx, "admin.toast.not_found"), show_alert: true });
    return;
  }
  const stock = await countAvailableStock(prisma, p.id);
  const text =
    `🛍 <b>${esc(p.name)}</b>\n\n` +
    `Type: ${p.type.toLowerCase()}\n` +
    `Duration: ${esc(p.durationLabel)}\n` +
    `Price: ${formatIdr(p.price)}\n` +
    `Reseller price: ${p.resellerPrice ? formatIdr(p.resellerPrice) : "-"}\n` +
    `Warranty: ${p.warrantyDays} days\n` +
    `Status: ${p.isActive ? "🟢 Active" : "⚪ Inactive"}\n` +
    `Available stock: ${stock}`;
  await adminEdit(ctx, text, akb.productViewKb(productId, p.isActive, lang));
}

async function toggleProduct(ctx: MyContext, productId: number): Promise<void> {
  const adminTg = ctx.from!.id;
  const p = await prisma.product.findUnique({ where: { id: productId } });
  if (p === null) {
    await ctx.answerCallbackQuery({ text: t(ctx, "admin.toast.not_found"), show_alert: true });
    return;
  }
  const newState = !p.isActive;
  await prisma.$transaction(async (tx) => {
    await updateProduct(tx, productId, { isActive: newState });
    const admin = await getUserByTelegramId(tx, adminTg);
    await logAdminAction(tx, {
      adminId: adminId(admin),
      action: "product_toggle",
      targetType: "product",
      targetId: productId,
      details: `is_active=${newState}`,
    });
  });
  await ctx.answerCallbackQuery({ text: t(ctx, newState ? "admin.toast.product_activated" : "admin.toast.product_deactivated") });
  await viewProductAdmin(ctx, productId);
}

// ===========================================================================
// Stock items view + dead-marking
// ===========================================================================

async function viewStockItems(ctx: MyContext, productId: number): Promise<void> {
  const lang = ctx.session.lang;
  const p = await prisma.product.findUnique({ where: { id: productId } });
  if (p === null) {
    await ctx.answerCallbackQuery({ text: t(ctx, "admin.toast.product_not_found"), show_alert: true });
    return;
  }
  const items = await listStockItemsForProduct(prisma, productId);
  const statusIcons: Record<string, string> = {
    AVAILABLE: "🟢",
    RESERVED: "🔵",
    SOLD: "✅",
    DEAD: "💀",
  };
  const lines = items.map((it) => {
    const icon = statusIcons[it.status] ?? "⚪";
    const creds = it.credentials ?? "";
    const preview = creds.slice(0, 30) + (creds.length > 30 ? "…" : "");
    return `${icon} #${it.id} — ${preview}`;
  });
  const text =
    `📦 <b>Stock items for ${esc(p.name)}</b>\n` +
    `Total shown: ${items.length}\n\n` +
    (lines.length ? lines.join("\n") : t(ctx, "admin.empty_stock_items"));
  await adminEdit(ctx, text, akb.stockItemsKb(items, productId, lang));
}

async function adminMarkStockDead(ctx: MyContext, stockId: number, productId: number): Promise<void> {
  await markStockDead(prisma, stockId, "marked dead by admin");
  await ctx.answerCallbackQuery({ text: t(ctx, "admin.toast.stock_marked_dead") });
  await viewStockItems(ctx, productId);
}

// ===========================================================================
// Bulk pricing management
// ===========================================================================

async function showBulkPricing(ctx: MyContext, productId: number): Promise<void> {
  const lang = ctx.session.lang;
  const p = await prisma.product.findUnique({ where: { id: productId } });
  if (p === null) {
    await ctx.answerCallbackQuery({ text: t(ctx, "admin.toast.product_not_found"), show_alert: true });
    return;
  }
  const rule = await getBulkPricingForProduct(prisma, productId);
  let text: string;
  if (rule) {
    text =
      `💰 <b>Bulk Pricing — ${esc(p.name)}</b>\n\n` +
      `Min. quantity: <b>${rule.minQuantity} pcs</b>\n` +
      `Discount: <b>${rule.discountPercent}%</b>\n` +
      `Status: ${rule.isActive ? "🟢 Active" : "⚪ Inactive"}\n\n` +
      `Customers who buy ${rule.minQuantity}+ units of this product ` +
      `automatically receive ${rule.discountPercent}% off.`;
  } else {
    text = `💰 <b>Bulk Pricing — ${esc(p.name)}</b>\n\n` + t(ctx, "admin.bulk_none_set");
  }
  await adminEdit(ctx, text, akb.bulkPricingKb(productId, rule !== null, lang));
}

async function deleteBulkPricingHandler(ctx: MyContext, productId: number): Promise<void> {
  const adminTg = ctx.from!.id;
  const deleted = await prisma.$transaction(async (tx) => {
    const ok = await deleteBulkPricing(tx, productId);
    if (ok) {
      const admin = await getUserByTelegramId(tx, adminTg);
      await logAdminAction(tx, {
        adminId: adminId(admin),
        action: "bulk_pricing_delete",
        targetType: "product",
        targetId: productId,
      });
    }
    return ok;
  });
  await ctx.answerCallbackQuery({
    text: t(ctx, deleted ? "admin.toast.bulk_deleted" : "admin.toast.bulk_none"),
    show_alert: true,
  });
  await showBulkPricing(ctx, productId);
}

// ===========================================================================
// Support ticket management
// ===========================================================================

async function showTicketsAdmin(ctx: MyContext): Promise<void> {
  const lang = ctx.session.lang;
  const tickets = await listOpenTickets(prisma, 50);
  if (!tickets.length) {
    await adminEdit(ctx, t(ctx, "admin.hdr_tickets_none"), akb.backToAdminKb(lang));
    return;
  }
  await adminEdit(ctx, `📩 <b>Support Tickets</b>\n\n${tickets.length} open ticket(s):`, akb.ticketsListKb(tickets, lang));
}

async function closeTicketAdmin(ctx: MyContext, ticketId: number): Promise<void> {
  const lang = ctx.session.lang;
  const customerTgId = await closeTicket(prisma, ticketId);
  await ctx.answerCallbackQuery({ text: t(ctx, "admin.toast.ticket_closed") });

  if (customerTgId) {
    try {
      // DM the buyer in THEIR language, not a hardcoded "en".
      const buyer = await getUserByTelegramId(prisma, customerTgId);
      const buyerLang = buyer ? langCode(buyer.language) : "en";
      await ctx.api.sendMessage(Number(customerTgId), coreT("support.ticket_closed", buyerLang), { parse_mode: "HTML" });
    } catch (err) {
      logger.error({ err }, "Failed to notify user about ticket close");
    }
  }
  await adminEdit(ctx, t(ctx, "admin.ticket_closed_body", { id: ticketId }), akb.backToAdminKb(lang));
}

// ===========================================================================
// Restock subscriber notification (used after a stock upload)
// ===========================================================================

export async function notifyRestockSubscribers(ctx: MyContext, productId: number): Promise<void> {
  const subs = await listRestockSubscribers(prisma, productId);
  if (!subs.length) return;
  const productName = (subs[0] as { product: { name: string } }).product.name;
  const userIds = subs.map((s) => s.userId);
  const users = await prisma.user.findMany({ where: { id: { in: userIds } } });
  const targets = users.map((u) => ({ tgId: u.telegramId, lang: langCode(u.language) }));

  // Consume the subscriptions (one-shot notification).
  await prisma.restockSubscription.deleteMany({ where: { id: { in: subs.map((s) => s.id) } } });

  for (const { tgId, lang } of targets) {
    try {
      await ctx.api.sendMessage(
        Number(tgId),
        coreT("browse.subscribed_restock_notify", lang, { product: esc(productName) }),
        { parse_mode: "HTML" },
      );
    } catch (err) {
      logger.error({ err }, `Failed to notify restock subscriber ${tgId}`);
    }
  }
}

// ===========================================================================
// Undo banner removal (30-second window, expiry stored in session.scratch)
// ===========================================================================

async function undoBannerRemoval(ctx: MyContext): Promise<void> {
  const lang = ctx.session.lang;
  const undoState = ctx.session.scratch.undoBanner as
    | { fileId: string; expiresAt: number }
    | undefined;

  if (!undoState || Date.now() > undoState.expiresAt) {
    ctx.session.scratch.undoBanner = undefined;
    await ctx.answerCallbackQuery({ text: t(ctx, "admin.undo_expired"), show_alert: true });
    return;
  }

  ctx.session.scratch.undoBanner = undefined;
  await prisma.$transaction(async (tx) => {
    await setSetting(tx, "banner_image", undoState.fileId);
    const admin = await getUserByTelegramId(tx, ctx.from!.id);
    await logAdminAction(tx, {
      adminId: adminId(admin),
      action: "setting_set",
      targetType: "setting",
      details: "banner_image=restored_via_undo",
    });
  });
  await ctx.answerCallbackQuery({ text: t(ctx, "admin.banner_restored") });
  await adminEdit(ctx, t(ctx, "admin.banner_restored"), akb.backToAdminKb(lang));
}

// ===========================================================================
// Callback router entry (called by callbacks.ts for any v1:adm:*)
// ===========================================================================

export async function handleAdminCallback(ctx: MyContext, parts: string[]): Promise<void> {
  if (!isAdmin(ctx.from!.id)) {
    await ctx.answerCallbackQuery({ text: t(ctx, "error.admin_only"), show_alert: true });
    return;
  }
  if (parts.length < 3) return;
  const section = parts[2];
  const action = parts.length > 3 ? parts[3]! : "";
  const n = (i: number) => parseInt(parts[i]!, 10);

  switch (section) {
    case "menu":
      await adminCommand(ctx);
      break;
    case "dash":
      await showDashboard(ctx);
      break;
    case "verif":
      if (action === "list") await verification.showQueue(ctx);
      else if (action === "view") await verification.viewOrder(ctx, n(4));
      else if (action === "approve") await verification.approve(ctx, n(4));
      else if (action === "resend") await verification.resendCredentials(ctx, n(4));
      // 'reject' is a conversation entry point — intercepted upstream.
      break;
    case "prod":
      if (action === "menu") await showProducts(ctx);
      else if (action === "edit") await viewProductAdmin(ctx, n(4));
      else if (action === "toggle") await toggleProduct(ctx, n(4));
      else if (action === "stock") await viewStockItems(ctx, n(4));
      // 'new', 'type', 'cancel', 'rename', 'price' handled by conversations.
      break;
    case "stock":
      if (action === "menu") await showStockMenu(ctx);
      // 'add' handled by stock_upload conversation.
      break;
    case "stockitem":
      if (action === "dead") await adminMarkStockDead(ctx, n(4), n(5));
      break;
    case "vouch":
      if (action === "menu") await showVouchersMenu(ctx);
      else if (action === "list") await listVouchersView(ctx);
      // 'new' handled by voucher_create conversation.
      break;
    case "users":
      if (action === "menu") await showUsersMenu(ctx);
      else if (action === "view") await renderUserCard(ctx, n(4));
      else if (action === "ban") await userBan(ctx, n(4), true);
      else if (action === "unban") await userBan(ctx, n(4), false);
      else if (action === "reseller") await userSetReseller(ctx, n(4), Boolean(n(5)));
      else if (action === "wallet") await userWalletPrompt(ctx, n(4));
      // 'search' handled by user_search conversation.
      break;
    case "reports":
      if (action === "menu") await showReports(ctx);
      else if (action === "csv") await exportReport(ctx, parts[4]!);
      break;
    case "settings":
      if (action === "menu") await showSettings(ctx);
      else if (action === "undo" && parts[4] === "banner_image") await undoBannerRemoval(ctx);
      // 'set' handled by setting conversation.
      break;
    case "broadcast":
      // 'start' handled by broadcast conversation.
      break;
    case "cancel":
      // Stale cancel button pressed outside any conversation — go to admin panel.
      await adminCommand(ctx);
      break;
    case "bulk":
      if (action === "menu") await showBulkPricing(ctx, n(4));
      else if (action === "del") await deleteBulkPricingHandler(ctx, n(4));
      // 'new' handled by bulk_pricing conversation.
      break;
    case "ticket":
      if (action === "menu") await showTicketsAdmin(ctx);
      else if (action === "close") await closeTicketAdmin(ctx, n(4));
      // 'reply' handled by ticket_reply conversation.
      break;
  }
}
