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

/**
 * Lets a single test (Task 15 / I-3, the outbox dispatcher heartbeat) force
 * `fetchPendingNotifications` to reject, so `runDispatcher`'s catch path can
 * be exercised without any other test in this file losing the real DB
 * behavior — mirrors the identical `dbMockState` pattern in
 * apps/order-bot/test/jobs.test.ts (that file forces `updateBroadcastProgress`
 * to fail the same way). `vi.hoisted` is needed because the `vi.mock` factory
 * below runs before ordinary module-level `let`s are initialised.
 *
 * `recordPollHealthError` (final whole-branch review, Important #1): lets a
 * test force `recordPollHealth` itself to reject, proving `runDispatcher`'s
 * `.catch(() => undefined)` guard on both call sites keeps the loop alive
 * even when the heartbeat write is the thing that fails — not just the tick
 * it's recording the outcome of.
 */
const dbMockState = vi.hoisted(() => ({
  fetchPendingError: null as Error | null,
  recordPollHealthError: null as Error | null,
}));
vi.mock("@app/db", async () => {
  const actual = await vi.importActual<typeof import("@app/db")>("@app/db");
  return {
    ...actual,
    fetchPendingNotifications: async (...args: Parameters<typeof actual.fetchPendingNotifications>) => {
      if (dbMockState.fetchPendingError) throw dbMockState.fetchPendingError;
      return actual.fetchPendingNotifications(...args);
    },
    recordPollHealth: async (...args: Parameters<typeof actual.recordPollHealth>) => {
      if (dbMockState.recordPollHealthError) throw dbMockState.recordPollHealthError;
      return actual.recordPollHealth(...args);
    },
  };
});

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
import type { Bot, InlineKeyboard } from "grammy";
import {
  prisma,
  enqueueAdminPasswordReset,
  enqueueAdminStalePayment,
  enqueueAdminDigiflazzResyncAborted,
  enqueueAdminFxRateRejected,
  enqueueAdminFxRateStale,
  completeOrderWithWalletCredit,
  enqueueOrderDeliveredDm,
  enqueueRestockBroadcast,
  enqueueWalletTopupCreditedDm,
  enqueueNotification,
  adjustWallet,
  createOrderDirect,
  attachPaymentProof,
  settlePaidOrder,
  fulfillManualOrder,
  createCategory,
  createCatalogProduct,
  createDenomination,
  updateDenomination,
  bulkAddStock,
  upsertUser,
  addAdminIdToDb,
  setSetting,
  SMTP_HOST_KEY,
  SMTP_FROM_KEY,
  createTicket,
  getPollHealth,
  enqueueAdminNewTicketDm,
  enqueueTicketReplyDm,
  enqueueTicketClosedDm,
} from "@app/db";
import { setBotIdentity, resetBotIdentity } from "@app/core/runtime";
import { registerPaymentBubbleFlush } from "@app/core/nudge";
import { NotificationEvent, NotificationChannel, OrderCurrency, DeliveryType, ProductType } from "@app/core/enums";
import { config } from "@app/core/config";
import { Decimal } from "@app/core/money";
import { sendMail } from "@app/core/mailer";
import { buildSampleData } from "../../../tests/helpers/sampleData";
import { drainBatch, runDispatcher } from "./dispatcher";

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
 * Task 10: ADMIN_DIGIFLAZZ_RESYNC_ABORTED must be routed as an admin DM
 * (payload.chat_id), not a post to PUBLIC_CHANNEL_ID — same M-10-shaped risk
 * as ADMIN_STALE_PAYMENT above (an event left out of ADMIN_DM_EVENTS either
 * gets silently dropped forever with no channel configured, or leaks the
 * catalog-resync alert to the public channel when one is configured). This
 * event is not order-scoped (orderId: null), unlike ADMIN_STALE_PAYMENT.
 */
describe("drainBatch routes ADMIN_DIGIFLAZZ_RESYNC_ABORTED as an admin DM, never a public post (Task 10)", () => {
  afterEach(() => resetBotIdentity());

  it("sends to the admin's chat_id even when a public channel IS configured, with orderId null", async () => {
    await addAdminIdToDb(prisma, 900_200_001);
    setBotIdentity({ publicChannelId: -1009876543211 });
    await enqueueAdminDigiflazzResyncAborted(prisma, { kind: "sharp_change", sharpChanges: 7, consideredRows: 10 });

    const { bot, sendMessage } = fakeBot();
    await drainBatch(bot);

    const call = sendMessage.mock.calls.find((c) => c[0] === 900_200_001);
    expect(call).toBeDefined();
    const [chatId, text] = call! as [number, string];
    expect(chatId).not.toBe(-1009876543211); // never the public channel
    expect(text).toContain("7");
    expect(text).toContain("10");

    const rows = await prisma.notificationOutbox.findMany({
      where: { event: NotificationEvent.ADMIN_DIGIFLAZZ_RESYNC_ABORTED, orderId: null },
    });
    const row = rows.find((r) => (JSON.parse(r.payloadJson) as { chat_id: number }).chat_id === 900_200_001);
    expect(row).toBeDefined();
    expect(row!.status).toBe("SENT");
  });
});

