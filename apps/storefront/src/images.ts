/**
 * Central image resolution (design.md §6, reworked Fase 12). Product.imageFileId
 * is a Telegram file_id — unusable as an <img src> — so the web resolves a
 * product's real photo in one step:
 *   1. Product.webImageUrl (admin-set, added in plan.md §8) — the only source
 *      of a real <img>; there is no photo fallback of any kind anymore.
 * When there is no real photo, the client renders a business-agnostic
 * design-system placeholder (DefaultThumb.tsx, a lucide icon in a tinted
 * well) instead of hotlinking a third-party stock photo. `defaultThumbKind()`
 * below computes WHICH icon that placeholder shows, in priority order:
 *   1. category.group === "PREMIUM_APPS" -> always "generic" (even over a
 *      stale admin override, so this rule can't be defeated by data that
 *      predates a category's reclassification).
 *   2. product.thumbnailKind, when it's a recognized admin-set value.
 *   3. a heuristic keyed on the category (GAME_TOPUP group, then a
 *      substring match on the category name) — reused verbatim from the
 *      Unsplash-era CATEGORY_IMAGES needle list below, just re-targeted from
 *      URLs to icon kinds.
 */

import { existsSync } from "node:fs";
import { dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CategoryGroup } from "@app/core/enums";

export type ThumbnailKind = "game" | "voucher" | "steam" | "entertainment" | "app" | "generic";

const RECOGNIZED_THUMBNAIL_KINDS: ReadonlySet<string> = new Set<ThumbnailKind>([
  "game",
  "voucher",
  "steam",
  "entertainment",
  "app",
  "generic",
]);

function isThumbnailKind(value: string | null | undefined): value is ThumbnailKind {
  return value != null && RECOGNIZED_THUMBNAIL_KINDS.has(value);
}

/**
 * Category name (lowercased, contains-match) -> heuristic ThumbnailKind.
 * Order matters: the first key contained in the category name wins. This is
 * the pre-Fase-12 CATEGORY_IMAGES needle list, unchanged in substance — only
 * re-targeted from an Unsplash URL per entry to an icon kind, and pruned to
 * the kinds `defaultThumbKind` actually distinguishes (vpn/edu/ai/cloud/
 * design/office etc. had no dedicated icon before or after; they fall
 * through to "generic" either way, same as an unmatched name always did).
 */
const CATEGORY_NAME_KINDS: Array<[needle: string, kind: ThumbnailKind]> = [
  ["voucher", "voucher"],
  ["gift", "voucher"],
  ["steam", "steam"],
  ["netflix", "entertainment"],
  ["stream", "entertainment"],
  ["film", "entertainment"],
  ["spotify", "entertainment"],
  ["hbo", "entertainment"],
  ["disney", "entertainment"],
  ["music", "entertainment"],
  ["musik", "entertainment"],
  ["software", "app"],
  ["aplikasi", "app"],
  ["app", "app"],
];

/**
 * Resolves which design-system placeholder icon a product falls back to when
 * it has no real photo (see productImage()). Read the file header for the
 * full priority order — the PREMIUM_APPS override in step 1 is intentionally
 * unconditional: it ignores `product.thumbnailKind` even when set, so a
 * category re-classified to PREMIUM_APPS after an admin set a game-ish
 * override can't keep showing game art.
 */
export function defaultThumbKind(
  product: { thumbnailKind?: string | null },
  category: { group: string | null; name: string } | null | undefined,
): ThumbnailKind {
  if (category?.group === CategoryGroup.PREMIUM_APPS) return "generic";
  if (isThumbnailKind(product.thumbnailKind)) return product.thumbnailKind;
  if (category?.group === CategoryGroup.GAME_TOPUP) return "game";
  const n = (category?.name ?? "").toLowerCase();
  for (const [needle, kind] of CATEGORY_NAME_KINDS) {
    if (n.includes(needle)) return kind;
  }
  return "generic";
}

/**
 * The product's real photo, or null when there isn't one — a null means
 * "render the DefaultThumb placeholder (keyed by defaultThumbKind)", never a
 * broken <img> and never a hotlinked stock photo standing in for one.
 */
export function productImage(p: { webImageUrl?: string | null }): string | null {
  return p.webImageUrl ?? null;
}

// --------------------------------------------------------------- WebP srcset

// Same directory web-admin writes uploads into (apps/web-admin/src/paths.ts) —
// one shared volume, so the derivatives it generates are readable from here.
const HERE = dirname(fileURLToPath(import.meta.url));
const UPLOADS_DIR = process.env.UPLOADS_DIR ?? join(HERE, "..", "..", "..", "data", "uploads");

/** Widths web-admin generates for product photos (webpVariants.ts PRODUCT_WIDTHS). */
export const PRODUCT_VARIANT_WIDTHS = [400, 800, 1600];

/**
 * Probing the filesystem is cheap but not free, and the same handful of images
 * is re-shaped on every catalog request. Derivatives only appear at upload time
 * (or via the backfill script), so a hit can be cached for the process's life.
 * A miss is cached too — that's the common case for pre-existing uploads, and
 * re-stat-ing those on every request would be the actual cost.
 *
 * The cache is keyed by URL. Replacing an image gives it a new random filename
 * (handleUpload), so a stale entry can't point at the wrong picture.
 */
const srcsetCache = new Map<string, string | null>();

/**
 * `srcset` of WebP derivatives for an admin-uploaded image, or null when there
 * are none — pre-existing uploads that predate the backfill, images sharp
 * couldn't convert, and every non-upload URL. Callers that get null render a
 * plain <img>, so a missing derivative degrades to today's behaviour instead of
 * a broken image.
 *
 * Unsplash URLs (the placeholder catalog imagery above) are skipped on purpose:
 * they already carry `auto=format`, so Unsplash serves WebP by itself.
 */
export function webpSrcset(url: string | null | undefined, widths: number[]): string | null {
  if (!url || !url.startsWith("/uploads/")) return null;
  const cached = srcsetCache.get(url);
  if (cached !== undefined) return cached;

  const relative = url.slice("/uploads/".length);
  // Defence in depth: the URL comes from the DB, and `..` in it would let a
  // crafted value probe outside the uploads tree.
  if (relative.includes("..")) {
    srcsetCache.set(url, null);
    return null;
  }
  const ext = extname(relative);
  const stem = relative.slice(0, relative.length - ext.length);

  const entries: string[] = [];
  for (const width of widths) {
    if (existsSync(join(UPLOADS_DIR, `${stem}-${width}.webp`))) {
      entries.push(`/uploads/${stem}-${width}.webp ${width}w`);
    }
  }
  const result = entries.length > 0 ? entries.join(", ") : null;
  srcsetCache.set(url, result);
  return result;
}

/** Test seam — the cache lives for the process, so tests that write files need to reset it. */
export function clearSrcsetCache(): void {
  srcsetCache.clear();
}
