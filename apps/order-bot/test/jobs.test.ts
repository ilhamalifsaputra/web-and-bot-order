// setup-db MUST be first — temp DB + push before any @app import.
import "./setup-db";

import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  prisma,
  createOrderDirect,
  finalizeOrderPayment,
  setOrderPaymentMessage,
  createBroadcast,
  createTicket,
  getSetting,
  setSetting,
  BINANCE_UID_KEY,
  BINANCE_API_KEY_KEY,
  BINANCE_API_SECRET_KEY,
  BINANCE_POLL_HEALTH_KEY,
} from "@app/db";
import { GrammyError, type Api } from "grammy";
import { OrderStatus, OrderCurrency, TicketStatus } from "@app/core/enums";
import { buildSampleData, resetDb, type SampleData } from "../../../tests/helpers/sampleData";
import { autoCancelExpiredOrders, autoCloseStaleTickets, scheduleJobs, drainBroadcasts, announceStartedFlashSales, binancePollWatchdog } from "../src/jobs";
import { NotificationEvent } from "@app/core/enums";

let sample: SampleData;

beforeEach(async () => {
  await resetDb(prisma);
  sample = await buildSampleData(prisma);
});

afterAll(async () => {
  await prisma.$disconnect();
});

const fakeApi = (overrides: Partial<{ editMessageCaption: unknown; editMessageText: unknown; sendMessage: unknown; sendPhoto: unknown }> = {}) =>
  ({
    sendMessage: overrides.sendMessage ?? vi.fn().mockResolvedValue(undefined),
    sendPhoto: overrides.sendPhoto ?? vi.fn().mockResolvedValue({ photo: [{ file_id: "small_fid" }, { file_id: "large_fid" }] }),
    editMessageCaption: overrides.editMessageCaption ?? vi.fn().mockResolvedValue(undefined),
    editMessageText: overrides.editMessageText ?? vi.fn().mockResolvedValue(undefined),
  }) as unknown as Api;

/** A PENDING_PAYMENT order whose window already expired (picked up by the job). */
async function makeExpiredOrder() {
  const created = await prisma.$transaction(async (tx) => {
    const o = await createOrderDirect(tx, {
      user: { id: sample.user.id, role: sample.user.role },
      productId: sample.product.id,
      quantity: 1,
    });
    return finalizeOrderPayment(tx, o!.id, { currency: OrderCurrency.IDR });
  });
  await prisma.order.update({ where: { id: created!.id }, data: { expiresAt: new Date(Date.now() - 60_000) } });
  return created!;
}

