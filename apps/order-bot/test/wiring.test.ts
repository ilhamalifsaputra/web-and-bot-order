// setup-env MUST be first — sets env that @app/core/config reads at import time.
import "./setup-env";

import { describe, it, expect, vi } from "vitest";
import { Bot } from "grammy";
import { buildBot, start } from "../src/main";
import { CONVERSATIONS } from "../src/conversations";

// --- Payment-poller wiring test doubles -------------------------------------
// start() (this file's bot-standalone composition root) must start the same
// set of payment pollers as the combined root (apps/server/src/index.ts:272-
// 278). Each poller module is partially mocked — only startPolling/
// stopPolling are replaced with spies via vi.hoisted so the assertions below
// can inspect them directly; every other export (pollOnce, triggerImmediatePoll,
// etc., used by handlers elsewhere in the import graph) stays real.
const pollerSpies = vi.hoisted(() => ({
  binanceInternal: { startPolling: vi.fn(), stopPolling: vi.fn() },
  bybitDeposit: { startPolling: vi.fn(), stopPolling: vi.fn() },
  bybitBscDeposit: { startPolling: vi.fn(), stopPolling: vi.fn() },
  bybitBscConfirmationTracker: { startPolling: vi.fn(), stopPolling: vi.fn() },
  tokopayReconcile: { startPolling: vi.fn(), stopPolling: vi.fn() },
  paydisiniReconcile: { startPolling: vi.fn(), stopPolling: vi.fn() },
  nowpaymentsReconcile: { startPolling: vi.fn(), stopPolling: vi.fn() },
}));

vi.mock("../src/payments/binanceInternal", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/payments/binanceInternal")>()),
  ...pollerSpies.binanceInternal,
}));
vi.mock("../src/payments/bybitDeposit", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/payments/bybitDeposit")>()),
  ...pollerSpies.bybitDeposit,
}));
vi.mock("../src/payments/bybitBscDeposit", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/payments/bybitBscDeposit")>()),
  ...pollerSpies.bybitBscDeposit,
}));
vi.mock("../src/payments/bybitBscConfirmationTracker", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/payments/bybitBscConfirmationTracker")>()),
  ...pollerSpies.bybitBscConfirmationTracker,
}));
vi.mock("../src/payments/tokopayReconcile", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/payments/tokopayReconcile")>()),
  ...pollerSpies.tokopayReconcile,
}));
vi.mock("../src/payments/paydisiniReconcile", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/payments/paydisiniReconcile")>()),
  ...pollerSpies.paydisiniReconcile,
}));
vi.mock("../src/payments/nowpaymentsReconcile", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/payments/nowpaymentsReconcile")>()),
  ...pollerSpies.nowpaymentsReconcile,
}));

// scheduleFxRefresh kicks an immediate real DB + market-rate fetch (jobs/
// index.ts); scheduleJobs registers real croner timers. Neither is relevant
// to poller wiring, so both are stubbed out — the rest of the jobs module
// (used only by jobs.test.ts, not here) stays real.
const jobsSpies = vi.hoisted(() => ({
  scheduleJobs: vi.fn(() => []),
  scheduleFxRefresh: vi.fn(() => ({ stop: vi.fn() })),
  scheduleDigiflazzCatalogSync: vi.fn(() => ({ stop: vi.fn() })),
}));
vi.mock("../src/jobs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/jobs")>()),
  ...jobsSpies,
}));

// @grammyjs/runner's run() starts a real detached getUpdates loop; stub it
// out so start() doesn't leave a live polling loop running after the test.
// sequentialize (also from this package, used inside buildBot()) stays real.
const runnerSpies = vi.hoisted(() => ({ stop: vi.fn(async () => undefined) }));
vi.mock("@grammyjs/runner", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@grammyjs/runner")>()),
  run: vi.fn(() => ({ task: () => undefined, isRunning: () => false, stop: runnerSpies.stop })),
}));

