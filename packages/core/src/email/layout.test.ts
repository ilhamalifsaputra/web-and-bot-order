import { describe, it, expect } from "vitest";
import { renderShell } from "./layout";
import type { BrandConfig } from "./types";

const brand: BrandConfig = {
  shopName: "Acme Shop",
  logoUrl: null,
  accentColor: "#4F46E5",
  supportEmail: null,
  storeUrl: null,
};

describe("renderShell", () => {
  it("contains a max-width:600px container declaration", () => {
    const html = renderShell({ brand, bodyHtml: "<p>hi</p>" });
    expect(html).toMatch(/max-width:\s*600px/);
  });

  it("contains a prefers-color-scheme: dark media block", () => {
    const html = renderShell({ brand, bodyHtml: "<p>hi</p>" });
    expect(html).toContain("prefers-color-scheme: dark");
  });

  it("omits the logo <img> entirely when logoUrl is null", () => {
    const html = renderShell({ brand, bodyHtml: "<p>hi</p>" });
    expect(html).not.toContain("<img");
  });

  it("renders a logo <img> with the given src when logoUrl is set", () => {
    const withLogo: BrandConfig = { ...brand, logoUrl: "https://example.com/logo.png" };
    const html = renderShell({ brand: withLogo, bodyHtml: "<p>hi</p>" });
    expect(html).toContain("<img");
    expect(html).toContain("https://example.com/logo.png");
  });

  it("never renders an empty-src img even if logoUrl is an empty string", () => {
    const emptyLogo: BrandConfig = { ...brand, logoUrl: "" };
    const html = renderShell({ brand: emptyLogo, bodyHtml: "<p>hi</p>" });
    expect(html).not.toContain('src=""');
  });

  it("includes the shop name as text in the header", () => {
    const html = renderShell({ brand, bodyHtml: "<p>hi</p>" });
    expect(html).toContain("Acme Shop");
  });

  it("includes the given bodyHtml", () => {
    const html = renderShell({ brand, bodyHtml: "<p>unique-marker-xyz</p>" });
    expect(html).toContain("unique-marker-xyz");
  });

  it("includes a doctype and html/head/body structure", () => {
    const html = renderShell({ brand, bodyHtml: "<p>hi</p>" });
    expect(html).toMatch(/^<!doctype html>/i);
    expect(html).toContain("<html");
    expect(html).toContain("<head>");
    expect(html).toContain("<body");
  });

  it("omits the preheader div when preheader is not given", () => {
    const html = renderShell({ brand, bodyHtml: "<p>hi</p>" });
    // "preheader" never appears literally in the markup either way, so assert
    // against the div's actual distinguishing marker (mso-hide:all, only ever
    // emitted by the preheader div) instead — a vacuous string check here
    // would keep passing even if the omission logic broke.
    expect(html).not.toContain("mso-hide:all");
  });

  it("includes a hidden preheader div with the given text when preheader is given", () => {
    const html = renderShell({ brand, bodyHtml: "<p>hi</p>", preheader: "Your order is paid" });
    expect(html).toContain("Your order is paid");
  });

  it("uses a role=\"presentation\" table for the container", () => {
    const html = renderShell({ brand, bodyHtml: "<p>hi</p>" });
    expect(html).toContain('role="presentation"');
  });

  it("rejects a malicious accentColor value in the header rule outright, falling back to the coded default rather than escaping-and-including it", () => {
    // theme.ts's resolveAccentColor (used by resolveTokens, which this
    // shell's accent rule reads from) now rejects anything that isn't a
    // clean 6-digit hex code before it ever reaches markup — a stronger
    // guarantee than escaping alone: the malicious value doesn't appear in
    // ANY form (raw or escaped), it's replaced with "#4F46E5" instead.
    const malicious: BrandConfig = { ...brand, accentColor: '"><script>alert(1)</script>' };
    const html = renderShell({ brand: malicious, bodyHtml: "<p>hi</p>" });
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).not.toContain("&quot;&gt;&lt;script&gt;");
    expect(html).toContain("background-color:#4F46E5;");
  });
});
