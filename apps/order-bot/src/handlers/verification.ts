/**
 * Admin verification queue — port of verification.py (non-conversation parts;
 * the reject-reason flow lives in src/conversations/reject.ts).
 *
 * The approve path is the touchiest workflow: credentials only leave the DB if
 * the DB transaction commits. We do DB transaction → DM buyer → (the audit log
 * is written inside the same transaction). If the DM fails we keep the DB
 * DELIVERED and show the admin a one-tap resend button.
 */
import { config } from "@app/core/config";
import { adminIds } from "@app/core/runtime";
import { OrderStatus, StockStatus, langCode } from "@app/core/enums";
import { logger } from "@app/core/logger";
import {
  prisma,
  listPendingVerifications,
  getOrder,
  getUserByTelegramId,
  approveOrder,
  logAdminAction,
  lowStockDenominations,
} from "@app/db";
import type { MyContext } from "../context";
import { adminEdit } from "../util/chat";
import { coreT, t } from "../util/i18n";
import { esc, formatIdr, orderAmount, groupOrderItems, redactCredentials } from "../util/format";
import * as akb from "../keyboards/admin";
import { sendAccountFile } from "../util/delivery";

/** Build per-product credential sections for the buyer DM (one header + <pre>). */
function buildCredSections(
  items: Array<{ productId: number; product: { name: string }; stockItem: { credentials: string } | null }>,
  buyerLang: string,
): { blob: string; groups: Array<[string, string[]]> } {
  const groups: Array<[string, string[]]> = [];
  const pidToIdx = new Map<number, number>();
  for (const it of items) {
    if (!it.stockItem) continue;
    if (!pidToIdx.has(it.productId)) {
      pidToIdx.set(it.productId, groups.length);
      groups.push([it.product.name, []]);
    }
    groups[pidToIdx.get(it.productId)!]![1].push(it.stockItem.credentials);
  }
  const sections = groups.map(([pname, creds]) => {
    const header = coreT("order.delivered_group_header", buyerLang, { product: esc(pname), count: creds.length });
    const block = "<pre>" + esc(creds.join("\n")) + "</pre>";
    return `${header}\n${block}`;
  });
  return { blob: sections.join("\n\n"), groups };
}

// ---------------------------------------------------------------------------
// Queue listing
// ---------------------------------------------------------------------------

export async function showQueue(ctx: MyContext): Promise<void> {
  const lang = ctx.session.lang;
  const orders = await listPendingVerifications(prisma);
  if (!orders.length) {
    await adminEdit(ctx, "✅ No pending verifications.", akb.backToAdminKb(lang));
    return;
  }
  const text = `🔎 <b>Pending Verifications</b> (${orders.length})\n\nTap an order to review:`;
  await adminEdit(ctx, text, akb.verificationQueueKb(orders, lang));
}

// ---------------------------------------------------------------------------
// Order view (with screenshot + actions)
// ---------------------------------------------------------------------------

export async function viewOrder(ctx: MyContext, orderId: number): Promise<void> {
  const lang = ctx.session.lang;
  const order = await getOrder(prisma, orderId);
  if (order === null) {
    await ctx.answerCallbackQuery({ text: t(ctx, "error.order_not_found"), show_alert: true });
    return;
  }

  const itemLines = groupOrderItems(order.items)
    .map((g) => `• ${esc(g.product.name)} × ${g.quantity} — ${formatIdr(g.lineTotal)}`)
    .join("\n");
  const userDisplay =
    `<code>${order.user.telegramId ?? "?"}</code> ` +
    `(@${esc(order.user.username ?? "")} — ${esc(order.user.fullName ?? "")})`;
  const text = t(ctx, "admin.verification_item", {
    code: order.orderCode,
    user: userDisplay,
    total: orderAmount(order, 4),
    txid: esc(order.binanceTxid ?? "-"),
    lines: itemLines,
  });
  const keyboard = akb.verificationActionsKb(orderId, lang);

  const screenshotFileId = order.paymentProofFileId;
  if (screenshotFileId) {
    try {
      await ctx.replyWithPhoto(screenshotFileId, { caption: text, parse_mode: "HTML", reply_markup: keyboard });
      return;
    } catch {
      logger.warn("Could not send proof screenshot; falling back to text");
    }
  }
  await adminEdit(ctx, text, keyboard);
}

// ---------------------------------------------------------------------------
// Approve
// ---------------------------------------------------------------------------

