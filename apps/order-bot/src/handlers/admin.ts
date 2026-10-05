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
import { Decimal, isValidWalletAdjustment } from "@app/core/money";
import { parseMoneyInput } from "@app/core/moneyFormat";
import { ensureUtc } from "@app/core/datetime";
import { UserRole, DeadReason, langCode, OrderKind } from "@app/core/enums";
import { logger } from "@app/core/logger";
import { tryDecryptCredentials } from "@app/core/credentialCrypto";
import {
  prisma,
  countPendingVerifications,
  revenueSummary,
  lowStockDenominations,
  countAvailableStock,
  listVouchers,
  getUser,
  getUserByTelegramId,
  setUserRole,
  adjustWallet,
  postWalletAdjustmentPosting,
  getSetting,
  setSetting,
  deleteSetting,
  updateDenomination,
  listStockItemsForProduct,
  markStockDead,
  getBulkPricingForDenomination,
  deleteBulkPricing,
  listOpenTickets,
  countOpenTickets,
  closeTicket,
  enqueueTicketClosedDm,
  logAdminAction,
} from "@app/db";
import type { MyContext } from "../context";
import { adminEdit } from "../util/chat";
import { BANNER_FILEID_KEY } from "../util/banner";
import { coreT, t } from "../util/i18n";
import { esc, formatIdr, formatUsdt, mixedAmount } from "../util/format";
import { requireAdminId } from "../util/adminAudit";
import * as akb from "../keyboards/admin";
import * as verification from "./verification";

// ===========================================================================
// /admin command + main menu
// ===========================================================================

export async function adminCommand(ctx: MyContext): Promise<void> {
  if (!ctx.from || !isAdmin(ctx.from.id)) {
    logger.warn(`Non-admin user ${ctx.from?.id} tried to open /admin — request blocked, user is not in the admin id list`);
    if (ctx.callbackQuery) await ctx.answerCallbackQuery({ text: t(ctx, "error.admin_only"), show_alert: true });
    else await ctx.reply(t(ctx, "error.admin_only"));
    return;
  }
  const lang = ctx.session.lang;
  if (ctx.message) ctx.session.adminMsgId = undefined; // drop the old anchor
  logger.info(`Admin command from user ${ctx.from?.id} via ${ctx.callbackQuery ? "a callback button" : "a typed command"}`);

  // countPendingVerifications has no page-size cap, unlike
  // listPendingVerifications(db, limit) — this badge must reflect the real
  // queue size even when it's larger than any single page of it.
  const pendingCount = await countPendingVerifications(prisma);
  await adminEdit(ctx, t(ctx, "admin.menu"), akb.adminMenu(lang, pendingCount));
}

// ===========================================================================
// Dashboard
// ===========================================================================

async function showDashboard(ctx: MyContext): Promise<void> {
  const lang = ctx.session.lang;
  const todayStart = ensureUtc(new Date()).startOf("day").toJSDate();

  const today = await revenueSummary(prisma, todayStart);
  // See the comment in adminCommand above — same true-count-vs-page-cap fix.
  const pendingCount = await countPendingVerifications(prisma);
  const lowStock = await lowStockDenominations(prisma, config.LOW_STOCK_THRESHOLD);

  let text = t(ctx, "admin.dashboard_text", {
    today_revenue: mixedAmount(today.revenue_idr, today.revenue_usdt),
    today_orders: today.orders,
    pending: pendingCount,
    low_stock: lowStock.length,
  });
  if (lowStock.length) {
    text += "\n\n<b>Low stock:</b>\n";
    for (const { denomination, available } of lowStock.slice(0, 10)) {
      if (denomination) text += `• ${esc(denomination.name)} — ${available}\n`;
    }
  }
  await adminEdit(ctx, text, akb.backToAdminKb(lang));
}

// ===========================================================================
// Products: list view
// ===========================================================================

