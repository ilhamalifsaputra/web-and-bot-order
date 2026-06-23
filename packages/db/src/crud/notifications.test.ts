import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { makeTestDb, type TestDb } from "../../../../tests/helpers/testdb";
import {
  enqueueNotification,
  fetchPendingNotifications,
  claimNotification,
  releaseNotificationClaim,
  markNotificationSent,
  markNotificationFailed,
  retryNotification,
  STALE_CLAIM_MS,
  notificationBackoffMs,
  NOTIF_RETRY_BASE_MS,
  NOTIF_RETRY_MAX_MS,
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

  // Infra-3 (security audit, 2026-06-23): a row markNotificationFailed sends
  // back to PENDING gets an exponential-backoff nextRetryAt — without it, the
  // row's unchanged (oldest) createdAt keeps re-claiming the limited-size
  // batch's "top N" slot every tick, starving valid rows enqueued after it.
  describe("nextRetryAt backoff (Infra-3 fix)", () => {
    it("notificationBackoffMs doubles per attempt and caps at NOTIF_RETRY_MAX_MS", () => {
      expect(notificationBackoffMs(1)).toBe(NOTIF_RETRY_BASE_MS);
      expect(notificationBackoffMs(2)).toBe(NOTIF_RETRY_BASE_MS * 2);
      expect(notificationBackoffMs(3)).toBe(NOTIF_RETRY_BASE_MS * 4);
      // Keep doubling until it would exceed the cap.
      const uncapped = NOTIF_RETRY_BASE_MS * 2 ** 19;
      expect(uncapped).toBeGreaterThan(NOTIF_RETRY_MAX_MS);
      expect(notificationBackoffMs(20)).toBe(NOTIF_RETRY_MAX_MS);
    });

    it("a backed-off row is excluded from fetchPendingNotifications until its window passes", async () => {
      const orderId = await seedOrder();
      await enqueueNotification(prisma, NotificationEvent.ORDER_DELIVERED, orderId, {});
      const [row] = await fetchPendingNotifications(prisma, 1);
      const now = new Date();

      await markNotificationFailed(prisma, row!.id, "transient blip", 5, now);
      const after = await prisma.notificationOutbox.findUnique({ where: { id: row!.id } });
      expect(after!.status).toBe("PENDING");
      expect(after!.nextRetryAt).not.toBeNull();

      // Still within the backoff window — not claimable.
      expect(await fetchPendingNotifications(prisma, 50, now)).toHaveLength(0);
      expect(await claimNotification(prisma, row!.id, now)).toBe(false);

      // Past the backoff window — claimable again.
      const past = new Date(now.getTime() + notificationBackoffMs(1) + 1000);
      const visible = await fetchPendingNotifications(prisma, 50, past);
      expect(visible.some((r) => r.id === row!.id)).toBe(true);
      expect(await claimNotification(prisma, row!.id, past)).toBe(true);
    });

    it("a row that reaches FAILED has nextRetryAt cleared (terminal — no backoff to track)", async () => {
      const orderId = await seedOrder();
      await enqueueNotification(prisma, NotificationEvent.ORDER_DELIVERED, orderId, {});
      const [row] = await fetchPendingNotifications(prisma, 1);
      await markNotificationFailed(prisma, row!.id, "permanent", 1);
      const r = await prisma.notificationOutbox.findUnique({ where: { id: row!.id } });
      expect(r!.status).toBe("FAILED");
      expect(r!.nextRetryAt).toBeNull();
    });

    it("retryNotification clears nextRetryAt — an admin retry isn't blocked by a leftover backoff window", async () => {
      const orderId = await seedOrder();
      await enqueueNotification(prisma, NotificationEvent.ORDER_DELIVERED, orderId, {});
      const [row] = await fetchPendingNotifications(prisma, 1);
      const now = new Date();
      await markNotificationFailed(prisma, row!.id, "transient", 5, now);

      await retryNotification(prisma, row!.id);
      const r = await prisma.notificationOutbox.findUnique({ where: { id: row!.id } });
      expect(r!.status).toBe("PENDING");
      expect(r!.nextRetryAt).toBeNull();
      // Immediately claimable, even "now" (no backoff wait needed).
      expect((await fetchPendingNotifications(prisma, 50, now)).some((x) => x.id === row!.id)).toBe(true);
    });

    it("a backed-off row never starves a VALID row enqueued after it, once the batch is limit-constrained", async () => {
      const orderId = await seedOrder();
      await enqueueNotification(prisma, NotificationEvent.ORDER_DELIVERED, orderId, {});
      const [badRow] = await fetchPendingNotifications(prisma, 1);
      const now = new Date();
      await markNotificationFailed(prisma, badRow!.id, "keeps failing", 5, now);

      // A second, valid row enqueued AFTER the failing one.
      const orderId2 = await seedOrder();
      await enqueueNotification(prisma, NotificationEvent.ORDER_DELIVERED, orderId2, {});

      // With a batch limit of 1 (simulating "top of an oldest-first queue"),
      // the backed-off row must NOT occupy the only slot — the valid row
      // enqueued after it gets through instead.
      const batch = await fetchPendingNotifications(prisma, 1, now);
      expect(batch).toHaveLength(1);
      expect(batch[0]!.id).not.toBe(badRow!.id);
    });
  });
});

