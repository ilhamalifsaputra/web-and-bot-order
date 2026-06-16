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
import { config } from "@app/core/config";
import { botToken, isAdmin } from "@app/core/runtime";
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
  getSetting,
  setSetting,
  deleteSetting,
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
import { adminEdit, adminAnchor, consumeInput } from "../util/chat";
import { BANNER_FILEID_KEY } from "../util/banner";
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
        await adminAnchor(u, t(u, "admin.stock_err_txt"), akb.cancelInputKb());
        continue;
      }
      if (doc.file_size && doc.file_size > 1_000_000) {
        await adminAnchor(u, t(u, "admin.stock_err_too_large"), akb.cancelInputKb());
        continue;
      }
      rawText = await conversation.external(() => downloadTgText(u, doc.file_id));
      // Delete only after the download — keeps pasted credentials out of the
      // visible chat history once they're safely captured.
      await consumeInput(u);
    } else if (u.message?.text) {
      rawText = u.message.text;
      await consumeInput(u);
    } else {
      continue;
    }

    const result = parseStockUpload(rawText);
    if (!result.valid.length) {
      await adminAnchor(u, t(u, "admin.stock_err_no_valid"), akb.cancelInputKb());
      continue;
    }
    credentials = result.valid;
    skippedCount = result.skipped.length;
    break;
  }

  // Buttonless processing state: a second paste/tap can't double-run the bulk
  // insert while the transaction is in flight.
  await adminAnchor(ctx, t(ctx, "admin.processing"));

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
  await adminEdit(ctx, t(ctx, "admin.voucher_step1"), akb.cancelInputKb());

  // Step 1: code
  let code: string;
  for (;;) {
    const u = await conversation.wait();
    if (await handledEscape(u)) return;
    if (!u.message?.text) continue;
    const raw = u.message.text;
    await consumeInput(u);
    try {
      code = validateVoucherCode(raw);
    } catch (e) {
      if (e instanceof ValidationError) {
        await adminAnchor(u, t(u, e.key, e.formatArgs), akb.cancelInputKb());
        continue;
      }
      throw e;
    }
    const existing = await conversation.external(() => getVoucherByCode(prisma, code));
    if (existing) {
      await adminAnchor(u, t(u, "admin.voucher_err_exists"), akb.cancelInputKb());
      continue;
    }
    break;
  }
  await adminEdit(ctx, t(ctx, "admin.voucher_step2", { code }), akb.cancelInputKb());

  // Step 2: type + value
  let vtype: VoucherType;
  let value: Decimal;
  for (;;) {
    const u = await conversation.wait();
    if (await handledEscape(u)) return;
    if (!u.message?.text) continue;
    const raw = u.message.text.trim().toLowerCase().split(/\s+/);
    await consumeInput(u);
    const [typeStr, valStr] = raw;
    if (raw.length !== 2 || (typeStr !== "percent" && typeStr !== "fixed")) {
      await adminAnchor(u, t(u, "admin.voucher_err_format"), akb.cancelInputKb());
      continue;
    }
    let val: Decimal;
    try {
      val = new Decimal(valStr!);
    } catch {
      await adminAnchor(u, t(u, "admin.voucher_err_value"), akb.cancelInputKb());
      continue;
    }
    if (val.lessThanOrEqualTo(0)) {
      await adminAnchor(u, t(u, "admin.voucher_err_value"), akb.cancelInputKb());
      continue;
    }
    vtype = typeStr === "percent" ? VoucherType.PERCENT : VoucherType.FIXED;
    value = val;
    break;
  }
  const discount = vtype === VoucherType.PERCENT ? `${value}%` : `${value} USDT`;
  await adminEdit(ctx, t(ctx, "admin.voucher_step3", { code, discount }), akb.cancelInputKb());

  // Step 3: limit
  let limit: number;
  for (;;) {
    const u = await conversation.wait();
    if (await handledEscape(u)) return;
    if (!u.message?.text) continue;
    const raw = u.message.text.trim();
    await consumeInput(u);
    const n = parseInt(raw, 10);
    if (Number.isNaN(n) || n < 0) {
      await adminAnchor(u, t(u, "admin.voucher_err_limit"), akb.cancelInputKb());
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

  // Read-after-write: the wizard bubble becomes the created voucher's summary.
  await adminEdit(
    ctx,
    t(ctx, "admin.voucher_created", {
      code: esc(code),
      discount,
      limit: limit > 0 ? limit : t(ctx, "admin.unlimited"),
    }),
    akb.backToAdminKb(lang),
  );
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
      // The preview repeats the composed text, so the raw input can go.
      // (Photo messages are kept: the broadcast reuses their file_id.)
      await consumeInput(u);
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

  await adminEdit(ctx, t(ctx, "admin.processing"));
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
  await adminEdit(ctx, t(ctx, "admin.user_search_ask"), akb.cancelInputKb());

  let users: Awaited<ReturnType<typeof searchUsers>>;
  for (;;) {
    const u = await conversation.wait();
    if (await handledEscape(u)) return;
    if (!u.message?.text) continue;
    const query = u.message.text.trim();
    await consumeInput(u);
    users = await conversation.external(() => searchUsers(prisma, query));
    break;
  }

  if (!users.length) {
    await adminEdit(ctx, t(ctx, "admin.user_search_none"), akb.backToAdminKb(lang));
    return;
  }
  const shown = users.slice(0, 10);
  const lines = [t(ctx, "admin.user_search_matches", { count: shown.length }), ""];
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

  const promptKeys: Record<string, string> = {
    binance_pay_id: "admin.setting_prompt_binance_pay_id",
    qr: "admin.setting_prompt_qr",
    banner_image: "admin.setting_prompt_banner_image",
    welcome: "admin.setting_prompt_welcome",
    support_contact: "admin.setting_prompt_support_contact",
  };
  const promptKey = promptKeys[key];
  await ctx.answerCallbackQuery();
  await adminEdit(
    ctx,
    promptKey ? t(ctx, promptKey) : t(ctx, "admin.setting_ask_value", { key: esc(key) }),
    akb.cancelInputKb(),
  );

  let value: string;
  let displayValue: string;
  for (;;) {
    const u = await conversation.wait();
    if (await handledEscape(u)) return;

    if (key === "qr" || key === "banner_image") {
      // banner_image can also be removed by sending "-".
      if (key === "banner_image" && (u.message?.text ?? "").trim() === "-") {
        await consumeInput(u);
        const oldFileId = await conversation.external(() => prisma.setting.findUnique({ where: { key } }).then((r) => r?.value ?? null));
        await conversation.external(() => prisma.setting.deleteMany({ where: { key } }));
        // Drop any cached upload file_id so a later web banner can't resurface it.
        await conversation.external(() => deleteSetting(prisma, BANNER_FILEID_KEY));
        // Save undo state with a 30-second expiry window.
        if (oldFileId) {
          u.session.scratch.undoBanner = { fileId: oldFileId, expiresAt: Date.now() + 30_000 };
        }
        await adminAnchor(u, t(u, "admin.banner_removed_undo"), akb.bannerRemovedUndoKb(lang));
        return;
      }
      if (!u.message?.photo) {
        await consumeInput(u);
        await adminAnchor(u, t(u, "admin.setting_err_photo"), akb.cancelInputKb());
        continue;
      }
      // Photo inputs are kept in the chat (the stored file_id references them).
      value = u.message.photo.at(-1)!.file_id;
      displayValue = "[photo]";
      break;
    }

    if (!u.message?.text) continue;
    const raw = u.message.text.trim();
    await consumeInput(u);
    if (raw === "-" && (key === "welcome" || key === "support_contact")) {
      await conversation.external(() => prisma.setting.deleteMany({ where: { key } }));
      await adminAnchor(u, t(u, "admin.setting_cleared", { key: esc(key) }), akb.backToAdminKb(lang));
      return;
    }
    try {
      value = validateText(raw, 2000);
    } catch (e) {
      if (e instanceof ValidationError) {
        await adminAnchor(u, t(u, e.key, e.formatArgs), akb.cancelInputKb());
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
    // A bot-set banner is a raw file_id; invalidate any cached upload file_id.
    if (key === "banner_image") await deleteSetting(tx, BANNER_FILEID_KEY);
    const admin = await getUserByTelegramId(tx, adminTg);
    await logAdminAction(tx, {
      adminId: adminIdOf(admin),
      action: "setting_set",
      targetType: "setting",
      details: `${key}=${displayValue}`,
    });
  });
  await adminEdit(ctx, t(ctx, "admin.setting_updated", { key: esc(key) }), akb.backToAdminKb(lang));
}

// ===========================================================================
// Product create (6 steps)
// ===========================================================================

export async function productCreateConversation(conversation: MyConversation, ctx: MyContext): Promise<void> {
  if (!adminGate(ctx)) return denyAdmin(ctx);
  const lang = ctx.session.lang;
  await ctx.answerCallbackQuery();

  // Draft shape stored in session.scratch.productDraft between entries.
  type ProductDraft = {
    step: number;
    name?: string;
    type?: string;   // "SHARED" | "PRIVATE"
    typeLabel?: string;
    duration?: string;
    price?: string;
    resellerPrice?: string | null;
  };
  const clearDraft = () => void (ctx.session.scratch.productDraft = undefined);
  const saveDraft = (d: ProductDraft) => void (ctx.session.scratch.productDraft = d);

  // Check for an unfinished draft from a previous entry.
  // `prior` is read once before any wait() — same value on replay.
  const prior = ctx.session.scratch.productDraft as ProductDraft | undefined;
  let skip = 0; // how many initial steps to restore from draft (0 = fresh start)
  let dr: ProductDraft = { step: 1 };

  if (prior && prior.step >= 2 && prior.name) {
    await adminEdit(ctx, t(ctx, "admin.prod_draft_found", { step: prior.step, name: esc(prior.name) }), akb.productDraftResumeKb());
    for (;;) {
      const u = await conversation.wait();
      const data = u.callbackQuery?.data ?? "";
      if (data === "v1:adm:prod:draft:resume") {
        await u.answerCallbackQuery();
        dr = prior;
        skip = prior.step - 1;
        break;
      }
      if (data === "v1:adm:prod:draft:fresh") {
        await u.answerCallbackQuery();
        clearDraft();
        break;
      }
      if (await handledEscape(u)) return;
    }
  }

  // --- Step 1: name ---------------------------------------------------------
  let name: string;
  if (skip >= 1) {
    name = dr.name!;
  } else {
    await adminEdit(ctx, t(ctx, "admin.prod_step1"), akb.cancelInputKb());
    for (;;) {
      const u = await conversation.wait();
      if (await handledEscape(u)) return;
      if (!u.message?.text) continue;
      const raw = u.message.text;
      await consumeInput(u);
      try {
        name = validateText(raw, 128, 2);
        break;
      } catch (e) {
        if (e instanceof ValidationError) {
          await adminAnchor(u, t(u, e.key, e.formatArgs), akb.cancelInputKb());
          continue;
        }
        throw e;
      }
    }
  }
  saveDraft({ step: 2, name: name! });

  // --- Step 2: type ---------------------------------------------------------
  let ptype: ProductType;
  let typeLabel: string;
  if (skip >= 2) {
    ptype = dr.type === "PRIVATE" ? ProductType.PRIVATE : ProductType.SHARED;
    typeLabel = dr.typeLabel ?? (ptype === ProductType.SHARED ? "Shared" : "Private");
  } else {
    await adminEdit(ctx, t(ctx, "admin.prod_step2", { name: esc(name!) }), akb.productTypePickerKb());
    for (;;) {
      const u = await conversation.wait();
      if (await handledEscape(u)) return;
      const data = u.callbackQuery?.data ?? "";
      if (data === "v1:adm:prod:cancel") {
        await u.answerCallbackQuery({ text: t(u, "admin.toast.cancelled") });
        await adminCommand(u);
        return;
      }
      if (data === "v1:adm:prod:type:shared" || data === "v1:adm:prod:type:private") {
        ptype = data.endsWith("shared") ? ProductType.SHARED : ProductType.PRIVATE;
        await u.answerCallbackQuery();
        break;
      }
    }
    typeLabel = ptype! === ProductType.SHARED ? "Shared" : "Private";
  }
  saveDraft({ step: 3, name: name!, type: ptype!, typeLabel });

  // --- Step 3: duration -----------------------------------------------------
  let duration: string;
  if (skip >= 3) {
    duration = dr.duration!;
  } else {
    await adminEdit(ctx, t(ctx, "admin.prod_step3", { name: esc(name!), type: typeLabel }), akb.cancelInputKb());
    for (;;) {
      const u = await conversation.wait();
      if (await handledEscape(u)) return;
      if (!u.message?.text) continue;
      const raw = u.message.text;
      await consumeInput(u);
      try {
        duration = validateText(raw, 32, 2);
        break;
      } catch (e) {
        if (e instanceof ValidationError) {
          await adminAnchor(u, t(u, e.key, e.formatArgs), akb.cancelInputKb());
          continue;
        }
        throw e;
      }
    }
  }
  saveDraft({ step: 4, name: name!, type: ptype!, typeLabel, duration: duration! });

  // --- Step 4: price --------------------------------------------------------
  let priceVal: Decimal;
  if (skip >= 4) {
    priceVal = new Decimal(dr.price!);
  } else {
    await adminEdit(ctx, t(ctx, "admin.prod_step4", { name: esc(name!), type: typeLabel, duration: esc(duration!) }), akb.cancelInputKb());
    for (;;) {
      const u = await conversation.wait();
      if (await handledEscape(u)) return;
      if (!u.message?.text) continue;
      const raw = u.message.text.trim().replace(",", ".");
      await consumeInput(u);
      try {
        const p = new Decimal(raw);
        if (p.lessThanOrEqualTo(0)) throw new Error();
        priceVal = p;
        break;
      } catch {
        await adminAnchor(u, t(u, "admin.prod_err_price"), akb.cancelInputKb());
      }
    }
  }
  saveDraft({ step: 5, name: name!, type: ptype!, typeLabel, duration: duration!, price: priceVal!.toString() });

  // --- Step 5: reseller price -----------------------------------------------
  let resellerVal: Decimal | null;
  if (skip >= 5) {
    resellerVal = dr.resellerPrice != null ? new Decimal(dr.resellerPrice) : null;
  } else {
    await adminEdit(ctx, t(ctx, "admin.prod_step5", { price: price(priceVal!) }), akb.cancelInputKb());
    for (;;) {
      const u = await conversation.wait();
      if (await handledEscape(u)) return;
      if (!u.message?.text) continue;
      const raw = u.message.text.trim().replace(",", ".");
      await consumeInput(u);
      if (raw === "-") { resellerVal = null; break; }
      try {
        const p = new Decimal(raw);
        if (p.lessThanOrEqualTo(0)) throw new Error();
        resellerVal = p;
        break;
      } catch {
        await adminAnchor(u, t(u, "admin.prod_err_reseller"), akb.cancelInputKb());
      }
    }
  }
  saveDraft({ step: 6, name: name!, type: ptype!, typeLabel, duration: duration!, price: priceVal!.toString(), resellerPrice: resellerVal ? resellerVal.toString() : null });

  // --- Step 6: warranty (always runs — last step before DB write) -----------
  let warranty: number | null;
  await adminEdit(ctx, t(ctx, "admin.prod_step6"), akb.cancelInputKb());
  for (;;) {
    const u = await conversation.wait();
    if (await handledEscape(u)) return;
    if (!u.message?.text) continue;
    const raw = u.message.text.trim();
    await consumeInput(u);
    if (raw === "-") { warranty = null; break; }
    const n = parseInt(raw, 10);
    if (Number.isNaN(n) || n < 0) {
      await adminAnchor(u, t(u, "admin.prod_err_warranty"), akb.cancelInputKb());
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
      name: name!,
      description: null,
      type: ptype!,
      durationLabel: duration!,
      price: priceVal!,
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

  clearDraft(); // Created successfully — discard the draft.
  await adminEdit(ctx, t(ctx, "admin.prod_created", { name: esc(productName) }), akb.backToAdminKb(lang));
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
    rename: t(ctx, "admin.prod_ask_rename"),
    price: t(ctx, "admin.prod_ask_price"),
  };
  await ctx.answerCallbackQuery();
  await adminEdit(ctx, prompts[field] ?? t(ctx, "admin.setting_ask_value", { key: esc(field) }), akb.cancelInputKb());

  const adminTg = ctx.from!.id;
  for (;;) {
    const u = await conversation.wait();
    if (await handledEscape(u)) return;
    if (!u.message?.text) continue;
    const raw = u.message.text.trim();
    await consumeInput(u);

    if (field === "rename") {
      if (raw.length < 2 || raw.length > 128) {
        await adminAnchor(u, t(u, "admin.prod_err_name_len"), akb.cancelInputKb());
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
      await adminEdit(ctx, t(ctx, "admin.prod_renamed", { name: esc(raw) }), akb.backToAdminKb(lang));
      return;
    }

    if (field === "price") {
      let p: Decimal;
      try {
        p = new Decimal(raw.replace(",", "."));
        if (p.lessThanOrEqualTo(0)) throw new Error();
      } catch {
        await adminAnchor(u, t(u, "admin.prod_err_price"), akb.cancelInputKb());
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
      await adminEdit(ctx, t(ctx, "admin.prod_price_updated", { price: price(p) }), akb.backToAdminKb(lang));
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
  await adminEdit(ctx, t(ctx, "admin.bulk_step1"), akb.cancelInputKb());

  // Step 1: min qty
  let minQty: number;
  for (;;) {
    const u = await conversation.wait();
    if (await handledEscape(u)) return;
    if (!u.message?.text) continue;
    const raw = u.message.text.trim();
    await consumeInput(u);
    const n = parseInt(raw, 10);
    if (Number.isNaN(n) || n < 5) {
      await adminAnchor(u, t(u, "admin.bulk_err_min"), akb.cancelInputKb());
      continue;
    }
    minQty = n;
    break;
  }
  await adminEdit(ctx, t(ctx, "admin.bulk_step2", { minQty }), akb.cancelInputKb());

  // Step 2: percent
  let pct: Decimal;
  for (;;) {
    const u = await conversation.wait();
    if (await handledEscape(u)) return;
    if (!u.message?.text) continue;
    const raw = u.message.text.trim().replace(",", ".");
    await consumeInput(u);
    try {
      const p = new Decimal(raw);
      if (p.lessThan(1) || p.greaterThan(99)) throw new Error();
      pct = p;
      break;
    } catch {
      await adminAnchor(u, t(u, "admin.bulk_err_pct"), akb.cancelInputKb());
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

  await adminEdit(ctx, t(ctx, "admin.bulk_saved", { minQty, pct }), akb.backToAdminKb(lang));
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
    await adminEdit(ctx, t(ctx, "admin.ticket_not_found"), akb.backToAdminKb(lang));
    return;
  }

  const photoNote = ticket.photoFileIds ? `\n📎 ${ticket.photoFileIds.split(",").length}` : "";
  await adminEdit(
    ctx,
    t(ctx, "admin.ticket_reply_prompt", { id: ticketId, photos: photoNote, message: esc(ticket.message) }),
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
    const raw = u.message.text;
    await consumeInput(u);
    try {
      replyText = validateText(raw, 2000, 1);
      break;
    } catch (e) {
      if (e instanceof ValidationError) {
        await adminAnchor(u, t(u, e.key, e.formatArgs), akb.cancelInputKb());
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

  // The typed reply was consumed above — keep its content in the confirmation
  // so the admin still has a record of what was sent.
  await adminEdit(
    ctx,
    t(ctx, "admin.ticket_reply_sent", { id: ticketId, reply: esc(replyText) }),
    akb.backToAdminKb(lang),
  );

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
