// setup-db MUST be first — temp DB + push before any @app import.
import "./setup-db";

import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { prisma, upsertUser, setUserLanguage, setUserPreferredCurrency, getUser } from "@app/db";
import { t as coreT } from "@app/core/i18n";
import { buildSampleData, resetDb } from "../../../tests/helpers/sampleData";
import { BotState, initialSession, type MyContext, type SessionData } from "../src/context";
import { registeredUser, requireCurrency } from "../src/middleware";
import { routeCallback } from "../src/handlers/callbacks";
import * as customer from "../src/handlers/customer";
import * as ckb from "../src/keyboards/customer";
import { makeCtx, sentIncludes, lastMarkup, type MakeCtxOptions } from "./helpers/ctx";

/**
 * Task 3a — currency onboarding: /start → language → currency, the `cur:`
 * callbacks, and the requireCurrency guard, driven through the REAL
 * registeredUser + requireCurrency middleware pair so the session snapshot,
 * warm cache and guard all behave as they do in production.
 */

// Unique telegram id per test: the warm-user cache is process-wide and keyed
// by telegram id, so reusing one across resetDb() would serve a stale row id.
let tgSeq = 7_700_000;
const nextTgId = () => ++tgSeq;

const ADMIN_TG_ID = 999; // setup-db.ts sets ADMIN_IDS=999,1000

function freshSession(): SessionData {
  return { ...initialSession(), state: BotState.HOME, lang: "en", scratch: {} };
}

interface Step {
  reached: boolean;
  sink: ReturnType<typeof makeCtx>["sink"];
  ctx: MyContext;
}

/** Route an update the way main.ts would, after the middleware pair. */
async function route(ctx: MyContext): Promise<void> {
  if (ctx.callbackQuery) return routeCallback(ctx);
  if (!ctx.message?.text || ctx.chat?.type !== "private") return;
  const text = ctx.message.text;
  if (/^\/start\b/.test(text)) return customer.startCommand(ctx);
  if (/^\/language\b/.test(text)) return customer.languageCommand(ctx);
  if (/^\/menu\b/.test(text)) return customer.menuCommand(ctx);
  return customer.handleProductNumber(ctx);
}

async function send(tgId: number, session: SessionData, opts: MakeCtxOptions): Promise<Step> {
  const { ctx, sink } = makeCtx({ from: { id: tgId, username: `u${tgId}`, first_name: "T" }, sharedSession: session, ...opts });
  let reached = false;
  await registeredUser(ctx, async () => {
    await requireCurrency(ctx, async () => {
      reached = true;
      await route(ctx);
    });
  });
  return { reached, sink, ctx };
}

const tap = (tgId: number, s: SessionData, data: string) => send(tgId, s, { callbackData: data });
const say = (tgId: number, s: SessionData, text: string, match?: string) => send(tgId, s, { text, match });

async function dbUserByTg(tgId: number) {
  return prisma.user.findUniqueOrThrow({ where: { telegramId: BigInt(tgId) } });
}

/** An existing user from before this feature: row exists, currency NULL. */
async function makeLegacyUser(tgId: number, language: "en" | "id") {
  const u = await upsertUser(prisma, { telegramId: tgId, username: `u${tgId}`, fullName: "T" });
  await setUserLanguage(prisma, u.id, language);
  return u;
}

const blockedText = (lang: string) => coreT("currency.required", lang);
const isMainMenu = (sink: Step["sink"]) => {
  const m = lastMarkup(sink) as { keyboard?: unknown[][] } | undefined;
  return Array.isArray(m?.keyboard);
};

