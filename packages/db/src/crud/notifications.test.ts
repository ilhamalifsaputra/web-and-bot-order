import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";

// resolveAdminIds merges config.ADMIN_IDS (env) with DB-persisted IDs. The
// enqueueOrderPipelineFailed tests need a predictable baseline (no env admins),
// so we stub the config export to return an empty ADMIN_IDS list.
vi.mock("@app/core/config", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@app/core/config")>();
  return { ...actual, config: { ...actual.config, ADMIN_IDS: [] } };
});
import type { PrismaClient } from "@prisma/client";
import { makeTestDb, type TestDb } from "../../../../tests/helpers/testdb";
import {
  enqueueNotification,
  enqueueOrderPipelineFailed,
  enqueueManualOrderAdminAlert,
  enqueueAdminStalePayment,
  enqueueAdminPasswordReset,
  enqueueRestockBroadcast,
  enqueueFlashSaleBroadcast,
  FLASH_SALE_BROADCAST_CHUNK_SIZE,
  fetchPendingNotifications,
  claimNotification,
  releaseNotificationClaim,
  releaseNotificationClaimWithBackoff,
  markNotificationSent,
  markNotificationFailed,
  retryNotification,
  STALE_CLAIM_MS,
  notificationBackoffMs,
  NOTIF_RETRY_BASE_MS,
  NOTIF_RETRY_MAX_MS,
} from "./notifications";
import { addAdminIdToDb } from "./admins";
import { NotificationEvent } from "@app/core/enums";
import { Decimal } from "@app/core/money";

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

  // Outbox-1 fix (backend audit): a channel-not-configured release must back
  // off like markNotificationFailed, but never terminate in FAILED — an admin
  // reconfiguring PUBLIC_CHANNEL_ID should always be able to un-stick it.
  it("releaseNotificationClaimWithBackoff increments attempts and sets a future nextRetryAt, staying PENDING", async () => {
    const orderId = await seedOrder();
    await enqueueNotification(prisma, NotificationEvent.ORDER_DELIVERED, orderId, {});
    const [row] = await fetchPendingNotifications(prisma, 1);
    await claimNotification(prisma, row!.id);

    const before = new Date();
    await releaseNotificationClaimWithBackoff(prisma, row!.id, before);
    const r = await prisma.notificationOutbox.findUnique({ where: { id: row!.id } });
    expect(r!.status).toBe("PENDING");
    expect(r!.claimedAt).toBeNull();
    expect(r!.attempts).toBe(1);
    expect(r!.nextRetryAt!.getTime()).toBe(before.getTime() + notificationBackoffMs(1));
    // Not claimable again until nextRetryAt passes.
    expect((await fetchPendingNotifications(prisma, 50, before)).some((x) => x.id === row!.id)).toBe(false);
  });

  it("releaseNotificationClaimWithBackoff never flips the row to FAILED, however many times it's called", async () => {
    const orderId = await seedOrder();
    await enqueueNotification(prisma, NotificationEvent.ORDER_DELIVERED, orderId, {});
    const [row] = await fetchPendingNotifications(prisma, 1);

    for (let i = 0; i < 8; i++) {
      // Simulate each backoff window having already elapsed (an admin
      // reconfiguring the channel doesn't wait out the real clock) so the
      // row is claimable again on this iteration.
      await prisma.notificationOutbox.update({
        where: { id: row!.id },
        data: { nextRetryAt: null },
      });
      await claimNotification(prisma, row!.id);
      await releaseNotificationClaimWithBackoff(prisma, row!.id);
    }
    const r = await prisma.notificationOutbox.findUnique({ where: { id: row!.id } });
    expect(r!.status).toBe("PENDING");
    expect(r!.attempts).toBe(8);
    expect(r!.nextRetryAt).not.toBeNull();
  });

  it("releaseNotificationClaimWithBackoff is a no-op once the row has moved on (e.g. SENT)", async () => {
    const orderId = await seedOrder();
    await enqueueNotification(prisma, NotificationEvent.ORDER_DELIVERED, orderId, {});
    const [row] = await fetchPendingNotifications(prisma, 1);
    await claimNotification(prisma, row!.id);
    await markNotificationSent(prisma, row!.id);

    await releaseNotificationClaimWithBackoff(prisma, row!.id);
    const r = await prisma.notificationOutbox.findUnique({ where: { id: row!.id } });
    expect(r!.status).toBe("SENT");
  });
});

