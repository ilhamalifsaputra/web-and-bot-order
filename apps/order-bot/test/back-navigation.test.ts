// setup-db MUST be first — temp DB + push before any @app import.
import "./setup-db";

import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

// A QR payment screen without a real gateway call (typed Back on the QR wait).
vi.mock("@app/core/payments/tokopay", async (orig) => ({
  ...(await orig<typeof import("@app/core/payments/tokopay")>()),
  createTransaction: vi.fn().mockResolvedValue({ trxId: "TP-BACK", payUrl: null, qrLink: "https://x/qr.png", qrString: "000", totalBayar: "100" }),
}));

import { prisma, adjustWallet, createCatalogProduct, createCategory, createDenomination, createOrderDirect, createTicket, setSetting, upsertUser } from "@app/db";
import { t as coreT } from "@app/core/i18n";
import { CategoryGroup, OrderStatus } from "@app/core/enums";
import { buildSampleData, resetDb, type SampleData } from "../../../tests/helpers/sampleData";
import { makeCtx, calls, sentIncludes, lastMarkup, FakeConversation, type FakeCtx, type SentCall } from "./helpers/ctx";
import { primeQuote, quoteNonce } from "./helpers/quote";
import * as checkout from "../src/handlers/checkout";
import { voucherConversation } from "../src/conversations/checkout";
import type { SessionData } from "../src/context";
import { routeCallback } from "../src/handlers/callbacks";
import * as customer from "../src/handlers/customer";
import { backRow, backToMain, editInfoCancelKb, notificationKb, paymentSuccessKb, persistentLabel, proofCancelKb, qrisWaitingKb, qtyInputCancelKb, ticketClosedKb, ticketDuplicateKb, topupAmountCancelKb, voucherCancelKb } from "../src/keyboards/customer";
import { settledPaymentKb } from "../src/util/delivery";
import { t } from "../src/util/i18n";

// Back navigation is computed from state (which screens were really shown),
// never guessed: auto-skipped screens are stepped over, a lone service never
// bounces back into itself, and a Back render edits the bubble the customer is
// looking at instead of stacking new messages.

type Button = { text: string; callback_data?: string };
type Markup = { inline_keyboard?: Button[][]; keyboard?: Array<Array<{ text: string }>> };

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
  // Failed edits are recorded too, so a count never hides a wasted call.
  return makeCtx({ from: { id: 42, username: "tester" }, session: userSession(), recordFailedCalls: true, ...opts });
}

/** A later update in the same chat: shares the previous screen's session (scratch + menuMsgId). */
function next(prev: { session: SessionData }, opts: Parameters<typeof makeCtx>[0] = {}) {
  return customerCtx({ ...opts, sharedSession: prev.session });
}

/** The reply-keyboard "← Back" typed/tapped on the bottom keyboard. */
async function typedBack(prev: { session: SessionData }) {
  const back = next(prev, { text: persistentLabel("back", "en") });
  await customer.handleProductNumber(back.ctx);
  return back;
}

