/**
 * Admin multi-step conversations — port of the ConversationHandlers in
 * admin.py: stock upload, voucher create, broadcast, user search, setting edit,
 * product create, product edit, bulk pricing, ticket reply.
 *
 * Common fallbacks (per admin conv): /cancel → admin panel; /start → customer
 * dashboard; the inline `v1:adm:cancel` button → admin panel.
 *
 * Replay-safety: DB/IO that precedes another wait() is wrapped in
 * conversation.external(); terminal mutations run once.
 */
import { InputMediaBuilder } from "grammy";
import type { MessageEntity } from "grammy/types";
import { config, isAdmin } from "@app/core/config";
import { botToken } from "@app/core/runtime";
import { Decimal } from "@app/core/money";
import { ProductType, SenderType, VoucherType } from "@app/core/enums";
import { ValidationError } from "@app/core/errors";
import { logger } from "@app/core/logger";
import {
  prisma,
  getVoucherByCode,
  createVoucher,
  bulkAddStock,
  getUserByTelegramId,
  logAdminAction,
  searchUsers,
  setSetting,
  createProduct,
  listAllCategories,
  createCategory,
  updateProduct,
  upsertBulkPricing,
  getTicket,
  replyToTicket,
  addTicketMessage,
} from "@app/db";
import type { MyContext, MyConversation } from "../context";
import { adminEdit } from "../util/chat";
import { coreT, t } from "../util/i18n";
import { esc, formatPrice } from "../util/format";
import { validateText, validateVoucherCode, parseStockUpload } from "../util/validators";
import * as akb from "../keyboards/admin";
import { ticketResolvedKb } from "../keyboards/customer";
import { adminCommand, notifyRestockSubscribers } from "../handlers/admin";
import { startCommand } from "../handlers/customer";

const price = (v: Decimal.Value, decimals = 2) => formatPrice(v, config.CURRENCY, decimals);
const adminIdOf = (a: { id: number } | null) => (a ? a.id : 0);

function isCmd(ctx: MyContext, cmd: string): boolean {
  const text = ctx.message?.text ?? "";
  return text === `/${cmd}` || text.startsWith(`/${cmd} `) || text.startsWith(`/${cmd}@`);
}

/** Returns true (and handles it) if `u` is one of the generic admin escapes. */
async function handledEscape(u: MyContext): Promise<boolean> {
  if ((u.callbackQuery?.data ?? "") === "v1:adm:cancel") {
    await u.answerCallbackQuery();
    await adminCommand(u);
    return true;
  }
  if (isCmd(u, "cancel")) {
    await adminCommand(u);
    return true;
  }
  if (isCmd(u, "start")) {
    await startCommand(u);
    return true;
  }
  return false;
}

function adminGate(ctx: MyContext): boolean {
  return isAdmin(ctx.from!.id);
}

async function denyAdmin(ctx: MyContext): Promise<void> {
  await ctx.answerCallbackQuery({ text: t(ctx, "error.admin_only"), show_alert: true });
}

async function downloadTgText(ctx: MyContext, fileId: string): Promise<string> {
  const file = await ctx.api.getFile(fileId);
  const url = `https://api.telegram.org/file/bot${botToken()}/${file.file_path}`;
  const res = await fetch(url);
  return res.text();
}

// ===========================================================================
// Stock upload
// ===========================================================================