describe("enqueueOrderPipelineFailed", () => {
  // Runs before the "two admins" test below — addAdminIdToDb persists into
  // the shared `admin_ids` Setting for the rest of this file's run, so the
  // "no admin resolved" assumption only holds before that happens.
  it("enqueues nothing when no admin is resolved", async () => {
    const orderId = await seedOrder();
    const before = await prisma.notificationOutbox.count({ where: { event: NotificationEvent.ORDER_PIPELINE_FAILED } });
    await enqueueOrderPipelineFailed(prisma, { orderId, orderCode: "ORD-NOADMIN", reason: "no admins configured in this test" });
    const after = await prisma.notificationOutbox.count({ where: { event: NotificationEvent.ORDER_PIPELINE_FAILED } });
    expect(after).toBe(before);
  });

  it("enqueues one ORDER_PIPELINE_FAILED DM per resolved admin, with chat_id/order_code/reason and a truncated reason", async () => {
    await addAdminIdToDb(prisma, 4001);
    await addAdminIdToDb(prisma, 4002);
    const orderId = await seedOrder();

    await enqueueOrderPipelineFailed(prisma, { orderId, orderCode: "ORD-FAILTEST", reason: "x".repeat(1000) });

    const rows = await prisma.notificationOutbox.findMany({ where: { event: NotificationEvent.ORDER_PIPELINE_FAILED, orderId } });
    expect(rows).toHaveLength(2);
    const chatIds = rows.map((r) => (JSON.parse(r.payloadJson) as { chat_id: number }).chat_id).sort();
    expect(chatIds).toEqual([4001, 4002]);
    const payload = JSON.parse(rows[0]!.payloadJson) as { order_code: string; reason: string };
    expect(payload.order_code).toBe("ORD-FAILTEST");
    expect(payload.reason.length).toBe(300); // truncated, not the full 1000-char input
  });
});

// enqueueManualOrderAdminAlert shares enqueueOrderPipelineFailed's exact
// per-admin fan-out primitive (resolveAdminIds + one outbox row per id), so
// the "no admin resolved -> no-op" behavior is already covered by that
// block's first test above; this block only needs to assert this function's
// own event/payload shape. Runs after enqueueOrderPipelineFailed's block, so
// 4001/4002 are already persisted in the shared `admin_ids` Setting — assert
// against the full resolved set (4001/4002 plus the ids added here) rather
// than assuming a clean slate.
describe("enqueueManualOrderAdminAlert", () => {
  it("enqueues one ADMIN_MANUAL_ORDER_QUEUED DM per resolved admin, with chat_id/order_code/items/total/currency", async () => {
    await addAdminIdToDb(prisma, 4501);
    await addAdminIdToDb(prisma, 4502);
    const orderId = await seedOrder();

    await enqueueManualOrderAdminAlert(prisma, {
      orderId,
      orderCode: "ORD-MANUALTEST",
      items: [{ name: "Netflix Premium", qty: 2 }],
      total: new Decimal("15.50"),
      currency: "USDT",
    });

    const rows = await prisma.notificationOutbox.findMany({
      where: { event: NotificationEvent.ADMIN_MANUAL_ORDER_QUEUED, orderId },
    });
    const chatIds = rows.map((r) => (JSON.parse(r.payloadJson) as { chat_id: number }).chat_id).sort((a, b) => a - b);
    expect(chatIds).toEqual([4001, 4002, 4501, 4502]);
    const payload = JSON.parse(rows[0]!.payloadJson) as {
      order_code: string;
      items: { name: string; qty: number }[];
      total: string;
      currency: string;
    };
    expect(payload.order_code).toBe("ORD-MANUALTEST");
    expect(payload.items).toEqual([{ name: "Netflix Premium", qty: 2 }]);
    expect(payload.total).toBe("15.5");
    expect(payload.currency).toBe("USDT");
  });
});

