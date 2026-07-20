/**
 * WebP derivatives for admin-uploaded images.
 *
 * ⚠ The ORIGINAL upload is never converted, resized or deleted here — only
 * read. That is a hard constraint, not a preference: product photos and the
 * shop banner are dual-use. The storefront shows them with an <img>, but the
 * bot also reads the same file off disk and uploads it to Telegram as an
 * InputFile (apps/order-bot/src/util/banner.ts, util/productPhoto.ts). Rewrite
 * `product-abc.jpg` as WebP in place and `sendPhoto` starts receiving a format
 * Telegram makes no guarantees about — product photos could silently stop
 * arriving in the bot. So the web gets siblings and the bot keeps the original.
 *
 * Naming: `product-abc.jpg` → `product-abc-400.webp`, `product-abc-800.webp`, …
 * The storefront rebuilds these names from the stored URL and checks which ones
 * exist (apps/storefront/src/images.ts), so the naming here is a contract
 * between the two apps — change it in both or not at all.
 */
import { existsSync } from "node:fs";
import { unlink } from "node:fs/promises";
import { extname, join } from "node:path";
import sharp from "sharp";
import { logger } from "@app/core/logger";

/** Widths generated for each image kind. Shared with the backfill script. */
export const PRODUCT_WIDTHS = [400, 800, 1600];
export const HERO_WIDTHS = [800, 1600];
export const LOGO_WIDTHS = [160, 320];

/** Formats worth converting. SVG is already tiny and resolution-independent; ICO is a favicon. */
const CONVERTIBLE_EXTENSIONS = new Set([".jpg", ".jpeg", ".png", ".webp"]);

/** Whether this filename is a raster we can derive WebP from. */
export function isConvertible(filename: string): boolean {
  return CONVERTIBLE_EXTENSIONS.has(extname(filename).toLowerCase()) && !isVariant(filename);
}

/** Whether this filename is itself a generated derivative (so we never derive from a derivative). */
export function isVariant(filename: string): boolean {
  return /-\d+\.webp$/i.test(filename);
}

/** Derivative filename for `filename` at `width` — the naming contract with the storefront. */
export function variantName(filename: string, width: number): string {
  const ext = extname(filename);
  return `${filename.slice(0, filename.length - ext.length)}-${width}.webp`;
}

/**
 * Write the WebP derivatives of `dir/filename` that don't exist yet, and return
 * how many were created. Idempotent, so the backfill script can be re-run.
 *
 * Widths at or above the source width are clamped rather than upscaled, and
 * generation stops at the first width that already covers the whole image — so
 * a 500px-wide upload yields one 500px file instead of three identical copies.
 * The file is still *named* for the requested width, because that name is what
 * the storefront probes for.
 */
export async function generateWebpVariants(
  dir: string,
  filename: string,
  widths: number[],
): Promise<number> {
  const source = join(dir, filename);
  const image = sharp(source);
  const sourceWidth = (await image.metadata()).width ?? 0;

  let created = 0;
  for (const width of [...widths].sort((a, b) => a - b)) {
    const target = join(dir, variantName(filename, width));
    if (!existsSync(target)) {
      await sharp(source)
        .resize({ width, withoutEnlargement: true })
        .webp({ quality: 80 })
        .toFile(target);
      created += 1;
    }
    // This width already covers the full image; anything larger is the same picture.
    if (sourceWidth && width >= sourceWidth) break;
  }
  return created;
}

/**
 * Best-effort variant generation for the upload path. A failure here must never
 * fail the upload: the original is already written and every consumer falls
 * back to it (the storefront omits the <source> tag, the bot never used the
 * derivatives at all). Losing WebP costs page weight; failing the upload would
 * cost the admin their work.
 */
export async function tryGenerateWebpVariants(
  dir: string,
  filename: string,
  widths: number[],
): Promise<void> {
  try {
    await generateWebpVariants(dir, filename, widths);
  } catch (err) {
    logger.warn(
      { err },
      "Could not build the WebP versions of a freshly uploaded image. The upload itself succeeded and the site will serve the original file, so this only costs page weight — check that the sharp library is installed correctly for this platform.",
    );
  }
}

/** Remove the derivatives of a replaced/deleted upload so no orphans pile up. */
export async function deleteWebpVariants(
  dir: string,
  filename: string,
  widths: number[],
): Promise<void> {
  await Promise.all(
    widths.map((width) => unlink(join(dir, variantName(filename, width))).catch(() => undefined)),
  );
}
