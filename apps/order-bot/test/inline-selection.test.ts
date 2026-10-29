// setup-db MUST be first — temp DB + push before any @app import.
import "./setup-db";

/**
 * Inline-only selection (Game Top-up, and every service whose registry entry
 * is not "numbered" — @app/core/services `usesNumberedSelection`): no numbered
 * caption, no digit reply keyboard and no "Use the numbers below" companion
 * message on ANY screen; the product list carries one inline button per
 * product plus Prev/Next and Back. Premium Apps keeps its numbered list
 * byte-for-byte (the control cases at the end).
 *
 * Message budget: every count below is exact. "reply" is ctx.reply (a fresh
 * send), so a companion message would show up there.
 */
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { prisma, createCatalogProduct, createCategory, createDenomination, setSetting, upsertUser } from "@app/db";
import { CategoryGroup } from "@app/core/enums";
import { buildSampleData, resetDb, type SampleData } from "../../../tests/helpers/sampleData";
import { makeCtx, calls, sentIncludes, lastMarkup, type SentCall } from "./helpers/ctx";
import type { MyContext, SessionData } from "../src/context";
import { routeCallback } from "../src/handlers/callbacks";
import * as customer from "../src/handlers/customer";
import { persistentLabel } from "../src/keyboards/customer";
import { t } from "../src/util/i18n";

type Button = { text: string; callback_data?: string };
type Scratch = { activeNumberedScreen?: string; browseEntries?: number[] };

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

/** A later update in the same chat: shares the previous screen's scratch and menu bubble. */
function next(prev: { session: SessionData | Partial<SessionData> }, opts: Parameters<typeof makeCtx>[0] = {}) {
  return customerCtx({ ...opts, session: { ...userSession(), scratch: prev.session.scratch as SessionData["scratch"], menuMsgId: prev.session.menuMsgId } });
}

async function product(categoryId: number, name: string, dims: { gameVariant?: string | null; gameRegion?: string | null } = {}) {
  const p = await createCatalogProduct(prisma, { categoryId, name });
  await prisma.product.update({ where: { id: p.id }, data: { gameVariant: dims.gameVariant ?? null, gameRegion: dims.gameRegion ?? null } });
  await createDenomination(prisma, { productId: p.id, name: "100", type: "SHARED", durationLabel: "100", price: "15000" });
  return p;
}

const rows = (sink: SentCall[]): Button[][] => ((lastMarkup(sink) as { inline_keyboard?: Button[][] } | undefined)?.inline_keyboard ?? []);
const buttons = (sink: SentCall[]): Button[] => rows(sink).flat();
const pickButtons = (sink: SentCall[]) => buttons(sink).filter((b) => b.callback_data?.startsWith("v1:browse:pick:"));
const hasReplyKeyboard = (sink: SentCall[]) =>
  sink.some((c) => JSON.stringify(c.args).includes("\"keyboard\":"));

/** Exact Telegram call counts of one update. */
function counts(sink: SentCall[]) {
  return {
    reply: calls(sink, "reply").length,
    sendMessage: calls(sink, "sendMessage").length,
    replyWithPhoto: calls(sink, "replyWithPhoto").length,
    editMessageText: calls(sink, "editMessageText").length,
    deleteMessage: calls(sink, "deleteMessage").length,
  };
}
const ONE_EDIT = { reply: 0, sendMessage: 0, replyWithPhoto: 0, editMessageText: 1, deleteMessage: 0 };
const ONE_SEND = { reply: 1, sendMessage: 0, replyWithPhoto: 0, editMessageText: 0, deleteMessage: 0 };

/** A recognised region shows its canonical flagged label ("Indonesia" → "🇮🇩 Indonesia"). */
function regionIdx(sink: SentCall[], catId: number, label: string): number {
  const b = buttons(sink).find((x) => (x.text === label || x.text.endsWith(` ${label}`)) && x.callback_data?.startsWith(`v1:browse:greg:${catId}:`));
  return Number(b!.callback_data!.split(":")[4]);
}