// Infra-2 fix (security audit, 2026-06-23): atomic claim before send closes
// the crash-window double-send gap.
describe("claimNotification / releaseNotificationClaim (crash-window double-send guard)", () => {
  it("claims a PENDING row exactly once — a second claim attempt fails", async () => {
    const orderId = await seedOrder();
    await enqueueNotification(prisma, NotificationEvent.ORDER_DELIVERED, orderId, {});
    const [row] = await fetchPendingNotifications(prisma, 1);

    expect(await claimNotification(prisma, row!.id)).toBe(true);
    const claimed = await prisma.notificationOutbox.findUnique({ where: { id: row!.id } });
    expect(claimed!.status).toBe("SENDING");
    expect(claimed!.claimedAt).not.toBeNull();

    // A second dispatcher (or the same one re-entering) must not re-claim it.
    expect(await claimNotification(prisma, row!.id)).toBe(false);
  });

  it("a freshly-claimed SENDING row is NOT returned by fetchPendingNotifications", async () => {
    const orderId = await seedOrder();
    await enqueueNotification(prisma, NotificationEvent.ORDER_DELIVERED, orderId, {});
    const [row] = await fetchPendingNotifications(prisma, 1);
    await claimNotification(prisma, row!.id);

    const visible = await fetchPendingNotifications(prisma, 50);
    expect(visible.some((r) => r.id === row!.id)).toBe(false);
  });

  it("a SENDING row past STALE_CLAIM_MS becomes claimable again (abandoned mid-send)", async () => {
    const orderId = await seedOrder();
    await enqueueNotification(prisma, NotificationEvent.ORDER_DELIVERED, orderId, {});
    const [row] = await fetchPendingNotifications(prisma, 1);
    const longAgo = new Date(Date.now() - STALE_CLAIM_MS - 1000);
    await claimNotification(prisma, row!.id, longAgo); // simulate a claim that never completed

    // Visible again once stale.
    const visible = await fetchPendingNotifications(prisma, 50);
    expect(visible.some((r) => r.id === row!.id)).toBe(true);
    // And reclaimable.
    expect(await claimNotification(prisma, row!.id)).toBe(true);
  });

  it("releaseNotificationClaim puts a SENDING row back to PENDING immediately (no stale-window wait)", async () => {
    const orderId = await seedOrder();
    await enqueueNotification(prisma, NotificationEvent.ORDER_DELIVERED, orderId, {});
    const [row] = await fetchPendingNotifications(prisma, 1);
    await claimNotification(prisma, row!.id);

    await releaseNotificationClaim(prisma, row!.id);
    const r = await prisma.notificationOutbox.findUnique({ where: { id: row!.id } });
    expect(r!.status).toBe("PENDING");
    expect(r!.claimedAt).toBeNull();
    expect((await fetchPendingNotifications(prisma, 50)).some((x) => x.id === row!.id)).toBe(true);
  });

  it("markNotificationFailed (under maxAttempts) returns a claimed row to PENDING, not stuck SENDING", async () => {
    const orderId = await seedOrder();
    await enqueueNotification(prisma, NotificationEvent.ORDER_DELIVERED, orderId, {});
    const [row] = await fetchPendingNotifications(prisma, 1);
    await claimNotification(prisma, row!.id);

    await markNotificationFailed(prisma, row!.id, "transient", 5);
    const r = await prisma.notificationOutbox.findUnique({ where: { id: row!.id } });
    expect(r!.status).toBe("PENDING");
    expect(r!.claimedAt).toBeNull();
  });

  it("markNotificationSent clears claimedAt", async () => {
    const orderId = await seedOrder();
    await enqueueNotification(prisma, NotificationEvent.ORDER_DELIVERED, orderId, {});
    const [row] = await fetchPendingNotifications(prisma, 1);
    await claimNotification(prisma, row!.id);

    await markNotificationSent(prisma, row!.id);
    const r = await prisma.notificationOutbox.findUnique({ where: { id: row!.id } });
    expect(r!.status).toBe("SENT");
    expect(r!.claimedAt).toBeNull();
  });
});