async function showProducts(ctx: MyContext): Promise<void> {
  const lang = ctx.session.lang;
  const allProducts = await prisma.denomination.findMany({ orderBy: { name: "asc" } });
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
  const products = await prisma.denomination.findMany({ where: { isActive: true }, orderBy: { name: "asc" } });
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

export async function renderUserCard(ctx: MyContext, userId: number): Promise<void> {
  const lang = ctx.session.lang;
  const u = await getUser(prisma, userId);
  if (u === null) return;
  const text =
    `👤 <b>${esc(u.fullName ?? "-")}</b> (@${esc(u.username ?? "-")})\n` +
    `TG ID: <code>${u.telegramId}</code>\n` +
    `DB ID: <code>${u.id}</code>\n` +
    `Role: ${u.role} | Banned: ${u.banned}\n` +
    `Wallet (IDR): ${formatIdr(u.walletBalance)}\n` +
    `Wallet (USDT): ${formatUsdt(u.walletBalanceUsdt)}\n` +
    `Referral code: <code>${esc(u.referralCode)}</code>`;
  await adminEdit(
    ctx,
    text,
    akb.userActionsKb(u.id, { banned: u.banned, isReseller: u.role === UserRole.RESELLER, lang }),
  );
}

async function userSetReseller(ctx: MyContext, userId: number, on: boolean): Promise<void> {
  const adminTg = ctx.from!.id;
  const newRole = on ? UserRole.RESELLER : UserRole.CUSTOMER;
  await prisma.$transaction(async (tx) => {
    await setUserRole(tx, userId, newRole);
    const admin = await getUserByTelegramId(tx, adminTg);
    await logAdminAction(tx, {
      adminId: requireAdminId(admin),
      action: "user_set_reseller",
      targetType: "user",
      targetId: userId,
      details: `Set user's role to ${newRole}.`,
    });
  });
  await ctx.answerCallbackQuery({ text: t(ctx, "admin.toast.role_set", { role: newRole }), show_alert: true });
  await renderUserCard(ctx, userId);
}

async function userWalletPrompt(ctx: MyContext, userId: number): Promise<void> {
  await ctx.answerCallbackQuery({
    text: t(ctx, "admin.wallet_usage_hint", { uid: userId }),
    show_alert: true,
  });
}

/** `/wallet <user_db_id> <amount> [IDR|USDT]` — manual wallet adjustment by admin. */
export async function adminWalletCommand(ctx: MyContext): Promise<void> {
  if (!ctx.from || !isAdmin(ctx.from.id)) {
    logger.warn(`Non-admin user ${ctx.from?.id} tried to use /wallet — request blocked, user is not in the admin id list`);
    if (ctx.callbackQuery) await ctx.answerCallbackQuery({ text: t(ctx, "error.admin_only"), show_alert: true });
    else await ctx.reply(t(ctx, "error.admin_only"));
    return;
  }
  ctx.session.adminMsgId = undefined;
  const lang = ctx.session.lang;
  const args = (typeof ctx.match === "string" ? ctx.match : "").trim().split(/\s+/).filter(Boolean);
  logger.info(`Admin wallet command from user ${ctx.from?.id} with args "${args.join(" ")}"`);
  if (args.length < 2 || args.length > 3) {
    await adminEdit(ctx, t(ctx, "admin.wallet_usage"), akb.backToAdminKb(lang));
    return;
  }
  let uid: number;
  let amt: Decimal;
  // Trailing currency argument is optional and defaults to IDR so every
  // pre-existing "/wallet <uid> <amount>" usage keeps behaving exactly as
  // before (M-4, backend audit 2026-07-31).
  let currency: "IDR" | "USDT" = "IDR";
  try {
    uid = parseInt(args[0]!, 10);
    if (Number.isNaN(uid)) throw new Error("bad uid");
    // Currency first: how the amount is read depends on it (USDT `1.000` is
    // ambiguous, IDR `1.000` is one thousand rupiah).
    if (args[2] !== undefined) {
      const requested = args[2].toUpperCase();
      if (requested !== "IDR" && requested !== "USDT") throw new Error("bad currency");
      currency = requested;
    }
    // The amount is read by its shape, the way the bot displays it
    // (`10.000` is Rp10.000, not Rp10), with ONE optional leading sign on
    // top because /wallet also deducts. parseMoneyInput accepts only digits
    // and `.`/`,`, so `NaN`, `Infinity`, `1e3` and `0x10` never reach
    // Decimal — `new Decimal("NaN")`/`new Decimal("Infinity")` construct
    // without throwing, and a non-finite amount reaching adjustWallet would
    // poison the wallet balance (M-3, backend audit 2026-07-31).
    const typed = args[1]!;
    const negative = typed.startsWith("-");
    const unsigned = negative || typed.startsWith("+") ? typed.slice(1) : typed;
    const magnitude = parseMoneyInput(unsigned, currency);
    if (magnitude === null || !magnitude.isFinite()) throw new Error("bad amount");
    amt = negative ? magnitude.negated() : magnitude;
  } catch {
    await adminEdit(ctx, t(ctx, "admin.wallet_bad_args"), akb.backToAdminKb(lang));
    return;
  }
  // Money an admin typed is refused, never rounded: a zero (or -0) amount
  // would write a no-op ledger row; IDR reads `10,5` as Rp10,5, and a wallet
  // holds whole rupiah; USDT beyond the 4 decimals a wallet keeps would be
  // silently truncated by adjustWallet. Negative amounts stay allowed (debits).
  if (!isValidWalletAdjustment(amt, currency)) {
    await adminEdit(ctx, t(ctx, "admin.wallet_bad_amount"), akb.backToAdminKb(lang));
    return;
  }

  const adminTg = ctx.from!.id;
  let newBal: Decimal;
  try {
    newBal = await prisma.$transaction(async (tx) => {
      const admin = await getUserByTelegramId(tx, adminTg);
      const actingId = requireAdminId(admin);
      const { balance: bal, transactionId } = await adjustWallet(tx, uid, amt, { allowNegative: true, reason: "admin_adjust", adminId: actingId, currency });
      // Record the hand-made move in the double-entry ledger, in the same
      // transaction as the balance change and the audit row, so the three
      // cannot disagree about whether this adjustment happened.
      await postWalletAdjustmentPosting(tx, {
        walletTransactionId: transactionId,
        adminId: actingId,
        occurredAt: new Date(),
      });
      await logAdminAction(tx, {
        adminId: actingId,
        action: "wallet_adjust",
        targetType: "user",
        targetId: uid,
        details: `Adjusted the user's ${currency} wallet by ${amt}; new balance is ${bal}.`,
      });
      return bal;
    });
  } catch (err) {
    logger.error({ err }, `Wallet adjustment for user ${uid} failed — balance was not changed, admin shown a failure message`);
    await adminEdit(ctx, t(ctx, "admin.wallet_failed"), akb.backToAdminKb(lang));
    return;
  }
  const balanceDisplay = currency === "USDT" ? formatUsdt(newBal) : formatIdr(newBal);
  await adminEdit(ctx, t(ctx, "admin.wallet_adjusted", { uid, currency, balance: balanceDisplay }), akb.backToAdminKb(lang));
}

// ===========================================================================
// /emojiid — harvest custom emoji ids for Settings → Custom emoji map
// ===========================================================================

/**
 * Pull `{emoji: custom_emoji_id}` out of a message's entities. Telegram counts
 * entity offsets in UTF-16 code units, which is exactly how JS indexes strings,
 * so a plain slice is correct for multi-codepoint emoji too.
 */
function collectCustomEmoji(
  text: string | undefined,
  entities: readonly { type: string; offset: number; length: number; custom_emoji_id?: string }[] | undefined,
): Record<string, string> {
  const found: Record<string, string> = {};
  if (!text || !entities) return found;
  for (const e of entities) {
    if (e.type !== "custom_emoji" || !e.custom_emoji_id) continue;
    const emoji = text.slice(e.offset, e.offset + e.length);
    if (emoji) found[emoji] = e.custom_emoji_id;
  }
  return found;
}

/**
 * `/emojiid` — reply with the JSON map for the custom emoji in this message (or
 * in the message it replies to). Only a Telegram Premium account can put custom
 * emoji into a message, so this is how the shop owner reads the ids off the
 * emoji pack they want the bot to use.
 */
export async function adminEmojiIdCommand(ctx: MyContext): Promise<void> {
  if (!ctx.from || !isAdmin(ctx.from.id)) {
    logger.warn(`Non-admin user ${ctx.from?.id} tried to use /emojiid — request blocked, user is not in the admin id list`);
    if (ctx.callbackQuery) await ctx.answerCallbackQuery({ text: t(ctx, "error.admin_only"), show_alert: true });
    else await ctx.reply(t(ctx, "error.admin_only"));
    return;
  }
  ctx.session.adminMsgId = undefined;
  const lang = ctx.session.lang;
  const msg = ctx.message;
  const replied = msg?.reply_to_message;

  const found = {
    ...collectCustomEmoji(replied?.text, replied?.entities),
    ...collectCustomEmoji(replied?.caption, replied?.caption_entities),
    ...collectCustomEmoji(msg?.text, msg?.entities),
  };
  const count = Object.keys(found).length;
  logger.info(`Admin ${ctx.from.id} asked for custom emoji ids with /emojiid; ${count} custom emoji were found in the message`);

  if (count === 0) {
    // No entities at all → the admin probably just typed the command.
    const bare = !replied && (msg?.text ?? "").trim().split(/\s+/).length <= 1;
    await adminEdit(ctx, t(ctx, bare ? "admin.emojiid_usage" : "admin.emojiid_none"), akb.backToAdminKb(lang));
    return;
  }
  await adminEdit(
    ctx,
    t(ctx, "admin.emojiid_result", { count, json: esc(JSON.stringify(found, null, 2)) }),
    akb.backToAdminKb(lang),
  );
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
    where: { status: "DELIVERED", kind: OrderKind.PRODUCT, deliveredAt: { gte: since } },
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
  const p = await prisma.denomination.findUnique({ where: { id: productId } });
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

async function toggleProduct(ctx: MyContext, denominationId: number): Promise<void> {
  const adminTg = ctx.from!.id;
  const p = await prisma.denomination.findUnique({ where: { id: denominationId } });
  if (p === null) {
    await ctx.answerCallbackQuery({ text: t(ctx, "admin.toast.not_found"), show_alert: true });
    return;
  }
  const newState = !p.isActive;
  await prisma.$transaction(async (tx) => {
    await updateDenomination(tx, denominationId, { isActive: newState });
    const admin = await getUserByTelegramId(tx, adminTg);
    await logAdminAction(tx, {
      adminId: requireAdminId(admin),
      action: "product_toggle",
      targetType: "product",
      targetId: denominationId,
      details: `${newState ? "Activated" : "Deactivated"} this product.`,
    });
  });
  await ctx.answerCallbackQuery({ text: t(ctx, newState ? "admin.toast.product_activated" : "admin.toast.product_deactivated") });
  await viewProductAdmin(ctx, denominationId);
}

// ===========================================================================
// Stock items view + dead-marking
// ===========================================================================

async function viewStockItems(ctx: MyContext, productId: number): Promise<void> {
  const lang = ctx.session.lang;
  const p = await prisma.denomination.findUnique({ where: { id: productId } });
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
    // listStockItemsForProduct returns the raw encrypted envelope — decrypt just
    // for this preview; an unreadable row shows as unavailable, never as its envelope.
    // A missing key throws here, but the boot-time key check makes that unreachable.
    const creds =
      tryDecryptCredentials(it.credentials ?? "", { stockItemId: it.id, purpose: "the admin bot stock preview" }) ??
      "[unavailable]";
    const preview = creds.slice(0, 30) + (creds.length > 30 ? "…" : "");
    return `${icon} #${it.id} — ${preview}`;
  });
  // The previews above are decrypted plaintext, so record the view (count only,
  // never the text) before showing them — the web equivalents are audited too.
  const admin = await getUserByTelegramId(prisma, ctx.from!.id);
  await logAdminAction(prisma, {
    adminId: requireAdminId(admin),
    action: "stock_view",
    targetType: "product",
    targetId: productId,
    details: `Viewed ${items.length} stock ${items.length === 1 ? "item" : "items"} in the admin bot.`,
  });
  const text =
    `📦 <b>Stock items for ${esc(p.name)}</b>\n` +
    `Total shown: ${items.length}\n\n` +
    (lines.length ? lines.join("\n") : t(ctx, "admin.empty_stock_items"));
  await adminEdit(ctx, text, akb.stockItemsKb(items, productId, lang));
}

