import { beforeAll, afterAll, beforeEach, describe, expect, it } from "vitest";
import { PrismaClient } from "@prisma/client";
import {
  addAdminIdToDb, createCategory, createCatalogProduct, createDenomination, createOrderDirect, deliverPaidBybitBscOrder, fulfillManualOrder,
  recordBybitBscConfirmationProgress, recordBybitBscPaymentDetected, wakeFulfillmentMessage, creditOrderToBalance, transitionOrderStatus, adoptTransactionMessage,
} from "@app/db";
import { encryptDeliveredContent } from "@app/core/credentialCrypto";
import { provisionPgTestSchema } from "../../../tests/helpers/pgTestSchema";
import { FulfillmentMessageWorker, type FulfillmentTelegramApi } from "./fulfillmentMessages";

let db: PrismaClient;
let cleanup: () => Promise<void>;
let now: Date;
beforeAll(async () => {
  const env = await provisionPgTestSchema("fulfillment_messages");
  cleanup = env.cleanup;
  db = new PrismaClient({ datasourceUrl: env.url });
}, 60_000);
afterAll(async () => { await db?.$disconnect(); await cleanup?.(); });
beforeEach(async () => {
  await db.fulfillmentMessage.deleteMany();
  now = new Date("2026-10-06T00:00:00.000Z");
});

async function seed(language = "en", opts: { status?: string; provider?: string; paid?: boolean } = {}) {
  const user = await db.user.create({ data: { referralCode: crypto.randomUUID(), telegramId: BigInt(Math.floor(Math.random() * 1e9)), language } });
  const order = await db.order.create({ data: {
    orderCode: `ORD-${crypto.randomUUID()}`, userId: user.id, subtotalAmount: 1000,
    totalAmount: 1000, status: opts.status ?? "PROCESSING", paidAt: opts.paid === false ? null : now,
    fulfillmentProvider: opts.provider ?? "DIGIFLAZZ", fulfillmentSku: "ML5",
  } });
  await db.fulfillmentMessage.create({ data: { orderId: order.id, chatId: user.telegramId!, nextUpdateAt: now } });
  return order;
}

type Markup = { inline_keyboard: Array<Array<{ text: string; callback_data: string }>> };
function telegram() {
  const sent: Array<{ chatId: string | number; text: string; id: number; markup?: Markup }> = [];
  const edits: Array<{ chatId: string | number; id: number; text: string; markup?: Markup }> = [];
  const captions: Array<{ chatId: string | number; id: number; text: string }> = [];
  const deletes: Array<{ chatId: string | number; id: number }> = [];
  const markups: Array<{ chatId: string | number; id: number; markup?: Markup }> = [];
  let sendError: Error | undefined;
  let editError: Error | undefined;
  let deleteError: Error | undefined;
  let markupError: Error | undefined;
  const calls: Record<string, number> = {};
  const count = (name: string) => { calls[name] = (calls[name] ?? 0) + 1; };
  const api = {
    sendMessage: async (chatId: string | number, text: string, options?: { reply_markup?: Markup }) => {
      count("sendMessage");
      if (sendError) throw sendError;
      const id = sent.length + 100;
      sent.push({ chatId, text, id, markup: options?.reply_markup });
      return { message_id: id };
    },
    editMessageText: async (chatId: string | number, id: number, text: string, options?: { reply_markup?: Markup }) => {
      count("editMessageText");
      if (editError) throw editError;
      edits.push({ chatId, id, text, ...(options?.reply_markup ? { markup: options.reply_markup } : {}) });
      return true;
    },
    editMessageCaption: async (chatId: string | number, id: number, options: { caption: string }) => {
      count("editMessageCaption");
      captions.push({ chatId, id, text: options.caption });
      return true;
    },
    deleteMessage: async (chatId: string | number, id: number) => {
      count("deleteMessage");
      deletes.push({ chatId, id }); // every attempt, including rejected ones
      if (deleteError) throw deleteError;
      return true;
    },
    editMessageReplyMarkup: async (chatId: string | number, id: number, options?: { reply_markup?: Markup }) => {
      count("editMessageReplyMarkup");
      if (markupError) throw markupError;
      markups.push({ chatId, id, markup: options?.reply_markup });
      return true;
    },
  } as unknown as FulfillmentTelegramApi;
  return {
    api, sent, edits, captions, deletes, markups, calls,
    failSend: (e?: Error) => { sendError = e; }, failEdit: (e?: Error) => { editError = e; },
    failDelete: (e?: Error) => { deleteError = e; }, failMarkup: (e?: Error) => { markupError = e; },
  };
}
const buttons = (markup?: Markup) => (markup?.inline_keyboard ?? []).flat().map(b => b.callback_data);
function worker(api: FulfillmentTelegramApi) { return new FulfillmentMessageWorker(api, { db, now: () => now }); }
function advance(ms = 2000) { now = new Date(now.getTime() + ms); }
function apiError(code: number, description: string, retryAfter?: number) {
  return Object.assign(new Error(description), { error_code: code, description, parameters: { retry_after: retryAfter } });
}

