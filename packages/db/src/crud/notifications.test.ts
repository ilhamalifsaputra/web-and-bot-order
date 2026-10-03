import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";

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
  enqueueAdminUnconfirmablePayment,
  enqueueAdminDigiflazzResyncAborted,
  enqueueAdminPasswordReset,
  enqueueAdminNewTicketDm,
  enqueueTicketReplyDm,
  enqueueTicketClosedDm,
  enqueueWalletTopupCreditedDm,
  enqueueRestockBroadcast,
  enqueueFlashSaleBroadcast,
  enqueueOwnerOrderPaidEmail,
  enqueueOwnerManualQueueEmail,
  enqueueOwnerNewTicketEmail,
  enqueueOwnerTicketReplyEmail,
  enqueueOwnerWalletTopupEmail,
  enqueueBuyerOrderReadyEmail,
  FLASH_SALE_BROADCAST_CHUNK_SIZE,
  fetchPendingNotifications,
  claimNotification,
  releaseNotificationClaim,
  releaseNotificationClaimWithBackoff,
  markNotificationSent,
  markNotificationFailed,
  retryNotification,
  getNotification,
  outboxStatusCounts,
  oldestUnsentNotificationAge,
  STALE_CLAIM_MS,
  notificationBackoffMs,
  NOTIF_RETRY_BASE_MS,
  NOTIF_RETRY_MAX_MS,
  enqueueRestockSubscriberNotifications,
  afterStockAdded,
} from "./notifications";
import { addAdminIdToDb } from "./admins";
import { createCategory, createCatalogProduct, createDenomination } from "./catalog";
import { bulkAddStock } from "./stock";
import { reapStaleBroadcasts, BROADCAST_STALE_CLAIM_MS } from "./broadcasts";
import { setSetting, deleteSetting } from "./settings";
import { NotificationEvent } from "@app/core/enums";
import { Decimal } from "@app/core/money";
import { logger } from "@app/core/logger";

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

