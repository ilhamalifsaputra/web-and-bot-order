import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { makeTestDb, type TestDb } from "../../../../tests/helpers/testdb";
import {
  enqueueNotification,
  fetchPendingNotifications,
  markNotificationSent,
  markNotificationFailed,
} from "./notifications";
import { NotificationEvent } from "@app/core/enums";

let db: TestDb;
let prisma: PrismaClient;

beforeAll(async () => {
  db = await makeTestDb();
  prisma = db.prisma;
});
afterAll(async () => {
  await db.cleanup();
});

async function seedOrder(): Promise<number> {
  const user = await prisma.user.create({
    data: { telegramId: BigInt(Math.floor(Math.random() * 1e15)), referralCode: `r${Math.random()}` },
  });
  const order = await prisma.order.create({
    data: {
      orderCode: `ORD-${Math.random()}`,
      userId: user.id,
      subtotalAmount: "5",
      totalAmount: "5",
    },
  });
  return order.id;
}

describe("outbox CRUD", () => {
  it("enqueue → stored PENDING with JSON payload", async () => {
    const orderId = await seedOrder();
    await enqueueNotification(prisma, NotificationEvent.ORDER_DELIVERED, orderId, {
      total: "5",
      buyer_language: "en",
    });
    const rows = await fetchPendingNotifications(prisma, 50);
    expect(rows.length).toBe(1);
    expect(rows[0]!.event).toBe("ORDER_DELIVERED");
    expect(rows[0]!.status).toBe("PENDING");
    expect(JSON.parse(rows[0]!.payloadJson).buyer_language).toBe("en");
  });

  it("markSent flips status and sets sentAt; no longer pending", async () => {
    const [row] = await fetchPendingNotifications(prisma, 1);
    await markNotificationSent(prisma, row!.id);
    const after = await prisma.notificationOutbox.findUnique({ where: { id: row!.id } });
    expect(after!.status).toBe("SENT");
    expect(after!.sentAt).not.toBeNull();
    expect(await fetchPendingNotifications(prisma, 50)).toHaveLength(0);
  });

  it("markFailed stays PENDING until attempts >= maxAttempts", async () => {
    const orderId = await seedOrder();
    await enqueueNotification(prisma, NotificationEvent.ORDER_DELIVERED, orderId, {});
    const [row] = await fetchPendingNotifications(prisma, 1);
    const id = row!.id;

    await markNotificationFailed(prisma, id, "boom", 3);
    let r = await prisma.notificationOutbox.findUnique({ where: { id } });
    expect(r!.attempts).toBe(1);
    expect(r!.status).toBe("PENDING");
    expect(r!.lastError).toBe("boom");

    await markNotificationFailed(prisma, id, "boom2", 3);
    await markNotificationFailed(prisma, id, "boom3", 3);
    r = await prisma.notificationOutbox.findUnique({ where: { id } });
    expect(r!.attempts).toBe(3);
    expect(r!.status).toBe("FAILED");
  });

  it("markFailed with maxAttempts=1 fails immediately", async () => {
    const orderId = await seedOrder();
    await enqueueNotification(prisma, NotificationEvent.ORDER_DELIVERED, orderId, {});
    const [row] = await fetchPendingNotifications(prisma, 1);
    await markNotificationFailed(prisma, row!.id, "no template", 1);
    const r = await prisma.notificationOutbox.findUnique({ where: { id: row!.id } });
    expect(r!.status).toBe("FAILED");
  });

  it("lastError is truncated to 500 chars", async () => {
    const orderId = await seedOrder();
    await enqueueNotification(prisma, NotificationEvent.ORDER_DELIVERED, orderId, {});
    const [row] = await fetchPendingNotifications(prisma, 1);
    await markNotificationFailed(prisma, row!.id, "x".repeat(1000), 1);
    const r = await prisma.notificationOutbox.findUnique({ where: { id: row!.id } });
    expect(r!.lastError!.length).toBe(500);
  });
});
