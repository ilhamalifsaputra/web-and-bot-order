/**
 * WebP derivative generation. The load-bearing test here is
 * "leaves the original untouched": product photos and the banner are read back
 * off disk by the bot and uploaded to Telegram (apps/order-bot/src/util/
 * banner.ts), so converting an original in place could silently stop product
 * photos arriving in chat. If that assertion ever fails, the bug is in the
 * code, not the test.
 */
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import sharp from "sharp";
import {
  deleteWebpVariants,
  generateWebpVariants,
  isConvertible,
  isVariant,
  variantName,
} from "../src/lib/webpVariants";

let dir: string;
/** Bytes of the original, captured before any conversion runs. */
let originalBytes: Buffer;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "webp-variants-"));
  await sharp({ create: { width: 1200, height: 900, channels: 3, background: { r: 20, g: 80, b: 200 } } })
    .jpeg()
    .toFile(join(dir, "product-wide.jpg"));
  // Narrower than every requested width — must not be upscaled into copies.
  await sharp({ create: { width: 300, height: 200, channels: 3, background: { r: 200, g: 40, b: 40 } } })
    .png()
    .toFile(join(dir, "product-narrow.png"));
  originalBytes = readFileSync(join(dir, "product-wide.jpg"));
});

afterAll(() => {
  // Best effort: on Windows sharp keeps a handle on files it has read, so
  // removing the temp directory can fail EBUSY. Leaving a few bytes in the
  // OS temp dir is not worth failing the suite over.
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
  } catch {
    // ignored — the OS reclaims its own temp directory
  }
});

describe("generateWebpVariants", () => {
  it("writes one WebP per width and leaves the original byte-for-byte untouched", async () => {
    const created = await generateWebpVariants(dir, "product-wide.jpg", [400, 800, 1600]);
    expect(created).toBe(3);

    for (const width of [400, 800, 1600]) {
      const variant = join(dir, `product-wide-${width}.webp`);
      expect(existsSync(variant), `missing ${width}w variant`).toBe(true);
      expect((await sharp(variant).metadata()).format).toBe("webp");
    }

    // THE guarantee: the file the bot sends to Telegram is exactly as uploaded.
    const after = readFileSync(join(dir, "product-wide.jpg"));
    expect(after.equals(originalBytes)).toBe(true);
    expect((await sharp(join(dir, "product-wide.jpg")).metadata()).format).toBe("jpeg");
  });

  it("resizes down to each width without enlarging past the source", async () => {
    expect((await sharp(join(dir, "product-wide-400.webp")).metadata()).width).toBe(400);
    expect((await sharp(join(dir, "product-wide-1600.webp")).metadata()).width).toBe(1200);
  });

  it("stops once a width covers the whole image, instead of writing duplicates", async () => {
    const created = await generateWebpVariants(dir, "product-narrow.png", [400, 800, 1600]);
    // 400 already exceeds the 300px source, so 800/1600 would be the same picture.
    expect(created).toBe(1);
    expect(existsSync(join(dir, "product-narrow-400.webp"))).toBe(true);
    expect(existsSync(join(dir, "product-narrow-800.webp"))).toBe(false);
  });

  it("is idempotent — a second run creates nothing", async () => {
    const created = await generateWebpVariants(dir, "product-wide.jpg", [400, 800, 1600]);
    expect(created).toBe(0);
  });
});

describe("deleteWebpVariants", () => {
  it("removes the derivatives so a replaced image leaves no orphans", async () => {
    // A fixture of its own, never opened by sharp for reading: on Windows,
    // sharp keeps a handle on files it has inspected and unlink then fails
    // EBUSY. That's a quirk of the test host, not of this code (production
    // runs Linux, where unlink succeeds regardless of open handles), so the
    // test simply avoids provoking it.
    await sharp({ create: { width: 900, height: 600, channels: 3, background: { r: 9, g: 9, b: 9 } } })
      .jpeg()
      .toFile(join(dir, "product-doomed.jpg"));
    await generateWebpVariants(dir, "product-doomed.jpg", [400, 800]);
    expect(existsSync(join(dir, "product-doomed-400.webp"))).toBe(true);

    await deleteWebpVariants(dir, "product-doomed.jpg", [400, 800]);
    for (const width of [400, 800]) {
      expect(existsSync(join(dir, `product-doomed-${width}.webp`))).toBe(false);
    }
    // The original is not this function's business.
    expect(existsSync(join(dir, "product-doomed.jpg"))).toBe(true);
  });

  it("is silent when the derivatives were never created", async () => {
    await expect(deleteWebpVariants(dir, "never-existed.jpg", [400])).resolves.toBeUndefined();
  });
});

describe("filename rules", () => {
  it("names derivatives the way the storefront rebuilds them", () => {
    // Contract with apps/storefront/src/images.ts webpSrcset().
    expect(variantName("product-abc.jpg", 800)).toBe("product-abc-800.webp");
    expect(variantName("hero-x.png", 1600)).toBe("hero-x-1600.webp");
  });

  it("converts rasters but not favicons", () => {
    expect(isConvertible("product-abc.jpg")).toBe(true);
    expect(isConvertible("logo-abc.PNG")).toBe(true);
    expect(isConvertible("favicon-abc.svg")).toBe(false);
    expect(isConvertible("favicon-abc.ico")).toBe(false);
  });

  it("never treats a derivative as a source, so re-runs can't cascade", () => {
    expect(isVariant("product-abc-800.webp")).toBe(true);
    expect(isConvertible("product-abc-800.webp")).toBe(false);
    expect(isVariant("product-abc.webp")).toBe(false);
  });
});
