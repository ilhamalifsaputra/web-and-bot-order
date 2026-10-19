// setup-db MUST be first — temp DB + push before any @app import.
import "./setup-db";

import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { prisma, setSetting, createCatalogProduct, createCategory, createDenomination, upsertUser } from "@app/db";
import { CategoryGroup } from "@app/core/enums";
import { buildSampleData, resetDb, type SampleData } from "../../../tests/helpers/sampleData";
import { makeCtx, calls, sentIncludes, lastMarkup, type SentCall } from "./helpers/ctx";
import type { SessionData } from "../src/context";
import { routeCallback } from "../src/handlers/callbacks";
import { t } from "../src/util/i18n";

// Game Top-up region -> product list navigation. Region is the only level
// below the edition: tapping a region goes straight to that region's products
// (or the single product's detail), with and without game_topup_flow_v2_enabled.
// The flag only appends one hint line to the bubble; it never adds a step or a message.

const FLAG = "game_topup_flow_v2_enabled";
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

/** Region index of `label` on the picker the last screen rendered. */
function regionIdx(sink: SentCall[], catId: number, label: string): number {
  const b = buttons(sink).find((x) => x.text === label && x.callback_data?.startsWith(`v1:browse:greg:${catId}:`));
  return Number(b!.callback_data!.split(":")[4]);
}

type Scratch = { activeNumberedScreen?: string };

describe.each([["unset", null], ["false", "false"], ["true", "true"]])("region picker with the flow v2 flag %s", (_label, value) => {
  beforeEach(async () => {
    if (value !== null) await setSetting(prisma, FLAG, value);
  });

  it("a region tap lists every product in that region with the same Telegram call budget", async () => {
    const cat = await freeFire();
    const entry = customerCtx({ callbackData: `v1:browse:cat:${cat.id}` });
    await routeCallback(entry.ctx);
    expect(sentIncludes(entry.sink, t(entry.ctx, "browse.choose_region"))).toBe(true);

    const tap = tapCtx(entry.ctx, { callbackData: `v1:browse:greg:${cat.id}:${regionIdx(entry.sink, cat.id, "Indonesia")}` });
    await routeCallback(tap.ctx);

    for (const name of ["FF Alpha", "FF Bravo", "FF Charlie"]) expect(sentIncludes(tap.sink, name)).toBe(true);
    expect(sentIncludes(tap.sink, "FF Delta")).toBe(false);
    expect((tap.ctx.session.scratch as Scratch).activeNumberedScreen).toBe("products");
    // One digit-keyboard resend plus the list edit; nothing else.
    expect(calls(tap.sink, "sendMessage")).toHaveLength(0);
    expect(calls(tap.sink, "reply")).toHaveLength(1);
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
