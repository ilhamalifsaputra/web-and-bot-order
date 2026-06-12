/**
 * Broadcast queue — the web admin ENQUEUES; the order-bot drains and sends.
 * The web never calls Telegram (WEB.md constraint). Segments resolve to the
 * recipients the bot DMs.
 */
import { OrderStatus, UserRole } from "@app/core/enums";
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

export function createBroadcast(
  db: Db,
  args: { message: string; segment: BroadcastSegment; scheduledAt: Date | null; createdById: number | null; total: number },
) {
  return db.broadcast.create({
    data: {
      message: args.message,
      segment: args.segment,
      scheduledAt: args.scheduledAt,
      createdById: args.createdById,
      totalCount: args.total,
      status: "PENDING",
    },
  });
}

export function listBroadcasts(db: Db, limit = 50) {
  return db.broadcast.findMany({ orderBy: { id: "desc" }, take: limit });
}

/** Cancel a still-PENDING broadcast. Returns true if it was cancelled. */
export async function cancelBroadcast(db: Db, id: number): Promise<boolean> {
  const res = await db.broadcast.updateMany({ where: { id, status: "PENDING" }, data: { status: "CANCELLED" } });
  return res.count > 0;
}

/**
 * Atomically claim the next due PENDING broadcast (scheduledAt null or past),
 * flipping it to SENDING so a second drainer tick can't re-send it. Returns the
 * claimed row or null. (SQLite single-writer + the status guard = no double-claim.)
 */
export async function claimNextDueBroadcast(db: Db, now: Date) {
  const next = await db.broadcast.findFirst({
    where: { status: "PENDING", OR: [{ scheduledAt: null }, { scheduledAt: { lte: now } }] },
    orderBy: { id: "asc" },
  });
  if (!next) return null;
  const res = await db.broadcast.updateMany({ where: { id: next.id, status: "PENDING" }, data: { status: "SENDING" } });
  return res.count > 0 ? next : null;
}

export async function finishBroadcast(
  db: Db,
  id: number,
  r: { sent: number; failed: number; total: number },
): Promise<void> {
  await db.broadcast.update({
    where: { id },
    data: { status: "SENT", sentCount: r.sent, failedCount: r.failed, totalCount: r.total, sentAt: new Date() },
  });
}
