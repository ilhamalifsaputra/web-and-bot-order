import { describe, it, expect } from "vitest";
import { buildSubject } from "./subject";
import type { BrandConfig, EmailCopy } from "./types";

const brand: BrandConfig = {
  shopName: "Acme Shop",
  logoUrl: null,
  accentColor: "#4F46E5",
  supportEmail: null,
  storeUrl: null,
};

describe("buildSubject", () => {
  it("returns the subject verbatim when it has no {shop_name} token", () => {
    const copy: EmailCopy = { subject: "New paid order", title: "", subtitle: "", message: "" };
    expect(buildSubject(copy, brand)).toBe("New paid order");
  });

  it("substitutes {shop_name} with brand.shopName", () => {
    const copy: EmailCopy = { subject: "{shop_name} has a new order!", title: "", subtitle: "", message: "" };
    expect(buildSubject(copy, brand)).toBe("Acme Shop has a new order!");
  });

  it("does not substitute any other token, even if literally present", () => {
    const copy: EmailCopy = { subject: "New order {order_code}", title: "", subtitle: "", message: "" };
    expect(buildSubject(copy, brand)).toBe("New order {order_code}");
  });
});
