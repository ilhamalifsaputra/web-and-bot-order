/**
 * Multipart parsing + validation for support-ticket evidence uploads
 * (image/video) — the storefront's only multipart route today, so this is
 * a small dedicated helper rather than a reuse of web-admin's single-file,
 * settings-key-oriented `handleUpload` (apps/web-admin/src/lib/upload.ts).
 * Files are saved under UPLOADS_DIR/tickets and served back at
 * /uploads/tickets/... (that static mount + its nosniff/CSP headers already
 * exist in server.ts).
 *
 * Images are verified against their magic bytes (packages/core/src/media.ts,
 * shared with web-admin's upload handler). Video containers are trusted by
 * declared MIME + extension only — full container-format sniffing (mp4/webm/
 * mov all differ) was judged not worth the complexity given the nosniff/CSP
 * headers on /uploads/ already prevent MIME-confusion execution.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import type { FastifyRequest } from "fastify";
import { ValidationError } from "@app/core/errors";
import { sniffImageMime, canonicalImageMime } from "@app/core/media";

const HERE = dirname(fileURLToPath(import.meta.url));
const UPLOADS_DIR = process.env.UPLOADS_DIR ?? join(HERE, "..", "..", "..", "..", "data", "uploads");
const TICKET_DIR = join(UPLOADS_DIR, "tickets");
const TICKET_URL_PREFIX = "/uploads/tickets";

const IMAGE_MIME: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
};
const VIDEO_MIME: Record<string, string> = {
  "video/mp4": "mp4",
  "video/webm": "webm",
  "video/quicktime": "mov",
};

export const MAX_TICKET_ATTACHMENTS = 3;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_VIDEO_BYTES = 20 * 1024 * 1024;
const MAX_MESSAGE_LENGTH = 2000;

/** Exported for tests only, to check the upload directory is clean after a
 * request whose ticket/reply never gets created (M-18 regression guard). */
export { TICKET_DIR };

/** A validated attachment held in memory — not yet written to disk. Kept
 * separate from `TicketSubmission.message`/`orderCode` (which the route
 * handler validates BEFORE anything is written — see `writeAttachments`). */
export interface ParsedAttachment {
  buffer: Buffer;
  ext: string;
}

export interface TicketSubmission {
  message: string;
  attachments: ParsedAttachment[];
  orderCode: string | null;
}

/** Batas parser tetap memakai pesan validasi lampiran yang dipahami klien. */
async function* ticketParts(req: FastifyRequest) {
  try {
    yield* req.parts({ limits: { fileSize: MAX_VIDEO_BYTES, files: MAX_TICKET_ATTACHMENTS, fields: 8, parts: 11, fieldSize: 8192 } });
  } catch (error) {
    const code = error instanceof Error && "code" in error ? error.code : undefined;
    if (code === "FST_FILES_LIMIT") throw new ValidationError("web.support_attach_error_count");
    if (code === "FST_REQ_FILE_TOO_LARGE") throw new ValidationError("web.support_attach_error_size");
    throw error;
  }
}

/**
 * Reads a `message` text field plus up to `MAX_TICKET_ATTACHMENTS` `attachments`
 * file parts off a multipart request. Throws `ValidationError` (i18n key,
 * caught by the route the same way other validation failures are) on a bad
 * file type, an oversized file, or too many files.
 *
 * Deliberately does NOT write anything to disk (M-18 fix, backend audit
 * 2026-07-31): each part is buffered in memory and validated (magic-byte
 * sniff, size cap) here, but the actual `writeFile` is deferred to
 * `writeAttachments`, which the route calls only after its own validation
 * (order ownership, the `message`/attachment-required guard) has passed.
 * Before this fix, a request with an empty message and several attachments
 * would write every file to disk during parsing, then discard them with no
 * ticket ever created — orphaned files `storageCleanupJob` can never reclaim
 * since it prunes by joined ticket rows.
 */
export async function parseTicketMultipart(req: FastifyRequest): Promise<TicketSubmission> {
  let message = "";
  let orderCode = "";
  const attachments: ParsedAttachment[] = [];
  let fileCount = 0;
  for await (const part of ticketParts(req)) {
    if (part.type === "field" && part.fieldname === "message") {
      message = String(part.value ?? "");
      continue;
    }
    if (part.type === "field" && part.fieldname === "order_code") {
      orderCode = String(part.value ?? "");
      continue;
    }
    if (part.type !== "file") continue;
    if (part.fieldname !== "attachments") {
      part.file.resume();
      continue;
    }
    fileCount += 1;
    if (fileCount > MAX_TICKET_ATTACHMENTS) {
      part.file.resume();
      throw new ValidationError("web.support_attach_error_count");
    }
    const mimetype = part.mimetype;
    const chunks: Buffer[] = [];
    for await (const chunk of part.file) chunks.push(chunk);
    if (part.file.truncated) throw new ValidationError("web.support_attach_error_size");
    const buffer = Buffer.concat(chunks);
    if (buffer.length === 0) continue; // an <input> with no file chosen still sends an empty part
    attachments.push(await validateAttachment(buffer, mimetype));
  }
  return {
    message: message.trim().slice(0, MAX_MESSAGE_LENGTH),
    attachments,
    orderCode: orderCode.trim() || null,
  };
}

