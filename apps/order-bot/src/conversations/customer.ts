/**
 * Customer-side conversations — port of the review + ticket-user-reply
 * ConversationHandlers from customer.py.
 *
 * Replay-safety: every DB/IO call is wrapped in `conversation.external(...)`.
 * UI sends (ctx.reply / smartEdit) go through grammY's Api and are cached by
 * the conversations plugin, so they are not duplicated across replays.
 */
import { config } from "@app/core/config";
import { adminIds } from "@app/core/runtime";
import { SenderType, TicketStatus } from "@app/core/enums";
import { ValidationError } from "@app/core/errors";
import { logger } from "@app/core/logger";
import { prisma, getTicket, addTicketMessage } from "@app/db";
import type { MyContext, MyConversation } from "../context";
import { smartEdit } from "../util/chat";
import { t } from "../util/i18n";
import { esc } from "../util/format";
import { validateText } from "../util/validators";
import { backToMain, isPersistentLabel } from "../keyboards/customer";
import * as akb from "../keyboards/admin";
import { handleProductNumber } from "../handlers/customer";

// ===========================================================================
// Ticket user reply: entry v1:ticket:reply:<id> → ask text → save → notify
// ===========================================================================

export async function ticketUserReplyConversation(conversation: MyConversation, ctx: MyContext): Promise<void> {
  const info = ctx.session.dbUser!;
  const ticketId = parseInt((ctx.callbackQuery?.data ?? "").split(":").at(-1)!, 10);

  const ticket = await conversation.external(() => getTicket(prisma, ticketId));
  if (ticket === null || ticket.userId !== info.id) {
    await ctx.answerCallbackQuery({ text: t(ctx, "error.order_not_found"), show_alert: true });
    return;
  }
  if (ticket.status === TicketStatus.CLOSED) {
    await ctx.answerCallbackQuery({ text: t(ctx, "ticket.closed_cannot_reply"), show_alert: true });
    return;
  }

  await ctx.answerCallbackQuery();
  await smartEdit(ctx, t(ctx, "ticket.ask_reply"));

  let body: string;
  for (;;) {
    const msgCtx = await conversation.waitFor("message:text");
    const replyText = msgCtx.message.text ?? "";
    // A reply-keyboard menu tap (Terms, FAQ, …) must not be captured as the
    // ticket reply. Exit the conversation and run the tapped action instead.
    if (isPersistentLabel(replyText)) return void (await handleProductNumber(msgCtx));
    try {
      body = validateText(replyText, 2000, 1);
      break;
    } catch (e) {
      if (e instanceof ValidationError) {
        await smartEdit(msgCtx, t(msgCtx, e.key, e.formatArgs));
        continue;
      }
      throw e;
    }
  }

  await conversation.external(() =>
    addTicketMessage(prisma, { ticketId, senderType: SenderType.USER, senderId: info.id, content: body }),
  );

  await smartEdit(ctx, t(ctx, "ticket.reply_sent"), backToMain(ctx.session.lang));

  const targets = config.SUPPORT_GROUP_ID ? [config.SUPPORT_GROUP_ID] : adminIds();
  await conversation.external(async () => {
    for (const chatId of targets) {
      if (!chatId) continue;
      try {
        await ctx.api.sendMessage(
          chatId,
          `User reply on ticket #${ticketId}\n` +
            `From: <code>${ctx.from!.id}</code>\n\n` +
            `${esc(body.slice(0, 500))}`,
          { parse_mode: "HTML", reply_markup: akb.ticketReplyKb(ticketId, "en") },
        );
      } catch (err) {
        logger.error({ err }, `Failed to notify admin about ticket #${ticketId} user reply`);
      }
    }
  });
}
