// setup-db MUST be first — temp DB + push before any @app import.
import "./setup-db";

import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { prisma, createCatalogProduct, createCategory, createDenomination, upsertUser } from "@app/db";
import { CategoryGroup } from "@app/core/enums";
import { buildSampleData, resetDb, type SampleData } from "../../../tests/helpers/sampleData";
import { makeCtx, calls, sentIncludes, lastMarkup, type SentCall } from "./helpers/ctx";
import type { SessionData } from "../src/context";
import { routeCallback } from "../src/handlers/callbacks";
import * as customer from "../src/handlers/customer";
import { persistentLabel } from "../src/keyboards/customer";
import { t } from "../src/util/i18n";

// Game Top-up region -> product list navigation. Region is the only level
// below the edition: tapping a region goes straight to that region's products
// (or the single product's detail). The hint is one line appended to the bubble;
// it never adds a step or a message.

type Button = { text: string; callback_data?: string };

let sample: SampleData;

beforeEach(async () => {
  await resetDb(prisma);
  sample = await buildSampleData(prisma);
  await upsertUser(prisma, { telegramId: 999, username: "boss", fullName: "Admin Boss" });
});

afterAll(async () => {
  await prisma.$disconnect();
});

function userSession(): Partial<SessionData> {
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
  return makeCtx({ from: { id: 42, username: "tester" }, session: userSession(), ...opts });
}

/** A follow-up ctx that shares the previous screen's scratch (a later tap). */
function tapCtx(prev: { session: { scratch: unknown } }, opts: Parameters<typeof makeCtx>[0] = {}) {
  return customerCtx({ ...opts, session: { ...userSession(), scratch: prev.session.scratch as SessionData["scratch"] } });
}

async function product(categoryId: number, name: string, dims: { gameVariant?: string | null; gameRegion?: string | null } = {}) {
  const p = await createCatalogProduct(prisma, { categoryId, name });
  await prisma.product.update({
    where: { id: p.id },
    data: { gameVariant: dims.gameVariant ?? null, gameRegion: dims.gameRegion ?? null },
  });
  await createDenomination(prisma, { productId: p.id, name: "100", type: "SHARED", durationLabel: "100", price: "15000" });
  return p;
}

/** Free Fire: Indonesia has three products, Global has one. */
async function freeFire() {
  const cat = await createCategory(prisma, { name: "Free Fire", group: CategoryGroup.GAME_TOPUP });
  await product(cat.id, "FF Alpha", { gameRegion: "Indonesia" });
  await product(cat.id, "FF Bravo", { gameRegion: "Indonesia" });
  await product(cat.id, "FF Charlie", { gameRegion: "Indonesia" });
  await product(cat.id, "FF Delta", { gameRegion: "Global" });
  return cat;
}

const buttons = (sink: SentCall[]): Button[] =>
  ((lastMarkup(sink) as { inline_keyboard?: Button[][] } | undefined)?.inline_keyboard ?? []).flat();

/** Region index of `label` on the picker the last screen rendered. A recognised
 * region shows its canonical flagged label ("Indonesia" → "🇮🇩 Indonesia"). */
function regionIdx(sink: SentCall[], catId: number, label: string): number {
  const b = buttons(sink).find((x) => (x.text === label || x.text.endsWith(` ${label}`)) && x.callback_data?.startsWith(`v1:browse:greg:${catId}:`));
  return Number(b!.callback_data!.split(":")[4]);
}

type Scratch = { activeNumberedScreen?: string };

// Exact Telegram call counts of the typed Back from the product list when the
// session tracks no menu bubble (a fresh session carrying only the scratch):
// one send that becomes the tracked bubble, and the typed "← Back" deleted.
// With a tracked bubble the typed Back is one edit instead (back-navigation.test.ts).
const BACK_SEND = 0;
const BACK_REPLY = 1;
const BACK_EDIT = 0;
const BACK_DELETE = 1;