export interface NewTicketSubmission {
  subject: string;
  category: string;
  productId: string;
  description: string;
  attachments: ParsedAttachment[];
  orderCode: string | null;
}

/**
 * Multipart reader for the /help create-ticket form (POST
 * /account/support/new, Task 11). Same file-part handling as
 * `parseTicketMultipart` — up to `MAX_TICKET_ATTACHMENTS` `attachments`
 * parts, each buffered + validated (magic-byte sniff, size cap) in memory
 * and NEVER written to disk here (M-18: the route calls `writeAttachments`
 * only after its own validation passes) — but it reads the /help form's
 * richer text fields instead of the legacy single `message`: `subject`,
 * `category`, `product_id`, `description` (the body text — this form names it
 * `description`, not `message`), and the optional `order_code`. Field-level
 * validation (required / length / enum / product existence) is the route's
 * job, not this parser's: it only returns the raw values (trimmed, and
 * `description` capped at `MAX_MESSAGE_LENGTH`, mirroring
 * `parseTicketMultipart`'s own `message` handling).
 *
 * A DEDICATED function rather than an extension of `parseTicketMultipart`:
 * that helper is shared by the legacy POST /account/support route AND the
 * reply route, both of which must keep byte-identical behavior — so it is
 * left completely untouched.
 */
export async function parseNewTicketMultipart(req: FastifyRequest): Promise<NewTicketSubmission> {
  let subject = "";
  let category = "";
  let productId = "";
  let description = "";
  let orderCode = "";
  const attachments: ParsedAttachment[] = [];
  let fileCount = 0;
  for await (const part of ticketParts(req)) {
    if (part.type === "field") {
      if (part.fieldname === "subject") subject = String(part.value ?? "");
      else if (part.fieldname === "category") category = String(part.value ?? "");
      else if (part.fieldname === "product_id") productId = String(part.value ?? "");
      else if (part.fieldname === "description") description = String(part.value ?? "");
      else if (part.fieldname === "order_code") orderCode = String(part.value ?? "");
      continue;
    }
    if (part.type !== "file") continue;
    if (part.fieldname !== "attachments") {
      part.file.resume();
      continue;
    }
    fileCount += 1;
    if (fileCount > MAX_TICKET_ATTACHMENTS) {
      part.file.resume();
      throw new ValidationError("web.support_attach_error_count");
    }
    const mimetype = part.mimetype;
    const chunks: Buffer[] = [];
    for await (const chunk of part.file) chunks.push(chunk);
    if (part.file.truncated) throw new ValidationError("web.support_attach_error_size");
    const buffer = Buffer.concat(chunks);
    if (buffer.length === 0) continue; // an <input> with no file chosen still sends an empty part
    attachments.push(await validateAttachment(buffer, mimetype));
  }
  return {
    subject: subject.trim(),
    category: category.trim(),
    productId: productId.trim(),
    description: description.trim().slice(0, MAX_MESSAGE_LENGTH),
    attachments,
    orderCode: orderCode.trim() || null,
  };
}

/** Validates a buffered attachment (magic-byte sniff for images, size caps)
 * without touching disk — returns the buffer + resolved extension for
 * `writeAttachments` to persist later, once the caller's own validation has
 * passed. */
async function validateAttachment(buffer: Buffer, mimetype: string): Promise<ParsedAttachment> {
  const imageExt = IMAGE_MIME[mimetype];
  if (imageExt) {
    if (buffer.length > MAX_IMAGE_BYTES) throw new ValidationError("web.support_attach_error_size");
    const sniffed = sniffImageMime(buffer);
    if (!sniffed || canonicalImageMime(sniffed) !== canonicalImageMime(mimetype)) {
      throw new ValidationError("web.support_attach_error_type");
    }
    return { buffer, ext: imageExt };
  }
  const videoExt = VIDEO_MIME[mimetype];
  if (videoExt) {
    if (buffer.length > MAX_VIDEO_BYTES) throw new ValidationError("web.support_attach_error_size");
    return { buffer, ext: videoExt };
  }
  throw new ValidationError("web.support_attach_error_type");
}

async function writeAttachment(buffer: Buffer, ext: string): Promise<string> {
  const filename = `evidence-${randomBytes(16).toString("hex")}.${ext}`;
  await mkdir(TICKET_DIR, { recursive: true });
  await writeFile(join(TICKET_DIR, filename), buffer);
  return `${TICKET_URL_PREFIX}/${filename}`;
}

/**
 * Persists already-validated attachments to disk and returns the joined
 * `attachmentUrls` string (or `null` when there are none) — the shape
 * `createTicket`/`addTicketMessage` expect. Callers MUST only invoke this
 * after every other validation for the request has passed (order ownership,
 * non-empty message): this is the one place bytes actually hit disk, so
 * calling it any earlier reintroduces the M-18 orphaned-file bug.
 */
export async function writeAttachments(attachments: ParsedAttachment[]): Promise<string | null> {
  if (attachments.length === 0) return null;
  const urls = await Promise.all(attachments.map((a) => writeAttachment(a.buffer, a.ext)));
  return urls.join(",");
}
