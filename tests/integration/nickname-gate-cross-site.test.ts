// setup-cross-site-env MUST be first — temp Postgres schema + env before any
// @app import.
import "./setup-cross-site-env";

// ===========================================================================
// Phase B fix round 2 — genuine cross-site "insurance against drift" test.
//
// The prior fix (54cbf47) extracted resolveNicknameGate (packages/db/src/
// crud/nickname.ts) so apiTopup.ts's POST /topup/check-account (storefront),
// checkout.ts's showOrderConfirmation (bot), and nicknameCheck.ts's own
// defensive re-check (bot) can never independently drift on the nickname-
// check opt-in rule. That fix's own review found the test that shipped with
// it (packages/db/src/crud/nickname.test.ts's "resolveNicknameGate — shared
// opt-in rule fixture matrix") only ever called resolveNicknameGate itself in
// isolation — never the real route/handler code at any of the 3 call sites —
// so it couldn't actually catch one site's wiring reverting to inline
// duplicated logic that diverged from the other two.
//
// This file closes that gap: ONE shared Postgres schema (provisioned by
// setup-cross-site-env.ts), ONE `@app/db` Prisma singleton, and for each of 4
// representative fixtures, all 3 REAL entry points are invoked against the
// SAME denomination row and asserted to agree on whether the nickname-check
// gate fires:
//   1. apps/storefront/src/routes/apiTopup.ts's POST /topup/check-account —
//      via buildApp() + app.inject(), the same way
//      apps/storefront/test/topup-check-account.test.ts does.
//   2. apps/order-bot/src/handlers/checkout.ts's showOrderConfirmation — via
//      the real function + the bot's FakeConversation/ctx test doubles
//      (apps/order-bot/test/helpers/ctx.ts), the same way
//      apps/order-bot/test/nickname-check.test.ts does.
//   3. apps/order-bot/src/conversations/nicknameCheck.ts's own defensive
//      re-check — driven straight into the conversation (bypassing
//      showOrderConfirmation, simulating the "config changed in the moment
//      between the gate's read and this conversation starting" race its own
//      doc comment describes) with a queued /cancel so the assertion never
//      needs to complete the full wizard, just observe whether it engaged
//      the prompt loop at all.
//
// Each of the 6-case unit test's existing fixture shapes in nickname.test.ts
// stays untouched — this is additive, not a replacement.
// ===========================================================================
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const kokinpayMock = vi.hoisted(() => ({ checkGameNickname: vi.fn() }));
vi.mock("@app/core/suppliers/kokinpay", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@app/core/suppliers/kokinpay")>()),
  checkGameNickname: kokinpayMock.checkGameNickname,
}));

import {
  prisma,
  createCategory,
  createCatalogProduct,
  updateCatalogProduct,
  createDenomination,
  bulkAddStock,
  createGame,
  upsertProviderGameMapping,
  setSetting,
  KOKINPAY_API_KEY_KEY,
} from "@app/db";
import { ProductType } from "@app/core/enums";
import { buildSampleData, type SampleData } from "../helpers/sampleData";
import { buildApp } from "../../apps/storefront/src/server";
import * as checkout from "../../apps/order-bot/src/handlers/checkout";
import { nicknameCheckConversation } from "../../apps/order-bot/src/conversations/nicknameCheck";
import { makeCtx, FakeConversation, calls, sentIncludes, type SentCall } from "../../apps/order-bot/test/helpers/ctx";
import type { SessionData } from "../../apps/order-bot/src/context";

// Avoids importing the "fastify" package's own types directly — bare
// specifier resolution for it only works from inside apps/storefront's own
// node_modules (pnpm's non-hoisted layout), not from tests/integration/.
// buildApp()'s own return type already carries the real FastifyInstance shape.
let app: Awaited<ReturnType<typeof buildApp>>;
let sample: SampleData;
let categoryId: number;
let fixtureCounter = 0;

async function postCheckAccount(body: Record<string, unknown>) {
  return app.inject({ method: "POST", url: "/api/v1/topup/check-account", payload: body });
}

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
    },
  };
}