export async function stockUploadConversation(conversation: MyConversation, ctx: MyContext): Promise<void> {
  if (!adminGate(ctx)) return denyAdmin(ctx);
  const lang = ctx.session.lang;
  const productId = parseInt((ctx.callbackQuery?.data ?? "").split(":").at(-1)!, 10);

  await ctx.answerCallbackQuery();
  await adminEdit(ctx, t(ctx, "admin.stock_ask_upload"), akb.cancelInputKb());

  let credentials: string[];
  let skippedCount: number;
  for (;;) {
    const u = await conversation.wait();
    if (await handledEscape(u)) return;

    let rawText = "";
    const doc = u.message?.document;
    if (doc) {
      if (!doc.file_name || !doc.file_name.toLowerCase().endsWith(".txt")) {
        await adminEdit(u, "Please send a .txt file.");
        continue;
      }
      if (doc.file_size && doc.file_size > 1_000_000) {
        await adminEdit(u, "File too large (max 1MB).");
        continue;
      }
      rawText = await conversation.external(() => downloadTgText(u, doc.file_id));
    } else if (u.message?.text) {
      rawText = u.message.text;
    } else {
      continue;
    }

    const result = parseStockUpload(rawText);
    if (!result.valid.length) {
      await adminEdit(
        u,
        "No valid credentials found. Expected format:\n" +
          "<code>email:password</code> or <code>email|password|extra</code>\nOne per line.",
      );
      continue;
    }
    credentials = result.valid;
    skippedCount = result.skipped.length;
    break;
  }

  const adminTg = ctx.from!.id;
  const added = await prisma.$transaction(async (tx) => {
    const n = await bulkAddStock(tx, productId, credentials);
    const admin = await getUserByTelegramId(tx, adminTg);
    await logAdminAction(tx, {
      adminId: adminIdOf(admin),
      action: "stock_upload",
      targetType: "product",
      targetId: productId,
      details: `added=${n} skipped=${skippedCount}`,
    });
    return n;
  });

  await adminEdit(ctx, t(ctx, "admin.stock_added", { count: added, skipped: skippedCount }), akb.backToAdminKb(lang));
  await notifyRestockSubscribers(ctx, productId);
}

// ===========================================================================
// Voucher create (3 steps)
// ===========================================================================

export async function voucherCreateConversation(conversation: MyConversation, ctx: MyContext): Promise<void> {
  if (!adminGate(ctx)) return denyAdmin(ctx);
  const lang = ctx.session.lang;
  await ctx.answerCallbackQuery();
  await adminEdit(
    ctx,
    "🎟 <b>Create voucher</b>\n\nStep 1/3: send the code (3–32 chars, A–Z/0–9/_/-)",
    akb.cancelInputKb(),
  );

  // Step 1: code
  let code: string;
  for (;;) {
    const u = await conversation.wait();
    if (await handledEscape(u)) return;
    if (!u.message?.text) continue;
    try {
      code = validateVoucherCode(u.message.text);
    } catch (e) {
      if (e instanceof ValidationError) {
        await adminEdit(u, coreT(e.key, "en", e.formatArgs));
        continue;
      }
      throw e;
    }
    const existing = await conversation.external(() => getVoucherByCode(prisma, code));
    if (existing) {
      await adminEdit(u, "That code already exists. Pick another.");
      continue;
    }
    break;
  }
  await adminEdit(
    ctx,
    "Step 2/3: send type and value, e.g. <code>percent 10</code> for 10% off or <code>fixed 5</code> for 5 USDT off.",
    akb.cancelInputKb(),
  );

  // Step 2: type + value
  let vtype: VoucherType;
  let value: Decimal;
  for (;;) {
    const u = await conversation.wait();
    if (await handledEscape(u)) return;
    const raw = (u.message?.text ?? "").trim().toLowerCase().split(/\s+/);
    if (raw.length !== 2) {
      await adminEdit(u, "Send like <code>percent 10</code> or <code>fixed 5</code>.");
      continue;
    }
    const [typeStr, valStr] = raw;
    if (typeStr !== "percent" && typeStr !== "fixed") {
      await adminEdit(u, "Type must be 'percent' or 'fixed'.");
      continue;
    }
    let val: Decimal;
    try {
      val = new Decimal(valStr!);
    } catch {
      await adminEdit(u, "Value must be a number.");
      continue;
    }
    if (val.lessThanOrEqualTo(0)) {
      await adminEdit(u, "Value must be positive.");
      continue;
    }
    vtype = typeStr === "percent" ? VoucherType.PERCENT : VoucherType.FIXED;
    value = val;
    break;
  }
  await adminEdit(ctx, "Step 3/3: usage limit (number, 0 for unlimited).", akb.cancelInputKb());

  // Step 3: limit
  let limit: number;
  for (;;) {
    const u = await conversation.wait();
    if (await handledEscape(u)) return;
    const n = parseInt((u.message?.text ?? "").trim(), 10);
    if (Number.isNaN(n)) {
      await adminEdit(u, "Send a whole number (0 = unlimited).");
      continue;
    }
    if (n < 0) {
      await adminEdit(u, "Limit must be 0 or positive.");
      continue;
    }
    limit = n;
    break;
  }

  const adminTg = ctx.from!.id;
  await prisma.$transaction(async (tx) => {
    const v = await createVoucher(tx, { code, type: vtype, value, usageLimit: limit > 0 ? limit : null });
    const admin = await getUserByTelegramId(tx, adminTg);
    await logAdminAction(tx, {
      adminId: adminIdOf(admin),
      action: "voucher_create",
      targetType: "voucher",
      targetId: v.id,
      details: `code=${code} type=${vtype} value=${value} limit=${limit}`,
    });
  });

  await adminEdit(ctx, `✅ Voucher <code>${esc(code)}</code> created.`, akb.backToAdminKb(lang));
}

