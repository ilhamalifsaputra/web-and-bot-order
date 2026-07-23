import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { makeTestDb, type TestDb } from "../../../../tests/helpers/testdb";
import {
  countSegment,
  resolveSegmentRecipients,
  createBroadcast,
  claimNextDueBroadcast,
  finishBroadcast,
  cancelBroadcast,
  setBroadcastImageFileId,
  queueDraftBroadcast,
  deleteBroadcast,
  reapStaleBroadcasts,
  failBroadcast,
} from "./broadcasts";

let db: TestDb;
let prisma: PrismaClient;

beforeAll(async () => {
  db = await makeTestDb();
  prisma = db.prisma;
});
afterAll(async () => {
  await db.cleanup();
});

let resellerId: number;
let buyerId: number;
beforeEach(async () => {
  await prisma.broadcast.deleteMany();
  await prisma.order.deleteMany();
  await prisma.user.deleteMany();
  const mk = (over: Record<string, unknown>) =>
    prisma.user.create({
      data: { telegramId: BigInt(Math.floor(Math.random() * 1e15)), referralCode: `r${Math.random()}`, ...over },
    });
  const reseller = await mk({ role: "RESELLER" });
  const buyer = await mk({ role: "CUSTOMER" });
  await mk({ role: "CUSTOMER" }); // plain
  await mk({ role: "CUSTOMER", banned: true }); // excluded everywhere
  resellerId = reseller.id;
  buyerId = buyer.id;
  // Give `buyer` a recent delivered order.
  await prisma.order.create({
    data: {
      orderCode: `ORD-${Math.random()}`, userId: buyer.id,
      subtotalAmount: "5", totalAmount: "5", status: "DELIVERED", deliveredAt: new Date(),
    },
  });
});

describe("broadcast segments", () => {
  it("ALL excludes banned; RESELLERS and RECENT_BUYERS are narrower", async () => {
    expect(await countSegment(prisma, "ALL")).toBe(3); // 4 users, 1 banned
    expect(await countSegment(prisma, "RESELLERS")).toBe(1);
    expect(await countSegment(prisma, "RECENT_BUYERS")).toBe(1);
    const resellers = await resolveSegmentRecipients(prisma, "RESELLERS");
    expect(resellers.length).toBe(1);
    const buyers = await resolveSegmentRecipients(prisma, "RECENT_BUYERS");
    expect(buyers.length).toBe(1);
  });

  it("RECENT_BUYERS ignores an old delivered order", async () => {
    await prisma.order.create({
      data: {
        orderCode: `ORD-old-${Math.random()}`, userId: resellerId,
        subtotalAmount: "5", totalAmount: "5", status: "DELIVERED",
        deliveredAt: new Date(Date.now() - 60 * 24 * 3600_000), // 60 days ago
      },
    });
    expect(await countSegment(prisma, "RECENT_BUYERS")).toBe(1); // still just `buyer`
  });

  it("excludes web-only accounts (no telegramId) from every segment", async () => {
    await prisma.user.create({
      data: { telegramId: null, loginUsername: "webonly", email: "w@o.test", referralCode: "WEBONL" },
    });
    const all = await resolveSegmentRecipients(prisma, "ALL");
    expect(all.every((r) => r.telegramId !== null)).toBe(true);
  });
});

describe("broadcast queue lifecycle", () => {
  const make = (over: Record<string, unknown> = {}) =>
    createBroadcast(prisma, { message: "hi", segment: "ALL", scheduledAt: null, createdById: null, total: 3, ...over });

  it("claims a due broadcast once, flips it to SENDING, then finishes", async () => {
    const bc = await make();
    const claimed = await claimNextDueBroadcast(prisma, new Date());
    expect(claimed!.id).toBe(bc.id);
    expect((await prisma.broadcast.findUnique({ where: { id: bc.id } }))!.status).toBe("SENDING");
    // No second PENDING → nothing more to claim.
    expect(await claimNextDueBroadcast(prisma, new Date())).toBeNull();

    await finishBroadcast(prisma, bc.id, { sent: 2, failed: 1, total: 3 });
    const done = (await prisma.broadcast.findUnique({ where: { id: bc.id } }))!;
    expect(done.status).toBe("SENT");
    expect(done.sentCount).toBe(2);
    expect(done.failedCount).toBe(1);
  });

  it("does not claim a future-scheduled broadcast", async () => {
    await make({ scheduledAt: new Date(Date.now() + 3600_000) });
    expect(await claimNextDueBroadcast(prisma, new Date())).toBeNull();
  });

  it("cancels a PENDING broadcast but not one already SENDING", async () => {
    const bc = await make();
    expect(await cancelBroadcast(prisma, bc.id)).toBe(true);
    expect((await prisma.broadcast.findUnique({ where: { id: bc.id } }))!.status).toBe("CANCELLED");
    const bc2 = await make();
    await claimNextDueBroadcast(prisma, new Date()); // → SENDING
    expect(await cancelBroadcast(prisma, bc2.id)).toBe(false);
  });

  it("persists an optional webImageUrl, defaulting to null when omitted", async () => {
    const withImage = await make({ webImageUrl: "/uploads/broadcasts/broadcast-abc123.jpg" });
    expect(withImage.webImageUrl).toBe("/uploads/broadcasts/broadcast-abc123.jpg");
    expect(withImage.imageFileId).toBeNull();

    const withoutImage = await make();
    expect(withoutImage.webImageUrl).toBeNull();
  });

  it("caches a broadcast's image file_id without touching other fields", async () => {
    const bc = await make({ webImageUrl: "/uploads/broadcasts/broadcast-abc123.jpg" });
    await setBroadcastImageFileId(prisma, bc.id, "AgAC123fileid");
    const updated = (await prisma.broadcast.findUnique({ where: { id: bc.id } }))!;
    expect(updated.imageFileId).toBe("AgAC123fileid");
    expect(updated.webImageUrl).toBe("/uploads/broadcasts/broadcast-abc123.jpg");
    expect(updated.status).toBe("PENDING");
  });

  it("finishBroadcast is unaffected by a broadcast having an image", async () => {
    const bc = await make({ webImageUrl: "/uploads/broadcasts/broadcast-abc123.jpg" });
    await claimNextDueBroadcast(prisma, new Date());
    await finishBroadcast(prisma, bc.id, { sent: 3, failed: 0, total: 3 });
    const done = (await prisma.broadcast.findUnique({ where: { id: bc.id } }))!;
    expect(done.status).toBe("SENT");
    expect(done.sentCount).toBe(3);
    expect(done.webImageUrl).toBe("/uploads/broadcasts/broadcast-abc123.jpg");
  });
});