const inlineButtons = (sink: SentCall[]): Button[] => ((lastMarkup(sink) as Markup | undefined)?.inline_keyboard ?? []).flat();
const replyLabels = (sink: SentCall[]): string[] => ((lastMarkup(sink) as Markup | undefined)?.keyboard ?? []).flat().map((b) => b.text);
const isHome = (sink: SentCall[]) => replyLabels(sink).includes(persistentLabel("browse", "en"));
/** Labels of the last reply (bottom) keyboard sent, wherever it rode. */
function bottomKeyboard(sink: SentCall[]): string[] {
  for (const c of [...sink].reverse()) {
    const kb = (c.args.at(-1) as { reply_markup?: Markup } | undefined)?.reply_markup?.keyboard;
    if (kb) return kb.flat().map((b) => b.text);
  }
  return [];
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

describe("lone service: Back never bounces into the auto-skipped service picker", () => {
  it("Premium Apps as the only service: Back from its flat list goes to the main menu, not the same list", async () => {
    await setSetting(prisma, "service_game_topup_enabled_bot", "false");
    const entry = customerCtx({ callbackData: "v1:browse:grps" });
    await routeCallback(entry.ctx);
    expect(sentIncludes(entry.sink, sample.parentProduct.name)).toBe(true); // straight to the Premium list

    const back = await typedBack(entry.ctx);
    expect(isHome(back.sink)).toBe(true);
    expect(sentIncludes(back.sink, sample.parentProduct.name)).toBe(false);
    expect(sentIncludes(back.sink, "What are you shopping for")).toBe(false);
  });

  it("Premium Apps as the only service: the empty-list Back targets the main menu", async () => {
    await setSetting(prisma, "service_game_topup_enabled_bot", "false");
    await prisma.category.updateMany({ data: { isActive: false } });
    await setSetting(prisma, "service_game_topup_enabled_bot", "false");
    const { ctx, sink } = customerCtx({ callbackData: "v1:browse:grps" });
    await routeCallback(ctx);
    expect(sentIncludes(sink, "No products available at the moment")).toBe(true);
    const data = inlineButtons(sink).map((b) => b.callback_data);
    expect(data).toContain("v1:menu:main");
    expect(data).not.toContain("v1:browse:grps");
  });

  it("Game Top-up as the only service: the category picker's Back targets the main menu", async () => {
    await setSetting(prisma, "service_premium_apps_enabled_bot", "false");
    await createCategory(prisma, { name: "Mobile Legends", group: CategoryGroup.GAME_TOPUP });
    await createCategory(prisma, { name: "Wild Rift", group: CategoryGroup.GAME_TOPUP });
    const { ctx, sink } = customerCtx({ callbackData: "v1:browse:grps" });
    await routeCallback(ctx);
    expect(sentIncludes(sink, "Wild Rift")).toBe(true);
    // The parent is the main menu itself, so one Back replaces a duplicate Menu button.
    const lastRow = ((lastMarkup(sink) as Markup).inline_keyboard ?? []).at(-1)!;
    expect(lastRow).toEqual([{ text: persistentLabel("back", "en"), callback_data: "v1:menu:main" }]);
  });

  it("Game Top-up as the only service with one game: Back from the list goes to the main menu (both pickers were skipped)", async () => {
    await setSetting(prisma, "service_premium_apps_enabled_bot", "false");
    const cat = await createCategory(prisma, { name: "Mobile Legends", group: CategoryGroup.GAME_TOPUP });
    await product(cat.id, "ML Alpha");
    await product(cat.id, "ML Bravo");
    const entry = customerCtx({ callbackData: "v1:browse:grps" });
    await routeCallback(entry.ctx);
    expect(sentIncludes(entry.sink, "ML Bravo")).toBe(true);

    const back = await typedBack(entry.ctx);
    expect(isHome(back.sink)).toBe(true);
    expect(sentIncludes(back.sink, "ML Bravo")).toBe(false);
  });

  it("both services enabled: the category picker's Back still targets the service picker", async () => {
    await createCategory(prisma, { name: "Mobile Legends", group: CategoryGroup.GAME_TOPUP });
    await createCategory(prisma, { name: "Wild Rift", group: CategoryGroup.GAME_TOPUP });
    const { ctx, sink } = customerCtx({ callbackData: `v1:browse:grp:${CategoryGroup.GAME_TOPUP}` });
    await routeCallback(ctx);
    const lastRow = ((lastMarkup(sink) as Markup).inline_keyboard ?? []).at(-1)!;
    expect(lastRow.map((b) => b.callback_data)).toEqual(["v1:browse:grps", "v1:menu:main"]);
  });
});

/** Callback data of the inline button labelled `label` on the last screen. */
function tapTarget(sink: SentCall[], label: string): string {
  const b = inlineButtons(sink).find((x) => x.text === label);
  if (!b?.callback_data) throw new Error(`no button "${label}" on the last screen`);
  return b.callback_data;
}

/** Tap `data` on the bubble the session currently shows (its menuMsgId). */
async function tap(prev: { session: SessionData }, data: string, opts: Parameters<typeof makeCtx>[0] = {}) {
  const msgId = prev.session.menuMsgId;
  const c = next(prev, { callbackData: data, cbMessage: { message_id: msgId, chat: { id: 42, type: "private" }, date: 0 }, ...opts });
  await routeCallback(c.ctx);
  return c;
}

const counts = (sink: SentCall[]) => ({
  sendMessage: calls(sink, "sendMessage").length,
  reply: calls(sink, "reply").length,
  editMessageText: calls(sink, "editMessageText").length,
  editMessageCaption: calls(sink, "editMessageCaption").length,
  deleteMessage: calls(sink, "deleteMessage").length,
  sendDocument: calls(sink, "sendDocument").length,
  failedEdit: sink.filter((c) => c.method.startsWith("failed:")).length,
});
const NOTHING = { sendMessage: 0, reply: 0, editMessageText: 0, editMessageCaption: 0, deleteMessage: 0, sendDocument: 0, failedEdit: 0 };
const ONE_EDIT = { ...NOTHING, editMessageText: 1 };
const ONE_SEND = { ...NOTHING, reply: 1 };
/** A typed Back: the bot-owned bubble is edited and the typed "← Back" deleted. */
const TYPED_BACK = { ...NOTHING, editMessageText: 1, deleteMessage: 1 };
/** A typed Back that lands on Home: Home carries the menu reply keyboard, so one send; the typed text is deleted. */
const TYPED_BACK_HOME = { ...NOTHING, reply: 1, deleteMessage: 1 };

type Scratch = { activeNumberedScreen?: string; gameRegionEntries?: string[]; browseEntries?: number[] };
const scratchOf = (c: { ctx: { session: { scratch: unknown } } }) => c.ctx.session.scratch as Scratch;

const sees = {
  variantPicker: (c: FakeCtx) => sentIncludes(c.sink, t(c.ctx, "browse.choose_variant")),
  regionPicker: (c: FakeCtx) => sentIncludes(c.sink, t(c.ctx, "browse.choose_region")),
};

/**
 * Genshin (+ a sibling game so the category picker is really shown):
 * Standard edition in Asia (2 products) and Europe (1), Deluxe edition with
 * no regions (2 products).
 */
async function genshin(asiaCount = 2) {
  const cat = await createCategory(prisma, { name: "Genshin Impact", group: CategoryGroup.GAME_TOPUP });
  await createCategory(prisma, { name: "Honkai Star Rail", group: CategoryGroup.GAME_TOPUP });
  for (let i = 0; i < asiaCount; i++) await product(cat.id, `GI Asia ${String(i).padStart(2, "0")}`, { gameVariant: "Standard", gameRegion: "Asia" });
  await product(cat.id, "GI Europe", { gameVariant: "Standard", gameRegion: "Europe" });
  await product(cat.id, "GI Deluxe 1", { gameVariant: "Deluxe" });
  await product(cat.id, "GI Deluxe 2", { gameVariant: "Deluxe" });
  return cat;
}

/** Category tap → Standard edition → Asia region → the Asia product list. */
async function openAsiaList(cat: { id: number }) {
  const entry = customerCtx({ callbackData: `v1:browse:cat:${cat.id}` });
  await routeCallback(entry.ctx);
  const edition = await tap(entry.ctx, tapTarget(entry.sink, "Standard"));
  const list = await tap(edition.ctx, tapTarget(edition.sink, "Asia"));
  expect(sentIncludes(list.sink, "GI Asia 00")).toBe(true);
  return list;
}

/** A Game Top-up product with two packs (so it opens a pack picker, not a detail). */
async function twoPackGame(categoryId: number, name: string) {
  const p = await createCatalogProduct(prisma, { categoryId, name });
  await createDenomination(prisma, { productId: p.id, name: "100", type: "SHARED", durationLabel: "100", price: "15000" });
  await createDenomination(prisma, { productId: p.id, name: "200", type: "SHARED", durationLabel: "200", price: "29000" });
  return p;
}

/** A search result's `browse:pick` callback, found by the product name its label starts with. */
const resultTarget = (sink: SentCall[], name: string) =>
  inlineButtons(sink).find((b) => b.text.startsWith(`${name} · `) && b.callback_data?.startsWith("v1:browse:pick:"))!.callback_data!;

const backData = (sink: SentCall[]) => inlineButtons(sink).find((b) => b.text === persistentLabel("back", "en"))?.callback_data;

async function search(query: string) {
  const s = customerCtx({ match: query });
  await customer.searchCommand(s.ctx);
  return s;
}

describe("Back from a product opened from search or Popular returns there, not to stale browse state", () => {
  it("search → pack picker: Back targets the results page it came from and re-renders it in place", async () => {
    const games = await createCategory(prisma, { name: "Games", group: CategoryGroup.GAME_TOPUP });
    const other = await createCategory(prisma, { name: "Other Games", group: CategoryGroup.GAME_TOPUP });
    for (let i = 0; i < 11; i++) await twoPackGame(games.id, `Zqx Hero ${String(i).padStart(2, "0")}`);
    const results = await search("Zqx");
    // Stale browse scope from an earlier session must not leak into the Back.
    Object.assign(results.ctx.session.scratch, { categoryId: other.id, group: CategoryGroup.GAME_TOPUP, page: 3 });
    const page2 = await tap(results.ctx, "v1:search:page:1");
    const picker = await tap(page2.ctx, resultTarget(page2.sink, "Zqx Hero 10"));
    expect(backData(picker.sink)).toBe("v1:search:page:1");

    const back = await tap(picker.ctx, "v1:search:page:1");
    expect(sentIncludes(back.sink, "Zqx Hero 10")).toBe(true);
    expect(counts(back.sink)).toEqual(ONE_EDIT);
  });

  it("search → single-pack detail: Back targets the search results; a typed Back goes there too", async () => {
    const games = await createCategory(prisma, { name: "Games", group: CategoryGroup.GAME_TOPUP });
    await product(games.id, "Zqx Solo");
    const results = await search("Zqx");
    const detail = await tap(results.ctx, resultTarget(results.sink, "Zqx Solo"));
    expect(backData(detail.sink)).toBe("v1:search:page:0");

    const typed = await typedBack(detail.ctx);
    expect(sentIncludes(typed.sink, t(typed.ctx, "search.again_btn"))).toBe(true);
    expect(sentIncludes(typed.sink, "What are you shopping for")).toBe(false);
  });

  it("an outdated search snapshot falls back to the main menu instead of a stale results page", async () => {
    const games = await createCategory(prisma, { name: "Games", group: CategoryGroup.GAME_TOPUP });
    const hero = await twoPackGame(games.id, "Zqx Hero");
    const results = await search("Zqx");
    Object.assign(results.ctx.session.scratch, { browseOrigin: { kind: "search", page: 4 } });
    const picker = next(results.ctx);
    await customer.browseProduct(picker.ctx, hero.id);
    expect(backData(picker.sink)).toBe("v1:menu:main");
  });

  it("Popular → detail and Popular → pack picker: Back targets Popular", async () => {
    await prisma.$transaction((tx) =>
      createOrderDirect(tx, { channel: "bot", user: { id: sample.user.id, role: sample.user.role }, productId: sample.product.id, quantity: 1 }),
    );
    await prisma.order.updateMany({ data: { status: OrderStatus.DELIVERED } });
    const popular = customerCtx({ callbackData: "v1:browse:popular" });
    await routeCallback(popular.ctx);
    const detail = await tap(popular.ctx, `v1:browse:pick:${sample.parentProduct.id}`);
    expect(backData(detail.sink)).toBe("v1:browse:popular");

    await createDenomination(prisma, { productId: sample.parentProduct.id, name: "Netflix 3 Month", type: "SHARED", durationLabel: "3 Month", price: "90000" });
    const picker = await tap(detail.ctx, `v1:browse:pick:${sample.parentProduct.id}`);
    expect(backData(picker.sink)).toBe("v1:browse:popular");
    const back = await tap(picker.ctx, "v1:browse:popular");
    expect(sentIncludes(back.sink, sample.parentProduct.name)).toBe(true);
    expect(counts(back.sink)).toEqual(ONE_EDIT);
  });

  it("the origin is forgotten once the customer browses the catalog: a product opened from the list goes back to the list", async () => {
    const games = await createCategory(prisma, { name: "Games", group: CategoryGroup.GAME_TOPUP });
    await twoPackGame(games.id, "Zqx Hero A");
    await twoPackGame(games.id, "Zqx Hero B");
    const results = await search("Zqx");
    const list = await tap(results.ctx, `v1:browse:cat:${games.id}`);
    // Opened by tapping its inline list button (a Game list has no numbers).
    const picker = await tap(list.ctx, tapTarget(list.sink, "Zqx Hero A"));
    expect(sentIncludes(picker.sink, t(picker.ctx, "browse.use_buttons"))).toBe(false);
    expect(backData(picker.sink)).toBe("v1:browse:prods");
  });

  it("the origin is forgotten at the main menu too", async () => {
    const games = await createCategory(prisma, { name: "Games", group: CategoryGroup.GAME_TOPUP });
    const hero = await twoPackGame(games.id, "Zqx Hero");
    const results = await search("Zqx");
    const home = await tap(results.ctx, "v1:menu:main");
    const picker = next(home.ctx);
    await customer.browseProduct(picker.ctx, hero.id);
    expect(backData(picker.sink)).toBe("v1:browse:prods");
  });
});

describe("product list Back follows the pickers that were really shown", () => {
  it("edition → region → list: Back returns one step at a time to the region picker, edition picker, category picker, service picker and menu", async () => {
    const cat = await genshin();
    const list = await openAsiaList(cat);
    // A Game list is inline-only: no bottom keyboard rides with it. The typed
    // "← Back" below is the key of a numbered keyboard left by an earlier
    // Premium visit, which still navigates the catalog.
    expect(bottomKeyboard(list.sink)).toEqual([]);

    const toRegion = await typedBack(list.ctx);
    expect(sees.regionPicker(toRegion)).toBe(true);
    expect(inlineButtons(toRegion.sink).filter((b) => b.callback_data?.startsWith(`v1:browse:greg:${cat.id}:`))).toHaveLength(2);
    expect(scratchOf(toRegion).activeNumberedScreen).toBe("gameRegion");
    // A typed Back edits the bot's own bubble (the list) and deletes the typed
    // text: no new bubble, no companion keyboard message, nothing left behind.
    const bubble = list.ctx.session.menuMsgId;
    const pinTyped = (c: FakeCtx) => {
      expect(counts(c.sink)).toEqual(TYPED_BACK);
      expect(calls(c.sink, "editMessageText")[0]!.args[1]).toBe(bubble);
      expect(calls(c.sink, "deleteMessage")[0]!.args[1]).toBe(c.ctx.message!.message_id);
      expect(c.ctx.session.menuMsgId).toBe(bubble);
    };
    pinTyped(toRegion);

    const toEdition = await typedBack(toRegion.ctx);
    expect(sees.variantPicker(toEdition)).toBe(true);
    pinTyped(toEdition);

    const toCategories = await typedBack(toEdition.ctx);
    expect(sentIncludes(toCategories.sink, "Honkai Star Rail")).toBe(true);
    pinTyped(toCategories);

    const toServices = await typedBack(toCategories.ctx);
    expect(sentIncludes(toServices.sink, "What are you shopping for")).toBe(true);
    pinTyped(toServices);

    const toMenu = await typedBack(toServices.ctx);
    expect(isHome(toMenu.sink)).toBe(true);
    expect(counts(toMenu.sink)).toEqual(TYPED_BACK_HOME);
  });

  it("a typed Back with no tracked bubble sends once, tracks it, and every later typed Back edits that bubble", async () => {
    const cat = await genshin();
    const list = await openAsiaList(cat);
    list.ctx.session.menuMsgId = undefined;
    const toRegion = await typedBack(list.ctx);
    expect(sees.regionPicker(toRegion)).toBe(true);
    expect(counts(toRegion.sink)).toEqual({ ...NOTHING, reply: 1, deleteMessage: 1 });
    const tracked = toRegion.ctx.session.menuMsgId;
    expect(tracked).toBeDefined();
    const toEdition = await typedBack(toRegion.ctx);
    expect(counts(toEdition.sink)).toEqual(TYPED_BACK);
    expect(calls(toEdition.sink, "editMessageText")[0]!.args[1]).toBe(tracked);
  });

  it("a typed Back from a product photo to a text picker replaces the photo once instead of captioning it", async () => {
    const cat = await genshin();
    const entry = customerCtx({ callbackData: `v1:browse:cat:${cat.id}` });
    await routeCallback(entry.ctx);
    const edition = await tap(entry.ctx, tapTarget(entry.sink, "Standard"));
    const detail = await tap(edition.ctx, tapTarget(edition.sink, "Europe"));
    const photoId = detail.ctx.session.menuMsgId!;
    const back = next(detail.ctx, { text: BACK, photoMessageIds: [photoId] });
    await customer.handleProductNumber(back.ctx);
    expect(sees.regionPicker(back)).toBe(true);
    // One failed text edit (the bot cannot know the anchor is a photo), the photo
    // and the typed text deleted, one picker sent: the chat holds one bubble.
    expect(counts(back.sink)).toEqual({ ...NOTHING, reply: 1, deleteMessage: 2, failedEdit: 1 });
    expect(calls(back.sink, "editMessageCaption")).toHaveLength(0);
    expect(calls(back.sink, "deleteMessage").map((c) => c.args[1])).toEqual([photoId, back.ctx.message!.message_id]);
  });

  it("a single-page list reached by a tap carries its own inline Back; tapping it edits the region picker in place with no companion keyboard", async () => {
    const cat = await genshin();
    const list = await openAsiaList(cat);
    // One button per product, then the Back row.
    expect(rowsOf(list.sink).map((row) => row.map(([text]) => text))).toEqual([["GI Asia 00"], ["GI Asia 01"], [BACK]]);
    expect(rowsOf(list.sink).at(-1)).toEqual([[BACK, `v1:browse:gregs:${cat.id}`]]);
    const back = await tap(list.ctx, `v1:browse:gregs:${cat.id}`);
    expect(sees.regionPicker(back)).toBe(true);
    expect(counts(back.sink)).toEqual(ONE_EDIT);
  });

  it("Back from a 2-product list to a 5-region picker never sends a companion 'use the numbers' message, tapped or typed", async () => {
    const cat = await createCategory(prisma, { name: "Genshin Impact", group: CategoryGroup.GAME_TOPUP });
    await createCategory(prisma, { name: "Honkai Star Rail", group: CategoryGroup.GAME_TOPUP });
    await product(cat.id, "GI Asia 1", { gameRegion: "Asia" });
    await product(cat.id, "GI Asia 2", { gameRegion: "Asia" });
    for (const region of ["Europe", "America", "TW HK MO", "SEA"]) await product(cat.id, `GI ${region}`, { gameRegion: region });
    const entry = customerCtx({ callbackData: `v1:browse:cat:${cat.id}` });
    await routeCallback(entry.ctx);
    // Inline-only: neither the picker nor the list sends a digit keyboard.
    expect(bottomKeyboard(entry.sink)).toEqual([]);
    expect(counts(entry.sink)).toEqual(ONE_EDIT);
    const list = await tap(entry.ctx, tapTarget(entry.sink, "Asia"));
    expect(bottomKeyboard(list.sink)).toEqual([]);
    expect(counts(list.sink)).toEqual(ONE_EDIT);

    const tapped = await tap(list.ctx, `v1:browse:gregs:${cat.id}`);
    expect(sees.regionPicker(tapped)).toBe(true);
    expect(inlineButtons(tapped.sink).filter((b) => b.callback_data?.startsWith(`v1:browse:greg:${cat.id}:`))).toHaveLength(5);
    expect(sentIncludes(tapped.sink, t(tapped.ctx, "browse.use_numbers"))).toBe(false);
    expect(counts(tapped.sink)).toEqual(ONE_EDIT);

    const list2 = await tap(tapped.ctx, tapTarget(tapped.sink, "Asia"));
    const typed = await typedBack(list2.ctx);
    expect(sees.regionPicker(typed)).toBe(true);
    expect(sentIncludes(typed.sink, t(typed.ctx, "browse.use_numbers"))).toBe(false);
    expect(counts(typed.sink)).toEqual(TYPED_BACK);
  });

  it("a legacy (null-group) category's list goes Back to the service level, tapped and typed", async () => {
    const legacy = await createCategory(prisma, { name: "Legacy Apps" });
    await prisma.category.update({ where: { id: legacy.id }, data: { group: null } });
    await product(legacy.id, "Legacy One");
    await product(legacy.id, "Legacy Two");
    const list = customerCtx({ callbackData: `v1:browse:cat:${legacy.id}` });
    await routeCallback(list.ctx);
    expect(sentIncludes(list.sink, "Legacy Two")).toBe(true);
    expect(rowsOf(list.sink)).toEqual([[[BACK, "v1:browse:grps"]]]);

    const typed = await typedBack(list.ctx);
    expect(sentIncludes(typed.sink, "What are you shopping for")).toBe(true);
    expect(counts(typed.sink)).toEqual(TYPED_BACK);
  });

  it("the pickers send no reply keyboard; their own inline keyboard carries Back", async () => {
    const cat = await genshin();
    const entry = customerCtx({ callbackData: `v1:browse:cat:${cat.id}` });
    await routeCallback(entry.ctx);
    expect(bottomKeyboard(entry.sink)).toEqual([]);
    expect(counts(entry.sink)).toEqual(ONE_EDIT);
    expect(inlineButtons(entry.sink).at(-1)).toEqual({ text: BACK, callback_data: `v1:browse:grp:${CategoryGroup.GAME_TOPUP}` });
  });

  it("a multi-page list's inline Back re-renders the region picker by editing the same bubble; a double tap and a deleted bubble add nothing extra", async () => {
    const cat = await genshin(11);
    const list = await openAsiaList(cat);
    const rows = (lastMarkup(list.sink) as Markup).inline_keyboard!;
    // Ten product buttons, then the page indicator (a no-op) + Next, then Back.
    expect(rows).toHaveLength(12);
    expect(rows.slice(0, 10).every((row) => row.length === 1 && row[0]!.callback_data!.startsWith("v1:browse:pick:"))).toBe(true);
    expect(rows.slice(10).map((row) => row.map((b) => b.callback_data))).toEqual([["v1:noop", "v1:browse:page:1"], [`v1:browse:gregs:${cat.id}`]]);
    expect(rows[11]![0]!.text).toBe(persistentLabel("back", "en"));

    const back = await tap(list.ctx, `v1:browse:gregs:${cat.id}`);
    expect(sees.regionPicker(back)).toBe(true);
    expect(counts(back.sink)).toEqual(ONE_EDIT);
    expect(scratchOf(back).activeNumberedScreen).toBe("gameRegion");
    expect(scratchOf(back).gameRegionEntries).toEqual(["Asia", "Europe"]);
    // The region picker's own Back still leads to the edition picker that was shown.
    expect(inlineButtons(back.sink).at(-1)!.callback_data).toBe(`v1:browse:gvars:${cat.id}`);

    // Second quick tap of the same button: the bubble already shows the region picker.
    const again = await tap(back.ctx, `v1:browse:gregs:${cat.id}`, { editThrowsNotModified: true });
    expect(counts(again.sink)).toEqual(NOTHING);

    // The bubble vanished: exactly one replacement message, and its id becomes the anchor.
    const goneId = again.ctx.session.menuMsgId!;
    const gone = await tap(again.ctx, `v1:browse:gregs:${cat.id}`, { deletedMessageIds: [goneId] });
    // The bot cannot know the bubble is gone until its one edit fails.
    expect(counts(gone.sink)).toEqual({ ...ONE_SEND, failedEdit: 1 });
    expect(gone.ctx.session.menuMsgId).toBeDefined();
    expect(gone.ctx.session.menuMsgId).not.toBe(goneId);
  });

  it("a single region is auto-skipped, so Back from the list goes to the edition picker, never to a region picker", async () => {
    const cat = await createCategory(prisma, { name: "Genshin Impact", group: CategoryGroup.GAME_TOPUP });
    await createCategory(prisma, { name: "Honkai Star Rail", group: CategoryGroup.GAME_TOPUP });
    await product(cat.id, "GI Asia 1", { gameVariant: "Standard", gameRegion: "Asia" });
    await product(cat.id, "GI Asia 2", { gameVariant: "Standard", gameRegion: "Asia" });
    await product(cat.id, "GI Deluxe 1", { gameVariant: "Deluxe" });
    const entry = customerCtx({ callbackData: `v1:browse:cat:${cat.id}` });
    await routeCallback(entry.ctx);
    const list = await tap(entry.ctx, tapTarget(entry.sink, "Standard"));
    expect(sentIncludes(list.sink, "GI Asia 2")).toBe(true);
    expect(sees.regionPicker(list)).toBe(false);

    const back = await typedBack(list.ctx);
    expect(sees.variantPicker(back)).toBe(true);
    expect(sees.regionPicker(back)).toBe(false);
  });

  it("a single edition is auto-skipped, so the region picker's Back (and the list's second Back) goes to the category picker", async () => {
    const cat = await createCategory(prisma, { name: "Genshin Impact", group: CategoryGroup.GAME_TOPUP });
    await createCategory(prisma, { name: "Honkai Star Rail", group: CategoryGroup.GAME_TOPUP });
    await product(cat.id, "GI Asia 1", { gameRegion: "Asia" });
    await product(cat.id, "GI Asia 2", { gameRegion: "Asia" });
    await product(cat.id, "GI Europe", { gameRegion: "Europe" });
    const entry = customerCtx({ callbackData: `v1:browse:cat:${cat.id}` });
    await routeCallback(entry.ctx);
    expect(sees.regionPicker(entry)).toBe(true);
    const list = await tap(entry.ctx, tapTarget(entry.sink, "Asia"));

    const toRegion = await typedBack(list.ctx);
    expect(sees.regionPicker(toRegion)).toBe(true);
    expect(inlineButtons(toRegion.sink).at(-1)!.callback_data).toBe(`v1:browse:grp:${CategoryGroup.GAME_TOPUP}`);
    const toCategories = await typedBack(toRegion.ctx);
    expect(sees.variantPicker(toCategories)).toBe(false);
    expect(sentIncludes(toCategories.sink, "Honkai Star Rail")).toBe(true);
  });

  it("a single game is auto-skipped too: list → region picker → service picker", async () => {
    const cat = await createCategory(prisma, { name: "Genshin Impact", group: CategoryGroup.GAME_TOPUP });
    await product(cat.id, "GI Asia 1", { gameRegion: "Asia" });
    await product(cat.id, "GI Asia 2", { gameRegion: "Asia" });
    await product(cat.id, "GI Europe", { gameRegion: "Europe" });
    const entry = customerCtx({ callbackData: `v1:browse:grp:${CategoryGroup.GAME_TOPUP}` });
    await routeCallback(entry.ctx);
    const list = await tap(entry.ctx, tapTarget(entry.sink, "Asia"));
    const toRegion = await typedBack(list.ctx);
    expect(sees.regionPicker(toRegion)).toBe(true);
    const toServices = await typedBack(toRegion.ctx);
    expect(sentIncludes(toServices.sink, "What are you shopping for")).toBe(true);
  });

  it("stale picker state never routes Back: after opening another game without pickers, Back goes to the category picker", async () => {
    const cat = await genshin();
    const list = await openAsiaList(cat);
    const other = await createCategory(prisma, { name: "Mobile Legends", group: CategoryGroup.GAME_TOPUP });
    await product(other.id, "ML Alpha");
    await product(other.id, "ML Bravo");
    const otherList = await tap(list.ctx, `v1:browse:cat:${other.id}`);
    expect(sentIncludes(otherList.sink, "ML Bravo")).toBe(true);

    const back = await typedBack(otherList.ctx);
    expect(sees.regionPicker(back)).toBe(false);
    expect(sentIncludes(back.sink, "Honkai Star Rail")).toBe(true);
  });

  it("an old list bubble's region Back after browsing elsewhere answers stale instead of rendering a wrong picker", async () => {
    const cat = await genshin(11);
    const list = await openAsiaList(cat);
    const groups = await tap(list.ctx, "v1:browse:grps");
    const stale = await tap(groups.ctx, `v1:browse:gregs:${cat.id}`);
    expect(counts(stale.sink)).toEqual(NOTHING);
    expect(sentIncludes(stale.sink, t(stale.ctx, "error.stale_screen"))).toBe(true);
  });

  it("Premium Apps' flat list Back goes to the service picker, and its multi-page inline Back row does too, even when products carry a region", async () => {
    const premium = await createCategory(prisma, { name: "Streaming Apps", group: CategoryGroup.PREMIUM_APPS });
    for (let i = 0; i < 11; i++) await product(premium.id, `App ${String(i).padStart(2, "0")}`, { gameVariant: "Standard", gameRegion: i % 2 ? "Asia" : "Europe" });
    const entry = customerCtx({ callbackData: `v1:browse:grp:${CategoryGroup.PREMIUM_APPS}` });
    await routeCallback(entry.ctx);
    expect(sees.regionPicker(entry)).toBe(false);
    const rows = (lastMarkup(entry.sink) as Markup).inline_keyboard!;
    expect(rows.map((row) => row.map((b) => b.callback_data))).toEqual([["v1:browse:page:1"], ["v1:browse:grps"]]);

    const back = await typedBack(entry.ctx);
    expect(sentIncludes(back.sink, "What are you shopping for")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Back on every remaining menu section (plan step 5) and the auto-skipped
// one-product list (B1 follow-up).
// ---------------------------------------------------------------------------

const BACK = persistentLabel("back", "en");
const MENU = persistentLabel("main", "en");
const rowsOf = (sink: SentCall[]) =>
  ((lastMarkup(sink) as Markup | undefined)?.inline_keyboard ?? []).map((row) => row.map((b) => [b.text, b.callback_data]));
const BACK_TO_MENU = [[BACK, "v1:menu:main"]];
const backAndMenu = (target: string) => [[BACK, target], [MENU, "v1:menu:main"]];

/** A customer who finished onboarding (display currency chosen). */
function settledCtx(opts: Parameters<typeof makeCtx>[0] = {}) {
  const c = customerCtx(opts);
  c.ctx.session.dbUser!.preferredCurrency = "IDR";
  c.ctx.session.onboarding = null;
  return c;
}

async function deliveredSale() {
  await prisma.$transaction((tx) =>
    createOrderDirect(tx, { channel: "bot", user: { id: sample.user.id, role: sample.user.role }, productId: sample.product.id, quantity: 1 }),
  );
  await prisma.order.updateMany({ data: { status: OrderStatus.DELIVERED } });
}

describe("top-level sections: one Back to the main menu replaces the duplicate Menu button", () => {
  const onlyBack = (sink: SentCall[]) => {
    expect(rowsOf(sink).at(-1)).toEqual(BACK_TO_MENU);
    expect(inlineButtons(sink).some((b) => b.text === MENU)).toBe(false);
  };

  it("service picker", async () => {
    const { ctx, sink } = settledCtx({ callbackData: "v1:browse:grps" });
    await routeCallback(ctx);
    expect(sentIncludes(sink, "What are you shopping for")).toBe(true);
    onlyBack(sink);
  });

  it("Wallet keeps Top Up, then Back", async () => {
    const { ctx, sink } = settledCtx({ callbackData: "v1:wallet:view" });
    await routeCallback(ctx);
    expect(rowsOf(sink)).toEqual([[[t(ctx, "wallet.topup_btn"), "v1:topup:open"]], BACK_TO_MENU]);
  });

  it("My Orders: pay row, All history, then Back on its own row", async () => {
    const created = await prisma.$transaction((tx) =>
      createOrderDirect(tx, { channel: "bot", user: { id: sample.user.id, role: sample.user.role }, productId: sample.product.id, quantity: 1 }),
    );
    const order = created!;
    const { ctx, sink } = settledCtx({ callbackData: "v1:order:list" });
    await routeCallback(ctx);
    expect(rowsOf(sink)).toEqual([
      [[t(ctx, "order.pay_btn", { code: order.orderCode }), `v1:order:view:${order.id}`]],
      [[t(ctx, "order.all_history_btn"), "v1:order:allhistory"]],
      BACK_TO_MENU,
    ]);
  });

  it("Help Center", async () => {
    const { ctx, sink } = settledCtx({ callbackData: "v1:help:open" });
    await routeCallback(ctx);
    expect(rowsOf(sink).at(-2)).toEqual([[t(ctx, "help.tickets_btn"), "v1:ticket:list"]]);
    onlyBack(sink);
  });

  it("Popular", async () => {
    await deliveredSale();
    const { ctx, sink } = settledCtx({ callbackData: "v1:browse:popular" });
    await routeCallback(ctx);
    expect(rowsOf(sink).at(0)?.[0]?.[1]).toBe(`v1:browse:pick:${sample.parentProduct.id}`);
    onlyBack(sink);
  });

  it("search results, the no-results screen and the bare /search prompt", async () => {
    const games = await createCategory(prisma, { name: "Games", group: CategoryGroup.GAME_TOPUP });
    await product(games.id, "Zqx Solo");
    const results = await search("Zqx");
    expect(rowsOf(results.sink).at(-2)).toEqual([[t(results.ctx, "search.again_btn"), "v1:search:again"]]);
    onlyBack(results.sink);

    const none = await search("Nothingmatcheshere");
    expect(rowsOf(none.sink)).toEqual([[[t(none.ctx, "search.again_btn"), "v1:search:again"]], BACK_TO_MENU]);

    const bare = await search("");
    expect(rowsOf(bare.sink)).toEqual([BACK_TO_MENU]);
  });

  it("Back from a top-level section behaves exactly like the old Menu button: Home, one new bubble carrying the menu keyboard", async () => {
    const wallet = settledCtx({ callbackData: "v1:wallet:view" });
    await routeCallback(wallet.ctx);
    const back = await tap(wallet.ctx, tapTarget(wallet.sink, BACK));
    expect(isHome(back.sink)).toBe(true);
    // A reply keyboard can only ride on a fresh send; the old bubble's keyboard is retired, nothing deleted.
    expect(counts(back.sink)).toEqual(ONE_SEND);
  });
});

describe("deeper sections: [Back, Menu] where Back is the screen really above", () => {
  for (const [name, data] of [["FAQ", "v1:page:faq"], ["Terms", "v1:page:terms"], ["How to pay", "v1:page:howtopay"], ["Referral", "v1:ref:view"]] as const) {
    it(`${name} goes Back to the Help Center`, async () => {
      const { ctx, sink } = settledCtx({ callbackData: data });
      await routeCallback(ctx);
      expect(rowsOf(sink)).toEqual([backAndMenu("v1:help:open")]);
    });
  }

  it("My Tickets goes Back to the Help Center", async () => {
    await createTicket(prisma, sample.user.id, "My order has not arrived yet, please check.");
    const { ctx, sink } = settledCtx({ callbackData: "v1:ticket:list" });
    await routeCallback(ctx);
    expect(rowsOf(sink).at(-1)).toEqual(backAndMenu("v1:help:open"));
  });

  it("the duplicate-ticket notice goes Back to My Tickets", () => {
    const rows = (ticketDuplicateKb(7, "en").inline_keyboard as Button[][]).map((row) => row.map((b) => [b.text, b.callback_data]));
    expect(rows).toEqual([[[coreT("support.duplicate_open_ticket_view_btn", "en"), "v1:ticket:view:7"]], backAndMenu("v1:ticket:list")]);
  });

  it("Language and Currency settings go Back to the Help Center once onboarding is done", async () => {
    const lang = settledCtx({ callbackData: "v1:lang:menu" });
    await routeCallback(lang.ctx);
    expect(rowsOf(lang.sink).at(-1)).toEqual(backAndMenu("v1:help:open"));

    const cur = settledCtx({ callbackData: "v1:cur:menu" });
    await routeCallback(cur.ctx);
    expect(rowsOf(cur.sink).at(-1)).toEqual(backAndMenu("v1:help:open"));
  });

  it("the Game Top-up empty list goes Back to the category picker it came from", async () => {
    const empty = await createCategory(prisma, { name: "Empty Game", group: CategoryGroup.GAME_TOPUP });
    await createCategory(prisma, { name: "Other Game", group: CategoryGroup.GAME_TOPUP });
    const { ctx, sink } = settledCtx({ callbackData: `v1:browse:cat:${empty.id}` });
    await routeCallback(ctx);
    expect(sentIncludes(sink, "No products available at the moment")).toBe(true);
    expect(rowsOf(sink)).toEqual([backAndMenu(`v1:browse:grp:${CategoryGroup.GAME_TOPUP}`)]);
  });
});

describe("onboarding never offers Back (the currency gate cannot be skipped)", () => {
  const noBack = (sink: SentCall[]) => {
    expect(inlineButtons(sink).length).toBeGreaterThan(0);
    expect(inlineButtons(sink).some((b) => b.text === BACK || b.callback_data === "v1:help:open")).toBe(false);
  };

  it("/start language step and the currency step that follows have no Back", async () => {
    const start = customerCtx();
    await customer.startCommand(start.ctx);
    expect(sentIncludes(start.sink, t(start.ctx, "language.choose"))).toBe(true);
    noBack(start.sink);

    const pick = await tap(start.ctx, "v1:lang:set:en");
    expect(sentIncludes(pick.sink, t(pick.ctx, "currency.choose"))).toBe(true);
    noBack(pick.sink);
  });

  it("a user with no currency yet sees no Back on Language or Currency, even outside /start", async () => {
    const lang = customerCtx({ callbackData: "v1:lang:menu" });
    await routeCallback(lang.ctx);
    noBack(lang.sink);
    const cur = customerCtx({ callbackData: "v1:cur:menu" });
    await routeCallback(cur.ctx);
    noBack(cur.sink);
  });

  it("an unfinished onboarding hides Back on the currency step even when a currency is stored", async () => {
    const cur = settledCtx({ callbackData: "v1:cur:menu" });
    cur.ctx.session.onboarding = "currency";
    await routeCallback(cur.ctx);
    noBack(cur.sink);
  });
});

describe("Back chains edit the bubble in place", () => {
  it("Help → FAQ → Back → Help → Back → main menu; a double tap and a deleted bubble add nothing extra", async () => {
    const help = settledCtx({ callbackData: "v1:help:open" });
    await routeCallback(help.ctx);
    const faq = await tap(help.ctx, "v1:page:faq");
    expect(counts(faq.sink)).toEqual(ONE_EDIT);

    const toHelp = await tap(faq.ctx, tapTarget(faq.sink, BACK));
    expect(sentIncludes(toHelp.sink, "What do you need help with?")).toBe(true);
    expect(counts(toHelp.sink)).toEqual(ONE_EDIT);

    const again = await tap(toHelp.ctx, "v1:help:open", { editThrowsNotModified: true });
    expect(counts(again.sink)).toEqual(NOTHING);

    const goneId = again.ctx.session.menuMsgId!;
    const gone = await tap(again.ctx, "v1:help:open", { deletedMessageIds: [goneId] });
    expect(counts(gone.sink)).toEqual({ ...ONE_SEND, failedEdit: 1 });
    expect(gone.ctx.session.menuMsgId).not.toBe(goneId);

    const toMenu = await tap(gone.ctx, tapTarget(gone.sink, BACK));
    expect(isHome(toMenu.sink)).toBe(true);
  });

  it("My Tickets → Back → Help Center is one edit", async () => {
    await createTicket(prisma, sample.user.id, "My order has not arrived yet, please check.");
    const tickets = settledCtx({ callbackData: "v1:ticket:list" });
    await routeCallback(tickets.ctx);
    const back = await tap(tickets.ctx, tapTarget(tickets.sink, BACK));
    expect(sentIncludes(back.sink, "What do you need help with?")).toBe(true);
    expect(counts(back.sink)).toEqual(ONE_EDIT);
  });

  it("Wallet and My Orders go Back to Home", async () => {
    await prisma.$transaction((tx) =>
      createOrderDirect(tx, { channel: "bot", user: { id: sample.user.id, role: sample.user.role }, productId: sample.product.id, quantity: 1 }),
    );
    for (const data of ["v1:wallet:view", "v1:order:list"]) {
      const screen = settledCtx({ callbackData: data });
      await routeCallback(screen.ctx);
      const back = await tap(screen.ctx, tapTarget(screen.sink, BACK));
      expect(isHome(back.sink)).toBe(true);
    }
  });

  it("Popular → product → Back → Popular → Back → Home", async () => {
    await deliveredSale();
    const popular = settledCtx({ callbackData: "v1:browse:popular" });
    await routeCallback(popular.ctx);
    const detail = await tap(popular.ctx, `v1:browse:pick:${sample.parentProduct.id}`);
    const back = await tap(detail.ctx, tapTarget(detail.sink, BACK));
    expect(sentIncludes(back.sink, t(back.ctx, "browse.popular_title"))).toBe(true);
    expect(counts(back.sink)).toEqual(ONE_EDIT);
    const home = await tap(back.ctx, tapTarget(back.sink, BACK));
    expect(isHome(home.sink)).toBe(true);
  });

  it("Search → product → Back → results; Search again → Back → the same results page", async () => {
    const games = await createCategory(prisma, { name: "Games", group: CategoryGroup.GAME_TOPUP });
    await product(games.id, "Zqx Solo");
    const results = await search("Zqx");
    const detail = await tap(results.ctx, resultTarget(results.sink, "Zqx Solo"));
    const back = await tap(detail.ctx, tapTarget(detail.sink, BACK));
    expect(sentIncludes(back.sink, "Zqx Solo")).toBe(true);
    expect(counts(back.sink)).toEqual(ONE_EDIT);

    const prompt = await tap(back.ctx, "v1:search:again");
    expect(rowsOf(prompt.sink)).toEqual([backAndMenu("v1:search:page:0")]);
    const toResults = await tap(prompt.ctx, "v1:search:page:0");
    expect(sentIncludes(toResults.sink, "Zqx Solo")).toBe(true);
    expect(counts(toResults.sink)).toEqual(ONE_EDIT);
  });

  it("Search again without valid results goes Back to the main menu only", async () => {
    const prompt = settledCtx({ callbackData: "v1:search:again" });
    await routeCallback(prompt.ctx);
    expect(rowsOf(prompt.sink)).toEqual([BACK_TO_MENU]);
  });
});

describe("a region (or edition) holding one product skips its one-line list, and so does Back", () => {
  it("one-pack product: the detail's Back re-renders the region picker the buyer came from, in place", async () => {
    const cat = await genshin();
    const entry = customerCtx({ callbackData: `v1:browse:cat:${cat.id}` });
    await routeCallback(entry.ctx);
    const edition = await tap(entry.ctx, tapTarget(entry.sink, "Standard"));
    const detail = await tap(edition.ctx, tapTarget(edition.sink, "Europe"));
    expect(sentIncludes(detail.sink, "GI Europe")).toBe(true);
    expect(backData(detail.sink)).toBe(`v1:browse:gregs:${cat.id}`);

    const back = await tap(detail.ctx, `v1:browse:gregs:${cat.id}`);
    expect(sees.regionPicker(back)).toBe(true);
    expect(sentIncludes(back.sink, "GI Europe")).toBe(false);
    expect(counts(back.sink)).toEqual(ONE_EDIT);

    // A typed Back from the same detail lands on the same picker.
    const detail2 = await tap(back.ctx, tapTarget(back.sink, "Europe"));
    const typed = await typedBack(detail2.ctx);
    expect(sees.regionPicker(typed)).toBe(true);
    expect(sentIncludes(typed.sink, "GI Europe")).toBe(false);
  });

  it("multi-pack product: the pack picker's Back goes to the region picker, and a pack's Back still goes to the pack picker", async () => {
    const cat = await genshin();
    const europe = await prisma.product.findFirstOrThrow({ where: { name: "GI Europe" } });
    await createDenomination(prisma, { productId: europe.id, name: "200", type: "SHARED", durationLabel: "200", price: "29000" });
    const entry = customerCtx({ callbackData: `v1:browse:cat:${cat.id}` });
    await routeCallback(entry.ctx);
    const edition = await tap(entry.ctx, tapTarget(entry.sink, "Standard"));
    const picker = await tap(edition.ctx, tapTarget(edition.sink, "Europe"));
    expect(backData(picker.sink)).toBe(`v1:browse:gregs:${cat.id}`);
    const pack = inlineButtons(picker.sink).find((b) => b.callback_data?.startsWith("v1:browse:denom:"))!.callback_data!;
    const detail = await tap(picker.ctx, pack);
    expect(backData(detail.sink)).toBe(`v1:browse:pick:${europe.id}`);
  });

  it("an edition with one product and no region goes Back to the edition picker", async () => {
    const cat = await createCategory(prisma, { name: "Genshin Impact", group: CategoryGroup.GAME_TOPUP });
    await createCategory(prisma, { name: "Honkai Star Rail", group: CategoryGroup.GAME_TOPUP });
    await product(cat.id, "GI Standard 1", { gameVariant: "Standard" });
    await product(cat.id, "GI Standard 2", { gameVariant: "Standard" });
    await product(cat.id, "GI Deluxe Only", { gameVariant: "Deluxe" });
    const entry = customerCtx({ callbackData: `v1:browse:cat:${cat.id}` });
    await routeCallback(entry.ctx);
    const detail = await tap(entry.ctx, tapTarget(entry.sink, "Deluxe"));
    expect(sentIncludes(detail.sink, "GI Deluxe Only")).toBe(true);
    expect(backData(detail.sink)).toBe(`v1:browse:gvars:${cat.id}`);
    const back = await tap(detail.ctx, `v1:browse:gvars:${cat.id}`);
    expect(sees.variantPicker(back)).toBe(true);
    expect(counts(back.sink)).toEqual(ONE_EDIT);
  });

  it("Back from the product photo deletes that obsolete photo and sends the picker once", async () => {
    const cat = await genshin();
    const entry = customerCtx({ callbackData: `v1:browse:cat:${cat.id}` });
    await routeCallback(entry.ctx);
    const edition = await tap(entry.ctx, tapTarget(entry.sink, "Standard"));
    const detail = await tap(edition.ctx, tapTarget(edition.sink, "Europe"));
    const photoId = detail.ctx.session.menuMsgId!;
    const back = await tap(detail.ctx, `v1:browse:gregs:${cat.id}`, {
      cbMessage: { message_id: photoId, chat: { id: 42, type: "private" }, date: 0, photo: [{ file_id: "p" }] },
    });
    expect(sees.regionPicker(back)).toBe(true);
    // The photo was just deleted: no edit is attempted on it, and its keyboard is not "retired".
    expect(counts(back.sink)).toEqual({ ...ONE_SEND, deleteMessage: 1 });
    expect(calls(back.sink, "editMessageReplyMarkup").some((c) => c.args[1] === photoId)).toBe(false);
  });

  it("a product listed with others still goes Back to its list", async () => {
    const cat = await genshin();
    const list = await openAsiaList(cat);
    // Opened by tapping its inline list button (a Game list has no numbers).
    const detail = await tap(list.ctx, tapTarget(list.sink, "GI Asia 00"));
    expect(sentIncludes(detail.sink, t(detail.ctx, "browse.use_buttons"))).toBe(false);
    expect(backData(detail.sink)).toBe("v1:browse:prods");
  });
});

describe("a typed Back outside the catalog behaves exactly like the typed Menu key", () => {
  /** The Premium sample product's detail, opened from the catalog list (catalog scratch set). */
  async function openDetail() {
    const list = settledCtx({ callbackData: `v1:browse:grp:${CategoryGroup.PREMIUM_APPS}` });
    await routeCallback(list.ctx);
    const detail = await tap(list.ctx, `v1:browse:pick:${sample.parentProduct.id}`);
    expect(backData(detail.sink)).toBe("v1:browse:prods");
    return detail;
  }
  /** Home, one send, nothing edited (no transaction/payment bubble touched), no catalog screen. */
  function pinMenu(c: FakeCtx) {
    expect(isHome(c.sink)).toBe(true);
    expect(counts(c.sink)).toEqual(ONE_SEND);
    expect(sentIncludes(c.sink, "Product List")).toBe(false);
    expect(c.ctx.session.scratch.productId).toBeUndefined();
    expect(c.ctx.session.scratch.variantId).toBeUndefined();
  }
  async function typedMenu(prev: { session: SessionData }) {
    const menu = next(prev, { text: MENU });
    await customer.handleProductNumber(menu.ctx);
    return menu;
  }

  it("on the order review: Home (like Menu), never the product detail or list", async () => {
    const detail = await openDetail();
    const review = await tap(detail.ctx, `v1:walletm:back:${sample.product.id}:1`);
    expect(sentIncludes(review.sink, "Confirm Order")).toBe(true);
    const back = await typedBack(review.ctx);
    pinMenu(back);
    expect(counts(back.sink)).toEqual(counts((await typedMenu(review.ctx)).sink));
  });

  it("on the USDT payment-method screen: Home", async () => {
    const detail = await openDetail();
    const methods = await tap(detail.ctx, `v1:usdt:${sample.product.id}:1`);
    const back = await typedBack(methods.ctx);
    pinMenu(back);
  });

  it("on the fully wallet-covered confirm: Home", async () => {
    await adjustWallet(prisma, sample.user.id, "10", { currency: "IDR", reason: "admin_adjust" });
    const detail = await openDetail();
    const confirm = await tap(detail.ctx, `v1:walletm:idr:${sample.product.id}:1`);
    expect(sentIncludes(confirm.sink, "Fully paid from your wallet credit")).toBe(true);
    pinMenu(await typedBack(confirm.ctx));
  });

  it("on the QR payment wait: Home; the QR bubble is neither edited nor deleted", async () => {
    await setSetting(prisma, "tokopay_merchant_id", "M1");
    await setSetting(prisma, "tokopay_secret", "S1");
    const detail = await openDetail();
    const review = await tap(detail.ctx, `v1:walletm:back:${sample.product.id}:1`);
    const pay = next(review.ctx, { callbackData: "v1:payq", cbMessage: { message_id: review.ctx.session.menuMsgId, chat: { id: 42, type: "private" }, date: 0 } });
    await primeQuote(pay.ctx, sample.product.id, 1);
    await checkout.buyNowTokopay(pay.ctx, sample.product.id, 1, quoteNonce(pay.ctx));
    expect(calls(pay.sink, "replyWithPhoto")).toHaveLength(1);
    const back = await typedBack(pay.ctx);
    pinMenu(back);
  });

  it("inside a wizard prompt (voucher entry): the wizard exits to Home like Menu, no catalog Back", async () => {
    const detail = await openDetail();
    const review = await tap(detail.ctx, `v1:walletm:back:${sample.product.id}:1`);
    const start = next(review.ctx, { callbackData: `v1:voucher:start:${sample.product.id}:1`, cbMessage: { message_id: review.ctx.session.menuMsgId, chat: { id: 42, type: "private" }, date: 0 } });
    const back = next(review.ctx, { text: BACK });
    await voucherConversation(new FakeConversation([back.ctx]).asMyConversation(), start.ctx);
    expect(sentIncludes(start.sink, t(start.ctx, "checkout.enter_voucher"))).toBe(true);
    pinMenu(back);
  });

  it("on search results: Home (the results' own Back), never an old catalog picker", async () => {
    const cat = await genshin();
    const entry = customerCtx({ callbackData: `v1:browse:cat:${cat.id}` });
    await routeCallback(entry.ctx);
    const regions = await tap(entry.ctx, tapTarget(entry.sink, "Standard"));
    expect(sees.regionPicker(regions)).toBe(true);
    const results = next(regions.ctx, { match: "GI" });
    await customer.searchCommand(results.ctx);
    const back = await typedBack(results.ctx);
    expect(sees.regionPicker(back)).toBe(false);
    pinMenu(back);
  });
});

describe("stale product scratch never steers Back", () => {
  it("list → pack detail → /search → typed Back is Home; a product opened from the results goes Back to them", async () => {
    const games = await createCategory(prisma, { name: "Games", group: CategoryGroup.GAME_TOPUP });
    const hero = await twoPackGame(games.id, "Zqx Hero");
    await twoPackGame(games.id, "Zqx Other");
    const list = customerCtx({ callbackData: `v1:browse:cat:${games.id}` });
    await routeCallback(list.ctx);
    const picker = await tap(list.ctx, `v1:browse:pick:${hero.id}`);
    const pack = inlineButtons(picker.sink).find((b) => b.callback_data?.startsWith("v1:browse:denom:"))!.callback_data!;
    const detail = await tap(picker.ctx, pack);
    expect(detail.ctx.session.scratch.variantId).toBeDefined();

    const results = next(detail.ctx, { match: "Zqx" });
    await customer.searchCommand(results.ctx);
    expect(results.ctx.session.scratch.productId).toBeUndefined();
    expect(results.ctx.session.scratch.variantId).toBeUndefined();
    expect(results.ctx.session.scratch.productPage).toBeUndefined();
    const home = await typedBack(results.ctx);
    expect(isHome(home.sink)).toBe(true);
    expect(sentIncludes(home.sink, "Zqx Hero")).toBe(false);

    const again = next(home.ctx, { match: "Zqx" });
    await customer.searchCommand(again.ctx);
    const opened = await tap(again.ctx, resultTarget(again.sink, "Zqx Other"));
    const back = await typedBack(opened.ctx);
    expect(sentIncludes(back.sink, t(back.ctx, "search.again_btn"))).toBe(true);
    expect(counts(back.sink)).toEqual(TYPED_BACK);
  });

  it("Popular clears the open product too", async () => {
    await deliveredSale();
    const list = settledCtx({ callbackData: `v1:browse:grp:${CategoryGroup.PREMIUM_APPS}` });
    await routeCallback(list.ctx);
    const detail = await tap(list.ctx, `v1:browse:pick:${sample.parentProduct.id}`);
    const popular = await tap(detail.ctx, "v1:browse:popular");
    expect(popular.ctx.session.scratch.productId).toBeUndefined();
    expect(popular.ctx.session.scratch.variantId).toBeUndefined();
    const home = await typedBack(popular.ctx);
    expect(isHome(home.sink)).toBe(true);
  });

  it("a prod_<id> deep link ignores a product picker left open earlier", async () => {
    const games = await createCategory(prisma, { name: "Games", group: CategoryGroup.GAME_TOPUP });
    const hero = await twoPackGame(games.id, "Zqx Hero");
    const list = customerCtx({ callbackData: `v1:browse:cat:${games.id}` });
    await routeCallback(list.ctx);
    const picker = await tap(list.ctx, `v1:browse:pick:${hero.id}`);
    expect(picker.ctx.session.scratch.productId).toBe(hero.id);
    const link = next(picker.ctx, { match: `prod_${sample.product.id}` });
    await customer.menuCommand(link.ctx);
    expect(backData(link.sink)).toBe("v1:browse:prods");
    expect(link.ctx.session.scratch.productId).toBeUndefined();
  });
});

describe("fully wallet-covered confirm", () => {
  it("its Back re-renders the pack detail in place", async () => {
    await adjustWallet(prisma, sample.user.id, "10", { currency: "IDR", reason: "admin_adjust" });
    const confirm = settledCtx({ callbackData: `v1:walletm:idr:${sample.product.id}:1` });
    await routeCallback(confirm.ctx);
    expect(backData(confirm.sink)).toBe(`v1:browse:denom:${sample.product.id}`);
    const back = await tap(confirm.ctx, `v1:browse:denom:${sample.product.id}`);
    expect(sentIncludes(back.sink, sample.parentProduct.name)).toBe(true);
    expect(sentIncludes(back.sink, "Fully paid from your wallet credit")).toBe(false);
    expect(counts(back.sink)).toEqual(ONE_EDIT);
  });
});

describe("backRow", () => {
  it("is [← Back, 🏠 Menu], a single Back when its target already is the main menu, and Back alone on request", () => {
    expect(backRow("en", "v1:help:open")).toEqual([{ text: BACK, data: "v1:help:open" }, { text: MENU, data: "v1:menu:main" }]);
    expect(backRow("en", "v1:menu:main")).toEqual([{ text: BACK, data: "v1:menu:main" }]);
    expect(backRow("en", "v1:browse:grps", false)).toEqual([{ text: BACK, data: "v1:browse:grps" }]);
    expect(backRow("id", "v1:help:open").map((b) => b.text)).toEqual([persistentLabel("back", "id"), persistentLabel("main", "id")]);
  });
});

describe("screens excluded from Back keep their keyboards exactly", () => {
  const shape = (kb: { inline_keyboard: unknown[][] }) =>
    (kb.inline_keyboard as Button[][]).map((row) => row.map((b) => [b.text, b.callback_data ?? "copy"]));
  it("receipts, notifications, payment waits, wizard prompts and error screens", () => {
    const L = (k: string) => coreT(k, "en");
    expect(shape(settledPaymentKb("WALLET_TOPUP", "en"))).toEqual([[[L("wallet.topup_btn"), "v1:topup:open"]], [[MENU, "v1:menu:main"]]]);
    expect(shape(paymentSuccessKb("en"))).toEqual([[[L("checkout.buy_again_btn"), "v1:browse:prods"]], [[L("order.all_history_btn"), "v1:order:list"]], [[MENU, "v1:menu:main"]]]);
    expect(shape(notificationKb("en"))).toEqual([[[L("menu.my_orders"), "v1:order:list"], [MENU, "v1:menu:main"]]]);
    expect(shape(ticketClosedKb("en"))).toEqual([[[L("menu.my_tickets"), "v1:ticket:list"], [MENU, "v1:menu:main"]]]);
    expect(shape(qrisWaitingKb(5, "en"))).toEqual([[[L("checkout.refresh_status_btn"), "v1:checkout:refresh:5"]], [[L("checkout.cancel_order"), "v1:checkout:cancel:5"]], [[MENU, "v1:menu:main"]]]);
    expect(shape(proofCancelKb(5, "en"))).toEqual([[[L("checkout.cancel_order"), "v1:checkout:cancel:5"]], [[MENU, "v1:menu:main"]]]);
    expect(shape(backToMain("en"))).toEqual([[[MENU, "v1:menu:main"]]]);
    expect(shape(topupAmountCancelKb("en"))).toEqual([[[L("checkout.cancel_btn"), "v1:topup:open"]]]);
    expect(shape(voucherCancelKb(3, 2, "en"))).toEqual([[[L("checkout.cancel_btn"), "v1:buy:3:2"]]]);
    expect(shape(qtyInputCancelKb(3, "en"))).toEqual([[[L("browse.qty_input_cancel"), "v1:qty:cancel:3"]]]);
    expect(shape(editInfoCancelKb(4, "en"))).toEqual([[[L("checkout.cancel_btn"), "v1:order:view:4"]]]);
  });
});
