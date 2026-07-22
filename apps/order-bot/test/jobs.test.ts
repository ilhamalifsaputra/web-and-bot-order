// setup-db MUST be first — temp DB + push before any @app import.
import "./setup-db";

import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma, createOrderDirect, finalizeOrderPayment, setOrderPaymentMessage, createBroadcast } from "@app/db";
import type { Api } from "grammy";
import { OrderStatus, OrderCurrency } from "@app/core/enums";
import { buildSampleData, resetDb, type SampleData } from "../../../tests/helpers/sampleData";
import { autoCancelExpiredOrders, scheduleJobs, drainBroadcasts, announceStartedFlashSales } from "../src/jobs";
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
      // drainBroadcasts — offset to :20 past the minute (not :00, same as
      // autoCancelExpiredOrders above) so the two don't contend for SQLite's
      // single write-lock in the same instant every tick; still protected.
      expect(crons[6]!.getPattern()).toBe("20 * * * * *");
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
    } finally {
      for (const c of crons) c.stop();
    }
  });
});