// enqueueAdminStalePayment shares enqueueOrderPipelineFailed's exact
// per-admin fan-out primitive, so "no admin resolved -> no-op" is already
// covered above; this block only asserts this function's own event/payload
// shape. Runs after the earlier blocks, so 4001/4002/4501/4502 are already
// persisted in the shared `admin_ids` Setting.
describe("enqueueAdminStalePayment", () => {
  it("enqueues one ADMIN_STALE_PAYMENT DM per resolved admin, with chat_id/order_code/gateway/trx_id", async () => {
    const orderId = await seedOrder();

    await enqueueAdminStalePayment(prisma, {
      orderId,
      orderCode: "ORD-STALETEST",
      gateway: "TokoPay",
      trxId: "TRX-STALE-1",
    });

    const rows = await prisma.notificationOutbox.findMany({
      where: { event: NotificationEvent.ADMIN_STALE_PAYMENT, orderId },
    });
    expect(rows.length).toBeGreaterThan(0);
    const chatIds = rows.map((r) => (JSON.parse(r.payloadJson) as { chat_id: number }).chat_id).sort((a, b) => a - b);
    expect(chatIds).toEqual([4001, 4002, 4501, 4502]);
    const payload = JSON.parse(rows[0]!.payloadJson) as {
      order_code: string;
      gateway: string;
      trx_id: string;
    };
    expect(payload.order_code).toBe("ORD-STALETEST");
    expect(payload.gateway).toBe("TokoPay");
    expect(payload.trx_id).toBe("TRX-STALE-1");
  });
});

describe("enqueueRestockBroadcast", () => {
  function makeUser(overrides: { telegramId?: bigint | null; banned?: boolean; language?: string }) {
    return prisma.user.create({
      data: {
        telegramId: overrides.telegramId === undefined ? BigInt(Math.floor(Math.random() * 1e15)) : overrides.telegramId,
        referralCode: `r${Math.random()}`,
        banned: overrides.banned ?? false,
        language: overrides.language ?? "EN",
      },
    });
  }

  it("enqueues one DM per non-banned customer with a linked Telegram account, skipping banned and web-only users", async () => {
    const eligible = await makeUser({ language: "ID" });
    await makeUser({ banned: true }); // banned — must be skipped
    await makeUser({ telegramId: null }); // web-only — must be skipped

    const before = await prisma.notificationOutbox.count({ where: { event: NotificationEvent.PRODUCT_RESTOCKED_BROADCAST } });
    const notified = await enqueueRestockBroadcast(prisma, { productName: "1 Month CapCut Pro", stockCount: 12 });
    const rows = await prisma.notificationOutbox.findMany({
      where: { event: NotificationEvent.PRODUCT_RESTOCKED_BROADCAST },
      orderBy: { id: "desc" },
      take: notified,
    });

    expect(rows.length).toBe(notified);
    expect(await prisma.notificationOutbox.count({ where: { event: NotificationEvent.PRODUCT_RESTOCKED_BROADCAST } })).toBe(
      before + notified,
    );
    const eligibleRow = rows.find((r) => (JSON.parse(r.payloadJson) as { chat_id: number }).chat_id === Number(eligible.telegramId));
    expect(eligibleRow).toBeDefined();
    const payload = JSON.parse(eligibleRow!.payloadJson) as {
      chat_id: number;
      product_name: string;
      stock_count: number;
      buyer_language: string;
    };
    expect(payload.product_name).toBe("1 Month CapCut Pro");
    expect(payload.stock_count).toBe(12);
    expect(payload.buyer_language).toBe("id");
    expect(eligibleRow!.orderId).toBeNull();
  });

  it("also writes a SENT Broadcast row (segment ALL) so it shows up in the web-admin Broadcast History table", async () => {
    await makeUser({});
    const admin = await prisma.user.create({ data: { referralCode: `admin-${Math.random()}`, role: "ADMIN" } });

    const notified = await enqueueRestockBroadcast(prisma, {
      productName: "Netflix Premium",
      stockCount: 5,
      createdById: admin.id,
    });

    const row = await prisma.broadcast.findFirst({ orderBy: { id: "desc" } });
    expect(row!.segment).toBe("ALL");
    expect(row!.status).toBe("SENT");
    expect(row!.totalCount).toBe(notified);
    expect(row!.sentCount).toBe(notified);
    expect(row!.failedCount).toBe(0);
    expect(row!.createdById).toBe(admin.id);
    expect(row!.sentAt).not.toBeNull();
    expect(row!.message).toContain("Netflix Premium");
    expect(row!.message).toContain("5");
    // Plain text — no HTML tags, unlike the outbox-dispatcher's rendered DM.
    expect(row!.message).not.toContain("<b>");
  });

  it("returns 0 and enqueues nothing (no outbox rows, no Broadcast row) when there are no eligible customers", async () => {
    const before = await prisma.notificationOutbox.count({ where: { event: NotificationEvent.PRODUCT_RESTOCKED_BROADCAST } });
    const broadcastsBefore = await prisma.broadcast.count();
    await prisma.user.updateMany({ data: { banned: true } }); // neutralize any users left over from earlier tests
    const notified = await enqueueRestockBroadcast(prisma, { productName: "Nothing", stockCount: 0 });
    expect(notified).toBe(0);
    expect(await prisma.notificationOutbox.count({ where: { event: NotificationEvent.PRODUCT_RESTOCKED_BROADCAST } })).toBe(before);
    expect(await prisma.broadcast.count()).toBe(broadcastsBefore);
  });
});