describe("persisted Telegram fulfillment status", () => {
  it("waits for initial screen acknowledgement even if settlement completes first", async () => {
    const order = await seed("en", { status: "PAYMENT_DETECTED", paid: false });
    await db.fulfillmentMessage.update({ where: { orderId: order.id }, data: { state: "WAITING_SCREEN", messageId: null } });
    const tg = telegram();
    await worker(tg.api).tick();
    expect(tg.sent).toHaveLength(0);
    await db.order.update({ where: { id: order.id }, data: { status: "DELIVERED", paymentState: "PAID" } });
    await wakeFulfillmentMessage(db, order.id, now);
    await worker(tg.api).tick();
    expect(tg.sent).toHaveLength(0);
    await adoptTransactionMessage(db, order.id, order.userId, 906, "text");
    advance(); await worker(tg.api).tick();
    expect(tg.sent).toHaveLength(0);
    expect(tg.edits[0]).toMatchObject({ id: 906 });
    expect(tg.edits[0]!.text).toContain("100%");
  });

  it("records its own initial send as a text message together with the new id", async () => {
    const order = await seed();
    const tg = telegram();
    await worker(tg.api).tick();
    expect(tg.sent).toHaveLength(1);
    expect(await db.fulfillmentMessage.findUniqueOrThrow({ where: { orderId: order.id } })).toMatchObject({
      messageId: tg.sent[0]!.id, messageKind: "text",
    });
  });

  it("never overwrites an initial-send lease during late adoption", async () => {
    const order = await seed();
    await db.fulfillmentMessage.update({ where: { orderId: order.id }, data: { state: "SENDING", claimedAt: now } });
    await expect(adoptTransactionMessage(db, order.id, 42n, 907, "text")).rejects.toThrow("lease");
    expect(await db.fulfillmentMessage.findUniqueOrThrow({ where: { orderId: order.id } })).toMatchObject({ state: "SENDING", claimedAt: now, messageId: null });
  });
  it("captions a legacy wallet QR through verification, then retires it to the credited receipt", async () => {
    const order = await seed("en", { status: "PAYMENT_DETECTED", paid: false });
    const reference = "WLT-20261008-0000019284";
    await db.order.update({ where: { id: order.id }, data: { kind: "WALLET_TOPUP", orderCode: reference } });
    await db.fulfillmentMessage.update({ where: { orderId: order.id }, data: { messageId: 987, state: "ACTIVE" } });
    const tg = telegram();
    tg.failEdit(apiError(400, "Bad Request: there is no text in the message to edit"));
    await worker(tg.api).tick();
    expect(tg.captions[0]!.id).toBe(987);
    expect(tg.captions[0]!.text).toContain(reference); expect(tg.captions[0]!.text).not.toMatch(/[█░%]/u);
    await db.order.update({ where: { id: order.id }, data: { status: "CONFIRMING" } });
    advance(); await worker(tg.api).tick(); expect(tg.captions[1]!.text).not.toMatch(/[█░%]/u);
    // Learned to be a photo on the first pass: no further text-edit attempts.
    expect(tg.calls.editMessageText).toBe(1);
    await db.order.update({ where: { id: order.id }, data: { status: "DELIVERED", paymentState: "PAID", walletCreditState: "CREDITED" } });
    advance(); await worker(tg.api).tick();
    expect(tg.captions).toHaveLength(2);
    expect(tg.sent).toHaveLength(1);
    expect(tg.sent[0]!.text).toContain("100%"); expect(tg.sent[0]!.text).toContain(reference);
    expect(tg.sent[0]!.text).not.toMatch(/[⣾⣽⣻⢿⡿⣟⣯⣷]/u);
    expect(tg.deletes).toEqual([{ chatId: String((await db.fulfillmentMessage.findUniqueOrThrow({ where: { orderId: order.id } })).chatId), id: 987 }]);
    advance(60_000); await worker(tg.api).tick();
    expect(tg.sent).toHaveLength(1); expect(tg.captions).toHaveLength(2); expect(tg.deletes).toHaveLength(1);
  });

  it("renders underpaid trusted amounts as a static warning on the saved message", async () => {
    const order = await seed("en", { status: "UNDERPAID", paid: false });
    await db.order.update({ where: { id: order.id }, data: { currency: "USDT", totalAmount: "5.1", kind: "WALLET_TOPUP", paymentState: "UNDERPAID" } });
    await db.processedBybitTx.create({ data: { orderId: order.id, bybitTxId: crypto.randomUUID(), amount: "3", outcome: "underpaid" } });
    const tg = telegram(); await worker(tg.api).tick();
    expect(tg.sent[0]!.text).toContain("5.1 USDT"); expect(tg.sent[0]!.text).toContain("3 USDT");
    expect(tg.sent[0]!.text).toContain("less than the required amount");
    expect(tg.sent[0]!.text).toContain("Need help? Tap 💬 Support below.");
    expect(tg.sent[0]!.text).not.toMatch(/bot description|pay again/i); expect(tg.sent[0]!.text).not.toContain("%");
    expect(buttons(tg.sent[0]!.markup)).toContain("v1:support:open");
    expect(tg.sent[0]!.text).not.toMatch(/[⣾⣽⣻⢿⡿⣟⣯⣷]/u);
  });
  it("shows purchased item names with escaped HTML and excludes customer secrets", async () => {
    const order = await seed();
    const category = await createCategory(db, crypto.randomUUID());
    const product = await createCatalogProduct(db, { categoryId: category.id, name: "Game" });
    const denomination = await createDenomination(db, { productId: product.id, name: "<Diamond & Coins>", type: "SHARED", durationLabel: "One time", price: "1000" });
    await db.orderItem.create({ data: { orderId: order.id, productId: denomination.id, quantity: 1, unitPrice: 1000, warrantyDaysSnapshot: 0 } });
    await db.order.update({ where: { id: order.id }, data: { customerData: "private-target", deliveredContent: "private-secret" } });
    const tg = telegram(); await worker(tg.api).tick();
    expect(tg.sent[0]!.text).toContain("&lt;Diamond &amp; Coins&gt;");
    expect(tg.sent[0]!.text).not.toContain("private-");
  });

  it("recovers stale edit leases by editing the saved message", async () => {
    const order = await seed(); const tg = telegram(); await worker(tg.api).tick();
    await db.fulfillmentMessage.update({ where: { orderId: order.id }, data: { state: "EDITING", claimedAt: now } });
    advance(62_000); await worker(tg.api).tick();
    expect(tg.sent).toHaveLength(1); expect(tg.edits).toHaveLength(1);
    expect((await db.fulfillmentMessage.findUniqueOrThrow({ where: { orderId: order.id } })).state).toBe("ACTIVE");
  });

  it("preserves the same message through edit flood-control backoff", async () => {
    const order = await seed(); const tg = telegram(); await worker(tg.api).tick();
    tg.failEdit(apiError(429, "Too Many Requests", 20));
    advance(); await worker(tg.api).tick();
    expect((await db.fulfillmentMessage.findUniqueOrThrow({ where: { orderId: order.id } })).nextUpdateAt.getTime()).toBe(now.getTime() + 20_000);
    tg.failEdit(); advance(19_000); await worker(tg.api).tick(); expect(tg.edits).toHaveLength(0);
    advance(1000); await worker(tg.api).tick(); expect(tg.edits).toHaveLength(1); expect(tg.sent).toHaveLength(1);
  });
  it("sends once and edits the saved message across worker restart", async () => {
    const order = await seed();
    const tg = telegram();
    await worker(tg.api).tick();
    const initial = await db.fulfillmentMessage.findUniqueOrThrow({ where: { orderId: order.id } });
    expect(initial.messageId).toBe(100);
    expect(initial.state).toBe("ACTIVE");
    advance();
    await worker(tg.api).tick();
    expect(tg.sent).toHaveLength(1);
    expect(tg.edits).toHaveLength(1);
    expect(tg.edits[0]!.id).toBe(100);
    expect(tg.edits[0]!.text).not.toBe(tg.sent[0]!.text);
  });

  it("renders the database outcome and stops editing after successful delivery", async () => {
    const order = await seed();
    const tg = telegram();
    const w = worker(tg.api);
    await w.tick();
    await db.order.update({ where: { id: order.id }, data: { status: "DELIVERED", deliveredAt: now } });
    advance();
    await w.tick();
    expect(tg.edits[0]!.text).toContain("delivered successfully");
    expect((await db.fulfillmentMessage.findUniqueOrThrow({ where: { orderId: order.id } })).finishedAt).not.toBeNull();
    advance(60_000);
    await w.tick();
    expect(tg.edits).toHaveLength(1);
  });

  it("stops the spinner for review but edits the final resolution later", async () => {
    const order = await seed("id");
    const tg = telegram();
    const w = worker(tg.api);
    await w.tick();
    await db.order.update({ where: { id: order.id }, data: { digiflazzStatus: "failed" } });
    advance(); await w.tick();
    expect((await db.fulfillmentMessage.findUniqueOrThrow({ where: { orderId: order.id } })).state).toBe("REVIEW");
    advance(30_000); await worker(tg.api).tick();
    expect(tg.edits).toHaveLength(1);
    await db.order.update({ where: { id: order.id }, data: { status: "DELIVERED", deliveredAt: now } });
    advance(30_000); await worker(tg.api).tick();
    expect(tg.edits).toHaveLength(2);
    expect(tg.edits[1]!.text).toContain("berhasil");
    expect(tg.sent).toHaveLength(1);
  });

  it("claims each initial message once when two workers race", async () => {
    await seed();
    const tg = telegram();
    await Promise.all([worker(tg.api).tick(), worker(tg.api).tick()]);
    expect(tg.sent).toHaveLength(1);
  });

  it("does not resend an initial message after an ambiguous transport failure", async () => {
    const order = await seed();
    const admin = await db.user.create({ data: { referralCode: crypto.randomUUID(), telegramId: 9911223344n, role: "ADMIN" } });
    await addAdminIdToDb(db, Number(admin.telegramId));
    const tg = telegram();
    tg.failSend(new Error("socket closed before acknowledgement"));
    await worker(tg.api).tick();
    expect((await db.fulfillmentMessage.findUniqueOrThrow({ where: { orderId: order.id } })).state).toBe("UNCERTAIN");
    tg.failSend(); advance(120_000); await worker(tg.api).tick();
    expect(tg.sent).toHaveLength(0);
    expect(await db.notificationOutbox.count({ where: { orderId: order.id, event: "ORDER_PIPELINE_FAILED", payloadJson: { contains: String(admin.telegramId) } } })).toBe(1);
  });

  it("treats a stale initial-send lease as uncertain after a process crash", async () => {
    const order = await seed();
    await db.fulfillmentMessage.update({ where: { orderId: order.id }, data: { state: "SENDING", claimedAt: now } });
    advance(61_000);
    const tg = telegram(); await worker(tg.api).tick();
    expect(tg.sent).toHaveLength(0);
    expect((await db.fulfillmentMessage.findUniqueOrThrow({ where: { orderId: order.id } })).state).toBe("UNCERTAIN");
  });

  it("honors flood control before retrying a definitively rejected initial send", async () => {
    const order = await seed();
    const tg = telegram(); tg.failSend(apiError(429, "Too Many Requests", 15));
    await worker(tg.api).tick();
    const saved = await db.fulfillmentMessage.findUniqueOrThrow({ where: { orderId: order.id } });
    expect(saved.state).toBe("READY");
    expect(saved.nextUpdateAt.getTime()).toBe(now.getTime() + 15_000);
    tg.failSend(); advance(14_000); await worker(tg.api).tick(); expect(tg.sent).toHaveLength(0);
    advance(1000); await worker(tg.api).tick(); expect(tg.sent).toHaveLength(1);
  });

  it("stops edits of a deleted message without creating a replacement", async () => {
    const order = await seed();
    const tg = telegram(); await worker(tg.api).tick();
    tg.failEdit(apiError(400, "Bad Request: message to edit not found"));
    advance(); await worker(tg.api).tick();
    expect((await db.fulfillmentMessage.findUniqueOrThrow({ where: { orderId: order.id } })).state).toBe("STOPPED");
    tg.failEdit(); advance(120_000); await worker(tg.api).tick();
    expect(tg.sent).toHaveLength(1); expect(tg.edits).toHaveLength(0);
  });

  it("accepts message-not-modified as a completed terminal edit", async () => {
    const order = await seed(); const tg = telegram(); await worker(tg.api).tick();
    await db.order.update({ where: { id: order.id }, data: { status: "DELIVERED" } });
    tg.failEdit(apiError(400, "Bad Request: message is not modified"));
    advance(); await worker(tg.api).tick();
    expect((await db.fulfillmentMessage.findUniqueOrThrow({ where: { orderId: order.id } })).state).toBe("FINISHED");
  });
});

const BRAILLE = ["⣾", "⣽", "⣻", "⢿", "⡿", "⣟", "⣯", "⣷"];
const frameOf = (text: string) => BRAILLE.find(f => text.includes(f));

