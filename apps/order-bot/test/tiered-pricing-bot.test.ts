// setup-db MUST be first — temp DB + push before any @app import.
import "./setup-db";

import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

// The TokoPay rail's gateway call, so a payment tap can complete without HTTP.
vi.mock("@app/core/payments/tokopay", async (orig) => ({
  ...(await orig<typeof import("@app/core/payments/tokopay")>()),
  createTransaction: vi.fn().mockResolvedValue({ trxId: "TP-TEST", payUrl: null, qrLink: "https://x/qr.png", qrString: "000", totalBayar: "100" }),
}));

import { prisma, bulkAddStock, replaceTiers, setTieredPricingEnabled, setSetting, MAX_CART_ORDER_UNITS } from "@app/db";
import { Decimal } from "@app/core/money";
import * as checkout from "../src/handlers/checkout";
import { CategoryGroup } from "@app/core/enums";
import { buildSampleData, resetDb, type SampleData } from "../../../tests/helpers/sampleData";
import { makeCtx, calls, type SentCall } from "./helpers/ctx";
import type { SessionData } from "../src/context";
import { invalidateRateCache } from "../src/util/rate";
import { resetBotIdentity } from "@app/core/runtime";
import * as customer from "../src/handlers/customer";
import { routeCallback } from "../src/handlers/callbacks";
import { fitSections } from "../src/util/tierDisplay";

let sample: SampleData;

beforeEach(async () => {
  await resetDb(prisma);
  invalidateRateCache();
  resetBotIdentity();
  sample = await buildSampleData(prisma);
  // Rp10,000 a unit, 15 units in stock (the fixture brings 5).
  await prisma.denomination.update({ where: { id: sample.product.id }, data: { price: "10000", resellerPrice: null } });
  await bulkAddStock(prisma, sample.product.id, Array.from({ length: 10 }, (_, i) => `extra${i}@example.com:pw${i}`));
});

afterAll(async () => {
  await prisma.$disconnect();
});

function session(): Partial<SessionData> {
  return {
    lang: "en",
    scratch: {},
    dbUser: {
      id: sample.user.id,
      telegramId: String(sample.user.telegramId),
      role: sample.user.role,
      language: sample.user.language,
      referralCode: sample.user.referralCode,
      walletBalance: String(sample.user.walletBalance),
      preferredCurrency: null,
    },
  };
}

const PHOTO_BUBBLE = { message_id: 777, chat: { id: 42, type: "private" }, date: 0, photo: [{ file_id: "P", file_unique_id: "p", width: 10, height: 10 }] };

/** 3+ → 20% off (Rp8,000), 5+ → fixed Rp6,000 a unit. */
async function giveTiers(denominationId = sample.product.id) {
  await replaceTiers(
    prisma,
    denominationId,
    [
      { minQuantity: 3, discountType: "PERCENTAGE", discountValue: "20" },
      { minQuantity: 5, discountType: "FIXED_UNIT_PRICE", discountValue: "6000" },
    ],
    { adminId: null },
  );
  await setTieredPricingEnabled(prisma, denominationId, true, { adminId: null });
}

async function setGroup(group: string | null) {
  await prisma.category.update({ where: { id: sample.parentProduct.categoryId }, data: { group } });
}

/** Every Telegram call that adds, changes or removes a message — the budget a test pins. */
function budget(sink: SentCall[]) {
  return {
    sendMessage: calls(sink, "sendMessage").length + calls(sink, "reply").length,
    sendPhoto: calls(sink, "replyWithPhoto").length + calls(sink, "sendPhoto").length,
    editMessageText: calls(sink, "editMessageText").length,
    editMessageCaption: calls(sink, "editMessageCaption").length,
    deleteMessage: calls(sink, "deleteMessage").length,
    sendDocument: calls(sink, "sendDocument").length,
  };
}

const NONE = { sendMessage: 0, sendPhoto: 0, editMessageText: 0, editMessageCaption: 0, deleteMessage: 0, sendDocument: 0 };

/** The one rendered body (text or caption) in the sink. */
function renderedBody(sink: SentCall[]): string {
  for (const c of sink) {
    if (c.method === "editMessageCaption") {
      const opts = (c.args.length === 1 ? c.args[0] : c.args[2]) as { caption: string };
      return opts.caption;
    }
    if (c.method === "editMessageText") return String(c.args.length >= 3 && typeof c.args[0] === "number" ? c.args[2] : c.args[0]);
    if (c.method === "reply" || c.method === "sendMessage") return String(c.args[c.method === "reply" ? 0 : 1]);
  }
  throw new Error("nothing was rendered");
}