describe("autoCancelExpiredOrders", () => {
  it("edits the anchored text bubble in place instead of sending a new message", async () => {
    const order = await makeExpiredOrder();
    await setOrderPaymentMessage(prisma, order.id, 555, 777);
    const api = fakeApi({ editMessageCaption: vi.fn().mockRejectedValue(new Error("no caption to edit")) });

    await autoCancelExpiredOrders(api);

    expect(api.editMessageText).toHaveBeenCalledTimes(1);
    const [chatId, msgId, , payload] = (api.editMessageText as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(chatId).toBe(555);
    expect(msgId).toBe(777);
    const flat = (payload.reply_markup.inline_keyboard as Array<Array<{ callback_data?: string }>>)
      .flat()
      .map((b) => b.callback_data);
    expect(flat).toContain("v1:order:list");
    expect(api.sendMessage).not.toHaveBeenCalled();

    const after = await prisma.order.findUnique({ where: { id: order.id } });
    expect(after?.status).toBe(OrderStatus.CANCELLED);
  });

  it("edits the anchored photo (QR) bubble's caption when available", async () => {
    const order = await makeExpiredOrder();
    await setOrderPaymentMessage(prisma, order.id, 555, 777);
    const api = fakeApi();

    await autoCancelExpiredOrders(api);

    expect(api.editMessageCaption).toHaveBeenCalledTimes(1);
    expect(api.editMessageText).not.toHaveBeenCalled();
    expect(api.sendMessage).not.toHaveBeenCalled();
  });

  it("falls back to a fresh DM when the order has no anchored bubble", async () => {
    await makeExpiredOrder();
    const api = fakeApi();

    await autoCancelExpiredOrders(api);

    expect(api.sendMessage).toHaveBeenCalledTimes(1);
    expect(api.editMessageCaption).not.toHaveBeenCalled();
    expect(api.editMessageText).not.toHaveBeenCalled();
  });

  it("falls back to a fresh DM when the anchored bubble can no longer be edited", async () => {
    const order = await makeExpiredOrder();
    await setOrderPaymentMessage(prisma, order.id, 555, 777);
    const api = fakeApi({
      editMessageCaption: vi.fn().mockRejectedValue(new Error("gone")),
      editMessageText: vi.fn().mockRejectedValue(new Error("gone")),
    });

    await autoCancelExpiredOrders(api);

    expect(api.sendMessage).toHaveBeenCalledTimes(1);
  });
});

describe("autoCloseStaleTickets", () => {
  const HOUR = 3_600_000;

  /** A REPLIED ticket whose repliedAt is already past the 48h cutoff. */
  async function makeStaleTicket(userId: number) {
    const ticket = await createTicket(prisma, userId, "help please");
    await prisma.supportTicket.update({
      where: { id: ticket.id },
      data: { status: TicketStatus.REPLIED, repliedAt: new Date(Date.now() - 49 * HOUR) },
    });
    return ticket;
  }

  // M-27 fix (backend audit 2026-07-31): closing one stale ticket used to run
  // bare inside the loop (no per-iteration try/catch, only the DM was
  // guarded), so a single row's failure threw out of the whole `for` loop and
  // every other stale ticket in that tick stayed open. This mirrors
  // autoCancelExpiredOrders's per-row try/catch: one failing row is logged
  // and skipped, the rest of the batch still drains.
  it("keeps closing the rest of the batch when one ticket's closure throws", async () => {
    const secondUser = await prisma.user.create({
      data: { telegramId: BigInt(9001), referralCode: "stale-ticket-2", role: "CUSTOMER" },
    });
    const failing = await makeStaleTicket(sample.user.id);
    const healthy = await makeStaleTicket(secondUser.id);
    const api = fakeApi();

    const originalUpdateMany = prisma.supportTicket.updateMany.bind(prisma.supportTicket);
    const spy = vi
      .spyOn(prisma.supportTicket, "updateMany")
      .mockImplementation(((args: { where?: { id?: number } }) => {
        if (args.where?.id === failing.id) {
          return Promise.reject(new Error("simulated write-lock timeout"));
        }
        return originalUpdateMany(args as Parameters<typeof originalUpdateMany>[0]);
      }) as typeof prisma.supportTicket.updateMany);

    await autoCloseStaleTickets(api);
    spy.mockRestore();

    const failingRow = await prisma.supportTicket.findUnique({ where: { id: failing.id } });
    expect(failingRow!.status).toBe(TicketStatus.REPLIED); // untouched — closeTicket threw

    const healthyRow = await prisma.supportTicket.findUnique({ where: { id: healthy.id } });
    expect(healthyRow!.status).toBe(TicketStatus.CLOSED); // still processed despite the earlier failure

    expect(api.sendMessage).toHaveBeenCalledTimes(1);
    expect(api.sendMessage).toHaveBeenCalledWith(9001, expect.any(String), expect.anything());
  });
});

describe("drainBroadcasts", () => {
  // Exclude buildSampleData's own telegramId:42 user so each test's recipient
  // count is exactly the users it creates itself.
  beforeEach(async () => {
    await prisma.user.update({ where: { id: sample.user.id }, data: { banned: true } });
  });

  async function addRecipient(telegramId: number) {
    await prisma.user.create({
      data: { telegramId: BigInt(telegramId), referralCode: `r${telegramId}`, role: "CUSTOMER" },
    });
  }

  it("sends plain text via sendMessage when the broadcast has no image", async () => {
    await addRecipient(1001);
    await addRecipient(1002);
    const bc = await createBroadcast(prisma, { message: "hi all", segment: "ALL", scheduledAt: null, createdById: null, total: 0 });
    const api = fakeApi();

    await drainBroadcasts(api);

    expect(api.sendMessage).toHaveBeenCalledTimes(2);
    expect(api.sendPhoto).not.toHaveBeenCalled();
    const done = await prisma.broadcast.findUnique({ where: { id: bc.id } });
    expect(done!.status).toBe("SENT");
    expect(done!.sentCount).toBe(2);
  });

  it("sends a photo via sendPhoto and caches the resolved file_id after the first send", async () => {
    await addRecipient(2001);
    await addRecipient(2002);
    const bc = await createBroadcast(prisma, {
      message: "look at this",
      segment: "ALL",
      scheduledAt: null,
      createdById: null,
      total: 0,
      webImageUrl: "/uploads/broadcasts/broadcast-test.jpg",
    });
    const api = fakeApi();

    await drainBroadcasts(api);

    expect(api.sendPhoto).toHaveBeenCalledTimes(2);
    expect(api.sendMessage).not.toHaveBeenCalled();
    const calls = (api.sendPhoto as ReturnType<typeof vi.fn>).mock.calls;
    // First send resolves a fresh InputFile off disk (not a plain string)...
    expect(typeof calls[0]![1]).not.toBe("string");
    // ...subsequent recipients reuse the cached file_id string.
    expect(calls[1]![1]).toBe("large_fid");
    const done = await prisma.broadcast.findUnique({ where: { id: bc.id } });
    expect(done!.imageFileId).toBe("large_fid");
    expect(done!.status).toBe("SENT");
  });

  it("reuses an already-cached file_id from the very first recipient (resumed run)", async () => {
    await addRecipient(3001);
    const bc = await createBroadcast(prisma, {
      message: "resumed",
      segment: "ALL",
      scheduledAt: null,
      createdById: null,
      total: 0,
      webImageUrl: "/uploads/broadcasts/broadcast-test.jpg",
    });
    await prisma.broadcast.update({ where: { id: bc.id }, data: { imageFileId: "already_cached_fid" } });
    const api = fakeApi();

    await drainBroadcasts(api);

    expect(api.sendPhoto).toHaveBeenCalledTimes(1);
    expect(api.sendPhoto).toHaveBeenCalledWith(3001, "already_cached_fid", { caption: "resumed" });
  });

  it("counts a sendPhoto failure as failed without aborting remaining recipients", async () => {
    await addRecipient(4001);
    await addRecipient(4002);
    const bc = await createBroadcast(prisma, {
      message: "flaky",
      segment: "ALL",
      scheduledAt: null,
      createdById: null,
      total: 0,
      webImageUrl: "/uploads/broadcasts/broadcast-test.jpg",
    });
    const sendPhoto = vi.fn()
      .mockRejectedValueOnce(new Error("blocked"))
      .mockResolvedValueOnce({ photo: [{ file_id: "fid" }] });
    const api = fakeApi({ sendPhoto });

    await drainBroadcasts(api);

    expect(sendPhoto).toHaveBeenCalledTimes(2);
    const done = await prisma.broadcast.findUnique({ where: { id: bc.id } });
    expect(done!.sentCount).toBe(1);
    expect(done!.failedCount).toBe(1);
  });

  // Sub-item (c): sentCount used to be written exactly once, by
  // finishBroadcast, after the whole loop — so Broadcast History showed a
  // frozen 0 that jumped straight to the final number. The drainer now flushes
  // its running counters every BROADCAST_PROGRESS_FLUSH_EVERY (25) recipients.
  it("flushes running counters to the row every 25 recipients while still SENDING", async () => {
    for (let i = 0; i < 26; i++) await addRecipient(5100 + i);
    const bc = await createBroadcast(prisma, { message: "long one", segment: "ALL", scheduledAt: null, createdById: null, total: 0 });

    // Snapshot the persisted row from INSIDE the send loop: once just before
    // the 25th recipient (no flush yet) and once just before the 26th (the
    // first flush has landed).
    const snapshots: Record<number, { status: string; sentCount: number; failedCount: number }> = {};
    let call = 0;
    const sendMessage = vi.fn(async () => {
      call++;
      if (call === 25 || call === 26) {
        const row = (await prisma.broadcast.findUnique({ where: { id: bc.id } }))!;
        snapshots[call] = { status: row.status, sentCount: row.sentCount, failedCount: row.failedCount };
      }
    });

    await drainBroadcasts(fakeApi({ sendMessage }));

    expect(sendMessage).toHaveBeenCalledTimes(26);
    // Nothing flushed yet at recipient 25 — the counter is still the initial 0.
    expect(snapshots[25]).toEqual({ status: "SENDING", sentCount: 0, failedCount: 0 });
    // ...and the flush after recipient 25 is visible to the admin BEFORE the
    // broadcast finishes, which is the whole point of the change.
    expect(snapshots[26]).toEqual({ status: "SENDING", sentCount: 25, failedCount: 0 });

    // finishBroadcast still writes the authoritative final numbers over it.
    const done = (await prisma.broadcast.findUnique({ where: { id: bc.id } }))!;
    expect(done.status).toBe("SENT");
    expect(done.sentCount).toBe(26);
    expect(done.totalCount).toBe(26);
  });

  // Sub-item (b): the loop used to `await sleep(40)` flat AFTER the send, so
  // the real rate was 1/(latency + 40ms) rather than the ~25 msg/s the 40ms
  // throttle was sized for. The wait is now the REMAINDER of that budget.
  describe("latency-aware throttle", () => {
    /** Record every sleep the drainer asks for while letting the real timer
     *  run, and drive a virtual clock so a "slow" Telegram call can consume
     *  the send budget without the test actually waiting for it. */
    function instrumentClock() {
      const requested: number[] = [];
      const realSetTimeout = globalThis.setTimeout;
      let now = Date.now();
      const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => now);
      const timerSpy = vi.spyOn(globalThis, "setTimeout").mockImplementation(((fn: () => void, ms?: number) => {
        requested.push(ms ?? 0);
        // Advance the virtual clock by what was asked for, but fire straight
        // away so the suite doesn't spend real seconds sleeping.
        now += ms ?? 0;
        return realSetTimeout(fn, 0);
      }) as typeof globalThis.setTimeout);
      return {
        requested,
        advance: (ms: number) => { now += ms; },
        restore: () => { timerSpy.mockRestore(); nowSpy.mockRestore(); },
      };
    }

    it("sleeps only the remainder of the 40ms budget after a fast send", async () => {
      await addRecipient(6001);
      await createBroadcast(prisma, { message: "fast", segment: "ALL", scheduledAt: null, createdById: null, total: 0 });
      const clock = instrumentClock();
      // 10ms of latency leaves 30ms of the 40ms budget still to wait out.
      const sendMessage = vi.fn(async () => { clock.advance(10); });

      try {
        await drainBroadcasts(fakeApi({ sendMessage }));
      } finally {
        clock.restore();
      }

      expect(clock.requested).toEqual([30]);
    });

    it("does not sleep at all when the send already took longer than the budget", async () => {
      await addRecipient(6002);
      await addRecipient(6003);
      await createBroadcast(prisma, { message: "slow", segment: "ALL", scheduledAt: null, createdById: null, total: 0 });
      const clock = instrumentClock();
      // 100ms latency > the 40ms budget: the old flat sleep(40) would have
      // added 40ms on top of each of these, dropping the rate to ~7 msg/s.
      const sendMessage = vi.fn(async () => { clock.advance(100); });

      try {
        await drainBroadcasts(fakeApi({ sendMessage }));
      } finally {
        clock.restore();
      }

      expect(sendMessage).toHaveBeenCalledTimes(2);
      expect(clock.requested).toEqual([]);
    });
  });

  // Telegram flood control (429 + retry_after) used to fall into the bare
  // `catch { failed++ }` alongside "user blocked the bot", permanently writing
  // those recipients off with no retry.
  describe("Telegram flood control (retry_after)", () => {
    const floodError = (retryAfter: number) =>
      new GrammyError(
        "Call to 'sendMessage' failed!",
        { ok: false, error_code: 429, description: "Too Many Requests: retry after " + retryAfter, parameters: { retry_after: retryAfter } },
        "sendMessage",
        {},
      );

    /** Fire every sleep immediately but remember how long was asked for. */
    function captureSleeps() {
      const requested: number[] = [];
      const realSetTimeout = globalThis.setTimeout;
      const spy = vi.spyOn(globalThis, "setTimeout").mockImplementation(((fn: () => void, ms?: number) => {
        requested.push(ms ?? 0);
        return realSetTimeout(fn, 0);
      }) as typeof globalThis.setTimeout);
      return { requested, restore: () => spy.mockRestore() };
    }

    it("waits out retry_after and re-sends to the SAME recipient instead of failing them", async () => {
      await addRecipient(7001);
      const bc = await createBroadcast(prisma, { message: "throttled", segment: "ALL", scheduledAt: null, createdById: null, total: 0 });
      const sendMessage = vi.fn()
        .mockRejectedValueOnce(floodError(2))
        .mockResolvedValueOnce(undefined);
      const sleeps = captureSleeps();

      try {
        await drainBroadcasts(fakeApi({ sendMessage }));
      } finally {
        sleeps.restore();
      }

      // Same chat id, twice — the retry is a retry, not a skip.
      expect(sendMessage).toHaveBeenCalledTimes(2);
      expect(sendMessage.mock.calls[0]![0]).toBe(7001);
      expect(sendMessage.mock.calls[1]![0]).toBe(7001);
      // retry_after 2s honoured with the dispatcher's +1s of headroom.
      expect(sleeps.requested).toContain(3000);

      const done = (await prisma.broadcast.findUnique({ where: { id: bc.id } }))!;
      expect(done.sentCount).toBe(1);
      expect(done.failedCount).toBe(0);
    });

    it("clamps an absurd retry_after instead of parking the drainer for hours", async () => {
      await addRecipient(7002);
      await createBroadcast(prisma, { message: "hostile", segment: "ALL", scheduledAt: null, createdById: null, total: 0 });
      const sendMessage = vi.fn()
        .mockRejectedValueOnce(floodError(86_400)) // a full day
        .mockResolvedValueOnce(undefined);
      const sleeps = captureSleeps();

      try {
        await drainBroadcasts(fakeApi({ sendMessage }));
      } finally {
        sleeps.restore();
      }

      // Capped at BROADCAST_MAX_RETRY_AFTER_S (60s) + 1s of headroom.
      expect(Math.max(...sleeps.requested)).toBe(61_000);
    });

    it("gives up on a recipient that is flood-controlled forever, and keeps draining the rest", async () => {
      await addRecipient(7003);
      await addRecipient(7004);
      const bc = await createBroadcast(prisma, { message: "endless", segment: "ALL", scheduledAt: null, createdById: null, total: 0 });
      const sendMessage = vi.fn(async (chatId: number) => {
        if (chatId === 7003) throw floodError(1); // never recovers
      });
      const sleeps = captureSleeps();

      try {
        await drainBroadcasts(fakeApi({ sendMessage }));
      } finally {
        sleeps.restore();
      }

      // 1 initial attempt + BROADCAST_MAX_FLOOD_RETRIES (3) for 7003, then the
      // loop moves on and delivers to 7004 — it must terminate, not spin.
      expect(sendMessage.mock.calls.filter((c) => c[0] === 7003)).toHaveLength(4);
      expect(sendMessage.mock.calls.filter((c) => c[0] === 7004)).toHaveLength(1);

      const done = (await prisma.broadcast.findUnique({ where: { id: bc.id } }))!;
      expect(done.status).toBe("SENT");
      expect(done.sentCount).toBe(1);
      expect(done.failedCount).toBe(1);
    });

    it("still fails a non-flood error immediately, with no retry", async () => {
      await addRecipient(7005);
      const bc = await createBroadcast(prisma, { message: "blocked", segment: "ALL", scheduledAt: null, createdById: null, total: 0 });
      const sendMessage = vi.fn().mockRejectedValue(
        new GrammyError(
          "Call to 'sendMessage' failed!",
          { ok: false, error_code: 403, description: "Forbidden: bot was blocked by the user" },
          "sendMessage",
          {},
        ),
      );

      await drainBroadcasts(fakeApi({ sendMessage }));

      expect(sendMessage).toHaveBeenCalledTimes(1);
      const done = (await prisma.broadcast.findUnique({ where: { id: bc.id } }))!;
      expect(done.failedCount).toBe(1);
    });
  });
});

