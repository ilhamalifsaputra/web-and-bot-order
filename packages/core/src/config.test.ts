import { describe, it, expect } from "vitest";
import { Env } from "./config";

describe("config schema", () => {
  it("parses with no env at all (BINANCE_PAY_ID not required)", () => {
    expect(() => Env.parse({})).not.toThrow();
  });

  it("defaults BINANCE_PAY_ID to empty string", () => {
    expect(Env.parse({}).BINANCE_PAY_ID).toBe("");
  });

  it("treats empty/whitespace BOT_TOKEN as undefined (not a validation error)", () => {
    // The token is meant to live in the DB Setting; an empty `.env` line
    // (BOT_TOKEN=) must boot like the line was absent, not crash on min(20).
    expect(Env.parse({ BOT_TOKEN: "" }).BOT_TOKEN).toBeUndefined();
    expect(Env.parse({ BOT_TOKEN: "   " }).BOT_TOKEN).toBeUndefined();
  });

  it("keeps a valid BOT_TOKEN and still rejects a too-short non-empty one", () => {
    const token = "123456789:AAE-some-long-enough-token";
    expect(Env.parse({ BOT_TOKEN: token }).BOT_TOKEN).toBe(token);
    expect(() => Env.parse({ BOT_TOKEN: "short" })).toThrow();
  });

  it("treats empty/whitespace BOT_USERNAME as undefined", () => {
    expect(Env.parse({ BOT_USERNAME: "" }).BOT_USERNAME).toBeUndefined();
    expect(Env.parse({ BOT_USERNAME: "  " }).BOT_USERNAME).toBeUndefined();
  });
});
