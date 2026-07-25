/**
 * Audit log filtering — targetId addition (Support/Tickets redesign, Task 2).
 * `targetId` is a strictly-additive AuditFilter field: every existing caller
 * omits it and must see unfiltered-by-target behavior exactly as before.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { makeTestDb, type TestDb } from "../../../../tests/helpers/testdb";
import { logAdminAction, listAuditLogs, countAuditLogs } from "./audit";

let db: TestDb;
let prisma: PrismaClient;

beforeAll(async () => {
  db = await makeTestDb();
  prisma = db.prisma;
});
afterAll(async () => {
  await db.cleanup();
});
beforeEach(async () => {
  await prisma.auditLog.deleteMany();
  await prisma.user.deleteMany();
});

async function makeAdmin() {
  return prisma.user.create({ data: { referralCode: `a${Math.random()}`, role: "ADMIN" } });
}

describe("AuditFilter.targetId", () => {
  it("narrows results to a single targetType+targetId combination", async () => {
    const admin = await makeAdmin();
    await logAdminAction(db.prisma, {
      adminId: admin.id,
      action: "ticket.close",
      targetType: "SupportTicket",
      targetId: 1,
    });
    await logAdminAction(db.prisma, {
      adminId: admin.id,
      action: "ticket.reply",
      targetType: "SupportTicket",
      targetId: 2,
    });
    // Same targetId, different targetType — must not be conflated with
    // SupportTicket #1.
    await logAdminAction(db.prisma, {
      adminId: admin.id,
      action: "order.cancel",
      targetType: "Order",
      targetId: 1,
    });

    const filtered = await listAuditLogs(prisma, { targetType: "SupportTicket", targetId: 1 });
    expect(filtered).toHaveLength(1);
    expect(filtered[0]!.action).toBe("ticket.close");

    expect(await countAuditLogs(prisma, { targetType: "SupportTicket", targetId: 1 })).toBe(1);
  });

  it("targetId alone (no targetType) matches across target types", async () => {
    const admin = await makeAdmin();
    await logAdminAction(db.prisma, { adminId: admin.id, action: "ticket.close", targetType: "SupportTicket", targetId: 7 });
    await logAdminAction(db.prisma, { adminId: admin.id, action: "order.cancel", targetType: "Order", targetId: 7 });
    await logAdminAction(db.prisma, { adminId: admin.id, action: "order.cancel", targetType: "Order", targetId: 8 });

    expect(await countAuditLogs(prisma, { targetId: 7 })).toBe(2);
  });

  it("omitting targetId returns the old unfiltered-by-target behavior (existing callers unaffected)", async () => {
    const admin = await makeAdmin();
    await logAdminAction(db.prisma, { adminId: admin.id, action: "ticket.close", targetType: "SupportTicket", targetId: 1 });
    await logAdminAction(db.prisma, { adminId: admin.id, action: "order.cancel", targetType: "Order", targetId: 2 });
    await logAdminAction(db.prisma, { adminId: admin.id, action: "voucher.delete", targetType: "Voucher", targetId: null });

    // Same call shape every existing caller uses today — no targetId key at all.
    const all = await listAuditLogs(prisma, { adminId: admin.id });
    expect(all).toHaveLength(3);
    expect(await countAuditLogs(prisma, { adminId: admin.id })).toBe(3);

    // targetType-only filtering (pre-existing behavior) still works unchanged.
    const byType = await listAuditLogs(prisma, { targetType: "Order" });
    expect(byType).toHaveLength(1);
    expect(byType[0]!.action).toBe("order.cancel");
  });
});