describe("denomination detail prices the selected quantity through the tiers", () => {
  it("qty 1 below every threshold keeps today's bubble plus the next-tier hint", async () => {
    await giveTiers();
    const { ctx, sink } = makeCtx({ session: session(), callbackData: `v1:browse:denom:${sample.product.id}` });
    await customer.browseDenomination(ctx, sample.product.id);
    const body = renderedBody(sink);
    expect(body).toContain("Price: <b>Rp10,000</b>");
    expect(body).toContain("Buy <b>3+ plans</b> → <b>Rp8,000</b> each.");
    expect(body).not.toContain("Quantity:");
    expect(body).not.toContain("Total:");
    expect(body).not.toContain("<s>");
  });

  it.each([CategoryGroup.PREMIUM_APPS, null])("Premium Apps (group %s): qty 5 shows the tier price, tier, savings and total in plan wording", async (group) => {
    await setGroup(group);
    await giveTiers();
    const { ctx, sink } = makeCtx({ session: session(), callbackData: `v1:qty:${sample.product.id}:4:inc` });
    await customer.qtyChange(ctx, sample.product.id, 4, "inc");
    const body = renderedBody(sink);
    expect(body).toContain("Price: <b><s>Rp10,000</s> Rp6,000</b>");
    expect(body).toContain("Quantity: <b>5</b>");
    expect(body).toContain("Bundle price: <b>5+ plans</b> · Rp6,000 each");
    expect(body).toContain("You save: <b>Rp20,000</b>");
    expect(body).toContain("Total: <b>Rp30,000</b>");
    // Existing Premium facts stay.
    expect(body).toContain("Warranty: 30 days");
    expect(body).toContain("In stock: <b>15</b>");
    expect(body).not.toMatch(/top-?up/i);
  });

  it("Game Top Up: qty 3 shows the percentage tier in top-up wording and the next tier", async () => {
    await setGroup(CategoryGroup.GAME_TOPUP);
    await giveTiers();
    const { ctx, sink } = makeCtx({ session: session(), callbackData: `v1:qty:${sample.product.id}:2:inc` });
    await customer.qtyChange(ctx, sample.product.id, 2, "inc");
    const body = renderedBody(sink);
    expect(body).toContain("Price: <b><s>Rp10,000</s> Rp8,000</b>");
    expect(body).toContain("Bulk price: <b>3+ top-ups</b> · 20% off");
    expect(body).toContain("You save: <b>Rp6,000</b>");
    expect(body).toContain("Total: <b>Rp24,000</b>");
    expect(body).toContain("Buy <b>5+ top-ups</b> → <b>Rp6,000</b> each.");
    expect(body).not.toContain("plans");
    expect(body).not.toContain("Warranty");
  });

  it("qty 2 under the first threshold shows quantity and total but no tier or savings", async () => {
    await giveTiers();
    const { ctx, sink } = makeCtx({ session: session(), callbackData: `v1:qty:${sample.product.id}:1:inc` });
    await customer.qtyChange(ctx, sample.product.id, 1, "inc");
    const body = renderedBody(sink);
    expect(body).toContain("Quantity: <b>2</b>");
    expect(body).toContain("Total: <b>Rp20,000</b>");
    expect(body).not.toContain("You save");
    expect(body).not.toContain("<s>");
  });

  it("a FIXED_AMOUNT_OFF_PER_UNIT tier is worded as an amount off each", async () => {
    await replaceTiers(prisma, sample.product.id, [{ minQuantity: 2, discountType: "FIXED_AMOUNT_OFF_PER_UNIT", discountValue: "1500" }], { adminId: null });
    await setTieredPricingEnabled(prisma, sample.product.id, true, { adminId: null });
    const { ctx, sink } = makeCtx({ session: session(), callbackData: `v1:qty:${sample.product.id}:1:inc` });
    await customer.qtyChange(ctx, sample.product.id, 1, "inc");
    const body = renderedBody(sink);
    expect(body).toContain("Bundle price: <b>2+ plans</b> · Rp1,500 off each");
    expect(body).toContain("Total: <b>Rp17,000</b>");
  });

  it("a flash sale and a tier together strike the list price and keep the flash mark", async () => {
    await giveTiers();
    await prisma.denomination.update({
      where: { id: sample.product.id },
      data: { flashDiscountPercent: "10", flashStartsAt: new Date(Date.now() - 60_000), flashEndsAt: new Date(Date.now() + 3_600_000) },
    });
    const { ctx, sink } = makeCtx({ session: session(), callbackData: `v1:qty:${sample.product.id}:2:inc` });
    await customer.qtyChange(ctx, sample.product.id, 2, "inc");
    const body = renderedBody(sink);
    // 10,000 → flash 9,000 → 20% tier = 7,200.
    expect(body).toContain("Price: <b><s>Rp10,000</s> Rp7,200 ⚡</b>");
    expect(body).toContain("Flash Sale");
    expect(body).toContain("Total: <b>Rp21,600</b>");
  });

  it("tiered pricing switched off prices every quantity at the base unit", async () => {
    await giveTiers();
    await setTieredPricingEnabled(prisma, sample.product.id, false, { adminId: null });
    const { ctx, sink } = makeCtx({ session: session(), callbackData: `v1:qty:${sample.product.id}:4:inc` });
    await customer.qtyChange(ctx, sample.product.id, 4, "inc");
    const body = renderedBody(sink);
    expect(body).toContain("Price: <b>Rp10,000</b>");
    expect(body).toContain("Total: <b>Rp50,000</b>");
    expect(body).not.toContain("Bundle price");
  });
});