// buildSampleData (tests/helpers/sampleData.ts) hardcodes telegramId: 42 for
// its user row — mirrored literally here (not `sample.user.telegramId`,
// which is a Prisma BigInt) the same way nickname-check.test.ts's own
// customerCtx does.
const SAMPLE_USER_TELEGRAM_ID = 42;

function customerCtx(opts: Parameters<typeof makeCtx>[0] = {}) {
  return makeCtx({ from: { id: SAMPLE_USER_TELEGRAM_ID, username: "tester" }, session: userSession(), ...opts });
}

beforeAll(async () => {
  app = await buildApp();
  sample = await buildSampleData(prisma);
  const cat = await prisma.category.create({ data: { name: "CrossSiteCat", slug: "cross-site-cat", sortOrder: 1 } });
  categoryId = cat.id;
  await setSetting(prisma, KOKINPAY_API_KEY_KEY, "kp-key");
  // Without this, setupGatePlugin 503s every storefront request — the
  // "shop not configured yet" gate — same as
  // apps/storefront/test/topup-check-account.test.ts's own beforeAll.
  await setSetting(prisma, "setup_completed", "true");
});

afterAll(async () => {
  await app.close();
});

/**
 * One AUTO SKU (1 stock unit) whose fixture shape is driven entirely by
 * `resolveNicknameGate`'s own inputs — a linked `Game` (with its own
 * `isActive`/`nicknameSupported`), an optional credentialed
 * `ProviderGameMapping`, and an optional legacy `nicknameCheckGameCode` —
 * mirroring packages/db/src/crud/nickname.test.ts's own fixture matrix
 * one level up the stack (the real DB rows those unit-test fixtures stand
 * in for).
 */
async function makeFixtureDenom(opts: {
  linkGame?: boolean;
  gameActive?: boolean;
  nicknameSupported?: boolean;
  withMapping?: boolean;
  legacyGameCode?: string | null;
}) {
  fixtureCounter += 1;
  let gameId: number | null = null;
  if (opts.linkGame) {
    const game = await createGame(prisma, {
      slug: `cross-site-game-${fixtureCounter}`,
      name: `Cross Site Game ${fixtureCounter}`,
      isActive: opts.gameActive ?? true,
      nicknameSupported: opts.nicknameSupported ?? true,
    });
    gameId = game.id;
    if (opts.withMapping) {
      await upsertProviderGameMapping(prisma, {
        gameId: game.id,
        provider: "kokinpay",
        providerGameCode: `cross-site-code-${fixtureCounter}`,
        priority: 0,
      });
    }
  }
  const product = await createCatalogProduct(prisma, { categoryId, name: `Cross Site Product ${fixtureCounter}` });
  if (gameId != null) await updateCatalogProduct(prisma, product.id, { gameId });
  const denom = await createDenomination(prisma, {
    productId: product.id,
    name: `Cross Site Denom ${fixtureCounter}`,
    type: ProductType.SHARED,
    durationLabel: "N/A",
    price: "10.00",
    nicknameCheckGameCode: opts.legacyGameCode ?? undefined,
  });
  await bulkAddStock(prisma, denom.id, [`stock-${fixtureCounter}`]);
  return denom.id;
}

/**
 * Drives all 3 real entry points against the SAME denomination row and
 * asserts they agree on whether the nickname-check gate fires for it.
 */
