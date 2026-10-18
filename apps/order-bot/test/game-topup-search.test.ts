// setup-db MUST be first — temp DB + push before any @app import.
import "./setup-db";

import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { prisma, setSetting, createCatalogProduct, createCategory, createDenomination, upsertUser, KNOWLEDGE_REVISION_KEY } from "@app/db";
import { CategoryGroup } from "@app/core/enums";
import { MAX_LABEL_WIDTH, visualWidth } from "@app/core/buttonLimits";
import { buildSampleData, resetDb, type SampleData } from "../../../tests/helpers/sampleData";
import { makeCtx, calls, lastMarkup, sentIncludes, type SentCall } from "./helpers/ctx";
import type { SessionData } from "../src/context";
import * as customer from "../src/handlers/customer";
import { routeCallback } from "../src/handlers/callbacks";
import { enterConversation } from "../src/conversations";
import { searchResultsKb } from "../src/keyboards/customer";
import { t } from "../src/util/i18n";

// Game Top-up search (Phase 2, Task 6), gated by game_topup_flow_v2_enabled:
// service-tagged results, Game-only scope, paging from a session snapshot, the
// "Search again" mode, and the exact Telegram call counts. Fixtures are in-test.

const FLAG = "game_topup_flow_v2_enabled";
const TAG = "Zqx";

let sample: SampleData;

beforeEach(async () => {
  await resetDb(prisma);
  sample = await buildSampleData(prisma);
  await upsertUser(prisma, { telegramId: 999, username: "boss", fullName: "Admin Boss" });
});

afterAll(async () => {
  await prisma.$disconnect();
});

function newSession(lang: "en" | "id" = "en"): SessionData {
  return {
    lang,
    scratch: {},
    dbUser: {
      id: sample.user.id,
      telegramId: String(sample.user.telegramId),
      role: sample.user.role as never,
      language: sample.user.language,
      referralCode: sample.user.referralCode,
      walletBalance: String(sample.user.walletBalance),
      preferredCurrency: null,
    },
  } as unknown as SessionData;
}

/** One update of a chat that keeps a single session across calls, like the real bot. */
function update(session: SessionData, opts: Parameters<typeof makeCtx>[0] = {}) {
  return makeCtx({ from: { id: 42, username: "tester" }, sharedSession: session, ...opts });
}

async function addProduct(categoryId: number, name: string) {
  const p = await createCatalogProduct(prisma, { categoryId, name });
  await createDenomination(prisma, { productId: p.id, name: "Pack", type: "SHARED", durationLabel: "Pack", price: "10000" });
  return p;
}

async function seed(opts: { games?: string[]; premium?: string[] } = {}) {
  const game = await createCategory(prisma, { name: "Search Games", group: CategoryGroup.GAME_TOPUP });
  const premium = await createCategory(prisma, { name: "Search Apps", group: CategoryGroup.PREMIUM_APPS });
  const games = [];
  for (const name of opts.games ?? [`${TAG} Legends`]) games.push(await addProduct(game.id, name));
  const apps = [];
  for (const name of opts.premium ?? []) apps.push(await addProduct(premium.id, name));
  return { game, premium, games, apps };
}

interface Button {
  text: string;
  callback_data: string;
}
function buttons(sink: SentCall[]): Button[] {
  return ((lastMarkup(sink)?.inline_keyboard ?? []).flat() as Button[]);
}
function screenText(sink: SentCall[]): string {
  const api = calls(sink, "editMessageText").at(-1);
  const reply = calls(sink, "reply").at(-1);
  const call = api ?? reply!;
  return String(call.method === "reply" ? call.args[0] : call.args.find((a) => typeof a === "string" && a.length > 12) ?? call.args[0]);
}
const runSearch = (session: SessionData, q: string) => {
  const u = update(session, { match: q });
  return customer.searchCommand(u.ctx).then(() => u);
};