describe("Game Top-up product list: inline buttons, no numbers", () => {
  it("a category tap renders one inline button per product, the full names and From prices in the body, no numbering and no companion", async () => {
    const cat = await createCategory(prisma, { name: "Free Fire", group: CategoryGroup.GAME_TOPUP });
    const a = await product(cat.id, "FF Alpha");
    const b = await product(cat.id, "FF Bravo");
    const c = await product(cat.id, "FF Charlie");

    const tap = customerCtx({ callbackData: `v1:browse:cat:${cat.id}` });
    await routeCallback(tap.ctx);

    expect(counts(tap.sink)).toEqual(ONE_EDIT);
    expect(hasReplyKeyboard(tap.sink)).toBe(false);
    expect(sentIncludes(tap.sink, t(tap.ctx, "browse.use_numbers"))).toBe(false);
    expect(pickButtons(tap.sink)).toEqual([
      { text: "FF Alpha", callback_data: `v1:browse:pick:${a.id}` },
      { text: "FF Bravo", callback_data: `v1:browse:pick:${b.id}` },
      { text: "FF Charlie", callback_data: `v1:browse:pick:${c.id}` },
    ]);
    // One product per row.
    for (const row of rows(tap.sink)) if (row.some((x) => x.callback_data?.startsWith("v1:browse:pick:"))) expect(row).toHaveLength(1);
    const body = JSON.stringify(calls(tap.sink, "editMessageText")[0]!.args[0]);
    expect(body).not.toMatch(/\\n\d+\. /);
    expect(body).not.toContain("Enter a number");
    expect(body).toContain("FF Alpha");
    expect(body).toContain(t(tap.ctx, "browse.product_from_price", { price: "" }).trim());
    const scratch = tap.ctx.session.scratch as Scratch;
    expect(scratch.browseEntries).toBeUndefined();
    expect(scratch.activeNumberedScreen).toBeUndefined();
  });

  it("a single page still ends with its own inline Back row (the list's listBackTarget)", async () => {
    const cat = await createCategory(prisma, { name: "Free Fire", group: CategoryGroup.GAME_TOPUP });
    await product(cat.id, "FF Alpha");
    await product(cat.id, "FF Bravo");
    const tap = customerCtx({ callbackData: `v1:browse:cat:${cat.id}` });
    await routeCallback(tap.ctx);
    const last = rows(tap.sink).at(-1)!;
    expect(last).toEqual([{ text: t(tap.ctx, "menu.back"), callback_data: "v1:browse:grps" }]);
    expect(buttons(tap.sink).some((x) => x.callback_data?.startsWith("v1:browse:page:"))).toBe(false);
  });

  it("pages: ten product buttons + Next + Back, then the rest + Prev + Back, each page one edit", async () => {
    const cat = await createCategory(prisma, { name: "Free Fire", group: CategoryGroup.GAME_TOPUP });
    for (let i = 0; i < 12; i++) await product(cat.id, `FF P${String(i).padStart(2, "0")}`);
    const tap = customerCtx({ callbackData: `v1:browse:cat:${cat.id}` });
    await routeCallback(tap.ctx);
    expect(counts(tap.sink)).toEqual(ONE_EDIT);
    expect(pickButtons(tap.sink)).toHaveLength(10);
    const r0 = rows(tap.sink);
    // Page indicator (a no-op tap) between the arrows.
    expect(r0.at(-2)).toEqual([{ text: "1/2", callback_data: "v1:noop" }, { text: "›", callback_data: "v1:browse:page:1" }]);
    expect(r0.at(-1)![0]!.text).toBe(t(tap.ctx, "menu.back"));

    const page2 = next(tap.ctx, { callbackData: "v1:browse:page:1" });
    await routeCallback(page2.ctx);
    expect(counts(page2.sink)).toEqual(ONE_EDIT);
    expect(pickButtons(page2.sink).map((x) => x.text)).toEqual(["FF P10", "FF P11"]);
    const r1 = rows(page2.sink);
    expect(r1.at(-2)).toEqual([{ text: "‹", callback_data: "v1:browse:page:0" }, { text: "2/2", callback_data: "v1:noop" }]);
    expect(r1.at(-1)![0]!.text).toBe(t(page2.ctx, "menu.back"));
    expect(hasReplyKeyboard(page2.sink)).toBe(false);
  });

  it("tapping a product button opens it in the same bubble", async () => {
    const cat = await createCategory(prisma, { name: "Free Fire", group: CategoryGroup.GAME_TOPUP });
    await product(cat.id, "FF Alpha");
    const bravo = await product(cat.id, "FF Bravo");
    await createDenomination(prisma, { productId: bravo.id, name: "200", type: "SHARED", durationLabel: "200", price: "25000" });
    const tap = customerCtx({ callbackData: `v1:browse:cat:${cat.id}` });
    await routeCallback(tap.ctx);
    const open = next(tap.ctx, { callbackData: pickButtons(tap.sink).find((x) => x.text === "FF Bravo")!.callback_data! });
    await routeCallback(open.ctx);
    expect(counts(open.sink)).toEqual(ONE_EDIT);
    expect(sentIncludes(open.sink, "FF Bravo")).toBe(true);
  });

  it("the typed Products key with one service and one game sends exactly ONE message, inline", async () => {
    await setSetting(prisma, "service_premium_apps_enabled_bot", "false");
    const cat = await createCategory(prisma, { name: "Free Fire", group: CategoryGroup.GAME_TOPUP });
    await product(cat.id, "FF Alpha");
    await product(cat.id, "FF Bravo");
    const typed = customerCtx({ text: persistentLabel("browse", "en") });
    await customer.handleProductNumber(typed.ctx);
    expect(counts(typed.sink)).toEqual(ONE_SEND);
    expect(hasReplyKeyboard(typed.sink)).toBe(false);
    expect(pickButtons(typed.sink).map((x) => x.text)).toEqual(["FF Alpha", "FF Bravo"]);
    expect(rows(typed.sink).at(-1)![0]!.callback_data).toBe("v1:menu:main");
  });
});

