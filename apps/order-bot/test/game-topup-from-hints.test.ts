// setup-db MUST be first — temp DB + push before any @app import.
import "./setup-db";

import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { prisma, setSetting, createCatalogProduct, createCategory, createDenomination, upsertUser } from "@app/db";
import { CategoryGroup, UserRole } from "@app/core/enums";
import { buildSampleData, resetDb, type SampleData } from "../../../tests/helpers/sampleData";
import { makeCtx, calls, sentIncludes, type SentCall } from "./helpers/ctx";
import type { SessionData } from "../src/context";
import * as customer from "../src/handlers/customer";
import { routeCallback } from "../src/handlers/callbacks";
import { ctxPriceFormatter } from "../src/util/format";
import { t } from "../src/util/i18n";
import { Decimal } from "@app/core/money";
import { serviceForCategoryGroup } from "@app/core/services";

// Game Top-up `From` price label and one-line hints (Phase 2, Task 5), gated by
// game_topup_flow_v2_enabled. Fixtures are built in-test.

const FLAG = "game_topup_flow_v2_enabled";
const EXPECTED_SKU_SENDS = 1;
const HINT_KEYS = ["hint.game_list", "hint.variant", "hint.region", "hint.server", "hint.packs"] as const;

let sample: SampleData;

beforeEach(async () => {
  await resetDb(prisma);
  sample = await buildSampleData(prisma);
  await upsertUser(prisma, { telegramId: 999, username: "boss", fullName: "Admin Boss" });
});

afterAll(async () => {
  await prisma.$disconnect();
});

interface SessionOpts {
  lang?: "en" | "id";
  role?: string;
  preferredCurrency?: "USD" | "IDR" | null;
}

function userSession(o: SessionOpts = {}): Partial<SessionData> {
  return {
    lang: o.lang ?? "en",
    scratch: {},
    dbUser: {
      id: sample.user.id,
      telegramId: String(sample.user.telegramId),
      role: (o.role ?? sample.user.role) as never,
      language: sample.user.language,
      referralCode: sample.user.referralCode,
      walletBalance: String(sample.user.walletBalance),
      preferredCurrency: o.preferredCurrency ?? null,
    },
  };
}

function customerCtx(o: SessionOpts = {}, opts: Parameters<typeof makeCtx>[0] = {}) {
  return makeCtx({ from: { id: 42, username: "tester" }, session: userSession(o), ...opts });
}

function tapCtx(prev: { session: { scratch: unknown } }, o: SessionOpts = {}, opts: Parameters<typeof makeCtx>[0] = {}) {
  return customerCtx(o, { ...opts, session: { ...userSession(o), scratch: prev.session.scratch as SessionData["scratch"] } });
}

async function product(
  categoryId: number,
  name: string,
  prices: Array<number | { price: number; resellerPrice?: number }>,
  dims: { gameVariant?: string | null; gameRegion?: string | null; gameServer?: string | null } = {},
) {
  const p = await createCatalogProduct(prisma, { categoryId, name });
  await prisma.product.update({
    where: { id: p.id },
    data: { gameVariant: dims.gameVariant ?? null, gameRegion: dims.gameRegion ?? null, gameServer: dims.gameServer ?? null },
  });
  const denoms = [];
  for (const [i, entry] of prices.entries()) {
    const spec = typeof entry === "number" ? { price: entry } : entry;
    denoms.push(
      await createDenomination(prisma, {
        productId: p.id,
        name: `Pack ${i + 1}`,
        type: "SHARED",
        durationLabel: `Pack ${i + 1}`,
        price: String(spec.price),
        ...(spec.resellerPrice !== undefined ? { resellerPrice: String(spec.resellerPrice) } : {}),
      }),
    );
  }
  return { product: p, denoms };
}

/** The text of the single bubble edit a screen produced. */
function bubbleText(sink: SentCall[]): string {
  const edit = calls(sink, "editMessageText")[0] ?? calls(sink, "sendMessage")[0];
  return String(edit!.args[0]);
}

function fromLine(ctx: Parameters<typeof t>[0], price: string): string {
  return t(ctx, "browse.product_from_price", { price });
}

async function gameCategory(name = "Hint Game") {
  return createCategory(prisma, { name, group: CategoryGroup.GAME_TOPUP });
}

async function openList(catId: number, o: SessionOpts = {}) {
  const entry = customerCtx(o, { callbackData: `v1:browse:cat:${catId}` });
  await routeCallback(entry.ctx);
  return entry;
}

