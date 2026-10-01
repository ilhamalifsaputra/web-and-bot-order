/**
 * Storage-efficiency cleanup — deletes disk files and prunes DB rows that
 * grow unbounded with no retention today: sent broadcast images, closed
 * ticket evidence, terminal notification_outbox rows, expired/used password
 * reset tokens, and abandoned cart lines. Deliberately leaves the
 * ProcessedXxxTx idempotency ledgers alone (webhook-retry duplicate-payment
 * risk outweighs the disk savings). No manual VACUUM/checkpoint step —
 * Postgres autovacuums and checkpoints itself; the SQLite-era WAL checkpoint
 * this used to end with (`checkpointWal`) had no Postgres equivalent an app
 * needs to trigger, so it was removed rather than kept as a no-op.
 *
 * `runStorageCleanup` is the one entry point both the order-bot cron job and
 * the web-admin "Run cleanup now" button call, so the two paths can never
 * drift apart.
 */
import { join, basename } from "node:path";
import { unlink } from "node:fs/promises";
import { NotificationStatus, TicketStatus } from "@app/core/enums";
import type { Db } from "./_types";

const TERMINAL_OUTBOX_STATUSES: string[] = [
  NotificationStatus.SENT,
  NotificationStatus.FAILED,
  NotificationStatus.DEAD_LETTER,
];

/**
 * On-disk size, in bytes, of the Postgres database the client is connected to.
 * Feeds the web-admin Storage page's "Database" card.
 */
export async function getDatabaseSizeBytes(db: Db): Promise<number> {
  // Raw SQL because Prisma has no model for server statistics; the query takes no user input.
  const rows = await db.$queryRaw<Array<{ size: bigint | number | string }>>`
    SELECT pg_database_size(current_database())::bigint AS size
  `;
  const bytes = Number(rows[0]?.size ?? 0); // BigInt -> number is safe: a database never nears 2^53 bytes
  return Number.isFinite(bytes) ? bytes : 0;
}

/** Delete SENT/FAILED/DEAD_LETTER outbox rows older than `cutoff`. Returns the count removed. */
export async function pruneSentOutbox(db: Db, cutoff: Date): Promise<number> {
  const { count } = await db.notificationOutbox.deleteMany({
    where: { status: { in: TERMINAL_OUTBOX_STATUSES }, createdAt: { lt: cutoff } },
  });
  return count;
}

/** Delete password reset tokens that are expired or already used. Returns the count removed. */
export async function pruneExpiredPasswordResetTokens(db: Db, now: Date = new Date()): Promise<number> {
  const { count } = await db.passwordResetToken.deleteMany({
    where: { OR: [{ expiresAt: { lt: now } }, { usedAt: { not: null } }] },
  });
  return count;
}

/** Delete cart lines not added/updated since `cutoff` (abandoned carts). Returns the count removed. */
export async function pruneStaleCarts(db: Db, cutoff: Date): Promise<number> {
  const { count } = await db.cartItem.deleteMany({ where: { addedAt: { lt: cutoff } } });
  return count;
}

/** Sent broadcasts past `cutoff` that still have a web image on disk. */
export function listBroadcastsForImageCleanup(db: Db, cutoff: Date) {
  return db.broadcast.findMany({
    where: { sentAt: { lt: cutoff }, webImageUrl: { not: null } },
  });
}

/** Drop the web image reference — the Telegram `imageFileId` cache is untouched, so resends keep working. */
export async function clearBroadcastImage(db: Db, id: number): Promise<void> {
  await db.broadcast.update({ where: { id }, data: { webImageUrl: null } });
}

/** CLOSED tickets past `cutoff` that still have evidence attached (on the ticket or any of its messages). */
export function listTicketsForAttachmentCleanup(db: Db, cutoff: Date) {
  return db.supportTicket.findMany({
    where: {
      status: TicketStatus.CLOSED,
      closedAt: { lt: cutoff },
      OR: [{ attachmentUrls: { not: null } }, { messages: { some: { attachmentUrls: { not: null } } } }],
    },
    include: { messages: { where: { attachmentUrls: { not: null } } } },
  });
}

/** Null out evidence references on the ticket and every one of its messages. */
export async function clearTicketAttachments(db: Db, id: number): Promise<void> {
  await db.supportTicket.update({ where: { id }, data: { attachmentUrls: null } });
  await db.ticketMessage.updateMany({ where: { ticketId: id }, data: { attachmentUrls: null } });
}

/** Resolve a stored `/uploads/<sub>/<file>` web path to its file on disk, or null if it's not under `sub`. */
function resolveUploadPath(uploadsDir: string, sub: string, url: string): string | null {
  if (!url.startsWith(`/uploads/${sub}/`)) return null;
  return join(uploadsDir, sub, basename(url));
}

async function unlinkIfPresent(path: string): Promise<boolean> {
  try {
    await unlink(path);
    return true;
  } catch {
    return false; // already gone (ENOENT) — not fatal, this is a best-effort cleanup
  }
}

export interface StorageCleanupSummary {
  broadcastFilesDeleted: number;
  ticketFilesDeleted: number;
  outboxRowsDeleted: number;
  resetTokensDeleted: number;
  cartsDeleted: number;
}

/**
 * Run one full cleanup pass: delete eligible broadcast/ticket files off disk
 * and clear their DB references, then prune terminal outbox rows / dead
 * reset tokens / abandoned carts. Called daily by the order-bot cron
 * (`storageCleanupJob`) and on-demand by the web-admin Storage page's
 * "Run cleanup now" button — both call this same function so the two paths
 * can't drift apart.
 */
export async function runStorageCleanup(
  db: Db,
  uploadsDir: string,
  retentionDays = 30,
): Promise<StorageCleanupSummary> {
  const cutoff = new Date(Date.now() - retentionDays * 24 * 3_600_000);

  let broadcastFilesDeleted = 0;
  for (const broadcast of await listBroadcastsForImageCleanup(db, cutoff)) {
    const path = resolveUploadPath(uploadsDir, "broadcasts", broadcast.webImageUrl!);
    if (path && (await unlinkIfPresent(path))) broadcastFilesDeleted += 1;
    await clearBroadcastImage(db, broadcast.id);
  }

  let ticketFilesDeleted = 0;
  for (const ticket of await listTicketsForAttachmentCleanup(db, cutoff)) {
    const urls = [ticket.attachmentUrls, ...ticket.messages.map((m) => m.attachmentUrls)]
      .filter((u): u is string => u != null)
      .flatMap((u) => u.split(","));
    for (const url of urls) {
      const path = resolveUploadPath(uploadsDir, "tickets", url);
      if (path && (await unlinkIfPresent(path))) ticketFilesDeleted += 1;
    }
    await clearTicketAttachments(db, ticket.id);
  }

  const outboxRowsDeleted = await pruneSentOutbox(db, cutoff);
  const resetTokensDeleted = await pruneExpiredPasswordResetTokens(db);
  const cartsDeleted = await pruneStaleCarts(db, cutoff);

  return { broadcastFilesDeleted, ticketFilesDeleted, outboxRowsDeleted, resetTokensDeleted, cartsDeleted };
}