describe("customer progress phases in one Telegram message", () => {
  it("shows a detected payment with a braille spinner and never as paid", async () => {
    await seed("en", { status: "PAYMENT_DETECTED", paid: false });
    const tg = telegram(); await worker(tg.api).tick();
    expect(tg.sent).toHaveLength(1);
    const text = tg.sent[0]!.text;
    expect(text).toContain("<b>Payment detected</b>");
    expect(text).toContain("We&#x27;re checking your payment...");
    expect(text).not.toMatch(/[█░%]/u);
    expect(frameOf(text)).toBeDefined();
    expect(text).not.toMatch(/confirmed|completed|paid/i);
  });

  it("uses the Indonesian copy for the detected phase", async () => {
    await seed("id", { status: "PAYMENT_DETECTED", paid: false });
    const tg = telegram(); await worker(tg.api).tick();
    expect(tg.sent[0]!.text).toContain("<b>Pembayaran terdeteksi</b>");
    expect(tg.sent[0]!.text).toContain("Kami sedang memeriksa pembayaranmu...");
  });

  it("keeps submitted customer proof static while it awaits admin review", async () => {
    const order = await seed("en", { status: "PENDING_VERIFICATION", paid: false });
    const tg = telegram(); await worker(tg.api).tick();
    expect(tg.sent[0]!.text).toContain("Top-up needs attention");
    expect(tg.sent[0]!.text).not.toContain("Payment detected");
    expect(frameOf(tg.sent[0]!.text)).toBeUndefined();
    expect(tg.sent[0]!.text).not.toContain("%");
    expect((await db.fulfillmentMessage.findUniqueOrThrow({ where: { orderId: order.id } })).state).toBe("REVIEW");
  });

  it("rotates spinner frames by editing the same message and skips identical text", async () => {
    const order = await seed("en", { status: "PAYMENT_DETECTED", paid: false });
    const tg = telegram(); const w = worker(tg.api);
    await w.tick();
    advance(); await w.tick();
    expect(tg.edits).toHaveLength(1);
    expect(tg.edits[0]!.id).toBe(tg.sent[0]!.id);
    expect(frameOf(tg.edits[0]!.text)).not.toBe(frameOf(tg.sent[0]!.text));
    // A full 8-frame cycle later the text is identical: no Telegram edit.
    advance(16_000); await w.tick();
    expect(tg.edits).toHaveLength(1);
    expect((await db.fulfillmentMessage.findUniqueOrThrow({ where: { orderId: order.id } })).state).toBe("ACTIVE");
  });

  it.each([
    ["en", "Still verifying your payment…"],
    ["id", "Masih memverifikasi pembayaran…"],
  ])("slows a detected payment to a static line after ten minutes in that phase (%s)", async (lang, still) => {
    const order = await seed(lang, { status: "PAYMENT_DETECTED", paid: false });
    const tg = telegram(); const w = worker(tg.api);
    await w.tick();
    advance(9 * 60_000 + 58_000); await w.tick();
    expect(frameOf(tg.edits.at(-1)!.text)).toBeDefined();
    let row = await db.fulfillmentMessage.findUniqueOrThrow({ where: { orderId: order.id } });
    expect(row.nextUpdateAt.getTime()).toBe(now.getTime() + 2000);

    advance(); await w.tick(); // ten minutes since the payment was first shown
    const slow = tg.edits.at(-1)!.text;
    expect(slow).toContain(still);
    expect(frameOf(slow)).toBeUndefined();
    row = await db.fulfillmentMessage.findUniqueOrThrow({ where: { orderId: order.id } });
    expect(row.state).toBe("ACTIVE");
    expect(row.nextUpdateAt.getTime()).toBe(now.getTime() + 60_000);
    const edits = tg.edits.length;
    advance(59_000); await w.tick();
    expect(tg.edits).toHaveLength(edits);
    advance(1000); await w.tick(); // due again, same static text: no Telegram edit
    expect(tg.edits).toHaveLength(edits);

    // The backend moves on: the next due tick shows the new phase with its spinner.
    await db.order.update({ where: { id: order.id }, data: { status: "PROCESSING", paidAt: now } });
    advance(60_000); await w.tick();
    expect(tg.edits.at(-1)!.text).not.toContain(still);
    expect(frameOf(tg.edits.at(-1)!.text)).toBeDefined();
    expect((await db.fulfillmentMessage.findUniqueOrThrow({ where: { orderId: order.id } })).nextUpdateAt.getTime()).toBe(now.getTime() + 2000);
    expect(tg.sent).toHaveLength(1);
  });

  it("restarts the ten-minute budget when the detected phase is left and entered again", async () => {
    const order = await seed("en", { status: "PAYMENT_DETECTED", paid: false });
    const tg = telegram(); const w = worker(tg.api);
    await w.tick();
    advance(8 * 60_000); await w.tick();
    await db.order.update({ where: { id: order.id }, data: { status: "PENDING_PAYMENT" } });
    advance(); await w.tick(); // payment withdrawn: static waiting, no progress
    await db.order.update({ where: { id: order.id }, data: { status: "PAYMENT_DETECTED" } });
    await wakeFulfillmentMessage(db, order.id, now);
    advance(30_000); await w.tick(); // detected again: a fresh phase
    advance(5 * 60_000); await w.tick();
    expect(frameOf(tg.edits.at(-1)!.text)).toBeDefined();
    expect(tg.edits.at(-1)!.text).not.toContain("Still verifying");
  });

  it("moves the same message from detected to the fulfillment spinner once paid, then stops on success", async () => {
    const order = await seed("en", { status: "PAYMENT_DETECTED", paid: false });
    const tg = telegram(); const w = worker(tg.api);
    await w.tick();
    await db.order.update({ where: { id: order.id }, data: { status: "PROCESSING", paidAt: now } });
    advance(); await w.tick();
    expect(tg.edits[0]!.text).toContain("<b>Preparing your top-up</b>");
    expect(tg.edits[0]!.text).toContain("Your top-up is being prepared.");
    expect(tg.edits[0]!.text).toContain("55%");
    expect(frameOf(tg.edits[0]!.text)).toBeDefined();
    await db.order.update({ where: { id: order.id }, data: { digiflazzDispatchedAt: now } });
    advance(); await w.tick();
    expect(tg.edits[1]!.text).toContain("Sending your top-up for processing...");
    expect(tg.edits[1]!.text).toContain("65%");
    await db.order.update({ where: { id: order.id }, data: { digiflazzAttempts: 1 } });
    advance(); await w.tick();
    expect(tg.edits[2]!.text).toContain("Your top-up is being processed.");
    expect(tg.edits[2]!.text).toContain("80%");
    await db.order.update({ where: { id: order.id }, data: { status: "DELIVERED", deliveredAt: now } });
    advance(); await w.tick();
    expect(tg.edits[3]!.text).toContain("✅ <b>Top-up completed</b>");
    expect(tg.edits[3]!.text).toContain("Your top-up was delivered successfully.");
    expect(frameOf(tg.edits[3]!.text)).toBeUndefined();
    advance(60_000); await w.tick();
    expect(tg.sent).toHaveLength(1); expect(tg.edits).toHaveLength(4);
  });

  it("uses generic product wording for stock orders", async () => {
    const order = await seed("en", { provider: "STOCK" });
    const tg = telegram(); const w = worker(tg.api);
    await w.tick();
    expect(tg.sent[0]!.text).toContain("Preparing your order");
    expect(tg.sent[0]!.text).toContain("55%");
    await db.order.update({ where: { id: order.id }, data: { status: "DELIVERED", deliveredAt: now } });
    advance(); await w.tick();
    expect(tg.edits[0]!.text).toContain("✅ <b>Order completed</b>");
    expect(tg.edits[0]!.text).not.toMatch(/top-up/i);
  });

  it("ends a manual order on a static waiting line instead of spinning for hours", async () => {
    const order = await seed("en", { provider: "MANUAL" });
    const tg = telegram(); const w = worker(tg.api);
    await w.tick();
    const waiting = tg.sent[0]!.text;
    expect(waiting).toContain("🕒 <b>Payment confirmed</b>");
    expect(waiting).toContain("Your order is waiting to be prepared. We&#x27;ll update this message when it&#x27;s ready.");
    expect(frameOf(waiting)).toBeUndefined();
    expect(waiting).not.toContain("%");
    expect(waiting).not.toMatch(/provider|top-up|admin/i);
    for (let i = 0; i < 30; i++) { advance(); await w.tick(); }
    expect(tg.edits).toHaveLength(0);
    expect((await db.fulfillmentMessage.findUniqueOrThrow({ where: { orderId: order.id } })).state).toBe("WAITING");
    // WAITING is never re-polled; the final transition wakes the row instead.
    await db.order.update({ where: { id: order.id }, data: { status: "DELIVERED", deliveredAt: now } });
    advance(10 * 60_000); await w.tick();
    expect(tg.edits).toHaveLength(0);
    await wakeFulfillmentMessage(db, order.id, now);
    await w.tick();
    expect(tg.edits).toHaveLength(1);
    expect(tg.edits[0]!.text).toContain("✅ <b>Order completed</b>");
    expect(tg.sent).toHaveLength(1);
  });

  it("words review for the buyer without internal fulfillment jargon", async () => {
    const order = await seed("en");
    await db.order.update({ where: { id: order.id }, data: { digiflazzStatus: "failed" } });
    const tg = telegram(); await worker(tg.api).tick();
    expect(tg.sent[0]!.text).toContain("⚠️ <b>Top-up needs attention</b>");
    expect(tg.sent[0]!.text).not.toMatch(/manual fulfil|admin must/i);
    expect(frameOf(tg.sent[0]!.text)).toBeUndefined();
    expect(tg.sent[0]!.text).not.toContain("%");
  });

  it("does not send anything for an order whose payment was never seen, and drops it silently if it expires", async () => {
    const order = await seed("en", { status: "PENDING_PAYMENT", paid: false });
    const tg = telegram(); const w = worker(tg.api);
    await w.tick();
    expect(tg.sent).toHaveLength(0);
    expect((await db.fulfillmentMessage.findUniqueOrThrow({ where: { orderId: order.id } })).state).toBe("READY");
    await db.order.update({ where: { id: order.id }, data: { status: "EXPIRED" } });
    advance(); await w.tick();
    expect(tg.sent).toHaveLength(0);
    expect((await db.fulfillmentMessage.findUniqueOrThrow({ where: { orderId: order.id } })).state).toBe("FINISHED");
  });

  it("does not let many waiting manual orders starve a spinner", async () => {
    const tg = telegram(); const w = worker(tg.api);
    for (let i = 0; i < 12; i++) await seed("en", { provider: "MANUAL" });
    await w.tick(); advance(); await w.tick(); // first ten: send then go WAITING
    advance(); await w.tick(); advance(); await w.tick(); // last two
    expect(await db.fulfillmentMessage.count({ where: { state: "WAITING" } })).toBe(12);
    const spinning = await seed("en", { status: "PAYMENT_DETECTED", paid: false });
    // Due after every waiting row would have been due again under a 60s re-poll.
    await db.fulfillmentMessage.update({ where: { orderId: spinning.id }, data: { nextUpdateAt: new Date(now.getTime() + 4 * 60_000) } });
    advance(5 * 60_000); await w.tick();
    expect(tg.sent.filter(s => s.text.includes(spinning.orderCode))).toHaveLength(1);
  });

  it("wakes itself when the order ends while the waiting line is being written", async () => {
    const order = await seed("en", { provider: "MANUAL" });
    const tg = telegram(); const w = worker(tg.api);
    await w.tick();
    // Force a fresh waiting edit after restart; static manual rows are otherwise idle.
    await db.fulfillmentMessage.update({ where: { orderId: order.id }, data: { state: "ACTIVE", lastText: "Previous preparation phase", nextUpdateAt: now } });
    // The admin delivers the order after the worker read it as still queued.
    const api = { ...tg.api, editMessageText: async (...args: Parameters<FulfillmentTelegramApi["editMessageText"]>) => {
      await db.order.update({ where: { id: order.id }, data: { status: "DELIVERED", deliveredAt: now } });
      return tg.api.editMessageText(...args);
    } } as FulfillmentTelegramApi;
    advance(); await worker(api).tick();
    const row = await db.fulfillmentMessage.findUniqueOrThrow({ where: { orderId: order.id } });
    expect(row.state).not.toBe("WAITING");
    expect(row.nextUpdateAt.getTime()).toBeLessThanOrEqual(now.getTime());
    await w.tick();
    expect(tg.edits.at(-1)!.text).toContain("✅ <b>Order completed</b>");
  });

  it("edits a sent message to static waiting when the order falls back to awaiting payment", async () => {
    const order = await seed("en", { status: "PAYMENT_DETECTED", paid: false });
    const tg = telegram(); const w = worker(tg.api);
    await w.tick();
    await db.order.update({ where: { id: order.id }, data: { status: "PENDING_PAYMENT" } });
    advance(); await w.tick();
    expect(tg.edits).toHaveLength(1);
    const row = await db.fulfillmentMessage.findUniqueOrThrow({ where: { orderId: order.id } });
    expect(row.lastText).toBe(tg.edits[0]!.text);
    expect(row.lastText).toContain("Complete your payment");
    expect(frameOf(row.lastText!)).toBeUndefined();
    expect(row.lastText).not.toContain("%");
    expect(row.state).toBe("WAITING");
    expect(row.finishedAt).toBeNull();
    expect(row.claimedAt).toBeNull();
  });

  it("shows an underpaid order as a static review, not a verifying spinner", async () => {
    const order = await seed("en", { status: "UNDERPAID", paid: false });
    const tg = telegram(); await worker(tg.api).tick();
    expect(tg.sent[0]!.text).toContain("⚠️ <b>Payment incomplete</b>");
    expect(tg.sent[0]!.text).not.toContain("Verifying your payment");
    expect(frameOf(tg.sent[0]!.text)).toBeUndefined();
    expect((await db.fulfillmentMessage.findUniqueOrThrow({ where: { orderId: order.id } })).state).toBe("REVIEW");
  });

  it("stays silent when a stock order is already delivered before its first message", async () => {
    const order = await seed("en", { provider: "STOCK", status: "DELIVERED" });
    const tg = telegram(); await worker(tg.api).tick();
    expect(tg.sent).toHaveLength(0);
    const row = await db.fulfillmentMessage.findUniqueOrThrow({ where: { orderId: order.id } });
    expect(row.state).toBe("FINISHED");
    expect(row.finishedAt).not.toBeNull();
  });

  it.each([["en", "credited to your wallet balance"], ["id", "dikreditkan ke saldo dompet"]])("tells the buyer a credited order went to the wallet balance (%s)", async (lang, phrase) => {
    const order = await seed(lang, { provider: "MANUAL" });
    const tg = telegram(); const w = worker(tg.api);
    await w.tick();
    await db.order.update({ where: { id: order.id }, data: { status: "CANCELLED" } });
    await db.walletTransaction.create({ data: { userId: order.userId, delta: 1000, balanceAfter: 1000, reason: "unfulfilled_credit", orderId: order.id } });
    await wakeFulfillmentMessage(db, order.id, now);
    advance(); await w.tick();
    expect(tg.edits.at(-1)!.text).toContain(phrase);
    expect(tg.edits.at(-1)!.text).not.toMatch(/cancelled|dibatalkan/i);
    const completed = await db.fulfillmentMessage.findUniqueOrThrow({ where: { orderId: order.id } });
    expect(completed).toMatchObject({ state: "FINISHED", phase: "CREDITED", messageId: tg.sent[0]!.id });
    expect(completed.finishedAt).not.toBeNull();
    const edits = tg.edits.length;
    advance(120_000); await worker(tg.api).tick();
    expect(tg.edits).toHaveLength(edits);
  });
});