describe("announceStartedFlashSales", () => {
  const HOUR = 3_600_000;

  /** A second SKU under the sample product, so a test can hold several sales. */
  async function makeDenomination(name: string, isActive = true) {
    return prisma.denomination.create({
      data: {
        productId: sample.parentProduct.id,
        name,
        slug: `slug-${name}-${Math.random()}`,
        type: "SHARED",
        durationLabel: "1 Month",
        price: "50000",
        isActive,
      },
    });
  }

  function scheduleFlash(id: number, startsAt: Date, endsAt: Date) {
    return prisma.denomination.update({
      where: { id },
      data: {
        // Central IDR (the fixture's default 5.00 is a USDT-era leftover) so
        // the announced price is a realistic Rupiah figure.
        price: "50000",
        flashDiscountPercent: "25",
        flashStartsAt: startsAt,
        flashEndsAt: endsAt,
        flashAnnouncedAt: null,
      },
    });
  }

  const flashRows = () =>
    prisma.notificationOutbox.findMany({ where: { event: NotificationEvent.FLASH_SALE_BROADCAST } });

  it("announces a started sale once, and the flashAnnouncedAt guard stops the next tick re-sending it", async () => {
    const now = Date.now();
    await scheduleFlash(sample.product.id, new Date(now - HOUR), new Date(now + HOUR));

    await announceStartedFlashSales();
    const afterFirst = await flashRows();
    expect(afterFirst.length).toBe(1); // one recipient: the sample user
    const payload = JSON.parse(afterFirst[0]!.payloadJson) as {
      chat_id: number;
      product_name: string;
      denomination_name: string;
      discount_percent: string;
      new_price: string;
    };
    expect(payload.chat_id).toBe(42);
    expect(payload.product_name).toBe(sample.parentProduct.name);
    expect(payload.denomination_name).toBe(sample.product.name);
    expect(payload.discount_percent).toBe("25");
    expect(payload.new_price).toBe("Rp37.500");

    const stamped = await prisma.denomination.findUnique({ where: { id: sample.product.id } });
    expect(stamped!.flashAnnouncedAt).not.toBeNull();

    await announceStartedFlashSales();
    expect((await flashRows()).length).toBe(1); // still exactly one batch
    expect(await prisma.broadcast.count()).toBe(1);
  });

  // H-7 fix (backend audit 2026-07-31): the `flashAnnouncedAt` claim and the
  // customer fan-out used to share one `$transaction`, holding SQLite's
  // single writer lock for however long the whole-customer-base enqueue
  // took. They're now two phases — a short claim transaction, then a
  // chunked enqueue outside any transaction — and this test's job is to
  // prove that split still delivers to a customer base large enough to need
  // multiple chunks (500 rows/chunk internally), and that the claim alone
  // still correctly stops a second run from double-sending to any of them.
  it("announces a started sale to a large customer base across the two-phase claim-then-chunked-enqueue, still stamping flashAnnouncedAt so a re-run doesn't double-send", async () => {
    const now = Date.now();
    await scheduleFlash(sample.product.id, new Date(now - HOUR), new Date(now + HOUR));
    const EXTRA_RECIPIENTS = 1100; // comfortably more than one 500-row chunk
    await prisma.user.createMany({
      data: Array.from({ length: EXTRA_RECIPIENTS }, (_, i) => ({
        telegramId: BigInt(8_000_000 + i),
        referralCode: `flash-job-${i}`,
        banned: false,
      })),
    });
    const expectedRecipients = EXTRA_RECIPIENTS + 1; // + the sample user (telegramId 42)

    await announceStartedFlashSales();

    const afterFirst = await flashRows();
    expect(afterFirst.length).toBe(expectedRecipients);
    const broadcastRow = await prisma.broadcast.findFirst({ orderBy: { id: "desc" } });
    expect(broadcastRow!.totalCount).toBe(expectedRecipients);

    const stamped = await prisma.denomination.findUnique({ where: { id: sample.product.id } });
    expect(stamped!.flashAnnouncedAt).not.toBeNull();

    // Re-run: the claim (not the enqueue) is what prevents a double-send, so
    // this must still hold even though the fan-out is no longer in the same
    // transaction as the claim.
    await announceStartedFlashSales();
    expect((await flashRows()).length).toBe(expectedRecipients);
    expect(await prisma.broadcast.count()).toBe(1);
  });

  it("skips sales that have not started yet, have already ended, or sit on an inactive SKU", async () => {
    const now = Date.now();
    const future = await makeDenomination("not-yet");
    await scheduleFlash(future.id, new Date(now + HOUR), new Date(now + 2 * HOUR));
    const ended = await makeDenomination("already-over");
    await scheduleFlash(ended.id, new Date(now - 2 * HOUR), new Date(now - HOUR));
    const inactive = await makeDenomination("inactive", false);
    await scheduleFlash(inactive.id, new Date(now - HOUR), new Date(now + HOUR));

    await announceStartedFlashSales();

    expect(await flashRows()).toEqual([]);
    expect(await prisma.broadcast.count()).toBe(0);
    for (const id of [future.id, ended.id, inactive.id]) {
      const row = await prisma.denomination.findUnique({ where: { id } });
      expect(row!.flashAnnouncedAt).toBeNull();
    }
  });
});