describe("From price, flag ON", () => {
  beforeEach(async () => {
    await setSetting(prisma, FLAG, "true");
  });

  it("shows the cheapest active denomination per GAME_TOPUP product, ignoring stock", async () => {
    const cat = await gameCategory();
    await product(cat.id, "Diamonds A", [30000, 15000, 20000]);
    await product(cat.id, "Diamonds B", [50000]);
    const { ctx, sink } = await openList(cat.id);
    const prices = ctxPriceFormatter(ctx, null);
    const text = bubbleText(sink);
    expect(text).toContain(`1. Diamonds A — ${fromLine(ctx, prices.price(15000))}`);
    expect(text).toContain(`2. Diamonds B — ${fromLine(ctx, prices.price(50000))}`);
    expect(text).toContain("Rp15,000");
  });

  it("uses the reseller price for a reseller and the plain price for a customer", async () => {
    const cat = await gameCategory();
    await product(cat.id, "Reseller Game", [{ price: 15000, resellerPrice: 12000 }, 20000]);
    await product(cat.id, "Zz Reseller Filler", [90000]);
    const reseller = await openList(cat.id, { role: UserRole.RESELLER });
    expect(bubbleText(reseller.sink)).toContain(`1. Reseller Game — ${fromLine(reseller.ctx, "Rp12,000")}`);
    const buyer = await openList(cat.id, { role: UserRole.CUSTOMER });
    expect(bubbleText(buyer.sink)).toContain(`1. Reseller Game — ${fromLine(buyer.ctx, "Rp15,000")}`);
  });

  it("uses a live flash price when it beats the base price", async () => {
    const cat = await gameCategory();
    const { denoms } = await product(cat.id, "Flash Game", [20000, 15000]);
    await product(cat.id, "Zz Flash Filler", [90000]);
    await prisma.denomination.update({
      where: { id: denoms[0]!.id },
      data: {
        flashDiscountPercent: "50",
        flashStartsAt: new Date(Date.now() - 3_600_000),
        flashEndsAt: new Date(Date.now() + 3_600_000),
      },
    });
    const { ctx, sink } = await openList(cat.id);
    expect(bubbleText(sink)).toContain(`1. Flash Game — ${fromLine(ctx, "Rp10,000")}`);
  });

  it("formats through the buyer's language and currency (IDR id buyer vs USD en buyer)", async () => {
    await setSetting(prisma, "usd_idr_rate", "16000");
    const cat = await gameCategory();
    await product(cat.id, "Currency Game", [16000]);
    await product(cat.id, "Zz Currency Filler", [90000]);
    const idr = await openList(cat.id, { lang: "id", preferredCurrency: "IDR" });
    expect(bubbleText(idr.sink)).toContain("1. Currency Game — mulai Rp16.000");

    const usd = await openList(cat.id, { lang: "en", preferredCurrency: "USD" });
    const expected = ctxPriceFormatter(usd.ctx, new Decimal(16000)).price(16000);
    expect(expected).toContain("$");
    expect(bubbleText(usd.sink)).toContain(`from ${expected}`);
    expect(bubbleText(usd.sink)).not.toContain("Rp16");
  });

  it("USD buyer without an FX rate: IDR From price plus the rate notice, same call counts", async () => {
    const cat = await gameCategory();
    await product(cat.id, "NoRate Game", [16000]);
    await product(cat.id, "Zz NoRate Filler", [90000]);
    const { ctx, sink } = await openList(cat.id, { lang: "en", preferredCurrency: "USD" });
    const text = bubbleText(sink);
    expect(text).toContain("1. NoRate Game — from Rp16,000");
    expect(text).not.toContain("$");
    expect(text).toContain(ctxPriceFormatter(ctx, null).rateNotice("en").trim());
    expect(text.indexOf(t(ctx, "currency.rate_unavailable"))).toBeLessThan(text.indexOf(t(ctx, "hint.game_list")));
    expect(calls(sink, "sendMessage")).toHaveLength(0);
    expect(calls(sink, "reply")).toHaveLength(1);
    expect(calls(sink, "editMessageText")).toHaveLength(1);
    expect(calls(sink, "deleteMessage")).toHaveLength(0);
  });

  it("never shows From for Premium Apps", async () => {
    const cat = await createCategory(prisma, { name: "Hint Premium Apps", group: CategoryGroup.PREMIUM_APPS });
    await product(cat.id, "App One", [15000, 20000]);
    await product(cat.id, "App Two", [25000]);
    const { ctx, sink } = await openList(cat.id);
    const text = bubbleText(sink);
    expect(text).toContain("1. App One");
    expect(text).not.toContain(fromLine(ctx, "").trim());
    expect(text).not.toContain("Rp15,000");
  });
});