describe("durable progress outcome corrections", () => {
  async function cancelledPaymentEvidence(orderId: number) {
    await db.processedBinanceTx.create({ data: { binanceTxId: crypto.randomUUID(), orderId, amount: 1000, outcome: "delivery_failed" } });
  }

  it.each(["FAILED", "CANCELLED"])("edits the saved %s result when a later credit commits", async status => {
    now = new Date();
    const order = await seed("en", { provider: "MANUAL" });
    const tg = telegram(); await worker(tg.api).tick();
    await db.$transaction(async tx => {
      await transitionOrderStatus(tx, { orderId: order.id, from: "PROCESSING", to: status });
    });
    advance(); await worker(tg.api).tick();
    const finished = await db.fulfillmentMessage.findUniqueOrThrow({ where: { orderId: order.id } });
    expect(finished.state).toBe("FINISHED");
    if (status === "CANCELLED") await cancelledPaymentEvidence(order.id);
    await creditOrderToBalance(db, { orderId: order.id, adminId: order.userId });
    const due = await db.fulfillmentMessage.findUniqueOrThrow({ where: { orderId: order.id } });
    expect(due).toMatchObject({ state: "ACTIVE", messageId: finished.messageId, finishedAt: null });
    advance(); await worker(tg.api).tick();
    const corrected = await db.fulfillmentMessage.findUniqueOrThrow({ where: { orderId: order.id } });
    expect(corrected).toMatchObject({ state: "FINISHED", phase: "CREDITED", messageId: finished.messageId });
    expect(corrected.lastText).toContain("credited to your wallet balance");
    expect(tg.edits.at(-1)!.id).toBe(finished.messageId);
    expect(tg.sent).toHaveLength(1);
  });

  it("keeps delivery recoverable if the worker stops after saving a stale waiting edit", async () => {
    now = new Date();
    const order = await seed("en", { provider: "MANUAL" });
    const tg = telegram(); await worker(tg.api).tick();
    await db.fulfillmentMessage.update({ where: { orderId: order.id }, data: { state: "ACTIVE", lastText: "Previous preparation phase", nextUpdateAt: now } });
    const api = { ...tg.api, editMessageText: async (...args: Parameters<FulfillmentTelegramApi["editMessageText"]>) => {
      await db.$transaction(tx => transitionOrderStatus(tx, { orderId: order.id, from: "PROCESSING", to: "DELIVERED" }));
      return tg.api.editMessageText(...args);
    } } as FulfillmentTelegramApi;
    // Interruption at the old post-save recheck: no second read can repair a durable WAITING row.
    const interruptedDb = db.$extends({ query: { order: { async findUnique({ args, query }) {
      if (args.select?.status) throw new Error("worker interrupted after save");
      return query(args);
    } } } }) as unknown as PrismaClient;
    advance(); await new FulfillmentMessageWorker(api, { db: interruptedDb, now: () => now }).tick();
    const saved = await db.fulfillmentMessage.findUniqueOrThrow({ where: { orderId: order.id } });
    expect(saved).toMatchObject({ state: "ACTIVE", finishedAt: null, messageId: 100 });
    expect(saved.nextUpdateAt.getTime()).toBeLessThanOrEqual(now.getTime());
    await worker(tg.api).tick();
    expect(tg.edits.at(-1)!.text).toContain("Order completed");
    expect((await db.fulfillmentMessage.findUniqueOrThrow({ where: { orderId: order.id } })).state).toBe("FINISHED");
    expect(tg.sent).toHaveLength(1);
  });

  it.each([false, true])("keeps credit recoverable when it commits during a cancellation edit (not modified=%s)", async notModified => {
    now = new Date();
    const order = await seed("en", { provider: "MANUAL" });
    const tg = telegram(); await worker(tg.api).tick();
    await db.$transaction(tx => transitionOrderStatus(tx, { orderId: order.id, from: "PROCESSING", to: "CANCELLED" }));
    await cancelledPaymentEvidence(order.id);
    const api = { ...tg.api, editMessageText: async (...args: Parameters<FulfillmentTelegramApi["editMessageText"]>) => {
      await creditOrderToBalance(db, { orderId: order.id, adminId: order.userId });
      if (notModified) throw apiError(400, "Bad Request: message is not modified");
      return tg.api.editMessageText(...args);
    } } as FulfillmentTelegramApi;
    advance(); await worker(api).tick();
    const saved = await db.fulfillmentMessage.findUniqueOrThrow({ where: { orderId: order.id } });
    expect(saved).toMatchObject({ state: "ACTIVE", finishedAt: null, messageId: 100 });
    expect(saved.nextUpdateAt.getTime()).toBeLessThanOrEqual(now.getTime());
    // Discard the old worker immediately after its save; a fresh worker must find the correction.
    await worker(tg.api).tick();
    const corrected = await db.fulfillmentMessage.findUniqueOrThrow({ where: { orderId: order.id } });
    expect(corrected).toMatchObject({ state: "FINISHED", phase: "CREDITED", messageId: 100 });
    expect(corrected.lastText).toContain("credited to your wallet balance");
    expect(tg.edits.at(-1)!.id).toBe(100);
    expect(tg.sent).toHaveLength(1);
  });
});