/**
 * M13 / audit P0-3: both FX alerts must be routed as admin DMs, never posts to
 * PUBLIC_CHANNEL_ID — same M-10-shaped risk as the two blocks above, with a
 * sharper edge here. ADMIN_FX_RATE_STALE says in plain language that the shop
 * cannot take USDT payments right now; on the public channel that is an outage
 * announcement to every customer.
 */
describe("drainBatch routes both FX alerts as admin DMs, never public posts (M13)", () => {
  afterEach(() => resetBotIdentity());

  it("sends ADMIN_FX_RATE_REJECTED and ADMIN_FX_RATE_STALE to the admin's chat_id with a public channel configured", async () => {
    await addAdminIdToDb(prisma, 900_200_002);
    setBotIdentity({ publicChannelId: -1009876543212 });
    await enqueueAdminFxRateRejected(prisma, {
      reason: "above_max",
      market: "16200000",
      rate: "16200000",
      saved: "16000",
      consecutiveFailures: 2,
      max: "40000",
    });
    await enqueueAdminFxRateStale(prisma, {
      confirmedAt: new Date("2026-09-14T00:00:00.000Z"),
      ageHours: "72.4",
      maxAgeHours: "48",
    });

    const { bot, sendMessage } = fakeBot();
    await drainBatch(bot);

    const calls = sendMessage.mock.calls.filter((c) => c[0] === 900_200_002) as [number, string][];
    expect(calls.length).toBe(2);
    expect(sendMessage.mock.calls.some((c) => c[0] === -1009876543212)).toBe(false);
    expect(calls.some(([, text]) => text.includes("40000"))).toBe(true);
    expect(calls.some(([, text]) => /USDT payments are switched off/i.test(text))).toBe(true);

    for (const event of [NotificationEvent.ADMIN_FX_RATE_REJECTED, NotificationEvent.ADMIN_FX_RATE_STALE]) {
      const rows = await prisma.notificationOutbox.findMany({ where: { event, orderId: null } });
      const row = rows.find((r) => (JSON.parse(r.payloadJson) as { chat_id: number }).chat_id === 900_200_002);
      expect(row, `${event} should have a row for this admin`).toBeDefined();
      expect(row!.status).toBe("SENT");
    }
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

/**
 * Task E3: the payment-bubble flush hook (`flushPaymentBubble`,
 * `@app/core/nudge`) must run, and finish, before this dispatcher sends any
 * of the four order-scoped settlement DMs — ORDER_DELIVERED_DM,
 * ORDER_MANUAL_DELIVERED_DM, WALLET_TOPUP_CREDITED_DM, ORDER_PROCESSING_DM —
 * never for an admin
 * DM, a channel post, or a broadcast (see dispatcher.ts's own module doc-
 * comment for the full "why": a buyer's account file/top-up notice used to
 * land before the "Payment received" bubble flip, purely a message-ordering
 * artefact this hook exists to close).
 *
 * These tests register a FAKE flush implementation via
 * `registerPaymentBubbleFlush` — the same registry apps/server's boot uses
 * in production — so call order can be observed directly, without a real
 * order-bot `Api` or a real anchored bubble. The real implementation
 * (`flushSettledOrderBubble`, apps/order-bot/src/jobs/index.ts) has its own
 * dedicated tests in apps/order-bot/test/jobs.test.ts.
 */
describe("drainBatch flushes the payment bubble before a settlement DM (Task E3)", () => {
  afterEach(() => registerPaymentBubbleFlush(null));

  /** A DELIVERED order with real stock credentials (own category/product/
   *  denomination/user, all with unique ids — this file shares one temp DB
   *  across every test with no per-test reset, so nothing here may reuse
   *  buildSampleData's fixed telegramId 42). */
  async function makeDeliveredOrder(telegramId: number) {
    const user = await upsertUser(prisma, { telegramId, username: `e3buyer${telegramId}`, fullName: "E3 Buyer" });
    const category = await createCategory(prisma, `e3-cat-${telegramId}`);
    const parent = await createCatalogProduct(prisma, { categoryId: category.id, name: `E3 Product ${telegramId}` });
    const denom = await createDenomination(prisma, {
      productId: parent.id,
      name: "E3 Denom",
      type: ProductType.SHARED,
      durationLabel: "1 Month",
      price: "5.00",
    });
    await bulkAddStock(prisma, denom.id, [`e3-cred-${telegramId}@example.com:pwd`]);
    // Real wallet credit first (matches the pre-existing ORDER_DELIVERED_DM
    // test above) — completeOrderWithWalletCredit deducts the price from the
    // ACTUAL DB balance, not from whatever `walletBalance` is passed in.
    await adjustWallet(prisma, user.id, "10", { currency: "IDR", reason: "admin_adjust" });
    const funded = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    const { order } = await prisma.$transaction((tx) =>
      completeOrderWithWalletCredit(tx, {
        user: { id: funded.id, role: funded.role, walletBalance: funded.walletBalance },
        productId: denom.id,
        quantity: 1,
        currency: OrderCurrency.IDR,
      }),
    );
    return { user, order };
  }

  it("flushes before an ORDER_DELIVERED_DM's sendDocument", async () => {
    const { order } = await makeDeliveredOrder(600_101);
    await enqueueOrderDeliveredDm(prisma, {
      orderId: order.id,
      orderCode: order.orderCode,
      telegramId: BigInt(600_101),
      language: "en",
    });

    const log: string[] = [];
    registerPaymentBubbleFlush(async (orderId) => {
      expect(orderId).toBe(order.id);
      log.push("flush");
    });
    const sendDocument = vi.fn(async () => {
      log.push("dm");
      return { message_id: 1 };
    });
    const bot = { api: { sendDocument, sendMessage: vi.fn() } } as unknown as Bot;

    await drainBatch(bot);

    expect(log).toEqual(["flush", "dm"]);
  });

  it("flushes before a WALLET_TOPUP_CREDITED_DM's sendMessage", async () => {
    const { order } = await makeDeliveredOrder(600_102);
    await enqueueWalletTopupCreditedDm(prisma, {
      orderId: order.id,
      orderCode: order.orderCode,
      chatId: 600_102,
      amount: new Decimal("50000"),
      currency: "IDR",
      newBalance: new Decimal("125000"),
    });

    const log: string[] = [];
    registerPaymentBubbleFlush(async (orderId) => {
      expect(orderId).toBe(order.id);
      log.push("flush");
    });
    const sendMessage = vi.fn(async () => {
      log.push("dm");
      return { message_id: 1 };
    });
    const bot = { api: { sendMessage, sendDocument: vi.fn() } } as unknown as Bot;

    await drainBatch(bot);

    expect(log).toEqual(["flush", "dm"]);
  });

  it("flushes before an ORDER_MANUAL_DELIVERED_DM's sendMessage", async () => {
    const buyer = await upsertUser(prisma, { telegramId: 600_103, username: "e3manualbuyer", fullName: "E3 Manual Buyer" });
    const admin = await prisma.user.create({
      data: { telegramId: BigInt(900_600_103), referralCode: `e3-admin-${Math.random()}`, role: "ADMIN" },
    });
    const category = await createCategory(prisma, "e3-manual-cat");
    const parent = await createCatalogProduct(prisma, { categoryId: category.id, name: "E3 Manual Product" });
    const denom = await createDenomination(prisma, {
      productId: parent.id,
      name: "E3 Manual Denom",
      type: "SHARED",
      durationLabel: "1 Month",
      price: "10.00",
    });
    await updateDenomination(prisma, denom.id, { deliveryType: DeliveryType.MANUAL });
    const order = await createOrderDirect(prisma, { user: buyer, productId: denom.id, quantity: 1 });
    await attachPaymentProof(prisma, order!.id, { fileId: "file123", txid: "TX-E3" });

    // settlePaidOrder enqueues ORDER_PROCESSING_DM — drain it FIRST, with no
    // flush hook registered, so the flush-count assertion below can only
    // count the ORDER_MANUAL_DELIVERED_DM's own flush. (That DM flushes too
    // since the final whole-branch review; the test immediately below is the
    // one that pins it. Draining it here is isolation, not a statement that
    // it does not flush — which is what this test's own name used to imply.)
    const result = await settlePaidOrder(prisma, order!.id, { adminId: admin.id });
    expect(result.kind).toBe("processing");
    const preBot = { api: { sendMessage: vi.fn().mockResolvedValue({ message_id: 1 }), sendDocument: vi.fn() } } as unknown as Bot;
    await drainBatch(preBot);

    await fulfillManualOrder(prisma, order!.id, { adminId: admin.id, content: "user: e3@example.com / pass: hunter2" });

    const log: string[] = [];
    let flushCount = 0;
    registerPaymentBubbleFlush(async (orderId) => {
      expect(orderId).toBe(order!.id);
      flushCount++;
      log.push("flush");
    });
    const sendMessage = vi.fn(async () => {
      log.push("dm");
      return { message_id: 1 };
    });
    const bot = { api: { sendMessage, sendDocument: vi.fn() } } as unknown as Bot;

    await drainBatch(bot);

    expect(flushCount).toBe(1); // exactly once — the ORDER_MANUAL_DELIVERED_DM row only
    expect(log).toEqual(["flush", "dm"]);
  });

  // Added by the final whole-branch review. ORDER_PROCESSING_DM was the one
  // order-scoped settlement DM the hook did not cover, and the one the
  // per-rail reordering could never fix on its own: `settlePaidOrder` enqueues
  // it INSIDE the settlement transaction, so it can already be sitting in the
  // outbox before the rail reaches its own bubble flip. A buyer of a
  // hand-fulfilled SKU would read "your order is being prepared" above a
  // bubble still saying "waiting for payment" — the reported bug's symptom on
  // a different message.
  it("flushes before an ORDER_PROCESSING_DM, the DM a rail cannot order correctly by itself", async () => {
    const { order } = await makeDeliveredOrder(600_107);
    await enqueueNotification(prisma, NotificationEvent.ORDER_PROCESSING_DM, order.id, {
      chat_id: 600_107,
      order_code: order.orderCode,
      buyer_language: "en",
    });

    const log: string[] = [];
    registerPaymentBubbleFlush(async (orderId) => {
      expect(orderId).toBe(order.id);
      log.push("flush");
    });
    const sendMessage = vi.fn(async () => {
      log.push("dm");
      return { message_id: 1 };
    });
    const bot = { api: { sendMessage, sendDocument: vi.fn() } } as unknown as Bot;

    await drainBatch(bot);

    expect(log).toEqual(["flush", "dm"]);
  });

  it("does NOT call the flush hook for an admin DM (ADMIN_PW_RESET has no payment bubble)", async () => {
    await enqueueAdminPasswordReset(prisma, { telegramId: 600_104, code: "E3CODE1", ttlMinutes: 10 });

    const flush = vi.fn(async () => undefined);
    registerPaymentBubbleFlush(flush);
    const { bot, sendMessage } = fakeBot();

    await drainBatch(bot);

    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(flush).not.toHaveBeenCalled();
  });

  it("still sends the ORDER_DELIVERED_DM when the flush hook throws", async () => {
    const { order } = await makeDeliveredOrder(600_105);
    await enqueueOrderDeliveredDm(prisma, {
      orderId: order.id,
      orderCode: order.orderCode,
      telegramId: BigInt(600_105),
      language: "en",
    });
    registerPaymentBubbleFlush(async () => {
      throw new Error("flush blew up");
    });
    const { bot, sendDocument } = fakeDocBot();

    await drainBatch(bot);

    expect(sendDocument).toHaveBeenCalledTimes(1);
    const dm = await prisma.notificationOutbox.findFirst({
      where: { orderId: order.id, event: NotificationEvent.ORDER_DELIVERED_DM },
    });
    expect(dm!.status).toBe("SENT");
  });

  it("still sends the ORDER_DELIVERED_DM when the flush hook hangs past its bound", async () => {
    const { order } = await makeDeliveredOrder(600_106);
    await enqueueOrderDeliveredDm(prisma, {
      orderId: order.id,
      orderCode: order.orderCode,
      telegramId: BigInt(600_106),
      language: "en",
    });
    registerPaymentBubbleFlush(() => new Promise<void>(() => undefined)); // never resolves
    const { bot, sendDocument } = fakeDocBot();

    await drainBatch(bot);

    expect(sendDocument).toHaveBeenCalledTimes(1);
    const dm = await prisma.notificationOutbox.findFirst({
      where: { orderId: order.id, event: NotificationEvent.ORDER_DELIVERED_DM },
    });
    expect(dm!.status).toBe("SENT");
  }, 10_000);
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

/**
 * Task 2 (Phase C): the three ticket-notification events that used to call
 * ctx.api.sendMessage() directly from apps/order-bot (conversations/
 * support.ts, conversations/admin.ts, handlers/admin.ts) — now routed
 * through notification_outbox like every other buyer/admin DM. Each test
 * goes through the real `enqueue*` crud helper (packages/db/src/crud/
 * notifications.ts), then the real `drainBatch`, and asserts on both the
 * rendered payload/text/keyboard AND the row's terminal SENT status — not
 * just "doesn't throw".
 */
describe("ADMIN_NEW_TICKET, TICKET_REPLY_DM, TICKET_CLOSED_DM (Task 2, Phase C)", () => {
  /** Fake Bot that also stubs sendMediaGroup — the call ADMIN_NEW_TICKET
   *  makes when the buyer attached photos. */
  function fakeMediaBot() {
    const sendMessage = vi.fn().mockResolvedValue({ message_id: 1 });
    const sendMediaGroup = vi.fn().mockResolvedValue([{ message_id: 2 }]);
    const bot = { api: { sendMessage, sendMediaGroup, sendDocument: vi.fn() } } as unknown as Bot;
    return { bot, sendMessage, sendMediaGroup };
  }

  it("ADMIN_NEW_TICKET fans out to every resolved admin with the Reply/Close keyboard, and forwards attached photos as a media group", async () => {
    await addAdminIdToDb(prisma, 910_100_001);
    await addAdminIdToDb(prisma, 910_100_002);
    const user = await upsertUser(prisma, { telegramId: 610_001, username: "ticketuser1", fullName: "Ticket User 1" });
    const ticket = await createTicket(prisma, user.id, "I need help with my order");
    await enqueueAdminNewTicketDm(prisma, {
      ticketId: ticket.id,
      fromUserId: 610_001,
      fromUsername: "ticketuser1",
      message: "I need help with my order",
      photoFileIds: ["photo_a", "photo_b"],
    });

    const { bot, sendMessage, sendMediaGroup } = fakeMediaBot();
    await drainBatch(bot);

    const call1 = sendMessage.mock.calls.find((c) => c[0] === 910_100_001);
    const call2 = sendMessage.mock.calls.find((c) => c[0] === 910_100_002);
    expect(call1).toBeDefined();
    expect(call2).toBeDefined();
    const [, text, opts] = call1! as [number, string, { reply_markup: InlineKeyboard; parse_mode: string }];
    expect(text).toContain(`New support ticket #${ticket.id}`);
    expect(text).toContain("610001");
    expect(text).toContain("I need help with my order");
    expect(text).toContain("2 photo(s) attached");
    expect(opts.reply_markup.inline_keyboard[0]).toEqual([
      { text: "💬 Reply", callback_data: `v1:adm:ticket:reply:${ticket.id}` },
      { text: "🔒 Close", callback_data: `v1:adm:ticket:close:${ticket.id}` },
    ]);

    // resolveAdminIds is the UNION of every admin id ever added by an earlier
    // test in this file (shared DB, no per-test reset — same caveat the
    // ADMIN_STALE_PAYMENT/ADMIN_MANUAL_ORDER_QUEUED describe blocks document
    // above), so this fan-out isn't necessarily exactly these two targets —
    // isolate each assertion to OUR two admin ids among however many fired,
    // the same technique those earlier blocks use.
    const mediaCall1 = sendMediaGroup.mock.calls.find((c) => c[0] === 910_100_001);
    const mediaCall2 = sendMediaGroup.mock.calls.find((c) => c[0] === 910_100_002);
    expect(mediaCall1).toBeDefined();
    expect(mediaCall2).toBeDefined();
    expect(mediaCall1![1]).toHaveLength(2);
    expect(mediaCall1![1][0]).toMatchObject({ type: "photo", media: "photo_a" });
    expect(mediaCall1![1][1]).toMatchObject({ type: "photo", media: "photo_b" });

    const rows = await prisma.notificationOutbox.findMany({
      where: { event: NotificationEvent.ADMIN_NEW_TICKET, orderId: null },
    });
    const matching = rows.filter((r) => (JSON.parse(r.payloadJson) as { ticket_id: number }).ticket_id === ticket.id);
    const chatIds = matching.map((r) => (JSON.parse(r.payloadJson) as { chat_id: number }).chat_id);
    expect(chatIds).toContain(910_100_001);
    expect(chatIds).toContain(910_100_002);
    for (const r of matching) expect(r.status).toBe("SENT"); // every fanned-out row, not just ours
  });

  it("ADMIN_NEW_TICKET sends no media group and no photo note when the ticket has no photos", async () => {
    await addAdminIdToDb(prisma, 910_100_003);
    const user = await upsertUser(prisma, { telegramId: 610_002, username: null, fullName: "Ticket User 2" });
    const ticket = await createTicket(prisma, user.id, "Second ticket, no photos");
    await enqueueAdminNewTicketDm(prisma, {
      ticketId: ticket.id,
      fromUserId: 610_002,
      fromUsername: null,
      message: "Second ticket, no photos",
      photoFileIds: [],
    });

    const { bot, sendMessage, sendMediaGroup } = fakeMediaBot();
    await drainBatch(bot);

    const call = sendMessage.mock.calls.find((c) => c[0] === 910_100_003);
    expect(call).toBeDefined();
    const [, text] = call! as [number, string];
    expect(text).not.toContain("photo(s) attached");
    expect(sendMediaGroup).not.toHaveBeenCalled();
  });

  it("HTML-escapes ADMIN_NEW_TICKET's message and username", async () => {
    await addAdminIdToDb(prisma, 910_100_004);
    const user = await upsertUser(prisma, { telegramId: 610_007, username: null, fullName: "Ticket User 7" });
    const ticket = await createTicket(prisma, user.id, "<script>alert(1)</script>");
    await enqueueAdminNewTicketDm(prisma, {
      ticketId: ticket.id,
      fromUserId: 610_007,
      fromUsername: "<b>evil</b>",
      message: "<script>alert(1)</script>",
      photoFileIds: [],
    });

    const { bot, sendMessage } = fakeMediaBot();
    await drainBatch(bot);

    const call = sendMessage.mock.calls.find((c) => c[0] === 910_100_004);
    const [, text] = call! as [number, string];
    expect(text).not.toContain("<script>");
    expect(text).not.toContain("<b>evil</b>");
    expect(text).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(text).toContain("&lt;b&gt;evil&lt;/b&gt;");
  });

  it("fails an ADMIN_NEW_TICKET row without sending when chat_id is missing", async () => {
    await prisma.notificationOutbox.create({
      data: {
        event: NotificationEvent.ADMIN_NEW_TICKET,
        orderId: null,
        payloadJson: JSON.stringify({
          ticket_id: 999_999,
          from_user_id: 1,
          from_username: null,
          message: "x",
          photo_file_ids: [],
        }),
      },
    });

    const { bot, sendMessage } = fakeMediaBot();
    await drainBatch(bot);

    expect(sendMessage).not.toHaveBeenCalled();
    const row = await prisma.notificationOutbox.findFirst({
      where: { event: NotificationEvent.ADMIN_NEW_TICKET, payloadJson: { contains: "999999" } },
    });
    expect(row!.status).toBe("FAILED");
    expect(row!.lastError).toContain("missing chat_id");
  });

  it("TICKET_REPLY_DM sends the admin's reply in English with a Mark-as-Resolved keyboard", async () => {
    const user = await upsertUser(prisma, { telegramId: 610_003, username: "ticketuser3", fullName: "Ticket User 3" });
    const ticket = await createTicket(prisma, user.id, "Reply test ticket");
    await enqueueTicketReplyDm(prisma, { ticketId: ticket.id, chatId: 610_003, message: "We refunded your order." });

    const { bot, sendMessage } = fakeMediaBot();
    await drainBatch(bot);

    const call = sendMessage.mock.calls.find((c) => c[0] === 610_003);
    expect(call).toBeDefined();
    const [, text, opts] = call! as [number, string, { reply_markup: InlineKeyboard }];
    expect(text).toContain("Reply from support:");
    expect(text).toContain("We refunded your order.");
    expect(text).toContain("tap the button below to close this ticket");
    expect(opts.reply_markup.inline_keyboard[0]).toEqual([
      { text: "✅ Mark as Resolved", callback_data: `v1:ticket:close:${ticket.id}` },
    ]);

    const row = await prisma.notificationOutbox.findFirst({
      where: { event: NotificationEvent.TICKET_REPLY_DM, payloadJson: { contains: `"ticket_id":${ticket.id},` } },
    });
    expect(row!.status).toBe("SENT");
  });

  it("HTML-escapes TICKET_REPLY_DM's message", async () => {
    const user = await upsertUser(prisma, { telegramId: 610_004, username: "ticketuser4", fullName: "Ticket User 4" });
    const ticket = await createTicket(prisma, user.id, "Escape test ticket");
    await enqueueTicketReplyDm(prisma, { ticketId: ticket.id, chatId: 610_004, message: "<script>alert(1)</script>" });

    const { bot, sendMessage } = fakeMediaBot();
    await drainBatch(bot);

    const call = sendMessage.mock.calls.find((c) => c[0] === 610_004);
    const [, text] = call! as [number, string];
    expect(text).not.toContain("<script>");
    expect(text).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
  });

  it("TICKET_CLOSED_DM sends the buyer's own-language closed message with no keyboard", async () => {
    const user = await upsertUser(prisma, { telegramId: 610_005, username: "ticketuser5", fullName: "Ticket User 5" });
    const ticket = await createTicket(prisma, user.id, "Closed test ticket");
    await enqueueTicketClosedDm(prisma, { ticketId: ticket.id, chatId: 610_005, buyerLanguage: "id" });

    const { bot, sendMessage } = fakeMediaBot();
    await drainBatch(bot);

    const call = sendMessage.mock.calls.find((c) => c[0] === 610_005);
    expect(call).toBeDefined();
    const [, text, opts] = call! as [number, string, { reply_markup?: unknown }];
    expect(text).toBe("Tiket ditutup. Buka tiket baru jika masih butuh bantuan.");
    expect(opts.reply_markup).toBeUndefined();

    const row = await prisma.notificationOutbox.findFirst({
      where: { event: NotificationEvent.TICKET_CLOSED_DM, payloadJson: { contains: `"ticket_id":${ticket.id},` } },
    });
    expect(row!.status).toBe("SENT");
  });

  it("TICKET_CLOSED_DM defaults to English when buyerLanguage is null", async () => {
    const user = await upsertUser(prisma, { telegramId: 610_006, username: "ticketuser6", fullName: "Ticket User 6" });
    const ticket = await createTicket(prisma, user.id, "Closed test ticket 2");
    await enqueueTicketClosedDm(prisma, { ticketId: ticket.id, chatId: 610_006, buyerLanguage: null });

    const { bot, sendMessage } = fakeMediaBot();
    await drainBatch(bot);

    const call = sendMessage.mock.calls.find((c) => c[0] === 610_006);
    expect(call).toBeDefined();
    const [, text] = call! as [number, string];
    expect(text).toBe("Your ticket has been closed. Open a new one if you need further help.");
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

  it("once SMTP is configured, sends a valid EMAIL row via sendMail with the rendered {to, subject, text, html} and marks it SENT, never touching bot.api.sendMessage", async () => {
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
          customer_label: "buyer@example.com",
          items: [{ name: "Netflix Premium", variant: "1 Month", quantity: 2, unitPrice: "5.00" }],
          subtotal: "10.00",
          discount: "0",
          payment_method: "TOKOPAY",
          transaction_id: "TXN-EMAIL-1",
          voucher_code: null,
          paid_at: "2026-08-07T10:00:00.000Z",
          order_url: null,
        }),
      },
    });

    const { bot, sendMessage } = fakeBot();
    await drainBatch(bot);

    expect(sendMail).toHaveBeenCalledTimes(1);
    const [, args] = vi.mocked(sendMail).mock.calls[0]!;
    expect(args).toEqual({
      to: "owner@example.com",
      subject: "New Paid Order - ORD-EMAIL-1",
      text: expect.stringContaining("ORD-EMAIL-1"),
      html: expect.stringContaining("ORD-EMAIL-1"),
    });
    // The HTML design system is exercised for real here — assert it's a full
    // document, not just any string containing the order code.
    expect(args.html).toContain("<!doctype html>");
    expect(sendMessage).not.toHaveBeenCalled();

    const row = await prisma.notificationOutbox.findFirst({
      where: { event: NotificationEvent.OWNER_EMAIL_ORDER_PAID, orderId: null },
      orderBy: { id: "desc" },
    });
    expect(row!.status).toBe("SENT");
  });

  it("sends a plain-text-only event (OWNER_EMAIL_NEW_TICKET) via sendMail with no html key (undefined), confirming the html upgrade is scoped to OWNER_EMAIL_ORDER_PAID alone", async () => {
    // SMTP is already configured by the previous test (persists — no
    // per-test DB reset in this file).
    await prisma.notificationOutbox.create({
      data: {
        event: NotificationEvent.OWNER_EMAIL_NEW_TICKET,
        channel: NotificationChannel.EMAIL,
        orderId: null,
        payloadJson: JSON.stringify({ to: "owner@example.com", ticket_id: 5001, message: "Plain-text event check" }),
      },
    });

    const { bot } = fakeBot();
    await drainBatch(bot);

    const call = vi.mocked(sendMail).mock.calls.find((c) => (c[1].text as string).includes("Plain-text event check"));
    expect(call).toBeDefined();
    const [, args] = call!;
    expect(args.html).toBeUndefined();
    expect(args.subject).toBe("New support ticket");

    const row = await prisma.notificationOutbox.findFirst({
      where: { event: NotificationEvent.OWNER_EMAIL_NEW_TICKET, orderId: null, payloadJson: { contains: "5001" } },
      orderBy: { id: "desc" },
    });
    expect(row!.status).toBe("SENT");
  });

  it("marks an EMAIL row DEAD_LETTER once sendMail failures reach NOTIF_MAX_ATTEMPTS, backing off between each attempt like the Telegram generic-failure path", async () => {
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
    // This call site passes config.NOTIF_MAX_ATTEMPTS (> 1), so the row was
    // genuinely retried with backoff up to the ceiling — DEAD_LETTER, not
    // FAILED (which is reserved for maxAttempts<=1 one-shot invalid rows).
    expect(final!.status).toBe("DEAD_LETTER");
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

/**
 * Finding 4 (Task E1 review follow-up): `render()` (templates.ts) runs money
 * fields through `formatIdr`/`formatUsdt`, which throw on a non-numeric
 * value — unlike the old raw-passthrough template, which could never throw.
 * Deciding that contract deliberately: `render()` itself stays a strict
 * formatter (throwing is correct for the live checkout/settlement code that
 * also calls those formatters), and `drainBatch` is the caller made
 * resilient — a malformed outbox payload fails just that one row
 * (maxAttempts=1, mirroring the pre-existing "bad payload json" isolation
 * just above it in dispatcher.ts) instead of aborting the rest of the batch
 * and leaving the claimed row stuck in SENDING until the stale-claim window.
 */
describe("drainBatch isolates a render() failure instead of aborting the batch (Finding 4)", () => {
  it("fails a WALLET_TOPUP_CREDITED_DM row with a non-numeric amount at once, without crashing drainBatch or re-sending it", async () => {
    await prisma.notificationOutbox.create({
      data: {
        event: NotificationEvent.WALLET_TOPUP_CREDITED_DM,
        orderId: null,
        payloadJson: JSON.stringify({
          chat_id: 600_001,
          order_code: "TOPUP-CORRUPT-1",
          amount: "not-a-number",
          currency: "IDR",
          new_balance: "100",
        }),
      },
    });
    const row = await prisma.notificationOutbox.findFirst({
      where: { event: NotificationEvent.WALLET_TOPUP_CREDITED_DM, payloadJson: { contains: "TOPUP-CORRUPT-1" } },
      orderBy: { id: "desc" },
    });

    const { bot, sendMessage } = fakeBot();
    // Task 15 (I-3): drainBatch now returns the number of rows it saw this
    // cycle (pending.length) instead of void — this row is the only one
    // pending at this point in the shared-DB test run, so the count is 1.
    // The assertion's real point (unchanged): must not throw out of drainBatch.
    await expect(drainBatch(bot)).resolves.toBe(1);

    expect(sendMessage).not.toHaveBeenCalledWith(600_001, expect.anything(), expect.anything());
    const after = await prisma.notificationOutbox.findUnique({ where: { id: row!.id } });
    expect(after!.status).toBe("FAILED");
    expect(after!.attempts).toBe(1);
    expect(after!.lastError).toContain("template render failed");
  });

  it("keeps draining the rest of the batch after a malformed row — a good row queued alongside it still sends", async () => {
    await prisma.notificationOutbox.create({
      data: {
        event: NotificationEvent.WALLET_TOPUP_CREDITED_DM,
        orderId: null,
        payloadJson: JSON.stringify({
          chat_id: 600_002,
          order_code: "TOPUP-CORRUPT-2",
          amount: "also-not-a-number",
          currency: "USDT",
          new_balance: "5",
        }),
      },
    });
    await enqueueAdminPasswordReset(prisma, { telegramId: 600_003, code: "AFTERBAD1", ttlMinutes: 10 });

    const { bot, sendMessage } = fakeBot();
    await drainBatch(bot);

    const goodCall = sendMessage.mock.calls.find((c) => c[0] === 600_003);
    expect(goodCall).toBeDefined(); // the good row after the bad one was still sent

    const badRow = await prisma.notificationOutbox.findFirst({
      where: { event: NotificationEvent.WALLET_TOPUP_CREDITED_DM, payloadJson: { contains: "TOPUP-CORRUPT-2" } },
    });
    expect(badRow!.status).toBe("FAILED");
  });
});

/**
 * Task 15 (I-3, fresh backend audit 2026-08-21): the outbox dispatcher is the
 * sole delivery path for every buyer credential DM and every admin alert this
 * codebase enqueues, but unlike the six payment reconcile pollers it never
 * wrote a heartbeat — a bad notifier token or an unhandled exception class
 * silently stopped all Telegram delivery with nothing but one log line, no
 * admin ever told. `runDispatcher` now records a `recordPollHealth(prisma,
 * "outbox", ...)` heartbeat after every tick, success or failure, so
 * `outboxDispatcherPollWatchdog` (apps/order-bot/src/jobs/index.ts) has
 * something to read. These two tests drive `runDispatcher` for exactly one
 * tick (abort the signal synchronously right after calling it, before the
 * first `await` inside `drainBatch` resolves — the loop's own
 * `if (signal?.aborted) break;` then stops it right after that one tick,
 * without waiting out the real NOTIF_POLL_INTERVAL_SECONDS sleep).
 */
describe("runDispatcher records an outbox heartbeat (Task 15 / I-3)", () => {
  afterEach(() => {
    dbMockState.fetchPendingError = null;
    dbMockState.recordPollHealthError = null;
  });

  it("records a successful heartbeat after a normal batch cycle", async () => {
    const { bot } = fakeBot();
    const controller = new AbortController();
    const done = runDispatcher(bot, controller.signal);
    controller.abort();
    await done;

    const health = await getPollHealth(prisma, "outbox");
    expect(health.lastRun).not.toBeNull();
    expect(health.lastSuccessAt).toBe(health.lastRun);
    expect(health.consecutiveFailures).toBe(0);
  });

  it("records a failed heartbeat (truncated error, loop does not crash) when a cycle throws", async () => {
    dbMockState.fetchPendingError = new Error(`simulated DB failure ${"x".repeat(400)}`); // forces fetchPendingNotifications to reject
    const { bot } = fakeBot();
    const controller = new AbortController();
    const done = runDispatcher(bot, controller.signal);
    controller.abort();
    await expect(done).resolves.toBeUndefined(); // the loop itself must not throw

    const health = await getPollHealth(prisma, "outbox");
    expect(health.lastRun).not.toBeNull();
    expect(health.lastError).toContain("simulated DB failure");
    // Matches this repo's own documented 300-char truncation convention
    // (packages/core/src/payments/pollHealth.ts's LAST_ERROR_DISPLAY_MAX
    // comment) — the poller-side truncation the display logic already expects.
    expect(health.lastError!.length).toBeLessThanOrEqual(300);
  });

  /**
   * Final whole-branch review, Important #1: before this fix, both
   * `recordPollHealth` calls in `runDispatcher` were unguarded — if the
   * heartbeat write itself threw (e.g. the shared SQLite DB is busy/locked,
   * plausibly correlated with why the tick just failed), the exception
   * escaped `runDispatcher` entirely. `startNotifier`
   * (apps/server/src/index.ts) treats that outer throw as fatal and stops
   * restarting the loop, permanently killing all Telegram delivery until a
   * manual process restart — from a single transient heartbeat-write error.
   * This drives a normal (successful) tick but makes `recordPollHealth`
   * itself reject, and asserts `runDispatcher` still resolves cleanly
   * instead of propagating that rejection.
   */
  it("survives a recordPollHealth rejection on the success path without crashing the loop", async () => {
    dbMockState.recordPollHealthError = new Error("simulated DB busy/locked error writing the heartbeat");
    const { bot } = fakeBot();
    const controller = new AbortController();
    const done = runDispatcher(bot, controller.signal);
    controller.abort();
    await expect(done).resolves.toBeUndefined(); // the loop itself must not throw
  });
});
