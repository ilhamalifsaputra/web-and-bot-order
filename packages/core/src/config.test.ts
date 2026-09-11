import { describe, it, expect } from "vitest";
import { Env } from "./config";

// DATABASE_URL_PRISMA has no default (it's required — see config.ts) so every
// parse() call below needs a value; these tests are exercising unrelated
// fields (BINANCE_PAY_ID, BOT_TOKEN, BOT_USERNAME), not this one.
const baseEnv = { DATABASE_URL_PRISMA: "postgresql://user:pass@localhost:5432/db" };

describe("config schema", () => {
  it("parses with no other env set (BINANCE_PAY_ID not required)", () => {
    expect(() => Env.parse(baseEnv)).not.toThrow();
  });

  it("defaults BINANCE_PAY_ID to empty string", () => {
    expect(Env.parse(baseEnv).BINANCE_PAY_ID).toBe("");
  });

  it("treats empty/whitespace BOT_TOKEN as undefined (not a validation error)", () => {
    // The token is meant to live in the DB Setting; an empty `.env` line
    // (BOT_TOKEN=) must boot like the line was absent, not crash on min(20).
    expect(Env.parse({ ...baseEnv, BOT_TOKEN: "" }).BOT_TOKEN).toBeUndefined();
    expect(Env.parse({ ...baseEnv, BOT_TOKEN: "   " }).BOT_TOKEN).toBeUndefined();
  });

  it("keeps a valid BOT_TOKEN and also passes through a malformed non-empty one", () => {
    // BOT_TOKEN is a recovery-only fallback (Settings wins) — a typo'd or
    // truncated value here must not crash the whole process at parse time.
    // Real format validation happens once, at the buildBot() call site.
    const token = "123456789:AAE-some-long-enough-token";
    expect(Env.parse({ ...baseEnv, BOT_TOKEN: token }).BOT_TOKEN).toBe(token);
    expect(() => Env.parse({ ...baseEnv, BOT_TOKEN: "short" })).not.toThrow();
    expect(Env.parse({ ...baseEnv, BOT_TOKEN: "short" }).BOT_TOKEN).toBe("short");
  });

  it("treats empty/whitespace BOT_USERNAME as undefined", () => {
    expect(Env.parse({ ...baseEnv, BOT_USERNAME: "" }).BOT_USERNAME).toBeUndefined();
    expect(Env.parse({ ...baseEnv, BOT_USERNAME: "  " }).BOT_USERNAME).toBeUndefined();
  });
});