// Bot-5 (security audit, 2026-06-23): a slow tick (or a restart racing the
// next scheduled fire) must not overlap with itself and re-process the same
// expired-orders/stale-tickets set, sending duplicate DMs.
describe("scheduleJobs cron registration (Bot-5 fix)", () => {
  it("registers autoCancelExpiredOrders and autoCloseStaleTickets with protect:true", () => {
    // Indices match scheduleJobs' literal array order in src/jobs/index.ts:
    // [autoCancelExpiredOrders, autoCloseStaleTickets, reconcileFinancesJob,
    //  binancePollWatchdog, bybitPollWatchdog, bybitBscPollWatchdog, drainBroadcasts,
    //  announceStartedFlashSales, storageCleanupJob].
    const crons = scheduleJobs(fakeApi());
    try {
      expect(crons[0]!.getPattern()).toBe("*/1 * * * *"); // autoCancelExpiredOrders
      expect(crons[0]!.options.protect).toBe(true);
      expect(crons[1]!.getPattern()).toBe("0 * * * *"); // autoCloseStaleTickets
      expect(crons[1]!.options.protect).toBe(true);
      // reconcileFinancesJob + the three poller watchdogs (M-26 fix, backend
      // audit 2026-07-31): these were the one group in this list missing
      // protect:true, letting a slow Telegram call overlap the next tick and
      // double-page admins on the same incident.
      expect(crons[2]!.getPattern()).toBe("0 */6 * * *"); // reconcileFinancesJob
      expect(crons[2]!.options.protect).toBe(true);
      expect(crons[3]!.getPattern()).toBe("*/2 * * * *"); // binancePollWatchdog
      expect(crons[3]!.options.protect).toBe(true);
      expect(crons[4]!.getPattern()).toBe("*/2 * * * *"); // bybitPollWatchdog
      expect(crons[4]!.options.protect).toBe(true);
      expect(crons[5]!.getPattern()).toBe("*/2 * * * *"); // bybitBscPollWatchdog
      expect(crons[5]!.options.protect).toBe(true);
      // drainBroadcasts — four ticks a minute so a queued broadcast starts
      // within ~15s instead of up to a full minute, on seconds that dodge both
      // second 0 (autoCancelExpiredOrders and the hourly/6-hourly jobs) and
      // second 40 (announceStartedFlashSales) so they never contend for
      // SQLite's single write-lock in the same instant; still protected.
      // "*/15" is deliberately NOT used — it would put a tick back on second 0.
      expect(crons[6]!.getPattern()).toBe("5,20,35,50 * * * * *");
      expect(crons[6]!.options.protect).toBe(true);
      // announceStartedFlashSales — offset to :40 past the minute for the same
      // reason, protected so an overlapping tick can't race the
      // flashAnnouncedAt stamp.
      expect(crons[7]!.getPattern()).toBe("40 * * * * *");
      expect(crons[7]!.options.protect).toBe(true);
      // storageCleanupJob — once daily, off-peak (03:15), well clear of every
      // other job's minutely/hourly ticks.
      expect(crons[8]!.getPattern()).toBe("30 15 3 * * *");
      expect(crons[8]!.options.protect).toBe(true);

      // The write-lock collision guard itself, rather than just the literal
      // patterns above: no second-resolution job may share a firing second
      // with another, and none may land on second 0 where every
      // minute/hour-resolution job in this list fires (P1008/P2028 in
      // production, 2026-07-20).
      const secondsOf = (pattern: string | undefined) =>
        pattern!.split(" ")[0]!.split(",").map(Number);
      const drainSeconds = secondsOf(crons[6]!.getPattern());
      const flashSeconds = secondsOf(crons[7]!.getPattern());
      expect(drainSeconds).not.toContain(0);
      expect(flashSeconds).not.toContain(0);
      expect(drainSeconds.filter((s) => flashSeconds.includes(s))).toEqual([]);
    } finally {
      for (const c of crons) c.stop();
    }
  });
});