async function adminMarkStockDead(ctx: MyContext, stockId: number, productId: number): Promise<void> {
  const adminTg = ctx.from!.id;
  // Bot-4 fix, security audit 2026-06-23: was a bare update with no
  // $transaction and NO audit row at all — a stock-status change has no
  // trail back to the admin who made it.
  const count = await prisma.$transaction(async (tx) => {
    const stockItem = await tx.stockItem.findUnique({ where: { id: stockId }, include: { product: true } });
    // Resolved before the update: its MARKED_DEAD event names this admin.
    const admin = await getUserByTelegramId(tx, adminTg);
    const adminId = requireAdminId(admin);
    const updated = await markStockDead(tx, stockId, "marked dead by admin", adminId, DeadReason.OTHER); // no reason prompt in the bot
    if (updated === 0) return 0; // already SOLD/DEAD — nothing to audit
    await logAdminAction(tx, {
      adminId,
      action: "stock_mark_dead",
      targetType: "stock_item",
      targetId: stockId,
      details: `Marked a stock item dead for product "${stockItem?.product.name ?? productId}".`,
    });
    return updated;
  });
  if (count === 0) {
    await ctx.answerCallbackQuery({ text: t(ctx, "error.stock_item_not_eligible"), show_alert: true });
  } else {
    await ctx.answerCallbackQuery({ text: t(ctx, "admin.toast.stock_marked_dead") });
  }
  await viewStockItems(ctx, productId);
}

