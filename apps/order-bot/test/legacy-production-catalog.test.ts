// setup-db MUST be first — temp DB + push before any @app import.
import "./setup-db";

/**
 * PRODUCTION-SIMULATION ACCEPTANCE CRITERIA (the regression test of the game
 * level; it was RED, 6 of 8 failing, before the game level landed).
 *
 * This file encodes the behaviour a buyer must see when the shop's catalog is
 * the one a real Digiflazz import leaves behind (tests/helpers/legacyProductionCatalog.ts:
 * one flat "Game Top Up" category, region stuffed into gameVariant, no
 * gameRegion, a shop banner and some product photos), driven through the REAL
 * `buildBot()` with the fake Telegram transport (same harness as
 * game-topup-e2e.test.ts). It reproduces the production bugs, so scenarios 1-6
 * FAIL today and become the regression test of the "game level" feature.
 * Scenario 7 (Premium Apps control) must PASS today.
 *
 * It is deliberately NOT in any always-run guard list (`test:guards`).
 *
 * Every button is read back from the keyboards the bot rendered, never written
 * here; labels are matched by their visible text because the callback shapes of
 * the not-yet-built game / region / edition levels are not known yet.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  process.env.RATE_LIMIT_MAX = "1000";
});

import { prisma, setUserPreferredCurrency, invalidateWarmUser } from "@app/db";
import { resetDb } from "../../../tests/helpers/sampleData";
import { buildLegacyProductionLikeCatalog, type LegacyCatalogIds } from "../../../tests/helpers/legacyProductionCatalog";
import { FIXTURE_BUYER_TELEGRAM_ID } from "../../../tests/helpers/gameTopupFixtures";
import { buildBot } from "../src/main";
import { invalidateRateCache } from "../src/util/rate";
import { coreT } from "../src/util/i18n";
import { FAKE_ME, FakeTelegram, type InlineButton } from "./helpers/fakeTelegram";

const BUYER = FIXTURE_BUYER_TELEGRAM_ID;
const EN = "en";

let fx: LegacyCatalogIds;
let updateSeq = 300_000;

beforeEach(async () => {
  await resetDb(prisma);
  await prisma.botSession.deleteMany();
  invalidateRateCache();
  fx = await buildLegacyProductionLikeCatalog(prisma);
  await setUserPreferredCurrency(prisma, fx.userId, "IDR");
});

afterEach(() => {
  invalidateWarmUser(fx.userId);
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

// --- reading the screen -----------------------------------------------------

/** Navigation / chrome buttons, never a content choice. */
const CHROME = /Back|Menu|Refresh|Next|Prev|‹|›|^\d+\/\d+$/;
/** A label without its leading emoji / flag / symbol. */
const bare = (text: string) => text.replace(/^[^\p{L}\p{N}]+/u, "").trim();

const choices = (tg: FakeTelegram): InlineButton[] => tg.buttons().filter((b) => b.callback_data && !CHROME.test(b.text));
const labels = (tg: FakeTelegram) => choices(tg).map((b) => bare(b.text));
const denomButtons = (tg: FakeTelegram) => tg.buttons().filter((b) => b.callback_data?.startsWith("v1:browse:denom:"));
const denomIds = (tg: FakeTelegram) => denomButtons(tg).map((b) => Number(b.callback_data!.split(":").pop()));

/** Live (sent minus deleted) bot messages that still carry a catalog picker keyboard. */
function pickerBubbles(tg: FakeTelegram): number {
  return [...tg.messages.values()].filter((m) => m.inline.flat().some((b) => b.callback_data?.startsWith("v1:browse:"))).length;
}

/** The message currently holding the newest inline keyboard (what the buyer is looking at). */
function currentBubble(tg: FakeTelegram) {
  const { messageId } = tg.findButton(() => true);
  return { messageId, message: tg.messages.get(messageId)! };
}

const FLAG = "(?:[\\u{1F1E6}-\\u{1F1FF}]{2}|\\u{1F310}|\\p{Extended_Pictographic}\\uFE0F?)";
const regionLabel = (name: string) => new RegExp(`^${FLAG}\\s+${name}$`, "u");

// --- navigation (strict, desired path) --------------------------------------

/** /start → Products → Game Top Up (→ the category, if a category picker is shown). */
async function openGameList(tg: FakeTelegram) {
  await tg.sendText("/start");
  await tg.pressReply(/Products/);
  await tg.press(/Game Top Up/);
  // One GAME_TOPUP category is auto-skipped; if a category picker is still showing, enter it.
  if (tg.buttons().some((b) => b.callback_data?.startsWith("v1:browse:cat:"))) await tg.press(/Game Top Up/);
}

const pressExact = (tg: FakeTelegram, name: string | RegExp) =>
  tg.press((b) => (typeof name === "string" ? bare(b.text).toLowerCase() === name.toLowerCase() : name.test(b.text)));

