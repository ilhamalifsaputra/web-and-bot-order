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
import {
  prisma,
  enqueueAdminPasswordReset,
  completeOrderWithWalletCredit,
  enqueueOrderDeliveredDm,
  enqueueRestockBroadcast,
  adjustWallet,
  createOrderDirect,
  attachPaymentProof,
  settlePaidOrder,
  fulfillManualOrder,
  createCategory,
  createCatalogProduct,
  createDenomination,
  updateDenomination,
  upsertUser,
} from "@app/db";
import { setBotIdentity, resetBotIdentity } from "@app/core/runtime";
import { NotificationEvent, OrderCurrency, DeliveryType } from "@app/core/enums";
import { buildSampleData } from "../../../tests/helpers/sampleData";
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

/** Fake Bot that also stubs sendDocument — the call ORDER_DELIVERED_DM makes. */
function fakeDocBot() {
  const sendDocument = vi.fn().mockResolvedValue({ message_id: 1 });
  const sendMessage = vi.fn().mockResolvedValue({ message_id: 1 });
  const bot = { api: { sendDocument, sendMessage } } as unknown as Bot;
  return { bot, sendDocument, sendMessage };
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

/**
 * End-to-end guard for the outbox credential DM: an ORDER_DELIVERED_DM row for
 * a delivered order must, once drained, put the account `.txt` document on the
 * wire. This is the only test that exercises `deliverAccountDm` (sendDocument)
 * through to the bot — the shared outbox delivery path used by TokoPay /
 * PayDisini / NOWPayments and the wallet rail's direct-send fallback. Seeds a
 * real delivered wallet order (SOLD stock + live credentials) and enqueues via
 * the generic `enqueueOrderDeliveredDm` helper the web-admin resend uses.
 */
describe("drainBatch delivers a delivered order's credentials as a document", () => {
  it("turns an ORDER_DELIVERED_DM row into a sendDocument and marks the row SENT", async () => {
    const sample = await buildSampleData(prisma); // product price "5.00" IDR, user telegramId 42
    await adjustWallet(prisma, sample.user.id, "10", { currency: "IDR", reason: "admin_adjust" });
    const user = await prisma.user.findUniqueOrThrow({ where: { id: sample.user.id } });

    const { order } = await prisma.$transaction((tx) =>
      completeOrderWithWalletCredit(tx, {
        user: { id: user.id, role: user.role, walletBalance: user.walletBalance },
        productId: sample.product.id,
        quantity: 1,
        currency: OrderCurrency.IDR,
      }),
    );
    await enqueueOrderDeliveredDm(prisma, {
      orderId: order.id,
      orderCode: order.orderCode,
      telegramId: BigInt(42),
      language: "en",
    });

    const { bot, sendDocument } = fakeDocBot();
    await drainBatch(bot);

    expect(sendDocument).toHaveBeenCalledTimes(1);
    const [chatId, file] = sendDocument.mock.calls[0]!;
    expect(chatId).toBe(42); // the buyer's Telegram id, not the public channel
    expect((file as { filename?: string }).filename).toBe(`${order.orderCode}.txt`);

    const dm = await prisma.notificationOutbox.findFirst({
      where: { orderId: order.id, event: NotificationEvent.ORDER_DELIVERED_DM },
    });
    expect(dm!.status).toBe("SENT");
  });
});

/** A manual (or manual_with_info) denomination with NO stock rows, using its
 * own category/product — mirrors settlePaidOrder.test.ts's makeManualDenom. */
async function makeManualDenom(deliveryType: string = DeliveryType.MANUAL) {
  const category = await createCategory(prisma, `manual-cat-${Math.random()}`);
  const product = await createCatalogProduct(prisma, {
    categoryId: category.id,
    name: `Manual Product ${Math.random()}`,
  });
  const denom = await createDenomination(prisma, {
    productId: product.id,
    name: "Manual Denom",
    type: "SHARED",
    durationLabel: "1 Month",
    price: "10.00",
  });
  await updateDenomination(prisma, denom.id, { deliveryType });
  return denom;
}

/**
 * Per-SKU delivery flows (Task 4): the two new outbox-dispatcher DM paths for
 * manual (hand-fulfilled) orders — ORDER_PROCESSING_DM (payment confirmed,
 * queued for hand-fulfilment) and ORDER_MANUAL_DELIVERED_DM (admin typed and
 * sent the account). Seeds real orders through settlePaidOrder/
 * fulfillManualOrder (the actual enqueue call sites from Task 3), not
 * hand-crafted outbox rows.
 */
describe("drainBatch delivers the per-SKU manual delivery-flow DMs", () => {
  /** Each test creates its own buyer (unique telegramId — this file runs many
   * tests against one shared temp DB with no per-test reset, so ids/names
   * across tests/describe-blocks must never collide) and admin. */
  async function makeBuyer(telegramId: number) {
    return upsertUser(prisma, { telegramId, username: `buyer${telegramId}`, fullName: "Manual Buyer" });
  }
  async function makeAdmin(telegramId: number) {
    return prisma.user.create({
      data: { telegramId: BigInt(telegramId), referralCode: `admin-${Math.random()}`, role: "ADMIN" },
    });
  }

  it("turns an ORDER_PROCESSING_DM row (payment confirmed, queued for hand-fulfilment) into a sendMessage and marks it SENT", async () => {
    const buyer = await makeBuyer(500_001);
    const admin = await makeAdmin(900_000_001);
    const denom = await makeManualDenom();
    const order = await createOrderDirect(prisma, { user: buyer, productId: denom.id, quantity: 1 });
    await attachPaymentProof(prisma, order!.id, { fileId: "file123", txid: "TX-1" });

    const result = await settlePaidOrder(prisma, order!.id, { adminId: admin.id });
    expect(result.kind).toBe("processing");

    const { bot, sendMessage } = fakeBot();
    await drainBatch(bot);

    expect(sendMessage).toHaveBeenCalledTimes(1);
    const [chatId, text] = sendMessage.mock.calls[0]!;
    expect(chatId).toBe(500_001);
    expect(text).toContain(order!.orderCode);

    const row = await prisma.notificationOutbox.findFirst({
      where: { orderId: order!.id, event: NotificationEvent.ORDER_PROCESSING_DM },
    });
    expect(row!.status).toBe("SENT");
  });

  it("turns an ORDER_MANUAL_DELIVERED_DM row into a sendMessage carrying the admin-typed deliveredContent, read live from the DB, and marks it SENT", async () => {
    const buyer = await makeBuyer(500_002);
    const admin = await makeAdmin(900_000_002);
    const denom = await makeManualDenom();
    const order = await createOrderDirect(prisma, { user: buyer, productId: denom.id, quantity: 1 });
    await attachPaymentProof(prisma, order!.id, { fileId: "file123", txid: "TX-1" });
    await settlePaidOrder(prisma, order!.id, { adminId: admin.id });

    const { order: delivered } = await fulfillManualOrder(prisma, order!.id, {
      adminId: admin.id,
      content: "user: shared42@example.com / pass: hunter2",
    });
    expect(delivered.deliveredContent).toBe("user: shared42@example.com / pass: hunter2");

    const { bot, sendMessage } = fakeBot();
    await drainBatch(bot);

    // The ORDER_PROCESSING_DM sent earlier by settlePaidOrder is drained too —
    // assert on the ORDER_MANUAL_DELIVERED_DM call specifically.
    const manualCall = sendMessage.mock.calls.find((call) =>
      (call[1] as string).includes("shared42@example.com"),
    );
    expect(manualCall).toBeDefined();
    const [chatId, text] = manualCall! as [number, string];
    expect(chatId).toBe(500_002);
    expect(text).toContain(order!.orderCode);
    expect(text).toContain("hunter2");

    const row = await prisma.notificationOutbox.findFirst({
      where: { orderId: order!.id, event: NotificationEvent.ORDER_MANUAL_DELIVERED_DM },
    });
    expect(row!.status).toBe("SENT");
  });

  it("HTML-escapes deliveredContent (admin free-text) before sending", async () => {
    const buyer = await makeBuyer(500_003);
    const admin = await makeAdmin(900_000_003);
    const denom = await makeManualDenom();
    const order = await createOrderDirect(prisma, { user: buyer, productId: denom.id, quantity: 1 });
    await attachPaymentProof(prisma, order!.id, { fileId: "file123", txid: "TX-1" });
    await settlePaidOrder(prisma, order!.id, { adminId: admin.id });
    await fulfillManualOrder(prisma, order!.id, { adminId: admin.id, content: "<script>alert(1)</script>" });

    const { bot, sendMessage } = fakeBot();
    await drainBatch(bot);

    const manualCall = sendMessage.mock.calls.find((call) => (call[1] as string).includes("alert(1)"));
    expect(manualCall).toBeDefined();
    const [, text] = manualCall! as [number, string];
    expect(text).not.toContain("<script>");
    expect(text).toContain("&lt;script&gt;");
  });

  it("splits deliveredContent longer than Telegram's 4096-char cap into multiple sequential sendMessage calls, in order", async () => {
    const buyer = await makeBuyer(500_004);
    const admin = await makeAdmin(900_000_004);
    const denom = await makeManualDenom();
    const order = await createOrderDirect(prisma, { user: buyer, productId: denom.id, quantity: 1 });
    await attachPaymentProof(prisma, order!.id, { fileId: "file123", txid: "TX-1" });
    await settlePaidOrder(prisma, order!.id, { adminId: admin.id });
    const longContent = Array.from({ length: 400 }, (_, i) => `line ${i}: some account credential text`).join("\n");
    await fulfillManualOrder(prisma, order!.id, { adminId: admin.id, content: longContent });

    const { bot, sendMessage } = fakeBot();
    await drainBatch(bot);

    // At least the manual-delivered chunks were sent in addition to the
    // earlier ORDER_PROCESSING_DM — find the ones carrying our marker lines.
    const allChunkTexts = sendMessage.mock.calls
      .map((call) => call[1] as string)
      .filter((text: string) => text.includes("line "));
    expect(allChunkTexts.length).toBeGreaterThan(1); // split into multiple messages
    // Reassembled in order: "line 0" appears before "line 399" across the sequence.
    const joined = allChunkTexts.join("\n---\n");
    expect(joined.indexOf("line 0:")).toBeLessThan(joined.indexOf("line 399:"));
    for (const [, text] of sendMessage.mock.calls) {
      expect((text as string).length).toBeLessThanOrEqual(4096);
    }

    const row = await prisma.notificationOutbox.findFirst({
      where: { orderId: order!.id, event: NotificationEvent.ORDER_MANUAL_DELIVERED_DM },
    });
    expect(row!.status).toBe("SENT");
  });

  it("fails the row without sending when the order has no deliveredContent (defensive — should not normally happen)", async () => {
    await prisma.notificationOutbox.create({
      data: {
        event: NotificationEvent.ORDER_MANUAL_DELIVERED_DM,
        orderId: null,
        payloadJson: JSON.stringify({ chat_id: 500_005, order_code: "ORD-DOES-NOT-EXIST", buyer_language: "en" }),
      },
    });

    const { bot, sendMessage } = fakeBot();
    await drainBatch(bot);

    expect(sendMessage).not.toHaveBeenCalled();
    const row = await prisma.notificationOutbox.findFirst({
      where: { event: NotificationEvent.ORDER_MANUAL_DELIVERED_DM, orderId: null },
    });
    expect(row!.status).toBe("FAILED"); // markNotificationFailed(..., maxAttempts=1) fails immediately
    expect(row!.lastError).toContain("order not found");
  });
});

describe("PRODUCT_RESTOCKED_BROADCAST", () => {
  it("routes as a DM to the customer's chat_id (not a public-channel post) and marks the row SENT", async () => {
    const user = await upsertUser(prisma, { telegramId: 700_001, username: "restockfan", fullName: null });
    await enqueueRestockBroadcast(prisma, { productName: "1 Month CapCut Pro", stockCount: 7 });

    const { bot, sendMessage } = fakeBot();
    await drainBatch(bot);

    expect(sendMessage).toHaveBeenCalledWith(
      Number(user.telegramId),
      expect.stringContaining("1 Month CapCut Pro"),
      { parse_mode: "HTML" },
    );
    const row = await prisma.notificationOutbox.findFirst({
      where: { event: NotificationEvent.PRODUCT_RESTOCKED_BROADCAST },
      orderBy: { id: "desc" },
    });
    expect(row!.status).toBe("SENT");
  });
});