describe("a quantity tap stays inside its bubble (message budget)", () => {
  it("qty 1 → 6 via +5 on a photo bubble edits the caption once and nothing else", async () => {
    await giveTiers();
    await prisma.product.update({ where: { id: sample.parentProduct.id }, data: { webImageUrl: "PHOTO_FILE_ID" } });
    const { ctx, sink } = makeCtx({ session: session(), callbackData: `v1:qty:${sample.product.id}:1:inc5`, cbMessage: PHOTO_BUBBLE });
    await routeCallback(ctx);
    expect(budget(sink)).toEqual({ ...NONE, editMessageCaption: 1 });
    expect(renderedBody(sink)).toContain("Quantity: <b>6</b>");
    expect(renderedBody(sink)).toContain("Total: <b>Rp36,000</b>");
  });

  it("qty 1 → 6 via +5 on a text bubble edits the text once and nothing else", async () => {
    await giveTiers();
    const { ctx, sink } = makeCtx({ session: session(), callbackData: `v1:qty:${sample.product.id}:1:inc5` });
    await routeCallback(ctx);
    expect(budget(sink)).toEqual({ ...NONE, editMessageText: 1 });
    expect(renderedBody(sink)).toContain("Total: <b>Rp36,000</b>");
  });

  it("a typed quantity edits the tracked text bubble once and deletes the typed message once", async () => {
    await giveTiers();
    const s = session();
    const { ctx, sink } = makeCtx({ session: { ...s, menuMsgId: 500, awaitingQtyDenomId: sample.product.id }, text: "5" });
    await customer.handleProductNumber(ctx);
    expect(budget(sink)).toEqual({ ...NONE, editMessageText: 1, deleteMessage: 1 });
    const edit = calls(sink, "editMessageText")[0]!;
    expect(edit.args[1]).toBe(500);
    expect(String(edit.args[2])).toContain("Total: <b>Rp30,000</b>");
    expect(calls(sink, "deleteMessage")[0]!.args[1]).toBe(ctx.message!.message_id);
  });

  it("a typed quantity on a photo anchor edits its caption, never sending a new bubble", async () => {
    await giveTiers();
    await prisma.product.update({ where: { id: sample.parentProduct.id }, data: { webImageUrl: "PHOTO_FILE_ID" } });
    const { ctx, sink } = makeCtx({
      session: { ...session(), menuMsgId: 501, awaitingQtyDenomId: sample.product.id },
      text: "3",
      photoMessageIds: [501],
    });
    await customer.handleProductNumber(ctx);
    // The rejected editMessageText is not recorded; the caption edit is the one change.
    expect(budget(sink)).toEqual({ ...NONE, editMessageCaption: 1, deleteMessage: 1 });
    expect(renderedBody(sink)).toContain("Total: <b>Rp24,000</b>");
  });

  it("'message is not modified' sends nothing extra", async () => {
    await giveTiers();
    const { ctx, sink } = makeCtx({ session: session(), callbackData: `v1:qty:${sample.product.id}:1:inc5`, editThrowsNotModified: true });
    await routeCallback(ctx);
    expect(budget(sink)).toEqual(NONE);
  });

  it("a rapid double tap of the same payload edits the same bubble twice to the same text, sending nothing", async () => {
    await giveTiers();
    const shared = { lang: "en", ...session() } as SessionData;
    const bubble = { message_id: 900, chat: { id: 42, type: "private" }, date: 0 };
    const first = makeCtx({ sharedSession: shared, callbackData: `v1:qty:${sample.product.id}:1:inc5`, cbMessage: bubble });
    const second = makeCtx({ sharedSession: shared, callbackData: `v1:qty:${sample.product.id}:1:inc5`, cbMessage: bubble });
    await Promise.all([routeCallback(first.ctx), routeCallback(second.ctx)]);
    expect(budget(first.sink)).toEqual({ ...NONE, editMessageText: 1 });
    expect(budget(second.sink)).toEqual({ ...NONE, editMessageText: 1 });
    expect(renderedBody(first.sink)).toBe(renderedBody(second.sink));
    expect(shared.menuMsgId).toBe(900);
  });
});

