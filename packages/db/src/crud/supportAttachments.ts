import { randomUUID } from "node:crypto";
import { ValidationError } from "@app/core/errors";
import { supportMediaConfigured, resolveSupportBucket, supportMediaType, supportObjectUrl, inspectSupportObject } from "@app/core/supportMedia";
import type { Db } from "./_types";

let telegramStreams = 0;
/** Two live streams per process, with backpressure and no permanent disk writes. */
export async function ingestSupportTelegramMedia(db: Db, args: { ownerId: number; draftId: string; ticketId?: number; fileId: string; filePath: string; token: string; mime: string; bytes: number }) {
  if (telegramStreams >= 2) throw new ValidationError("helpdesk.upload_failed");
  supportMediaType(args.mime, args.bytes);
  if (!/^[a-zA-Z0-9_/.-]+$/.test(args.filePath) || args.filePath.includes("..")) throw new ValidationError("web.support_attach_error_type");
  telegramStreams++;
  let id: string | undefined;
  try {
    const upload = await createSupportUpload(db, { ownerId: args.ownerId, draftId: args.draftId, ticketId: args.ticketId, filename: `evidence.${args.mime === "video/mp4" ? "mp4" : "jpg"}`, mime: args.mime, bytes: args.bytes });
    id = upload.id;
    const source = await fetch(`https://api.telegram.org/file/bot${args.token}/${args.filePath}`, { signal: AbortSignal.timeout(90_000) });
    if (!source.ok || !source.body) throw new Error("Media source unavailable");
    let count = 0;
    const bounded = source.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({ transform(chunk, controller) { count += chunk.byteLength; if (count > args.bytes) throw new Error("Media limit exceeded"); controller.enqueue(chunk); } }));
    const result = await fetch(upload.url, { method: "PUT", headers: upload.headers, body: bounded, duplex: "half", signal: AbortSignal.timeout(90_000) } as RequestInit & { duplex: string });
    if (!result.ok || count !== args.bytes) throw new Error("Media transfer failed");
    await finalizeSupportUpload(db, id, args.ownerId);
    await db.supportAttachment.update({ where: { id }, data: { telegramFileId: args.fileId, telegramBotId: args.token.split(":")[0] } });
    return id;
  } catch {
    if (id) await db.supportAttachment.updateMany({ where: { id, attachedAt: null }, data: { status: "REJECTED", expiresAt: new Date() } });
    // Network errors may contain Telegram URLs with the bot token. Never
    // propagate that error to the logger, caller, notification, or audit.
    throw new ValidationError("helpdesk.upload_failed");
  } finally { telegramStreams--; }
}

export async function createSupportUpload(db: Db, args: { ownerId: number; draftId: string; ticketId?: number; filename: string; mime: string; bytes: number }): Promise<{ id: string; url: string; headers: { "Content-Type": string }; expires_in: number }> {
  if (!supportMediaConfigured()) throw new ValidationError("helpdesk.media_unavailable");
  const bucket = await resolveSupportBucket();
  const ext = supportMediaType(args.mime, args.bytes);
  if (!/^[a-zA-Z0-9_-]{16,100}$/.test(args.draftId)) throw new ValidationError("helpdesk.invalid_request");
  // Serialize quota checks across parallel intents from the same identity.
  if ("$transaction" in db) return db.$transaction((tx) => createSupportUpload(tx, args));
  await db.$queryRaw`SELECT id FROM users WHERE id = ${args.ownerId} FOR UPDATE`;
  const pending = await db.supportAttachment.count({ where: { ownerId: args.ownerId, attachedAt: null, status: { in: ["PENDING", "READY", "VERIFYING"] }, expiresAt: { gt: new Date() } } });
  const draftCount = await db.supportAttachment.count({ where: { ownerId: args.ownerId, draftId: args.draftId, status: { in: ["PENDING", "READY", "VERIFYING"] } } });
  if (pending >= 12 || draftCount >= 3) throw new ValidationError("web.support_attach_error_count");
  const id = randomUUID();
  const storageKey = `support/${id}.${ext}`;
  const filename = args.filename.replace(/[^\p{L}\p{N} ._-]/gu, "_").slice(0, 100) || `evidence.${ext}`;
  const row = await db.supportAttachment.create({ data: { ...args, id, filename, storageKey, bucket, expiresAt: new Date(Date.now() + 3600_000) } });
  return { id: row.id, url: await supportObjectUrl(storageKey, "PUT", args.mime, undefined, bucket), headers: { "Content-Type": args.mime }, expires_in: 180 };
}

