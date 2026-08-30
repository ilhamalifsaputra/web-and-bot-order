/**
 * Audit log filtering — targetId addition (Support/Tickets redesign, Task 2).
 * `targetId` is a strictly-additive AuditFilter field: every existing caller
 * omits it and must see unfiltered-by-target behavior exactly as before.
 *
 * Also covers the customer-action audit trail (Phase H, Task 1):
 * `actorType`/`channel`/`customerId`/`telegramUserId`/`correlationId` on
 * AuditLog, `logCustomerAction`, and the matching AuditFilter fields.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { makeTestDb, type TestDb } from "../../../../tests/helpers/testdb";
import { logAdminAction, logCustomerAction, listAuditLogs, countAuditLogs } from "./audit";

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

async function makeCustomer() {
  return prisma.user.create({
    data: { referralCode: `c${Math.random()}`, role: "CUSTOMER", telegramId: Math.floor(Math.random() * 1_000_000_000) },
  });
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

describe("customer-action audit trail (Phase H)", () => {
  it("logAdminAction defaults actorType to ADMIN when omitted (regression — existing admin call sites unaffected)", async () => {
    const admin = await makeAdmin();
    await logAdminAction(db.prisma, { adminId: admin.id, action: "order.cancel", targetType: "Order", targetId: 1 });

    const rows = await prisma.auditLog.findMany({ where: { adminId: admin.id } });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.actorType).toBe("ADMIN");
    expect(rows[0]!.channel).toBeNull();
    expect(rows[0]!.customerId).toBeNull();
    expect(rows[0]!.telegramUserId).toBeNull();
    expect(rows[0]!.correlationId).toBeNull();
  });

  it("logCustomerAction creates a CUSTOMER-actor row with customerId/telegramUserId/channel/correlationId populated", async () => {
    const customer = await makeCustomer();

    await logCustomerAction(db.prisma, {
      customerId: customer.id,
      telegramUserId: BigInt(customer.telegramId!),
      channel: "BOT",
      action: "order.create",
      targetType: "order",
      targetId: 42,
      details: "Created order via Telegram checkout.",
      correlationId: "12345",
    });

    const rows = await prisma.auditLog.findMany({ where: { customerId: customer.id } });
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.actorType).toBe("CUSTOMER");
    expect(row.adminId).toBeNull();
    expect(row.customerId).toBe(customer.id);
    expect(row.telegramUserId).toBe(BigInt(customer.telegramId!));
    expect(row.channel).toBe("BOT");
    expect(row.correlationId).toBe("12345");
    expect(row.targetType).toBe("order");
    expect(row.targetId).toBe(42);
    expect(row.details).toBe("Created order via Telegram checkout.");
  });

  it("listAuditLogs/countAuditLogs filter by actorType", async () => {
    const admin = await makeAdmin();
    const customer = await makeCustomer();
    await logAdminAction(db.prisma, { adminId: admin.id, action: "order.cancel", targetType: "Order", targetId: 1 });
    await logCustomerAction(db.prisma, { customerId: customer.id, action: "order.create", targetType: "order", targetId: 2 });

    const customerRows = await listAuditLogs(prisma, { actorType: "CUSTOMER" });
    expect(customerRows).toHaveLength(1);
    expect(customerRows[0]!.action).toBe("order.create");
    expect(await countAuditLogs(prisma, { actorType: "CUSTOMER" })).toBe(1);

    const adminRows = await listAuditLogs(prisma, { actorType: "ADMIN" });
    expect(adminRows).toHaveLength(1);
    expect(adminRows[0]!.action).toBe("order.cancel");
  });

  it("listAuditLogs/countAuditLogs filter by customerId", async () => {
    const customerA = await makeCustomer();
    const customerB = await makeCustomer();
    await logCustomerAction(db.prisma, { customerId: customerA.id, action: "order.create", targetType: "order", targetId: 1 });
    await logCustomerAction(db.prisma, { customerId: customerB.id, action: "order.create", targetType: "order", targetId: 2 });

    const forA = await listAuditLogs(prisma, { customerId: customerA.id });
    expect(forA).toHaveLength(1);
    expect(forA[0]!.targetId).toBe(1);
    expect(await countAuditLogs(prisma, { customerId: customerA.id })).toBe(1);
  });
});