describe("the server owns the quantity and the price", () => {
  it("a forged refresh quantity above stock is clamped to stock before pricing", async () => {
    await giveTiers();
    const { ctx, sink } = makeCtx({ session: session(), callbackData: `v1:browse:refresh:${sample.product.id}:999` });
    await routeCallback(ctx);
    const body = renderedBody(sink);
    expect(body).toContain("Quantity: <b>15</b>");
    expect(body).toContain("Total: <b>Rp90,000</b>");
    expect(JSON.stringify(sink)).toContain(`v1:buy:${sample.product.id}:15`);
    expect(JSON.stringify(sink)).not.toContain(":999");
  });

  it("a stale stepper quantity above stock is clamped too", async () => {
    const { ctx, sink } = makeCtx({ session: session(), callbackData: `v1:qty:${sample.product.id}:400:inc` });
    await routeCallback(ctx);
    expect(renderedBody(sink)).toContain("Quantity: <b>15</b>");
  });

  it("a non-numeric quantity falls back to 1", async () => {
    const { ctx, sink } = makeCtx({ session: session(), callbackData: `v1:qty:${sample.product.id}:abc:inc` });
    await routeCallback(ctx);
    expect(renderedBody(sink)).not.toContain("Quantity:");
    expect(JSON.stringify(sink)).toContain(`v1:buy:${sample.product.id}:1`);
  });

  it("a manual SKU without stock rows is clamped to MAX_CART_ORDER_UNITS", async () => {
    await prisma.denomination.update({ where: { id: sample.product.id }, data: { deliveryType: "MANUAL" } });
    const { ctx, sink } = makeCtx({ session: session(), callbackData: `v1:browse:refresh:${sample.product.id}:${MAX_CART_ORDER_UNITS + 50}` });
    await routeCallback(ctx);
    expect(renderedBody(sink)).toContain(`Quantity: <b>${MAX_CART_ORDER_UNITS}</b>`);
  });
});

describe("caption limit", () => {
  it("a long description on a photo bubble is shortened so the caption fits, keeping price, tier and total", async () => {
    await setGroup(CategoryGroup.GAME_TOPUP);
    await giveTiers();
    await prisma.product.update({ where: { id: sample.parentProduct.id }, data: { webImageUrl: "PHOTO_FILE_ID", description: "Terms ".repeat(400) } });
    const { ctx, sink } = makeCtx({ session: session(), callbackData: `v1:qty:${sample.product.id}:2:inc`, cbMessage: PHOTO_BUBBLE });
    await routeCallback(ctx);
    expect(budget(sink)).toEqual({ ...NONE, editMessageCaption: 1 });
    const caption = renderedBody(sink);
    expect(caption.length).toBeLessThanOrEqual(1024);
    expect(caption).toContain("Price: <b><s>Rp10,000</s> Rp8,000</b>");
    expect(caption).toContain("Bulk price: <b>3+ top-ups</b> · 20% off");
    expect(caption).toContain("Total: <b>Rp24,000</b>");
    expect(caption).toContain("Terms Terms");
    expect(caption).toContain("…");
    // The next-tier hint is the first to give way.
    expect(caption).not.toContain("Buy <b>5+");
  });

  it("fitSections drops in rank order and keeps unranked sections", () => {
    const text = fitSections(
      [
        { text: "A".repeat(10) },
        { text: "B".repeat(10), dropRank: 3 },
        { text: "C".repeat(10), dropRank: 1 },
        { text: "D".repeat(10), dropRank: 2, shrink: () => "d" },
      ],
      30,
    );
    expect(text).toBe(`${"A".repeat(10)}\n\n${"B".repeat(10)}\n\nd`);
    expect(fitSections([{ text: "A".repeat(50) }, { text: "B", dropRank: 1 }], 10)).toBe("A".repeat(50));
    expect(fitSections([{ text: "short" }, { text: "" }, { text: "x", dropRank: 1 }], 100)).toBe("short\n\nx");
  });
});

