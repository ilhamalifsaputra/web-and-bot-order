import { botToken } from "@app/core/runtime";
import { prisma, ingestSupportTelegramMedia } from "@app/db";
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

/** The photo (largest size) or video this message carries, with the type the
 * support upload stores it as; null when the message has neither. */
export function incomingMedia(ctx: MyContext): { fileId: string; mime: string; size?: number } | null {
  const photo = ctx.message?.photo?.at(-1);
  const video = ctx.message?.video;
  const media = photo ?? video;
  if (!media) return null;
  return { fileId: media.file_id, mime: photo ? "image/jpeg" : video?.mime_type ?? "video/mp4", size: media.file_size };
}

/** Over the limit (or media off): the photo is unused, so it is deleted and
 * the returned text tells the customer why. Null means the photo may be
 * uploaded. A repeat of the same text re-renders as a no-op edit. */
export async function refuseMedia(ctx: MyContext, mediaEnabled: boolean, count: number): Promise<string | null> {
  if (mediaEnabled && count < MAX_SUPPORT_MEDIA) return null;
  await consumeInput(ctx);
  return t(ctx, mediaEnabled ? "web.support_attach_error_count" : "helpdesk.media_unavailable");
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
  try {
    if (!media) throw new Error("The message carries no photo or video.");
    const file = await ctx.api.getFile(media.fileId);
    const args = { ...owner, fileId: media.fileId, filePath: file.file_path ?? "", mime: media.mime, bytes: file.file_size ?? media.size ?? 0 };
    result = { id: await conversation.external(async () => ingestSupportTelegramMedia(prisma, { ...args, token: botToken() ?? "" })) };
  } catch {
    result = { error: t(ctx, "helpdesk.upload_failed_bot") };
  }
  await consumeInput(ctx);
  return result;
}