describe("hints, flag ON", () => {
  beforeEach(async () => {
    await setSetting(prisma, FLAG, "true");
  });

  it("product list: hint.game_list (not hint.packs) rides on the same bubble with unchanged call counts", async () => {
    const cat = await gameCategory();
    await product(cat.id, "List Game A", [15000]);
    await product(cat.id, "List Game B", [20000]);
    const { ctx, sink } = await openList(cat.id);
    const text = bubbleText(sink);
    expect(text.endsWith(t(ctx, "hint.game_list"))).toBe(true);
    expect(text).not.toContain(t(ctx, "hint.packs"));
    expect(calls(sink, "sendMessage")).toHaveLength(0);
    expect(calls(sink, "reply")).toHaveLength(1); // digit keyboard resend, as before
    expect(calls(sink, "editMessageText")).toHaveLength(1);
    expect(calls(sink, "deleteMessage")).toHaveLength(0);
  });

  it("variant, region and server pickers each carry exactly their own hint", async () => {
    const cat = await gameCategory("Layered Game");
    await product(cat.id, "LG A", [15000], { gameVariant: "Global", gameRegion: "Asia", gameServer: "S1" });
    await product(cat.id, "LG B", [15000], { gameVariant: "Global", gameRegion: "Asia", gameServer: "S2" });
    await product(cat.id, "LG C", [15000], { gameVariant: "Lite", gameRegion: "Asia", gameServer: "S1" });
    await product(cat.id, "LG D", [15000], { gameVariant: "Global", gameRegion: "EU", gameServer: "S1" });

    const variantStep = await openList(cat.id);
    expect(bubbleText(variantStep.sink).endsWith(t(variantStep.ctx, "hint.variant"))).toBe(true);
    expect(calls(variantStep.sink, "editMessageText")).toHaveLength(1);
    expect(calls(variantStep.sink, "reply")).toHaveLength(1);
    expect(calls(variantStep.sink, "sendMessage")).toHaveLength(0);

    const regionStep = tapCtx(variantStep.ctx, {}, { callbackData: `v1:browse:gvar:${cat.id}:0` });
    await routeCallback(regionStep.ctx);
    expect(bubbleText(regionStep.sink).endsWith(t(regionStep.ctx, "hint.region"))).toBe(true);
    expect(calls(regionStep.sink, "editMessageText")).toHaveLength(1);
    expect(calls(regionStep.sink, "sendMessage")).toHaveLength(0);

    const serverStep = tapCtx(regionStep.ctx, {}, { callbackData: `v1:browse:greg:${cat.id}:0` });
    await routeCallback(serverStep.ctx);
    expect(bubbleText(serverStep.sink).endsWith(t(serverStep.ctx, "hint.server"))).toBe(true);
    expect(calls(serverStep.sink, "editMessageText")).toHaveLength(1);
    expect(calls(serverStep.sink, "sendMessage")).toHaveLength(0);
    for (const other of ["hint.variant", "hint.region"] as const) {
      expect(bubbleText(serverStep.sink)).not.toContain(t(serverStep.ctx, other));
    }
  });

  it("game list (category picker of the Game Top Up group) carries hint.game_list", async () => {
    await gameCategory("Game One");
    await gameCategory("Game Two");
    await product((await gameCategory("Game Three")).id, "G3", [1000]);
    const { ctx, sink } = customerCtx({}, { callbackData: `v1:browse:grp:${CategoryGroup.GAME_TOPUP}` });
    await routeCallback(ctx);
    expect(bubbleText(sink).endsWith(t(ctx, "hint.game_list"))).toBe(true);
    expect(calls(sink, "editMessageText")).toHaveLength(1);
    expect(calls(sink, "sendMessage")).toHaveLength(0);
  });

  it("SKU picker of a GAME_TOPUP product carries hint.packs; a Premium Apps picker does not", async () => {
    const cat = await gameCategory();
    const game = await product(cat.id, "Sku Game", [15000, 20000]);
    const g = customerCtx();
    await customer.browseProduct(g.ctx, game.product.id);
    const gameText = [...calls(g.sink, "editMessageText"), ...calls(g.sink, "sendMessage"), ...calls(g.sink, "reply")].map((c) => String(c.args[0])).join("\n");
    expect(gameText).toContain(t(g.ctx, "hint.packs"));
    expect(g.sink.filter((c) => ["sendMessage", "reply", "deleteMessage"].includes(c.method)).length).toBe(EXPECTED_SKU_SENDS);

    const premiumCat = await createCategory(prisma, { name: "Hint Apps", group: CategoryGroup.PREMIUM_APPS });
    const app = await product(premiumCat.id, "Sku App", [15000, 20000]);
    const a = customerCtx();
    await customer.browseProduct(a.ctx, app.product.id);
    for (const key of HINT_KEYS) expect(sentIncludes(a.sink, t(a.ctx, key))).toBe(false);
  });

  it("Premium Apps flat list has no hint", async () => {
    const cat = await createCategory(prisma, { name: "Hint Premium Apps", group: CategoryGroup.PREMIUM_APPS });
    await product(cat.id, "App One", [15000]);
    await product(cat.id, "App Two", [20000]);
    const { ctx, sink } = await openList(cat.id);
    for (const key of HINT_KEYS) expect(sentIncludes(sink, t(ctx, key))).toBe(false);
  });
});