describe("broadcast draft/failed lifecycle", () => {
  const make = (over: Record<string, unknown> = {}) =>
    createBroadcast(prisma, { message: "hi", segment: "ALL", scheduledAt: null, createdById: null, total: 3, ...over });

  it("a DRAFT is never auto-picked-up by claimNextDueBroadcast", async () => {
    const bc = await make({ status: "DRAFT" });
    expect(bc.status).toBe("DRAFT");
    expect(await claimNextDueBroadcast(prisma, new Date())).toBeNull();
  });

  it("queueDraftBroadcast promotes a DRAFT to PENDING and clears its schedule", async () => {
    const bc = await make({ status: "DRAFT", scheduledAt: new Date(Date.now() - 3600_000) });
    expect(await queueDraftBroadcast(prisma, bc.id)).toBe(true);
    const updated = (await prisma.broadcast.findUnique({ where: { id: bc.id } }))!;
    expect(updated.status).toBe("PENDING");
    expect(updated.scheduledAt).toBeNull();
  });

  it("queueDraftBroadcast returns false on a non-draft", async () => {
    const bc = await make();
    expect(await queueDraftBroadcast(prisma, bc.id)).toBe(false);
    expect((await prisma.broadcast.findUnique({ where: { id: bc.id } }))!.status).toBe("PENDING");
  });

  it("deleteBroadcast hard-deletes a DRAFT", async () => {
    const bc = await make({ status: "DRAFT" });
    expect(await deleteBroadcast(prisma, bc.id)).toBe(true);
    expect(await prisma.broadcast.findUnique({ where: { id: bc.id } })).toBeNull();
  });

  it("deleteBroadcast returns false on a non-draft", async () => {
    const bc = await make();
    expect(await deleteBroadcast(prisma, bc.id)).toBe(false);
    expect(await prisma.broadcast.findUnique({ where: { id: bc.id } })).not.toBeNull();
  });

  it("finishBroadcast no longer clobbers a non-SENDING row", async () => {
    const bc = await make(); // stays PENDING, never claimed
    await finishBroadcast(prisma, bc.id, { sent: 1, failed: 0, total: 1 });
    expect((await prisma.broadcast.findUnique({ where: { id: bc.id } }))!.status).toBe("PENDING");
  });

  it("reapStaleBroadcasts flips only abandoned SENDING rows to FAILED", async () => {
    const bc1 = await make();
    const bc2 = await make();
    await claimNextDueBroadcast(prisma, new Date());
    await claimNextDueBroadcast(prisma, new Date());
    await prisma.broadcast.update({
      where: { id: bc1.id },
      data: { claimedAt: new Date(Date.now() - 20 * 60_000) },
    });
    const reaped = await reapStaleBroadcasts(prisma, new Date());
    expect(reaped).toBe(1);
    const stale = (await prisma.broadcast.findUnique({ where: { id: bc1.id } }))!;
    expect(stale.status).toBe("FAILED");
    expect(stale.failureReason).toBeTruthy();
    const fresh = (await prisma.broadcast.findUnique({ where: { id: bc2.id } }))!;
    expect(fresh.status).toBe("SENDING");
  });

  it("failBroadcast marks a SENDING row FAILED but cannot clobber an already-finished row", async () => {
    const bc = await make();
    await claimNextDueBroadcast(prisma, new Date());
    await failBroadcast(prisma, bc.id, "unknown segment");
    const failed = (await prisma.broadcast.findUnique({ where: { id: bc.id } }))!;
    expect(failed.status).toBe("FAILED");
    expect(failed.failureReason).toBe("unknown segment");

    const bc2 = await make();
    await claimNextDueBroadcast(prisma, new Date());
    await finishBroadcast(prisma, bc2.id, { sent: 3, failed: 0, total: 3 });
    await failBroadcast(prisma, bc2.id, "should not apply");
    expect((await prisma.broadcast.findUnique({ where: { id: bc2.id } }))!.status).toBe("SENT");
  });
});
