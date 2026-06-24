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
