import type { MyContext } from "../context";
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