// initDb/resolveAdminIds/getSetting/resolveBotCredentials are the only
// @app/db calls start() makes directly at boot; stubbing them avoids needing
// a real (migrated) database while keeping every other @app/db export real.
const dbSpies = vi.hoisted(() => ({
  initDb: vi.fn(async () => undefined),
  resolveAdminIds: vi.fn(async () => [999, 1000]),
  getSetting: vi.fn(async () => null),
  resolveBotCredentials: vi.fn(async () => ({
    botToken: "123:WIRING-TEST-TOKEN",
    botUsername: "WiringTestBot",
    notifBotToken: null,
    publicChannelId: null,
  })),
}));
vi.mock("@app/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@app/db")>()),
  ...dbSpies,
}));

/**
 * Wiring smoke test: construct the whole bot (every middleware, conversation,
 * command, router) without a live token or network. Catches registration /
 * import-graph errors that tsc can't (e.g. a bad conversation spec or a
 * throwing top-level side effect) before a real deploy.
 */
describe("order-bot wiring", () => {
  it("buildBot() constructs a fully-wired Bot without throwing", () => {
    const bot = buildBot();
    expect(bot).toBeInstanceOf(Bot);
    // botInfo isn't fetched (no network); token was accepted by the constructor.
    expect(bot.token).toBe(process.env.BOT_TOKEN);
  });

  it("is idempotent — can be built more than once", () => {
    expect(() => {
      buildBot();
      buildBot();
    }).not.toThrow();
  });

  it("registers exactly the 16 expected conversations with unique names", () => {
    expect(CONVERSATIONS).toHaveLength(16);
    const names = CONVERSATIONS.map((c) => c.name);
    expect(new Set(names).size).toBe(names.length);
    expect(names).toEqual(
      expect.arrayContaining([
        "ticketUserReply",
        "voucher",
        "customerInfo",
        "editCustomerInfo",
        "support",
        "reject",
        "stockUpload",
        "voucherCreate",
        "broadcast",
        "userSearch",
        "userBan",
        "setting",
        "productCreate",
        "productEdit",
        "bulkPricing",
        "ticketReply",
      ]),
    );
  });

  // "customerInfo" and "editCustomerInfo" are the deliberate exceptions:
  // both are entered programmatically (checkout.ts's showOrderConfirmation
  // calls ctx.conversation.enter("customerInfo") for a manual_with_info SKU;
  // callbacks.ts's dispatchOrder calls ctx.conversation.enter("editCustomerInfo")
  // for a v1:order:editinfo:<id> tap), not from a callback/command/hears
  // match, so neither has a trigger by design.
  const NO_TRIGGER_BY_DESIGN = new Set(["customerInfo", "editCustomerInfo"]);

  it("every conversation spec has a handler fn, and an entry trigger unless it's deliberately programmatic-entry-only", () => {
    for (const spec of CONVERSATIONS) {
      expect(typeof spec.fn, `${spec.name} fn`).toBe("function");
      const hasTrigger = Boolean(spec.callback || spec.command || spec.hears);
      if (NO_TRIGGER_BY_DESIGN.has(spec.name)) {
        expect(hasTrigger, `${spec.name} was expected to stay trigger-less`).toBe(false);
      } else {
        expect(hasTrigger, `${spec.name} has an entry trigger`).toBe(true);
      }
    }
  });
});

// Task 19 (payment-health-hardening plan): apps/server/src/index.ts:272-278
// (the combined web-admin+storefront+bot root) starts SEVEN payment pollers.
// apps/order-bot/src/main.ts (this bot-standalone root) used to start only
// six of them — the Bybit BSC confirmation tracker was missing, so an order
// running against a standalone bot never got its PAYMENT_DETECTED ->
// CONFIRMING -> CONFIRMED display progression. This asserts the standalone
// root's start() calls every poller's startPolling exactly once, with the
// same live bot.api instance, closing that gap for all seven.
describe("bot-standalone payment poller wiring (Task 19)", () => {
  it("bot-standalone boot starts every payment poller the combined server starts", async () => {
    await start();

    for (const [name, spies] of Object.entries(pollerSpies)) {
      expect(spies.startPolling, `${name}.startPolling`).toHaveBeenCalledTimes(1);
    }

    // Same bot.api instance passed to every poller — proof they're all wired
    // to the one live bot the runner is polling with, not stray instances.
    const apis = Object.values(pollerSpies).map((s) => s.startPolling.mock.calls[0]?.[0]);
    expect(apis[0]).toBeDefined();
    expect(apis.every((api) => api === apis[0])).toBe(true);
  }, 15_000);
});
