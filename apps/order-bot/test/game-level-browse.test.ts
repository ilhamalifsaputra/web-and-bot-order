// setup-db MUST be first — temp DB + push before any @app import.
import "./setup-db";

/**
 * The Game Top-up GAME LEVEL through the real `buildBot()` and the fake
 * Telegram transport (photo vs text bubbles, deletes): a category holding
 * several games → game list → a game's edition picker → its region picker →
 * the pack picker (TEXT) → the pack detail (PHOTO) and Back all the way up,
 * with the exact Telegram calls per transition, repeated cycles that never
 * grow the chat, stale / repeated / concurrent taps that never add a bubble,
 * a several-products scope (inline list), and entries from search.
 *
 * Catalog (in-test, explicit gameVariant / gameRegion — the admin values win
 * over anything derived): "Genshin Impact" with editions Welkin / Crystal ×
 * regions Indonesia / Malaysia (4 products), "Honkai Star Rail" with two
 * products of the same scope (one brand, no edition / region), "Free Fire"
 * (one product). The shop banner is set, so the game list is a photo bubble.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  process.env.RATE_LIMIT_MAX = "1000";
});

import { prisma, createCategory, createCatalogProduct, createDenomination, setSetting, setUserPreferredCurrency, invalidateWarmUser } from "@app/db";
import { CategoryGroup } from "@app/core/enums";
import { Decimal } from "@app/core/money";
import { resetDb } from "../../../tests/helpers/sampleData";
import { ensureFixtureBuyerAndSettings, FIXTURE_BUYER_TELEGRAM_ID } from "../../../tests/helpers/gameTopupFixtures";
import { buildBot } from "../src/main";
import { invalidateRateCache } from "../src/util/rate";
import { coreT } from "../src/util/i18n";
import { paymentSuccessKb, persistentLabel } from "../src/keyboards/customer";
import { FAKE_ME, FakeTelegram } from "./helpers/fakeTelegram";

const BUYER = FIXTURE_BUYER_TELEGRAM_ID;
const EN = "en";
const STALE = coreT("error.stale_screen", EN);

let userId: number;
let categoryId: number;
let updateSeq = 600_000;

async function product(name: string, brand: string, extra: { gameVariant?: string; gameRegion?: string; photo?: boolean; packs?: number }) {
  const p = await createCatalogProduct(prisma, {
    categoryId,
    name,
    digiflazzBrand: brand,
    gameVariant: extra.gameVariant ?? null,
    gameRegion: extra.gameRegion ?? null,
    ...(extra.photo ? { webImageUrl: "/uploads/products/x.jpg", imageFileId: `AgACFAKE_${name.replace(/\W+/g, "_")}` } : {}),
  });
  for (let i = 0; i < (extra.packs ?? 3); i++) {
    const qty = (i + 1) * 60;
    await createDenomination(prisma, {
      productId: p.id, name: `${qty} Crystals`, type: "SHARED", durationLabel: `${qty} Crystals`,
      price: new Decimal(qty * 250), deliveryType: "manual_with_info", qtyValue: qty, qtyUnit: "Crystals", sortOrder: i,
    });
  }
  return p;
}

beforeEach(async () => {
  await resetDb(prisma);
  await prisma.botSession.deleteMany();
  invalidateRateCache();
  const user = await ensureFixtureBuyerAndSettings(prisma);
  userId = user.id;
  await setUserPreferredCurrency(prisma, userId, "IDR");
  await setSetting(prisma, "banner_image", "AgACAgUAAxkBAAIFAKE_game_level_banner");
  categoryId = (await createCategory(prisma, { name: "Game Top Up", group: CategoryGroup.GAME_TOPUP, sortOrder: 1 })).id;
  await createCategory(prisma, { name: "Premium Apps", group: CategoryGroup.PREMIUM_APPS, sortOrder: 2 });
  await product("Genshin Impact Welkin Indonesia", "Genshin Impact", { gameVariant: "Welkin", gameRegion: "🇮🇩 Indonesia", photo: true });
  await product("Genshin Impact Welkin Malaysia", "Genshin Impact", { gameVariant: "Welkin", gameRegion: "🇲🇾 Malaysia" });
  await product("Genshin Impact Crystal Indonesia", "Genshin Impact", { gameVariant: "Crystal", gameRegion: "🇮🇩 Indonesia" });
  await product("Genshin Impact Crystal Malaysia", "Genshin Impact", { gameVariant: "Crystal", gameRegion: "🇲🇾 Malaysia" });
  await product("Honkai Star Rail Oneiric Shard", "Honkai Star Rail", {});
  await product("Honkai Star Rail Express Pass", "Honkai Star Rail", {});
  await product("Free Fire", "Free Fire", { photo: true });
});

afterEach(() => {
  invalidateWarmUser(userId);
});

afterAll(async () => {
  await prisma.$disconnect();
});

function openBot(): FakeTelegram {
  const bot = buildBot("123:test-token");
  bot.botInfo = FAKE_ME;
  const tg = new FakeTelegram(bot, BUYER, { id: BUYER, first_name: "Fixture", username: "fixture_buyer" }, updateSeq);
  updateSeq += 10_000;
  return tg;
}

const bare = (text: string) => text.replace(/^[^\p{L}\p{N}]+/u, "").trim();
const pressLabel = (tg: FakeTelegram, label: string) => tg.press((b) => bare(b.text) === label);
const denomButtons = (tg: FakeTelegram) => tg.buttons().filter((b) => b.callback_data?.startsWith("v1:browse:denom:"));
const current = (tg: FakeTelegram) => tg.messages.get(tg.findButton(() => true).messageId)!;
/** Live bot messages still carrying a catalog keyboard. */
const pickerBubbles = (tg: FakeTelegram) => [...tg.messages.values()].filter((m) => m.inline.flat().some((b) => b.callback_data?.startsWith("v1:browse:"))).length;
/** The stale-screen toasts answered since `mark`. */
const staleToasts = (tg: FakeTelegram, mark: number) => tg.since(mark).filter((c) => c.method === "answerCallbackQuery" && c.payload.text === STALE).length;
const atGameList = (tg: FakeTelegram) => tg.screenText().includes(coreT("hint.game_list", EN)) && tg.buttons().some((b) => bare(b.text) === "Free Fire");

