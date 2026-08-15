/**
 * Replacing an upload while its WebP siblings are still being written.
 *
 * Variant generation is deliberately not awaited before the upload responds —
 * the admin shouldn't wait through three sharp passes. But sharp keeps the
 * source file open while it reads, and on Windows deleting an open file fails
 * with EBUSY. The upload path swallowed that failure, so replacing a photo
 * twice in quick succession left the first one on disk forever, and the
 * variants written after the delete outlived the image they came from.
 */
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import sharp from "sharp";
import { deleteOldUpload } from "../src/lib/upload";
import {
  PRODUCT_WIDTHS,
  awaitWebpVariants,
  startWebpVariants,
  variantName,
} from "../src/lib/webpVariants";

const URL_PREFIX = "/uploads/products";

let dir: string;

/** A source wide enough that all three widths are generated, not clamped. */
async function writeSource(name: string): Promise<string> {
  await sharp({
    create: { width: 2400, height: 1800, channels: 3, background: { r: 30, g: 90, b: 160 } },
  })
    .png()
    .toFile(join(dir, name));
  return name;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "upload-cleanup-"));
});

afterEach(() => {
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
  } catch {
    // ignored — the OS reclaims its own temp directory
  }
});

describe("deleteOldUpload with variant generation in flight", () => {
  it("removes the original even though sharp is still reading it", async () => {
    const name = await writeSource("product-replaced.png");

    // Exactly what the upload path does: kick generation off, don't wait.
    startWebpVariants(dir, name, PRODUCT_WIDTHS);
    await deleteOldUpload(URL_PREFIX, dir, `${URL_PREFIX}/${name}`, PRODUCT_WIDTHS);

    expect(existsSync(join(dir, name))).toBe(false);
  });

  it("leaves no variant behind, including ones written after the delete began", async () => {
    const name = await writeSource("product-orphans.png");

    startWebpVariants(dir, name, PRODUCT_WIDTHS);
    await deleteOldUpload(URL_PREFIX, dir, `${URL_PREFIX}/${name}`, PRODUCT_WIDTHS);

    const survivors = PRODUCT_WIDTHS.filter((w) => existsSync(join(dir, variantName(name, w))));
    expect(survivors).toEqual([]);
  });
});

describe("awaitWebpVariants", () => {
  it("resolves only once the tracked generation has written its variants", async () => {
    const name = await writeSource("product-tracked.png");

    startWebpVariants(dir, name, PRODUCT_WIDTHS);
    expect(existsSync(join(dir, variantName(name, 400)))).toBe(false);

    await awaitWebpVariants(dir, name);

    expect(existsSync(join(dir, variantName(name, 400)))).toBe(true);
  });

  it("resolves immediately for a file nothing is working on", async () => {
    await expect(awaitWebpVariants(dir, "product-never-started.png")).resolves.toBeUndefined();
  });
});
