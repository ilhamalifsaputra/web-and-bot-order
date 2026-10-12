import { describe, it, expect } from "vitest";
import { EMAIL_EVENT_REGISTRY, canonicalEmailEventFor } from "./registry";
import { renderEventNotification } from "./templates/eventNotification";
const brand = { shopName: "Shop", logoUrl: null, accentColor: "#4F46E5", supportEmail: null, storeUrl: null };
describe("source email registry", () => {
  it("contains exactly the 23 specified facts with unique stable keys", () => {
    expect(EMAIL_EVENT_REGISTRY).toHaveLength(23);
    expect(new Set(EMAIL_EVENT_REGISTRY.map((row) => row.key)).size).toBe(23);
    expect(EMAIL_EVENT_REGISTRY.filter((row) => row.mandatory).map((row) => row.key)).toEqual(["account.password_reset.requested"]);
    expect(canonicalEmailEventFor("OWNER_EMAIL_ORDER_PAID")).toBe("legacy.owner_order_paid");
    expect(canonicalEmailEventFor("BUYER_EMAIL_ORDER_READY")).toBe("order.completed.customer");
  });
  it.each(EMAIL_EVENT_REGISTRY)("renders $key with optional fields absent and escaped facts", (row) => {
    const email = renderEventNotification(row.key, { order_code: '<script>alert("x")</script>', password: "secret-never-render", credentials: "secret-never-render" }, brand);
    expect(email.subject).toBe(row.label);
    expect(email.html).toContain("&lt;script&gt;");
    expect(email.html).not.toContain('<script>');
    expect(email.text).toContain(row.description);
    expect(email.text).not.toContain("secret-never-render");
    expect(email.subject).not.toContain("alert");
  });
});