// This describe block MUST run first in the file (Vitest executes tests
// within a file sequentially, top-to-bottom, by default — no
// test.concurrent/shuffle is configured here): the "empty outbox" case needs
// a genuinely empty notification_outbox, and every other describe block
// below enqueues rows into the same shared schema-per-file `prisma` without
// cleaning up afterward (see the "fetchPendingNotifications priority"
// block's comment further down for the same shared-DB caveat). Each
// subsequent case here deliberately inserts a row OLDER than anything
// already in the table so its assertion holds regardless of run order among
// ITS OWN cases.
//
// Unlike every other describe block in this file, the rows created here are
// explicitly deleted in this block's own `afterAll` (below) rather than left
// for the rest of the file to accumulate: several later tests (e.g. "outbox
// CRUD > enqueue → stored PENDING with JSON payload" and "nextRetryAt
// backoff > a backed-off row is excluded ... until its window passes")
// assert an EXACT claimable-row count from fetchPendingNotifications, which
// would be thrown off by a genuinely-PENDING (or stale-SENDING, which
// fetchPendingNotifications treats as equally claimable) row left behind by
// this block — a real regression caught by running the full file, not just
// this block's own cases, before considering this task done.
describe("oldestUnsentNotificationAge", () => {
  const createdIds: number[] = [];

  afterAll(async () => {
    await prisma.notificationOutbox.deleteMany({ where: { id: { in: createdIds } } });
  });

  it("returns null on an empty outbox", async () => {
    expect(await oldestUnsentNotificationAge(prisma)).toBeNull();
  });

  it("returns the age of a single PENDING row", async () => {
    const orderId = await seedOrder();
    const createdAt = new Date(Date.now() - 120_000); // 120s old
    const row = await prisma.notificationOutbox.create({
      data: {
        event: "ORDER_DELIVERED",
        payloadJson: "{}",
        orderId,
        status: "PENDING",
        createdAt,
      },
    });
    createdIds.push(row.id);
    const age = await oldestUnsentNotificationAge(prisma);
    expect(age).not.toBeNull();
    expect(age!).toBeGreaterThanOrEqual(120);
    expect(age!).toBeLessThanOrEqual(135); // generous tolerance for test runtime
  });

  it("ignores a fresh (non-stale) SENDING row even if its createdAt is much older", async () => {
    const orderId = await seedOrder();
    const row = await prisma.notificationOutbox.create({
      data: {
        event: "ORDER_DELIVERED",
        payloadJson: "{}",
        orderId,
        status: "SENDING",
        claimedAt: new Date(), // fresh claim — actively being sent right now
        createdAt: new Date(Date.now() - 3_600_000), // 1h old, but must be excluded
      },
    });
    createdIds.push(row.id);
    const age = await oldestUnsentNotificationAge(prisma);
    expect(age).not.toBeNull();
    // Still reflects the ~120s PENDING row from the previous case, NOT the
    // 1h-old fresh-SENDING row — proves a fresh claim is excluded.
    expect(age!).toBeLessThan(300);
  });

  it("counts a SENDING row whose claim is older than STALE_CLAIM_MS, like a PENDING row", async () => {
    const orderId = await seedOrder();
    const staleClaimedAt = new Date(Date.now() - STALE_CLAIM_MS - 10_000);
    const row = await prisma.notificationOutbox.create({
      data: {
        event: "ORDER_DELIVERED",
        payloadJson: "{}",
        orderId,
        status: "SENDING",
        claimedAt: staleClaimedAt,
        createdAt: new Date(Date.now() - 400_000), // 400s old — older than any prior row
      },
    });
    createdIds.push(row.id);
    const age = await oldestUnsentNotificationAge(prisma);
    expect(age).not.toBeNull();
    expect(age!).toBeGreaterThanOrEqual(400);
    expect(age!).toBeLessThanOrEqual(415);
  });

  it("returns the OLDEST qualifying row's age across a mix of PENDING and stale SENDING rows", async () => {
    const orderId = await seedOrder();
    const staleClaimedAt = new Date(Date.now() - STALE_CLAIM_MS - 20_000);
    const row = await prisma.notificationOutbox.create({
      data: {
        event: "ORDER_DELIVERED",
        payloadJson: "{}",
        orderId,
        status: "SENDING",
        claimedAt: staleClaimedAt,
        createdAt: new Date(Date.now() - 500_000), // 500s old — older than the 400s row above
      },
    });
    createdIds.push(row.id);
    const age = await oldestUnsentNotificationAge(prisma);
    expect(age).not.toBeNull();
    expect(age!).toBeGreaterThanOrEqual(500);
    expect(age!).toBeLessThanOrEqual(515);
  });
});

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

  it("markFailed stays PENDING until attempts >= maxAttempts, then goes DEAD_LETTER (genuinely retried, exhausted)", async () => {
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
    expect(r!.status).toBe("DEAD_LETTER");
  });

  it("markFailed with maxAttempts=1 fails immediately as FAILED, not DEAD_LETTER (never actually retried)", async () => {
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

    it("a row that reaches DEAD_LETTER also has nextRetryAt cleared (terminal — no backoff to track)", async () => {
      const orderId = await seedOrder();
      await enqueueNotification(prisma, NotificationEvent.ORDER_DELIVERED, orderId, {});
      const [row] = await fetchPendingNotifications(prisma, 1);
      await markNotificationFailed(prisma, row!.id, "attempt 1", 2);
      await markNotificationFailed(prisma, row!.id, "attempt 2", 2);
      const r = await prisma.notificationOutbox.findUnique({ where: { id: row!.id } });
      expect(r!.status).toBe("DEAD_LETTER");
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

    it("retryNotification resets a DEAD_LETTER row to PENDING/attempts:0, same as it already does for FAILED", async () => {
      const orderId = await seedOrder();
      await enqueueNotification(prisma, NotificationEvent.ORDER_DELIVERED, orderId, {});
      const [row] = await fetchPendingNotifications(prisma, 1);
      await markNotificationFailed(prisma, row!.id, "attempt 1", 2);
      await markNotificationFailed(prisma, row!.id, "attempt 2", 2);
      let r = await prisma.notificationOutbox.findUnique({ where: { id: row!.id } });
      expect(r!.status).toBe("DEAD_LETTER");

      const ok = await retryNotification(prisma, row!.id);
      expect(ok).toBe(true);
      r = await prisma.notificationOutbox.findUnique({ where: { id: row!.id } });
      expect(r!.status).toBe("PENDING");
      expect(r!.attempts).toBe(0);
      expect(r!.nextRetryAt).toBeNull();
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

describe("getNotification", () => {
  it("returns just the event type for an existing outbox row", async () => {
    const orderId = await seedOrder();
    await enqueueNotification(prisma, NotificationEvent.ORDER_DELIVERED, orderId, {});
    const [row] = await fetchPendingNotifications(prisma, 1);
    const found = await getNotification(prisma, row!.id);
    expect(found).toEqual({ event: NotificationEvent.ORDER_DELIVERED });
  });

  it("returns null for a notification that doesn't exist", async () => {
    expect(await getNotification(prisma, 999999)).toBeNull();
  });
});

describe("outboxStatusCounts", () => {
  it("buckets DEAD_LETTER separately from FAILED", async () => {
    const deadLetterOrder = await seedOrder();
    await enqueueNotification(prisma, NotificationEvent.ORDER_DELIVERED, deadLetterOrder, {});
    const [deadLetterRow] = await fetchPendingNotifications(prisma, 1);
    await markNotificationFailed(prisma, deadLetterRow!.id, "attempt 1", 2);
    await markNotificationFailed(prisma, deadLetterRow!.id, "attempt 2", 2);

    const failedOrder = await seedOrder();
    await enqueueNotification(prisma, NotificationEvent.ORDER_DELIVERED, failedOrder, {});
    const [failedRow] = await fetchPendingNotifications(prisma, 1);
    await markNotificationFailed(prisma, failedRow!.id, "no template", 1);

    const [deadLetterAfter, failedAfter] = await Promise.all([
      prisma.notificationOutbox.findUnique({ where: { id: deadLetterRow!.id } }),
      prisma.notificationOutbox.findUnique({ where: { id: failedRow!.id } }),
    ]);
    expect(deadLetterAfter!.status).toBe("DEAD_LETTER");
    expect(failedAfter!.status).toBe("FAILED");

    const counts = await outboxStatusCounts(prisma);
    expect(counts.DEAD_LETTER).toBeGreaterThanOrEqual(1);
    expect(counts.FAILED).toBeGreaterThanOrEqual(1);
    // Same-cause rows landed in different buckets — proves DEAD_LETTER and
    // FAILED are counted separately, not collapsed into one status.
    const grouped = await prisma.notificationOutbox.groupBy({ by: ["status"], _count: { _all: true } });
    const dl = grouped.find((g) => g.status === "DEAD_LETTER")!;
    const fl = grouped.find((g) => g.status === "FAILED")!;
    expect(counts.DEAD_LETTER).toBe(dl._count._all);
    expect(counts.FAILED).toBe(fl._count._all);
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

// Backend audit (Task B1.2): a dispatcher whose send outlived STALE_CLAIM_MS
// has lost its claim — a second dispatcher may have reclaimed the row. The
// slow one's late SENT/FAILED/release write must not clobber the new
// claimer's state, so every post-send write can be guarded by the claim
// timestamp the caller claimed with.
describe("outbox writes are guarded by claim ownership (Task B1.2)", () => {
  async function claimedTwice() {
    const orderId = await seedOrder();
    await enqueueNotification(prisma, NotificationEvent.ORDER_DELIVERED, orderId, {});
    const [row] = await fetchPendingNotifications(prisma, 1);
    const firstClaim = new Date(Date.now() - STALE_CLAIM_MS - 60_000);
    expect(await claimNotification(prisma, row!.id, firstClaim)).toBe(true);
    // The first claim went stale; a second dispatcher reclaims the row.
    const secondClaim = new Date();
    expect(await claimNotification(prisma, row!.id, secondClaim)).toBe(true);
    return { id: row!.id, firstClaim, secondClaim };
  }

  it("markNotificationSent with a lost claim is a no-op and reports false", async () => {
    const { id, firstClaim, secondClaim } = await claimedTwice();
    expect(await markNotificationSent(prisma, id, firstClaim)).toBe(false);
    const r = await prisma.notificationOutbox.findUnique({ where: { id } });
    expect(r!.status).toBe("SENDING");
    expect(r!.claimedAt!.getTime()).toBe(secondClaim.getTime());
  });

  it("markNotificationSent with the current claim marks the row SENT and reports true", async () => {
    const { id, secondClaim } = await claimedTwice();
    expect(await markNotificationSent(prisma, id, secondClaim)).toBe(true);
    const r = await prisma.notificationOutbox.findUnique({ where: { id } });
    expect(r!.status).toBe("SENT");
  });

  it("markNotificationFailed with a lost claim neither counts an attempt nor releases the new claimer's row", async () => {
    const { id, firstClaim, secondClaim } = await claimedTwice();
    await markNotificationFailed(prisma, id, "late failure", 5, new Date(), firstClaim);
    const r = await prisma.notificationOutbox.findUnique({ where: { id } });
    expect(r!.status).toBe("SENDING");
    expect(r!.attempts).toBe(0);
    expect(r!.claimedAt!.getTime()).toBe(secondClaim.getTime());
  });

  it("releaseNotificationClaim with a lost claim leaves the new claimer's row alone", async () => {
    const { id, firstClaim, secondClaim } = await claimedTwice();
    await releaseNotificationClaim(prisma, id, firstClaim);
    const r = await prisma.notificationOutbox.findUnique({ where: { id } });
    expect(r!.status).toBe("SENDING");
    expect(r!.claimedAt!.getTime()).toBe(secondClaim.getTime());
  });

  it("releaseNotificationClaimWithBackoff with a lost claim leaves the new claimer's row alone", async () => {
    const { id, firstClaim, secondClaim } = await claimedTwice();
    await releaseNotificationClaimWithBackoff(prisma, id, new Date(), firstClaim);
    const r = await prisma.notificationOutbox.findUnique({ where: { id } });
    expect(r!.status).toBe("SENDING");
    expect(r!.attempts).toBe(0);
    expect(r!.claimedAt!.getTime()).toBe(secondClaim.getTime());
  });

  it("markNotificationFailed counts concurrent failures atomically (no lost update)", async () => {
    const ids: number[] = [];
    for (let i = 0; i < 5; i++) {
      const n = await prisma.notificationOutbox.create({
        data: { event: NotificationEvent.ORDER_DELIVERED, orderId: null, payloadJson: "{}" },
      });
      ids.push(n.id);
    }
    await Promise.all(
      ids.flatMap((id) => Array.from({ length: 4 }, (_, k) => markNotificationFailed(prisma, id, `parallel ${k}`, 100))),
    );
    const rows = await prisma.notificationOutbox.findMany({ where: { id: { in: ids } } });
    expect(rows.map((r) => r.attempts)).toEqual([4, 4, 4, 4, 4]);
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

// Task B fix round: the missing-amount reason reuses ADMIN_UNCONFIRMABLE_PAYMENT
// with its own dedupe key, so repeated calls tell each admin once and neither
// reason's alert can swallow the other's for the same order.
describe("enqueueAdminUnconfirmablePayment reasons", () => {
  it("dedupes per (order, admin, reason) and keeps the no-trx-id alert separate from the missing-amount one", async () => {
    const orderId = await seedOrder();
    const args = { orderId, orderCode: "ORD-UNCONF", gateway: "PayDisini", reason: "missing_amount" as const };
    await enqueueAdminUnconfirmablePayment(prisma, args);
    await enqueueAdminUnconfirmablePayment(prisma, args);
    const where = { event: NotificationEvent.ADMIN_UNCONFIRMABLE_PAYMENT, orderId };
    const rows = await prisma.notificationOutbox.findMany({ where });
    expect(rows.map((r) => (JSON.parse(r.payloadJson) as { chat_id: number }).chat_id).sort((a, b) => a - b)).toEqual([4001, 4002, 4501, 4502]);
    expect((JSON.parse(rows[0]!.payloadJson) as { reason?: string }).reason).toBe("missing_amount");

    await enqueueAdminUnconfirmablePayment(prisma, { orderId, orderCode: "ORD-UNCONF", gateway: "PayDisini" });
    const all = await prisma.notificationOutbox.findMany({ where });
    expect(all).toHaveLength(8);
    expect(all.filter((r) => (JSON.parse(r.payloadJson) as { reason?: string }).reason === undefined)).toHaveLength(4);
  });
});

// Task 10: enqueueAdminDigiflazzResyncAborted shares enqueueAdminStalePayment's
// exact per-admin fan-out shape, just orderId: null (catalog-wide, not
// order-scoped) — this block only asserts this function's own event/payload
// shape. Runs after the earlier blocks, so 4001/4002/4501/4502 are already
// persisted in the shared `admin_ids` Setting.
describe("enqueueAdminDigiflazzResyncAborted", () => {
  it("enqueues one ADMIN_DIGIFLAZZ_RESYNC_ABORTED DM per resolved admin, with orderId null and chat_id/kind/sharp_changes/considered_rows for the sharp_change kind", async () => {
    await enqueueAdminDigiflazzResyncAborted(prisma, { kind: "sharp_change", sharpChanges: 7, consideredRows: 10 });

    const rows = await prisma.notificationOutbox.findMany({
      where: { event: NotificationEvent.ADMIN_DIGIFLAZZ_RESYNC_ABORTED },
    });
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.orderId === null)).toBe(true);
    const chatIds = rows.map((r) => (JSON.parse(r.payloadJson) as { chat_id: number }).chat_id).sort((a, b) => a - b);
    expect(chatIds).toEqual([4001, 4002, 4501, 4502]);
    const payload = JSON.parse(rows[0]!.payloadJson) as { kind: string; sharp_changes: number; considered_rows: number };
    expect(payload.kind).toBe("sharp_change");
    expect(payload.sharp_changes).toBe(7);
    expect(payload.considered_rows).toBe(10);
  });

  it("enqueues a no_usable_rows payload without sharp_changes/considered_rows", async () => {
    await enqueueAdminDigiflazzResyncAborted(prisma, { kind: "no_usable_rows" });

    const rows = await prisma.notificationOutbox.findMany({
      where: { event: NotificationEvent.ADMIN_DIGIFLAZZ_RESYNC_ABORTED },
      // Postgres doesn't guarantee row order without ORDER BY (unlike SQLite's
      // old single-writer setup, which happened to preserve insertion order) —
      // without this, .slice(-4) below can pick up the sharp_change test's
      // rows instead of this test's own.
      orderBy: { id: "asc" },
    });
    const newestRows = rows.slice(-4); // this test's own fan-out, appended after the sharp_change test's rows
    expect(newestRows.length).toBeGreaterThan(0);
    for (const row of newestRows) {
      expect(row.orderId).toBeNull();
      const payload = JSON.parse(row.payloadJson) as { kind: string; sharp_changes?: number; considered_rows?: number };
      expect(payload.kind).toBe("no_usable_rows");
      expect(payload.sharp_changes).toBeUndefined();
      expect(payload.considered_rows).toBeUndefined();
    }
  });
});

// Task 2 (Phase C): the three ticket-notification events that used to call
// ctx.api.sendMessage() directly from apps/order-bot (conversations/
// support.ts, conversations/admin.ts, handlers/admin.ts) — these tests assert
// the exact payload shape each enqueue* helper writes; dispatcher.test.ts
// (packages/outbox-dispatcher) covers the render/keyboard/send side end to
// end. Runs after enqueueAdminDigiflazzResyncAborted's block, so
// 4001/4002/4501/4502 are already persisted in the shared `admin_ids`
// Setting — enqueueAdminNewTicketDm fans out to that full resolved set, same
// as every other admin fan-out helper tested above.
describe("enqueueAdminNewTicketDm", () => {
  it("enqueues one ADMIN_NEW_TICKET DM per resolved admin, with orderId null and chat_id/ticket_id/from_user_id/from_username/message/photo_file_ids", async () => {
    await enqueueAdminNewTicketDm(prisma, {
      ticketId: 9001,
      fromUserId: 555_000_001,
      fromUsername: "buyer1",
      message: "I need help",
      photoFileIds: ["file_a", "file_b"],
    });

    const rows = await prisma.notificationOutbox.findMany({ where: { event: NotificationEvent.ADMIN_NEW_TICKET } });
    const matching = rows.filter((r) => (JSON.parse(r.payloadJson) as { ticket_id: number }).ticket_id === 9001);
    expect(matching.length).toBeGreaterThan(0);
    expect(matching.every((r) => r.orderId === null)).toBe(true);
    const chatIds = matching.map((r) => (JSON.parse(r.payloadJson) as { chat_id: number }).chat_id).sort((a, b) => a - b);
    expect(chatIds).toEqual([4001, 4002, 4501, 4502]);
    const payload = JSON.parse(matching[0]!.payloadJson) as Record<string, unknown>;
    expect(payload.from_user_id).toBe(555_000_001);
    expect(payload.from_username).toBe("buyer1");
    expect(payload.message).toBe("I need help");
    expect(payload.photo_file_ids).toEqual(["file_a", "file_b"]);
  });

  it("carries photo_file_ids as an empty array (not omitted) and from_username as null when the ticket has neither", async () => {
    await enqueueAdminNewTicketDm(prisma, {
      ticketId: 9002,
      fromUserId: 555_000_002,
      fromUsername: null,
      message: "No photos here",
      photoFileIds: [],
    });

    const rows = await prisma.notificationOutbox.findMany({ where: { event: NotificationEvent.ADMIN_NEW_TICKET } });
    const matching = rows.filter((r) => (JSON.parse(r.payloadJson) as { ticket_id: number }).ticket_id === 9002);
    expect(matching.length).toBeGreaterThan(0);
    const payload = JSON.parse(matching[0]!.payloadJson) as Record<string, unknown>;
    expect(payload.from_username).toBeNull();
    expect(payload.photo_file_ids).toEqual([]);
  });
});

describe("enqueueTicketReplyDm", () => {
  it("writes one TICKET_REPLY_DM row with orderId null and exactly chat_id/ticket_id/message", async () => {
    await enqueueTicketReplyDm(prisma, { ticketId: 9101, chatId: 620_001, message: "We refunded your order." });

    const row = await prisma.notificationOutbox.findFirst({
      where: { event: NotificationEvent.TICKET_REPLY_DM, payloadJson: { contains: '"ticket_id":9101,' } },
    });
    expect(row).toBeDefined();
    expect(row!.orderId).toBeNull();
    const payload = JSON.parse(row!.payloadJson) as Record<string, unknown>;
    expect(payload).toEqual({ chat_id: 620_001, ticket_id: 9101, message: "We refunded your order." });
  });
});

describe("enqueueTicketClosedDm", () => {
  it("writes one TICKET_CLOSED_DM row with orderId null and exactly chat_id/ticket_id/buyer_language normalized via langCode", async () => {
    await enqueueTicketClosedDm(prisma, { ticketId: 9201, chatId: 620_002, buyerLanguage: "id" });

    const row = await prisma.notificationOutbox.findFirst({
      where: { event: NotificationEvent.TICKET_CLOSED_DM, payloadJson: { contains: '"ticket_id":9201,' } },
    });
    expect(row).toBeDefined();
    expect(row!.orderId).toBeNull();
    const payload = JSON.parse(row!.payloadJson) as Record<string, unknown>;
    expect(payload).toEqual({ chat_id: 620_002, ticket_id: 9201, buyer_language: "id" });
  });

  it("normalizes a null buyerLanguage to 'en' via langCode", async () => {
    await enqueueTicketClosedDm(prisma, { ticketId: 9202, chatId: 620_003, buyerLanguage: null });

    const row = await prisma.notificationOutbox.findFirst({
      where: { event: NotificationEvent.TICKET_CLOSED_DM, payloadJson: { contains: '"ticket_id":9202,' } },
    });
    const payload = JSON.parse(row!.payloadJson) as Record<string, unknown>;
    expect(payload.buyer_language).toBe("en");
  });
});

describe("enqueueWalletTopupCreditedDm", () => {
  it("writes one WALLET_TOPUP_CREDITED_DM row with orderId/order_code set and money stringified via Decimal.toString()", async () => {
    const orderId = await seedOrder();

    await enqueueWalletTopupCreditedDm(prisma, {
      orderId,
      orderCode: "ORD-TOPUP-8001",
      chatId: 8001,
      amount: new Decimal("50000"),
      currency: "IDR",
      newBalance: new Decimal("125000"),
    });

    const rows = await prisma.notificationOutbox.findMany({
      where: { event: NotificationEvent.WALLET_TOPUP_CREDITED_DM, orderId },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.orderId).toBe(orderId);
    const payload = JSON.parse(rows[0]!.payloadJson) as Record<string, unknown>;
    expect(payload).toEqual({
      chat_id: 8001,
      order_code: "ORD-TOPUP-8001",
      amount: "50000",
      currency: "IDR",
      new_balance: "125000",
    });
    expect(typeof payload.amount).toBe("string");
    expect(typeof payload.new_balance).toBe("string");
  });

  it("carries a USDT top-up's amount/balance as plain decimal strings too", async () => {
    const orderId = await seedOrder();

    await enqueueWalletTopupCreditedDm(prisma, {
      orderId,
      orderCode: "ORD-TOPUP-8002",
      chatId: 8002,
      amount: new Decimal("10.5"),
      currency: "USDT",
      newBalance: new Decimal("30.25"),
    });

    const row = await prisma.notificationOutbox.findFirst({
      where: { event: NotificationEvent.WALLET_TOPUP_CREDITED_DM, orderId },
    });
    const payload = JSON.parse(row!.payloadJson) as Record<string, unknown>;
    expect(payload.order_code).toBe("ORD-TOPUP-8002");
    expect(payload.amount).toBe("10.5");
    expect(payload.currency).toBe("USDT");
    expect(payload.new_balance).toBe("30.25");
  });

  // E5 item 1: the DB-level backstop under "one top-up DM per order". The
  // atomic claim in `settleWalletTopup` is still the primary guard and still
  // the reason this has exactly one call site — this pins what happens if that
  // guard is ever bypassed, which is the scenario a UNIQUE key exists for.
  it("writes nothing on a second enqueue for the same order, instead of a second row", async () => {
    const orderId = await seedOrder();
    const args = {
      orderId,
      orderCode: "ORD-TOPUP-8003",
      chatId: 8003,
      amount: new Decimal("1000"),
      currency: "IDR",
      newBalance: new Decimal("11000"),
    };

    await enqueueWalletTopupCreditedDm(prisma, args);
    await expect(enqueueWalletTopupCreditedDm(prisma, args)).resolves.toBeUndefined();

    const rows = await prisma.notificationOutbox.findMany({
      where: { event: NotificationEvent.WALLET_TOPUP_CREDITED_DM, orderId },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.dedupeKey).toBe(`topup-credited:${orderId}`);
  });

  it("still writes a row per order — the key is order-scoped, not global", async () => {
    const first = await seedOrder();
    const second = await seedOrder();
    const args = { chatId: 8004, amount: new Decimal("1000"), currency: "IDR", newBalance: new Decimal("2000") };

    await enqueueWalletTopupCreditedDm(prisma, { ...args, orderId: first, orderCode: "ORD-TOPUP-8004" });
    await enqueueWalletTopupCreditedDm(prisma, { ...args, orderId: second, orderCode: "ORD-TOPUP-8005" });

    const rows = await prisma.notificationOutbox.findMany({
      where: { event: NotificationEvent.WALLET_TOPUP_CREDITED_DM, orderId: { in: [first, second] } },
    });
    expect(rows).toHaveLength(2);
  });
});

// E5 item 1: `dedupeKey` is opt-in. These pin the two halves of that — an
// unkeyed enqueue must keep repeating freely (the per-admin fan-out events and
// the per-recipient broadcasts depend on it, and ORDER_DELIVERED_DM depends on
// it for admin credential resend), and a keyed one must collapse.
describe("enqueueNotification dedupeKey", () => {
  it("leaves dedupeKey null and allows unlimited repeats when no key is given", async () => {
    const orderId = await seedOrder();

    await enqueueNotification(prisma, NotificationEvent.ORDER_DELIVERED_DM, orderId, { chat_id: 1 });
    await enqueueNotification(prisma, NotificationEvent.ORDER_DELIVERED_DM, orderId, { chat_id: 1 });
    await enqueueNotification(prisma, NotificationEvent.ORDER_DELIVERED_DM, orderId, { chat_id: 1 });

    const rows = await prisma.notificationOutbox.findMany({
      where: { event: NotificationEvent.ORDER_DELIVERED_DM, orderId },
    });
    expect(rows).toHaveLength(3);
    expect(rows.every((r) => r.dedupeKey === null)).toBe(true);
  });

  it("swallows the collision on a repeated key, keeping the FIRST row's payload", async () => {
    const orderId = await seedOrder();

    await enqueueNotification(prisma, NotificationEvent.ORDER_DELIVERED_DM, orderId, { attempt: "first" }, "k:1");
    await enqueueNotification(prisma, NotificationEvent.ORDER_DELIVERED_DM, orderId, { attempt: "second" }, "k:1");

    const rows = await prisma.notificationOutbox.findMany({ where: { dedupeKey: "k:1" } });
    expect(rows).toHaveLength(1);
    expect(JSON.parse(rows[0]!.payloadJson).attempt).toBe("first");
  });

  it("still throws on a real failure — a keyed enqueue for an order that does not exist", async () => {
    // Proves the catch is narrow: it swallows the dedupe collision only, not
    // every error that happens to arrive while a key was passed. A missing
    // orderId is a foreign-key violation, not a unique one.
    await expect(
      enqueueNotification(prisma, NotificationEvent.ORDER_DELIVERED_DM, 999_999, { chat_id: 1 }, "k:missing-order"),
    ).rejects.toThrow();
  });

  // PG-migration landmine (see enqueueNotification's doc comment): under
  // SQLite, a caught UNIQUE violation mid-transaction didn't poison the rest
  // of the transaction, so catch-and-continue was safe even when the caller
  // passed `tx`. Under Postgres, ANY constraint violation aborts the whole
  // transaction (25P02) — every later statement on that `tx` fails, even one
  // that has nothing to do with the collision. This is reachable on the real
  // settlement path: enqueueWalletTopupCreditedDm is called from
  // settleWalletTopup inside prisma.$transaction(...) in all six top-up
  // rails, so a dedupe-key collision there must not take down the settlement
  // that triggered it.
  it("a dedupe-key collision inside an open $transaction does not poison later writes on the same tx", async () => {
    const orderId = await seedOrder();

    await prisma.$transaction(async (tx) => {
      await enqueueNotification(tx, NotificationEvent.WALLET_TOPUP_CREDITED_DM, orderId, { attempt: "first" }, "dupe-key");
      // Second call collides on the same dedupeKey — must be swallowed
      // without leaving the transaction aborted.
      await enqueueNotification(tx, NotificationEvent.WALLET_TOPUP_CREDITED_DM, orderId, { attempt: "second" }, "dupe-key");

      // A later, unrelated write on the SAME tx must still succeed — proves
      // the transaction was not poisoned by the collision above.
      await tx.notificationOutbox.create({
        data: {
          event: NotificationEvent.WALLET_TOPUP_CREDITED_DM,
          orderId,
          payloadJson: JSON.stringify({ attempt: "unrelated-followup" }),
          dedupeKey: "dupe-key-followup",
        },
      });
    });

    const rows = await prisma.notificationOutbox.findMany({
      where: { orderId, event: NotificationEvent.WALLET_TOPUP_CREDITED_DM },
      orderBy: { id: "asc" },
    });
    expect(rows).toHaveLength(2);
    expect(rows[0]!.dedupeKey).toBe("dupe-key");
    expect(JSON.parse(rows[0]!.payloadJson).attempt).toBe("first");
    expect(rows[1]!.dedupeKey).toBe("dupe-key-followup");
  });

  it("logs NOTIFICATION_CREATED exactly once on a same-payload collision, not once per call", async () => {
    // The realistic collision case for the two real dedupeKey call sites
    // (enqueueWalletTopupCreditedDm, enqueueAdminUnconfirmablePayment): a
    // retry of the same underlying order/admin state produces a
    // byte-identical payload, not a different one. A payload-equality
    // heuristic can't distinguish "this call inserted the row" from "this
    // call collided with an identical payload" — only a precise
    // insert/no-insert signal can. Pins that the second call does NOT log
    // NOTIFICATION_CREATED even though its payload matches the first row's.
    const orderId = await seedOrder();
    const infoSpy = vi.spyOn(logger, "info").mockImplementation(() => undefined as never);
    try {
      await enqueueNotification(prisma, NotificationEvent.ORDER_DELIVERED_DM, orderId, { attempt: "same" }, "k:same-payload");
      await enqueueNotification(prisma, NotificationEvent.ORDER_DELIVERED_DM, orderId, { attempt: "same" }, "k:same-payload");

      const rows = await prisma.notificationOutbox.findMany({ where: { dedupeKey: "k:same-payload" } });
      expect(rows).toHaveLength(1);

      const createdCalls = infoSpy.mock.calls.filter(
        ([meta]) => (meta as { event?: string })?.event === "NOTIFICATION_CREATED",
      );
      expect(createdCalls).toHaveLength(1);
    } finally {
      infoSpy.mockRestore();
    }
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

  it("renders each recipient's prices with pricesForRecipient(preferredCurrency), keeping the admin Broadcast row on the shop prices", async () => {
    await prisma.user.updateMany({ data: { banned: true } }); // neutralize leftovers from earlier tests
    const usd = await prisma.user.create({
      data: { telegramId: BigInt(7_100_001), referralCode: `r${Math.random()}`, preferredCurrency: "USD" },
    });
    const idr = await prisma.user.create({
      data: { telegramId: BigInt(7_100_002), referralCode: `r${Math.random()}`, preferredCurrency: "IDR" },
    });
    const unset = await prisma.user.create({
      data: { telegramId: BigInt(7_100_003), referralCode: `r${Math.random()}` },
    });
    const seen: Array<string | null> = [];

    const notified = await enqueueFlashSaleBroadcast(prisma, {
      ...sale,
      pricesForRecipient: (cur) => {
        seen.push(cur);
        return cur === "USD"
          ? { oldPrice: "$3.13", newPrice: "$2.35" }
          : { oldPrice: "Rp50.000", newPrice: "Rp37.500" };
      },
    });

    expect(notified).toBe(3);
    expect(seen.sort()).toEqual(["IDR", "USD", null].sort());
    const rows = await prisma.notificationOutbox.findMany({ where: { event: NotificationEvent.FLASH_SALE_BROADCAST } });
    const byChat = new Map(
      rows.map((r) => {
        const p = JSON.parse(r.payloadJson) as { chat_id: number; old_price: string; new_price: string };
        return [p.chat_id, p] as const;
      }),
    );
    expect(byChat.get(Number(usd.telegramId))).toMatchObject({ old_price: "$3.13", new_price: "$2.35" });
    expect(byChat.get(Number(idr.telegramId))).toMatchObject({ old_price: "Rp50.000", new_price: "Rp37.500" });
    expect(byChat.get(Number(unset.telegramId))).toMatchObject({ old_price: "Rp50.000", new_price: "Rp37.500" });
    const bc = await prisma.broadcast.findFirst({ orderBy: { id: "desc" } });
    expect(bc!.message).toContain("Rp37.500");
    expect(bc!.message).not.toContain("$");
  });

  it("passes each recipient's stored language to pricesForRecipient so their DM uses its separators", async () => {
    await prisma.user.updateMany({ data: { banned: true } }); // neutralize leftovers from earlier tests
    const english = await prisma.user.create({
      data: { telegramId: BigInt(7_200_001), referralCode: `r${Math.random()}`, preferredCurrency: "IDR", language: "EN" },
    });
    const indonesian = await prisma.user.create({
      data: { telegramId: BigInt(7_200_002), referralCode: `r${Math.random()}`, preferredCurrency: "IDR", language: "ID" },
    });
    const seen: string[] = [];

    await enqueueFlashSaleBroadcast(prisma, {
      ...sale,
      pricesForRecipient: (cur, language) => {
        seen.push(`${cur}|${language}`);
        return language === "id"
          ? { oldPrice: "Rp50.000", newPrice: "Rp37.500" }
          : { oldPrice: "Rp50,000", newPrice: "Rp37,500" };
      },
    });

    expect(seen.sort()).toEqual(["IDR|en", "IDR|id"]);
    const rows = await prisma.notificationOutbox.findMany({ where: { event: NotificationEvent.FLASH_SALE_BROADCAST } });
    const byChat = new Map(rows.map((r) => {
      const p = JSON.parse(r.payloadJson) as { chat_id: number; new_price: string; buyer_language: string };
      return [p.chat_id, p] as const;
    }));
    expect(byChat.get(Number(english.telegramId))).toMatchObject({ new_price: "Rp37,500", buyer_language: "en" });
    expect(byChat.get(Number(indonesian.telegramId))).toMatchObject({ new_price: "Rp37.500", buyer_language: "id" });
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
    expect(broadcastRow!.claimedAt).not.toBeNull();

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

  // H-7 follow-up fix #2 (backend audit 2026-07-31/08-01): a second review
  // pass found that the terminal SENT-flip written after the chunk loop was a
  // bare, unguarded `db.broadcast.update(...)` — if THAT write itself failed
  // (plausible under the same SQLite writer contention this whole task exists
  // to relieve), the row was left stuck in SENDING forever, because the row
  // was created without `claimedAt`, making it invisible to
  // reapStaleBroadcasts's `claimedAt: { lt: staleCutoff }` filter (NULL never
  // compares less-than anything). This test simulates exactly that: every
  // customer is genuinely enqueued, but the final status-flip write fails.
  it("still returns the full recipient count when only the terminal SENT-flip write fails, and the resulting stuck-SENDING row is reclaimable by reapStaleBroadcasts", async () => {
    await prisma.user.updateMany({ data: { banned: true } }); // neutralize leftovers from earlier tests
    const RECIPIENT_COUNT = 5;
    const TELEGRAM_ID_BASE = 9_600_000;
    await prisma.user.createMany({
      data: Array.from({ length: RECIPIENT_COUNT }, (_, i) => ({
        telegramId: BigInt(TELEGRAM_ID_BASE + i),
        referralCode: `flash-sentflip-fail-${i}`,
        banned: false,
      })),
    });

    const failingDb = {
      user: prisma.user,
      notificationOutbox: prisma.notificationOutbox,
      broadcast: {
        create: (args: Parameters<PrismaClient["broadcast"]["create"]>[0]) => prisma.broadcast.create(args),
        update: (args: Parameters<PrismaClient["broadcast"]["update"]>[0]) => {
          // Only fail the terminal SENT-flip — let the per-chunk sentCount
          // increments through, same as a real run would experience.
          if ((args.data as { status?: unknown }).status === "SENT") {
            throw new Error("simulated terminal SENT-flip write failure");
          }
          return prisma.broadcast.update(args);
        },
      },
    } as unknown as PrismaClient;

    // The function does NOT throw over this — delivery itself succeeded.
    const notified = await enqueueFlashSaleBroadcast(failingDb, sale);
    expect(notified).toBe(RECIPIENT_COUNT);

    const stuck = await prisma.broadcast.findFirst({ orderBy: { id: "desc" } });
    expect(stuck!.status).toBe("SENDING"); // never got the SENT flip
    expect(stuck!.sentCount).toBe(RECIPIENT_COUNT); // but the real count landed
    expect(stuck!.claimedAt).not.toBeNull(); // the fix: this is what makes it reclaimable

    // Prove it's not just "has claimedAt set" but genuinely reclaimable via
    // the codebase's existing stale-claim safety net.
    const reaped = await reapStaleBroadcasts(prisma, new Date(Date.now() + BROADCAST_STALE_CLAIM_MS + 60_000));
    expect(reaped).toBeGreaterThanOrEqual(1);
    const after = await prisma.broadcast.findUnique({ where: { id: stuck!.id } });
    expect(after!.status).toBe("FAILED");
  });

  // Same follow-up fix — the double-fault case: the chunk loop fails AND the
  // catch block's own FAILED-flip write also fails. The original chunk error
  // must still be what propagates (not the secondary write failure masking
  // it), and the row must still end up reclaimable rather than silently lost.
  it("propagates the original chunk error (not a masking secondary error) when the FAILED-flip write also fails, and the row is still reclaimable", async () => {
    await prisma.user.updateMany({ data: { banned: true } });
    const RECIPIENT_COUNT = FLASH_SALE_BROADCAST_CHUNK_SIZE + 50;
    const TELEGRAM_ID_BASE = 9_700_000;
    await prisma.user.createMany({
      data: Array.from({ length: RECIPIENT_COUNT }, (_, i) => ({
        telegramId: BigInt(TELEGRAM_ID_BASE + i),
        referralCode: `flash-doublefault-${i}`,
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
      broadcast: {
        create: (args: Parameters<PrismaClient["broadcast"]["create"]>[0]) => prisma.broadcast.create(args),
        update: (args: Parameters<PrismaClient["broadcast"]["update"]>[0]) => {
          if ((args.data as { status?: unknown }).status === "FAILED") {
            throw new Error("simulated FAILED-flip write failure (double fault)");
          }
          return prisma.broadcast.update(args);
        },
      },
    } as unknown as PrismaClient;

    // The ORIGINAL chunk error propagates — not the double-fault's own error.
    await expect(enqueueFlashSaleBroadcast(failingDb, sale)).rejects.toThrow("simulated write failure on the 2nd chunk");

    const stuck = await prisma.broadcast.findFirst({ orderBy: { id: "desc" } });
    expect(stuck!.status).toBe("SENDING"); // the FAILED-flip never landed
    expect(stuck!.sentCount).toBe(FLASH_SALE_BROADCAST_CHUNK_SIZE); // first chunk's progress still visible
    expect(stuck!.claimedAt).not.toBeNull();

    const reaped = await reapStaleBroadcasts(prisma, new Date(Date.now() + BROADCAST_STALE_CLAIM_MS + 60_000));
    expect(reaped).toBeGreaterThanOrEqual(1);
    const after = await prisma.broadcast.findUnique({ where: { id: stuck!.id } });
    expect(after!.status).toBe("FAILED");
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

// enqueueOwner*Email — the EMAIL-channel owner-notification enqueue layer
// (design doc: docs/superpowers/specs/2026-08-06-owner-email-notifications-design.md).
// Each wrapper is gated by resolveOwnerEmailRecipient (ownerEmail.ts, already
// unit-tested against a stub Db in ownerEmail.test.ts): the master toggle, the
// event's own toggle, and a valid `owner_email` address must ALL be set, or
// nothing is enqueued at all — not a PENDING row that never gets a `to`. These
// tests exercise that gate against the real Setting table (via setSetting),
// not a stub, since notifications.test.ts already runs against makeTestDb().
const OWNER_EMAIL_SETTING_KEYS = [
  "owner_email_enabled",
  "owner_email",
  "owner_email_on_paid_order",
  "owner_email_on_manual_queue",
  "owner_email_on_new_ticket",
  "owner_email_on_ticket_reply",
  "owner_email_on_wallet_topup",
];

/** Master toggle + address on, plus the one event's own toggle on. */
async function configureOwnerEmail(event: "paid_order" | "manual_queue" | "new_ticket" | "ticket_reply" | "wallet_topup") {
  await setSetting(prisma, "owner_email_enabled", "true");
  await setSetting(prisma, "owner_email", "owner@example.com");
  await setSetting(prisma, `owner_email_on_${event}`, "true");
}

/** Strip every owner-email Setting so the feature is unconfigured/off. */
async function disableOwnerEmail() {
  for (const key of OWNER_EMAIL_SETTING_KEYS) await deleteSetting(prisma, key);
}

describe("enqueueOwner*Email (EMAIL-channel owner notifications)", () => {
  afterEach(async () => {
    await disableOwnerEmail();
  });

  /** Full args, every optional field populated — the "everything present"
   * fixture for the payload-shape assertions below. */
  function fullPaidOrderArgs(orderId: number, orderCode: string) {
    return {
      orderId,
      orderCode,
      total: new Decimal("199.90"),
      currency: "USDT",
      itemCount: 2,
      customerLabel: "john@example.com",
      items: [
        { name: "Netflix Premium", variant: "1 Month", quantity: 1, unitPrice: new Decimal("150.00") },
        { name: "Spotify", variant: null, quantity: 1, unitPrice: new Decimal("49.90") },
      ],
      subtotal: new Decimal("199.90"),
      discount: new Decimal("0"),
      paymentMethod: "TOKOPAY",
      transactionId: "TXN-12345",
      voucherCode: "SAVE10",
      paidAt: new Date("2026-08-07T10:00:00.000Z"),
      orderUrl: "https://admin.example.com/orders/1",
    };
  }

  it("enqueueOwnerOrderPaidEmail writes nothing when owner email is unconfigured", async () => {
    await disableOwnerEmail();
    const orderId = await seedOrder();
    const before = await prisma.notificationOutbox.count({ where: { event: NotificationEvent.OWNER_EMAIL_ORDER_PAID } });

    await enqueueOwnerOrderPaidEmail(prisma, fullPaidOrderArgs(orderId, "ORD-OWNERPAID-OFF"));

    expect(await prisma.notificationOutbox.count({ where: { event: NotificationEvent.OWNER_EMAIL_ORDER_PAID } })).toBe(before);
  });

  it("enqueueOwnerOrderPaidEmail writes one EMAIL row with the full expanded payload (money as strings) when configured", async () => {
    await configureOwnerEmail("paid_order");
    const orderId = await seedOrder();

    await enqueueOwnerOrderPaidEmail(prisma, fullPaidOrderArgs(orderId, "ORD-OWNERPAID-ON"));

    const rows = await prisma.notificationOutbox.findMany({
      where: { event: NotificationEvent.OWNER_EMAIL_ORDER_PAID, orderId },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.channel).toBe("EMAIL");
    const payload = JSON.parse(rows[0]!.payloadJson) as Record<string, unknown>;
    expect(payload).toEqual({
      to: "owner@example.com",
      order_code: "ORD-OWNERPAID-ON",
      total: "199.9",
      currency: "USDT",
      item_count: 2,
      customer_label: "john@example.com",
      items: [
        { name: "Netflix Premium", variant: "1 Month", quantity: 1, unitPrice: "150" },
        { name: "Spotify", variant: null, quantity: 1, unitPrice: "49.9" },
      ],
      subtotal: "199.9",
      discount: "0",
      payment_method: "TOKOPAY",
      transaction_id: "TXN-12345",
      voucher_code: "SAVE10",
      paid_at: "2026-08-07T10:00:00.000Z",
      order_url: "https://admin.example.com/orders/1",
    });
    expect(typeof payload.total).toBe("string");
    expect(typeof payload.subtotal).toBe("string");
    expect(typeof payload.discount).toBe("string");
    expect(typeof (payload.items as Array<{ unitPrice: unknown }>)[0]!.unitPrice).toBe("string");
  });

  it("enqueueOwnerOrderPaidEmail writes explicit JSON null for every optional field left unset — never omitted, never the string \"null\"", async () => {
    await configureOwnerEmail("paid_order");
    const orderId = await seedOrder();

    await enqueueOwnerOrderPaidEmail(prisma, {
      orderId,
      orderCode: "ORD-OWNERPAID-NULLS",
      total: new Decimal("50"),
      currency: "IDR",
      itemCount: 1,
      customerLabel: "Guest (no contact email)",
      items: [{ name: "Netflix Premium", variant: null, quantity: 1, unitPrice: new Decimal("50") }],
      subtotal: new Decimal("50"),
      discount: new Decimal("0"),
      paymentMethod: "BINANCE_PAY",
      transactionId: null,
      voucherCode: null,
      paidAt: new Date("2026-08-07T11:00:00.000Z"),
      orderUrl: null,
    });

    const row = await prisma.notificationOutbox.findFirst({
      where: { event: NotificationEvent.OWNER_EMAIL_ORDER_PAID, orderId },
    });
    const payload = JSON.parse(row!.payloadJson) as Record<string, unknown>;
    expect(payload.transaction_id).toBeNull();
    expect(payload.voucher_code).toBeNull();
    expect(payload.order_url).toBeNull();
    expect((payload.items as Array<{ variant: unknown }>)[0]!.variant).toBeNull();
    // Every one of these keys is PRESENT in the JSON (not omitted) — a bare
    // "in" check, since `payload.transaction_id === undefined` would also be
    // true for a key that was simply never written.
    expect("transaction_id" in payload).toBe(true);
    expect("voucher_code" in payload).toBe(true);
    expect("order_url" in payload).toBe(true);
  });

  it("enqueueOwnerManualQueueEmail writes nothing when owner email is unconfigured", async () => {
    await disableOwnerEmail();
    const orderId = await seedOrder();
    const before = await prisma.notificationOutbox.count({ where: { event: NotificationEvent.OWNER_EMAIL_MANUAL_ORDER_QUEUED } });

    await enqueueOwnerManualQueueEmail(prisma, {
      orderId,
      orderCode: "ORD-OWNERMANUAL-OFF",
      items: [{ name: "Netflix Premium", qty: 1 }],
      total: new Decimal("15.5"),
      currency: "USDT",
    });

    expect(
      await prisma.notificationOutbox.count({ where: { event: NotificationEvent.OWNER_EMAIL_MANUAL_ORDER_QUEUED } }),
    ).toBe(before);
  });

  it("enqueueOwnerManualQueueEmail writes one EMAIL row with to/order_code/items/total(string)/currency when configured", async () => {
    await configureOwnerEmail("manual_queue");
    const orderId = await seedOrder();

    await enqueueOwnerManualQueueEmail(prisma, {
      orderId,
      orderCode: "ORD-OWNERMANUAL-ON",
      items: [{ name: "Netflix Premium", qty: 2 }],
      total: new Decimal("15.50"),
      currency: "USDT",
    });

    const rows = await prisma.notificationOutbox.findMany({
      where: { event: NotificationEvent.OWNER_EMAIL_MANUAL_ORDER_QUEUED, orderId },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.channel).toBe("EMAIL");
    const payload = JSON.parse(rows[0]!.payloadJson) as Record<string, unknown>;
    expect(payload).toEqual({
      to: "owner@example.com",
      order_code: "ORD-OWNERMANUAL-ON",
      items: [{ name: "Netflix Premium", qty: 2 }],
      total: "15.5",
      currency: "USDT",
    });
    expect(typeof payload.total).toBe("string");
  });

  it("enqueueOwnerNewTicketEmail writes nothing when owner email is unconfigured", async () => {
    await disableOwnerEmail();
    const before = await prisma.notificationOutbox.count({ where: { event: NotificationEvent.OWNER_EMAIL_NEW_TICKET } });

    await enqueueOwnerNewTicketEmail(prisma, {
      ticketId: 1,
      userId: 1,
      category: "ORDER",
      message: "Where is my order?",
    });

    expect(await prisma.notificationOutbox.count({ where: { event: NotificationEvent.OWNER_EMAIL_NEW_TICKET } })).toBe(before);
  });

  it("enqueueOwnerNewTicketEmail writes one EMAIL row with orderId null and category/message when configured", async () => {
    await configureOwnerEmail("new_ticket");

    await enqueueOwnerNewTicketEmail(prisma, {
      ticketId: 42,
      userId: 7,
      category: "PAYMENT",
      message: "My payment was deducted twice.",
    });

    const rows = await prisma.notificationOutbox.findMany({
      where: { event: NotificationEvent.OWNER_EMAIL_NEW_TICKET },
      orderBy: { id: "desc" },
      take: 1,
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.channel).toBe("EMAIL");
    expect(rows[0]!.orderId).toBeNull();
    const payload = JSON.parse(rows[0]!.payloadJson) as Record<string, unknown>;
    expect(payload).toEqual({
      to: "owner@example.com",
      ticket_id: 42,
      user_id: 7,
      category: "PAYMENT",
      message: "My payment was deducted twice.",
    });
  });

  it("enqueueOwnerNewTicketEmail defaults category to null and truncates a long message to 500 chars", async () => {
    await configureOwnerEmail("new_ticket");

    await enqueueOwnerNewTicketEmail(prisma, {
      ticketId: 43,
      userId: 7,
      message: "x".repeat(1000),
    });

    const rows = await prisma.notificationOutbox.findMany({
      where: { event: NotificationEvent.OWNER_EMAIL_NEW_TICKET },
      orderBy: { id: "desc" },
      take: 1,
    });
    const payload = JSON.parse(rows[0]!.payloadJson) as { category: unknown; message: string };
    expect(payload.category).toBeNull();
    expect(payload.message.length).toBe(500);
  });

  it("enqueueOwnerTicketReplyEmail writes nothing when owner email is unconfigured", async () => {
    await disableOwnerEmail();
    const before = await prisma.notificationOutbox.count({ where: { event: NotificationEvent.OWNER_EMAIL_TICKET_REPLY } });

    await enqueueOwnerTicketReplyEmail(prisma, {
      ticketId: 1,
      userId: 1,
      message: "Any update?",
    });

    expect(await prisma.notificationOutbox.count({ where: { event: NotificationEvent.OWNER_EMAIL_TICKET_REPLY } })).toBe(before);
  });

  it("enqueueOwnerTicketReplyEmail writes one EMAIL row with orderId null, and truncates a long message to 500 chars, when configured", async () => {
    await configureOwnerEmail("ticket_reply");

    await enqueueOwnerTicketReplyEmail(prisma, {
      ticketId: 55,
      userId: 9,
      message: "y".repeat(700),
    });

    const rows = await prisma.notificationOutbox.findMany({
      where: { event: NotificationEvent.OWNER_EMAIL_TICKET_REPLY },
      orderBy: { id: "desc" },
      take: 1,
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.channel).toBe("EMAIL");
    expect(rows[0]!.orderId).toBeNull();
    const payload = JSON.parse(rows[0]!.payloadJson) as { to: string; ticket_id: number; user_id: number; message: string };
    expect(payload.to).toBe("owner@example.com");
    expect(payload.ticket_id).toBe(55);
    expect(payload.user_id).toBe(9);
    expect(payload.message.length).toBe(500);
  });

  it("enabling one event's owner-email toggle does not enable the others", async () => {
    await configureOwnerEmail("paid_order");
    const orderId = await seedOrder();

    const beforeManual = await prisma.notificationOutbox.count({ where: { event: NotificationEvent.OWNER_EMAIL_MANUAL_ORDER_QUEUED } });
    await enqueueOwnerManualQueueEmail(prisma, {
      orderId,
      orderCode: "ORD-CROSSCHECK",
      items: [{ name: "X", qty: 1 }],
      total: new Decimal("1"),
      currency: "IDR",
    });
    expect(
      await prisma.notificationOutbox.count({ where: { event: NotificationEvent.OWNER_EMAIL_MANUAL_ORDER_QUEUED } }),
    ).toBe(beforeManual);
  });

  function fullWalletTopupArgs(orderId: number, orderCode: string) {
    return {
      orderId,
      orderCode,
      customerLabel: "jane@example.com",
      amount: new Decimal("50000"),
      currency: "IDR",
      newBalance: new Decimal("125000"),
      paymentMethod: "TOKOPAY",
      transactionId: "TXN-TOPUP-1",
      toppedUpAt: new Date("2026-08-14T09:30:00.000Z"),
    };
  }

  it("enqueueOwnerWalletTopupEmail writes nothing when owner email is unconfigured", async () => {
    await disableOwnerEmail();
    const orderId = await seedOrder();
    const before = await prisma.notificationOutbox.count({ where: { event: NotificationEvent.OWNER_EMAIL_WALLET_TOPUP } });

    await enqueueOwnerWalletTopupEmail(prisma, fullWalletTopupArgs(orderId, "ORD-TOPUP-OFF"));

    expect(await prisma.notificationOutbox.count({ where: { event: NotificationEvent.OWNER_EMAIL_WALLET_TOPUP } })).toBe(before);
  });

  it("enqueueOwnerWalletTopupEmail writes one EMAIL row with the full payload (money as strings) when configured", async () => {
    await configureOwnerEmail("wallet_topup");
    const orderId = await seedOrder();

    await enqueueOwnerWalletTopupEmail(prisma, fullWalletTopupArgs(orderId, "ORD-TOPUP-ON"));

    const rows = await prisma.notificationOutbox.findMany({
      where: { event: NotificationEvent.OWNER_EMAIL_WALLET_TOPUP, orderId },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.channel).toBe("EMAIL");
    const payload = JSON.parse(rows[0]!.payloadJson) as Record<string, unknown>;
    expect(payload).toEqual({
      to: "owner@example.com",
      order_code: "ORD-TOPUP-ON",
      customer_label: "jane@example.com",
      amount: "50000",
      currency: "IDR",
      new_balance: "125000",
      payment_method: "TOKOPAY",
      transaction_id: "TXN-TOPUP-1",
      topped_up_at: "2026-08-14T09:30:00.000Z",
    });
    expect(typeof payload.amount).toBe("string");
    expect(typeof payload.new_balance).toBe("string");
  });

  it("enqueueOwnerWalletTopupEmail writes explicit JSON null for a missing transactionId — never omitted, never the string \"null\"", async () => {
    await configureOwnerEmail("wallet_topup");
    const orderId = await seedOrder();

    await enqueueOwnerWalletTopupEmail(prisma, { ...fullWalletTopupArgs(orderId, "ORD-TOPUP-NULLS"), transactionId: null });

    const rows = await prisma.notificationOutbox.findMany({
      where: { event: NotificationEvent.OWNER_EMAIL_WALLET_TOPUP, orderId },
    });
    expect(rows).toHaveLength(1);
    const payload = JSON.parse(rows[0]!.payloadJson) as Record<string, unknown>;
    expect(payload.transaction_id).toBeNull();
    expect("transaction_id" in payload).toBe(true);
  });

  it("enabling the wallet_topup owner-email toggle does not enable the others", async () => {
    await configureOwnerEmail("wallet_topup");
    const orderId = await seedOrder();

    const beforePaid = await prisma.notificationOutbox.count({ where: { event: NotificationEvent.OWNER_EMAIL_ORDER_PAID } });
    await enqueueOwnerOrderPaidEmail(prisma, {
      orderId,
      orderCode: "ORD-TOPUP-CROSSCHECK",
      total: new Decimal("1"),
      currency: "IDR",
      itemCount: 1,
      customerLabel: "x",
      items: [],
      subtotal: new Decimal("1"),
      discount: new Decimal("0"),
      paymentMethod: "TOKOPAY",
      transactionId: null,
      voucherCode: null,
      paidAt: new Date(),
      orderUrl: null,
    });
    expect(await prisma.notificationOutbox.count({ where: { event: NotificationEvent.OWNER_EMAIL_ORDER_PAID } })).toBe(beforePaid);
  });
});

/**
 * The one BUYER-facing EMAIL event, structurally unlike every
 * `enqueueOwner*Email` above it: no owner toggle, no Settings read at all —
 * the recipient is the caller's own argument. These tests pin that
 * difference down (no `configureOwnerEmail` call anywhere in this block, and
 * one case that proves the owner settings being fully OFF changes nothing),
 * because "tidying" this onto the owner path would silently make a buyer's
 * order-complete email depend on a shop-owner preference.
 */
describe("enqueueBuyerOrderReadyEmail (buyer-facing EMAIL notification)", () => {
  afterEach(async () => {
    await disableOwnerEmail();
  });

  function fullArgs(orderId: number, orderCode: string) {
    return {
      orderId,
      orderCode,
      to: "guest@example.com",
      items: [
        {
          name: "Netflix Premium",
          variant: "1 Month",
          quantity: 2,
          unitPrice: new Decimal("50.00"),
          lineTotal: new Decimal("100.00"),
        },
        {
          name: "Spotify",
          variant: null,
          quantity: 1,
          unitPrice: new Decimal("30.00"),
          lineTotal: new Decimal("30.00"),
        },
      ],
      // An IDR order: no conversion, and finalizeOrderPayment zeroes its
      // unique cents. 130 - 13 + 0 = 117, the identity this payload owes the
      // receipt.
      subtotal: new Decimal("130.00"),
      discount: new Decimal("13.00"),
      uniqueCents: new Decimal("0"),
      total: new Decimal("117.00"),
      currency: "IDR",
      warrantyDays: 30,
      orderUrl: "https://shop.example.com/checkout/ORD-1/pay",
      trackUrl: "https://shop.example.com/track",
    };
  }

  it("writes one EMAIL-channel row addressed to the caller's `to`, with money as strings", async () => {
    const orderId = await seedOrder();

    await enqueueBuyerOrderReadyEmail(prisma, fullArgs(orderId, "ORD-READY-FULL"));

    const rows = await prisma.notificationOutbox.findMany({
      where: { event: NotificationEvent.BUYER_EMAIL_ORDER_READY, orderId },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.channel).toBe("EMAIL");
    const payload = JSON.parse(rows[0]!.payloadJson) as Record<string, unknown>;
    expect(payload).toEqual({
      to: "guest@example.com",
      order_code: "ORD-READY-FULL",
      items: [
        { name: "Netflix Premium", variant: "1 Month", quantity: 2, unitPrice: "50", lineTotal: "100" },
        { name: "Spotify", variant: null, quantity: 1, unitPrice: "30", lineTotal: "30" },
      ],
      subtotal: "130",
      discount: "13",
      unique_cents: "0",
      total: "117",
      currency: "IDR",
      warranty_days: 30,
      order_url: "https://shop.example.com/checkout/ORD-1/pay",
      track_url: "https://shop.example.com/track",
    });
    expect(typeof payload.total).toBe("string");
    expect(typeof payload.subtotal).toBe("string");
    expect(typeof payload.discount).toBe("string");
    expect(typeof payload.unique_cents).toBe("string");
    expect(typeof (payload.items as Array<{ unitPrice: unknown }>)[0]!.unitPrice).toBe("string");
    expect(typeof (payload.items as Array<{ lineTotal: unknown }>)[0]!.lineTotal).toBe("string");
  });

  it("carries a non-zero unique-cents surcharge through as its own string field — it is money the buyer paid", async () => {
    const orderId = await seedOrder();

    await enqueueBuyerOrderReadyEmail(prisma, {
      ...fullArgs(orderId, "ORD-READY-UNIQUE"),
      currency: "USDT",
      subtotal: new Decimal("2.8"),
      discount: new Decimal("0.5"),
      uniqueCents: new Decimal("0.042"),
      total: new Decimal("2.342"),
    });

    const row = (await prisma.notificationOutbox.findMany({
      where: { event: NotificationEvent.BUYER_EMAIL_ORDER_READY, orderId },
    }))[0]!;
    const payload = JSON.parse(row.payloadJson) as Record<string, unknown>;
    expect(payload.unique_cents).toBe("0.042");
    // The identity the receipt is rendered from, on the enqueued figures.
    expect(
      new Decimal(String(payload.subtotal))
        .minus(String(payload.discount))
        .plus(String(payload.unique_cents))
        .toString(),
    ).toBe(payload.total);
  });

  it("enqueues regardless of the owner-email settings — it is the buyer's email, not the owner's", async () => {
    await disableOwnerEmail();
    const orderId = await seedOrder();

    await enqueueBuyerOrderReadyEmail(prisma, fullArgs(orderId, "ORD-READY-NOOWNER"));

    const rows = await prisma.notificationOutbox.findMany({
      where: { event: NotificationEvent.BUYER_EMAIL_ORDER_READY, orderId },
    });
    expect(rows).toHaveLength(1);
    expect((JSON.parse(rows[0]!.payloadJson) as { to: string }).to).toBe("guest@example.com");
  });

  it("never addresses the row to the configured owner_email, even when one is set", async () => {
    await setSetting(prisma, "owner_email_enabled", "true");
    await setSetting(prisma, "owner_email", "owner@example.com");
    const orderId = await seedOrder();

    await enqueueBuyerOrderReadyEmail(prisma, fullArgs(orderId, "ORD-READY-NOTOWNER"));

    const rows = await prisma.notificationOutbox.findMany({
      where: { event: NotificationEvent.BUYER_EMAIL_ORDER_READY, orderId },
    });
    expect(rows).toHaveLength(1);
    const payload = JSON.parse(rows[0]!.payloadJson) as { to: string };
    expect(payload.to).toBe("guest@example.com");
    expect(payload.to).not.toBe("owner@example.com");
    expect(rows[0]!.payloadJson).not.toContain("owner@example.com");
  });

  it("writes explicit JSON null for every optional field left unset — never omitted, never the string \"null\"", async () => {
    const orderId = await seedOrder();

    await enqueueBuyerOrderReadyEmail(prisma, {
      orderId,
      orderCode: "ORD-READY-NULLS",
      to: "guest@example.com",
      items: [
        { name: "Netflix Premium", variant: null, quantity: 1, unitPrice: new Decimal("50"), lineTotal: new Decimal("50") },
      ],
      subtotal: new Decimal("50"),
      discount: new Decimal("0"),
      uniqueCents: new Decimal("0"),
      total: new Decimal("50"),
      currency: "IDR",
      warrantyDays: null,
      orderUrl: null,
      trackUrl: null,
    });

    const row = (await prisma.notificationOutbox.findMany({
      where: { event: NotificationEvent.BUYER_EMAIL_ORDER_READY, orderId },
    }))[0]!;
    const payload = JSON.parse(row.payloadJson) as Record<string, unknown>;
    expect("warranty_days" in payload).toBe(true);
    expect("order_url" in payload).toBe(true);
    expect("track_url" in payload).toBe(true);
    expect(payload.warranty_days).toBeNull();
    expect(payload.order_url).toBeNull();
    expect(payload.track_url).toBeNull();
    expect(row.payloadJson).not.toContain('"null"');
    expect((payload.items as Array<{ variant: unknown }>)[0]!.variant).toBeNull();
  });

  // The single most important guard in this block: the outbox payload is
  // rendered in the admin /outbox panel, and this email exists precisely
  // BECAUSE credentials are never mailed. A field carrying delivered content
  // would leak the goods into both the admin panel and an inbox forever.
  it("carries no credential-bearing field — no delivered content anywhere in the row", async () => {
    const orderId = await seedOrder();

    await enqueueBuyerOrderReadyEmail(prisma, fullArgs(orderId, "ORD-READY-NOCREDS"));

    const row = (await prisma.notificationOutbox.findMany({
      where: { event: NotificationEvent.BUYER_EMAIL_ORDER_READY, orderId },
    }))[0]!;
    const payload = JSON.parse(row.payloadJson) as Record<string, unknown>;
    for (const forbidden of [
      "credentials",
      "deliveredContent",
      "delivered_content",
      "content",
      "stock_item",
      "stockItem",
      "password",
    ]) {
      expect(Object.keys(payload)).not.toContain(forbidden);
      expect(row.payloadJson).not.toContain(forbidden);
    }
  });
});

describe("enqueueRestockSubscriberNotifications / afterStockAdded", () => {
  async function seedSku(broadcastOnRestock = false) {
    const cat = await createCategory(prisma, `c${Math.random()}`);
    const parent = await createCatalogProduct(prisma, { categoryId: cat.id, name: "Netflix" });
    const denom = await createDenomination(prisma, {
      productId: parent.id,
      name: "1 Month",
      type: "SHARED",
      durationLabel: "1 Month",
      price: "5",
    });
    return prisma.denomination.update({ where: { id: denom.id }, data: { broadcastOnRestock } });
  }
  function mkUser(o: { telegramId?: bigint | null; banned?: boolean; language?: string }) {
    return prisma.user.create({
      data: {
        telegramId: o.telegramId === undefined ? BigInt(Math.floor(Math.random() * 1e15)) : o.telegramId,
        referralCode: `r${Math.random()}`,
        banned: o.banned ?? false,
        language: o.language ?? "EN",
      },
    });
  }
  const subEvents = (chatId: number) =>
    prisma.notificationOutbox
      .findMany({ where: { event: NotificationEvent.RESTOCK_SUBSCRIBER_NOTIFIED } })
      .then((rows) => rows.filter((r) => (JSON.parse(r.payloadJson) as { chat_id: number }).chat_id === chatId));

  it("enqueues one DM per actionable subscriber (buyer language kept) and consumes only those subscriptions", async () => {
    const denom = await seedSku();
    const ok = await mkUser({ language: "ID" });
    const webOnly = await mkUser({ telegramId: null });
    const banned = await mkUser({ banned: true });
    for (const u of [ok, webOnly, banned]) {
      await prisma.restockSubscription.create({ data: { userId: u.id, productId: denom.id } });
    }

    const n = await enqueueRestockSubscriberNotifications(prisma, denom.id);

    expect(n).toBe(1);
    const rows = await subEvents(Number(ok.telegramId));
    expect(rows).toHaveLength(1);
    expect(JSON.parse(rows[0]!.payloadJson)).toEqual({
      chat_id: Number(ok.telegramId),
      product_name: "Netflix - 1 Month",
      buyer_language: "id",
    });
    const left = await prisma.restockSubscription.findMany({ where: { productId: denom.id } });
    expect(left.map((s) => s.userId).sort()).toEqual([webOnly.id, banned.id].sort());
  });

  it("writes nothing when there is no actionable subscriber", async () => {
    const denom = await seedSku();
    const before = await prisma.notificationOutbox.count({ where: { event: NotificationEvent.RESTOCK_SUBSCRIBER_NOTIFIED } });
    expect(await enqueueRestockSubscriberNotifications(prisma, denom.id)).toBe(0);
    expect(await prisma.notificationOutbox.count({ where: { event: NotificationEvent.RESTOCK_SUBSCRIBER_NOTIFIED } })).toBe(before);
  });

  it("is atomic: when the caller's transaction rolls back, both the outbox rows and the deletions roll back", async () => {
    const denom = await seedSku();
    const u = await mkUser({});
    await prisma.restockSubscription.create({ data: { userId: u.id, productId: denom.id } });

    await expect(
      prisma.$transaction(async (tx) => {
        await enqueueRestockSubscriberNotifications(tx, denom.id);
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");

    expect(await subEvents(Number(u.telegramId))).toHaveLength(0);
    expect(await prisma.restockSubscription.count({ where: { productId: denom.id } })).toBe(1);
  });

  it("afterStockAdded joins the caller's transaction: stock, subscriber rows and deletions commit together", async () => {
    const denom = await seedSku();
    const u = await mkUser({});
    await prisma.restockSubscription.create({ data: { userId: u.id, productId: denom.id } });
    const admin = await prisma.user.create({ data: { referralCode: `a${Math.random()}`, role: "ADMIN" } });

    await prisma.$transaction(async (tx) => {
      const { added } = await bulkAddStock(tx, denom.id, [`joined${Math.random()}@x.com:pw`]);
      await afterStockAdded(tx, denom.id, added, admin.id);
    });

    expect(await prisma.stockItem.count({ where: { productId: denom.id } })).toBe(1);
    expect(await subEvents(Number(u.telegramId))).toHaveLength(1);
    expect(await prisma.restockSubscription.count({ where: { productId: denom.id } })).toBe(0);
  });

  it("rolls the stock add back when the notification step throws inside the same transaction", async () => {
    const denom = await seedSku(true);
    const u = await mkUser({});
    await prisma.restockSubscription.create({ data: { userId: u.id, productId: denom.id } });
    const admin = await prisma.user.create({ data: { referralCode: `a${Math.random()}`, role: "ADMIN" } });

    await expect(
      prisma.$transaction(async (tx) => {
        const { added } = await bulkAddStock(tx, denom.id, [`rollback${Math.random()}@x.com:pw`]);
        // Simulate the outbox write failing after the stock insert.
        tx.notificationOutbox.createMany = (() => {
          throw new Error("outbox write failed");
        }) as never;
        await afterStockAdded(tx, denom.id, added, admin.id);
      }),
    ).rejects.toThrow("outbox write failed");

    expect(await prisma.stockItem.count({ where: { productId: denom.id } })).toBe(0);
    expect(await prisma.restockSubscription.count({ where: { productId: denom.id } })).toBe(1);
  });

  it("afterStockAdded does nothing when no stock was added", async () => {
    const denom = await seedSku(true);
    const u = await mkUser({});
    await prisma.restockSubscription.create({ data: { userId: u.id, productId: denom.id } });
    const admin = await prisma.user.create({ data: { referralCode: `a${Math.random()}`, role: "ADMIN" } });

    const res = await afterStockAdded(prisma, denom.id, 0, admin.id);

    expect(res).toEqual({ subscribersQueued: 0, broadcastQueued: 0 });
    expect(await prisma.restockSubscription.count({ where: { productId: denom.id } })).toBe(1);
  });

  it("afterStockAdded queues the subscriber DMs, and the broadcast (with an audit row) only when broadcastOnRestock is on", async () => {
    const admin = await prisma.user.create({ data: { referralCode: `a${Math.random()}`, role: "ADMIN" } });
    const off = await seedSku(false);
    const subA = await mkUser({});
    await prisma.restockSubscription.create({ data: { userId: subA.id, productId: off.id } });
    const resOff = await afterStockAdded(prisma, off.id, 3, admin.id);
    expect(resOff.subscribersQueued).toBe(1);
    expect(resOff.broadcastQueued).toBe(0);

    const on = await seedSku(true);
    const subB = await mkUser({});
    await prisma.restockSubscription.create({ data: { userId: subB.id, productId: on.id } });
    const resOn = await afterStockAdded(prisma, on.id, 3, admin.id);
    expect(resOn.subscribersQueued).toBe(1);
    expect(resOn.broadcastQueued).toBeGreaterThan(0);
    const audit = await prisma.auditLog.findFirst({ where: { action: "restock_broadcast", targetId: on.id } });
    expect(audit?.adminId).toBe(admin.id);
  });
});
