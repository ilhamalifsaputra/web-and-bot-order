import { describe, it, expect } from "vitest";
import { ptSection, ptKeyValue, ptDivider } from "./plaintext";

describe("ptSection", () => {
  it("renders the heading text", () => {
    expect(ptSection("Order Summary")).toContain("Order Summary");
  });
});

describe("ptKeyValue", () => {
  it("renders label and value on one line", () => {
    const line = ptKeyValue("Total", "100 USDT");
    expect(line).toContain("Total");
    expect(line).toContain("100 USDT");
  });

  it("does not HTML-escape the value", () => {
    const line = ptKeyValue("Name", "<script>alert(1)</script>");
    expect(line).toContain("<script>alert(1)</script>");
  });
});

describe("ptDivider", () => {
  it("returns a non-empty separator", () => {
    expect(ptDivider().length).toBeGreaterThan(0);
  });
});