export async function approve(ctx: MyContext, orderId: number): Promise<void> {
  const adminTg = ctx.from!.id;
  const adminLang = ctx.session.lang;

  let buyerTgId: bigint | null;
  let buyerLang: string;
  let orderCode: string;
  let buyerId: number;
  let credGroups: Array<[string, string[]]>;
  let buyerItems: Parameters<typeof sendAccountFile>[2]["items"];

  try {
    const result = await prisma.$transaction(async (tx) => {
      const admin = await getUserByTelegramId(tx, adminTg);
      const { order } = await approveOrder(tx, orderId, { adminId: admin ? admin.id : 0 });
      await logAdminAction(tx, {
        adminId: admin ? admin.id : 0,
        action: "approve_order",
        targetType: "order",
        targetId: orderId,
        details: `order_code=${order.orderCode}`,
      });
      return order;
    });
    buyerTgId = result.user.telegramId;
    buyerLang = langCode(result.user.language);
    orderCode = result.orderCode;
    buyerId = result.userId;
    buyerItems = result.items;
    credGroups = buildCredSections(result.items, buyerLang).groups;
  } catch (e) {
    if (e instanceof Error && "key" in e) {
      await ctx.answerCallbackQuery({ text: coreT((e as { key: string }).key, adminLang), show_alert: true });
      return;
    }
    throw e;
  }

  // Phase 2: notify buyer — first a "payment verified" status, then the creds.
  // Web-registered buyers have no Telegram id: skip both DMs (they see the
  // delivered order + credentials on the website) and don't offer a resend.
  let dmOk = false;
  if (buyerTgId === null) {
    dmOk = true;
    logger.info(`Order ${orderCode} approved; buyer is web-only (no Telegram id) — skipping DMs, order visible on the website`);
  } else {
    // Delivery is instant: no interim "payment verified / being prepared" DM —
    // the account file below is the single delivery notification.
    try {
      await sendAccountFile(ctx.api, Number(buyerTgId), { orderCode, items: buyerItems }, buyerLang);
      dmOk = true;
      const redacted = credGroups.flatMap(([, creds]) => creds.map(redactCredentials));
      logger.info(`Delivered order ${orderCode} to user ${buyerTgId} (creds redacted: ${redacted.join(", ")})`);
    } catch (err) {
      logger.error(
        { err },
        `Order ${orderCode} approved in DB but DM to buyer ${buyerTgId} FAILED — resend button shown to admin`,
      );
    }
  }

  // Phase 3: ack admin.
  await ctx.answerCallbackQuery({ text: coreT("admin.approved", adminLang, { code: orderCode }), show_alert: true });
  try {
    const replyKb = dmOk ? akb.backToAdminKb(adminLang) : akb.approvedResendKb(orderId, adminLang);
    const resultText =
      `✅ Order <code>${orderCode}</code> approved.` +
      (dmOk ? "" : "\n\n⚠️ " + coreT("admin.resend_needed", adminLang));
    await adminEdit(ctx, resultText, replyKb);
  } catch {
    /* ignore edit failures */
  }

  // Phase 4: low-stock alerts.
  await maybeAlertLowStock(ctx, buyerId);
}

// ---------------------------------------------------------------------------
// Resend credentials (admin one-tap retry when the initial buyer DM failed)
// ---------------------------------------------------------------------------

export async function resendCredentials(ctx: MyContext, orderId: number): Promise<void> {
  const adminLang = ctx.session.lang;
  const order = await getOrder(prisma, orderId);
  if (order === null) {
    await ctx.answerCallbackQuery({ text: t(ctx, "error.order_not_found"), show_alert: true });
    return;
  }
  if (order.status !== OrderStatus.DELIVERED) {
    await ctx.answerCallbackQuery({ text: t(ctx, "error.order_already_delivered"), show_alert: true });
    return;
  }

  const buyerLang = langCode(order.user.language);
  const soldItems = order.items.filter((oi) => oi.stockItem && oi.stockItem.status === StockStatus.SOLD);
  const { groups } = buildCredSections(soldItems, buyerLang);
  if (!groups.length) {
    await ctx.answerCallbackQuery({ text: t(ctx, "admin.resend_no_creds"), show_alert: true });
    return;
  }

  const buyerTgId = order.user.telegramId;
  const orderCode = order.orderCode;
  if (buyerTgId === null) {
    // Web-only buyer — there is no DM target; they see the credentials on the
    // website. (The resend button isn't offered for these orders, but guard
    // anyway so Number(null) can never become a sendDocument target.)
    await ctx.answerCallbackQuery({ text: t(ctx, "admin.resend_fail"), show_alert: true });
    logger.info(`Resend skipped for order ${orderCode}: buyer is web-only (no Telegram id)`);
    return;
  }

  try {
    await sendAccountFile(ctx.api, Number(buyerTgId), { orderCode, items: soldItems }, buyerLang);
    await ctx.answerCallbackQuery({ text: t(ctx, "admin.resend_ok"), show_alert: true });
    logger.info(`Resent credentials for order ${orderCode} to user ${buyerTgId}`);
  } catch (err) {
    await ctx.answerCallbackQuery({ text: t(ctx, "admin.resend_fail"), show_alert: true });
    logger.error({ err }, `Resend of credentials for order ${orderCode} to ${buyerTgId} still failed`);
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function maybeAlertLowStock(ctx: MyContext, _userId: number): Promise<void> {
  const rows = await lowStockDenominations(prisma, config.LOW_STOCK_THRESHOLD);
  if (!rows.length) return;
  for (const { denomination, available } of rows) {
    if (!denomination) continue;
    for (const adminId of adminIds()) {
      try {
        await ctx.api.sendMessage(
          adminId,
          coreT("admin.low_stock_alert", "en", { product: esc(denomination.name), count: available }),
          { parse_mode: "HTML" },
        );
      } catch (err) {
        logger.error({ err }, `Failed to send low-stock alert to admin ${adminId}`);
      }
    }
  }
}
