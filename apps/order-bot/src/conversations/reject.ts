/**
 * Reject-reason conversation — port of the reject ConversationHandler in
 * verification.py. Admin taps Reject → types a reason → order is rejected,
 * stock released, buyer notified.
 */
import { langCode } from "@app/core/enums";
import { ValidationError } from "@app/core/errors";
import { logger } from "@app/core/logger";
import { prisma, getUserByTelegramId, rejectOrder, logAdminAction } from "@app/db";
import { isAdmin } from "@app/core/config";
import type { MyContext, MyConversation } from "../context";
import { adminEdit, adminAnchor, consumeInput } from "../util/chat";
import { coreT, t } from "../util/i18n";
import { esc } from "../util/format";
import { validateText } from "../util/validators";
import * as akb from "../keyboards/admin";
import { notificationKb } from "../keyboards/customer";
import { adminCommand } from "../handlers/admin";
import { startCommand } from "../handlers/customer";

function isCmd(ctx: MyContext, cmd: string): boolean {
  const text = ctx.message?.text ?? "";
  return text === `/${cmd}` || text.startsWith(`/${cmd} `) || text.startsWith(`/${cmd}@`);
}

export async function rejectConversation(conversation: MyConversation, ctx: MyContext): Promise<void> {
  if (!isAdmin(ctx.from!.id)) {
    await ctx.answerCallbackQuery({ text: t(ctx, "error.admin_only"), show_alert: true });
    return;
  }
  const adminLang = ctx.session.lang;
  const orderId = parseInt((ctx.callbackQuery?.data ?? "").split(":").at(-1)!, 10);

  await ctx.answerCallbackQuery();
  await adminEdit(ctx, t(ctx, "admin.ask_reject_reason"), akb.cancelInputKb());

  let reason: string;
  for (;;) {
    const u = await conversation.wait();
    if ((u.callbackQuery?.data ?? "") === "v1:adm:cancel") {
      await u.answerCallbackQuery();
      await adminCommand(u);
      return;
    }
    if (isCmd(u, "cancel")) return void (await adminCommand(u));
    if (isCmd(u, "start")) return void (await startCommand(u));
    const text = u.message?.text;
    if (!text) continue;
    await consumeInput(u);
    try {
      reason = validateText(text, 512, 3);
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
  let buyerTgId: bigint | null;
  let buyerLang: string;
  let orderCode: string;
  try {
    const order = await prisma.$transaction(async (tx) => {
      const admin = await getUserByTelegramId(tx, adminTg);
      const o = await rejectOrder(tx, orderId, { adminId: admin ? admin.id : 0, reason });
      await logAdminAction(tx, {
        adminId: admin ? admin.id : 0,
        action: "reject_order",
        targetType: "order",
        targetId: orderId,
        details: `reason=${reason}`,
      });
      return o!;
    });
    buyerTgId = order.user.telegramId;
    buyerLang = langCode(order.user.language);
    orderCode = order.orderCode;
  } catch (e) {
    if (e instanceof ValidationError) {
      await adminEdit(ctx, t(ctx, e.key, e.formatArgs));
      return;
    }
    throw e;
  }

  if (buyerTgId === null) {
    // Web-registered buyer with no Telegram account — they see the rejected
    // order on the website, so there is no DM to send.
    logger.info(`Order ${orderCode} rejected; buyer is web-only (no Telegram id), skipping rejection DM`);
  } else {
    try {
      await ctx.api.sendMessage(
        Number(buyerTgId),
        coreT("order.rejected", buyerLang, { code: orderCode, reason: esc(reason) }),
        { parse_mode: "HTML", reply_markup: notificationKb(buyerLang) },
      );
    } catch (err) {
      logger.error({ err }, "Failed to notify buyer of rejection");
    }
  }

  await adminEdit(ctx, coreT("admin.rejected", adminLang, { code: orderCode }), akb.backToAdminKb(adminLang));
}
