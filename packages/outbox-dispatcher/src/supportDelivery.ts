import { Bot, GrammyError, InlineKeyboard, InputFile } from "grammy";
import { prisma } from "@app/db";
import { supportMediaType, supportObjectUrl } from "@app/core/supportMedia";
import { t } from "@app/core/i18n";

interface Progress { text: boolean; media: string[] }
// Preserve successful sends through a transient checkpoint-write failure.
// Restart after a lost transport acknowledgement can still duplicate a part;
// Telegram offers no transactional send-with-DB-commit operation.
const pendingProgress = new Map<number, Progress>();
let activeStreams = 0;

export async function deliverSupportReply(bot: Bot, row: { id: number; claimedAt: Date }, payload: Record<string, unknown>) {
  const ticketId = Number(payload.ticket_id); const messageId = Number(payload.message_id); const chatId = Number(payload.chat_id);
  const message = await prisma.ticketMessage.findFirst({ where: { id: messageId, ticketId, internal: false, senderType: "ADMIN" }, include: { ticket: { include: { user: { select: { telegramId: true, language: true } } } }, attachments: { where: { status: "READY", attachedAt: { not: null } }, orderBy: { createdAt: "asc" }, take: 3 } } });
  if (!message || String(message.ticket.user.telegramId) !== String(chatId)) throw new Error("Support reply recipient is no longer authorized.");
  const language = message.ticket.user.language ?? "id";
  const keyboard = new InlineKeyboard().text(t("helpdesk.view", language), `v1:ticket:view:${ticketId}`);
  const stored = payload.delivery as Progress | undefined;
  const progress = pendingProgress.get(row.id) ?? { text: stored?.text === true, media: Array.isArray(stored?.media) ? stored.media.filter((id): id is string => typeof id === "string") : [] };
  async function checkpoint() {
    pendingProgress.set(row.id, { text: progress.text, media: [...progress.media] });
    const saved = await prisma.notificationOutbox.updateMany({ where: { id: row.id, status: "SENDING", claimedAt: row.claimedAt }, data: { payloadJson: JSON.stringify({ ...payload, delivery: progress }) } });
    if (saved.count !== 1) throw new Error("Support delivery claim changed before the checkpoint was saved.");
    pendingProgress.delete(row.id);
  }
  if (pendingProgress.has(row.id)) await checkpoint();
  if (!progress.text) {
    await bot.api.sendMessage(chatId, `${t("helpdesk.reply_notice", language, { number: message.ticket.ticketNumber ?? `#${ticketId}` })}\n\n${message.content}`, { entities: [], reply_markup: keyboard });
    progress.text = true; await checkpoint();
  }
  for (const attachment of message.attachments) {
    if (progress.media.includes(attachment.id)) continue;
    const botId = bot.token?.split(":")[0];
    const send = (source: string | InputFile) => attachment.mime === "video/mp4" ? bot.api.sendVideo(chatId, source) : bot.api.sendPhoto(chatId, source);
    let sent: Awaited<ReturnType<typeof send>> | undefined;
    if (botId && attachment.telegramBotId === botId && attachment.telegramFileId) {
      try { sent = await send(attachment.telegramFileId); }
      catch (error) { if (!(error instanceof GrammyError) || error.error_code !== 400) throw error; }
    }
    if (!sent) {
      if (activeStreams >= 2) throw new Error("Support media transfer capacity is temporarily full.");
      supportMediaType(attachment.mime, attachment.bytes);
      activeStreams++;
      let response: Response | undefined;
      try {
        try { response = await fetch(await supportObjectUrl(attachment.storageKey, "GET", undefined, undefined, attachment.bucket), { headers: attachment.etag ? { "If-Match": attachment.etag } : {}, signal: AbortSignal.timeout(90_000) }); }
        catch { throw new Error("Support media storage is temporarily unavailable."); }
        if (!response.ok || !response.body || Number(response.headers.get("content-length")) !== attachment.bytes) throw new Error("Support media could not be verified for delivery.");
        const stream = response.body;
        async function* bytes() {
          const reader = stream.getReader(); let count = 0;
          try {
            for (;;) { const next = await reader.read(); if (next.done) break; count += next.value.byteLength; if (count > attachment.bytes) throw new Error("Support media exceeds its verified size."); yield next.value; }
            if (count !== attachment.bytes) throw new Error("Support media transfer ended before all bytes arrived.");
          } catch { throw new Error("Support media transfer failed."); }
          finally { await reader.cancel(); }
        }
        sent = await send(new InputFile(bytes(), attachment.filename));
      } finally { if (response?.body && !response.body.locked) await response.body.cancel().catch(() => undefined); activeStreams--; }
    }
    progress.media.push(attachment.id);
    await checkpoint();
    const fileId = "video" in sent ? sent.video.file_id : "photo" in sent ? sent.photo.at(-1)?.file_id : undefined;
    if (fileId && botId) await prisma.supportAttachment.update({ where: { id: attachment.id }, data: { telegramFileId: fileId, telegramBotId: botId } });
  }
}