describe("Game Top-up pickers: no companion message", () => {
  async function regional() {
    const cat = await createCategory(prisma, { name: "Mobile Legends", group: CategoryGroup.GAME_TOPUP });
    await product(cat.id, "ML Indo A", { gameRegion: "Indonesia" });
    await product(cat.id, "ML Indo B", { gameRegion: "Indonesia" });
    await product(cat.id, "ML Global A", { gameRegion: "Global" });
    await product(cat.id, "ML Global B", { gameRegion: "Global" });
    return cat;
  }

  it("the edition picker is one edit, no digit keyboard", async () => {
    const cat = await createCategory(prisma, { name: "Genshin", group: CategoryGroup.GAME_TOPUP });
    await product(cat.id, "GI Asia", { gameVariant: "Asia" });
    await product(cat.id, "GI Europe", { gameVariant: "Europe" });
    const tap = customerCtx({ callbackData: `v1:browse:cat:${cat.id}` });
    await routeCallback(tap.ctx);
    expect(sentIncludes(tap.sink, t(tap.ctx, "browse.choose_variant"))).toBe(true);
    expect(counts(tap.sink)).toEqual(ONE_EDIT);
    expect(hasReplyKeyboard(tap.sink)).toBe(false);
    // The inline tap still resolves (no numbered snapshot needed from a companion).
    const variant = buttons(tap.sink).find((x) => x.callback_data?.startsWith(`v1:browse:gvar:${cat.id}:`) && x.text.includes("Europe"))!;
    const pick = next(tap.ctx, { callbackData: variant.callback_data! });
    await routeCallback(pick.ctx);
    expect(sentIncludes(pick.sink, "GI Europe")).toBe(true);
    expect(counts(pick.sink)).toEqual(ONE_EDIT);
  });

  it("the region picker, the region list and Back to the picker: one edit each, never a send", async () => {
    const cat = await regional();
    const entry = customerCtx({ callbackData: `v1:browse:cat:${cat.id}` });
    await routeCallback(entry.ctx);
    expect(sentIncludes(entry.sink, t(entry.ctx, "browse.choose_region"))).toBe(true);
    expect(counts(entry.sink)).toEqual(ONE_EDIT);
    expect(hasReplyKeyboard(entry.sink)).toBe(false);

    const list = next(entry.ctx, { callbackData: `v1:browse:greg:${cat.id}:${regionIdx(entry.sink, cat.id, "Indonesia")}` });
    await routeCallback(list.ctx);
    expect(counts(list.sink)).toEqual(ONE_EDIT);
    expect(pickButtons(list.sink).map((x) => x.text)).toEqual(["ML Indo A", "ML Indo B"]);
    expect(rows(list.sink).at(-1)).toEqual([{ text: t(list.ctx, "menu.back"), callback_data: `v1:browse:gregs:${cat.id}` }]);

    const back = next(list.ctx, { callbackData: `v1:browse:gregs:${cat.id}` });
    await routeCallback(back.ctx);
    expect(sentIncludes(back.sink, t(back.ctx, "browse.choose_region"))).toBe(true);
    expect(counts(back.sink)).toEqual(ONE_EDIT);
  });

  it("regression: region → Back → other region → Back, repeated, never adds a message to the chat", async () => {
    const cat = await regional();
    let prev = customerCtx({ callbackData: `v1:browse:cat:${cat.id}` });
    await routeCallback(prev.ctx);
    const all: SentCall[] = [...prev.sink];
    for (const region of ["Indonesia", "Global", "Indonesia", "Global"]) {
      const pick = next(prev.ctx, { callbackData: `v1:browse:greg:${cat.id}:${regionIdx(prev.sink, cat.id, region)}` });
      await routeCallback(pick.ctx);
      const back = next(pick.ctx, { callbackData: `v1:browse:gregs:${cat.id}` });
      await routeCallback(back.ctx);
      all.push(...pick.sink, ...back.sink);
      prev = back;
    }
    expect(calls(all, "reply")).toHaveLength(0);
    expect(calls(all, "sendMessage")).toHaveLength(0);
    expect(calls(all, "replyWithPhoto")).toHaveLength(0);
    expect(calls(all, "deleteMessage")).toHaveLength(0);
    expect(calls(all, "editMessageText")).toHaveLength(9);
    expect(sentIncludes(all, t(prev.ctx, "browse.use_numbers"))).toBe(false);
  });
});

