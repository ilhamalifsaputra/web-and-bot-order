// setup-db MUST be first — temp DB + push before any @app import.
import "./setup-db";

/**
 * A service added to the registry later (here a fake "STEAM_WALLET") with no
 * special config gets the default selection style: inline-only lists, zero
 * companion messages, an inline Back on every screen — and none of Game
 * Top-up's pickers, From prices or game hints. Premium Apps stays numbered.
 *
 * The seam: `@app/core/services` is mocked to append the fake service to
 * CUSTOMER_SERVICES, and its resolvers are re-bound to that longer registry
 * (they take the registry as a parameter for exactly this).
 */
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@app/core/services", async (importOriginal) => {
  const real = await importOriginal<typeof import("@app/core/services")>();
  const services = [
    ...real.CUSTOMER_SERVICES,
    {
      id: "steam_wallet",
      label: "Steam Wallet",
      group: "STEAM_WALLET",
      settingKeys: { bot: "service_steam_wallet_enabled_bot", web: "service_steam_wallet_enabled_web" },
      translationKey: "browse.group_steam_wallet",
    },
  ] as unknown as typeof real.CUSTOMER_SERVICES;
  return {
    ...real,
    CUSTOMER_SERVICES: services,
    serviceForCategoryGroup: (group: string | null) =>
      services.find((service) => service.group === (group ?? "PREMIUM_APPS")) ?? real.serviceForCategoryGroup(null),
    listSelectionFor: (group: string | null | undefined) => real.listSelectionFor(group, services),
    usesNumberedSelection: (group: string | null | undefined) => real.usesNumberedSelection(group, services),
  };
});

import { prisma, createCatalogProduct, createCategory, createDenomination, setSetting, upsertUser } from "@app/db";
import { CategoryGroup } from "@app/core/enums";
import { buildSampleData, resetDb, type SampleData } from "../../../tests/helpers/sampleData";
import { makeCtx, calls, sentIncludes, lastMarkup, type SentCall } from "./helpers/ctx";
import type { SessionData } from "../src/context";
import { routeCallback } from "../src/handlers/callbacks";
import * as customer from "../src/handlers/customer";
import { persistentLabel } from "../src/keyboards/customer";
import { t } from "../src/util/i18n";

type Button = { text: string; callback_data?: string };
const STEAM = "STEAM_WALLET";

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

function next(prev: { session: SessionData | Partial<SessionData> }, opts: Parameters<typeof makeCtx>[0] = {}) {
  return customerCtx({ ...opts, session: { ...userSession(), scratch: prev.session.scratch as SessionData["scratch"], menuMsgId: prev.session.menuMsgId } });
}

async function product(categoryId: number, name: string, gameRegion: string | null = null) {
  const p = await createCatalogProduct(prisma, { categoryId, name });
  await prisma.product.update({ where: { id: p.id }, data: { gameRegion } });
  await createDenomination(prisma, { productId: p.id, name: "Voucher", type: "SHARED", durationLabel: "Voucher", price: "60000" });
  return p;
}

const rows = (sink: SentCall[]): Button[][] => ((lastMarkup(sink) as { inline_keyboard?: Button[][] } | undefined)?.inline_keyboard ?? []);
const pickButtons = (sink: SentCall[]) => rows(sink).flat().filter((b) => b.callback_data?.startsWith("v1:browse:pick:"));
const hasReplyKeyboard = (sink: SentCall[]) => sink.some((c) => JSON.stringify(c.args).includes("\"keyboard\":"));
function counts(sink: SentCall[]) {
  return {
    reply: calls(sink, "reply").length,
    sendMessage: calls(sink, "sendMessage").length,
    editMessageText: calls(sink, "editMessageText").length,
    deleteMessage: calls(sink, "deleteMessage").length,
  };
}
const ONE_EDIT = { reply: 0, sendMessage: 0, editMessageText: 1, deleteMessage: 0 };
const ONE_SEND = { reply: 1, sendMessage: 0, editMessageText: 0, deleteMessage: 0 };

