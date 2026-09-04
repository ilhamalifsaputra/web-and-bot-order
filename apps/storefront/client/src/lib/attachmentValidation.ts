/**
 * Shared client-side attachment rules for the support-ticket forms. Used by
 * AttachmentPicker.tsx and, in a later task, a second uploader component —
 * both need identical count/type/size rules, so the rules live here once.
 *
 * Client-side checks mirror the server's (apps/storefront/src/lib/
 * ticketAttachments.ts) but are defense-in-depth only — the server is the
 * real gate.
 */
export const MAX_TICKET_ATTACHMENTS = 3;
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
export const MAX_VIDEO_BYTES = 20 * 1024 * 1024;
export const IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);
export const VIDEO_TYPES = new Set(["video/mp4", "video/webm", "video/quicktime"]);

export interface ValidateNewFilesResult {
  accepted: File[];
  errorKey: string | null;
}

/**
 * Applies the count/type/size rules to `incoming` files against the
 * `current` staged list, in the same order as the original inline loop:
 * count limit first (breaks out of the loop — no more files considered),
 * then type, then size (both of which reject just that file and continue
 * to the next one). Returns the files that passed and the FIRST error key
 * encountered, or null if every incoming file was accepted.
 */
export function validateNewFiles(current: File[], incoming: File[]): ValidateNewFilesResult {
  const accepted: File[] = [];
  let errorKey: string | null = null;
  const next = [...current];

  for (const file of incoming) {
    if (next.length >= MAX_TICKET_ATTACHMENTS) {
      errorKey ??= "web.support_attach_error_count";
      break;
    }
    const isImage = IMAGE_TYPES.has(file.type);
    const isVideo = VIDEO_TYPES.has(file.type);
    if (!isImage && !isVideo) {
      errorKey ??= "web.support_attach_error_type";
      continue;
    }
    if ((isImage && file.size > MAX_IMAGE_BYTES) || (isVideo && file.size > MAX_VIDEO_BYTES)) {
      errorKey ??= "web.support_attach_error_size";
      continue;
    }
    next.push(file);
    accepted.push(file);
  }

  return { accepted, errorKey };
}