// M-26 fix (backend audit 2026-07-31): binancePollWatchdog (and its Bybit /
// Bybit-BSC twins, which share the exact same shape) used to write its
// "already alerted" flag only AFTER the admin DM loop finished. That left a
// window — a slow Telegram call, or an overlapping tick before `protect:
// true` was added to the Cron registration above — where a second run still
// read the flag as unset and paged every admin again for the same incident.
// croner's `protect: true` (asserted above) is the scheduler-level guard;
// these tests exercise the OTHER half of the fix directly — the flag write
// itself now happens before the loop starts, not just before it finishes —
// since croner's internal overlap lock isn't something a unit test can
// trigger without a real timer-based race.
describe("binancePollWatchdog alert-flag ordering (M-26 fix)", () => {
  const STALE_MS = 10 * 60_000; // > POLL_STALE_MINUTES (5), well into "alert"

  /** Enable the Binance Internal method and stamp a stale (unhealthy) heartbeat. */
  async function makeUnhealthy() {
    await setSetting(prisma, BINANCE_UID_KEY, "12345");
    await setSetting(prisma, BINANCE_API_KEY_KEY, "test-key");
    await setSetting(prisma, BINANCE_API_SECRET_KEY, "test-secret");
    await setSetting(
      prisma,
      BINANCE_POLL_HEALTH_KEY,
      JSON.stringify({ lastRun: new Date(Date.now() - STALE_MS).toISOString(), backoffUntil: null, consecutiveFailures: 0 }),
    );
  }

  it("writes the alert flag before the admin DM loop, so an invocation that overlaps mid-loop already sees it and sends nothing", async () => {
    await makeUnhealthy();
    // ADMIN_IDS is "999,1000" (test/setup-db.ts) — two admins to page.
    const flagSeenDuringEachDm: (string | null)[] = [];
    const nestedApi = fakeApi();
    let nestedTriggered = false;
    const api = fakeApi({
      sendMessage: vi.fn(async () => {
        flagSeenDuringEachDm.push(await getSetting(prisma, "binance_poll_alert_sent"));
        if (!nestedTriggered) {
          nestedTriggered = true;
          // Simulate a second tick firing while this run is still mid-loop —
          // exactly what `protect: true` on the Cron registration now stops
          // in production. Calling the job function directly here proves the
          // flag write ALONE (independent of the scheduler lock) also stops
          // it from re-alerting.
          await binancePollWatchdog(nestedApi);
        }
        return undefined;
      }),
    });

    await binancePollWatchdog(api);

    expect(flagSeenDuringEachDm).toEqual(["1", "1"]); // already "1" for every DM, including the very first
    expect(api.sendMessage).toHaveBeenCalledTimes(2); // both admins paged once by the original run
    expect(nestedApi.sendMessage).not.toHaveBeenCalled(); // the overlapping run saw alerted=true and paged no one
  });

  it("does not re-alert on the next tick after a run whose DM loop had a failure partway through", async () => {
    await makeUnhealthy();
    const firstRunApi = fakeApi({
      sendMessage: vi
        .fn()
        .mockResolvedValueOnce(undefined) // admin 999: delivered
        .mockRejectedValueOnce(new Error("bot was blocked by this admin")), // admin 1000: failed, caught per-admin
    });

    await binancePollWatchdog(firstRunApi);
    expect(firstRunApi.sendMessage).toHaveBeenCalledTimes(2);
    expect(await getSetting(prisma, "binance_poll_alert_sent")).toBe("1");

    // Next tick, still unhealthy (heartbeat untouched) — must see the flag
    // already set and skip alerting entirely, not just skip the admin who
    // already got the DM.
    const secondRunApi = fakeApi();
    await binancePollWatchdog(secondRunApi);
    expect(secondRunApi.sendMessage).not.toHaveBeenCalled();
  });
});
