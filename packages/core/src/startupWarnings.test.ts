import { describe, it, expect } from "vitest";
import { collectProductionWarnings } from "./startupWarnings";

const good = { nodeEnv: "production", trustProxy: "127.0.0.1", cookieSecure: true, webhookSecret: "x".repeat(32) };

describe("collectProductionWarnings", () => {
  it("returns nothing for a hardened production configuration", () => {
    expect(collectProductionWarnings(good)).toEqual([]);
  });

  it("returns nothing outside production, even with every setting weak", () => {
    expect(
      collectProductionWarnings({ nodeEnv: "development", trustProxy: undefined, cookieSecure: false, webhookSecret: "short" }),
    ).toEqual([]);
  });

  it("warns when TRUST_PROXY is unset", () => {
    const w = collectProductionWarnings({ ...good, trustProxy: undefined });
    expect(w).toHaveLength(1);
    expect(w[0]).toMatch(/TRUST_PROXY/);
  });

  it("warns when the session cookie is not Secure", () => {
    const w = collectProductionWarnings({ ...good, cookieSecure: false });
    expect(w).toHaveLength(1);
    expect(w[0]).toMatch(/WEB_COOKIE_SECURE/);
  });

  it("warns when WEBHOOK_SECRET is set but shorter than 24 characters, never echoing it", () => {
    const secret = "short-secret-value";
    const w = collectProductionWarnings({ ...good, webhookSecret: secret });
    expect(w).toHaveLength(1);
    expect(w[0]).toMatch(/WEBHOOK_SECRET/);
    expect(w[0]).not.toContain(secret);
  });

  it("does not warn about an unset WEBHOOK_SECRET (polling deployments do not use one)", () => {
    expect(collectProductionWarnings({ ...good, webhookSecret: undefined })).toEqual([]);
  });

  it("reports every weak setting at once", () => {
    expect(
      collectProductionWarnings({ nodeEnv: "production", trustProxy: "", cookieSecure: false, webhookSecret: "abc" }),
    ).toHaveLength(3);
  });
});