describe("a newly registered service with no special config", () => {
  async function steamCatalog() {
    const idr = await createCategory(prisma, { name: "Steam IDR", group: STEAM });
    await createCategory(prisma, { name: "Steam USD", group: STEAM });
    // A stray gameRegion on a non-game product must not summon the region picker.
    const a = await product(idr.id, "Steam Wallet 60K", "Indonesia");
    const b = await product(idr.id, "Steam Wallet 120K", "Global");
    return { idr, a, b };
  }

  it("category picker → inline list (one edit each), no companion, no Game pickers/prices/hints, Back to its category picker", async () => {
    const { idr, a, b } = await steamCatalog();

    const group = customerCtx({ callbackData: `v1:browse:grp:${STEAM}` });
    await routeCallback(group.ctx);
    expect(counts(group.sink)).toEqual(ONE_EDIT);
    expect(rows(group.sink).flat().filter((x) => x.callback_data?.startsWith("v1:browse:cat:"))).toHaveLength(2);
    expect(sentIncludes(group.sink, t(group.ctx, "hint.game_list"))).toBe(false);

    const list = next(group.ctx, { callbackData: `v1:browse:cat:${idr.id}` });
    await routeCallback(list.ctx);
    expect(counts(list.sink)).toEqual(ONE_EDIT);
    expect(hasReplyKeyboard(list.sink)).toBe(false);
    expect(sentIncludes(list.sink, t(list.ctx, "browse.use_numbers"))).toBe(false);
    expect(sentIncludes(list.sink, t(list.ctx, "browse.choose_region"))).toBe(false);
    expect(sentIncludes(list.sink, t(list.ctx, "browse.choose_variant"))).toBe(false);
    expect(pickButtons(list.sink)).toEqual([
      { text: "Steam Wallet 120K", callback_data: `v1:browse:pick:${b.id}` },
      { text: "Steam Wallet 60K", callback_data: `v1:browse:pick:${a.id}` },
    ]);
    const body = String(calls(list.sink, "editMessageText")[0]!.args[0]);
    expect(body).not.toMatch(/\n\d+\. /);
    expect(body).not.toContain(t(list.ctx, "browse.product_from_price", { price: "" }).trim());
    expect(body).not.toContain(t(list.ctx, "hint.game_list"));
    // Back steps up to this service's own category picker (2 categories).
    expect(rows(list.sink).at(-1)).toEqual([{ text: t(list.ctx, "menu.back"), callback_data: `v1:browse:grp:${STEAM}` }]);

    const typed = next(list.ctx, { text: "1" });
    await customer.handleProductNumber(typed.ctx);
    expect(counts(typed.sink)).toEqual(ONE_SEND);
    expect(sentIncludes(typed.sink, t(typed.ctx, "browse.use_buttons"))).toBe(true);
    expect(sentIncludes(typed.sink, "Netflix")).toBe(false);
  });

  it("the typed Products key with only this service enabled sends exactly one message (its category picker)", async () => {
    await steamCatalog();
    await setSetting(prisma, "service_game_topup_enabled_bot", "false");
    await setSetting(prisma, "service_premium_apps_enabled_bot", "false");
    const typed = customerCtx({ text: persistentLabel("browse", "en") });
    await customer.handleProductNumber(typed.ctx);
    expect(counts(typed.sink)).toEqual(ONE_SEND);
    expect(hasReplyKeyboard(typed.sink)).toBe(false);
    expect(rows(typed.sink).flat().filter((x) => x.callback_data?.startsWith("v1:browse:cat:"))).toHaveLength(2);
  });

  it("Premium Apps beside it is still numbered (companion + numbered caption)", async () => {
    await steamCatalog();
    const cat = await createCategory(prisma, { name: "Streaming Apps", group: CategoryGroup.PREMIUM_APPS });
    await product(cat.id, "App One");
    const tap = customerCtx({ callbackData: `v1:browse:cat:${cat.id}` });
    await routeCallback(tap.ctx);
    expect(counts(tap.sink)).toEqual({ reply: 1, sendMessage: 0, editMessageText: 1, deleteMessage: 0 });
    expect(calls(tap.sink, "reply")[0]!.args[0]).toBe(t(tap.ctx, "browse.use_numbers"));
    expect(String(calls(tap.sink, "editMessageText")[0]!.args[0])).toContain("1. App One");
    expect(pickButtons(tap.sink)).toHaveLength(0);
  });
});