async function openGameList(tg: FakeTelegram) {
  await tg.sendText("/start");
  await tg.pressReply(/Products/);
  await tg.press(/Game Top Up/);
}

describe("Game Top-up game level (fake transport)", () => {
  it("shows one button per game with its From price, and Back goes up to the service picker", async () => {
    const tg = openBot();
    await openGameList(tg);
    expect(atGameList(tg)).toBe(true);
    expect(tg.buttons().filter((b) => b.callback_data?.startsWith("v1:browse:game:")).map((b) => b.text)).toEqual(["Free Fire", "Genshin Impact", "Honkai Star Rail"]);
    // Every game named in the body with the lowest pack price over its products.
    expect(tg.screenText()).toMatch(/Genshin Impact — from Rp/);
    expect(current(tg).kind).toBe("photo");
    await tg.press(/Back/);
    expect(tg.buttons().some((b) => /Premium Apps/.test(b.text))).toBe(true);
  });

  it("game → edition → region → pack (text) → detail (photo) costs exactly one edit or one send + one delete per step, Back the same way up", async () => {
    const tg = openBot();
    await openGameList(tg);
    const step = async (action: () => Promise<unknown>) => {
      const mark = tg.mark();
      await action();
      return tg.screen(mark);
    };

    expect(await step(() => pressLabel(tg, "Genshin Impact"))).toEqual(["editMessageCaption"]);
    expect(tg.screenText()).toContain(coreT("browse.choose_variant", EN));
    expect(tg.buttons().filter((b) => b.callback_data?.startsWith("v1:browse:ged:")).map((b) => b.text)).toEqual(["Crystal", "Welkin"]);

    expect(await step(() => pressLabel(tg, "Welkin"))).toEqual(["editMessageCaption"]);
    expect(tg.screenText()).toContain(coreT("browse.choose_region", EN));
    expect(tg.buttons().filter((b) => b.callback_data?.startsWith("v1:browse:grg:")).map((b) => b.text)).toEqual(["🇮🇩 Indonesia", "🇲🇾 Malaysia"]);

    // The pack picker is a TEXT message: one send, then the obsolete photo is deleted.
    expect(await step(() => pressLabel(tg, "Indonesia"))).toEqual(["sendMessage", "deleteMessage"]);
    expect(current(tg).kind).toBe("text");
    expect(current(tg).text).toContain("Genshin Impact Welkin Indonesia");

    // The detail shows the product photo: one photo send, then the text picker is deleted.
    expect(await step(() => tg.press((b) => b.callback_data?.startsWith("v1:browse:denom:") === true))).toEqual(["sendPhoto", "deleteMessage"]);
    expect(current(tg).kind).toBe("photo");

    // Back: detail photo → pack picker text (delete + one send), → region, → edition (edits), → game list (photo + delete).
    expect((await step(() => tg.press(/Back/))).sort()).toEqual(["deleteMessage", "sendMessage"]);
    expect(denomButtons(tg).length).toBeGreaterThan(0);
    expect(await step(() => tg.press(/Back/))).toEqual(["editMessageText"]);
    expect(tg.screenText()).toContain(coreT("browse.choose_region", EN));
    expect(await step(() => tg.press(/Back/))).toEqual(["editMessageText"]);
    expect(tg.screenText()).toContain(coreT("browse.choose_variant", EN));
    expect(await step(() => tg.press(/Back/))).toEqual(["sendPhoto", "deleteMessage"]);
    expect(atGameList(tg)).toBe(true);
  });

  it("repeated full cycles (game → edition → region → pack → detail → Back ×5) keep the chat at a constant size with one picker bubble", async () => {
    const tg = openBot();
    await openGameList(tg);
    const baseline = tg.messages.size;
    const sizes: number[] = [];
    for (let cycle = 0; cycle < 4; cycle++) {
      await pressLabel(tg, "Genshin Impact");
      await pressLabel(tg, cycle % 2 ? "Crystal" : "Welkin");
      await pressLabel(tg, cycle % 2 ? "Malaysia" : "Indonesia");
      await tg.press((b) => b.callback_data?.startsWith("v1:browse:denom:") === true);
      expect(pickerBubbles(tg)).toBe(1);
      for (let back = 0; back < 4; back++) {
        await tg.press(/Back/);
        expect(pickerBubbles(tg)).toBe(1);
      }
      expect(atGameList(tg)).toBe(true);
      sizes.push(tg.messages.size);
    }
    expect(sizes).toEqual([baseline, baseline, baseline, baseline]);
  });

  it("several products in one game scope get an inline list; its Back returns to the game list", async () => {
    const tg = openBot();
    await openGameList(tg);
    await pressLabel(tg, "Honkai Star Rail");
    const picks = tg.buttons().filter((b) => b.callback_data?.startsWith("v1:browse:pick:")).map((b) => b.text);
    expect(picks.sort()).toEqual(["Honkai Star Rail Express Pass", "Honkai Star Rail Oneiric Shard"]);
    // Inline-only: no numbers, no "pick a game" hint inside a game.
    expect(tg.screenText()).not.toMatch(/^\s*1\./m);
    expect(tg.screenText()).not.toContain(coreT("hint.game_list", EN));
    await pressLabel(tg, "Honkai Star Rail Express Pass");
    expect(denomButtons(tg).length).toBeGreaterThan(0);
    await tg.press(/Back/);
    expect(tg.buttons().some((b) => b.callback_data?.startsWith("v1:browse:pick:"))).toBe(true);
    await tg.press(/Back/);
    expect(atGameList(tg)).toBe(true);
  });

  it("a one-product game opens its pack picker straight away; Back skips the never-shown screens", async () => {
    const tg = openBot();
    await openGameList(tg);
    await pressLabel(tg, "Free Fire");
    expect(denomButtons(tg).length).toBeGreaterThan(0);
    expect(current(tg).kind).toBe("text");
    await tg.press(/Back/);
    expect(atGameList(tg)).toBe(true);
  });

  it("STALE taps: an old game / edition button after the screen moved on answers the stale toast and renders nothing", async () => {
    const tg = openBot();
    await openGameList(tg);
    const game = await pressLabel(tg, "Genshin Impact");
    const edition = await pressLabel(tg, "Welkin");
    await pressLabel(tg, "Indonesia");
    const size = tg.messages.size;

    for (const old of [game, edition]) {
      const mark = tg.mark();
      await tg.tap(old.messageId, old.data);
      expect(staleToasts(tg, mark)).toBe(1);
      expect(tg.screen(mark)).toEqual([]);
    }
    // A pre-game-level region index on the old bubble is stale too.
    const mark = tg.mark();
    await tg.tap(edition.messageId, `v1:browse:grg:${categoryId}:0`);
    expect(staleToasts(tg, mark)).toBe(1);
    expect(tg.screen(mark)).toEqual([]);
    expect(tg.messages.size).toBe(size);
    expect(pickerBubbles(tg)).toBe(1);
  });

  it("DOUBLE and CONCURRENT taps: the second tap of the same button is a no-op (stale toast), one screen only", async () => {
    const tg = openBot();
    await openGameList(tg);
    // Double tap: the bubble already shows the edition picker when the second tap lands.
    const first = await pressLabel(tg, "Genshin Impact");
    let mark = tg.mark();
    await tg.tap(first.messageId, first.data);
    expect(staleToasts(tg, mark)).toBe(1);
    expect(tg.screen(mark)).toEqual([]);

    // Concurrent taps on one region button (updates are sequentialized per chat).
    await pressLabel(tg, "Welkin");
    const region = tg.findButton((b) => bare(b.text) === "Indonesia");
    const size = tg.messages.size;
    mark = tg.mark();
    await Promise.all([tg.tap(region.messageId, region.button.callback_data!), tg.tap(region.messageId, region.button.callback_data!)]);
    expect(staleToasts(tg, mark)).toBe(1);
    expect(tg.screen(mark)).toEqual(["sendMessage", "deleteMessage"]);
    expect(tg.messages.size).toBe(size);
    expect(pickerBubbles(tg)).toBe(1);
    expect(denomButtons(tg).length).toBeGreaterThan(0);
  });

  it("Back after the bubble was deleted: a Back from the photo detail sends exactly one replacement, a late duplicate never adds a live bubble", async () => {
    const tg = openBot();
    await openGameList(tg);
    await pressLabel(tg, "Free Fire");
    await tg.press((b) => b.callback_data?.startsWith("v1:browse:denom:") === true);
    const detail = tg.findButton(/Back/);
    const detailMessage = structuredClone(tg.messages.get(detail.messageId)!);
    const size = tg.messages.size;
    const mark = tg.mark();
    await tg.press(/Back/);
    const screen = tg.screen(mark);
    expect(screen.filter((m) => m === "sendMessage")).toHaveLength(1);
    expect(screen.filter((m) => m === "deleteMessage")).toHaveLength(1);
    expect(screen.filter((m) => m.startsWith("edit"))).toHaveLength(0);
    expect(tg.messages.has(detail.messageId)).toBe(false);
    expect(tg.messages.size).toBe(size);
    // The deleted detail's Back tapped again (a late duplicate carrying the old bubble): still one live bubble.
    tg.messages.set(detail.messageId, detailMessage);
    const tapPromise = tg.tap(detail.messageId, detail.button.callback_data!);
    tg.messages.delete(detail.messageId);
    await tapPromise;
    expect(tg.messages.size).toBe(size);
    expect(pickerBubbles(tg)).toBe(1);
  });

  describe("fast DOUBLE taps (both updates carry the same bubble) keep the live message count constant", () => {
    const doubleTap = async (tg: FakeTelegram, match: (b: { text: string; callback_data?: string }) => boolean) => {
      const { button, messageId } = tg.findButton(match);
      await Promise.all([tg.tap(messageId, button.callback_data!), tg.tap(messageId, button.callback_data!)]);
    };

    it("on a pack picker button (text → photo detail)", async () => {
      const tg = openBot();
      await openGameList(tg);
      await pressLabel(tg, "Free Fire");
      const size = tg.messages.size;
      await doubleTap(tg, (b) => b.callback_data?.startsWith("v1:browse:denom:") === true);
      expect(tg.messages.size).toBe(size);
      expect(pickerBubbles(tg)).toBe(1);
      expect(current(tg).kind).toBe("photo");
    });

    it("on the detail's Back (photo → text pack picker)", async () => {
      const tg = openBot();
      await openGameList(tg);
      await pressLabel(tg, "Free Fire");
      await tg.press((b) => b.callback_data?.startsWith("v1:browse:denom:") === true);
      const size = tg.messages.size;
      await doubleTap(tg, (b) => /Back/.test(b.text));
      expect(tg.messages.size).toBe(size);
      expect(pickerBubbles(tg)).toBe(1);
      expect(denomButtons(tg).length).toBeGreaterThan(0);
    });

    it("on a picker's Back up to the game list (text → banner photo)", async () => {
      const tg = openBot();
      await openGameList(tg);
      await pressLabel(tg, "Genshin Impact");
      await pressLabel(tg, "Welkin");
      await pressLabel(tg, "Indonesia");
      await tg.press(/Back/); // region picker (text)
      await tg.press(/Back/); // edition picker (text)
      const size = tg.messages.size;
      await doubleTap(tg, (b) => /Back/.test(b.text));
      expect(tg.messages.size).toBe(size);
      expect(pickerBubbles(tg)).toBe(1);
      expect(atGameList(tg)).toBe(true);
    });
  });

  it("an untracked receipt's \"Buy again\" is NEVER deleted: only its keyboard is retired, one new bubble is sent", async () => {
    const tg = openBot();
    await openGameList(tg);
    await tg.sendText("/start");
    // The settled "Payment received" screen of an order nobody tracks any more (not a FulfillmentMessage, not the anchor).
    const receipt = await tg.bot.api.sendMessage(BUYER, "✅ Payment received", { reply_markup: paymentSuccessKb(EN) });
    const size = tg.messages.size;
    const mark = tg.mark();
    await tg.press((b) => b.callback_data === "v1:browse:prods");
    expect(atGameList(tg)).toBe(true);
    expect(tg.messages.has(receipt.message_id)).toBe(true);
    expect(tg.messages.get(receipt.message_id)!.inline).toEqual([]);
    expect(tg.since(mark).some((c) => c.method === "deleteMessage" && c.payload.message_id === receipt.message_id)).toBe(false);
    expect(tg.messages.size).toBe(size + 1);
  });

  it("a typed ← Back on a game's region picker edits the menu bubble up to the edition picker and deletes the typed text", async () => {
    const tg = openBot();
    await openGameList(tg);
    await pressLabel(tg, "Genshin Impact");
    await pressLabel(tg, "Crystal");
    const mark = tg.mark();
    await tg.sendText(persistentLabel("back", EN));
    // The menu bubble is the banner photo: editAnchor's text edit is refused, then its caption is edited.
    expect(tg.screen(mark)).toEqual(["editMessageText", "editMessageCaption", "deleteMessage"]);
    expect(tg.screenText()).toContain(coreT("browse.choose_variant", EN));
  });

  it("search entry: a product opened from /search keeps its pack picker and its Back returns to the results", async () => {
    const tg = openBot();
    await tg.sendText("/start");
    await tg.sendText("/search Genshin");
    const welkin = await prisma.product.findFirstOrThrow({ where: { name: "Genshin Impact Welkin Indonesia" } });
    await tg.press((b) => b.callback_data === `v1:browse:pick:${welkin.id}`);
    expect(denomButtons(tg).length).toBeGreaterThan(0);
    expect(current(tg).kind).toBe("text");
    await tg.press(/Back/);
    expect(tg.buttons().some((b) => b.callback_data === "v1:search:again")).toBe(true);
  });
});
