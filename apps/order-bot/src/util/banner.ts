/**
 * Banner-image resolution. The `banner_image` setting may hold a web-admin
 * upload path (`/uploads/branding/…`, shared filesystem) or a legacy Telegram
 * file_id (set by sending a photo to the bot). Uploads are sent via InputFile
 * and the resulting file_id is cached in `banner_image_fileid` so the bot
 * re-uploads at most once per banner.
 */
import { join } from "node:path";
import { InputFile } from "grammy";

export const BANNER_IMAGE_KEY = "banner_image";
export const BANNER_FILEID_KEY = "banner_image_fileid";

const UPLOADS_ROOT = process.env.UPLOADS_DIR ?? join(process.cwd(), "data", "uploads");

export type BannerValue =
  | { kind: "none" }
  | { kind: "fileId"; fileId: string }
  | { kind: "upload"; relPath: string };

export function resolveBannerValue(
  bannerImage: string | null | undefined,
  cachedFileId: string | null | undefined,
): BannerValue {
  const v = (bannerImage ?? "").trim();
  if (!v) return { kind: "none" };
  if (v.startsWith("/uploads/")) {
    const cached = (cachedFileId ?? "").trim();
    if (cached) return { kind: "fileId", fileId: cached };
    return { kind: "upload", relPath: v.replace(/^\/uploads\//, "") };
  }
  return { kind: "fileId", fileId: v };
}

/** Build the photo argument for `renderMenu`, or undefined when no banner. */
export function bannerPhotoArg(
  bannerImage: string | null | undefined,
  cachedFileId: string | null | undefined,
): { photo: string | InputFile; needsCache: boolean } | undefined {
  const r = resolveBannerValue(bannerImage, cachedFileId);
  if (r.kind === "none") return undefined;
  if (r.kind === "fileId") return { photo: r.fileId, needsCache: false };
  return { photo: new InputFile(join(UPLOADS_ROOT, r.relPath)), needsCache: true };
}
