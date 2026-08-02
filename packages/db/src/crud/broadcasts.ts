/**
 * Broadcast queue — the web admin ENQUEUES; the order-bot drains and sends.
 * The web never calls Telegram (WEB.md constraint). Segments resolve to the
 * recipients the bot DMs.
 */
import { OrderStatus, UserRole, BroadcastStatus } from "@app/core/enums";
import { addDays } from "@app/core/datetime";
import type { Prisma } from "@prisma/client";
import type { Db } from "./_types";

export const BROADCAST_SEGMENTS = ["ALL", "RESELLERS", "RECENT_BUYERS"] as const;
export type BroadcastSegment = (typeof BROADCAST_SEGMENTS)[number];

export const isBroadcastSegment = (s: string): s is BroadcastSegment =>
  (BROADCAST_SEGMENTS as readonly string[]).includes(s);

const RECENT_BUYER_DAYS = 30;

/** Prisma `where` selecting the (non-banned) users a segment targets. */
function segmentWhere(segment: BroadcastSegment): Prisma.UserWhereInput {
  const base: Prisma.UserWhereInput = { banned: false, telegramId: { not: null } };
  if (segment === "RESELLERS") return { ...base, role: UserRole.RESELLER };
  if (segment === "RECENT_BUYERS") {
    return {
      ...base,
      orders: { some: { status: OrderStatus.DELIVERED, deliveredAt: { gte: addDays(new Date(), -RECENT_BUYER_DAYS) } } },
    };
  }
  return base; // ALL
}

export function countSegment(db: Db, segment: BroadcastSegment): Promise<number> {
  return db.user.count({ where: segmentWhere(segment) });
}

/** Recipients (telegram id + language) the bot drainer will DM. */
export function resolveSegmentRecipients(db: Db, segment: BroadcastSegment) {
  return db.user.findMany({
    where: segmentWhere(segment),
    select: { telegramId: true, language: true },
  });
}

/** A broadcast's segment + recipient count — just enough for an audit-log
 * `details` sentence (e.g. `Cancelled a broadcast to N recipient(s) in segment
 * "X".`) without pulling the full row (message text, image refs, etc.) into
 * a route. */
export function getBroadcast(db: Db, id: number) {
  return db.broadcast.findUnique({ where: { id }, select: { segment: true, totalCount: true } });
}

export function createBroadcast(
  db: Db,
  args: {
    message: string;
    segment: BroadcastSegment;
    scheduledAt: Date | null;
    createdById: number | null;
    total: number;
    webImageUrl?: string | null;
    status?: typeof BroadcastStatus.DRAFT | typeof BroadcastStatus.PENDING;
  },
) {
  return db.broadcast.create({
    data: {
      message: args.message,
      segment: args.segment,
      scheduledAt: args.scheduledAt,
      createdById: args.createdById,
      totalCount: args.total,
      webImageUrl: args.webImageUrl ?? null,
      status: args.status ?? BroadcastStatus.PENDING,
    },
  });
}

export function listBroadcasts(db: Db, limit = 50) {
  return db.broadcast.findMany({ orderBy: { id: "desc" }, take: limit });
}

/** Promote a DRAFT to PENDING for immediate send, clearing any stale
 *  schedule from when it was drafted. Returns false if the row wasn't a
 *  DRAFT (already queued/sent/deleted). */
export async function queueDraftBroadcast(db: Db, id: number): Promise<boolean> {
  const res = await db.broadcast.updateMany({
    where: { id, status: BroadcastStatus.DRAFT },
    data: { status: BroadcastStatus.PENDING, scheduledAt: null },
  });
  return res.count > 0;
}

/** Hard-delete a DRAFT (never sent, nothing to undo). Returns false if the
 *  row wasn't a DRAFT. */
export async function deleteBroadcast(db: Db, id: number): Promise<boolean> {
  const res = await db.broadcast.deleteMany({ where: { id, status: BroadcastStatus.DRAFT } });
  return res.count > 0;
}

/** Cancel a still-PENDING broadcast. Returns true if it was cancelled. */
export async function cancelBroadcast(db: Db, id: number): Promise<boolean> {
  const res = await db.broadcast.updateMany({ where: { id, status: BroadcastStatus.PENDING }, data: { status: BroadcastStatus.CANCELLED } });
  return res.count > 0;
}