describe("a Bybit BSC order gets one buyer-visible progress message", () => {
  it("edits the adopted payment bubble through confirmations and fulfillment without another send", async () => {
    // The crud helpers stamp rows with the real clock; run the worker on it too.
    now = new Date();
    const user = await db.user.create({ data: { referralCode: crypto.randomUUID(), telegramId: BigInt(Math.floor(Math.random() * 1e9)), language: "en" } });
    const category = await createCategory(db, crypto.randomUUID());
    const product = await createCatalogProduct(db, { categoryId: category.id, name: "Manual BSC" });
    const denomination = await createDenomination(db, {
      productId: product.id, name: "Manual", type: "SHARED", durationLabel: "1 Month", price: "10.00", deliveryType: "manual",
    });
    const order = (await createOrderDirect(db, { channel: "bot", user, productId: denomination.id, quantity: 1 }))!;
    await db.order.update({ where: { id: order.id }, data: { paymentMethod: "BYBIT_BSC" } });
    await adoptTransactionMessage(db, order.id, user.telegramId!, 617, "text");
    const tg = telegram(); const w = worker(tg.api);
    const txId = "0x" + "c".repeat(64);

    await recordBybitBscPaymentDetected(db, { orderId: order.id, bybitTxId: txId, network: "BSC" });
    advance(); await w.tick();
    await recordBybitBscConfirmationProgress(db, { orderId: order.id, confirmations: 1, requiredConfirmations: 2 });
    advance(); await w.tick();
    await recordBybitBscConfirmationProgress(db, { orderId: order.id, confirmations: 2, requiredConfirmations: 2 });
    advance(); await w.tick();
    expect(tg.sent).toHaveLength(0);

    expect((await deliverPaidBybitBscOrder(db, { orderId: order.id, bybitTxId: txId, amount: order.totalAmount })).status).toBe("processing");
    advance(); await w.tick(); advance(); await w.tick();
    expect(tg.sent).toHaveLength(0);
    expect(tg.edits.at(-1)!.text).toContain("Payment confirmed");

    await db.$transaction(tx => fulfillManualOrder(tx, order.id, { adminId: user.id, content: "code-bsc" }));
    advance(); await w.tick();
    expect(tg.sent).toHaveLength(0);
    expect(tg.edits.at(-1)!.text).toContain("✅ <b>Order completed</b>");
    expect(new Set(tg.edits.map(e => e.id))).toEqual(new Set([617]));
  });
});

describe("message failures alert admins only for Digiflazz orders", () => {
  async function admin() {
    const a = await db.user.create({ data: { referralCode: crypto.randomUUID(), telegramId: BigInt(Math.floor(Math.random() * 1e9)), role: "ADMIN" } });
    await addAdminIdToDb(db, Number(a.telegramId));
  }
  const alerts = (orderId: number) => db.notificationOutbox.count({ where: { orderId, event: "ORDER_PIPELINE_FAILED" } });

  it.each(["MANUAL", "STOCK"])("marks an uncertain %s send without paging admins", async (provider) => {
    await admin();
    const order = await seed("en", { provider });
    const tg = telegram(); tg.failSend(new Error("socket closed before acknowledgement"));
    await worker(tg.api).tick();
    expect((await db.fulfillmentMessage.findUniqueOrThrow({ where: { orderId: order.id } })).state).toBe("UNCERTAIN");
    expect(await alerts(order.id)).toBe(0);
  });

  it.each(["MANUAL", "STOCK"])("stops a blocked %s chat without paging admins", async (provider) => {
    await admin();
    const order = await seed("en", { provider });
    const tg = telegram(); tg.failSend(apiError(403, "Forbidden: bot was blocked by the user"));
    await worker(tg.api).tick();
    expect((await db.fulfillmentMessage.findUniqueOrThrow({ where: { orderId: order.id } })).state).toBe("STOPPED");
    expect(await alerts(order.id)).toBe(0);
  });

  it("still pages admins when a Digiflazz order's message is lost", async () => {
    await admin();
    const order = await seed("en", { provider: "DIGIFLAZZ" });
    const tg = telegram(); tg.failSend(apiError(403, "Forbidden: bot was blocked by the user"));
    await worker(tg.api).tick();
    expect(await alerts(order.id)).toBeGreaterThan(0); // one row per registered admin
  });
});

