// setup-db MUST be first — temp DB + push before any @app import.
import "./setup-db";

import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { prisma, createCatalogProduct, createCategory, createDenomination, setSetting, upsertUser } from "@app/db";
import { CategoryGroup } from "@app/core/enums";
import { buildSampleData, resetDb, type SampleData } from "../../../tests/helpers/sampleData";
import { makeCtx, calls, sentIncludes, lastMarkup, type FakeCtx, type SentCall } from "./helpers/ctx";
import type { SessionData } from "../src/context";
import { routeCallback } from "../src/handlers/callbacks";
import * as customer from "../src/handlers/customer";
import { persistentLabel } from "../src/keyboards/customer";
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
  return makeCtx({ from: { id: 42, username: "tester" }, session: userSession(), ...opts });
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
});
const ONE_EDIT = { sendMessage: 0, reply: 0, editMessageText: 1, editMessageCaption: 0, deleteMessage: 0, sendDocument: 0 };
const ONE_SEND = { sendMessage: 0, reply: 1, editMessageText: 0, editMessageCaption: 0, deleteMessage: 0, sendDocument: 0 };
const NOTHING = { sendMessage: 0, reply: 0, editMessageText: 0, editMessageCaption: 0, deleteMessage: 0, sendDocument: 0 };

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

describe("product list Back follows the pickers that were really shown", () => {
  it("edition → region → list: Back returns one step at a time to the region picker, edition picker, category picker, service picker and menu", async () => {
    const cat = await genshin();
    const list = await openAsiaList(cat);
    // The list's bottom keyboard (sent with the region tap's existing companion) carries Back next to Menu.
    expect(bottomKeyboard(list.sink)).toEqual(["1", "2", persistentLabel("back", "en"), persistentLabel("main", "en")]);

    const toRegion = await typedBack(list.ctx);
    expect(sees.regionPicker(toRegion)).toBe(true);
    expect(inlineButtons(toRegion.sink).filter((b) => b.callback_data?.startsWith(`v1:browse:greg:${cat.id}:`))).toHaveLength(2);
    expect(scratchOf(toRegion).activeNumberedScreen).toBe("gameRegion");
    // A typed Back cannot edit (no tapped bubble): exactly one new bubble, no companion keyboard message.
    expect(counts(toRegion.sink)).toEqual(ONE_SEND);

    const toEdition = await typedBack(toRegion.ctx);
    expect(sees.variantPicker(toEdition)).toBe(true);
    expect(counts(toEdition.sink)).toEqual(ONE_SEND);

    const toCategories = await typedBack(toEdition.ctx);
    expect(sentIncludes(toCategories.sink, "Honkai Star Rail")).toBe(true);
    expect(counts(toCategories.sink)).toEqual(ONE_SEND);

    const toServices = await typedBack(toCategories.ctx);
    expect(sentIncludes(toServices.sink, "What are you shopping for")).toBe(true);

    const toMenu = await typedBack(toServices.ctx);
    expect(isHome(toMenu.sink)).toBe(true);
  });

  it("the picker reply keyboards carry Back too", async () => {
    const cat = await genshin();
    const entry = customerCtx({ callbackData: `v1:browse:cat:${cat.id}` });
    await routeCallback(entry.ctx);
    expect(bottomKeyboard(entry.sink)).toEqual(["1", "2", persistentLabel("back", "en"), persistentLabel("main", "en")]);
  });

  it("a multi-page list's inline Back re-renders the region picker by editing the same bubble; a double tap and a deleted bubble add nothing extra", async () => {
    const cat = await genshin(11);
    const list = await openAsiaList(cat);
    const rows = (lastMarkup(list.sink) as Markup).inline_keyboard!;
    expect(rows.map((row) => row.map((b) => b.callback_data))).toEqual([["v1:browse:page:1"], [`v1:browse:gregs:${cat.id}`]]);
    expect(rows[1]![0]!.text).toBe(persistentLabel("back", "en"));

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
    expect(counts(gone.sink)).toEqual(ONE_SEND);
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
