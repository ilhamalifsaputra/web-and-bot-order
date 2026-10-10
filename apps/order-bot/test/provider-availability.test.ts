// setup-db MUST be first — temp DB + push before any @app import.
import "./setup-db";

/**
 * The bot reads SKU availability through @app/core/productAvailability, the
 * rule the order server applies. An `auto` + `digiflazz` SKU with no local
 * stock rows is a provider SKU: it is bought normally (no "Out of stock",
 * no "Notify me", qty not capped by stock) and, in a Premium/null-group
 * category, its screens carry no Stock or Warranty line. A plain `auto` SKU
 * with no stock keeps the Premium inventory behaviour (stock line + Notify).
 * Every flow pins its exact Telegram call counts (edit-first).
 */
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { prisma, createDenomination, createCatalogProduct, MAX_CART_ORDER_UNITS } from "@app/db";
import { CategoryGroup, ProductType } from "@app/core/enums";
import { buildSampleData, resetDb, type SampleData } from "../../../tests/helpers/sampleData";
import { makeCtx, calls, type SentCall } from "./helpers/ctx";
import type { SessionData } from "../src/context";
import { invalidateRateCache } from "../src/util/rate";
import { resetBotIdentity } from "@app/core/runtime";
import * as customer from "../src/handlers/customer";
import * as checkout from "../src/handlers/checkout";
import { coreT } from "../src/util/i18n";

let sample: SampleData;
let providerId: number;
let emptyLocalId: number;

