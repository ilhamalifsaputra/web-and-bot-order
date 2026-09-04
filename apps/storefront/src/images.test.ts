/**
 * webpSrcset() — the storefront half of the WebP contract. web-admin writes
 * `<name>-<width>.webp` next to each upload (apps/web-admin/src/lib/
 * webpVariants.ts); this rebuilds those names and reports only the ones that
 * actually exist, so an image uploaded before the derivatives existed still
 * renders instead of pointing at a 404.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

let uploadsDir: string;

// webpSrcset reads UPLOADS_DIR at module load, so point it at a temp tree
// before importing. Matches the "setup-env first" pattern in test/setup-env.ts.
beforeAll(() => {
  uploadsDir = mkdtempSync(join(tmpdir(), "storefront-uploads-"));
  process.env.UPLOADS_DIR = uploadsDir;
  mkdirSync(join(uploadsDir, "products"), { recursive: true });
  // Only two of the three widths exist — a narrow source stops early
  // (webpVariants.ts), so the srcset must describe reality, not the wish list.
  writeFileSync(join(uploadsDir, "products", "product-abc-400.webp"), "x");
  writeFileSync(join(uploadsDir, "products", "product-abc-800.webp"), "x");
});

afterAll(() => {
  delete process.env.UPLOADS_DIR;
  try {
    rmSync(uploadsDir, { recursive: true, force: true, maxRetries: 3 });
  } catch {
    // ignored — OS temp dir
  }
});

describe("defaultThumbKind", () => {
  it("uses the admin's thumbnailKind override when set", async () => {
    const { defaultThumbKind } = await import("./images");
    expect(
      defaultThumbKind(
        { thumbnailKind: "voucher" },
        { group: null, name: "Anything" },
      ),
    ).toBe("voucher");
  });

  it("forces generic for PREMIUM_APPS even when an admin override is set", async () => {
    const { defaultThumbKind } = await import("./images");
    expect(
      defaultThumbKind(
        { thumbnailKind: "game" },
        { group: "PREMIUM_APPS", name: "Design Software" },
      ),
    ).toBe("generic");
  });

  it("forces generic for PREMIUM_APPS even with no thumbnailKind set", async () => {
    const { defaultThumbKind } = await import("./images");
    expect(
      defaultThumbKind(
        { thumbnailKind: null },
        { group: "PREMIUM_APPS", name: "Netflix-ish App" },
      ),
    ).toBe("generic");
  });

  it("falls back to game for GAME_TOPUP categories with no override", async () => {
    const { defaultThumbKind } = await import("./images");
    expect(
      defaultThumbKind({ thumbnailKind: null }, { group: "GAME_TOPUP", name: "Mobile Legends" }),
    ).toBe("game");
  });

  it("matches heuristic substrings on the category name, in priority order", async () => {
    const { defaultThumbKind } = await import("./images");
    const cases: Array<[string, string]> = [
      ["Voucher Game", "voucher"],
      ["Gift Card", "voucher"],
      ["Steam Wallet", "steam"],
      ["Netflix", "entertainment"],
      ["Spotify Premium", "entertainment"],
      ["HBO Max", "entertainment"],
      ["Disney+", "entertainment"],
      ["Live Streaming", "entertainment"],
      ["Film & Series", "entertainment"],
      ["Music Pass", "entertainment"],
      ["Aplikasi Musik", "entertainment"],
      ["Aplikasi Kantor", "app"],
      ["App Store Gift", "voucher"], // "gift" substring wins over "app"
      ["Software Design", "app"],
    ];
    for (const [name, expected] of cases) {
      expect(
        defaultThumbKind({ thumbnailKind: null }, { group: null, name }),
        `category name "${name}"`,
      ).toBe(expected);
    }
  });

  it("falls back to generic when nothing matches", async () => {
    const { defaultThumbKind } = await import("./images");
    expect(defaultThumbKind({ thumbnailKind: null }, { group: null, name: "Miscellaneous" })).toBe(
      "generic",
    );
  });

  it("treats a null/undefined category as no match (generic)", async () => {
    const { defaultThumbKind } = await import("./images");
    expect(defaultThumbKind({ thumbnailKind: null }, null)).toBe("generic");
    expect(defaultThumbKind({ thumbnailKind: null }, undefined)).toBe("generic");
  });

  it("ignores an unrecognized thumbnailKind value and falls through to the heuristic", async () => {
    const { defaultThumbKind } = await import("./images");
    expect(
      defaultThumbKind(
        { thumbnailKind: "not-a-real-kind" },
        { group: null, name: "Netflix" },
      ),
    ).toBe("entertainment");
  });
});

describe("productImage", () => {
  it("returns the admin-set webImageUrl verbatim", async () => {
    const { productImage } = await import("./images");
    expect(productImage({ webImageUrl: "/uploads/products/a.jpg" })).toBe(
      "/uploads/products/a.jpg",
    );
  });

  it("returns null (no stock-photo fallback of any kind) when there is no webImageUrl", async () => {
    const { productImage } = await import("./images");
    expect(productImage({ webImageUrl: null })).toBeNull();
    expect(productImage({})).toBeNull();
  });
});

describe("webpSrcset", () => {
  it("lists only the derivatives that exist on disk", async () => {
    const { webpSrcset, clearSrcsetCache } = await import("./images");
    clearSrcsetCache();
    const srcset = webpSrcset("/uploads/products/product-abc.jpg", [400, 800, 1600]);
    expect(srcset).toBe(
      "/uploads/products/product-abc-400.webp 400w, /uploads/products/product-abc-800.webp 800w",
    );
    expect(srcset).not.toContain("1600w");
  });

  it("returns null for an upload with no derivatives, so the caller renders a plain <img>", async () => {
    const { webpSrcset, clearSrcsetCache } = await import("./images");
    clearSrcsetCache();
    expect(webpSrcset("/uploads/products/legacy-photo.png", [400, 800])).toBeNull();
  });

  it("ignores hotlinked and empty images", async () => {
    const { webpSrcset, clearSrcsetCache } = await import("./images");
    clearSrcsetCache();
    // Unsplash already serves WebP via auto=format — nothing to add.
    expect(webpSrcset("https://images.unsplash.com/photo-123?w=800&auto=format", [400])).toBeNull();
    expect(webpSrcset(null, [400])).toBeNull();
    expect(webpSrcset("", [400])).toBeNull();
  });

  it("refuses to probe outside the uploads tree", async () => {
    const { webpSrcset, clearSrcsetCache } = await import("./images");
    clearSrcsetCache();
    expect(webpSrcset("/uploads/../../etc/passwd", [400])).toBeNull();
  });
});
