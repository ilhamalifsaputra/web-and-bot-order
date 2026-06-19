/**
 * Shared multipart image-upload handler — CSRF + role gate + MIME + size,
 * then save the file and the setting that points at it. Used by both the
 * branding uploads (favicon/logo/hero/banner) and the payment QR upload;
 * extracted so the parsing/validation logic isn't duplicated per caller.
 */
import { mkdir, writeFile, unlink } from "node:fs/promises";
import { basename, join } from "node:path";
import { randomBytes } from "node:crypto";
import type { FastifyReply, FastifyRequest } from "fastify";
import { prisma, getSetting, setSetting, logAdminAction } from "@app/db";
import { canMutate } from "../plugins/auth";
import { redirectWithFlash } from "../flash";

export interface HandleUploadOpts {
  /** Filename prefix, e.g. "banner" → banner-<hex>.png. */
  kind: string;
  /** Multipart field name the file is expected under. */
  field: string;
  /** Allowed MIME → file extension map. */
  allowed: Record<string, string>;
  maxBytes: number;
  /** Directory the file is written into (created if missing). */
  destDir: string;
  /** Public URL prefix the saved path is built from, e.g. "/uploads/branding". */
  urlPrefix: string;
  /** Settings key the resulting URL is stored under. */
  settingKey: string;
  auditAction: string;
  /** Where to redirect on both success and failure. */
  redirectPath: string;
  afterSave?: () => Promise<void>;
}

/**
 * Sniff the real image type from a file's magic bytes (M-6). Returns a canonical
 * MIME, or null when the bytes don't look like a supported image. SVG is text
 * (no binary signature) so it's matched by a leading `<svg`/XML heuristic.
 */
function sniffImageMime(buf: Buffer): string | null {
  if (buf.length >= 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return "image/png";
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "image/jpeg";
  if (buf.length >= 12 && buf.toString("ascii", 0, 4) === "RIFF" && buf.toString("ascii", 8, 12) === "WEBP") return "image/webp";
  if (buf.length >= 4 && buf[0] === 0x00 && buf[1] === 0x00 && buf[2] === 0x01 && buf[3] === 0x00) return "image/x-icon";
  const head = buf.subarray(0, 1024).toString("utf8").trimStart().toLowerCase();
  if (head.includes("<svg")) return "image/svg+xml";
  return null;
}

/** Collapse the two icon MIME spellings so a sniffed type matches either header. */
const canonicalImageMime = (m: string): string =>
  m === "image/vnd.microsoft.icon" ? "image/x-icon" : m;

/** Shared multipart image upload: CSRF + role gate + MIME + size, then save. */
export async function handleUpload(
  req: FastifyRequest,
  reply: FastifyReply,
  opts: HandleUploadOpts,
): Promise<FastifyReply> {
  if (!canMutate(req.admin!.role, req.url)) {
    return reply.code(403).type("text/plain").send("Insufficient permissions for this action.");
  }
  let csrfField: string | null = null;
  let fileBuffer: Buffer | null = null;
  let mimetype = "";
  for await (const part of req.parts({ limits: { fileSize: opts.maxBytes } })) {
    if (part.type === "field" && part.fieldname === "csrf_token") {
      csrfField = part.value as string;
    } else if (part.type === "file" && part.fieldname === opts.field) {
      mimetype = part.mimetype;
      const chunks: Buffer[] = [];
      for await (const chunk of part.file) chunks.push(chunk);
      if (chunks.length > 0) fileBuffer = Buffer.concat(chunks);
    }
  }
  if (!csrfField || csrfField !== req.admin!.csrf) {
    return reply.code(403).type("text/plain").send("CSRF check failed");
  }
  if (!fileBuffer || fileBuffer.length === 0) {
    return redirectWithFlash(reply, opts.redirectPath, "No file selected.", "error");
  }
  const ext = opts.allowed[mimetype];
  if (!ext) {
    return redirectWithFlash(reply, opts.redirectPath, "That file type is not allowed.", "error");
  }
  // M-6: the MIME above is the client-supplied header (spoofable). Sniff the real
  // type from the file's magic bytes and require it to match the claimed type, so
  // a non-image (or a mismatched type) carrying an image header is rejected —
  // defence in depth alongside the random filename + nosniff/CSP on /uploads.
  const sniffed = sniffImageMime(fileBuffer);
  if (!sniffed || canonicalImageMime(sniffed) !== canonicalImageMime(mimetype)) {
    return redirectWithFlash(reply, opts.redirectPath, "That file type is not allowed.", "error");
  }
  const filename = `${opts.kind}-${randomBytes(8).toString("hex")}.${ext}`;
  await mkdir(opts.destDir, { recursive: true });
  await writeFile(join(opts.destDir, filename), fileBuffer);
  await deleteOldUpload(opts.urlPrefix, opts.destDir, await getSetting(prisma, opts.settingKey));
  await setSetting(prisma, opts.settingKey, `${opts.urlPrefix}/${filename}`);
  if (opts.afterSave) await opts.afterSave();
  await logAdminAction(prisma, {
    adminId: req.admin!.userId,
    action: opts.auditAction,
    targetType: "setting",
    details: `filename=${filename}`,
  });
  return redirectWithFlash(reply, opts.redirectPath, "Saved.", "success");
}

/** Delete a previous upload under `urlPrefix` (ignore legacy file_ids / missing files). */
export async function deleteOldUpload(
  urlPrefix: string,
  destDir: string,
  oldValue: string | null,
): Promise<void> {
  if (oldValue && oldValue.startsWith(`${urlPrefix}/`)) {
    await unlink(join(destDir, basename(oldValue))).catch(() => undefined);
  }
}