beforeEach(async () => {
  await resetDb(prisma);
  invalidateRateCache();
  resetBotIdentity();
  sample = await buildSampleData(prisma);
  // Same parent product as the sample (null-group category), so its picker
  // lists the local sample SKU (5 rows), a provider SKU and an empty local SKU.
  const provider = await createDenomination(prisma, {
    productId: sample.parentProduct.id, name: "Provider Plan", type: ProductType.SHARED, durationLabel: "Provider Plan",
    price: "7.00", warrantyDays: 30, deliveryType: "auto", autoDeliverySource: "digiflazz", supplierSku: "prov-1",
  });
  providerId = provider.id;
  const emptyLocal = await createDenomination(prisma, {
    productId: sample.parentProduct.id, name: "Empty Local", type: ProductType.SHARED, durationLabel: "Empty Local",
    price: "6.00", warrantyDays: 30, deliveryType: "auto",
  });
  emptyLocalId = emptyLocal.id;
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

function customerCtx(opts: Parameters<typeof makeCtx>[0] = {}) {
  return makeCtx({ from: { id: 42, username: "tester" }, session: session(), ...opts });
}

function callbackData(sink: SentCall[]): string[] {
  return sink.flatMap((c) => c.args).flatMap((a) => {
    const kb = (a as { reply_markup?: { inline_keyboard?: Array<Array<{ callback_data?: string }>> } } | null)?.reply_markup?.inline_keyboard;
    return kb ? kb.flat().map((b) => b.callback_data ?? "") : [];
  });
}

function buttonLabels(sink: SentCall[]): string[] {
  return sink.flatMap((c) => c.args).flatMap((a) => {
    const kb = (a as { reply_markup?: { inline_keyboard?: Array<Array<{ text?: string }>> } } | null)?.reply_markup?.inline_keyboard;
    return kb ? kb.flat().map((b) => b.text ?? "") : [];
  });
}

function bodies(sink: SentCall[]): string {
  return sink.flatMap((c) => c.args).filter((a): a is string => typeof a === "string").join("\n");
}

const outOfStock = coreT("browse.out_of_stock", "en");
const notify = coreT("browse.notify_restock", "en");

describe("denomination detail", () => {
  it("auto + digiflazz with no stock in a null-group category: buyable, no Stock/Warranty/Notify", async () => {
    const { ctx, sink } = customerCtx({ callbackData: `v1:browse:denom:${providerId}` });
    await customer.browseDenomination(ctx, providerId);

    expect(calls(sink, "editMessageText")).toHaveLength(1);
    expect(calls(sink, "sendMessage")).toHaveLength(0);
    expect(calls(sink, "deleteMessage")).toHaveLength(0);
    const text = bodies(sink);
    expect(text).toContain("Provider Plan");
    expect(text).not.toMatch(/In stock|Warranty|Stock/);
    expect(text).not.toContain(outOfStock);
    const data = callbackData(sink);
    expect(data).toContain(`v1:buy:${providerId}:1`);
    expect(data.some((d) => d.startsWith("v1:restock"))).toBe(false);
    // "Notify me" is a keyboard button, never body text: pin it on the
    // inline keyboard itself.
    expect(buttonLabels(sink)).not.toContain(notify);
    expect(buttonLabels(sink).length).toBeGreaterThan(0);
    expect(text).not.toContain(notify);
  });

  it("auto + digiflazz in a GAME_TOPUP category keeps the compact game template and is buyable", async () => {
    await prisma.category.update({ where: { id: sample.category.id }, data: { group: CategoryGroup.GAME_TOPUP } });
    const { ctx, sink } = customerCtx({ callbackData: `v1:browse:denom:${providerId}` });
    await customer.browseDenomination(ctx, providerId);
    expect(calls(sink, "editMessageText")).toHaveLength(1);
    expect(calls(sink, "sendMessage")).toHaveLength(0);
    expect(bodies(sink)).not.toMatch(/In stock|Warranty/);
    expect(callbackData(sink)).toContain(`v1:buy:${providerId}:1`);
  });

  it("plain auto with no stock keeps the Premium inventory template: stock line + Notify, no Buy", async () => {
    const { ctx, sink } = customerCtx({ callbackData: `v1:browse:denom:${emptyLocalId}` });
    await customer.browseDenomination(ctx, emptyLocalId);
    expect(calls(sink, "editMessageText")).toHaveLength(1);
    expect(calls(sink, "sendMessage")).toHaveLength(0);
    const text = bodies(sink);
    expect(text).toContain("In stock: <b>0</b>");
    expect(text).toContain("Warranty: 30 days");
    const data = callbackData(sink);
    expect(data).toContain(`v1:restock:sub:${emptyLocalId}`);
    expect(data.some((d) => d.startsWith(`v1:buy:${emptyLocalId}`))).toBe(false);
    expect(buttonLabels(sink)).toContain(notify);
  });
});

describe("plan picker", () => {
  it("null-group picker: provider line has no Stock, inventory lines keep theirs", async () => {
    const { ctx, sink } = customerCtx({ callbackData: `v1:browse:pick:${sample.parentProduct.id}` });
    await customer.browseProduct(ctx, sample.parentProduct.id);
    expect(calls(sink, "editMessageText")).toHaveLength(1);
    expect(calls(sink, "sendMessage")).toHaveLength(0);
    const lines = bodies(sink).split("\n");
    const providerLine = lines.find((l) => l.startsWith("Provider Plan"))!;
    expect(providerLine).toBeDefined();
    expect(providerLine).not.toMatch(/Stock|—\)/);
    expect(lines.find((l) => l.startsWith("1 Month"))).toContain("(Stock 5)");
    expect(lines.find((l) => l.startsWith("Empty Local"))).toContain("(Stock 0)");
  });

  it("an inactive SKU is not shown as out of stock: a product with no active SKU is browse.no_products", async () => {
    const lonely = await createCatalogProduct(prisma, { categoryId: sample.category.id, name: "Lonely" });
    await createDenomination(prisma, {
      productId: lonely.id, name: "Gone", type: ProductType.SHARED, durationLabel: "Gone", price: "5.00",
      deliveryType: "auto", autoDeliverySource: "digiflazz", isActive: false,
    });
    const { ctx, sink } = customerCtx({ callbackData: `v1:browse:pick:${lonely.id}` });
    await customer.browseProduct(ctx, lonely.id);
    expect(calls(sink, "editMessageText")).toHaveLength(1);
    expect(calls(sink, "sendMessage")).toHaveLength(0);
    const text = bodies(sink);
    expect(text).toContain(coreT("browse.no_products", "en"));
    expect(text).not.toContain(outOfStock);
  });
});

describe("quantity", () => {
  it("qtyChange on a provider SKU is not capped by its zero stock", async () => {
    const { ctx, sink } = customerCtx({ callbackData: `v1:qty:${providerId}:10:inc5` });
    await customer.qtyChange(ctx, providerId, 10, "inc5");
    expect(calls(sink, "editMessageText")).toHaveLength(1);
    expect(calls(sink, "sendMessage")).toHaveLength(0);
    expect(callbackData(sink)).toContain(`v1:buy:${providerId}:15`);
  });

  it("qtyInputStart on a provider SKU opens the prompt instead of an out-of-stock alert", async () => {
    const { ctx, sink } = customerCtx({ callbackData: `v1:qty:input:${providerId}` });
    await customer.qtyInputStart(ctx, providerId);
    expect(calls(sink, "editMessageText")).toHaveLength(1);
    expect(calls(sink, "sendMessage")).toHaveLength(0);
    expect(bodies(sink)).toContain(String(MAX_CART_ORDER_UNITS));
    const alerts = calls(sink, "answerCallbackQuery").filter((c) => JSON.stringify(c.args).includes(outOfStock));
    expect(alerts).toHaveLength(0);
    expect(ctx.session.awaitingQtyDenomId).toBe(providerId);
  });

  it("qtyInputStart on an empty local SKU still alerts out of stock", async () => {
    const { ctx, sink } = customerCtx({ callbackData: `v1:qty:input:${emptyLocalId}` });
    await customer.qtyInputStart(ctx, emptyLocalId);
    expect(calls(sink, "editMessageText")).toHaveLength(0);
    expect(calls(sink, "sendMessage")).toHaveLength(0);
    expect(JSON.stringify(calls(sink, "answerCallbackQuery"))).toContain(outOfStock);
  });
});

describe("order confirmation", () => {
  it("does not refuse an auto + digiflazz SKU with no stock rows", async () => {
    const { ctx, sink } = customerCtx({ callbackData: `v1:buy:${providerId}:1` });
    await checkout.showOrderConfirmation(ctx, providerId, 1);
    expect(bodies(sink)).not.toContain(coreT("error.out_of_stock", "en", { product: "Provider Plan" }));
    expect(JSON.stringify(calls(sink, "answerCallbackQuery"))).not.toContain("out of stock");
    // Edit-first: the confirmation is one edit of the existing bubble.
    expect(calls(sink, "editMessageText")).toHaveLength(1);
    expect(calls(sink, "sendMessage")).toHaveLength(0);
    expect(calls(sink, "deleteMessage")).toHaveLength(0);
  });

  it("still refuses a plain auto SKU with no stock (one edit to the notice, no send)", async () => {
    const { ctx, sink } = customerCtx({ callbackData: `v1:buy:${emptyLocalId}:1` });
    await checkout.showOrderConfirmation(ctx, emptyLocalId, 1);
    expect(calls(sink, "editMessageText")).toHaveLength(1);
    expect(calls(sink, "sendMessage")).toHaveLength(0);
    expect(bodies(sink)).toContain(coreT("error.out_of_stock", "en", { product: "Empty Local" }));
  });
});

describe("restock subscription", () => {
  it("refuses a provider SKU with one alert toast: no subscription, no edit, no send", async () => {
    const { ctx, sink } = customerCtx({ callbackData: `v1:restock:sub:${providerId}` });
    await customer.subscribeRestock(ctx, providerId);
    expect(await prisma.restockSubscription.count({ where: { productId: providerId } })).toBe(0);
    expect(calls(sink, "answerCallbackQuery")).toHaveLength(1);
    expect(JSON.stringify(calls(sink, "answerCallbackQuery"))).toContain(coreT("browse.restock_not_needed", "en"));
    expect(calls(sink, "editMessageText")).toHaveLength(0);
    expect(calls(sink, "sendMessage")).toHaveLength(0);
    expect(calls(sink, "deleteMessage")).toHaveLength(0);
  });

  it("still subscribes an empty local-inventory SKU: one toast + one edit", async () => {
    const { ctx, sink } = customerCtx({ callbackData: `v1:restock:sub:${emptyLocalId}` });
    await customer.subscribeRestock(ctx, emptyLocalId);
    expect(await prisma.restockSubscription.count({ where: { productId: emptyLocalId } })).toBe(1);
    expect(calls(sink, "answerCallbackQuery")).toHaveLength(1);
    expect(calls(sink, "editMessageText")).toHaveLength(1);
    expect(calls(sink, "sendMessage")).toHaveLength(0);
  });
});
