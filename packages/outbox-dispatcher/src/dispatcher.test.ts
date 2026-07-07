// dispatcher.test-setup MUST be first — temp DB + push before any @app import.
import { cleanupTestDb } from "./dispatcher.test-setup";

/**
 * Infra-2 fix (security audit, 2026-06-23): drainBatch must not re-send a row
 * that's already claimed (SENDING) and not yet stale — that's the
 * crash-window double-send gap this fix closes. Uses a fake Bot (only
 * `bot.api.sendMessage` is ever called for a DM event like ADMIN_PW_RESET, so
 * no real Telegram/HTTP is involved).
 */
import { describe, it, expect, afterAll, afterEach, vi } from "vitest";
import type { Bot } from "grammy";
import { prisma, enqueueAdminPasswordReset } from "@app/db";
import { setBotIdentity, resetBotIdentity } from "@app/core/runtime";
import { NotificationEvent } from "@app/core/enums";
import { drainBatch } from "./dispatcher";

afterAll(async () => {
  await prisma.$disconnect();
  cleanupTestDb();
});

function fakeBot() {
  const sendMessage = vi.fn().mockResolvedValue({ message_id: 1 });
  const bot = { api: { sendMessage } } as unknown as Bot;
  return { bot, sendMessage };
}

describe("drainBatch claim/release (Infra-2)", () => {
  it("sends a PENDING row once and marks it SENT", async () => {
    await enqueueAdminPasswordReset(prisma, { telegramId: 111222, code: "ABC123", ttlMinutes: 10 });
    const { bot, sendMessage } = fakeBot();

    await drainBatch(bot);

    expect(sendMessage).toHaveBeenCalledTimes(1);
    const row = await prisma.notificationOutbox.findFirst({ where: { event: "ADMIN_PW_RESET" }, orderBy: { id: "desc" } });
    expect(row!.status).toBe("SENT");
    expect(row!.claimedAt).toBeNull();
  });

  it("does NOT re-send a row that's already claimed (SENDING) and not stale — the crash-window gap", async () => {
    await enqueueAdminPasswordReset(prisma, { telegramId: 333444, code: "XYZ789", ttlMinutes: 10 });
    const row = await prisma.notificationOutbox.findFirst({ where: { event: "ADMIN_PW_RESET" }, orderBy: { id: "desc" } });

    // Simulate a dispatcher that claimed the row and then crashed BEFORE
    // calling markNotificationSent — the row is SENDING with a fresh claim.
    await prisma.notificationOutbox.update({
      where: { id: row!.id },
      data: { status: "SENDING", claimedAt: new Date() },
    });

    const { bot, sendMessage } = fakeBot();
    await drainBatch(bot);

    // Must NOT have been sent again — this is exactly the double-send this
    // fix prevents.
    expect(sendMessage).not.toHaveBeenCalled();
    const after = await prisma.notificationOutbox.findUnique({ where: { id: row!.id } });
    expect(after!.status).toBe("SENDING"); // untouched, still claimed
  });

  it("DOES retry a row whose claim is stale (dispatcher abandoned it, e.g. crashed) — eventually delivers exactly once", async () => {
    await enqueueAdminPasswordReset(prisma, { telegramId: 555666, code: "STALE01", ttlMinutes: 10 });
    const row = await prisma.notificationOutbox.findFirst({ where: { event: "ADMIN_PW_RESET" }, orderBy: { id: "desc" } });

    // Backdate the claim well past STALE_CLAIM_MS (5 min) — simulates an
    // abandoned claim from a dispatcher that crashed and never came back.
    await prisma.notificationOutbox.update({
      where: { id: row!.id },
      data: { status: "SENDING", claimedAt: new Date(Date.now() - 10 * 60_000) },
    });

    const { bot, sendMessage } = fakeBot();
    await drainBatch(bot);

    expect(sendMessage).toHaveBeenCalledTimes(1);
    const after = await prisma.notificationOutbox.findUnique({ where: { id: row!.id } });
    expect(after!.status).toBe("SENT");
  });
});

/**
 * Outbox-1 fix (backend audit): a channel-post row (e.g. ORDER_DELIVERED
 * testimonial) enqueued while PUBLIC_CHANNEL_ID was configured must not spin
 * forever at zero backoff once the channel is unset/changed — it should back
 * off exponentially like every other failure path, but NEVER flip to FAILED,
 * since an admin might reconfigure the channel at any time.
 */
describe("drainBatch channel-not-configured release (Outbox-1)", () => {
  afterEach(() => resetBotIdentity());

  it("releases a channel-post row with growing backoff and never marks it FAILED, however many ticks pass", async () => {
    // Channel configured when the row was enqueued (mirrors: admin sets a
    // public channel, testimonial rows get queued for it).
    setBotIdentity({ publicChannelId: -1001234567890 });
    await prisma.notificationOutbox.create({
      data: {
        event: NotificationEvent.ORDER_DELIVERED,
        orderId: null,
        payloadJson: JSON.stringify({
          items: [{ name: "Test Product", qty: 1 }],
          masked_buyer_id: "1234XXXX",
          total: "10",
          currency: "USDT",
          delivered_at: "2026-07-07 00:00 UTC",
          buyer_language: "en",
        }),
      },
    });
    const row = await prisma.notificationOutbox.findFirst({
      where: { event: "ORDER_DELIVERED" },
      orderBy: { id: "desc" },
    });

    // Admin unsets/changes the channel before this row is delivered.
    resetBotIdentity();

    const { bot, sendMessage } = fakeBot();
    await drainBatch(bot);

    expect(sendMessage).not.toHaveBeenCalled();
    const after1 = await prisma.notificationOutbox.findUnique({ where: { id: row!.id } });
    expect(after1!.status).toBe("PENDING");
    expect(after1!.attempts).toBe(1);
    expect(after1!.nextRetryAt).not.toBeNull();
    expect(after1!.nextRetryAt!.getTime()).toBeGreaterThan(Date.now());

    // A tick right now must NOT re-claim it — nextRetryAt hasn't passed yet.
    await drainBatch(bot);
    const after2 = await prisma.notificationOutbox.findUnique({ where: { id: row!.id } });
    expect(after2!.attempts).toBe(1);
    expect(after2!.nextRetryAt!.getTime()).toBe(after1!.nextRetryAt!.getTime());

    // Simulate the backoff window elapsing — the row is reclaimed and
    // released again with a strictly larger backoff window.
    await prisma.notificationOutbox.update({
      where: { id: row!.id },
      data: { nextRetryAt: new Date(Date.now() - 1000) },
    });
    await drainBatch(bot);
    const after3 = await prisma.notificationOutbox.findUnique({ where: { id: row!.id } });
    expect(after3!.status).toBe("PENDING");
    expect(after3!.attempts).toBe(2);
    expect(after3!.nextRetryAt!.getTime()).toBeGreaterThan(after1!.nextRetryAt!.getTime());

    // Drive it through many more elapsed-backoff ticks — well past the
    // default max-attempts count used elsewhere — and confirm it NEVER
    // transitions to FAILED and never gets sent.
    for (let i = 0; i < 10; i++) {
      await prisma.notificationOutbox.update({
        where: { id: row!.id },
        data: { nextRetryAt: new Date(Date.now() - 1000) },
      });
      await drainBatch(bot);
    }
    const final = await prisma.notificationOutbox.findUnique({ where: { id: row!.id } });
    expect(final!.status).toBe("PENDING");
    expect(final!.attempts).toBe(12);
    expect(sendMessage).not.toHaveBeenCalled();
  });
});