describe("the payment tap is bound to the total the confirmation showed", () => {
  const BUBBLE = { message_id: 910, chat: { id: 42, type: "private" }, date: 0 };

  async function enableTokopay() {
    await setSetting(prisma, "tokopay_merchant_id", "M1");
    await setSetting(prisma, "tokopay_secret", "S1");
  }

  it("a tier edited between the confirmation and the pay tap redraws the same bubble with the new price and charges nothing", async () => {
    await enableTokopay();
    await giveTiers();
    const shared = { lang: "en", ...session() } as SessionData;

    const confirm = makeCtx({ sharedSession: shared, callbackData: `v1:buy:${sample.product.id}:3`, cbMessage: BUBBLE });
    await checkout.showOrderConfirmation(confirm.ctx, sample.product.id, 3);
    expect(renderedBody(confirm.sink)).toContain("Rp24,000");

    // The admin deepens the 3+ tier to 30% while the buyer reads the summary.
    await replaceTiers(
      prisma,
      sample.product.id,
      [
        { minQuantity: 3, discountType: "PERCENTAGE", discountValue: "30" },
        { minQuantity: 5, discountType: "FIXED_UNIT_PRICE", discountValue: "6000" },
      ],
      { adminId: null },
    );

    const tap = makeCtx({ sharedSession: shared, callbackData: `v1:payq:${sample.product.id}:3`, cbMessage: BUBBLE });
    await checkout.buyNowTokopay(tap.ctx, sample.product.id, 3);
    expect(await prisma.order.count()).toBe(0);
    expect(budget(tap.sink)).toEqual({ ...NONE, editMessageText: 1 });
    const redrawn = renderedBody(tap.sink);
    expect(redrawn).toContain("The price changed");
    expect(redrawn).toContain("Rp21,000");
    expect(redrawn).not.toContain("Rp24,000");

    // Confirming again charges the new, now-shown figure.
    const again = makeCtx({ sharedSession: shared, callbackData: `v1:payq:${sample.product.id}:3`, cbMessage: BUBBLE });
    await checkout.buyNowTokopay(again.ctx, sample.product.id, 3);
    const orders = await prisma.order.findMany();
    expect(orders).toHaveLength(1);
    expect(new Decimal(orders[0]!.subtotalAmount).minus(orders[0]!.bulkDiscountAmount).toString()).toBe("21000");
    expect(shared.scratch.shownQuote).toBeUndefined();
  });

  it("an unchanged price goes straight through to the order", async () => {
    await enableTokopay();
    await giveTiers();
    const shared = { lang: "en", ...session() } as SessionData;
    const confirm = makeCtx({ sharedSession: shared, callbackData: `v1:buy:${sample.product.id}:3`, cbMessage: BUBBLE });
    await checkout.showOrderConfirmation(confirm.ctx, sample.product.id, 3);
    const tap = makeCtx({ sharedSession: shared, callbackData: `v1:payq:${sample.product.id}:3`, cbMessage: BUBBLE });
    await checkout.buyNowTokopay(tap.ctx, sample.product.id, 3);
    const orders = await prisma.order.findMany();
    expect(orders).toHaveLength(1);
    expect(new Decimal(orders[0]!.subtotalAmount).minus(orders[0]!.bulkDiscountAmount).toString()).toBe("24000");
    expect(JSON.stringify(tap.sink)).not.toContain("The price changed");
  });

  it("a quote shown for another quantity does not bind this tap", async () => {
    await enableTokopay();
    await giveTiers();
    const shared = { lang: "en", ...session() } as SessionData;
    const confirm = makeCtx({ sharedSession: shared, callbackData: `v1:buy:${sample.product.id}:3`, cbMessage: BUBBLE });
    await checkout.showOrderConfirmation(confirm.ctx, sample.product.id, 3);
    const tap = makeCtx({ sharedSession: shared, callbackData: `v1:payq:${sample.product.id}:2`, cbMessage: BUBBLE });
    await checkout.buyNowTokopay(tap.ctx, sample.product.id, 2);
    expect(await prisma.order.count()).toBe(1);
  });
});
