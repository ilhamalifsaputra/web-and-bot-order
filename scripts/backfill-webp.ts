/**
 * Idempotent WebP backfill for images uploaded before the derivatives existed.
 *
 *   pnpm images:backfill [path-to-uploads-dir] [--dry-run]
 *
 * New uploads get their WebP siblings automatically (apps/web-admin/src/lib/
 * upload.ts). Everything already on disk when that shipped does not — so
 * without this script every existing product photo keeps being served as a
 * full-size PNG/JPEG, and the "use a modern image format" / "serve properly
 * sized images" findings stay open for the whole catalog.
 *
 * SAFETY: this only ever CREATES `<name>-<width>.webp` files. Originals are
 * read and never modified, moved or deleted — the bot uploads those same files
 * to Telegram (apps/order-bot/src/util/banner.ts), so touching them could stop
 * product photos arriving in chat. Re-running is harmless: existing
 * derivatives are skipped.
 */
import { readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  HERO_WIDTHS,
  LOGO_WIDTHS,
  PRODUCT_WIDTHS,
  generateWebpVariants,
  isConvertible,
} from "../apps/web-admin/src/lib/webpVariants";

/**
 * Widths per upload folder, mirroring the route wiring in
 * apps/web-admin/src/routes/{catalogPhoto,branding}.ts.
 *
 * handleUpload names every file `<kind>-<random>.<ext>`, so the prefix tells us
 * which upload a file came from. Branding mixes four kinds in one directory and
 * they must NOT be treated alike: `hero-` and `logo-` are web images, `banner-`
 * is uploaded to Telegram by the bot, and `favicon-` is an ICO/SVG. Returning
 * null means "leave this file alone".
 */
const FOLDERS: Array<{ dir: string; label: string; widthsFor: (filename: string) => number[] | null }> = [
  { dir: "products", label: "product photos", widthsFor: () => PRODUCT_WIDTHS },
  {
    dir: "branding",
    label: "branding images",
    widthsFor: (filename) => {
      if (filename.startsWith("hero-")) return HERO_WIDTHS;
      if (filename.startsWith("logo-")) return LOGO_WIDTHS;
      return null; // banner- (Telegram), favicon-, or anything unrecognised
    },
  },
];

function resolveUploadsDir(): string {
  const arg = process.argv[2];
  if (arg && !arg.startsWith("--")) return arg;
  return process.env.UPLOADS_DIR ?? join(process.cwd(), "data", "uploads");
}

async function main(): Promise<void> {
  const dryRun = process.argv.includes("--dry-run");
  const uploadsDir = resolveUploadsDir();

  if (!existsSync(uploadsDir)) {
    console.error(`No uploads directory at ${uploadsDir}. Pass the path as the first argument.`);
    process.exitCode = 1;
    return;
  }

  let totalImages = 0;
  let totalCreated = 0;
  let totalSkipped = 0;
  let totalFailed = 0;

  for (const folder of FOLDERS) {
    const dir = join(uploadsDir, folder.dir);
    if (!existsSync(dir)) continue;

    const entries = await readdir(dir);
    for (const filename of entries) {
      if (!isConvertible(filename)) continue;
      const widths = folder.widthsFor(filename);
      if (!widths) continue;

      totalImages += 1;
      if (dryRun) continue;
      try {
        const created = await generateWebpVariants(dir, filename, widths);
        totalCreated += created;
        if (created === 0) totalSkipped += 1;
      } catch (err) {
        totalFailed += 1;
        console.error(`Could not convert ${folder.label} entry: ${(err as Error).message}`);
      }
    }
  }

  if (dryRun) {
    console.log(`Dry run: found ${totalImages} images eligible for WebP derivatives. Nothing written.`);
    return;
  }
  console.log(
    `Scanned ${totalImages} images; created ${totalCreated} WebP derivatives, ` +
      `${totalSkipped} already had theirs, ${totalFailed} failed. Originals untouched.`,
  );
}

void main();
