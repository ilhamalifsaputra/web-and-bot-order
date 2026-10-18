import { describe, expect, it } from "vitest";
import { resolveBooleanSetting } from "./booleanSettings.js";

describe("resolveBooleanSetting game_topup_flow_v2_enabled", () => {
  const opts = { smtpSecure: false };
  it("is off unless explicitly set to true", () => {
    expect(resolveBooleanSetting("game_topup_flow_v2_enabled", undefined, opts)).toBe(false);
    expect(resolveBooleanSetting("game_topup_flow_v2_enabled", "", opts)).toBe(false);
    expect(resolveBooleanSetting("game_topup_flow_v2_enabled", "false", opts)).toBe(false);
    expect(resolveBooleanSetting("game_topup_flow_v2_enabled", " TRUE ", opts)).toBe(true);
  });
});
