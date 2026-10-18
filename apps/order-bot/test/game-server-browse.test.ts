// setup-db MUST be first — temp DB + push before any @app import.
import "./setup-db";

import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { prisma, setSetting, createCatalogProduct, createCategory, createDenomination, upsertUser } from "@app/db";
import { CategoryGroup } from "@app/core/enums";
import { buildSampleData, resetDb, type SampleData } from "../../../tests/helpers/sampleData";
import { makeCtx, calls, sentIncludes, lastMarkup, type SentCall } from "./helpers/ctx";
import type { SessionData } from "../src/context";
import { gameServerPickerKb } from "../src/keyboards/customer";
import * as customer from "../src/handlers/customer";
import { routeCallback } from "../src/handlers/callbacks";
import { t } from "../src/util/i18n";

// Game Top-up Server level (Phase 2, Task 4): a Server picker after region,
// gated by the game_topup_flow_v2_enabled flag. Fixtures are built in-test.

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

async function product(
  categoryId: number,
  name: string,
  dims: { gameVariant?: string | null; gameRegion?: string | null; gameServer?: string | null } = {},
) {
  const p = await createCatalogProduct(prisma, { categoryId, name });
  await prisma.product.update({
    where: { id: p.id },
    data: { gameVariant: dims.gameVariant ?? null, gameRegion: dims.gameRegion ?? null, gameServer: dims.gameServer ?? null },
  });
  await createDenomination(prisma, { productId: p.id, name: "100", type: "SHARED", durationLabel: "100", price: "15000" });
  return p;
}

/** Free Fire: Indonesia has Server 1 (1 product) and Server 2 (2 products); Global has no server. */
async function freeFire() {
  const cat = await createCategory(prisma, { name: "Free Fire", group: CategoryGroup.GAME_TOPUP });
  await product(cat.id, "FF Alpha", { gameRegion: "Indonesia", gameServer: "Server 1" });
  await product(cat.id, "FF Bravo", { gameRegion: "Indonesia", gameServer: "Server 2" });
  await product(cat.id, "FF Charlie", { gameRegion: "Indonesia", gameServer: "Server 2" });
  await product(cat.id, "FF Delta", { gameRegion: "Global" });
  return cat;
}

/** Free Fire with a single region, so the region step is skipped. */
async function freeFireOneRegion() {
  const cat = await createCategory(prisma, { name: "Free Fire One", group: CategoryGroup.GAME_TOPUP });
  await product(cat.id, "FF Alpha", { gameRegion: "Indonesia", gameServer: "Server 1" });
  await product(cat.id, "FF Bravo", { gameRegion: "Indonesia", gameServer: "Server 2" });
  await product(cat.id, "FF Charlie", { gameRegion: "Indonesia", gameServer: "Server 2" });
  return cat;
}

const buttons = (sink: SentCall[]): Button[] =>
  ((lastMarkup(sink) as { inline_keyboard?: Button[][] } | undefined)?.inline_keyboard ?? []).flat();

/** Region index of `name` on the picker the last screen rendered. */
function regionIdx(sink: SentCall[], catId: number, label: string): number {
  const b = buttons(sink).find((x) => x.text === label && x.callback_data?.startsWith(`v1:browse:greg:${catId}:`));
  return Number(b!.callback_data!.split(":")[4]);
}

type Scratch = {
  activeNumberedScreen?: string;
  browseEntries?: unknown[];
  gameVariantEntries?: unknown[];
  gameRegionEntries?: unknown[];
  gameServerEntries?: string[];
  resolvedGameServer?: string | null;
  gameServerDimensionSkipped?: boolean;
};

