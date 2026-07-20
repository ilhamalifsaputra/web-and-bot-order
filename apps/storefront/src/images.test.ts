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
