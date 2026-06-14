import { describe, it, expect } from "vitest";
import { Env } from "./config";

describe("config schema", () => {
  it("parses with no env at all (BINANCE_PAY_ID not required)", () => {
    expect(() => Env.parse({})).not.toThrow();
  });

  it("defaults BINANCE_PAY_ID to empty string", () => {
    expect(Env.parse({}).BINANCE_PAY_ID).toBe("");
  });
});