describe("flag ON", () => {
  beforeEach(async () => {
    await setSetting(prisma, FLAG, "true");
  });

  it("lists only Game Top Up products, each tagged with its service, in one message", async () => {
    await seed({ games: [`${TAG} Legends`], premium: [`${TAG} Plus App`] });
    const { ctx, sink } = await runSearch(newSession(), TAG);
    const btns = buttons(sink);
    const picks = btns.filter((b) => b.callback_data.startsWith("v1:browse:pick:"));
    expect(picks).toHaveLength(1);
    const tag = t(ctx, "browse.group_game_topup");
    expect(picks[0]!.text).toBe(`${TAG} Legends · ${tag}`);
    expect(sentIncludes(sink, "Plus App")).toBe(false);
    expect(screenText(sink)).toBe(`${t(ctx, "search.results", { query: TAG, count: 1 })}\n${t(ctx, "hint.search")}`);
    expect(calls(sink, "reply")).toHaveLength(1);
    expect(calls(sink, "sendMessage")).toHaveLength(0);
    expect(calls(sink, "deleteMessage")).toHaveLength(0);
    expect(calls(sink, "editMessageText")).toHaveLength(0);
  });

  it("keeps labels within the phone width and callback data within 64 bytes", async () => {
    await seed({ games: [`${TAG} ${"Very Long Game Name ".repeat(4)}`, `${TAG} 日本語のとても長いゲームの名前です`], premium: [] });
    const { sink } = await runSearch(newSession("id"), TAG);
    for (const b of buttons(sink)) {
      expect(visualWidth(b.text)).toBeLessThanOrEqual(MAX_LABEL_WIDTH);
      expect(Buffer.byteLength(b.callback_data, "utf8")).toBeLessThanOrEqual(64);
    }
  });

  it("ranks an exact name before a prefix before a substring", async () => {
    await seed({ games: [`Big ${TAG} Quest`, `${TAG} Zeta`, `${TAG} Alpha`, TAG] });
    const { sink } = await runSearch(newSession(), TAG.toLowerCase());
    const names = buttons(sink).filter((b) => b.callback_data.startsWith("v1:browse:pick:")).map((b) => b.text.split(" · ")[0]);
    expect(names).toEqual([TAG, `${TAG} Alpha`, `${TAG} Zeta`, `Big ${TAG} Quest`]);
  });

  it("pages the snapshot with Prev/Next, editing the same bubble each time", async () => {
    const names = Array.from({ length: 12 }, (_, i) => `${TAG} Game ${String(i + 1).padStart(2, "0")}`);
    await seed({ games: names });
    const session = newSession();
    const first = await runSearch(session, TAG);
    const firstButtons = buttons(first.sink);
    expect(firstButtons.filter((b) => b.callback_data.startsWith("v1:browse:pick:"))).toHaveLength(10);
    expect(firstButtons.map((b) => b.callback_data)).toContain("v1:search:page:1");
    expect(firstButtons.map((b) => b.callback_data)).not.toContain("v1:search:page:-1");

    const next = update(session, { callbackData: "v1:search:page:1" });
    await routeCallback(next.ctx);
    const nextButtons = buttons(next.sink);
    expect(nextButtons.filter((b) => b.callback_data.startsWith("v1:browse:pick:"))).toHaveLength(2);
    expect(nextButtons.map((b) => b.callback_data)).toContain("v1:search:page:0");
    expect(nextButtons.map((b) => b.callback_data)).not.toContain("v1:search:page:2");
    expect(calls(next.sink, "editMessageText")).toHaveLength(1);
    expect(calls(next.sink, "reply")).toHaveLength(0);
    expect(calls(next.sink, "sendMessage")).toHaveLength(0);
    expect(calls(next.sink, "deleteMessage")).toHaveLength(0);

    const prev = update(session, { callbackData: "v1:search:page:0" });
    await routeCallback(prev.ctx);
    expect(buttons(prev.sink).filter((b) => b.callback_data.startsWith("v1:browse:pick:"))).toHaveLength(10);
    expect(calls(prev.sink, "editMessageText")).toHaveLength(1);
  });

  it("answers a stale or out-of-range page tap with the stale-screen toast and renders nothing", async () => {
    await seed({ games: [`${TAG} One`] });
    const noSnapshot = update(newSession(), { callbackData: "v1:search:page:1" });
    await routeCallback(noSnapshot.ctx);
    expect(sentIncludes(noSnapshot.sink, t(noSnapshot.ctx, "error.stale_screen"))).toBe(true);
    expect(calls(noSnapshot.sink, "editMessageText")).toHaveLength(0);
    expect(calls(noSnapshot.sink, "reply")).toHaveLength(0);

    const session = newSession();
    await runSearch(session, TAG);
    for (const data of ["v1:search:page:5", "v1:search:page:-1", "v1:search:page:x", "v1:search:bogus"]) {
      const u = update(session, { callbackData: data });
      await routeCallback(u.ctx);
      expect(sentIncludes(u.sink, t(u.ctx, "error.stale_screen"))).toBe(true);
      expect(calls(u.sink, "editMessageText")).toHaveLength(0);
    }
  });

  it("shows the empty state with its hint and a Search again button", async () => {
    await seed({ games: [`${TAG} Legends`] });
    const { ctx, sink } = await runSearch(newSession(), "nothingmatches");
    expect(sentIncludes(sink, t(ctx, "search.no_results", { query: "nothingmatches" }))).toBe(true);
    expect(sentIncludes(sink, t(ctx, "hint.search_empty"))).toBe(true);
    expect(buttons(sink).map((b) => b.callback_data)).toEqual(["v1:search:again", "v1:menu:main"]);
    expect(calls(sink, "reply")).toHaveLength(1);
  });

  it("finds a product through an admin-defined alias (case and spacing insensitive)", async () => {
    await seed({ games: [`${TAG} Legends`] });
    await prisma.detectionAlias.create({ data: { alias: "zq lg", expandsTo: `${TAG} Legends`, reason: "test" } });
    await setSetting(prisma, KNOWLEDGE_REVISION_KEY, String(Date.now()));
    const { sink } = await runSearch(newSession(), "  ZQ    LG ");
    expect(buttons(sink).filter((b) => b.callback_data.startsWith("v1:browse:pick:"))).toHaveLength(1);
  });

  describe("Search again mode", () => {
    async function armed() {
      await seed({ games: [`${TAG} Legends`, `${TAG} Quest`] });
      const session = newSession();
      // The results bubble the buyer taps Search again on.
      await runSearch(session, TAG);
      const again = update(session, { callbackData: "v1:search:again", cbMessage: { message_id: 555, chat: { id: 42, type: "private" }, date: 0 } });
      await routeCallback(again.ctx);
      return { session, again };
    }

    it("edits the bubble into the prompt and arms exactly the next typed text", async () => {
      const { session, again } = await armed();
      expect(screenText(again.sink)).toBe(t(again.ctx, "hint.search"));
      expect(calls(again.sink, "editMessageText")).toHaveLength(1);
      expect(calls(again.sink, "reply")).toHaveLength(0);
      expect(session.scratch.searchAwaiting).toBe(true);

      const typed = update(session, { text: `${TAG} Quest` });
      await customer.handleProductNumber(typed.ctx);
      // One delete of the typed query, one edit of the prompt bubble, nothing new sent.
      expect(calls(typed.sink, "deleteMessage")).toHaveLength(1);
      expect(calls(typed.sink, "editMessageText")).toHaveLength(1);
      expect(calls(typed.sink, "editMessageText")[0]!.args[1]).toBe(555);
      expect(calls(typed.sink, "reply")).toHaveLength(0);
      expect(calls(typed.sink, "sendMessage")).toHaveLength(0);
      expect(buttons(typed.sink).filter((b) => b.callback_data.startsWith("v1:browse:pick:"))).toHaveLength(1);
      expect(session.scratch.searchAwaiting).toBeUndefined();

      // The mode was one-shot: the next text is ordinary free text again.
      const later = update(session, { text: "hello there" });
      await customer.handleProductNumber(later.ctx);
      expect(later.sink).toEqual([]);
    });

    it("is ended by any other tap, so a later text is not a query", async () => {
      const { session } = await armed();
      const tap = update(session, { callbackData: "v1:search:page:9" });
      await routeCallback(tap.ctx);
      expect(session.scratch.searchAwaiting).toBeUndefined();
      const typed = update(session, { text: `${TAG} Quest` });
      await customer.handleProductNumber(typed.ctx);
      expect(typed.sink).toEqual([]);
    });

    it("is ended by entering a conversation (support, ticket reply, voucher), so a later text is not a query", async () => {
      const { session } = await armed();
      const enter = update(session, { callbackData: "v1:support:open" });
      const entered: string[] = [];
      (enter.ctx as unknown as { conversation: { enter: (n: string) => Promise<void> } }).conversation = { enter: async (n) => { entered.push(n); } };
      await enterConversation(enter.ctx, "support");
      expect(entered).toEqual(["support"]);
      expect(session.scratch.searchAwaiting).toBeUndefined();
      expect(enter.sink).toEqual([]);

      const typed = update(session, { text: `${TAG} Quest` });
      await customer.handleProductNumber(typed.ctx);
      expect(typed.sink).toEqual([]);
    });

    it("is ended by a screen render such as /listproduk", async () => {
      const { session } = await armed();
      await customer.listprodukCommand(update(session).ctx);
      expect(session.scratch.searchAwaiting).toBeUndefined();
    });

    it("does not swallow a numbered-list digit", async () => {
      const { session } = await armed();
      const typed = update(session, { text: "3" });
      await customer.handleProductNumber(typed.ctx);
      expect(session.scratch.searchAwaiting).toBeUndefined();
      expect(calls(typed.sink, "deleteMessage")).toHaveLength(0);
      expect(sentIncludes(typed.sink, "Results for")).toBe(false);
    });

    it("does not swallow a reply-keyboard label", async () => {
      const { session } = await armed();
      const typed = update(session, { text: t(update(session).ctx, "menu.wallet") });
      await customer.handleProductNumber(typed.ctx);
      expect(session.scratch.searchAwaiting).toBeUndefined();
      expect(calls(typed.sink, "deleteMessage")).toHaveLength(0);
      expect(sentIncludes(typed.sink, "Results for")).toBe(false);
    });
  });

  it("a bare /search shows the usage and prompt in one message and arms the next text", async () => {
    await seed();
    const session = newSession();
    const { ctx, sink } = await runSearch(session, "");
    expect(screenText(sink)).toBe(`${t(ctx, "search.no_query")}\n${t(ctx, "hint.search")}`);
    expect(calls(sink, "reply")).toHaveLength(1);
    expect(session.scratch.searchAwaiting).toBe(true);
  });
});

