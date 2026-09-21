/// <reference lib="dom" />
import { describe, it, expect, afterEach } from "vitest";
import { t, tCount, currentLang } from "./i18n";

afterEach(() => {
  document.documentElement.lang = "";
});

describe("currentLang", () => {
  it("reads a supported language from <html lang>", () => {
    document.documentElement.lang = "id";
    expect(currentLang()).toBe("id");
  });

  it("falls back to en for unsupported values (e.g. the raw __LANG__ placeholder)", () => {
    document.documentElement.lang = "__LANG__";
    expect(currentLang()).toBe("en");
  });
});

describe("tCount", () => {
  it("uses the _one variant for exactly 1 and the plain key otherwise", () => {
    expect(tCount("web.review_count", 1, {}, "en")).toBe("1 review");
    expect(tCount("web.review_count", 0, {}, "en")).toBe("0 reviews");
    expect(tCount("web.review_count", 2, {}, "en")).toBe("2 reviews");
    expect(tCount("web.review_count", 1, {}, "id")).toBe("1 ulasan");
  });

  it("falls back to the plain key when there is no _one variant", () => {
    expect(tCount("web.stock_left", 1, {}, "en")).toBe("1 left");
  });
});

describe("t", () => {
  it("resolves a key in the page language", () => {
    document.documentElement.lang = "id";
    const id = t("web.nav_cart");
    const en = t("web.nav_cart", {}, "en");
    expect(id).not.toBe("web.nav_cart");
    expect(en).not.toBe("web.nav_cart");
    expect(id).not.toBe(en); // "Keranjang" vs "Cart" — proves lang routing
  });

  it("falls back to the raw key for unknown keys", () => {
    expect(t("web.__does_not_exist__")).toBe("web.__does_not_exist__");
  });

  it("substitutes {placeholder} args", () => {
    expect(t("web.stock_left", { count: 7 }, "en")).toBe("7 left");
  });

  it("leaves the template intact when a placeholder is missing (core parity)", () => {
    // Mirrors packages/core/src/i18n.ts format(): missing arg = unformatted template.
    expect(t("web.stock_left", { unrelated: 1 }, "en")).toBe("{count} left");
  });
});