describe("a typed digit on a Game Top-up screen never navigates", () => {
  async function typeDigit(after: { ctx: { session: SessionData } }, digit = "1") {
    const typed = next(after.ctx, { text: digit });
    await customer.handleProductNumber(typed.ctx);
    return typed;
  }

  /** Edit first: the bot-owned bubble is edited in place (the same screen,
   * its buttons kept, the notice on top) and the typed digit is deleted —
   * never a fresh message. */
  const EDIT_AND_DELETE = { reply: 0, sendMessage: 0, replyWithPhoto: 0, editMessageText: 1, deleteMessage: 1 };
  function expectNoticeEditedIn(typed: { ctx: MyContext; sink: SentCall[] }, bubbleId: number | undefined) {
    expect(bubbleId).toBeDefined();
    expect(counts(typed.sink)).toEqual(EDIT_AND_DELETE);
    const edit = calls(typed.sink, "editMessageText")[0]!;
    expect(edit.args[1]).toBe(bubbleId);
    expect(String(edit.args[2]).startsWith(t(typed.ctx, "browse.use_buttons"))).toBe(true);
    expect(calls(typed.sink, "deleteMessage")[0]!.args[1]).toBe(typed.ctx.message!.message_id);
    expect(typed.ctx.session.menuMsgId).toBe(bubbleId);
  }

  it("on the product list: the list bubble is edited in place with the notice, its buttons kept, the digit deleted", async () => {
    const cat = await createCategory(prisma, { name: "Free Fire", group: CategoryGroup.GAME_TOPUP });
    await product(cat.id, "FF Alpha");
    await product(cat.id, "FF Bravo");
    const tap = customerCtx({ callbackData: `v1:browse:cat:${cat.id}` });
    await routeCallback(tap.ctx);
    const typed = await typeDigit(tap);
    expectNoticeEditedIn(typed, tap.ctx.session.menuMsgId);
    expect(sentIncludes(typed.sink, "Choose a top-up amount")).toBe(false);
    // The legacy unscoped lookup would have opened the Premium sample product.
    expect(sentIncludes(typed.sink, "Netflix")).toBe(false);
    // The same list, with the same inline buttons (Back included).
    expect(pickButtons(typed.sink).map((x) => x.text)).toEqual(["FF Alpha", "FF Bravo"]);
    expect(rows(typed.sink)).toEqual(rows(tap.sink));
    expect(hasReplyKeyboard(typed.sink)).toBe(false);
  });

  it("three digits in a row: still one bubble — three edits, three deletes, no message added", async () => {
    const cat = await createCategory(prisma, { name: "Free Fire", group: CategoryGroup.GAME_TOPUP });
    await product(cat.id, "FF Alpha");
    await product(cat.id, "FF Bravo");
    const tap = customerCtx({ callbackData: `v1:browse:cat:${cat.id}` });
    await routeCallback(tap.ctx);
    const bubble = tap.ctx.session.menuMsgId;
    let prev: { ctx: MyContext; sink: SentCall[] } = tap;
    const all: SentCall[] = [];
    for (const digit of ["1", "2", "7"]) {
      prev = await typeDigit(prev, digit);
      all.push(...prev.sink);
    }
    expect(counts(all)).toEqual({ reply: 0, sendMessage: 0, replyWithPhoto: 0, editMessageText: 3, deleteMessage: 3 });
    expect(calls(all, "editMessageText").every((c) => c.args[1] === bubble)).toBe(true);
    expect(calls(all, "editMessageReplyMarkup")).toHaveLength(0);
    expect(prev.ctx.session.menuMsgId).toBe(bubble);
    expect(pickButtons(prev.sink).map((x) => x.text)).toEqual(["FF Alpha", "FF Bravo"]);
  });

  it("with no tracked bubble: sends once and tracks it, so the next digit edits that one", async () => {
    const cat = await createCategory(prisma, { name: "Free Fire", group: CategoryGroup.GAME_TOPUP });
    await product(cat.id, "FF Alpha");
    await product(cat.id, "FF Bravo");
    const tap = customerCtx({ callbackData: `v1:browse:cat:${cat.id}` });
    await routeCallback(tap.ctx);
    delete tap.ctx.session.menuMsgId;
    const first = await typeDigit(tap);
    expect(counts(first.sink)).toEqual({ reply: 1, sendMessage: 0, replyWithPhoto: 0, editMessageText: 0, deleteMessage: 1 });
    expect(pickButtons(first.sink).map((x) => x.text)).toEqual(["FF Alpha", "FF Bravo"]);
    expect(first.ctx.session.menuMsgId).toBeDefined();
    const second = await typeDigit(first);
    expectNoticeEditedIn(second, first.ctx.session.menuMsgId);
  });

  it("on the region picker and on the edition picker: the picker is edited in place, its buttons kept", async () => {
    const reg = await createCategory(prisma, { name: "Mobile Legends", group: CategoryGroup.GAME_TOPUP });
    await product(reg.id, "ML Indo", { gameRegion: "Indonesia" });
    await product(reg.id, "ML Global", { gameRegion: "Global" });
    const regionScreen = customerCtx({ callbackData: `v1:browse:cat:${reg.id}` });
    await routeCallback(regionScreen.ctx);
    const onRegion = await typeDigit(regionScreen);
    expectNoticeEditedIn(onRegion, regionScreen.ctx.session.menuMsgId);
    expect(sentIncludes(onRegion.sink, "ML Indo")).toBe(false);
    expect(sentIncludes(onRegion.sink, t(onRegion.ctx, "browse.choose_region"))).toBe(true);
    expect(rows(onRegion.sink)).toEqual(rows(regionScreen.sink));

    const ed = await createCategory(prisma, { name: "Genshin", group: CategoryGroup.GAME_TOPUP });
    await product(ed.id, "GI Asia", { gameVariant: "Asia" });
    await product(ed.id, "GI Europe", { gameVariant: "Europe" });
    const editionScreen = customerCtx({ callbackData: `v1:browse:cat:${ed.id}` });
    await routeCallback(editionScreen.ctx);
    const onEdition = await typeDigit(editionScreen, "2");
    expectNoticeEditedIn(onEdition, editionScreen.ctx.session.menuMsgId);
    expect(sentIncludes(onEdition.sink, "GI Europe")).toBe(false);
    expect(sentIncludes(onEdition.sink, t(onEdition.ctx, "browse.choose_variant"))).toBe(true);
    expect(rows(onEdition.sink)).toEqual(rows(editionScreen.sink));
  });

  it("on the pack picker: the picker is edited in place, its buttons kept", async () => {
    const cat = await createCategory(prisma, { name: "Free Fire", group: CategoryGroup.GAME_TOPUP });
    await product(cat.id, "FF Alpha");
    const bravo = await product(cat.id, "FF Bravo");
    await createDenomination(prisma, { productId: bravo.id, name: "200", type: "SHARED", durationLabel: "200", price: "25000" });
    const list = customerCtx({ callbackData: `v1:browse:cat:${cat.id}` });
    await routeCallback(list.ctx);
    const open = next(list.ctx, { callbackData: `v1:browse:pick:${bravo.id}` });
    await routeCallback(open.ctx);
    const typed = await typeDigit(open);
    expectNoticeEditedIn(typed, open.ctx.session.menuMsgId);
    expect(rows(typed.sink)).toEqual(rows(open.sink));
  });

  it("a stale numbered snapshot from an earlier Premium visit is never used on a Game screen", async () => {
    const cat = await createCategory(prisma, { name: "Free Fire", group: CategoryGroup.GAME_TOPUP });
    await product(cat.id, "FF Alpha");
    await product(cat.id, "FF Bravo");
    const tap = customerCtx({ callbackData: `v1:browse:cat:${cat.id}` });
    await routeCallback(tap.ctx);
    (tap.ctx.session.scratch as Scratch).browseEntries = [sample.product.productId];
    const typed = await typeDigit(tap);
    expect(sentIncludes(typed.sink, "Netflix")).toBe(false);
    expectNoticeEditedIn(typed, tap.ctx.session.menuMsgId);
  });

  it("off the catalog (Home after a Game visit): no 'use the buttons' notice — the digit takes the non-catalog path it always took", async () => {
    const cat = await createCategory(prisma, { name: "Free Fire", group: CategoryGroup.GAME_TOPUP });
    await product(cat.id, "FF Alpha");
    const tap = customerCtx({ callbackData: `v1:browse:cat:${cat.id}` });
    await routeCallback(tap.ctx);
    const home = next(tap.ctx, { text: persistentLabel("main", "en") });
    await customer.handleProductNumber(home.ctx);
    expect((home.ctx.session.scratch as { catalogScreen?: boolean }).catalogScreen).toBeFalsy();
    const typed = await typeDigit(home);
    expect(sentIncludes(typed.sink, t(typed.ctx, "browse.use_buttons"))).toBe(false);
    // Not the catalog's edit-in-place answer either (that one deletes the digit).
    expect(calls(typed.sink, "deleteMessage")).toHaveLength(0);
  });
});