/**
 * Atomically claim the next due PENDING broadcast (scheduledAt null or past),
 * flipping it to SENDING so a second drainer tick can't re-send it. Returns the
 * claimed row or null. (SQLite single-writer + the status guard = no double-claim.)
 */
export async function claimNextDueBroadcast(db: Db, now: Date) {
  const next = await db.broadcast.findFirst({
    where: { status: BroadcastStatus.PENDING, OR: [{ scheduledAt: null }, { scheduledAt: { lte: now } }] },
    orderBy: { id: "asc" },
  });
  if (!next) return null;
  const res = await db.broadcast.updateMany({
    where: { id: next.id, status: BroadcastStatus.PENDING },
    data: { status: BroadcastStatus.SENDING, claimedAt: now },
  });
  return res.count > 0 ? next : null;
}

/**
 * Flush the drainer's running counters mid-flight so Broadcast History's "Sent"
 * column creeps up while a long broadcast is in progress, instead of sitting at
 * 0 until `finishBroadcast` lands the final numbers at the very end.
 *
 * Deliberately the same short, guarded `updateMany` shape as `finishBroadcast`:
 * the `status: SENDING` guard means a flush that races `reapStaleBroadcasts`
 * (or any other transition off SENDING) quietly no-ops rather than writing
 * counters onto a row that has already moved on. Called every N recipients,
 * not every recipient — SQLite is single-writer and shared across processes.
 */
export async function updateBroadcastProgress(
  db: Db,
  id: number,
  r: { sent: number; failed: number },
): Promise<void> {
  await db.broadcast.updateMany({
    where: { id, status: BroadcastStatus.SENDING },
    data: { sentCount: r.sent, failedCount: r.failed },
  });
}

export async function finishBroadcast(
  db: Db,
  id: number,
  r: { sent: number; failed: number; total: number },
): Promise<void> {
  await db.broadcast.updateMany({
    where: { id, status: BroadcastStatus.SENDING },
    data: { status: BroadcastStatus.SENT, sentCount: r.sent, failedCount: r.failed, totalCount: r.total, sentAt: new Date() },
  });
}

/** Mark a SENDING row FAILED with a short reason (used for the
 *  unknown-segment early-exit in drainBroadcasts, replacing the old
 *  incorrect finishBroadcast(...,{sent:0,failed:0,total:0}) call that
 *  wrongly marked it SENT). No-op if the row already moved on from SENDING. */
export async function failBroadcast(db: Db, id: number, reason: string): Promise<void> {
  await db.broadcast.updateMany({
    where: { id, status: BroadcastStatus.SENDING },
    data: { status: BroadcastStatus.FAILED, failureReason: reason.slice(0, 500) },
  });
}

/** A SENDING row whose claim is older than this is treated as abandoned
 *  (the drainer that claimed it crashed mid-loop) — 15 min is generous
 *  headroom over the order-bot's 15s drain tick. Mirrors notifications.ts's
 *  STALE_CLAIM_MS pattern, but deliberately does NOT make the row
 *  reclaimable/retried (unlike notifications) — see reapStaleBroadcasts. */
export const BROADCAST_STALE_CLAIM_MS = 15 * 60_000;

const STALE_BROADCAST_REASON =
  "The sender process restarted mid-broadcast; no further recipients were contacted.";

/**
 * Conservative — no automatic retry (would risk duplicate-sending to
 * recipients who already received it before the crash). Flips every
 * abandoned SENDING row straight to FAILED. Returns the number reaped.
 */
export async function reapStaleBroadcasts(db: Db, now: Date): Promise<number> {
  const staleCutoff = new Date(now.getTime() - BROADCAST_STALE_CLAIM_MS);
  const res = await db.broadcast.updateMany({
    where: { status: BroadcastStatus.SENDING, claimedAt: { lt: staleCutoff } },
    data: { status: BroadcastStatus.FAILED, failureReason: STALE_BROADCAST_REASON },
  });
  return res.count;
}

/** Cache the Telegram file_id resolved for this broadcast's image after its first successful sendPhoto. */
export async function setBroadcastImageFileId(db: Db, id: number, fileId: string): Promise<void> {
  await db.broadcast.update({ where: { id }, data: { imageFileId: fileId } });
}