describe("enqueueFlashSaleBroadcast", () => {
  const sale = {
    productName: "CapCut Pro",
    denominationName: "1 Month",
    discountPercent: "25",
    oldPrice: "Rp50.000",
    newPrice: "Rp37.500",
    endsAt: "2026-07-21 21:00 GMT+7",
  };

  function makeUser(overrides: { telegramId?: bigint | null; banned?: boolean; language?: string }) {
    return prisma.user.create({
      data: {
        telegramId: overrides.telegramId === undefined ? BigInt(Math.floor(Math.random() * 1e15)) : overrides.telegramId,
        referralCode: `r${Math.random()}`,
        banned: overrides.banned ?? false,
        language: overrides.language ?? "EN",
      },
    });
  }

  it("enqueues one DM per non-banned customer with a linked Telegram account, skipping banned and web-only users", async () => {
    await prisma.user.updateMany({ data: { banned: true } }); // neutralize leftovers from earlier tests
    const eligible = await makeUser({ language: "ID" });
    await makeUser({ banned: true }); // banned — must be skipped
    await makeUser({ telegramId: null }); // web-only — must be skipped

    const notified = await enqueueFlashSaleBroadcast(prisma, sale);

    expect(notified).toBe(1);
    const rows = await prisma.notificationOutbox.findMany({
      where: { event: NotificationEvent.FLASH_SALE_BROADCAST },
    });
    expect(rows.length).toBe(1);
    expect(rows[0]!.orderId).toBeNull();
    const payload = JSON.parse(rows[0]!.payloadJson) as Record<string, unknown>;
    expect(payload).toEqual({
      chat_id: Number(eligible.telegramId),
      product_name: "CapCut Pro",
      denomination_name: "1 Month",
      discount_percent: "25",
      old_price: "Rp50.000",
      new_price: "Rp37.500",
      ends_at: "2026-07-21 21:00 GMT+7",
      buyer_language: "id",
    });
  });

  it("also writes a SENT Broadcast row (segment ALL) so it shows up in the web-admin Broadcast History table", async () => {
    await makeUser({});
    const admin = await prisma.user.create({ data: { referralCode: `admin-${Math.random()}`, role: "ADMIN" } });

    const notified = await enqueueFlashSaleBroadcast(prisma, { ...sale, createdById: admin.id });

    const row = await prisma.broadcast.findFirst({ orderBy: { id: "desc" } });
    expect(row!.segment).toBe("ALL");
    expect(row!.status).toBe("SENT");
    expect(row!.totalCount).toBe(notified);
    expect(row!.sentCount).toBe(notified);
    expect(row!.failedCount).toBe(0);
    expect(row!.createdById).toBe(admin.id);
    expect(row!.sentAt).not.toBeNull();
    expect(row!.message).toContain("CapCut Pro — 1 Month");
    expect(row!.message).toContain("25% OFF");
    expect(row!.message).toContain("Rp37.500");
    expect(row!.message).toContain("2026-07-21 21:00 GMT+7");
    // Plain text — no HTML tags, unlike the outbox-dispatcher's rendered DM.
    expect(row!.message).not.toContain("<b>");
    expect(row!.message).not.toContain("<s>");
  });

  it("returns 0 and enqueues nothing (no outbox rows, no Broadcast row) when there are no eligible customers", async () => {
    const before = await prisma.notificationOutbox.count({ where: { event: NotificationEvent.FLASH_SALE_BROADCAST } });
    const broadcastsBefore = await prisma.broadcast.count();
    await prisma.user.updateMany({ data: { banned: true } });

    const notified = await enqueueFlashSaleBroadcast(prisma, sale);

    expect(notified).toBe(0);
    expect(await prisma.notificationOutbox.count({ where: { event: NotificationEvent.FLASH_SALE_BROADCAST } })).toBe(before);
    expect(await prisma.broadcast.count()).toBe(broadcastsBefore);
  });

  // H-7 fix (backend audit 2026-07-31): the outbox insert is now chunked
  // (FLASH_SALE_BROADCAST_CHUNK_SIZE rows per createMany) instead of one
  // insert sized to the whole customer base, so no single write holds
  // SQLite's writer lock for long regardless of how large the base is. This
  // customer count (1,200) is chosen to be more than double the internal
  // 500-row chunk size, so the test only passes if multiple chunks actually
  // ran and every one of them landed — not just the first.
  it("enqueues every recipient across a large customer base via multiple chunked writes, with one Broadcast row for the whole fan-out", async () => {
    await prisma.user.updateMany({ data: { banned: true } }); // neutralize leftovers from earlier tests (own new users only, doesn't touch old outbox rows)
    const RECIPIENT_COUNT = 1200;
    const TELEGRAM_ID_BASE = 9_000_000; // unique range so this run's rows are identifiable among any leftover outbox rows from earlier tests
    await prisma.user.createMany({
      data: Array.from({ length: RECIPIENT_COUNT }, (_, i) => ({
        telegramId: BigInt(TELEGRAM_ID_BASE + i),
        referralCode: `flash-chunk-${i}`,
        banned: false,
        language: i % 2 === 0 ? "EN" : "ID",
      })),
    });

    const notified = await enqueueFlashSaleBroadcast(prisma, sale);

    expect(notified).toBe(RECIPIENT_COUNT);
    const rows = await prisma.notificationOutbox.findMany({ where: { event: NotificationEvent.FLASH_SALE_BROADCAST } });
    const thisRunRows = rows.filter((r) => {
      const chatId = (JSON.parse(r.payloadJson) as { chat_id: number }).chat_id;
      return chatId >= TELEGRAM_ID_BASE && chatId < TELEGRAM_ID_BASE + RECIPIENT_COUNT;
    });
    expect(thisRunRows.length).toBe(RECIPIENT_COUNT);
    // No duplicate/missing recipients across chunk boundaries.
    const chatIds = new Set(thisRunRows.map((r) => (JSON.parse(r.payloadJson) as { chat_id: number }).chat_id));
    expect(chatIds.size).toBe(RECIPIENT_COUNT);

    const broadcastRow = await prisma.broadcast.findFirst({ orderBy: { id: "desc" } });
    expect(broadcastRow!.status).toBe("SENT");
    expect(broadcastRow!.totalCount).toBe(notified);
    expect(broadcastRow!.sentCount).toBe(notified);
    // Exactly one Broadcast row for the whole fan-out, not one per chunk.
    expect(await prisma.broadcast.count({ where: { totalCount: notified } })).toBe(1);
  });

  // H-7 follow-up fix (backend audit 2026-07-31/08-01): a code-review pass on
  // the chunked-write fix above found that the Broadcast row used to be
  // written only AFTER every chunk succeeded — so a chunk throwing partway
  // through left ZERO trace in Broadcast History, even though the earlier
  // chunks' createMany calls had already committed real outbox rows (each
  // createMany auto-commits outside any transaction, so those DMs really did
  // get queued). That directly contradicted announceStartedFlashSales's own
  // recovery guidance to "check Broadcast History." The Broadcast row is now
  // created up front (SENDING, sentCount 0) and flipped to FAILED with a
  // partial sentCount if a chunk throws, instead of only ever being written
  // on full success. This test simulates a chunk failure (via a `db` stand-in
  // whose notificationOutbox.createMany rejects on the 2nd chunk, after
  // proxying the 1st chunk through to the real Prisma client) and asserts
  // that failure is now visible and accurate in Broadcast History.
  it("leaves a FAILED Broadcast row with an accurate partial sentCount when a chunk fails partway through the fan-out", async () => {
    await prisma.user.updateMany({ data: { banned: true } }); // neutralize leftovers from earlier tests
    const RECIPIENT_COUNT = FLASH_SALE_BROADCAST_CHUNK_SIZE + 100; // forces exactly 2 chunks: a full one, then a partial one
    const TELEGRAM_ID_BASE = 9_500_000;
    await prisma.user.createMany({
      data: Array.from({ length: RECIPIENT_COUNT }, (_, i) => ({
        telegramId: BigInt(TELEGRAM_ID_BASE + i),
        referralCode: `flash-partial-fail-${i}`,
        banned: false,
      })),
    });

    let createManyCalls = 0;
    const failingDb = {
      user: prisma.user,
      notificationOutbox: {
        createMany: (args: Parameters<PrismaClient["notificationOutbox"]["createMany"]>[0]) => {
          createManyCalls++;
          if (createManyCalls === 2) throw new Error("simulated write failure on the 2nd chunk");
          return prisma.notificationOutbox.createMany(args);
        },
      },
      broadcast: prisma.broadcast,
    } as unknown as PrismaClient;

    await expect(enqueueFlashSaleBroadcast(failingDb, sale)).rejects.toThrow("simulated write failure on the 2nd chunk");
    expect(createManyCalls).toBe(2); // both chunks were attempted; the 2nd is what threw

    const broadcastRow = await prisma.broadcast.findFirst({ orderBy: { id: "desc" } });
    expect(broadcastRow!.status).toBe("FAILED");
    expect(broadcastRow!.totalCount).toBe(RECIPIENT_COUNT);
    // Only the first (successful) chunk's count landed — not 0 (which the old,
    // create-only-on-success version would have left nothing to even check),
    // and not the full RECIPIENT_COUNT (the 2nd chunk never committed).
    expect(broadcastRow!.sentCount).toBe(FLASH_SALE_BROADCAST_CHUNK_SIZE);
    expect(broadcastRow!.failureReason).toBeTruthy();
    expect(broadcastRow!.failureReason).toContain("partway through");

    // The first chunk's outbox rows really did commit (createMany auto-commits
    // outside any transaction) — those customers were genuinely queued the DM,
    // even though the overall run is now reported FAILED, not silently SENT.
    const rows = await prisma.notificationOutbox.findMany({ where: { event: NotificationEvent.FLASH_SALE_BROADCAST } });
    const thisRunRows = rows.filter((r) => {
      const chatId = (JSON.parse(r.payloadJson) as { chat_id: number }).chat_id;
      return chatId >= TELEGRAM_ID_BASE && chatId < TELEGRAM_ID_BASE + RECIPIENT_COUNT;
    });
    expect(thisRunRows.length).toBe(FLASH_SALE_BROADCAST_CHUNK_SIZE);
  });
});

