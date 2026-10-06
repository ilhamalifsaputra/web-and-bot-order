import { beforeAll, afterAll, beforeEach, describe, expect, it } from "vitest";
import { PrismaClient } from "@prisma/client";
import { addAdminIdToDb, createCategory, createCatalogProduct, createDenomination } from "@app/db";
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

async function seed(language = "en") {
  const user = await db.user.create({ data: { referralCode: crypto.randomUUID(), telegramId: BigInt(Math.floor(Math.random() * 1e9)), language } });
  const order = await db.order.create({ data: {
    orderCode: `ORD-${crypto.randomUUID()}`, userId: user.id, subtotalAmount: 1000,
    totalAmount: 1000, status: "PROCESSING", paidAt: now, fulfillmentProvider: "DIGIFLAZZ", fulfillmentSku: "ML5",
  } });
  await db.fulfillmentMessage.create({ data: { orderId: order.id, chatId: user.telegramId!, nextUpdateAt: now } });
  return order;
}

function telegram() {
  const sent: Array<{ chatId: string | number; text: string; id: number }> = [];
  const edits: Array<{ chatId: string | number; id: number; text: string }> = [];
  let sendError: Error | undefined;
  let editError: Error | undefined;
  const api = {
    sendMessage: async (chatId: string | number, text: string) => {
      if (sendError) throw sendError;
      const id = sent.length + 100;
      sent.push({ chatId, text, id });
      return { message_id: id };
    },
    editMessageText: async (chatId: string | number, id: number, text: string) => {
      if (editError) throw editError;
      edits.push({ chatId, id, text });
      return true;
    },
  } as FulfillmentTelegramApi;
  return { api, sent, edits, failSend: (e?: Error) => { sendError = e; }, failEdit: (e?: Error) => { editError = e; } };
}
function worker(api: FulfillmentTelegramApi) { return new FulfillmentMessageWorker(api, { db, now: () => now }); }
function advance(ms = 2000) { now = new Date(now.getTime() + ms); }
function apiError(code: number, description: string, retryAfter?: number) {
  return Object.assign(new Error(description), { error_code: code, description, parameters: { retry_after: retryAfter } });
}

describe("persisted Telegram fulfillment status", () => {
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
