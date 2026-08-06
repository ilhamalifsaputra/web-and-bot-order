// Mocked before any real import so no test in this file ever opens a real
// SMTP connection — same pattern the storefront test suites use for
// `@app/core/mailer` (e.g. apps/storefront/test/storefront.test.ts). vi.mock
// calls are hoisted above imports by vitest regardless of source position, so
// this doesn't disturb dispatcher.test-setup's requirement to run first: the
// factory below is pure (no side effects, no eager import of the real
// module), it only takes effect once "@app/core/mailer" is actually imported
// further down. `vi` itself comes from the named-imports block below —
// hoisted the same way, so it's already bound by the time this call runs.
vi.mock("@app/core/mailer", () => ({
  sendMail: vi.fn().mockResolvedValue(undefined),
}));

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
  enqueueAdminStalePayment,
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
  addAdminIdToDb,
  setSetting,
  SMTP_HOST_KEY,
  SMTP_FROM_KEY,
  createTicket,
} from "@app/db";
import { setBotIdentity, resetBotIdentity } from "@app/core/runtime";
import { NotificationEvent, NotificationChannel, OrderCurrency, DeliveryType } from "@app/core/enums";
import { config } from "@app/core/config";
import { sendMail } from "@app/core/mailer";
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
 * M-10 fix (backend audit 2026-07-31): ADMIN_STALE_PAYMENT must be routed as
 * an admin DM (payload.chat_id), not a post to PUBLIC_CHANNEL_ID — the first
 * implementation of this event omitted it from ADMIN_DM_EVENTS, which either
 * silently dropped the alert forever (no channel configured) or leaked
 * payment-reconciliation detail to the public channel (channel configured).
 * This test exercises both consequences directly and asserts neither happens.
 */