// ===========================================================================
// Broadcast
// ===========================================================================

export async function broadcastConversation(conversation: MyConversation, ctx: MyContext): Promise<void> {
  if (!adminGate(ctx)) return denyAdmin(ctx);
  const lang = ctx.session.lang;
  await ctx.answerCallbackQuery();
  await adminEdit(ctx, t(ctx, "admin.broadcast_ask"), akb.cancelInputKb());

  // Step 1: the message (text or photo).
  let isPhoto = false;
  let photoFileId: string | undefined;
  let caption: string | undefined;
  let captionEntities: MessageEntity[] | undefined;
  let text = "";
  let entities: MessageEntity[] | undefined;
  for (;;) {
    const u = await conversation.wait();
    if (await handledEscape(u)) return;
    const m = u.message;
    if (m?.photo) {
      isPhoto = true;
      photoFileId = m.photo.at(-1)!.file_id;
      caption = m.caption;
      captionEntities = m.caption_entities;
      break;
    }
    if (m?.text) {
      text = m.text;
      entities = m.entities;
      break;
    }
  }

  const recipients = await conversation.external(() =>
    prisma.user.findMany({ where: { banned: false }, select: { telegramId: true } }),
  );

  const snippet = isPhoto ? `🖼 [Photo]${caption ? "\n" + caption : ""}` : text;
  const preview = t(ctx, "admin.broadcast_preview", { count: recipients.length }) + "\n\n──────────\n" + snippet;
  await adminEdit(ctx, preview, akb.broadcastConfirmKb(lang));

  // Step 2: confirm / cancel.
  for (;;) {
    const u = await conversation.wait();
    const data = u.callbackQuery?.data ?? "";
    if (data === "v1:adm:broadcast:cancel" || (await isAdminCancelLike(u))) {
      await u.answerCallbackQuery().catch(() => {});
      await adminEdit(u, t(u, "admin.broadcast_cancelled"), akb.backToAdminKb(lang));
      return;
    }
    if (data === "v1:adm:broadcast:confirm") {
      await u.answerCallbackQuery();
      break;
    }
  }

  await adminEdit(ctx, "⏳ Memproses...");
  const result = await conversation.external(async () => {
    let sent = 0;
    let failed = 0;
    for (const r of recipients) {
      const tgId = Number(r.telegramId);
      try {
        if (isPhoto) {
          await ctx.api.sendPhoto(tgId, photoFileId!, { caption, caption_entities: captionEntities });
        } else {
          await ctx.api.sendMessage(tgId, text, { entities });
        }
        sent++;
      } catch {
        failed++;
      }
    }
    const adminTg = ctx.from!.id;
    await prisma.$transaction(async (tx) => {
      const admin = await getUserByTelegramId(tx, adminTg);
      await logAdminAction(tx, { adminId: adminIdOf(admin), action: "broadcast", details: `sent=${sent} failed=${failed}` });
    });
    return { sent, failed };
  });

  await adminEdit(ctx, t(ctx, "admin.broadcast_sent", { count: result.sent, failed: result.failed }), akb.backToAdminKb(lang));
}

async function isAdminCancelLike(u: MyContext): Promise<boolean> {
  return (u.callbackQuery?.data ?? "") === "v1:adm:cancel";
}

// ===========================================================================
// User search
// ===========================================================================

