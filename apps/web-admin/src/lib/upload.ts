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
import { sniffImageMime, canonicalImageMime } from "@app/core/media";
import { canMutate } from "../plugins/auth";
import { deleteWebpVariants, isConvertible, tryGenerateWebpVariants } from "./webpVariants";

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
  /** Settings key the resulting URL is stored under. Omit when the URL is persisted elsewhere (see `afterSave`). */
  settingKey?: string;
  /** Alternate source for the "delete previous upload" lookup when there's no `settingKey`. */
  getOldUrl?: () => Promise<string | null>;
  /** Audit log target; defaults to `{ type: "setting" }` (today's behavior) when omitted. */
  auditTarget?: { type: string; id?: number };
  auditAction: string;
  /** Natural-language audit `details` sentence for the saved filename. */
  details: (filename: string) => string;
  afterSave?: (url: string) => Promise<void>;
  /**
   * Widths to build WebP siblings at, for images the storefront renders in an
   * <img>. The uploaded file itself is left untouched — see webpVariants.ts for
   * why that matters (the bot re-uploads these same files to Telegram).
   * Omit for Telegram-only images (banner, broadcast), for the payment QR
   * (must stay pixel-crisp to scan), and for the favicon.
   */
  webVariants?: number[];
}

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
      // busboy truncates the stream at maxBytes rather than erroring inline; if we
      // don't catch it here, @fastify/multipart only surfaces the failure as an
      // uncaught RequestFileTooLargeError on the *next* req.parts() iteration,
      // which the app's blanket error handler turns into a bare 500.
      if (part.file.truncated) {
        const maxMb = (opts.maxBytes / (1024 * 1024)).toFixed(1).replace(/\.0$/, "");
        return reply.code(400).type("text/plain").send(`That file is too large (max ${maxMb}MB).`);
      }
      if (chunks.length > 0) fileBuffer = Buffer.concat(chunks);
    }
  }
  if (!csrfField || csrfField !== req.admin!.csrf) {
    return reply.code(403).type("text/plain").send("CSRF check failed");
  }
  if (!fileBuffer || fileBuffer.length === 0) {
    return reply.code(400).type("text/plain").send("No file selected.");
  }
  const ext = opts.allowed[mimetype];
  if (!ext) {
    return reply.code(400).type("text/plain").send("That file type is not allowed.");
  }
  // M-6: the MIME above is the client-supplied header (spoofable). Sniff the real
  // type from the file's magic bytes and require it to match the claimed type, so
  // a non-image (or a mismatched type) carrying an image header is rejected —
  // defence in depth alongside the random filename + nosniff/CSP on /uploads.
  const sniffed = sniffImageMime(fileBuffer);
  if (!sniffed || canonicalImageMime(sniffed) !== canonicalImageMime(mimetype)) {
    return reply.code(400).type("text/plain").send("That file type is not allowed.");
  }
  const filename = `${opts.kind}-${randomBytes(8).toString("hex")}.${ext}`;
  const url = `${opts.urlPrefix}/${filename}`;
  const oldValue = opts.settingKey
    ? await getSetting(prisma, opts.settingKey)
    : opts.getOldUrl
      ? await opts.getOldUrl()
      : null;
  await deleteOldUpload(opts.urlPrefix, opts.destDir, oldValue, opts.webVariants);
  await mkdir(opts.destDir, { recursive: true });
  await writeFile(join(opts.destDir, filename), fileBuffer);
  if (opts.settingKey) await setSetting(prisma, opts.settingKey, url);
  if (opts.afterSave) await opts.afterSave(url);
  await logAdminAction(prisma, {
    adminId: req.admin!.userId,
    action: opts.auditAction,
    targetType: opts.auditTarget?.type ?? "setting",
    targetId: opts.auditTarget?.id,
    details: opts.details(filename),
  });
  // Best-effort and self-logging (tryGenerateWebpVariants never throws), and the
  // original is already safely on disk — no reason to make the admin's Save
  // button wait through up to 3 sequential sharp resize/encode passes.
  if (opts.webVariants && isConvertible(filename)) {
    void tryGenerateWebpVariants(opts.destDir, filename, opts.webVariants);
  }
  return reply.code(200).send({ url });
}

/** Delete a previous upload under `urlPrefix` (ignore legacy file_ids / missing files). */
export async function deleteOldUpload(
  urlPrefix: string,
  destDir: string,
  oldValue: string | null,
  webVariants?: number[],
): Promise<void> {
  if (oldValue && oldValue.startsWith(`${urlPrefix}/`)) {
    const filename = basename(oldValue);
    await unlink(join(destDir, filename)).catch(() => undefined);
    // The WebP siblings would otherwise outlive the image they were made from.
    if (webVariants) await deleteWebpVariants(destDir, filename, webVariants);
  }
}
