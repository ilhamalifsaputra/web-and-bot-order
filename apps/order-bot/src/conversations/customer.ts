import { randomUUID } from "node:crypto";
import { InlineKeyboard } from "grammy";
import { SenderType, TicketStatus } from "@app/core/enums";
import { supportMediaAvailable } from "@app/core/supportMedia";
import { prisma, getTicket, addTicketMessage } from "@app/db";
import type { MyContext, MyConversation } from "../context";
import { consumeInput, menuAnchor } from "../util/chat";
import { MAX_SUPPORT_MEDIA, addRemoveButtons, albumFollowUpTracker, incomingMedia, ingestMedia, isMediaDocument, mediaChecklist, mediaLimitHint, refuseMedia, removeIndex, removeMedia } from "../util/supportMedia";
import { t } from "../util/i18n";
import { backToMain, isPersistentLabel } from "../keyboards/customer";
import { handleProductNumber, showMainMenu } from "../handlers/customer";

/** Callback prefix of a reply bubble's "remove file n" button (0-based). */
const REMOVE = "v1:support:reply:rm:";

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
  const albumFollowUp = albumFollowUpTracker();
  // Leaving abandons the draft: the typed reply text is obsolete scratch now
  // (photos were already deleted once stored).
  const discardDraft = async () => { for (const accepted of acceptedInputs) await consumeInput(accepted); };
  for (;;) {
    const keyboard = addRemoveButtons(current, new InlineKeyboard(), attachments.length, (index) => `${REMOVE}${index}`).text(t(current, "helpdesk.confirm"), "v1:support:reply:submit").row().text(t(current, "helpdesk.cancel"), `v1:ticket:view:${ticketId}`);
    const screen = `${t(current, "ticket.ask_reply")}\n${mediaEnabled ? t(current, "helpdesk.ask_media") : ""}\n${t(current, "helpdesk.attachments")}: ${attachments.length}/${MAX_SUPPORT_MEDIA}${mediaChecklist(current, attachments.length)}${mediaLimitHint(current, mediaEnabled, attachments.length, "helpdesk.media_limit_hint_reply")}${body ? `\n${t(current, "helpdesk.reply_ready")}` : ""}`;
    await menuAnchor(current, `${screen}${error ? `\n\n${error}` : ""}`, keyboard);
    current = await conversation.wait();
    const action = current.callbackQuery?.data;
    if (current.callbackQuery) await current.answerCallbackQuery();
    const input = current.message?.text;
    if (input && isPersistentLabel(input)) return void await handleProductNumber(current);
    if (input?.startsWith("/start") || input === "/cancel" || action === "v1:menu:main") { await discardDraft(); return void await showMainMenu(current); }
    if (action === `v1:ticket:view:${ticketId}`) { await discardDraft(); await menuAnchor(current, t(current, "helpdesk.cancelled"), new InlineKeyboard().text(t(current, "helpdesk.view"), action)); return; }
    if (await conversation.now() - started > 30 * 60_000) { await menuAnchor(current, t(current, "helpdesk.session_expired"), backToMain(current.session.lang)); return; }
    error = "";
    const removing = removeIndex(action ?? "", REMOVE);
    // A stale index changes nothing; the loop re-renders the bubble either way.
    if (removing !== null) await removeMedia(conversation, attachments, removing, info.id);
    else if (input) {
      if (!input.trim() || input.trim().length > 2000) { error = t(current, "helpdesk.description_quality"); continue; }
      body = input.trim(); acceptedInputs.push(current);
    } else if (isMediaDocument(current)) { error = t(current, "helpdesk.send_as_photo");
    } else if (incomingMedia(current)) {
      const sameAlbum = albumFollowUp(current);
      const refused = await refuseMedia(current, mediaEnabled, attachments.length);
      if (refused) { error = refused; continue; }
      if (!sameAlbum) await menuAnchor(current, `${screen}\n\n${t(current, "helpdesk.uploading_bot")}`, keyboard);
      const stored = await ingestMedia(conversation, current, { ownerId: info.id, ticketId, draftId });
      if ("id" in stored) attachments.push(stored.id); else error = stored.error;
    } else if (action === "v1:support:reply:submit") {
      if (!body && !attachments.length) { error = t(current, "helpdesk.description_quality"); continue; }
      try {
        await conversation.external(() => addTicketMessage(prisma, { ticketId, senderType: SenderType.USER, senderId: info.id, content: body, origin: "BOT", requestKey: draftId, attachmentIds: attachments }));
      } catch {
        await menuAnchor(current, t(current, "helpdesk.reply_unavailable"), new InlineKeyboard().text(t(current, "helpdesk.view"), `v1:ticket:view:${ticketId}`)); return;
      }
      for (const accepted of acceptedInputs) await consumeInput(accepted);
      await menuAnchor(current, t(current, "ticket.reply_sent"), new InlineKeyboard().text(t(current, "helpdesk.view"), `v1:ticket:view:${ticketId}`)); return;
    } else { error = t(current, "error.stale_screen"); }
  }
}
