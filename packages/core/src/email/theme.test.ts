import { describe, it, expect } from "vitest";
import { buildThemeStyleBlock, resolveTokens } from "./theme";
import type { BrandConfig } from "./types";

const brand: BrandConfig = {
  shopName: "Acme Shop",
  logoUrl: null,
  accentColor: "#4F46E5",
  supportEmail: null,
  storeUrl: null,
};

describe("resolveTokens", () => {
  it("returns light-mode tokens including the given accent color", () => {
    const tokens = resolveTokens(brand);
    expect(tokens.accent).toBe("#4F46E5");
    expect(tokens.bg).toMatch(/^#/);
    expect(tokens.surface).toMatch(/^#/);
    expect(tokens.text).toMatch(/^#/);
    expect(tokens.muted).toMatch(/^#/);
    expect(tokens.border).toMatch(/^#/);
  });
});

describe("buildThemeStyleBlock", () => {
  it("contains a prefers-color-scheme: dark media query", () => {
    const block = buildThemeStyleBlock(brand);
    expect(block).toContain("prefers-color-scheme: dark");
  });

  it("carries the accent color through into the dark-mode block", () => {
    const block = buildThemeStyleBlock(brand);
    expect(block).toContain("#4F46E5");
  });

  it("contains no CSS custom properties (var(--x))", () => {
    const block = buildThemeStyleBlock(brand);
    expect(block).not.toContain("var(--");
  });

  it("escapes a malicious accentColor value in the dark-mode block", () => {
    const malicious: BrandConfig = { ...brand, accentColor: '"}</style><script>alert(1)</script>' };
    const block = buildThemeStyleBlock(malicious);
    expect(block).not.toContain("<script>alert(1)</script>");
    expect(block).not.toContain("</style>");
  });
});
