// dispatcher.test-setup MUST be first — temp DB + push before any @app import.
import { cleanupTestDb } from "./dispatcher.test-setup";

/**
 * Infra-2 fix (security audit, 2026-06-23): drainBatch must not re-send a row
 * that's already claimed (SENDING) and not yet stale — that's the
 * crash-window double-send gap this fix closes. Uses a fake Bot (only
 * `bot.api.sendMessage` is ever called for a DM event like ADMIN_PW_RESET, so
 * no real Telegram/HTTP is involved).
 */
import { describe, it, expect, afterAll, vi } from "vitest";
import type { Bot } from "grammy";
import { prisma, enqueueAdminPasswordReset } from "@app/db";
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