describe("Server level, flag ON", () => {
  beforeEach(async () => {
    await setSetting(prisma, FLAG, "true");
  });

  it("shows the server picker after the region with exact Telegram call counts and a Back to the region picker", async () => {
    const cat = await freeFire();
    const entry = customerCtx({ callbackData: `v1:browse:cat:${cat.id}` });
    await routeCallback(entry.ctx);
    expect(sentIncludes(entry.sink, t(entry.ctx, "browse.choose_region"))).toBe(true);

    const tap = tapCtx(entry.ctx, { callbackData: `v1:browse:greg:${cat.id}:${regionIdx(entry.sink, cat.id, "Indonesia")}` });
    await routeCallback(tap.ctx);

    expect(sentIncludes(tap.sink, t(tap.ctx, "browse.choose_server"))).toBe(true);
    // One reply-keyboard resend + one edit of the bubble; nothing else.
    expect(calls(tap.sink, "sendMessage")).toHaveLength(0);
    expect(calls(tap.sink, "reply")).toHaveLength(1);
    expect(calls(tap.sink, "editMessageText")).toHaveLength(1);
    expect(calls(tap.sink, "deleteMessage")).toHaveLength(0);

    const all = buttons(tap.sink);
    const servers = all.filter((b) => b.callback_data?.startsWith(`v1:browse:gsrv:${cat.id}:`));
    expect(servers.map((b) => b.text)).toEqual(["Server 1", "Server 2"]);
    expect(servers.map((b) => b.callback_data)).toEqual([`v1:browse:gsrv:${cat.id}:0`, `v1:browse:gsrv:${cat.id}:1`]);
    expect(all[all.length - 1]!.callback_data).toBe(`v1:browse:gregs:${cat.id}`);
    for (const b of all) expect(Buffer.byteLength(b.callback_data ?? "", "utf8")).toBeLessThanOrEqual(64);

    const s = tap.ctx.session.scratch as Scratch;
    expect(s.activeNumberedScreen).toBe("gameServer");
    expect(s.gameServerEntries).toEqual(["Server 1", "Server 2"]);
    expect(s.browseEntries).toBeUndefined();
    expect(s.gameVariantEntries).toBeUndefined();
    expect(s.gameRegionEntries).toBeUndefined();
  });

  it("tapping a server with one product collapses to that product", async () => {
    const cat = await freeFireOneRegion();
    const entry = customerCtx({ callbackData: `v1:browse:cat:${cat.id}` });
    await routeCallback(entry.ctx); // one region -> server picker directly
    expect((entry.ctx.session.scratch as Scratch).activeNumberedScreen).toBe("gameServer");

    const tap = tapCtx(entry.ctx, { callbackData: `v1:browse:gsrv:${cat.id}:0` });
    await routeCallback(tap.ctx);
    expect(sentIncludes(tap.sink, "FF Alpha")).toBe(true);
    expect((tap.ctx.session.scratch as Scratch).resolvedGameServer).toBe("Server 1");
  });

  it("tapping a server with several products lists only that server's products", async () => {
    const cat = await freeFireOneRegion();
    const entry = customerCtx({ callbackData: `v1:browse:cat:${cat.id}` });
    await routeCallback(entry.ctx);

    const tap = tapCtx(entry.ctx, { callbackData: `v1:browse:gsrv:${cat.id}:1` });
    await routeCallback(tap.ctx);
    expect(sentIncludes(tap.sink, "FF Bravo")).toBe(true);
    expect(sentIncludes(tap.sink, "FF Charlie")).toBe(true);
    expect(sentIncludes(tap.sink, "FF Alpha")).toBe(false);
    const s = tap.ctx.session.scratch as Scratch;
    expect(s.resolvedGameServer).toBe("Server 2");
    expect(s.activeNumberedScreen).toBe("products");
    expect(s.gameServerEntries).toBeUndefined();
  });

  it("a stale server index answers the stale-screen toast and renders nothing", async () => {
    const { ctx, sink } = customerCtx({ callbackData: "v1:browse:gsrv:1:0", session: { ...userSession(), scratch: {} } });
    await customer.pickGameServer(ctx, 1, 0);
    expect(sentIncludes(sink, t(ctx, "error.stale_screen"))).toBe(true);
    expect(calls(sink, "answerCallbackQuery")).toHaveLength(1);
    expect(calls(sink, "editMessageText")).toHaveLength(0);
    expect(calls(sink, "sendMessage")).toHaveLength(0);
  });

  it("a typed digit resolves against the server picker, and an out-of-range digit gets the invalid-number message", async () => {
    const cat = await freeFireOneRegion();
    const entry = customerCtx({ callbackData: `v1:browse:cat:${cat.id}` });
    await routeCallback(entry.ctx);
    (entry.ctx.session.scratch as Record<string, unknown>).browseEntries = [999999]; // stale list must not win

    const digit = tapCtx(entry.ctx, { text: "1" });
    await customer.handleProductNumber(digit.ctx);
    expect(sentIncludes(digit.sink, "FF Alpha")).toBe(true);
    expect((digit.ctx.session.scratch as Scratch).resolvedGameServer).toBe("Server 1");

    const entry2 = customerCtx({ callbackData: `v1:browse:cat:${cat.id}` });
    await routeCallback(entry2.ctx);
    const bad = tapCtx(entry2.ctx, { text: "9" });
    await customer.handleProductNumber(bad.ctx);
    expect(sentIncludes(bad.sink, t(bad.ctx, "browse.invalid_number", { max: 2 }))).toBe(true);
    expect(sentIncludes(bad.sink, t(bad.ctx, "error.stale_screen"))).toBe(false);
  });

  it("Back (gregs) from the server picker re-opens the region picker", async () => {
    const cat = await freeFire();
    const entry = customerCtx({ callbackData: `v1:browse:cat:${cat.id}` });
    await routeCallback(entry.ctx);
    const pick = tapCtx(entry.ctx, { callbackData: `v1:browse:greg:${cat.id}:${regionIdx(entry.sink, cat.id, "Indonesia")}` });
    await routeCallback(pick.ctx);

    const back = tapCtx(pick.ctx, { callbackData: `v1:browse:gregs:${cat.id}` });
    await routeCallback(back.ctx);
    expect(sentIncludes(back.sink, t(back.ctx, "browse.choose_region"))).toBe(true);
    expect(buttons(back.sink).filter((b) => b.callback_data?.startsWith(`v1:browse:greg:${cat.id}:`))).toHaveLength(2);
    const s = back.ctx.session.scratch as Scratch;
    expect(s.activeNumberedScreen).toBe("gameRegion");
    expect(s.gameServerEntries).toBeUndefined();
  });

  it("Back from the server picker skips the region picker when the region step was skipped", async () => {
    const cat = await freeFireOneRegion();
    await createCategory(prisma, { name: "Free Fire Sibling", group: CategoryGroup.GAME_TOPUP });
    const entry = customerCtx({ callbackData: `v1:browse:cat:${cat.id}` });
    await routeCallback(entry.ctx);
    const all = buttons(entry.sink);
    expect(all[all.length - 1]!.callback_data).toBe(`v1:browse:grp:${CategoryGroup.GAME_TOPUP}`);
  });

  it("a region with no servers skips the server level and filters exactly like today", async () => {
    const cat = await freeFire();
    const entry = customerCtx({ callbackData: `v1:browse:cat:${cat.id}` });
    await routeCallback(entry.ctx);
    const tap = tapCtx(entry.ctx, { callbackData: `v1:browse:greg:${cat.id}:${regionIdx(entry.sink, cat.id, "Global")}` });
    await routeCallback(tap.ctx);
    expect(sentIncludes(tap.sink, "FF Delta")).toBe(true); // single product collapses
    expect(sentIncludes(tap.sink, t(tap.ctx, "browse.choose_server"))).toBe(false);
    const s = tap.ctx.session.scratch as Scratch;
    expect(s.gameServerDimensionSkipped).toBe(true);
    expect(s.resolvedGameServer ?? null).toBeNull();
  });

  it("a region with exactly one server uses it without a picker", async () => {
    const cat = await createCategory(prisma, { name: "Single Server Game", group: CategoryGroup.GAME_TOPUP });
    await product(cat.id, "SS One", { gameRegion: "Asia", gameServer: "Only" });
    await product(cat.id, "SS Two", { gameRegion: "Asia", gameServer: "Only" });
    const { ctx, sink } = customerCtx({ callbackData: `v1:browse:cat:${cat.id}` });
    await routeCallback(ctx);
    expect(sentIncludes(sink, t(ctx, "browse.choose_server"))).toBe(false);
    expect(sentIncludes(sink, "SS One")).toBe(true);
    expect(sentIncludes(sink, "SS Two")).toBe(true);
    const s = ctx.session.scratch as Scratch;
    expect(s.resolvedGameServer).toBe("Only");
    expect(s.gameServerDimensionSkipped).toBe(true);
  });

  it("a mixed scope (some products without a server) skips the level and hides nothing", async () => {
    const cat = await createCategory(prisma, { name: "Mixed Server Game", group: CategoryGroup.GAME_TOPUP });
    await product(cat.id, "MX Served A", { gameRegion: "Asia", gameServer: "S1" });
    await product(cat.id, "MX Served B", { gameRegion: "Asia", gameServer: "S2" });
    await product(cat.id, "MX Plain", { gameRegion: "Asia" });
    const { ctx, sink } = customerCtx({ callbackData: `v1:browse:cat:${cat.id}` });
    await routeCallback(ctx);
    expect(sentIncludes(sink, t(ctx, "browse.choose_server"))).toBe(false);
    for (const name of ["MX Served A", "MX Served B", "MX Plain"]) expect(sentIncludes(sink, name)).toBe(true);
    const s = ctx.session.scratch as Scratch;
    expect(s.gameServerDimensionSkipped).toBe(true);
    expect(s.resolvedGameServer ?? null).toBeNull();
  });

  it("a region-only game (ML) and a dimension-less game (Delta Force) never show a server picker", async () => {
    const ml = await createCategory(prisma, { name: "Mobile Legends", group: CategoryGroup.GAME_TOPUP });
    await product(ml.id, "ML Indo", { gameRegion: "Indonesia" });
    await product(ml.id, "ML Malay", { gameRegion: "Malaysia" });
    const mlEntry = customerCtx({ callbackData: `v1:browse:cat:${ml.id}` });
    await routeCallback(mlEntry.ctx);
    expect(sentIncludes(mlEntry.sink, t(mlEntry.ctx, "browse.choose_region"))).toBe(true);
    const mlTap = tapCtx(mlEntry.ctx, { callbackData: `v1:browse:greg:${ml.id}:0` });
    await routeCallback(mlTap.ctx);
    expect(sentIncludes(mlTap.sink, t(mlTap.ctx, "browse.choose_server"))).toBe(false);
    expect(sentIncludes(mlTap.sink, "ML Indo")).toBe(true);

    const df = await createCategory(prisma, { name: "Delta Force", group: CategoryGroup.GAME_TOPUP });
    await product(df.id, "DF Coins");
    await product(df.id, "DF Keys");
    const dfEntry = customerCtx({ callbackData: `v1:browse:cat:${df.id}` });
    await routeCallback(dfEntry.ctx);
    expect(sentIncludes(dfEntry.sink, "DF Coins")).toBe(true);
    expect(sentIncludes(dfEntry.sink, "DF Keys")).toBe(true);
    expect(buttons(dfEntry.sink).some((b) => b.callback_data?.includes(":gsrv:"))).toBe(false);
  });

  it("a Premium Apps category never shows game server controls even when its products carry a server", async () => {
    const cat = await createCategory(prisma, { name: "Streaming Apps", group: CategoryGroup.PREMIUM_APPS });
    await product(cat.id, "App One", { gameServer: "Server 1" });
    await product(cat.id, "App Two", { gameServer: "Server 2" });
    const { ctx, sink } = customerCtx({ callbackData: `v1:browse:cat:${cat.id}` });
    await routeCallback(ctx);
    expect(sentIncludes(sink, "App One")).toBe(true);
    expect(sentIncludes(sink, "App Two")).toBe(true);
    expect(sentIncludes(sink, t(ctx, "browse.choose_server"))).toBe(false);
    expect(sentIncludes(sink, ":gsrv:")).toBe(false);
    const s = ctx.session.scratch as Scratch;
    expect(s.gameServerEntries).toBeUndefined();
    expect(s.resolvedGameServer).toBeUndefined();
    expect(s.gameServerDimensionSkipped).toBeUndefined();
  });

  it("server scratch is cleared when browsing leaves the game flow", async () => {
    const cat = await freeFireOneRegion();
    const entry = customerCtx({ callbackData: `v1:browse:cat:${cat.id}` });
    await routeCallback(entry.ctx);
    expect((entry.ctx.session.scratch as Scratch).gameServerEntries).toHaveLength(2);

    const groups = tapCtx(entry.ctx, { callbackData: "v1:browse:grps" });
    await routeCallback(groups.ctx);
    let s = groups.ctx.session.scratch as Scratch;
    expect(s.gameServerEntries).toBeUndefined();
    expect(s.resolvedGameServer).toBeUndefined();
    expect(s.gameServerDimensionSkipped).toBeUndefined();

    // Leaving through a non-game category must clear a resolved server too.
    (groups.ctx.session.scratch as Record<string, unknown>).resolvedGameServer = "Server 2";
    (groups.ctx.session.scratch as Record<string, unknown>).gameServerEntries = ["x"];
    (groups.ctx.session.scratch as Record<string, unknown>).gameServerDimensionSkipped = true;
    const app = await createCategory(prisma, { name: "Apps", group: CategoryGroup.PREMIUM_APPS });
    await product(app.id, "Some App");
    const appTap = tapCtx(groups.ctx, { callbackData: `v1:browse:cat:${app.id}` });
    await routeCallback(appTap.ctx);
    s = appTap.ctx.session.scratch as Scratch;
    expect(s.gameServerEntries).toBeUndefined();
    expect(s.resolvedGameServer).toBeUndefined();
    expect(s.gameServerDimensionSkipped).toBeUndefined();
  });
});

