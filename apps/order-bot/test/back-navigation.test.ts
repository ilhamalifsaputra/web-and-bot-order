// setup-db MUST be first — temp DB + push before any @app import.
import "./setup-db";

import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { prisma, createCatalogProduct, createCategory, createDenomination, setSetting, upsertUser } from "@app/db";
import { CategoryGroup } from "@app/core/enums";
import { buildSampleData, resetDb, type SampleData } from "../../../tests/helpers/sampleData";
import { makeCtx, calls, sentIncludes, lastMarkup, type SentCall } from "./helpers/ctx";
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

void t;
