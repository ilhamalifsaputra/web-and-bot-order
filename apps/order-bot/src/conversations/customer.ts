import { randomUUID } from "node:crypto";
import { InlineKeyboard } from "grammy";
import { botToken } from "@app/core/runtime";
import { SenderType, TicketStatus } from "@app/core/enums";
import { supportMediaAvailable } from "@app/core/supportMedia";
import { prisma, getTicket, addTicketMessage, ingestSupportTelegramMedia } from "@app/db";
import type { MyContext, MyConversation } from "../context";
import { consumeInput, menuAnchor } from "../util/chat";
import { t } from "../util/i18n";
import { backToMain, isPersistentLabel } from "../keyboards/customer";
import { handleProductNumber, showMainMenu } from "../handlers/customer";

/** A single reply draft can contain text and up to three verified files.
 * The domain transaction owns persistence, status changes, and notification. */
export async function ticketUserReplyConversation(conversation: MyConversation, ctx: MyContext): Promise<void> {
  const info = ctx.session.dbUser!;
  const ticketId = Number((ctx.callbackQuery?.data ?? "").split(":").at(-1));
  const ticket = await conversation.external(() => getTicket(prisma, ticketId));
  if (!ticket || ticket.userId !== info.id) {
    await ctx.answerCallbackQuery({ text: t(ctx, "error.ticket_not_found"), show_alert: true }); return;
  }
  if (ticket.status === TicketStatus.CLOSED) {
    await ctx.answerCallbackQuery({ text: t(ctx, "ticket.closed_cannot_reply"), show_alert: true }); return;
  }
  await ctx.answerCallbackQuery();
  const started = await conversation.now();
  const draftId = await conversation.external(() => randomUUID());
  const mediaEnabled = await conversation.external(() => supportMediaAvailable());
  let current = ctx;
  let body = "";
  let error = "";
  const attachments: string[] = [];
  const acceptedInputs: MyContext[] = [];
  for (;;) {
    const keyboard = new InlineKeyboard().text(t(current, "helpdesk.confirm"), "v1:support:reply:submit").row().text(t(current, "helpdesk.cancel"), `v1:ticket:view:${ticketId}`);
    const text = `${t(current, "ticket.ask_reply")}\n${mediaEnabled ? t(current, "helpdesk.ask_media") : ""}\n${t(current, "helpdesk.attachments")}: ${attachments.length}/3${body ? `\n${t(current, "helpdesk.reply_ready")}` : ""}${error ? `\n\n${error}` : ""}`;
    await menuAnchor(current, text, keyboard);
    current = await conversation.wait();
    const action = current.callbackQuery?.data;
    if (current.callbackQuery) await current.answerCallbackQuery();
    const input = current.message?.text;
    if (input && isPersistentLabel(input)) return void await handleProductNumber(current);
    if (input?.startsWith("/start") || input === "/cancel" || action === "v1:menu:main") return void await showMainMenu(current);
    if (action === `v1:ticket:view:${ticketId}`) { await menuAnchor(current, t(current, "helpdesk.cancelled"), new InlineKeyboard().text(t(current, "helpdesk.view"), action)); return; }
    if (await conversation.now() - started > 30 * 60_000) { await menuAnchor(current, t(current, "helpdesk.session_expired"), backToMain(current.session.lang)); return; }
    error = "";
    if (input) {
      if (!input.trim() || input.trim().length > 2000) { error = t(current, "helpdesk.description_quality"); continue; }
      body = input.trim(); acceptedInputs.push(current);
    } else if (current.message?.photo || current.message?.video) {
      if (!mediaEnabled || attachments.length >= 3) { error = t(current, mediaEnabled ? "web.support_attach_error_count" : "helpdesk.media_unavailable"); continue; }
      const photo = current.message.photo?.at(-1); const video = current.message.video; const media = photo ?? video!;
      try {
        const file = await current.api.getFile(media.file_id);
        const args = { ownerId: info.id, ticketId, draftId, fileId: media.file_id, filePath: file.file_path ?? "", mime: photo ? "image/jpeg" : video?.mime_type ?? "video/mp4", bytes: file.file_size ?? media.file_size ?? 0 };
        attachments.push(await conversation.external(() => ingestSupportTelegramMedia(prisma, { ...args, token: botToken() ?? "" })));
        acceptedInputs.push(current);
      } catch { error = t(current, "helpdesk.upload_failed"); }
    } else if (action === "v1:support:reply:submit") {
      if (!body && !attachments.length) { error = t(current, "helpdesk.description_quality"); continue; }
      try {
        await conversation.external(() => addTicketMessage(prisma, { ticketId, senderType: SenderType.USER, senderId: info.id, content: body, origin: "BOT", requestKey: draftId, attachmentIds: attachments }));
      } catch {
        await menuAnchor(current, t(current, "helpdesk.reply_unavailable"), new InlineKeyboard().text(t(current, "helpdesk.view"), `v1:ticket:view:${ticketId}`)); return;
      }
      for (const accepted of acceptedInputs) await consumeInput(accepted);
      await menuAnchor(current, t(current, "ticket.reply_sent"), new InlineKeyboard().text(t(current, "helpdesk.view"), `v1:ticket:view:${ticketId}`)); return;
    } else { error = t(current, "helpdesk.stale_screen"); }
  }
}
