import type { InlineKeyboard } from "grammy";
import { botToken } from "@app/core/runtime";
import { logger } from "@app/core/logger";
import { ValidationError } from "@app/core/errors";
import { supportMediaLimits } from "@app/core/supportMedia";
import { prisma, ingestSupportTelegramMedia, discardSupportAttachment } from "@app/db";
import type { MyContext, MyConversation } from "../context";
import { consumeInput } from "./chat";
import { t } from "./i18n";

/** Files per new ticket or per reply; the web and backend enforce the same 3. */
export const MAX_SUPPORT_MEDIA = 3;

/** An image or video sent "as a file": Telegram delivers it as a document,
 * which the support upload does not take, so the customer is asked to resend
 * it as a photo/video instead. */
export function isMediaDocument(ctx: MyContext): boolean {
  const mime = ctx.message?.document?.mime_type ?? "";
  return /^(image|video)\//.test(mime);
}

/** "✅ Photo 1  ✅ Photo 2" for the files already stored, on its own line. */
export function mediaChecklist(ctx: MyContext, count: number): string {
  if (count <= 0) return "";
  return `\n${Array.from({ length: count }, (_, index) => t(ctx, "helpdesk.media_item", { n: index + 1 })).join("  ")}`;
}

/** The "at the limit" line under the counter, shown only once all files are
 * stored; each flow passes its own wording of where the rest can go. */
export function mediaLimitHint(ctx: MyContext, mediaEnabled: boolean, count: number, key: "helpdesk.media_limit_hint" | "helpdesk.media_limit_hint_reply"): string {
  return mediaEnabled && count >= MAX_SUPPORT_MEDIA ? `\n\n${t(ctx, key)}` : "";
}

/** One "🗑 Photo/video n" button per stored file, two per row (each label
 * fits NARROW_LABEL_WIDTH), on rows of their own above the flow's buttons.
 * The label shows the current position; the callback names the file itself
 * (its attachment UUID), so a double tap can never remove a second file. */
export function addRemoveButtons(ctx: MyContext, keyboard: InlineKeyboard, attachments: readonly string[], callbackFor: (id: string) => string): InlineKeyboard {
  attachments.forEach((id, index) => {
    keyboard.text(t(ctx, "helpdesk.media_remove", { n: index + 1 }), callbackFor(id));
    if (index % 2 === 1 || index === attachments.length - 1) keyboard.row();
  });
  return keyboard;
}

/** The attachment id a remove tap names, or null when the data is not a
 * remove tap of this flow. */
export function removeTarget(data: string, prefix: string): string | null {
  if (!data.startsWith(prefix)) return null;
  const id = data.slice(prefix.length);
  return id ? id : null;
}

/** Takes the named file out of the draft and retires its stored row so the
 * cleanup job deletes the object. An id no longer in the draft (already
 * removed, stale screen) changes nothing. A failed discard never blocks the
 * customer: the unattached row expires on its own. */
export async function removeMedia(conversation: MyConversation, attachments: string[], id: string, ownerId: number): Promise<void> {
  const index = attachments.indexOf(id);
  if (index < 0) return;
  attachments.splice(index, 1);
  await conversation.external(async () => {
    try {
      await discardSupportAttachment(prisma, id, ownerId);
    } catch (err) {
      // Only the error name: a database error message could carry connection details.
      logger.warn({ attachmentId: id, errorName: errorName(err) }, "A support attachment the customer removed from a draft could not be retired now; it will still expire and be cleaned up later.");
    }
  });
}

function errorName(err: unknown): string {
  return err instanceof Error ? err.name : typeof err;
}

/** The photo (largest size) or video this message carries, with the type the
 * support upload stores it as; null when the message has neither. */
export function incomingMedia(ctx: MyContext): { fileId: string; mime: string; size?: number } | null {
  const photo = ctx.message?.photo?.at(-1);
  const video = ctx.message?.video;
  const media = photo ?? video;
  if (!media) return null;
  return { fileId: media.file_id, mime: photo ? "image/jpeg" : video?.mime_type ?? "video/mp4", size: media.file_size };
}