describe("drainBatch routes ADMIN_STALE_PAYMENT as an admin DM, never a public post (M-10)", () => {
  afterEach(() => resetBotIdentity());

  // Note: this file runs many tests against one shared temp DB with no
  // per-test reset (per the file-level comment above), and `addAdminIdToDb`
  // is a union — every admin id ever added by an earlier test in this file
  // is still resolved here, so `enqueueAdminStalePayment` fans out to all of
  // them. Each test below isolates ITS OWN admin's call among however many
  // fire, exactly like the ADMIN_MANUAL_ORDER_QUEUED test above does.

  it("sends to the admin's chat_id even when a public channel IS configured", async () => {
    await addAdminIdToDb(prisma, 900_100_001);
    setBotIdentity({ publicChannelId: -1009876543210 });
    const buyer = await upsertUser(prisma, { telegramId: 500_101, username: "buyer500101", fullName: "Stale Buyer 1" });
    const denom = await makeManualDenom();
    const order = await createOrderDirect(prisma, { user: buyer, productId: denom.id, quantity: 1 });
    await enqueueAdminStalePayment(prisma, {
      orderId: order!.id,
      orderCode: order!.orderCode,
      gateway: "tokopay",
      trxId: "TRX-STALE-1",
    });

    const { bot, sendMessage } = fakeBot();
    await drainBatch(bot);

    const call = sendMessage.mock.calls.find((c) => c[0] === 900_100_001);
    expect(call).toBeDefined();
    const [chatId, text] = call! as [number, string];
    expect(chatId).not.toBe(-1009876543210); // never the public channel
    expect(text).toContain(order!.orderCode);

    const row = await prisma.notificationOutbox.findFirst({
      where: { orderId: order!.id, event: NotificationEvent.ADMIN_STALE_PAYMENT },
    });
    expect(row!.status).toBe("SENT");
  });

  it("still sends to the admin's chat_id when NO public channel is configured (would otherwise be misrouted as a channel-post release-forever)", async () => {
    await addAdminIdToDb(prisma, 900_100_002);
    const buyer = await upsertUser(prisma, { telegramId: 500_102, username: "buyer500102", fullName: "Stale Buyer 2" });
    const denom = await makeManualDenom();
    const order = await createOrderDirect(prisma, { user: buyer, productId: denom.id, quantity: 1 });
    await enqueueAdminStalePayment(prisma, {
      orderId: order!.id,
      orderCode: order!.orderCode,
      gateway: "paydisini",
      trxId: "TRX-STALE-2",
    });

    const { bot, sendMessage } = fakeBot();
    await drainBatch(bot);

    const call = sendMessage.mock.calls.find((c) => c[0] === 900_100_002);
    expect(call).toBeDefined();
    const [, text] = call! as [number, string];
    expect(text).toContain(order!.orderCode);

    const row = await prisma.notificationOutbox.findFirst({
      where: { orderId: order!.id, event: NotificationEvent.ADMIN_STALE_PAYMENT },
    });
    expect(row!.status).toBe("SENT");
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

    // settlePaidOrder also enqueues an ADMIN_MANUAL_ORDER_QUEUED alert
    // (asserted separately below), so this buyer's chat id may not be the
    // only call — find the buyer's specifically, same pattern the later
    // tests in this block use to isolate one call among several.
    const buyerCall = sendMessage.mock.calls.find((call) => call[0] === 500_001);
    expect(buyerCall).toBeDefined();
    const [, text] = buyerCall! as [number, string];
    expect(text).toContain(order!.orderCode);

    const row = await prisma.notificationOutbox.findFirst({
      where: { orderId: order!.id, event: NotificationEvent.ORDER_PROCESSING_DM },
    });
    expect(row!.status).toBe("SENT");
  });

  it("also alerts admins (ADMIN_MANUAL_ORDER_QUEUED) that the order needs hand-fulfilment", async () => {
    const buyer = await makeBuyer(500_005);
    const admin = await makeAdmin(900_000_005);
    await addAdminIdToDb(prisma, 900_000_005);
    const denom = await makeManualDenom();
    const order = await createOrderDirect(prisma, { user: buyer, productId: denom.id, quantity: 1 });
    await attachPaymentProof(prisma, order!.id, { fileId: "file123", txid: "TX-1" });

    const result = await settlePaidOrder(prisma, order!.id, { adminId: admin.id });
    expect(result.kind).toBe("processing");

    const { bot, sendMessage } = fakeBot();
    await drainBatch(bot);

    const adminCall = sendMessage.mock.calls.find((call) => call[0] === 900_000_005);
    expect(adminCall).toBeDefined();
    const [, text] = adminCall! as [number, string];
    expect(text).toContain(order!.orderCode);

    const row = await prisma.notificationOutbox.findFirst({
      where: { orderId: order!.id, event: NotificationEvent.ADMIN_MANUAL_ORDER_QUEUED },
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

/**
 * Task 7: the dispatcher's EMAIL lane (owner-email-notifications feature).
 * `row.channel === "EMAIL"` rows never touch `bot.api.sendMessage` — they go
 * through `renderEmail`/`sendMail` instead. Rows are hand-crafted directly
 * against the outbox table (same pattern the Outbox-1/M-10 describe blocks
 * above use) rather than routed through the enqueueOwner*Email helpers, so
 * each test doesn't also need to configure the owner-email master/per-event
 * Settings toggles those helpers gate on — the dispatcher doesn't care how a
 * row got there, only what's in it.
 *
 * Ordering matters within this block: the very first test relies on SMTP
 * being unconfigured, which is only true before any later test in this file
 * calls `setSetting` for smtp_host/smtp_from — those Settings persist for the
 * rest of the file (this suite runs against one shared temp DB with no
 * per-test reset, same as every other describe block here).
 */
describe("drainBatch EMAIL lane (owner email notifications)", () => {
  afterEach(() => {
    vi.mocked(sendMail).mockReset().mockResolvedValue(undefined);
  });

  it("leaves the row PENDING with a backoff nextRetryAt (never FAILED) when SMTP is unconfigured, and never calls sendMail", async () => {
    await prisma.notificationOutbox.create({
      data: {
        event: NotificationEvent.OWNER_EMAIL_NEW_TICKET,
        channel: NotificationChannel.EMAIL,
        orderId: null,
        payloadJson: JSON.stringify({ to: "owner@example.com", ticket_id: 4001, message: "Need help with my order" }),
      },
    });

    const { bot, sendMessage } = fakeBot();
    await drainBatch(bot);

    expect(sendMail).not.toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();

    const row = await prisma.notificationOutbox.findFirst({
      where: { event: NotificationEvent.OWNER_EMAIL_NEW_TICKET, orderId: null },
      orderBy: { id: "desc" },
    });
    expect(row!.status).toBe("PENDING");
    expect(row!.status).not.toBe("FAILED");
    expect(row!.nextRetryAt).not.toBeNull();
    expect(row!.nextRetryAt!.getTime()).toBeGreaterThan(Date.now());
  });

  it("fails an EMAIL row at once (maxAttempts=1) when the event has no email template, without calling sendMail", async () => {
    await prisma.notificationOutbox.create({
      data: {
        event: "OWNER_EMAIL_NOT_A_REAL_EVENT",
        channel: NotificationChannel.EMAIL,
        orderId: null,
        payloadJson: JSON.stringify({ to: "owner@example.com" }),
      },
    });

    const { bot } = fakeBot();
    await drainBatch(bot);

    expect(sendMail).not.toHaveBeenCalled();
    const row = await prisma.notificationOutbox.findFirst({
      where: { event: "OWNER_EMAIL_NOT_A_REAL_EVENT" },
      orderBy: { id: "desc" },
    });
    expect(row!.status).toBe("FAILED");
    expect(row!.attempts).toBe(1);
    expect(row!.lastError).toContain("no email template for event");
  });

  it("fails an EMAIL row at once (maxAttempts=1) when payload.to is missing, without calling sendMail", async () => {
    await prisma.notificationOutbox.create({
      data: {
        event: NotificationEvent.OWNER_EMAIL_NEW_TICKET,
        channel: NotificationChannel.EMAIL,
        orderId: null,
        payloadJson: JSON.stringify({ ticket_id: 4002, message: "No recipient on this row" }),
      },
    });

    const { bot } = fakeBot();
    await drainBatch(bot);

    expect(sendMail).not.toHaveBeenCalled();
    const row = await prisma.notificationOutbox.findFirst({
      where: { event: NotificationEvent.OWNER_EMAIL_NEW_TICKET, orderId: null, payloadJson: { contains: "4002" } },
      orderBy: { id: "desc" },
    });
    expect(row!.status).toBe("FAILED");
    expect(row!.attempts).toBe(1);
    expect(row!.lastError).toContain("missing to address");
  });

  it("once SMTP is configured, sends a valid EMAIL row via sendMail with the rendered {to, subject, text} and marks it SENT, never touching bot.api.sendMessage", async () => {
    await setSetting(prisma, SMTP_HOST_KEY, "smtp.test.invalid");
    await setSetting(prisma, SMTP_FROM_KEY, "Shop <shop@test.invalid>");

    await prisma.notificationOutbox.create({
      data: {
        event: NotificationEvent.OWNER_EMAIL_ORDER_PAID,
        channel: NotificationChannel.EMAIL,
        orderId: null,
        payloadJson: JSON.stringify({
          to: "owner@example.com",
          order_code: "ORD-EMAIL-1",
          total: "10.00",
          currency: "USDT",
          item_count: 2,
        }),
      },
    });

    const { bot, sendMessage } = fakeBot();
    await drainBatch(bot);

    expect(sendMail).toHaveBeenCalledTimes(1);
    const [, args] = vi.mocked(sendMail).mock.calls[0]!;
    expect(args).toEqual({
      to: "owner@example.com",
      subject: "New paid order",
      text: expect.stringContaining("ORD-EMAIL-1"),
    });
    expect(sendMessage).not.toHaveBeenCalled();

    const row = await prisma.notificationOutbox.findFirst({
      where: { event: NotificationEvent.OWNER_EMAIL_ORDER_PAID, orderId: null },
      orderBy: { id: "desc" },
    });
    expect(row!.status).toBe("SENT");
  });

  it("marks an EMAIL row FAILED once sendMail failures reach NOTIF_MAX_ATTEMPTS, backing off between each attempt like the Telegram generic-failure path", async () => {
    // SMTP is already configured by the previous test (persists — no
    // per-test DB reset in this file).
    vi.mocked(sendMail).mockRejectedValue(new Error("smtp connection refused"));

    await prisma.notificationOutbox.create({
      data: {
        event: NotificationEvent.OWNER_EMAIL_TICKET_REPLY,
        channel: NotificationChannel.EMAIL,
        orderId: null,
        payloadJson: JSON.stringify({ to: "owner@example.com", ticket_id: 4003, message: "A reply that will fail to send" }),
      },
    });
    const row = await prisma.notificationOutbox.findFirst({
      where: { event: NotificationEvent.OWNER_EMAIL_TICKET_REPLY, orderId: null },
      orderBy: { id: "desc" },
    });

    const { bot } = fakeBot();
    await drainBatch(bot);

    const after1 = await prisma.notificationOutbox.findUnique({ where: { id: row!.id } });
    expect(after1!.status).toBe("PENDING");
    expect(after1!.attempts).toBe(1);
    expect(after1!.nextRetryAt).not.toBeNull();

    // Drive the remaining attempts by clearing the backoff window each time,
    // same technique the Outbox-1 describe block above uses.
    for (let i = 1; i < config.NOTIF_MAX_ATTEMPTS; i++) {
      await prisma.notificationOutbox.update({
        where: { id: row!.id },
        data: { nextRetryAt: new Date(Date.now() - 1000) },
      });
      await drainBatch(bot);
    }

    const final = await prisma.notificationOutbox.findUnique({ where: { id: row!.id } });
    expect(final!.status).toBe("FAILED");
    expect(final!.attempts).toBe(config.NOTIF_MAX_ATTEMPTS);
    expect(final!.lastError).toContain("smtp connection refused");
  });

  it("a TELEGRAM-channel row (schema default channel, no channel set) is unaffected by the EMAIL lane — still sent via bot.api.sendMessage, and sendMail is never called", async () => {
    await enqueueAdminPasswordReset(prisma, { telegramId: 777888, code: "TG-STILL-WORKS", ttlMinutes: 10 });

    const { bot, sendMessage } = fakeBot();
    await drainBatch(bot);

    const call = sendMessage.mock.calls.find((c) => c[0] === 777888);
    expect(call).toBeDefined();
    expect(sendMail).not.toHaveBeenCalled();

    const row = await prisma.notificationOutbox.findFirst({
      where: { event: "ADMIN_PW_RESET", payloadJson: { contains: "TG-STILL-WORKS" } },
      orderBy: { id: "desc" },
    });
    expect(row!.channel).toBe("TELEGRAM");
    expect(row!.status).toBe("SENT");
  });

  /**
   * Full-chain integration test (final-review Finding 2): every other test in
   * this describe block hand-crafts its outbox row's payloadJson with a
   * literal the test author typed, so the enqueue-layer's field names
   * (Task 3, packages/db/src/crud/notifications.ts) and the render-layer's
   * expected field names (Task 6, emailTemplates.ts, consumed by the
   * dispatcher below) are only ever asserted independently — a rename on one
   * side alone would leave every existing test in this file green while
   * production email breaks. This test instead goes through the REAL
   * `createTicket` (which calls the real `enqueueOwnerNewTicketEmail`) and
   * then the real `drainBatch`, proving the whole enqueue -> claim -> render
   * -> send chain actually connects end to end.
   */
  it("full chain: createTicket's real enqueue -> drainBatch's real claim/render/send produces the expected owner email (Finding 2)", async () => {
    await setSetting(prisma, SMTP_HOST_KEY, "smtp.test.invalid");
    await setSetting(prisma, SMTP_FROM_KEY, "Shop <shop@test.invalid>");
    await setSetting(prisma, "owner_email_enabled", "true");
    await setSetting(prisma, "owner_email", "owner@example.com");
    await setSetting(prisma, "owner_email_on_new_ticket", "true");

    const user = await upsertUser(prisma, { telegramId: 800_001, username: "fullchainuser", fullName: "Full Chain User" });
    const ticket = await createTicket(prisma, user.id, "The full chain test message");

    const { bot, sendMessage } = fakeBot();
    await drainBatch(bot);

    expect(sendMail).toHaveBeenCalledTimes(1);
    const [, args] = vi.mocked(sendMail).mock.calls[0]!;
    expect(args.to).toBe("owner@example.com");
    expect(args.subject).toBe("New support ticket");
    expect(args.text).toContain(`#${ticket.id}`);
    expect(args.text).toContain("The full chain test message");
    expect(sendMessage).not.toHaveBeenCalled();

    const row = await prisma.notificationOutbox.findFirst({
      where: { event: NotificationEvent.OWNER_EMAIL_NEW_TICKET, orderId: null },
      orderBy: { id: "desc" },
    });
    expect(row!.status).toBe("SENT");
  });
});
