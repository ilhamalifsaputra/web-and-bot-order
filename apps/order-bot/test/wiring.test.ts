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