/** Telegram delivers an album as one update per part sharing a
 * media_group_id. Call the returned function once per incoming photo/video: it
 * is true for the 2nd and later parts of the album it saw last, which skip the
 * "uploading" edit and go straight to the counter edit. A single photo or a
 * different album resets it. */
export function albumFollowUpTracker(): (ctx: MyContext) => boolean {
  let lastAlbum: string | undefined;
  return (ctx) => {
    const group = ctx.message?.media_group_id;
    const followUp = group !== undefined && group === lastAlbum;
    lastAlbum = group;
    return followUp;
  };
}

/** Refusals that sending the same file again cannot fix: the customer sees
 * the reason instead of "please send it again". */
const FINAL_UPLOAD_ERRORS = new Set(["web.support_attach_error_size", "web.support_attach_error_type", "web.support_attach_error_count"]);

/** A photo/video that cannot be taken (media off, the draft already holds
 * the maximum, or Telegram reports it over the size limit) is unused, so it is
 * deleted and the returned text tells the customer why; this happens before
 * any "uploading" edit. Null means the photo may be uploaded. A repeat of the
 * same text re-renders as a no-op edit. */
export async function refuseAndConsumeMedia(ctx: MyContext, mediaEnabled: boolean, count: number): Promise<string | null> {
  const reason = !mediaEnabled ? "helpdesk.media_unavailable"
    : count >= MAX_SUPPORT_MEDIA ? "web.support_attach_error_count"
    : overSizeLimit(incomingMedia(ctx)) ? "web.support_attach_error_size"
    : null;
  if (!reason) return null;
  await consumeInput(ctx);
  return t(ctx, reason);
}

function overSizeLimit(media: { mime: string; size?: number } | null): boolean {
  if (!media?.size) return false;
  const limits = supportMediaLimits();
  return media.size > (media.mime.startsWith("image/") ? limits.imageBytes : limits.videoBytes);
}

/** Stores the message's photo/video for this draft, then deletes the chat
 * copy: stored in R2 or failed, either way it is no longer needed, and
 * removing it keeps the wizard/reply bubble in view. */
export async function ingestMedia(
  conversation: MyConversation,
  ctx: MyContext,
  owner: { ownerId: number; draftId: string; ticketId?: number },
): Promise<{ id: string } | { error: string }> {
  const media = incomingMedia(ctx);
  let result: { id: string } | { error: string };
  let file: Awaited<ReturnType<MyContext["api"]["getFile"]>> | undefined;
  try {
    if (!media) throw new Error("The message carries no photo or video.");
    file = await ctx.api.getFile(media.fileId);
  } catch (err) {
    // Only the stage and error name: the error text can hold the bot token or file URL.
    logger.warn({ stage: "telegram_get_file", errorName: errorName(err) }, "Telegram did not return the file details of a support photo/video, so the customer was asked to send it again.");
  }
  if (!media || !file) {
    result = { error: t(ctx, "helpdesk.upload_failed_bot") };
  } else {
    const args = { ...owner, fileId: media.fileId, filePath: file.file_path ?? "", mime: media.mime, bytes: file.file_size ?? media.size ?? 0 };
    // The outcome is folded into a plain value inside external(), so a
    // conversation replay sees the same result without rethrowing an error.
    const outcome = await conversation.external(async (): Promise<{ id: string } | { errorName: string; key?: string }> => {
      try {
        return { id: await ingestSupportTelegramMedia(prisma, { ...args, token: botToken() ?? "" }) };
      } catch (err) {
        return { errorName: errorName(err), ...(err instanceof ValidationError ? { key: err.key } : {}) };
      }
    });
    if ("id" in outcome) {
      result = { id: outcome.id };
    } else {
      logger.warn({ stage: "ingest", errorName: outcome.errorName, ...(outcome.key ? { key: outcome.key } : {}) }, "A support photo/video from Telegram could not be stored, so the customer was shown why or asked to send it again.");
      result = { error: t(ctx, outcome.key && FINAL_UPLOAD_ERRORS.has(outcome.key) ? outcome.key : "helpdesk.upload_failed_bot") };
    }
  }
  await consumeInput(ctx);
  return result;
}