// ===========================================================================
// Bulk pricing management
// ===========================================================================

async function showBulkPricing(ctx: MyContext, productId: number): Promise<void> {
  const lang = ctx.session.lang;
  const p = await prisma.denomination.findUnique({ where: { id: productId } });
  if (p === null) {
    await ctx.answerCallbackQuery({ text: t(ctx, "admin.toast.product_not_found"), show_alert: true });
    return;
  }
  const rule = await getBulkPricingForDenomination(prisma, productId);
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
      const denomination = await tx.denomination.findUnique({ where: { id: productId } });
      const admin = await getUserByTelegramId(tx, adminTg);
      await logAdminAction(tx, {
        adminId: requireAdminId(admin),
        action: "bulk_pricing_delete",
        targetType: "product",
        targetId: productId,
        details: `Removed bulk pricing for "${denomination?.name ?? productId}".`,
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
  // The header's count is the true total; `tickets` is capped at 50 buttons.
  const total = await countOpenTickets(prisma);
  await adminEdit(ctx, t(ctx, "admin.hdr_tickets", { count: total }), akb.ticketsListKb(tickets, lang));
}

async function closeTicketAdmin(ctx: MyContext, ticketId: number): Promise<void> {
  const lang = ctx.session.lang;
  const adminTg = ctx.from!.id;
  // closeTicket's atomic guard (count===1) means a double-tap "Close" never
  // sends a second buyer DM; wrapping it with the audit write in one
  // $transaction means a crash between them can never silently lose the
  // audit row for a ticket that DID close (Bot-3 fix, security audit
  // 2026-06-23).
  const customerTgId = await prisma.$transaction(async (tx) => {
    const tgId = await closeTicket(tx, ticketId);
    const admin = await getUserByTelegramId(tx, adminTg);
    await logAdminAction(tx, {
      adminId: requireAdminId(admin),
      action: "ticket_close",
      targetType: "support_ticket",
      targetId: ticketId,
      details: `Closed ticket #${ticketId}.`,
    });
    return tgId;
  });
  await ctx.answerCallbackQuery({ text: t(ctx, "admin.toast.ticket_closed") });

  // Task 2 (Phase C): routed through notification_outbox instead of a direct
  // ctx.api.sendMessage() — the dispatcher's TICKET_CLOSED_DM branch renders
  // the exact same coreT("support.ticket_closed", buyerLang) text, in the
  // buyer's own language.
  if (customerTgId) {
    const buyer = await getUserByTelegramId(prisma, customerTgId);
    const buyerLang = buyer ? langCode(buyer.language) : "en";
    await enqueueTicketClosedDm(prisma, { ticketId, chatId: Number(customerTgId), buyerLanguage: buyerLang });
  }
  await adminEdit(ctx, t(ctx, "admin.ticket_closed_body", { id: ticketId }), akb.backToAdminKb(lang));
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
    // Restoring a raw file_id; clear any cached upload file_id.
    await deleteSetting(tx, BANNER_FILEID_KEY);
    const admin = await getUserByTelegramId(tx, ctx.from!.id);
    await logAdminAction(tx, {
      adminId: requireAdminId(admin),
      action: "setting_set",
      targetType: "setting",
      details: `Restored the banner image via undo.`,
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
      else {
        logger.warn({ event: "dead_tap", section, action, callbackData: ctx.callbackQuery?.data, userId: ctx.from?.id }, `Admin callback verif action "${action}" is not recognized — likely a button from a stale bubble, showing the stale-screen toast instead`);
        await ctx.answerCallbackQuery({ text: t(ctx, "error.stale_screen") });
      }
      break;
    case "prod":
      if (action === "menu") await showProducts(ctx);
      else if (action === "edit") await viewProductAdmin(ctx, n(4));
      else if (action === "toggle") await toggleProduct(ctx, n(4));
      else if (action === "stock") await viewStockItems(ctx, n(4));
      // 'new', 'type', 'cancel', 'rename', 'price' handled by conversations.
      else {
        logger.warn({ event: "dead_tap", section, action, callbackData: ctx.callbackQuery?.data, userId: ctx.from?.id }, `Admin callback prod action "${action}" is not recognized — likely a button from a stale bubble, showing the stale-screen toast instead`);
        await ctx.answerCallbackQuery({ text: t(ctx, "error.stale_screen") });
      }
      break;
    case "stock":
      if (action === "menu") await showStockMenu(ctx);
      // 'add' handled by stock_upload conversation.
      else {
        logger.warn({ event: "dead_tap", section, action, callbackData: ctx.callbackQuery?.data, userId: ctx.from?.id }, `Admin callback stock action "${action}" is not recognized — likely a button from a stale bubble, showing the stale-screen toast instead`);
        await ctx.answerCallbackQuery({ text: t(ctx, "error.stale_screen") });
      }
      break;
    case "stockitem":
      if (action === "dead") await adminMarkStockDead(ctx, n(4), n(5));
      else {
        logger.warn({ event: "dead_tap", section, action, callbackData: ctx.callbackQuery?.data, userId: ctx.from?.id }, `Admin callback stockitem action "${action}" is not recognized — likely a button from a stale bubble, showing the stale-screen toast instead`);
        await ctx.answerCallbackQuery({ text: t(ctx, "error.stale_screen") });
      }
      break;
    case "vouch":
      if (action === "menu") await showVouchersMenu(ctx);
      else if (action === "list") await listVouchersView(ctx);
      // 'new' handled by voucher_create conversation.
      else {
        logger.warn({ event: "dead_tap", section, action, callbackData: ctx.callbackQuery?.data, userId: ctx.from?.id }, `Admin callback vouch action "${action}" is not recognized — likely a button from a stale bubble, showing the stale-screen toast instead`);
        await ctx.answerCallbackQuery({ text: t(ctx, "error.stale_screen") });
      }
      break;
    case "users":
      if (action === "menu") await showUsersMenu(ctx);
      else if (action === "view") await renderUserCard(ctx, n(4));
      // 'ban' and 'unban' are conversation entry points — intercepted upstream.
      else if (action === "reseller") await userSetReseller(ctx, n(4), Boolean(n(5)));
      else if (action === "wallet") await userWalletPrompt(ctx, n(4));
      // 'search' handled by user_search conversation.
      else {
        logger.warn({ event: "dead_tap", section, action, callbackData: ctx.callbackQuery?.data, userId: ctx.from?.id }, `Admin callback users action "${action}" is not recognized — likely a button from a stale bubble, showing the stale-screen toast instead`);
        await ctx.answerCallbackQuery({ text: t(ctx, "error.stale_screen") });
      }
      break;
    case "reports":
      if (action === "menu") await showReports(ctx);
      else if (action === "csv") await exportReport(ctx, parts[4]!);
      else {
        logger.warn({ event: "dead_tap", section, action, callbackData: ctx.callbackQuery?.data, userId: ctx.from?.id }, `Admin callback reports action "${action}" is not recognized — likely a button from a stale bubble, showing the stale-screen toast instead`);
        await ctx.answerCallbackQuery({ text: t(ctx, "error.stale_screen") });
      }
      break;
    case "settings":
      if (action === "menu") await showSettings(ctx);
      else if (action === "undo" && parts[4] === "banner_image") await undoBannerRemoval(ctx);
      // 'set' handled by setting conversation.
      else {
        logger.warn({ event: "dead_tap", section, action, callbackData: ctx.callbackQuery?.data, userId: ctx.from?.id }, `Admin callback settings action "${action}" is not recognized — likely a button from a stale bubble, showing the stale-screen toast instead`);
        await ctx.answerCallbackQuery({ text: t(ctx, "error.stale_screen") });
      }
      break;
    case "broadcast":
      // 'start' handled by broadcast conversation.
      logger.warn({ event: "dead_tap", section, action, callbackData: ctx.callbackQuery?.data, userId: ctx.from?.id }, `Admin callback broadcast action "${action}" is not recognized — likely a button from a stale bubble, showing the stale-screen toast instead`);
      await ctx.answerCallbackQuery({ text: t(ctx, "error.stale_screen") });
      break;
    case "cancel":
      // Stale cancel button pressed outside any conversation — go to admin panel.
      await adminCommand(ctx);
      break;
    case "bulk":
      if (action === "menu") await showBulkPricing(ctx, n(4));
      else if (action === "del") await deleteBulkPricingHandler(ctx, n(4));
      // 'new' handled by bulk_pricing conversation.
      else {
        logger.warn({ event: "dead_tap", section, action, callbackData: ctx.callbackQuery?.data, userId: ctx.from?.id }, `Admin callback bulk action "${action}" is not recognized — likely a button from a stale bubble, showing the stale-screen toast instead`);
        await ctx.answerCallbackQuery({ text: t(ctx, "error.stale_screen") });
      }
      break;
    case "ticket":
      if (action === "menu") await showTicketsAdmin(ctx);
      else if (action === "close") await closeTicketAdmin(ctx, n(4));
      // 'reply' handled by ticket_reply conversation.
      else {
        logger.warn({ event: "dead_tap", section, action, callbackData: ctx.callbackQuery?.data, userId: ctx.from?.id }, `Admin callback ticket action "${action}" is not recognized — likely a button from a stale bubble, showing the stale-screen toast instead`);
        await ctx.answerCallbackQuery({ text: t(ctx, "error.stale_screen") });
      }
      break;
    default:
      logger.warn({ event: "dead_tap", section, callbackData: ctx.callbackQuery?.data, userId: ctx.from?.id }, `Admin callback section "${section}" is not recognized — likely a button from a stale bubble, showing the stale-screen toast instead`);
      await ctx.answerCallbackQuery({ text: t(ctx, "error.stale_screen") });
  }
}