describe("Server level, flag OFF", () => {
  it.each([["unset", null], ["false", "false"]])("(%s) the region tap lists every product in the region and never shows a server picker", async (_label, value) => {
    if (value !== null) await setSetting(prisma, FLAG, value);
    const cat = await freeFire();
    const entry = customerCtx({ callbackData: `v1:browse:cat:${cat.id}` });
    await routeCallback(entry.ctx);
    const tap = tapCtx(entry.ctx, { callbackData: `v1:browse:greg:${cat.id}:${regionIdx(entry.sink, cat.id, "Indonesia")}` });
    await routeCallback(tap.ctx);

    for (const name of ["FF Alpha", "FF Bravo", "FF Charlie"]) expect(sentIncludes(tap.sink, name)).toBe(true);
    expect(sentIncludes(tap.sink, t(tap.ctx, "browse.choose_server"))).toBe(false);
    expect(sentIncludes(tap.sink, ":gsrv:")).toBe(false);
    const s = tap.ctx.session.scratch as Scratch;
    expect(s.gameServerEntries).toBeUndefined();
    expect(s.resolvedGameServer).toBeUndefined();
    expect(s.gameServerDimensionSkipped).toBeUndefined();
    expect(s.activeNumberedScreen).toBe("products");
    // The same call budget as the pre-server flow: one companion keyboard
    // resend (the digit keyboard) plus the list itself.
    expect(calls(tap.sink, "deleteMessage")).toHaveLength(0);
  });
});

describe("gameServerPickerKb", () => {
  it("lays out two per row with index callbacks and a Back row", () => {
    const kb = gameServerPickerKb(["Server 1", "Server 2", "Server 3"], 5, "v1:browse:gregs:5", "en");
    const rows = kb.inline_keyboard as Array<Array<{ text: string; callback_data?: string }>>;
    expect(rows).toHaveLength(3);
    expect(rows[0]!.map((b) => b.callback_data)).toEqual(["v1:browse:gsrv:5:0", "v1:browse:gsrv:5:1"]);
    expect(rows[1]!.map((b) => b.callback_data)).toEqual(["v1:browse:gsrv:5:2"]);
    expect(rows[2]!.map((b) => b.callback_data)).toEqual(["v1:browse:gregs:5"]);
    expect(rows[0]![0]!.text).toBe("Server 1");
  });
});
