/**
 * Payment-QR resolution. The `qr` setting may hold a web-admin upload path
 * (`/uploads/qr/…`, shared filesystem) or a legacy Telegram file_id (set by
 * sending a photo to the bot). Uploads are sent via InputFile and the
 * resulting file_id is cached in `qr_fileid` so the bot re-uploads at most
 * once per QR image. Twin of banner.ts.
 */
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { InputFile } from "grammy";

export const QR_KEY = "qr";
export const QR_FILEID_KEY = "qr_fileid";

// Module-relative (not cwd-relative): web-admin writes uploads under the repo's
// data/uploads, and pnpm runs the bot with cwd = the order-bot package dir, so a
// cwd-based path would look in the wrong place and the QR photo would 404.
// HERE = apps/order-bot/src/util → up 4 → <root>/data/uploads. Override via env.
const HERE = dirname(fileURLToPath(import.meta.url));
const UPLOADS_ROOT =
  process.env.UPLOADS_DIR ?? join(HERE, "..", "..", "..", "..", "data", "uploads");

export type QrValue =
  | { kind: "none" }
  | { kind: "fileId"; fileId: string }
  | { kind: "upload"; relPath: string };

export function resolveQrValue(
  qr: string | null | undefined,
  cachedFileId: string | null | undefined,
): QrValue {
  const v = (qr ?? "").trim();
  if (!v) return { kind: "none" };
  if (v.startsWith("/uploads/")) {
    const cached = (cachedFileId ?? "").trim();
    if (cached) return { kind: "fileId", fileId: cached };
    return { kind: "upload", relPath: v.replace(/^\/uploads\//, "") };
  }
  return { kind: "fileId", fileId: v };
}

/** Build the photo argument for the checkout payment screen, or undefined when no QR. */
export function qrPhotoArg(
  qr: string | null | undefined,
  cachedFileId: string | null | undefined,
): { photo: string | InputFile; needsCache: boolean } | undefined {
  const r = resolveQrValue(qr, cachedFileId);
  if (r.kind === "none") return undefined;
  if (r.kind === "fileId") return { photo: r.fileId, needsCache: false };
  return { photo: new InputFile(join(UPLOADS_ROOT, r.relPath)), needsCache: true };
}