// "Delta Force Garena" is NOT forbidden: a publisher word is never a region or
// an edition of another game, so a different publisher's edition stays its own
// game (owner rule, plan "game beda penerbit tidak digabung"; pinned by
// packages/core/src/gameIdentity.test.ts "keeps a type-split publisher edition
// apart from the base game").
const FORBIDDEN_AS_GAME = /MOBILE LEGENDS (Indonesia|Malaysia|Russia)|Mobile Legends \((BR|PH)\)|Mobile Legends Global|Arena Breakout Infinite|Valorant Malaysia/i;

/** Game list → Mobile Legends → a region → that region's pack picker. */
async function openMlPacks(tg: FakeTelegram, region: string) {
  await openGameList(tg);
  await pressExact(tg, "Mobile Legends");
  await pressExact(tg, regionLabel(region));
}

describe("production legacy catalog (acceptance)", () => {
  it("1. Game Top Up shows a GAME list: one button per game, never one per imported product", async () => {
    const tg = openBot();
    await openGameList(tg);

    const shown = labels(tg);
    expect.soft(shown.filter((l) => FORBIDDEN_AS_GAME.test(l))).toEqual([]);
    expect([...shown].sort()).toEqual(
      ["Arena Breakout", "Delta Force", "Delta Force Garena", "Free Fire", "Growtopia", "Mobile Legends", "Valorant", "Where Winds Meet"].sort(),
    );
  });

  it("2. Mobile Legends opens a flag-prefixed REGION picker; a region opens that region's packs", async () => {
    const tg = openBot();
    await openGameList(tg);
    await pressExact(tg, "Mobile Legends");

    expect(tg.screenText()).toContain(coreT("browse.choose_region", EN));
    expect(tg.screenText()).not.toContain(coreT("browse.choose_variant", EN));
    const shown = choices(tg).map((b) => b.text);
    for (const region of ["Indonesia", "Malaysia", "Russia", "Brazil", "Philippines", "Global"]) {
      expect(shown.filter((l) => regionLabel(region).test(l)), `region button for ${region} in ${JSON.stringify(shown)}`).toHaveLength(1);
    }
    expect(shown).toHaveLength(6);
    expect(denomButtons(tg)).toHaveLength(0);

    await pressExact(tg, regionLabel("Indonesia"));
    const ids = denomIds(tg);
    expect(ids.length).toBeGreaterThan(0);
    const indonesia = new Set(fx.denominations["MOBILE LEGENDS Indonesia"]);
    expect(ids.every((id) => indonesia.has(id))).toBe(true);
    const other = new Set(["MOBILE LEGENDS Malaysia", "MOBILE LEGENDS Russia", "Mobile Legends (BR)", "Mobile Legends (PH)", "Mobile Legends Global"].flatMap((n) => fx.denominations[n]!));
    expect(ids.some((id) => other.has(id))).toBe(false);
  });

  it("3. editions are per game (Arena Breakout: Umum / Infinite) and Malaysia is never an edition", async () => {
    const tg = openBot();
    await openGameList(tg);
    // No edition appears at the game level ("Delta Force Garena" is a game of
    // its own, a different publisher, see FORBIDDEN_AS_GAME).
    expect.soft(labels(tg).filter((l) => /Umum|Infinite/i.test(l))).toEqual([]);

    await pressExact(tg, "Arena Breakout");
    expect(tg.screenText()).toContain(coreT("browse.choose_variant", EN));
    expect(labels(tg).sort()).toEqual(["Infinite", "Umum"]);
    await pressExact(tg, "Infinite");
    const infinite = new Set(fx.denominations["Arena Breakout Infinite"]);
    expect(denomIds(tg).length).toBeGreaterThan(0);
    expect(denomIds(tg).every((id) => infinite.has(id))).toBe(true);

    // Valorant's "Malaysia" is a region, never an edition.
    await openGameList(tg);
    await pressExact(tg, "Valorant");
    expect(tg.screenText()).not.toContain(coreT("browse.choose_variant", EN));
    const regionPicker = tg.screenText().includes(coreT("browse.choose_region", EN));
    if (regionPicker) expect(choices(tg).some((b) => regionLabel("Malaysia").test(b.text))).toBe(true);
    else expect(denomIds(tg).length).toBeGreaterThan(0);
  });

  it("4. the pack picker is a TEXT message (no product photo); the photo appears only on the pack detail", async () => {
    const tg = openBot();
    await openMlPacks(tg, "Indonesia"); // this product has a photo
    expect(denomButtons(tg).length).toBeGreaterThan(0);
    expect(currentBubble(tg).message.kind).toBe("text");

    await tg.press((b) => b.callback_data?.startsWith("v1:browse:denom:") === true);
    expect(currentBubble(tg).message.kind).toBe("photo");
  });

  /**
   * Repeats `enter` → drill into Mobile Legends (region / edition pickers, a pack
   * picker, one pack detail) → Back out, four times, and reports the live bot
   * message count and the peak number of picker bubbles after each cycle. The
   * drill is path-agnostic (it presses whatever the screen offers), so it
   * measures both today's flat list and the future game level.
   */
  async function stackingRun(tg: FakeTelegram, enter: () => Promise<void>, atStart: () => boolean, backsToStart: number) {
    const baseline = tg.messages.size;
    const sizes: number[] = [];
    const maxPickers: number[] = [];
    const stuck: string[] = [];

    // The game list is recognised by a game that is neither the first nor an edition/region row.
    const atGameList = () => labels(tg).includes("Where Winds Meet");
    for (let cycle = 0; cycle < 4; cycle++) {
      let peak = pickerBubbles(tg);
      const note = () => {
        peak = Math.max(peak, pickerBubbles(tg));
      };
      try {
        await enter();
        note();
        if (!atGameList()) throw new Error("the game list did not open");
        // Drill down: the game, then region / edition pickers, until a pack picker (denomination buttons) shows.
        let depth = 0;
        await tg.press((b) => /mobile legends/i.test(b.text));
        depth += 1;
        note();
        for (let i = 0; i < 3 && denomButtons(tg).length === 0; i++) {
          const options = choices(tg);
          const pick = options.find((b) => /indonesia/i.test(b.text)) ?? options[0]!;
          await tg.press((b) => b.text === pick.text);
          depth += 1;
          note();
        }
        // Open one pack's detail too (the product photo bubble), then Back out to the game list.
        if (denomButtons(tg).length > 0) {
          await tg.press((b) => b.callback_data?.startsWith("v1:browse:denom:") === true);
          depth += 1;
          note();
        }
        let backs = 0;
        while (backs < depth + backsToStart + 2 && !atStart()) {
          await tg.press(/Back/);
          backs += 1;
          note();
        }
        if (!atStart()) stuck.push(`cycle ${cycle}: never returned to the start screen`);
        else if (backs !== depth + backsToStart) stuck.push(`cycle ${cycle}: ${depth + backsToStart} taps down needed ${backs} Backs up`);
      } catch (err) {
        stuck.push(`cycle ${cycle}: ${(err as Error).message.slice(0, 160)}`);
      }
      sizes.push(tg.messages.size);
      maxPickers.push(peak);
      if (!atStart()) break;
    }
    return { baseline, stuck, sizes, maxPickers };
  }

  it("5a. no stacking inside a game: game → region → pack → detail → Back… keeps the live bot-message count constant, one picker bubble at most", async () => {
    const tg = openBot();
    await openGameList(tg);
    const run = await stackingRun(tg, async () => {}, () => labels(tg).includes("Where Winds Meet"), 0);
    expect({ stuck: run.stuck, sizes: run.sizes, maxPickers: run.maxPickers }).toEqual({
      stuck: [],
      sizes: [run.baseline, run.baseline, run.baseline, run.baseline],
      maxPickers: [1, 1, 1, 1],
    });
  });

  it("5b. no stacking from the service picker: Game Top Up → game → region → pack → Back all the way up, four times", async () => {
    const tg = openBot();
    await tg.sendText("/start");
    await tg.pressReply(/Products/);
    const atServices = () => tg.buttons().some((b) => /Game Top Up/.test(b.text)) && tg.buttons().some((b) => /Premium Apps/.test(b.text));
    expect(atServices()).toBe(true);
    const run = await stackingRun(
      tg,
      async () => {
        await tg.press(/Game Top Up/);
        if (tg.buttons().some((b) => b.callback_data?.startsWith("v1:browse:cat:"))) await tg.press(/Game Top Up/);
      },
      atServices,
      1,
    );
    expect({ stuck: run.stuck, sizes: run.sizes, maxPickers: run.maxPickers }).toEqual({
      stuck: [],
      sizes: [run.baseline, run.baseline, run.baseline, run.baseline],
      maxPickers: [1, 1, 1, 1],
    });
  });

  it("6. a two-page pack picker shows a page indicator between the arrows", async () => {
    const tg = openBot();
    await openMlPacks(tg, "Indonesia");
    expect(fx.denominations["MOBILE LEGENDS Indonesia"]!.length).toBeGreaterThan(20);

    const pagerRow = () => currentBubble(tg).message.inline.find((row) => row.some((b) => /^\d+\/\d+$/.test(b.text)));
    const first = pagerRow();
    expect(first?.map((b) => b.text)).toEqual(["1/2", "›"]);

    await tg.press(/^›$/);
    expect(pagerRow()?.map((b) => b.text)).toEqual(["‹", "2/2"]);
  });

  it("7. control: Premium Apps in the same database keeps the numbered list and plan picker", async () => {
    const tg = openBot();
    await tg.sendText("/start");
    await tg.pressReply(/Products/);
    await tg.press(/Premium Apps/);

    // Numbered list in the text, not one inline button per product.
    const listText = tg.screenText();
    expect(listText).toContain("Vidio Platinum");
    expect(listText).toContain("Spotify Premium");
    expect(tg.buttons().filter((b) => b.callback_data?.startsWith("v1:browse:pick:"))).toHaveLength(0);

    await tg.sendText("1");
    expect(tg.screenText()).toContain("Choose a plan:");
    expect(tg.buttons().filter((b) => b.callback_data?.startsWith("v1:browse:denom:")).map((b) => b.text)).toEqual(["1 Month", "3 Months"]);
  });
});