describe("flag OFF", () => {
  it.each([["unset", null], ["false", "false"]])("(%s) the product list text is byte-identical to the old format and no hint appears", async (_label, value) => {
    if (value !== null) await setSetting(prisma, FLAG, value);
    const cat = await gameCategory();
    await product(cat.id, "Old Game A", [15000]);
    await product(cat.id, "Old Game B", [20000, 30000]);
    const { ctx, sink } = await openList(cat.id);
    const expected = t(ctx, "browse.list_decorated", { page: 1, total: 1, items: "1. Old Game A\n2. Old Game B" });
    expect(bubbleText(sink)).toBe(expected);
    expect(calls(sink, "sendMessage")).toHaveLength(0);
    expect(calls(sink, "reply")).toHaveLength(1);
    expect(calls(sink, "editMessageText")).toHaveLength(1);
    expect(calls(sink, "deleteMessage")).toHaveLength(0);
  });

  it("pickers and the SKU picker carry no hint", async () => {
    const cat = await gameCategory("Layered Off");
    await product(cat.id, "LO A", [15000, 20000], { gameVariant: "Global", gameRegion: "Asia" });
    await product(cat.id, "LO B", [15000], { gameVariant: "Lite", gameRegion: "Asia" });
    const variantStep = await openList(cat.id);
    expect(bubbleText(variantStep.sink)).toBe(t(variantStep.ctx, "browse.choose_variant"));
    const sku = customerCtx();
    const p = await prisma.product.findFirstOrThrow({ where: { name: "LO A" } });
    await customer.browseProduct(sku.ctx, p.id);
    for (const key of HINT_KEYS) expect(sentIncludes(sku.sink, t(sku.ctx, key))).toBe(false);
  });

  it("category list and region picker are byte-identical to the old text with exact call counts", async () => {
    await gameCategory("Off One");
    await gameCategory("Off Two");
    const list = customerCtx({}, { callbackData: `v1:browse:grp:${CategoryGroup.GAME_TOPUP}` });
    await routeCallback(list.ctx);
    const groupLabel = t(list.ctx, serviceForCategoryGroup(CategoryGroup.GAME_TOPUP).translationKey);
    expect(bubbleText(list.sink)).toBe(t(list.ctx, "browse.category_picker_title", { group: groupLabel }));
    expect(calls(list.sink, "editMessageText")).toHaveLength(1);
    expect(calls(list.sink, "sendMessage")).toHaveLength(0);
    expect(calls(list.sink, "reply")).toHaveLength(0);
    expect(calls(list.sink, "deleteMessage")).toHaveLength(0);

    const cat = await gameCategory("Region Off");
    await product(cat.id, "RO A", [15000], { gameRegion: "Asia" });
    await product(cat.id, "RO B", [15000], { gameRegion: "EU" });
    const region = await openList(cat.id);
    expect(bubbleText(region.sink)).toBe(t(region.ctx, "browse.choose_region"));
    expect(calls(region.sink, "editMessageText")).toHaveLength(1);
    expect(calls(region.sink, "sendMessage")).toHaveLength(0);
    expect(calls(region.sink, "reply")).toHaveLength(1);
    expect(calls(region.sink, "deleteMessage")).toHaveLength(0);
  });

  // The server picker only renders with the flag ON (pickGameRegion skips straight
  // to the product list otherwise), so there is no flag-off server text to pin.
  it("never reaches the server picker: a region tap lands on the product list with no hint", async () => {
    const cat = await gameCategory("Server Off");
    await product(cat.id, "SO A", [15000], { gameRegion: "Asia", gameServer: "S1" });
    await product(cat.id, "SO B", [15000], { gameRegion: "Asia", gameServer: "S2" });
    await product(cat.id, "SO C", [15000], { gameRegion: "EU", gameServer: "S1" });
    const regionStep = await openList(cat.id);
    const tap = tapCtx(regionStep.ctx, {}, { callbackData: `v1:browse:greg:${cat.id}:0` });
    await routeCallback(tap.ctx);
    expect(bubbleText(tap.sink)).not.toContain(t(tap.ctx, "browse.choose_server"));
    for (const key of HINT_KEYS) expect(sentIncludes(tap.sink, t(tap.ctx, key))).toBe(false);
  });
});