export async function userSearchConversation(conversation: MyConversation, ctx: MyContext): Promise<void> {
  if (!adminGate(ctx)) return denyAdmin(ctx);
  const lang = ctx.session.lang;
  await ctx.answerCallbackQuery();
  await adminEdit(ctx, "🔎 Send a query (username, full name, or Telegram user ID):", akb.cancelInputKb());

  let users: Awaited<ReturnType<typeof searchUsers>>;
  for (;;) {
    const u = await conversation.wait();
    if (await handledEscape(u)) return;
    if (!u.message?.text) continue;
    users = await conversation.external(() => searchUsers(prisma, u.message!.text!.trim()));
    break;
  }

  if (!users.length) {
    await adminEdit(ctx, "No users matched.", akb.backToAdminKb(lang));
    return;
  }
  const shown = users.slice(0, 10);
  const lines = [`🔎 <b>${shown.length} match(es)</b>`, ""];
  for (const u of shown) {
    const roleTag = u.role === "RESELLER" ? "🛒" : "👤";
    const banTag = u.banned ? " 🚫" : "";
    const name = esc(u.fullName || u.username || `#${u.id}`);
    lines.push(`${roleTag} <b>${name}</b> — TG <code>${u.telegramId}</code>${banTag}`);
  }
  await adminEdit(ctx, lines.join("\n"), akb.usersSearchResultsKb(shown, lang));
}

// ===========================================================================
// Setting edit
// ===========================================================================

export async function settingConversation(conversation: MyConversation, ctx: MyContext): Promise<void> {
  if (!adminGate(ctx)) return denyAdmin(ctx);
  const lang = ctx.session.lang;
  const key = (ctx.callbackQuery?.data ?? "").split(":").at(-1)!;

  const prompts: Record<string, string> = {
    binance_pay_id: "💳 Send the new <b>Binance Pay ID</b> (the numeric ID buyers transfer USDT to).",
    qr: "🖼 Send the new <b>QR image</b> as a photo. It will be shown to buyers at checkout.",
    banner_image:
      "📢 Send the new <b>banner image</b> as a photo. It appears on top of the main menu and the product list (never on payment screens).\n\nSend <code>-</code> to remove the banner.",
    welcome:
      "👋 Send the new <b>welcome message</b>.\n\n• Use <code>{name}</code> as a placeholder for the user's name.\n• HTML tags allowed (e.g. <code>&lt;b&gt;bold&lt;/b&gt;</code>).\n• Send <code>-</code> to reset to the default message.",
    support_contact:
      "📞 Send the <b>support contact</b> (e.g. <code>@yourusername</code> or <code>t.me/yourchannel</code>). It will appear on /support.\n\nSend <code>-</code> to clear.",
  };
  await ctx.answerCallbackQuery();
  await adminEdit(ctx, prompts[key] ?? `Send new value for <b>${esc(key)}</b>:`, akb.cancelInputKb());

  let value: string;
  let displayValue: string;
  for (;;) {
    const u = await conversation.wait();
    if (await handledEscape(u)) return;

    if (key === "qr" || key === "banner_image") {
      // banner_image can also be removed by sending "-".
      if (key === "banner_image" && (u.message?.text ?? "").trim() === "-") {
        await conversation.external(() => prisma.setting.deleteMany({ where: { key } }));
        await adminEdit(u, "✅ Banner removed.", akb.backToAdminKb(lang));
        return;
      }
      if (!u.message?.photo) {
        await adminEdit(u, "⚠️ Please send a <b>photo</b>, not text.");
        continue;
      }
      value = u.message.photo.at(-1)!.file_id;
      displayValue = "[photo]";
      break;
    }

    const raw = (u.message?.text ?? "").trim();
    if (raw === "-" && (key === "welcome" || key === "support_contact")) {
      await conversation.external(() => prisma.setting.deleteMany({ where: { key } }));
      await adminEdit(u, `✅ <b>${esc(key)}</b> cleared.`, akb.backToAdminKb(lang));
      return;
    }
    try {
      value = validateText(raw, 2000);
    } catch (e) {
      if (e instanceof ValidationError) {
        await adminEdit(u, t(u, e.key, e.formatArgs));
        continue;
      }
      throw e;
    }
    displayValue = value.slice(0, 80) + (value.length > 80 ? "..." : "");
    break;
  }

  const adminTg = ctx.from!.id;
  await prisma.$transaction(async (tx) => {
    await setSetting(tx, key, value);
    const admin = await getUserByTelegramId(tx, adminTg);
    await logAdminAction(tx, {
      adminId: adminIdOf(admin),
      action: "setting_set",
      targetType: "setting",
      details: `${key}=${displayValue}`,
    });
  });
  await adminEdit(ctx, `✅ <b>${esc(key)}</b> updated.`, akb.backToAdminKb(lang));
}

