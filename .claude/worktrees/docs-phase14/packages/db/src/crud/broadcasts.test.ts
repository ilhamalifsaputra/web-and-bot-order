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
});
