/**
 * Central image map (design.md §6). Product.imageFileId is a Telegram file_id —
 * unusable as an <img src> — so the web resolves images in this order:
 *   1. Product.webImageUrl (admin-set, added in plan.md §8) — wired in Phase 4;
 *   2. a curated Unsplash photo per CATEGORY name (below);
 *   3. a neutral placeholder.
 * Everything lives in this one file so swapping imagery = editing one map.
 * TODO: ganti dengan foto produk asli sebelum produksi (jangan hotlink Unsplash
 * pada skala besar — lihat plan.md §17.2 #8).
 */

import { existsSync } from "node:fs";
import { dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** Keep images light: card-sized, compressed, cropped. */
const UNSPLASH_PARAMS = "?w=800&q=80&auto=format&fit=crop";

const u = (id: string) => `https://images.unsplash.com/${id}${UNSPLASH_PARAMS}`;

/** Neutral fallback — soft tech desk shot that fits any digital product. */
export const PLACEHOLDER = u("photo-1498050108023-c5249f4df085");

/**
 * Category name (lowercased, contains-match) → Unsplash photo. Order matters:
 * the first key contained in the category name wins.
 */
const CATEGORY_IMAGES: Array<[needle: string, url: string]> = [
  ["netflix", u("photo-1574375927938-d5a98e8ffe85")], // TV remote / dark screen
  ["stream", u("photo-1522869635100-9f4c5e86aa37")], // movie night
  ["film", u("photo-1489599849927-2ee91cede3ba")], // cinema
  ["spotify", u("photo-1611339555312-e607c8352fd7")], // headphones green
  ["music", u("photo-1493225457124-a3eb161ffa5f")], // concert
  ["musik", u("photo-1493225457124-a3eb161ffa5f")],
  ["game", u("photo-1542751371-adc38448a05e")], // gaming setup
  ["gaming", u("photo-1593305841991-05c297ba4575")],
  ["vpn", u("photo-1563013544-824ae1b704d3")], // security lock
  ["keamanan", u("photo-1563013544-824ae1b704d3")],
  ["software", u("photo-1461749280684-dccba630e2f6")], // code editor
  ["aplikasi", u("photo-1551650975-87deedd944c3")],
  ["app", u("photo-1551650975-87deedd944c3")],
  ["edu", u("photo-1456513080510-7bf3a84b82f8")], // study desk
  ["kursus", u("photo-1456513080510-7bf3a84b82f8")],
  ["ai", u("photo-1677442136019-21780ecad995")], // abstract AI
  ["cloud", u("photo-1544197150-b99a580bb7a8")], // server / network
  ["hosting", u("photo-1558494949-ef010cbdcc31")],
  ["design", u("photo-1626785774573-4b799315345d")],
  ["desain", u("photo-1626785774573-4b799315345d")],
  ["office", u("photo-1497032628192-86f99bcd76bc")],
  ["produktivitas", u("photo-1497032628192-86f99bcd76bc")],
];

/** Best Unsplash image for a category name; placeholder when nothing matches. */
export function categoryImage(name: string | null | undefined): string {
  const n = (name ?? "").toLowerCase();
  for (const [needle, url] of CATEGORY_IMAGES) {
    if (n.includes(needle)) return url;
  }
  return PLACEHOLDER;
}

/**
 * Image for a product card/detail. `webImageUrl` (admin override, Phase 4
 * column) wins; falls back to the category map, then the placeholder.
 */
export function productImage(
  p: { webImageUrl?: string | null },
  categoryName: string | null | undefined,
): string {
  if (p.webImageUrl) return p.webImageUrl;
  return categoryImage(categoryName);
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