describe("region picker", () => {
  it("a region tap lists every product in that region with the same Telegram call budget", async () => {
    const cat = await freeFire();
    const entry = customerCtx({ callbackData: `v1:browse:cat:${cat.id}` });
    await routeCallback(entry.ctx);
    expect(sentIncludes(entry.sink, t(entry.ctx, "browse.choose_region"))).toBe(true);

    const tap = tapCtx(entry.ctx, { callbackData: `v1:browse:greg:${cat.id}:${regionIdx(entry.sink, cat.id, "Indonesia")}` });
    await routeCallback(tap.ctx);

    for (const name of ["FF Alpha", "FF Bravo", "FF Charlie"]) expect(sentIncludes(tap.sink, name)).toBe(true);
    expect(sentIncludes(tap.sink, "FF Delta")).toBe(false);
    // An inline list: no numbered screen recorded.
    expect((tap.ctx.session.scratch as Scratch).activeNumberedScreen).toBeUndefined();
    // The list edit only: no digit keyboard, no companion message.
    expect(calls(tap.sink, "sendMessage")).toHaveLength(0);
    expect(calls(tap.sink, "reply")).toHaveLength(0);
    expect(calls(tap.sink, "editMessageText")).toHaveLength(1);
    expect(calls(tap.sink, "deleteMessage")).toHaveLength(0);
  });

  it("a region with exactly one product collapses straight to that product", async () => {
    const cat = await freeFire();
    const entry = customerCtx({ callbackData: `v1:browse:cat:${cat.id}` });
    await routeCallback(entry.ctx);
    const tap = tapCtx(entry.ctx, { callbackData: `v1:browse:greg:${cat.id}:${regionIdx(entry.sink, cat.id, "Global")}` });
    await routeCallback(tap.ctx);
    expect(sentIncludes(tap.sink, "FF Delta")).toBe(true);
    expect(sentIncludes(tap.sink, "FF Alpha")).toBe(false);
    expect(calls(tap.sink, "sendMessage")).toHaveLength(0);
    expect(calls(tap.sink, "reply")).toHaveLength(0);
    expect(calls(tap.sink, "editMessageText")).toHaveLength(1);
    expect(calls(tap.sink, "deleteMessage")).toHaveLength(0);
  });

  it("a mixed region scope (some products without a region) lists every product and shows no picker", async () => {
    const cat = await freeFire();
    await product(cat.id, "FF Echo");
    const entry = customerCtx({ callbackData: `v1:browse:cat:${cat.id}` });
    await routeCallback(entry.ctx);
    for (const name of ["FF Alpha", "FF Bravo", "FF Charlie", "FF Delta", "FF Echo"]) expect(sentIncludes(entry.sink, name)).toBe(true);
    expect(sentIncludes(entry.sink, t(entry.ctx, "browse.choose_region"))).toBe(false);
    expect(sentIncludes(entry.sink, ":greg:")).toBe(false);
    expect((entry.ctx.session.scratch as Scratch).activeNumberedScreen).toBeUndefined();
    // The list edit only; no picker, no companion, no extra send or delete.
    expect(calls(entry.sink, "sendMessage")).toHaveLength(0);
    expect(calls(entry.sink, "reply")).toHaveLength(0);
    expect(calls(entry.sink, "editMessageText")).toHaveLength(1);
    expect(calls(entry.sink, "deleteMessage")).toHaveLength(0);
  });

  it("exactly one region plus a region-less sibling lists both instead of silently filtering", async () => {
    const cat = await createCategory(prisma, { name: "Free Fire", group: CategoryGroup.GAME_TOPUP });
    await product(cat.id, "FF Alpha", { gameRegion: "Indonesia" });
    await product(cat.id, "FF Echo");
    const entry = customerCtx({ callbackData: `v1:browse:cat:${cat.id}` });
    await routeCallback(entry.ctx);
    expect(sentIncludes(entry.sink, "FF Alpha")).toBe(true);
    expect(sentIncludes(entry.sink, "FF Echo")).toBe(true);
    expect(calls(entry.sink, "reply")).toHaveLength(0);
    expect(calls(entry.sink, "editMessageText")).toHaveLength(1);
  });

  it("a mixed scope keeps every product on page 2 and after Back from a product", async () => {
    const cat = await createCategory(prisma, { name: "Free Fire", group: CategoryGroup.GAME_TOPUP });
    for (let i = 0; i < 12; i++) await product(cat.id, `FF P${String(i).padStart(2, "0")}`, i % 2 ? { gameRegion: "Indonesia" } : {});
    const entry = customerCtx({ callbackData: `v1:browse:cat:${cat.id}` });
    await routeCallback(entry.ctx);
    const page2 = tapCtx(entry.ctx, { callbackData: "v1:browse:page:1" });
    await routeCallback(page2.ctx);
    expect(sentIncludes(page2.sink, "FF P10")).toBe(true);
    expect(sentIncludes(page2.sink, "FF P11")).toBe(true);
    expect(calls(page2.sink, "sendMessage")).toHaveLength(0);
    expect(calls(page2.sink, "editMessageText")).toHaveLength(1);
    expect(calls(page2.sink, "deleteMessage")).toHaveLength(0);

    const back = tapCtx(page2.ctx, { callbackData: "v1:browse:prods" });
    await routeCallback(back.ctx);
    expect(sentIncludes(back.sink, "FF P10")).toBe(true);
    expect(sentIncludes(back.sink, t(back.ctx, "browse.choose_region"))).toBe(false);
  });

  it("a non-mixed scope keeps the picker and the region filter", async () => {
    const cat = await freeFire();
    const entry = customerCtx({ callbackData: `v1:browse:cat:${cat.id}` });
    await routeCallback(entry.ctx);
    expect(sentIncludes(entry.sink, t(entry.ctx, "browse.choose_region"))).toBe(true);
    expect(buttons(entry.sink).filter((b) => b.callback_data?.includes(":greg:"))).toHaveLength(2);
    expect(calls(entry.sink, "reply")).toHaveLength(0);
    expect(calls(entry.sink, "editMessageText")).toHaveLength(1);

    // Picking a region filters: only that region's products are listed.
    const tap = tapCtx(entry.ctx, { callbackData: `v1:browse:greg:${cat.id}:${regionIdx(entry.sink, cat.id, "Indonesia")}` });
    await routeCallback(tap.ctx);
    for (const name of ["FF Alpha", "FF Bravo", "FF Charlie"]) expect(sentIncludes(tap.sink, name)).toBe(true);
    expect(sentIncludes(tap.sink, "FF Delta")).toBe(false);
    expect((tap.ctx.session.scratch as { gameRegionDimensionSkipped?: boolean }).gameRegionDimensionSkipped).toBeUndefined();
  });

  it("after the variant picker, a mixed region scope keeps the variant filter and lists every product of that variant", async () => {
    const cat = await createCategory(prisma, { name: "Free Fire", group: CategoryGroup.GAME_TOPUP });
    await product(cat.id, "FF Global Indo", { gameVariant: "Global", gameRegion: "Indonesia" });
    await product(cat.id, "FF Global Plain", { gameVariant: "Global" });
    await product(cat.id, "FF Lite Asia", { gameVariant: "Lite", gameRegion: "Asia" });
    await product(cat.id, "FF Lite Plain", { gameVariant: "Lite" });
    const entry = customerCtx({ callbackData: `v1:browse:cat:${cat.id}` });
    await routeCallback(entry.ctx);
    expect(sentIncludes(entry.sink, t(entry.ctx, "browse.choose_variant"))).toBe(true);
    const variantBtn = buttons(entry.sink).find((b) => b.callback_data?.startsWith(`v1:browse:gvar:${cat.id}:`) && b.text.includes("Global"));

    const tap = tapCtx(entry.ctx, { callbackData: variantBtn!.callback_data! });
    await routeCallback(tap.ctx);
    // Variant filter kept (no Lite product), both the regional and the region-less Global product listed.
    expect(sentIncludes(tap.sink, "FF Global Indo")).toBe(true);
    expect(sentIncludes(tap.sink, "FF Global Plain")).toBe(true);
    expect(sentIncludes(tap.sink, "FF Lite Asia")).toBe(false);
    expect(sentIncludes(tap.sink, "FF Lite Plain")).toBe(false);
    expect(sentIncludes(tap.sink, t(tap.ctx, "browse.choose_region"))).toBe(false);
    // The product query carries no gameRegion key: the scratch flag that removes it is set.
    const scratch = tap.ctx.session.scratch as { gameRegionDimensionSkipped?: boolean; resolvedGameVariant?: string | null; resolvedGameRegion?: string | null };
    expect(scratch.gameRegionDimensionSkipped).toBe(true);
    expect(scratch.resolvedGameVariant).toBe("Global");
    expect(scratch.resolvedGameRegion).toBeUndefined();
    expect(calls(tap.sink, "sendMessage")).toHaveLength(0);
    expect(calls(tap.sink, "reply")).toHaveLength(0);
    expect(calls(tap.sink, "editMessageText")).toHaveLength(1);
    expect(calls(tap.sink, "deleteMessage")).toHaveLength(0);
  });

  it("Back from a mixed-scope product list reaches the category picker", async () => {
    const cat = await freeFire();
    await product(cat.id, "FF Echo");
    await createCategory(prisma, { name: "Wild Rift", group: CategoryGroup.GAME_TOPUP });
    const entry = customerCtx({ callbackData: `v1:browse:cat:${cat.id}` });
    await routeCallback(entry.ctx);
    expect(sentIncludes(entry.sink, "FF Echo")).toBe(true);

    const back = customerCtx({ text: persistentLabel("back", "en"), session: { ...userSession(), scratch: entry.ctx.session.scratch } });
    await customer.handleProductNumber(back.ctx);
    expect(sentIncludes(back.sink, "Wild Rift")).toBe(true);
    expect(sentIncludes(back.sink, "FF Alpha")).toBe(false);
    expect(sentIncludes(back.sink, "What are you shopping for")).toBe(false);
    expect(calls(back.sink, "sendMessage")).toHaveLength(BACK_SEND);
    expect(calls(back.sink, "reply")).toHaveLength(BACK_REPLY);
    expect(calls(back.sink, "editMessageText")).toHaveLength(BACK_EDIT);
    expect(calls(back.sink, "deleteMessage").map((c) => c.args[1])).toEqual(Array(BACK_DELETE).fill(back.ctx.message!.message_id));
    expect(back.ctx.session.menuMsgId).toBeDefined();
  });

  it("a region-less product that is inactive does not make the scope mixed", async () => {
    const cat = await freeFire();
    const hidden = await product(cat.id, "FF Hidden");
    await prisma.product.update({ where: { id: hidden.id }, data: { isActive: false } });
    const entry = customerCtx({ callbackData: `v1:browse:cat:${cat.id}` });
    await routeCallback(entry.ctx);
    expect(sentIncludes(entry.sink, t(entry.ctx, "browse.choose_region"))).toBe(true);
  });

  it("a Premium Apps category never shows the region picker, even when its products carry a region", async () => {
    const cat = await createCategory(prisma, { name: "Streaming Apps", group: CategoryGroup.PREMIUM_APPS });
    await product(cat.id, "App One", { gameRegion: "Indonesia" });
    await product(cat.id, "App Two", { gameRegion: "Global" });
    const { ctx, sink } = customerCtx({ callbackData: `v1:browse:cat:${cat.id}` });
    await routeCallback(ctx);
    expect(sentIncludes(sink, "App One")).toBe(true);
    expect(sentIncludes(sink, "App Two")).toBe(true);
    expect(sentIncludes(sink, t(ctx, "browse.choose_region"))).toBe(false);
    expect(sentIncludes(sink, ":greg:")).toBe(false);
  });
});