describe("currency onboarding — /start → language → currency", () => {
  beforeEach(async () => {
    await resetDb(prisma);
  });
  afterAll(async () => {
    await prisma.$disconnect();
  });

  it.each([
    ["en", "USD"],
    ["id", "IDR"],
    ["en", "IDR"],
    ["id", "USD"],
  ] as const)("new user picks language %s then currency %s — both persist independently", async (lang, cur) => {
    const tg = nextTgId();
    const s = freshSession();

    const start = await say(tg, s, "/start", "");
    expect(start.reached).toBe(true);
    expect(s.onboarding).toBe("language");
    expect(sentIncludes(start.sink, ckb.cb("lang", "set", "en"))).toBe(true);
    expect(sentIncludes(start.sink, coreT("language.choose", "en"))).toBe(true);

    const langTap = await tap(tg, s, ckb.cb("lang", "set", lang));
    expect(langTap.reached).toBe(true);
    expect(s.onboarding).toBe("currency");
    expect(sentIncludes(langTap.sink, ckb.cb("cur", "set", "USD"))).toBe(true);
    expect(sentIncludes(langTap.sink, ckb.cb("cur", "set", "IDR"))).toBe(true);
    expect(sentIncludes(langTap.sink, coreT("currency.choose", lang))).toBe(true);
    expect(isMainMenu(langTap.sink)).toBe(false);

    const curTap = await tap(tg, s, ckb.cb("cur", "set", cur));
    expect(curTap.reached).toBe(true);
    expect(s.onboarding).toBeNull();
    expect(s.dbUser?.preferredCurrency).toBe(cur);
    expect(sentIncludes(curTap.sink, coreT("currency.set", lang))).toBe(true);
    expect(isMainMenu(curTap.sink)).toBe(true);

    const row = await dbUserByTg(tg);
    expect(row.preferredCurrency).toBe(cur);
    expect(row.language).toBe(lang.toUpperCase());
  });

  it("an existing configured user (USD) re-running /start can switch to IDR without a duplicate row", async () => {
    const tg = nextTgId();
    const u = await makeLegacyUser(tg, "en");
    await setUserPreferredCurrency(prisma, u.id, "USD");
    const s = freshSession();

    await say(tg, s, "/start", "");
    expect(s.onboarding).toBe("language");
    await tap(tg, s, ckb.cb("lang", "set", "en"));
    await tap(tg, s, ckb.cb("cur", "set", "IDR"));

    expect((await getUser(prisma, u.id))?.preferredCurrency).toBe("IDR");
    expect(await prisma.user.count({ where: { telegramId: BigInt(tg) } })).toBe(1);
    expect(s.onboarding).toBeNull();
  });

  it("a /start prod_<id> deep link is remembered and opened once onboarding completes", async () => {
    const sample = await buildSampleData(prisma);
    const tg = nextTgId();
    const s = freshSession();

    const start = await say(tg, s, `/start prod_${sample.product.id}`, `prod_${sample.product.id}`);
    expect(s.onboarding).toBe("language");
    expect(sentIncludes(start.sink, "Netflix Premium 1M")).toBe(false);

    await tap(tg, s, ckb.cb("lang", "set", "en"));
    const cur = await tap(tg, s, ckb.cb("cur", "set", "USD"));
    expect(sentIncludes(cur.sink, "Netflix Premium 1M")).toBe(true);
    expect(s.pendingDeepLinkDenomId).toBeUndefined();
  });

  it("/language outside onboarding keeps its old behaviour (main menu, no currency step)", async () => {
    const tg = nextTgId();
    const u = await makeLegacyUser(tg, "en");
    await setUserPreferredCurrency(prisma, u.id, "USD");
    const s = freshSession();

    const langTap = await tap(tg, s, ckb.cb("lang", "set", "id"));
    expect(langTap.reached).toBe(true);
    expect(s.onboarding ?? null).toBeNull();
    expect(isMainMenu(langTap.sink)).toBe(true);
    expect(sentIncludes(langTap.sink, ckb.cb("cur", "set", "USD"))).toBe(false);
  });

  it("an old persisted session without the onboarding field behaves as not onboarding", async () => {
    const tg = nextTgId();
    const u = await makeLegacyUser(tg, "en");
    await setUserPreferredCurrency(prisma, u.id, "USD");
    const s = { state: BotState.HOME, lang: "en", scratch: {} } as SessionData; // pre-feature shape
    const langTap = await tap(tg, s, ckb.cb("lang", "set", "en"));
    expect(isMainMenu(langTap.sink)).toBe(true);
  });
});