// A bulk broadcast (enqueueRestockBroadcast/enqueueFlashSaleBroadcast) can
// createMany hundreds/thousands of rows into the same notification_outbox
// table an urgent single-recipient DM (e.g. ADMIN_PW_RESET, the admin-panel
// forgot-password OTP) rides in. Strict createdAt-FIFO would let a broadcast
// backlog delay an OTP by many minutes. fetchPendingNotifications must
// return urgent (non-broadcast) rows ahead of broadcast rows regardless of
// enqueue order, without starving the broadcast rows entirely.
// This file's tests share one DB and don't all clean up after themselves, so
// by the time this block runs there can be an arbitrary number of leftover
// claimable PENDING rows from earlier tests. These assertions are written to
// hold regardless of that backlog: they check the *invariant* (no broadcast
// row is ever returned while a claimable urgent row still exists; broadcast
// rows are still reachable, not starved forever) rather than an exact
// position or an exact small `limit`.
describe("fetchPendingNotifications priority (urgent DMs before bulk broadcasts)", () => {
  it("never returns a broadcast row while a claimable urgent row exists, even at limit=1", async () => {
    await prisma.user.updateMany({ data: { banned: true } }); // neutralize leftovers from earlier tests
    const buyer = await prisma.user.create({
      data: { telegramId: BigInt(Math.floor(Math.random() * 1e15)), referralCode: `r${Math.random()}`, banned: false },
    });

    // Broadcast row enqueued first (older createdAt) — must still lose priority.
    const notified = await enqueueFlashSaleBroadcast(prisma, {
      productName: "CapCut Pro",
      denominationName: "1 Month",
      discountPercent: "25",
      oldPrice: "Rp50.000",
      newPrice: "Rp37.500",
      endsAt: "2026-07-21 21:00 GMT+7",
    });
    expect(notified).toBe(1);

    // OTP enqueued after — newer createdAt, but must still be reachable first.
    await enqueueAdminPasswordReset(prisma, { telegramId: 9001, code: "123456", ttlMinutes: 10 });

    const [top] = await fetchPendingNotifications(prisma, 1);
    expect(top).toBeDefined();
    expect(top!.event).not.toBe(NotificationEvent.FLASH_SALE_BROADCAST);
    expect(top!.event).not.toBe(NotificationEvent.PRODUCT_RESTOCKED_BROADCAST);

    void buyer; // only needed so enqueueFlashSaleBroadcast has an eligible recipient
  });

  it("still surfaces broadcast rows once the limit covers every claimable urgent row — not starved forever", async () => {
    await prisma.user.updateMany({ data: { banned: true } }); // neutralize leftovers from earlier tests
    await prisma.user.create({
      data: { telegramId: BigInt(Math.floor(Math.random() * 1e15)), referralCode: `r${Math.random()}`, banned: false },
    });

    await enqueueAdminPasswordReset(prisma, { telegramId: 9002, code: "654321", ttlMinutes: 10 });
    const notified = await enqueueRestockBroadcast(prisma, { productName: "Netflix Premium", stockCount: 3 });
    expect(notified).toBe(1);

    // A limit covering every currently-PENDING row (urgent leftovers included)
    // must still include the broadcast row — priority reorders, never drops.
    const totalPending = await prisma.notificationOutbox.count({ where: { status: "PENDING" } });
    const fullBatch = await fetchPendingNotifications(prisma, totalPending);
    expect(fullBatch.some((r) => r.event === NotificationEvent.ADMIN_PW_RESET)).toBe(true);
    expect(fullBatch.some((r) => r.event === NotificationEvent.PRODUCT_RESTOCKED_BROADCAST)).toBe(true);
  });
});