// ===========================================================================
// Product create (6 steps)
// ===========================================================================

export async function productCreateConversation(conversation: MyConversation, ctx: MyContext): Promise<void> {
  if (!adminGate(ctx)) return denyAdmin(ctx);
  const lang = ctx.session.lang;
  await ctx.answerCallbackQuery();
  await adminEdit(
    ctx,
    "🛍 <b>New Product</b>\n\nStep 1/6: Send product name (e.g. <code>Netflix Premium 1M</code>).\n\nTap ❌ Cancel to abort.",
    akb.cancelInputKb(),
  );

  // Step 1: name
  let name: string;
  for (;;) {
    const u = await conversation.wait();
    if (await handledEscape(u)) return;
    if (!u.message?.text) continue;
    try {
      name = validateText(u.message.text, 128, 2);
      break;
    } catch (e) {
      if (e instanceof ValidationError) {
        await adminEdit(u, coreT(e.key, "en", e.formatArgs));
        continue;
      }
      throw e;
    }
  }
  await adminEdit(ctx, "Step 2/6: Pick product type.\n\nTap ❌ Cancel to abort.", akb.productTypePickerKb());

  // Step 2: type (callback)
  let ptype: ProductType;
  for (;;) {
    const u = await conversation.wait();
    if (await handledEscape(u)) return;
    const data = u.callbackQuery?.data ?? "";
    if (data === "v1:adm:prod:cancel") {
      await u.answerCallbackQuery({ text: "Cancelled" });
      await adminCommand(u);
      return;
    }
    if (data === "v1:adm:prod:type:shared" || data === "v1:adm:prod:type:private") {
      ptype = data.endsWith("shared") ? ProductType.SHARED : ProductType.PRIVATE;
      await u.answerCallbackQuery();
      break;
    }
  }
  await adminEdit(ctx, "Step 3/6: Send duration label (e.g. <code>1 Month</code>, <code>3 Months</code>).", akb.cancelInputKb());

  // Step 3: duration
  let duration: string;
  for (;;) {
    const u = await conversation.wait();
    if (await handledEscape(u)) return;
    if (!u.message?.text) continue;
    try {
      duration = validateText(u.message.text, 32, 2);
      break;
    } catch (e) {
      if (e instanceof ValidationError) {
        await adminEdit(u, coreT(e.key, "en", e.formatArgs));
        continue;
      }
      throw e;
    }
  }
  await adminEdit(ctx, "Step 4/6: Send price in USDT (e.g. <code>5.00</code>).", akb.cancelInputKb());

  // Step 4: price
  let priceVal: Decimal;
  for (;;) {
    const u = await conversation.wait();
    if (await handledEscape(u)) return;
    const raw = (u.message?.text ?? "").trim().replace(",", ".");
    try {
      const p = new Decimal(raw);
      if (p.lessThanOrEqualTo(0)) throw new Error();
      priceVal = p;
      break;
    } catch {
      await adminEdit(u, "Invalid. Send a positive number, e.g. 5.00");
    }
  }
  await adminEdit(ctx, "Step 5/6: Send reseller price in USDT (or send <code>-</code> to skip).", akb.cancelInputKb());

  // Step 5: reseller price
  let resellerVal: Decimal | null;
  for (;;) {
    const u = await conversation.wait();
    if (await handledEscape(u)) return;
    const raw = (u.message?.text ?? "").trim().replace(",", ".");
    if (raw === "-") {
      resellerVal = null;
      break;
    }
    try {
      const p = new Decimal(raw);
      if (p.lessThanOrEqualTo(0)) throw new Error();
      resellerVal = p;
      break;
    } catch {
      await adminEdit(u, "Invalid. Send a positive number or - to skip.");
    }
  }
  await adminEdit(ctx, "Step 6/6: Send warranty days (e.g. <code>30</code>, or <code>-</code> for default).", akb.cancelInputKb());

  // Step 6: warranty
  let warranty: number | null;
  for (;;) {
    const u = await conversation.wait();
    if (await handledEscape(u)) return;
    const raw = (u.message?.text ?? "").trim();
    if (raw === "-") {
      warranty = null;
      break;
    }
    const n = parseInt(raw, 10);
    if (Number.isNaN(n) || n < 0) {
      await adminEdit(u, "Invalid. Send a non-negative integer or - to skip.");
      continue;
    }
    warranty = n;
    break;
  }

  const adminTg = ctx.from!.id;
  const productName = await prisma.$transaction(async (tx) => {
    const cats = await listAllCategories(tx);
    const catId = cats.length ? cats[0]!.id : (await createCategory(tx, "General", "📦")).id;
    const product = await createProduct(tx, {
      categoryId: catId,
      name,
      description: null,
      type: ptype,
      durationLabel: duration,
      price: priceVal,
      resellerPrice: resellerVal,
      warrantyDays: warranty,
    });
    const admin = await getUserByTelegramId(tx, adminTg);
    await logAdminAction(tx, {
      adminId: adminIdOf(admin),
      action: "product_create",
      targetType: "product",
      targetId: product.id,
      details: `name=${product.name}`,
    });
    return product.name;
  });

  await adminEdit(
    ctx,
    `✅ Product <b>${esc(productName)}</b> created.\n\nNext: add stock via /admin → 📦 Stock.`,
    akb.backToAdminKb(lang),
  );
}

