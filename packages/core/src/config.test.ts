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

  // Owner decision (Game Top-up refactor, Phase 4): the per-rail payment
  // windows. Parsed from an env with none of the window keys set, so this
  // pins the schema defaults themselves — the test harnesses and a local
  // `.env` may still set explicit values, and an explicit value always wins.
  it("defaults each rail's payment window to the owner-approved minutes", () => {
    const parsed = Env.parse(baseEnv);
    expect(parsed.PAYMENT_WINDOW_MINUTES).toBe(10); // TokoPay QRIS, PayDisini, initial stamp
    expect(parsed.INTERNAL_PAYMENT_WINDOW_MINUTES).toBe(10); // Binance Pay
    expect(parsed.BYBIT_PAYMENT_WINDOW_MINUTES).toBe(10); // Bybit UID
    expect(parsed.BYBIT_BSC_PAYMENT_WINDOW_MINUTES).toBe(30); // Bybit BSC on-chain
    expect(parsed.NOWPAYMENTS_PAYMENT_WINDOW_MINUTES).toBe(30); // NOWPayments hosted invoice
  });

  // Owner decision (Phase 4): one reminder push ~5 minutes before the window
  // closes; 0 switches it off. A value that is not a usable positive number
  // must never turn into something surprising (a negative lead, NaN
  // arithmetic in the job) — it switches the reminder off instead.
  it("defaults the payment reminder lead to 5 minutes, also for a blank line", () => {
    expect(Env.parse(baseEnv).PAYMENT_REMINDER_LEAD_MINUTES).toBe(5);
    expect(Env.parse({ ...baseEnv, PAYMENT_REMINDER_LEAD_MINUTES: "" }).PAYMENT_REMINDER_LEAD_MINUTES).toBe(5);
    expect(Env.parse({ ...baseEnv, PAYMENT_REMINDER_LEAD_MINUTES: "  " }).PAYMENT_REMINDER_LEAD_MINUTES).toBe(5);
  });

  it("reads an explicit payment reminder lead, and 0 disables it", () => {
    expect(Env.parse({ ...baseEnv, PAYMENT_REMINDER_LEAD_MINUTES: "3" }).PAYMENT_REMINDER_LEAD_MINUTES).toBe(3);
    expect(Env.parse({ ...baseEnv, PAYMENT_REMINDER_LEAD_MINUTES: "0" }).PAYMENT_REMINDER_LEAD_MINUTES).toBe(0);
  });

  it.each(["-5", "abc", "NaN", "Infinity", "0.5"])(
    "treats an unusable payment reminder lead (%s) as disabled instead of failing the boot",
    (raw) => {
      expect(Env.parse({ ...baseEnv, PAYMENT_REMINDER_LEAD_MINUTES: raw }).PAYMENT_REMINDER_LEAD_MINUTES).toBe(0);
    },
  );

  it("rounds a fractional payment reminder lead down to whole minutes", () => {
    expect(Env.parse({ ...baseEnv, PAYMENT_REMINDER_LEAD_MINUTES: "4.9" }).PAYMENT_REMINDER_LEAD_MINUTES).toBe(4);
  });

  it("lets an explicit env value override a payment window default", () => {
    const parsed = Env.parse({ ...baseEnv, PAYMENT_WINDOW_MINUTES: "30", BYBIT_BSC_PAYMENT_WINDOW_MINUTES: "15" });
    expect(parsed.PAYMENT_WINDOW_MINUTES).toBe(30);
    expect(parsed.BYBIT_BSC_PAYMENT_WINDOW_MINUTES).toBe(15);
  });
});