async function expectGateOutcomeAgrees(denominationId: number, triggers: boolean) {
  // --- 1. storefront: POST /topup/check-account (apiTopup.ts, real Fastify route) ---
  kokinpayMock.checkGameNickname.mockReset();
  if (triggers) kokinpayMock.checkGameNickname.mockResolvedValueOnce({ valid: true, nickname: "CrossSitePlayer" });
  const res = await postCheckAccount({ denomination_id: denominationId, id: "cross-site-account" });
  expect(res.statusCode).toBe(200);
  if (triggers) {
    // A real provider attempt happened and returned a determinate answer —
    // proof the gate let the request through to NicknameService/the legacy
    // KokinPay call, not that it merely didn't error.
    expect(res.json()).toEqual({ available: true, valid: true, nickname: "CrossSitePlayer" });
    expect(kokinpayMock.checkGameNickname).toHaveBeenCalledTimes(1);
  } else {
    expect(res.json()).toEqual({ available: false });
    expect(kokinpayMock.checkGameNickname).not.toHaveBeenCalled();
  }

  // --- 2. bot: checkout.ts's showOrderConfirmation (real function) ---
  kokinpayMock.checkGameNickname.mockReset();
  const { ctx, sink } = customerCtx({ callbackData: `v1:buy:${denominationId}:1` });
  await checkout.showOrderConfirmation(ctx, denominationId, 1);
  if (triggers) {
    expect(calls(sink, "conversation.enter").some((c) => c.args[0] === "nicknameCheck")).toBe(true);
    expect(sentIncludes(sink, "Confirm Order")).toBe(false);
  } else {
    expect(calls(sink, "conversation.enter").length).toBe(0);
    expect(sentIncludes(sink, "Confirm Order")).toBe(true);
  }

  // --- 3. bot: nicknameCheck.ts's own defensive re-check (real function),
  // entered directly (bypassing showOrderConfirmation) the way its own doc
  // comment describes as the race it guards against. A single queued
  // /cancel is enough to observe the outcome without completing the whole
  // wizard: if the gate fires, the conversation prompts first (so /cancel is
  // consumed inside its wait() loop, then re-enters showOrderConfirmation's
  // gate — same behavior nickname-check.test.ts's own "/cancel abandons the
  // check" case proves); if the gate doesn't fire, it returns straight to
  // renderOrderConfirmation before ever calling wait(), so the queued
  // /cancel is never consumed at all.
  const sink2: SentCall[] = [];
  const entry = makeCtx({
    sink: sink2,
    from: { id: SAMPLE_USER_TELEGRAM_ID, username: "tester" },
    session: { ...userSession(), scratch: { pendingNicknameProductId: denominationId, pendingNicknameQuantity: 1 } },
    callbackData: `v1:buy:${denominationId}:1`,
  }).ctx;
  const cancelMsg = makeCtx({ sink: sink2, from: { id: SAMPLE_USER_TELEGRAM_ID, username: "tester" }, session: userSession(), text: "/cancel" }).ctx;
  const conv = new FakeConversation([cancelMsg]);
  await nicknameCheckConversation(conv.asMyConversation(), entry);
  if (triggers) {
    expect(calls(sink2, "conversation.enter").some((c) => c.args[0] === "nicknameCheck")).toBe(true);
  } else {
    expect(calls(sink2, "conversation.enter").length).toBe(0);
    expect(sentIncludes(sink2, "Confirm Order")).toBe(true);
  }
}

describe("nickname-check gate — storefront, showOrderConfirmation, and nicknameCheck agree on the same fixture matrix", () => {
  it("game-linked + active + nicknameSupported + credentialed mapping: all 3 sites trigger the check", async () => {
    const denominationId = await makeFixtureDenom({ linkGame: true, withMapping: true });
    await expectGateOutcomeAgrees(denominationId, true);
  });

  it("game-linked but nicknameSupported:false (even with a credentialed mapping): all 3 sites skip the check", async () => {
    const denominationId = await makeFixtureDenom({ linkGame: true, nicknameSupported: false, withMapping: true });
    await expectGateOutcomeAgrees(denominationId, false);
  });

  it("no game link and no legacy game code: all 3 sites skip the check (the overwhelming common case)", async () => {
    const denominationId = await makeFixtureDenom({});
    await expectGateOutcomeAgrees(denominationId, false);
  });

  it("no game link but a legacy nicknameCheckGameCode is configured (with KokinPay credentials set): all 3 sites trigger via the legacy fallback", async () => {
    const denominationId = await makeFixtureDenom({ legacyGameCode: "cross-site-legacy-code" });
    await expectGateOutcomeAgrees(denominationId, true);
  });
});