// ===========================================================================
// Product edit (rename / price)
// ===========================================================================

export async function productEditConversation(conversation: MyConversation, ctx: MyContext): Promise<void> {
  if (!adminGate(ctx)) return denyAdmin(ctx);
  const lang = ctx.session.lang;
  const parts = (ctx.callbackQuery?.data ?? "").split(":");
  const field = parts[3]!; // rename | price
  const productId = parseInt(parts[4]!, 10);

  const prompts: Record<string, string> = {
    rename: "✏️ Send the new <b>product name</b>:",
    price: "💲 Send the new <b>price</b> (number, e.g. <code>5.50</code>):",
  };
  await ctx.answerCallbackQuery();
  await adminEdit(ctx, prompts[field] ?? "Send new value:", akb.cancelInputKb());

  const adminTg = ctx.from!.id;
  for (;;) {
    const u = await conversation.wait();
    if (await handledEscape(u)) return;
    const raw = (u.message?.text ?? "").trim();

    if (field === "rename") {
      if (raw.length < 2 || raw.length > 128) {
        await adminEdit(u, "Name must be 2–128 characters.");
        continue;
      }
      await prisma.$transaction(async (tx) => {
        await updateProduct(tx, productId, { name: raw });
        const admin = await getUserByTelegramId(tx, adminTg);
        await logAdminAction(tx, {
          adminId: adminIdOf(admin),
          action: "product_rename",
          targetType: "product",
          targetId: productId,
          details: `name=${raw}`,
        });
      });
      await adminEdit(ctx, `✅ Product renamed to <b>${esc(raw)}</b>.`, akb.backToAdminKb(lang));
      return;
    }

    if (field === "price") {
      let p: Decimal;
      try {
        p = new Decimal(raw.replace(",", "."));
        if (p.lessThanOrEqualTo(0)) throw new Error();
      } catch {
        await adminEdit(u, "Invalid price. Send a positive number.");
        continue;
      }
      await prisma.$transaction(async (tx) => {
        await updateProduct(tx, productId, { price: p });
        const admin = await getUserByTelegramId(tx, adminTg);
        await logAdminAction(tx, {
          adminId: adminIdOf(admin),
          action: "product_price",
          targetType: "product",
          targetId: productId,
          details: `price=${p}`,
        });
      });
      await adminEdit(ctx, `✅ Price updated to <b>${price(p)}</b>.`, akb.backToAdminKb(lang));
      return;
    }
    return;
  }
}

// ===========================================================================
// Bulk pricing (2 steps)
// ===========================================================================