describe("flag OFF", () => {
  it.each([["unset", null], ["false", "false"]])("(%s) /search keeps today's results, keyboard and call count", async (_label, value) => {
    if (value !== null) await setSetting(prisma, FLAG, value);
    const { games, apps } = await seed({ games: [`${TAG} Legends`], premium: [`${TAG} Plus App`] });
    const session = newSession();
    const { ctx, sink } = await runSearch(session, TAG);
    const picks = buttons(sink).filter((b) => b.callback_data.startsWith("v1:browse:pick:"));
    expect(picks.map((b) => b.text)).toEqual([`${TAG} Legends`, `${TAG} Plus App`]);
    expect(buttons(sink)).toEqual(
      searchResultsKb([{ id: games[0]!.id, name: games[0]!.name }, { id: apps[0]!.id, name: apps[0]!.name }], "en")
        .inline_keyboard.flat()
        .map((b) => ({ text: b.text, callback_data: (b as { callback_data: string }).callback_data })),
    );
    expect(screenText(sink)).toBe(t(ctx, "search.results", { query: TAG, count: 2 }));
    expect(sentIncludes(sink, t(ctx, "hint.search"))).toBe(false);
    expect(sentIncludes(sink, "v1:search:")).toBe(false);
    expect(calls(sink, "reply")).toHaveLength(1);
    expect(calls(sink, "editMessageText")).toHaveLength(0);
    expect(calls(sink, "deleteMessage")).toHaveLength(0);
    expect(session.scratch.searchSnapshot).toBeUndefined();
  });

  it("a bare /search keeps the usage text and does not arm a mode; Search again is a stale tap", async () => {
    await seed();
    const session = newSession();
    const { ctx, sink } = await runSearch(session, "");
    expect(screenText(sink)).toBe(t(ctx, "search.no_query"));
    expect(session.scratch.searchAwaiting).toBeUndefined();

    const tap = update(session, { callbackData: "v1:search:again" });
    await routeCallback(tap.ctx);
    expect(sentIncludes(tap.sink, t(tap.ctx, "error.stale_screen"))).toBe(true);
    expect(calls(tap.sink, "editMessageText")).toHaveLength(0);
    expect(session.scratch.searchAwaiting).toBeUndefined();
  });
});
