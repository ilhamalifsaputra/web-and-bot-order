import { describe, it, expect } from "vitest";
import { escapeHtml } from "./escape";

describe("escapeHtml", () => {
  it("escapes &, <, >, \", '", () => {
    expect(escapeHtml("&")).toBe("&amp;");
    expect(escapeHtml("<")).toBe("&lt;");
    expect(escapeHtml(">")).toBe("&gt;");
    expect(escapeHtml('"')).toBe("&quot;");
    expect(escapeHtml("'")).toBe("&#x27;");
  });

  it("round-trips a full XSS payload to inert text", () => {
    const payload = `<script>alert(1)</script>`;
    const escaped = escapeHtml(payload);
    expect(escaped).not.toContain("<");
    expect(escaped).not.toContain(">");
    expect(escaped).toBe("&lt;script&gt;alert(1)&lt;/script&gt;");
  });

  it("round-trips an attribute-breakout XSS payload to inert text", () => {
    const payload = `"><img src=x onerror=alert(1)>`;
    const escaped = escapeHtml(payload);
    expect(escaped).not.toContain("<");
    expect(escaped).not.toContain(">");
    expect(escaped).not.toContain('"');
  });

  it("leaves ordinary text untouched", () => {
    expect(escapeHtml("Order ORD-20260807-ABCD")).toBe("Order ORD-20260807-ABCD");
  });
});