describe("cur:set callback edge cases", () => {
  beforeEach(async () => {
    await resetDb(prisma);
  });

  it.each(["EUR", "usd"])("rejects v1:cur:set:%s and leaves the DB unchanged", async (bad) => {
    const tg = nextTgId();
    const u = await makeLegacyUser(tg, "en");
    await setUserPreferredCurrency(prisma, u.id, "USD");
    const s = freshSession();

    const r = await tap(tg, s, `v1:cur:set:${bad}`);
    expect(sentIncludes(r.sink, coreT("error.stale_screen", "en"))).toBe(true);
    expect((await getUser(prisma, u.id))?.preferredCurrency).toBe("USD");
    expect(s.dbUser?.preferredCurrency).toBe("USD");
  });

  it("rejects an invalid code mid-onboarding without leaving the currency step", async () => {
    const tg = nextTgId();
    const s = freshSession();
    await say(tg, s, "/start", "");
    await tap(tg, s, ckb.cb("lang", "set", "en"));
    const r = await tap(tg, s, "v1:cur:set:EUR");
    expect(sentIncludes(r.sink, coreT("error.stale_screen", "en"))).toBe(true);
    expect(s.onboarding).toBe("currency");
    expect((await dbUserByTg(tg)).preferredCurrency).toBeNull();
  });

  it("a double tap of cur:set:USD reaches the same end state", async () => {
    const tg = nextTgId();
    const s = freshSession();
    await say(tg, s, "/start", "");
    await tap(tg, s, ckb.cb("lang", "set", "en"));
    await tap(tg, s, ckb.cb("cur", "set", "USD"));
    const second = await tap(tg, s, ckb.cb("cur", "set", "USD"));
    expect(second.reached).toBe(true);
    expect(s.onboarding).toBeNull();
    expect((await dbUserByTg(tg)).preferredCurrency).toBe("USD");
    expect(await prisma.user.count({ where: { telegramId: BigInt(tg) } })).toBe(1);
    expect(isMainMenu(second.sink)).toBe(true);
  });

  it("a stale cur:set:IDR tap outside onboarding updates the currency and re-renders the main menu", async () => {
    const tg = nextTgId();
    const u = await makeLegacyUser(tg, "en");
    await setUserPreferredCurrency(prisma, u.id, "USD");
    const s = freshSession();
    const r = await tap(tg, s, ckb.cb("cur", "set", "IDR"));
    expect(r.reached).toBe(true);
    expect(s.onboarding ?? null).toBeNull();
    expect((await getUser(prisma, u.id))?.preferredCurrency).toBe("IDR");
    expect(isMainMenu(r.sink)).toBe(true);
  });
});

describe("requireCurrency guard", () => {
  beforeEach(async () => {
    await resetDb(prisma);
  });

  it("blocks an existing user with no currency on a normal callback and a persistent-keyboard tap, until onboarding completes", async () => {
    const tg = nextTgId();
    await makeLegacyUser(tg, "id");
    const s = freshSession();

    const cbTap = await tap(tg, s, ckb.cb("menu", "main"));
    expect(cbTap.reached).toBe(false);
    expect(sentIncludes(cbTap.sink, blockedText("id"))).toBe(true);
    expect(cbTap.sink.some((c) => c.method === "answerCallbackQuery")).toBe(true);

    const textTap = await say(tg, s, ckb.persistentLabel("browse", "id"));
    expect(textTap.reached).toBe(false);
    expect(sentIncludes(textTap.sink, blockedText("id"))).toBe(true);

    const menu = await say(tg, s, "/menu");
    expect(menu.reached).toBe(false);

    // Pass-through list.
    expect((await say(tg, s, "/language")).reached).toBe(true);
    expect((await tap(tg, s, ckb.cb("lang", "menu"))).reached).toBe(true);

    const start = await say(tg, s, "/start", "");
    expect(start.reached).toBe(true);
    expect((await tap(tg, s, ckb.cb("lang", "set", "id"))).reached).toBe(true);
    expect((await tap(tg, s, ckb.cb("cur", "set", "IDR"))).reached).toBe(true);

    // Unblocked immediately.
    const after = await tap(tg, s, ckb.cb("menu", "main"));
    expect(after.reached).toBe(true);
    expect(sentIncludes(after.sink, blockedText("id"))).toBe(false);
  });

  it("lets a cur:* callback through for a user without a currency even outside onboarding", async () => {
    const tg = nextTgId();
    await makeLegacyUser(tg, "en");
    const s = freshSession();
    const r = await tap(tg, s, ckb.cb("cur", "set", "USD"));
    expect(r.reached).toBe(true);
    expect((await dbUserByTg(tg)).preferredCurrency).toBe("USD");
  });

  it("never blocks an admin", async () => {
    await makeLegacyUser(ADMIN_TG_ID, "en");
    const s = freshSession();
    const r = await tap(ADMIN_TG_ID, s, ckb.cb("menu", "main"));
    expect(r.reached).toBe(true);
    expect(sentIncludes(r.sink, blockedText("en"))).toBe(false);
  });

  it("passes non-private chats and updates without a message or callback", async () => {
    const tg = nextTgId();
    await makeLegacyUser(tg, "en");
    const group = await send(tg, freshSession(), { text: "hello", chatType: "group" });
    expect(group.reached).toBe(true);
    const member = await send(tg, freshSession(), { myChatMember: true });
    expect(member.reached).toBe(true);
  });

  it("passes any update while onboarding is in progress", async () => {
    const tg = nextTgId();
    await makeLegacyUser(tg, "en");
    const s = freshSession();
    s.onboarding = "currency";
    const r = await tap(tg, s, ckb.cb("noop"));
    expect(r.reached).toBe(true);
  });
});