export async function finalizeSupportUpload(db: Db, id: string, ownerId: number) {
  const row = await db.supportAttachment.findFirst({ where: { id, ownerId } });
  if (!row) throw new ValidationError("helpdesk.invalid_request");
  if (row.status === "READY") return { id, status: "READY" };
  if (row.status !== "PENDING" || row.expiresAt < new Date()) throw new ValidationError("helpdesk.media_verification_failed");
  const head = await fetch(await supportObjectUrl(row.storageKey, "HEAD", undefined, undefined, row.bucket), { method: "HEAD", signal: AbortSignal.timeout(15_000) });
  const bytes = Number(head.headers.get("content-length"));
  const mime = head.headers.get("content-type")?.split(";")[0];
  if (!head.ok || bytes !== row.bytes || mime !== row.mime) throw new ValidationError("helpdesk.media_verification_failed");
  await inspectSupportObject(row.storageKey, row.mime, bytes, head.headers.get("etag") ?? undefined, row.bucket);
  const etag = head.headers.get("etag");
  if (!etag) throw new ValidationError("helpdesk.media_verification_failed");
  // Freeze verified bytes into a key the browser was never allowed to write.
  // A presigned PUT can be replayed until expiry, so READY must never refer
  // to that mutable staging object. Conditional copy pins the inspected ETag.
  const readyKey = `support-ready/${randomUUID()}.${row.mime === "video/mp4" ? "mp4" : row.mime.split("/")[1]}`;
  // Register the destination before network I/O. A crash or failed commit
  // leaves this orphan record eligible for the existing cleanup job.
  // The ticket attachment and retirement of this record commit together.
  const orphan = await db.supportAttachment.create({ data: {
    ownerId, draftId: row.draftId, bucket: row.bucket, storageKey: readyKey,
    filename: row.filename, mime: row.mime, bytes: row.bytes,
    status: "REJECTED", expiresAt: new Date(Date.now() + 3600_000),
  } });
  const copyHeaders = { "x-amz-copy-source": `/${row.bucket}/${row.storageKey}`, "x-amz-copy-source-if-match": etag };
  const copied = await fetch(await supportObjectUrl(readyKey, "PUT", undefined, copyHeaders, row.bucket), { method: "PUT", headers: copyHeaders, signal: AbortSignal.timeout(20_000) });
  if (!copied.ok || /<(?:[\w-]+:)?Error(?:\s|>)/.test(await copied.text())) throw new ValidationError("helpdesk.media_verification_failed");
  const persist = async (tx: Db) => {
    await tx.$queryRaw`SELECT id FROM support_attachments WHERE id = ${id} FOR UPDATE`;
    const current = await tx.supportAttachment.findUnique({ where: { id } });
    if (current?.status !== "PENDING") return { count: 0 };
    // Transfer the unique key from the temporary cleanup record atomically.
    await tx.supportAttachment.delete({ where: { id: orphan.id } });
    return tx.supportAttachment.updateMany({ where: { id, status: "PENDING" }, data: { status: "READY", storageKey: readyKey, etag } });
  };
  const changed = "$transaction" in db ? await db.$transaction(persist) : await persist(db);
  if (!changed.count) {
    await fetch(await supportObjectUrl(readyKey, "DELETE", undefined, undefined, row.bucket), { method: "DELETE", signal: AbortSignal.timeout(15_000) }).catch(() => undefined);
    const current = await db.supportAttachment.findUnique({ where: { id } });
    if (current?.status !== "READY") throw new ValidationError("helpdesk.media_verification_failed");
  }
  return { id, status: "READY" };
}

/** Called inside the ticket/message transaction. Attachments cannot be stolen
 * from another draft owner, rebound, or used before actual verification. */
export async function attachSupportMedia(db: Db, ids: string[], ownerId: number, ticketId: number, messageId?: number) {
  if (!ids.length) return;
  if (ids.length > 3 || new Set(ids).size !== ids.length) throw new ValidationError("web.support_attach_error_count");
  const rows = await db.supportAttachment.findMany({ where: { id: { in: ids }, ownerId, status: "READY", attachedAt: null, expiresAt: { gt: new Date() }, OR: [{ ticketId: null }, { ticketId }] } });
  if (rows.length !== ids.length || new Set(rows.map((r) => r.draftId)).size !== 1) throw new ValidationError("helpdesk.media_verification_failed");
  for (const row of rows) {
    const changed = await db.supportAttachment.updateMany({ where: { id: row.id, ticketId: row.ticketId, attachedAt: null, status: "READY" }, data: { ticketId, messageId: messageId ?? null, attachedAt: new Date(), expiresAt: new Date("9999-01-01") } });
    if (changed.count !== 1) throw new ValidationError("helpdesk.media_verification_failed");
  }
}

export async function supportAttachmentLinks(db: Db, ticketId: number, messageId: number | null, prefix: string) {
  const rows = await db.supportAttachment.findMany({ where: { ticketId, messageId, status: "READY" } });
  return rows.map((row) => `${prefix}/${row.id}/file.${row.mime.startsWith("video/") ? "mp4" : row.mime.split("/")[1]}`);
}

export async function cleanupSupportMedia(db: Db, now = new Date()) {
  if (!supportMediaConfigured()) return { deleted: 0 };
  const days = Math.max(1, Number(process.env.SUPPORT_RETENTION_DAYS) || 90);
  const cutoff = new Date(now.getTime() - days * 86400_000);
  const eligible = { OR: [
    { attachedAt: null, expiresAt: { lt: now } },
    { ticket: { status: "CLOSED", legalHold: false, closedAt: { lt: cutoff } } },
  ] };
  const rows = await db.supportAttachment.findMany({ where: { status: { not: "DELETED" }, ...eligible }, take: 50 });
  let deleted = 0;
  for (const row of rows) {
    const claim = async (tx: Db) => {
      if (row.ticketId) await tx.$queryRaw`SELECT id FROM support_tickets WHERE id = ${row.ticketId} FOR NO KEY UPDATE`;
      return tx.supportAttachment.updateMany({ where: { id: row.id, storageKey: row.storageKey, status: { not: "DELETED" }, ...eligible }, data: { status: "DELETING" } });
    };
    const claimed = "$transaction" in db ? await db.$transaction(claim) : await claim(db);
    if (!claimed.count) continue;
    try {
      const result = await fetch(await supportObjectUrl(row.storageKey, "DELETE", undefined, undefined, row.bucket), { method: "DELETE", signal: AbortSignal.timeout(15_000) });
      if (!result.ok && result.status !== 404) continue;
      await db.supportAttachment.updateMany({ where: { id: row.id, status: "DELETING" }, data: { status: "DELETED", deletedAt: now } });
      deleted++;
    } catch {
      // Keep the claim for a bounded retry next cycle. Reopen/hold cannot
      // promise preservation while a storage deletion is already in flight.
    }
  }
  return { deleted };
}
