import { describe, it, expect } from "vitest";
import { recoveryScopeAllows } from "./recoveryScope";

describe("recoveryScopeAllows", () => {
  it("allows the recovered order's own pages, /track and the informational pages", () => {
    for (const path of ["/account/orders/ORD-1", "/account/orders/ORD-1/", "/checkout/ORD-1/pay", "/track", "/terms", "/privacy", "/refund", "/about", "/contact", "/how-to-order"]) {
      expect(recoveryScopeAllows(path, "ORD-1")).toBe(true);
    }
  });

  it("refuses every page whose data the scoped session cannot read", () => {
    for (const path of ["/", "/products", "/cart", "/checkout", "/account", "/account/orders", "/account/orders/ORD-2", "/checkout/ORD-2/pay", "/p/netflix", "/account/settings"]) {
      expect(recoveryScopeAllows(path, "ORD-1")).toBe(false);
    }
  });
});
