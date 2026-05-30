// setup-env MUST be first — sets env that @app/core/config reads at import time.
import "./setup-env";

import { describe, it, expect } from "vitest";
import { Bot } from "grammy";
import { buildBot } from "../src/main";
import { CONVERSATIONS } from "../src/conversations";

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

  it("registers exactly the 15 expected conversations with unique names", () => {
    expect(CONVERSATIONS).toHaveLength(15);
    const names = CONVERSATIONS.map((c) => c.name);
    expect(new Set(names).size).toBe(names.length);
    expect(names).toEqual(
      expect.arrayContaining([
        "review",
        "ticketUserReply",
        "proof",
        "voucher",
        "support",
        "reject",
        "stockUpload",
        "voucherCreate",
        "broadcast",
        "userSearch",
        "setting",
        "productCreate",
        "productEdit",
        "bulkPricing",
        "ticketReply",
      ]),
    );
  });

  it("every conversation spec has a handler fn and at least one entry trigger", () => {
    for (const spec of CONVERSATIONS) {
      expect(typeof spec.fn, `${spec.name} fn`).toBe("function");
      const hasTrigger = Boolean(spec.callback || spec.command || spec.hears);
      expect(hasTrigger, `${spec.name} has an entry trigger`).toBe(true);
    }
  });
});