describe("a QR photo is retired to one status text once payment is no longer pending", () => {
  /** Adopt the order's checkout screen as a QR photo, as checkout does. */
  async function asPhoto(orderId: number, messageId = 900) {
    const row = await db.fulfillmentMessage.findUniqueOrThrow({ where: { orderId } });
    await adoptTransactionMessage(db, orderId, row.chatId, messageId, "photo");
    return String(row.chatId);
  }
  const rowOf = (orderId: number) => db.fulfillmentMessage.findUniqueOrThrow({ where: { orderId } });

  it("edits only the caption of a photo while the payment is detected or verifying", async () => {
    const order = await seed("en", { status: "PAYMENT_DETECTED", paid: false });
    await asPhoto(order.id);
    const tg = telegram(); const w = worker(tg.api);
    await w.tick();
    await db.order.update({ where: { id: order.id }, data: { status: "CONFIRMING" } });
    advance(); await w.tick();
    expect(tg.captions.map(c => c.id)).toEqual([900, 900]);
    expect(tg.calls.editMessageText).toBeUndefined();
    expect(tg.sent).toHaveLength(0); expect(tg.deletes).toHaveLength(0);
    expect(await rowOf(order.id)).toMatchObject({ messageId: 900, messageKind: "photo" });
  });

  it("replaces the photo with one status text once paid, then edits that text in place", async () => {
    const order = await seed("en", { status: "PAYMENT_DETECTED", paid: false });
    const chatId = await asPhoto(order.id);
    const tg = telegram(); const w = worker(tg.api);
    await w.tick();
    await db.order.update({ where: { id: order.id }, data: { status: "PROCESSING", paidAt: now } });
    advance(); await w.tick();
    expect(tg.sent).toHaveLength(1);
    expect(tg.sent[0]!.text).toContain("Preparing your top-up");
    expect(frameOf(tg.sent[0]!.text)).toBeDefined();
    expect(tg.deletes).toEqual([{ chatId, id: 900 }]);
    expect(tg.captions).toHaveLength(1);
    expect(await rowOf(order.id)).toMatchObject({ messageId: tg.sent[0]!.id, messageKind: "text", state: "ACTIVE", claimedAt: null });
    for (let i = 0; i < 3; i++) { advance(); await w.tick(); }
    expect(tg.sent).toHaveLength(1); expect(tg.deletes).toHaveLength(1); expect(tg.captions).toHaveLength(1);
    expect(tg.edits.length).toBeGreaterThan(0);
    expect(new Set(tg.edits.map(e => e.id))).toEqual(new Set([tg.sent[0]!.id]));
  });

  it("retires straight to the final result when the order already succeeded", async () => {
    const order = await seed("en", { status: "DELIVERED" });
    await db.order.update({ where: { id: order.id }, data: { deliveredAt: now } });
    await asPhoto(order.id);
    const tg = telegram(); const w = worker(tg.api);
    await w.tick();
    expect(tg.sent).toHaveLength(1);
    expect(tg.sent[0]!.text).toContain("✅ <b>Top-up completed</b>");
    expect(frameOf(tg.sent[0]!.text)).toBeUndefined();
    expect(tg.deletes.map(d => d.id)).toEqual([900]);
    expect(tg.calls.editMessageText).toBeUndefined(); expect(tg.captions).toHaveLength(0);
    const row = await rowOf(order.id);
    expect(row).toMatchObject({ state: "FINISHED", messageKind: "text", messageId: tg.sent[0]!.id });
    advance(60_000); await w.tick();
    await wakeFulfillmentMessage(db, order.id, now); await w.tick();
    expect(tg.sent).toHaveLength(1); expect(tg.deletes).toHaveLength(1);
  });

  it.each([
    ["CANCELLED", "FINISHED"],
    ["EXPIRED", "FINISHED"],
    ["UNDERPAID", "REVIEW"],
  ])("retires the photo of a %s order to a status text with a Support button", async (status, state) => {
    const order = await seed("en", { status, paid: false });
    await asPhoto(order.id);
    const tg = telegram(); await worker(tg.api).tick();
    expect(tg.calls).toEqual({ sendMessage: 1, deleteMessage: 1 });
    expect(buttons(tg.sent[0]!.markup)).toEqual(["v1:support:open", "v1:menu:main"]);
    expect(tg.deletes.map(d => d.id)).toEqual([900]);
    expect(await rowOf(order.id)).toMatchObject({ state, messageKind: "text", messageId: tg.sent[0]!.id });
  });

  it.each([
    ["FAILED", { status: "FAILED" }, true],
    ["REVIEW", { digiflazzStatus: "failed" }, true],
    ["SUCCESS", { status: "DELIVERED" }, false],
  ] as const)("offers Support on a %s status text: %s", async (_phase, data, support) => {
    const order = await seed("en");
    const tg = telegram(); const w = worker(tg.api); await w.tick();
    await db.order.update({ where: { id: order.id }, data });
    const markups: Markup[] = [];
    const api = { ...tg.api, editMessageText: async (chat: string, id: number, text: string, options: { reply_markup: Markup }) => {
      markups.push(options.reply_markup); return tg.api.editMessageText(chat, id, text);
    } } as unknown as FulfillmentTelegramApi;
    advance(); await worker(api).tick();
    expect(buttons(markups[0]).includes("v1:support:open")).toBe(support);
    expect(buttons(markups[0])).toContain("v1:menu:main");
  });

  it("removes the stale payment buttons when Telegram refuses to delete the photo", async () => {
    const order = await seed("en");
    const chatId = await asPhoto(order.id);
    const tg = telegram(); tg.failDelete(apiError(400, "Bad Request: message can't be deleted for everyone"));
    await worker(tg.api).tick();
    expect(tg.deletes.map(d => d.id)).toEqual([900]);
    expect(tg.markups).toEqual([{ chatId, id: 900, markup: { inline_keyboard: [] } }]);
    expect(await rowOf(order.id)).toMatchObject({ state: "ACTIVE", messageKind: "text", messageId: tg.sent[0]!.id });
    advance(); await worker(tg.api).tick();
    expect(tg.sent).toHaveLength(1); expect(tg.deletes).toHaveLength(1); expect(tg.edits).toHaveLength(1);
  });

  it("keeps going when even the keyboard cleanup fails", async () => {
    const order = await seed("en");
    await asPhoto(order.id);
    const tg = telegram();
    tg.failDelete(apiError(403, "Forbidden: bot was blocked by the user"));
    tg.failMarkup(apiError(400, "Bad Request: message to edit not found"));
    await worker(tg.api).tick();
    expect(tg.markups).toHaveLength(0); expect(tg.calls.editMessageReplyMarkup).toBe(1);
    expect(await rowOf(order.id)).toMatchObject({ state: "ACTIVE", messageKind: "text", messageId: tg.sent[0]!.id });
  });

  it.each([
    ["flood control", () => apiError(429, "Too Many Requests", 30)],
    ["a transport error", () => new Error("socket hang up")],
  ])("skips the cleanup without retrying after %s", async (_label, error) => {
    const order = await seed("en");
    await asPhoto(order.id);
    const tg = telegram(); tg.failDelete(error());
    await worker(tg.api).tick();
    expect(tg.calls.editMessageReplyMarkup).toBeUndefined();
    const row = await rowOf(order.id);
    expect(row).toMatchObject({ state: "ACTIVE", messageKind: "text", messageId: tg.sent[0]!.id });
    expect(row.nextUpdateAt.getTime()).toBe(now.getTime() + 2000);
    for (let i = 0; i < 3; i++) { advance(); await worker(tg.api).tick(); }
    expect(tg.deletes).toHaveLength(1); expect(tg.sent).toHaveLength(1);
  });

  it("learns a legacy message is a photo from the caption fallback, then retires it once paid", async () => {
    const order = await seed("en", { status: "PAYMENT_DETECTED", paid: false });
    await db.fulfillmentMessage.update({ where: { orderId: order.id }, data: { messageId: 900, state: "ACTIVE" } });
    const tg = telegram(); tg.failEdit(apiError(400, "Bad Request: there is no text in the message to edit"));
    const w = worker(tg.api);
    await w.tick();
    expect(tg.calls.editMessageText).toBe(1);
    expect(tg.captions.map(c => c.id)).toEqual([900]);
    expect(await rowOf(order.id)).toMatchObject({ messageId: 900, messageKind: "photo" });
    await db.order.update({ where: { id: order.id }, data: { status: "PROCESSING", paidAt: now } });
    advance(); await w.tick();
    expect(tg.calls.editMessageText).toBe(1);
    expect(tg.sent).toHaveLength(1); expect(tg.deletes.map(d => d.id)).toEqual([900]);
    expect(await rowOf(order.id)).toMatchObject({ messageId: tg.sent[0]!.id, messageKind: "text" });
  });

  it("retires a legacy photo straight away when it is found after payment, without a caption edit", async () => {
    const order = await seed("en");
    await db.fulfillmentMessage.update({ where: { orderId: order.id }, data: { messageId: 900, state: "ACTIVE" } });
    const tg = telegram(); tg.failEdit(apiError(400, "Bad Request: there is no text in the message to edit"));
    await worker(tg.api).tick();
    expect(tg.captions).toHaveLength(0);
    expect(tg.sent).toHaveLength(1); expect(tg.deletes.map(d => d.id)).toEqual([900]);
    expect(await rowOf(order.id)).toMatchObject({ messageId: tg.sent[0]!.id, messageKind: "text" });
  });

  it("records a legacy message as text when the text edit succeeds", async () => {
    const order = await seed("en");
    await db.fulfillmentMessage.update({ where: { orderId: order.id }, data: { messageId: 900, state: "ACTIVE" } });
    const tg = telegram(); await worker(tg.api).tick();
    expect(tg.edits.map(e => e.id)).toEqual([900]);
    expect(tg.sent).toHaveLength(0);
    expect(await rowOf(order.id)).toMatchObject({ messageId: 900, messageKind: "text" });
  });

  it("keeps two orders in one chat on their own messages", async () => {
    const paid = await seed("en");
    const chatId = await asPhoto(paid.id, 900);
    const other = await db.order.create({ data: {
      orderCode: `ORD-${crypto.randomUUID()}`, userId: paid.userId, subtotalAmount: 1000, totalAmount: 1000,
      status: "PAYMENT_DETECTED", fulfillmentProvider: "DIGIFLAZZ", fulfillmentSku: "ML5",
    } });
    await db.fulfillmentMessage.create({ data: { orderId: other.id, chatId: BigInt(chatId), nextUpdateAt: now } });
    await asPhoto(other.id, 901);
    const tg = telegram(); await worker(tg.api).tick();
    expect(tg.sent).toHaveLength(1); expect(tg.sent[0]!.text).toContain(paid.orderCode);
    expect(tg.deletes.map(d => d.id)).toEqual([900]);
    expect(tg.captions.map(c => c.id)).toEqual([901]);
    expect(await rowOf(other.id)).toMatchObject({ messageId: 901, messageKind: "photo" });
    expect(await rowOf(paid.id)).toMatchObject({ messageId: tg.sent[0]!.id, messageKind: "text" });
  });

  it("never resends after an ambiguous replacement send, keeps the photo and strips only its payment buttons", async () => {
    const order = await seed("en");
    const chatId = await asPhoto(order.id);
    const tg = telegram(); tg.failSend(new Error("socket closed before acknowledgement"));
    await worker(tg.api).tick();
    expect(await rowOf(order.id)).toMatchObject({ state: "UNCERTAIN", messageId: 900, messageKind: "photo" });
    expect(tg.calls).toEqual({ sendMessage: 1, editMessageReplyMarkup: 1 });
    expect(tg.markups).toEqual([{ chatId, id: 900, markup: { inline_keyboard: [] } }]);
    tg.failSend(); advance(120_000); await worker(tg.api).tick();
    expect(tg.calls).toEqual({ sendMessage: 1, editMessageReplyMarkup: 1 });
  });

  it("treats a replacement interrupted between send and save as uncertain", async () => {
    const order = await seed("en");
    await asPhoto(order.id);
    const tg = telegram();
    const states: string[] = [];
    // Telegram accepts the replacement, then the process dies before its id is saved.
    const crashing = { ...tg.api, sendMessage: async (...args: Parameters<FulfillmentTelegramApi["sendMessage"]>) => {
      states.push((await rowOf(order.id)).state);
      await tg.api.sendMessage(...args);
      throw new Error("process killed");
    } } as FulfillmentTelegramApi;
    await worker(crashing).tick();
    expect(states).toEqual(["SENDING"]);
    expect((await rowOf(order.id)).state).toBe("UNCERTAIN");
    advance(120_000); await worker(tg.api).tick();
    expect(tg.sent).toHaveLength(1); expect(tg.deletes).toHaveLength(0);
  });

  it("backs off and retries the replacement after flood control on its send", async () => {
    const order = await seed("en");
    await asPhoto(order.id);
    const tg = telegram(); tg.failSend(apiError(429, "Too Many Requests", 15));
    await worker(tg.api).tick();
    const row = await rowOf(order.id);
    expect(row).toMatchObject({ state: "ACTIVE", messageId: 900, messageKind: "photo" });
    expect(row.nextUpdateAt.getTime()).toBe(now.getTime() + 15_000);
    tg.failSend(); advance(15_000); await worker(tg.api).tick();
    expect(tg.sent).toHaveLength(1); expect(tg.deletes.map(d => d.id)).toEqual([900]);
  });

  it("leaves the photo alone when the lease is lost between the replacement send and its save", async () => {
    const order = await seed("en");
    await asPhoto(order.id);
    const tg = telegram();
    const stolen = new Date(now.getTime() + 1);
    const api = { ...tg.api, sendMessage: async (...args: Parameters<FulfillmentTelegramApi["sendMessage"]>) => {
      const sent = await tg.api.sendMessage(...args);
      // Another worker recovers the row while Telegram was answering.
      await db.fulfillmentMessage.update({ where: { orderId: order.id }, data: { claimedAt: stolen } });
      return sent;
    } } as FulfillmentTelegramApi;
    await worker(api).tick();
    expect(tg.calls).toEqual({ sendMessage: 1 });
    expect(await rowOf(order.id)).toMatchObject({ messageId: 900, messageKind: "photo", state: "SENDING", claimedAt: stolen });
  });

  it("marks a retire left in SENDING past its lease as uncertain without sending or deleting", async () => {
    const order = await seed("en");
    await asPhoto(order.id);
    // The process died after claiming the replacement: SENDING, photo still saved.
    await db.fulfillmentMessage.update({ where: { orderId: order.id }, data: {
      state: "SENDING", claimedAt: new Date(now.getTime() - 61_000), nextUpdateAt: now,
    } });
    const tg = telegram(); await worker(tg.api).tick();
    expect(tg.calls).toEqual({});
    expect(await rowOf(order.id)).toMatchObject({ state: "UNCERTAIN", messageId: 900, messageKind: "photo" });
    advance(120_000); await worker(tg.api).tick();
    expect(tg.calls).toEqual({});
  });

  it.each([
    [400, "Bad Request: chat not found", 1],
    [403, "Forbidden: bot was blocked by the user", 0],
  ])("stops a rejected replacement send (%s) and strips the photo's payment buttons only when the chat is reachable", async (code, description, stripped) => {
    const order = await seed("en");
    const chatId = await asPhoto(order.id);
    const tg = telegram(); tg.failSend(apiError(code, description));
    await worker(tg.api).tick();
    expect(await rowOf(order.id)).toMatchObject({ state: "STOPPED", messageId: 900 });
    expect(tg.calls).toEqual({ sendMessage: 1, ...(stripped ? { editMessageReplyMarkup: 1 } : {}) });
    expect(tg.markups).toEqual(stripped ? [{ chatId, id: 900, markup: { inline_keyboard: [] } }] : []);
    advance(120_000); await worker(tg.api).tick();
    expect(tg.calls.sendMessage).toBe(1);
  });

  it("spends exactly one caption, one send, one delete and then only edits on the new text, through success", async () => {
    const order = await seed("en", { status: "PAYMENT_DETECTED", paid: false });
    const chatId = await asPhoto(order.id);
    const tg = telegram(); const w = worker(tg.api);
    await w.tick(); // detected: caption on the QR photo
    expect(tg.calls).toEqual({ editMessageCaption: 1 });
    await db.order.update({ where: { id: order.id }, data: { status: "PROCESSING", paidAt: now } });
    advance(); await w.tick(); // paid: one replacement text, the QR deleted
    expect(tg.calls).toEqual({ editMessageCaption: 1, sendMessage: 1, deleteMessage: 1 });
    expect(tg.deletes).toEqual([{ chatId, id: 900 }]);
    const statusId = tg.sent[0]!.id;
    for (let i = 0; i < 3; i++) { advance(); await w.tick(); } // three spinner frames
    expect(tg.calls).toEqual({ editMessageCaption: 1, sendMessage: 1, deleteMessage: 1, editMessageText: 3 });
    await db.order.update({ where: { id: order.id }, data: { status: "DELIVERED", deliveredAt: now } });
    advance(); await w.tick(); // final result on the same text
    expect(tg.calls).toEqual({ editMessageCaption: 1, sendMessage: 1, deleteMessage: 1, editMessageText: 4 });
    expect(tg.edits.at(-1)!.text).toContain("✅ <b>Top-up completed</b>");
    expect(new Set(tg.edits.map(e => e.id))).toEqual(new Set([statusId]));
    advance(60_000); await w.tick();
    await wakeFulfillmentMessage(db, order.id, now); advance(); await w.tick();
    expect(tg.calls).toEqual({ editMessageCaption: 1, sendMessage: 1, deleteMessage: 1, editMessageText: 4 });
    expect(await rowOf(order.id)).toMatchObject({ state: "FINISHED", messageId: statusId, messageKind: "text" });
  });

  it("spends the same budget for a wallet top-up QR through crediting, ending on the wallet keyboard", async () => {
    const order = await seed("en", { status: "PAYMENT_DETECTED", paid: false });
    await db.order.update({ where: { id: order.id }, data: { kind: "WALLET_TOPUP" } });
    const chatId = await asPhoto(order.id);
    const tg = telegram(); const w = worker(tg.api);
    await w.tick();
    expect(tg.calls).toEqual({ editMessageCaption: 1 });
    await db.order.update({ where: { id: order.id }, data: { status: "PENDING_PAYMENT", paymentState: "PAID", paidAt: now, walletCreditState: "CREDITING" } });
    advance(); await w.tick(); // WALLET_CREDITING: replacement text, QR deleted
    expect(tg.calls).toEqual({ editMessageCaption: 1, sendMessage: 1, deleteMessage: 1 });
    expect(tg.deletes).toEqual([{ chatId, id: 900 }]);
    expect(frameOf(tg.sent[0]!.text)).toBeDefined();
    const statusId = tg.sent[0]!.id;
    for (let i = 0; i < 2; i++) { advance(); await w.tick(); }
    expect(tg.calls).toEqual({ editMessageCaption: 1, sendMessage: 1, deleteMessage: 1, editMessageText: 2 });
    await db.order.update({ where: { id: order.id }, data: { status: "DELIVERED", walletCreditState: "CREDITED" } });
    advance(); await w.tick(); // WALLET_CREDITED on the same text
    expect(tg.calls).toEqual({ editMessageCaption: 1, sendMessage: 1, deleteMessage: 1, editMessageText: 3 });
    const final = tg.edits.at(-1)!;
    expect(final.id).toBe(statusId);
    expect(final.text).toContain("100%");
    expect(buttons(final.markup)).toEqual(["v1:wallet:view", "v1:menu:main"]);
    advance(60_000); await w.tick();
    await wakeFulfillmentMessage(db, order.id, now); advance(); await w.tick();
    expect(tg.calls).toEqual({ editMessageCaption: 1, sendMessage: 1, deleteMessage: 1, editMessageText: 3 });
    expect(await rowOf(order.id)).toMatchObject({ state: "FINISHED", phase: "WALLET_CREDITED", messageId: statusId });
  });

  it.each([
    ["CANCELLED", "FINISHED", "CANCELLED"],
    ["EXPIRED", "FINISHED", "CANCELLED"],
    ["UNDERPAID", "REVIEW", "UNDERPAID"],
  ])("retires a %s wallet top-up QR with one send and one delete", async (status, state, phase) => {
    const order = await seed("en", { status, paid: false });
    await db.order.update({ where: { id: order.id }, data: { kind: "WALLET_TOPUP" } });
    await asPhoto(order.id);
    const tg = telegram(); const w = worker(tg.api);
    await w.tick();
    expect(tg.calls).toEqual({ sendMessage: 1, deleteMessage: 1 });
    expect(tg.deletes.map(d => d.id)).toEqual([900]);
    expect(buttons(tg.sent[0]!.markup)).toEqual(["v1:support:open", "v1:menu:main"]);
    // A REVIEW row is re-polled every 30 s; an unchanged status costs nothing.
    advance(30_000); await w.tick();
    advance(60_000); await w.tick();
    await wakeFulfillmentMessage(db, order.id, now); advance(); await w.tick();
    expect(tg.calls).toEqual({ sendMessage: 1, deleteMessage: 1 });
    expect(await rowOf(order.id)).toMatchObject({ state, phase, messageKind: "text", messageId: tg.sent[0]!.id });
  });
});

