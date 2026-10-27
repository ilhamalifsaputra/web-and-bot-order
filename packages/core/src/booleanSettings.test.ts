import { describe, expect, it } from "vitest";
import { resolveBooleanSetting } from "./booleanSettings.js";

describe("resolveBooleanSetting default-off keys", () => {
  const opts = { smtpSecure: false };
  it("is off unless explicitly set to true", () => {
    expect(resolveBooleanSetting("bulk_purchase_broadcast_enabled", undefined, opts)).toBe(false);
    expect(resolveBooleanSetting("bulk_purchase_broadcast_enabled", "", opts)).toBe(false);
    expect(resolveBooleanSetting("bulk_purchase_broadcast_enabled", "false", opts)).toBe(false);
    expect(resolveBooleanSetting("bulk_purchase_broadcast_enabled", " TRUE ", opts)).toBe(true);
  });
});