describe("Premium Apps keeps the numbered list (control)", () => {
  it("callback entry: one numbered companion + the numbered list edit with its inline Back; a digit opens the product", async () => {
    const cat = await createCategory(prisma, { name: "Streaming Apps", group: CategoryGroup.PREMIUM_APPS });
    await product(cat.id, "App One");
    await product(cat.id, "App Two");
    const tap = customerCtx({ callbackData: `v1:browse:cat:${cat.id}` });
    await routeCallback(tap.ctx);
    expect(counts(tap.sink)).toEqual({ reply: 1, sendMessage: 0, replyWithPhoto: 0, editMessageText: 1, deleteMessage: 0 });
    const companion = calls(tap.sink, "reply")[0]!;
    expect(companion.args[0]).toBe(t(tap.ctx, "browse.use_numbers"));
    const kb = (companion.args[1] as { reply_markup: { keyboard: Button[][] } }).reply_markup.keyboard;
    expect(kb.flat().map((x) => x.text)).toEqual(["1", "2", persistentLabel("back", "en"), persistentLabel("main", "en")]);
    const listCall = calls(tap.sink, "editMessageText")[0]!;
    expect(listCall.args[0]).toBe(t(tap.ctx, "browse.list_decorated", { page: 1, total: 1, items: "1. App One\n2. App Two" }));
    expect(pickButtons(tap.sink)).toHaveLength(0);
    expect(rows(tap.sink)).toEqual([[{ text: t(tap.ctx, "menu.back"), callback_data: "v1:browse:grps" }]]);
    expect((tap.ctx.session.scratch as Scratch).activeNumberedScreen).toBe("products");

    const typed = next(tap.ctx, { text: "2" });
    await customer.handleProductNumber(typed.ctx);
    expect(sentIncludes(typed.sink, "App Two")).toBe(true);
    expect(sentIncludes(typed.sink, t(typed.ctx, "browse.use_buttons"))).toBe(false);
  });

  it("typed entry: unchanged — the companion and the numbered list, both carrying the digit reply keyboard", async () => {
    const cat = await createCategory(prisma, { name: "Streaming Apps", group: CategoryGroup.PREMIUM_APPS });
    await product(cat.id, "App One");
    const typed = customerCtx({ text: persistentLabel("browse", "en") });
    await setSetting(prisma, "service_game_topup_enabled_bot", "false");
    await customer.handleProductNumber(typed.ctx);
    expect(counts(typed.sink)).toEqual({ reply: 2, sendMessage: 0, replyWithPhoto: 0, editMessageText: 0, deleteMessage: 0 });
    const [companion, list] = calls(typed.sink, "reply");
    expect(companion!.args[0]).toBe(t(typed.ctx, "browse.use_numbers"));
    const digits = ["1", "2", persistentLabel("back", "en"), persistentLabel("main", "en")];
    for (const call of [companion!, list!]) {
      const kb = (call.args[1] as { reply_markup: { keyboard: Button[][] } }).reply_markup.keyboard;
      expect(kb.flat().map((x) => x.text)).toEqual(digits);
    }
    expect(String(list!.args[0])).toMatch(/\n1\. .*\n2\. /);
  });
});