describe("a delivered Digiflazz game top-up shows its Game ID, Zone/Server ID and full SN", () => {
  const fields = JSON.stringify([
    { key: "uid", label: { id: "UID", en: "UID" }, type: "text", required: true },
    { key: "zone", label: { id: "Zone", en: "Zone" }, type: "text", required: true },
    { key: "password", label: { id: "Password", en: "Password" }, type: "text", required: false },
  ]);
  async function gameOrder(opts: { fields?: string; mapping?: string; customerData?: unknown; sn?: string | null; provider?: string; group?: string } = {}) {
    const order = await seed("en", { provider: opts.provider ?? "DIGIFLAZZ" });
    const category = await createCategory(db, { name: crypto.randomUUID(), ...(opts.group ? { group: opts.group } : {}) });
    const product = await createCatalogProduct(db, { categoryId: category.id, name: "Game" });
    const denomination = await createDenomination(db, {
      productId: product.id, name: "86 Diamonds", type: "SHARED", durationLabel: "One time", price: "1000",
      additionalFields: opts.fields ?? fields, providerInputMapping: opts.mapping ?? null,
    });
    await db.orderItem.create({ data: { orderId: order.id, productId: denomination.id, quantity: 1, unitPrice: 1000, warrantyDaysSnapshot: 0 } });
    await db.order.update({ where: { id: order.id }, data: {
      customerData: JSON.stringify(opts.customerData ?? [{ uid: "12345678", zone: "2201", password: "hunter2-secret" }]),
      deliveredContent: opts.sn === null ? null : encryptDeliveredContent(opts.sn ?? "SN-OK-123", order.id),
    } });
    return order;
  }
  async function finish(order: { id: number }) {
    const tg = telegram(); const w = worker(tg.api);
    await w.tick(); // the first status message (processing)
    await db.order.update({ where: { id: order.id }, data: { status: "DELIVERED", deliveredAt: now } });
    advance(); await w.tick();
    return tg;
  }

  it("shows the Game ID, Zone ID and a 200-character SN in full, and never another answer", async () => {
    const sn = "SN" + "ab12-".repeat(40);
    expect(sn.length).toBe(202);
    const tg = await finish(await gameOrder({ sn }));
    expect(tg.calls).toEqual({ sendMessage: 1, editMessageText: 1 });
    const text = tg.edits[0]!.text;
    expect(text).toContain("Game ID: <code>12345678</code>");
    expect(text).toContain("Zone ID: <code>2201</code>");
    expect(text).toContain(`SN: <code>${sn}</code>`);
    expect(text).toContain("86 Diamonds");
    expect(text).toContain("Top-up completed");
    expect(text).not.toMatch(/hunter2|password/i);
    expect(text.length).toBeLessThan(4096);
  });

  it("follows the denomination's provider input mapping for the Game ID, Zone and Server", async () => {
    const tg = await finish(await gameOrder({
      fields: JSON.stringify([
        { key: "a", label: { id: "A", en: "A" }, type: "text", required: true }, { key: "b", label: { id: "B", en: "B" }, type: "text", required: true },
        { key: "c", label: { id: "C", en: "C" }, type: "text", required: true },
      ]),
      mapping: JSON.stringify({ nickname: { targetKey: "c", zoneKey: "a", serverKey: "b" } }),
      customerData: [{ a: "Z9", b: "S7", c: "G1" }],
    }));
    const text = tg.edits[0]!.text;
    expect(text).toContain("Game ID: <code>G1</code>");
    expect(text).toContain("Zone ID: <code>Z9</code>");
    expect(text).toContain("Server ID: <code>S7</code>");
  });

  it("omits the zone line when the denomination has no zone field", async () => {
    const tg = await finish(await gameOrder({ fields: JSON.stringify([{ key: "uid", label: { id: "UID", en: "UID" }, type: "text", required: true }]), customerData: [{ uid: "777", zone: "9999" }] }));
    expect(tg.edits[0]!.text).toContain("Game ID: <code>777</code>");
    expect(tg.edits[0]!.text).not.toMatch(/Zone ID|Server ID|9999/);
  });

  it("escapes HTML in the typed values", async () => {
    const tg = await finish(await gameOrder({ customerData: [{ uid: "<b>1</b>", zone: "a&b" }] }));
    expect(tg.edits[0]!.text).toContain("<code>&lt;b&gt;1&lt;/b&gt;</code>");
    expect(tg.edits[0]!.text).toContain("<code>a&amp;b</code>");
  });

  it("leaves the SN line out, without failing, when the delivered content cannot be decrypted", async () => {
    const order = await gameOrder();
    // A real envelope whose auth tag was tampered with: decryption throws.
    const envelope = JSON.parse(encryptDeliveredContent("not-a-valid-envelope", order.id)) as { authTag: string };
    envelope.authTag = Buffer.alloc(16).toString("base64");
    await db.order.update({ where: { id: order.id }, data: { deliveredContent: JSON.stringify(envelope) } });
    const tg = await finish(order);
    expect(tg.calls).toEqual({ sendMessage: 1, editMessageText: 1 });
    expect(tg.edits[0]!.text).toContain("Game ID: <code>12345678</code>");
    expect(tg.edits[0]!.text).not.toMatch(/SN:|not-a-valid/);
    expect(tg.edits[0]!.text).toContain("Top-up completed");
  });

  it("shows no SN line when no serial number was stored", async () => {
    const tg = await finish(await gameOrder({ sn: null }));
    expect(tg.edits[0]!.text).toContain("Game ID:");
    expect(tg.edits[0]!.text).not.toContain("SN:");
  });

  it("shows no receipt block for a manual game order, whose delivered content is admin-typed", async () => {
    const order = await gameOrder({ provider: "MANUAL", group: "GAME_TOPUP" });
    await db.order.update({ where: { id: order.id }, data: { status: "DELIVERED", deliveredAt: now } });
    const tg = telegram();
    await worker(tg.api).tick();
    expect(tg.calls).toEqual({ sendMessage: 1 });
    expect(tg.sent[0]!.text).toContain("Top-up completed");
    expect(tg.sent[0]!.text).not.toMatch(/Game ID|SN:|12345678/);
  });

  it("is unaffected for a premium app delivered through Digiflazz", async () => {
    const tg = await finish(await gameOrder({ group: "PREMIUM_APPS" }));
    expect(tg.edits[0]!.text).not.toMatch(/Game ID|SN:|12345678/);
  });

  it.each([
    ["FAILED", { status: "FAILED" }],
    ["REVIEW", { digiflazzStatus: "failed", digiflazzFailureDetail: "rc 53 supplier stack trace" }],
  ])("stays generic and never says completed when the top-up is %s", async (_name, patch) => {
    const order = await gameOrder();
    const tg = telegram(); const w = worker(tg.api);
    await w.tick();
    await db.order.update({ where: { id: order.id }, data: patch });
    advance(); await w.tick();
    expect(tg.calls).toEqual({ sendMessage: 1, editMessageText: 1 });
    const text = tg.edits[0]!.text;
    expect(text).not.toMatch(/Top-up completed|delivered successfully|Game ID|SN:|12345678|rc 53|stack/i);
    expect(text).toContain("contact support");
    expect(buttons(tg.edits[0]!.markup)).toContain("v1:support:open");
  });
});