export async function bulkPricingConversation(conversation: MyConversation, ctx: MyContext): Promise<void> {
  if (!adminGate(ctx)) return denyAdmin(ctx);
  const lang = ctx.session.lang;
  const productId = parseInt((ctx.callbackQuery?.data ?? "").split(":").at(-1)!, 10);

  await ctx.answerCallbackQuery();
  await adminEdit(
    ctx,
    "💰 <b>Bulk Pricing Setup</b>\n\nStep 1/2: Send the <b>minimum quantity</b> (integer ≥ 5).\nCustomers who buy at least this many units get the discount.",
    akb.cancelInputKb(),
  );

  // Step 1: min qty
  let minQty: number;
  for (;;) {
    const u = await conversation.wait();
    if (await handledEscape(u)) return;
    const n = parseInt((u.message?.text ?? "").trim(), 10);
    if (Number.isNaN(n) || n < 5) {
      await adminEdit(u, "Please send a whole number ≥ 5.");
      continue;
    }
    minQty = n;
    break;
  }
  await adminEdit(
    ctx,
    "Step 2/2: Send the <b>discount percentage</b> (e.g. <code>10</code> for 10% off).\nMust be between 1 and 99.",
    akb.cancelInputKb(),
  );

  // Step 2: percent
  let pct: Decimal;
  for (;;) {
    const u = await conversation.wait();
    if (await handledEscape(u)) return;
    const raw = (u.message?.text ?? "").trim().replace(",", ".");
    try {
      const p = new Decimal(raw);
      if (p.lessThan(1) || p.greaterThan(99)) throw new Error();
      pct = p;
      break;
    } catch {
      await adminEdit(u, "Please send a number between 1 and 99.");
    }
  }

  const adminTg = ctx.from!.id;
  await prisma.$transaction(async (tx) => {
    await upsertBulkPricing(tx, { productId, minQuantity: minQty, discountPercent: pct });
    const admin = await getUserByTelegramId(tx, adminTg);
    await logAdminAction(tx, {
      adminId: adminIdOf(admin),
      action: "bulk_pricing_set",
      targetType: "product",
      targetId: productId,
      details: `min_qty=${minQty} discount_pct=${pct}`,
    });
  });

  await adminEdit(ctx, `✅ Bulk pricing saved: buy <b>${minQty}+</b> → <b>${pct}% off</b>.`, akb.backToAdminKb(lang));
}

// ===========================================================================
// Ticket reply
// ===========================================================================

export async function ticketReplyConversation(conversation: MyConversation, ctx: MyContext): Promise<void> {
  if (!adminGate(ctx)) return denyAdmin(ctx);
  const lang = ctx.session.lang;
  const ticketId = parseInt((ctx.callbackQuery?.data ?? "").split(":").at(-1)!, 10);

  await ctx.answerCallbackQuery();
  const ticket = await conversation.external(() => getTicket(prisma, ticketId));
  if (ticket === null) {
    await adminEdit(ctx, "Ticket not found.");
    return;
  }

  const photoNote = ticket.photoFileIds ? `\n📎 Photos: ${ticket.photoFileIds.split(",").length}` : "";
  await adminEdit(
    ctx,
    `📩 <b>Replying to ticket #${ticketId}</b>${photoNote}\n\n<b>User message:</b>\n${esc(ticket.message)}\n\nType your reply and send it:`,
    akb.cancelInputKb(),
  );
  if (ticket.photoFileIds) {
    try {
      const media = ticket.photoFileIds.split(",").map((fid) => InputMediaBuilder.photo(fid));
      await ctx.api.sendMediaGroup(ctx.chat!.id, media);
    } catch (err) {
      logger.error({ err }, "Failed to send ticket photos to admin");
    }
  }

  let replyText: string;
  for (;;) {
    const u = await conversation.wait();
    if (await handledEscape(u)) return;
    if (!u.message?.text) continue;
    try {
      replyText = validateText(u.message.text, 2000, 1);
      break;
    } catch (e) {
      if (e instanceof ValidationError) {
        await adminEdit(u, t(u, e.key, e.formatArgs));
        continue;
      }
      throw e;
    }
  }

  const adminTg = ctx.from!.id;
  const customerTgId = await prisma.$transaction(async (tx) => {
    const admin = await getUserByTelegramId(tx, adminTg);
    const adminDbId = adminIdOf(admin);
    const tgId = await replyToTicket(tx, { ticketId, reply: replyText, adminDbId });
    await addTicketMessage(tx, { ticketId, senderType: SenderType.ADMIN, senderId: adminDbId, content: replyText });
    return tgId;
  });

  await adminEdit(ctx, `✅ Reply sent for ticket #${ticketId}.`, akb.backToAdminKb(lang));

  if (customerTgId) {
    try {
      await ctx.api.sendMessage(Number(customerTgId), coreT("support.admin_reply", "en", { message: esc(replyText) }), {
        parse_mode: "HTML",
        reply_markup: ticketResolvedKb(ticketId),
      });
    } catch (err) {
      logger.error({ err }, `Failed to DM customer ${customerTgId} about ticket reply`);
    }
  }
}
