/**
 * Slug helper shared by the catalog crud (new-row creation) and the catalog
 * rename migration / backfill script. Kept dependency-free (no Prisma, no
 * config) so the standalone cutover scripts can import it cheaply.
 */

/** Lowercase, ASCII, hyphen-separated handle derived from a display name. */
export function slugify(name: string): string {
  const base = name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "") // strip combining diacritics
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60)
    .replace(/-+$/g, "");
  return base || "item";
}

/**
 * Deterministic unique-slug allocator backed by an in-memory `taken` set — the
 * migration fills slugs in one pass, so it dedupes against rows already slugged
 * in this run. Collisions get a `-<n>` suffix (n≥2); a still-colliding suffix
 * falls back to `-<id>` to guarantee termination.
 */
export function uniqueSlug(name: string, id: number, taken: Set<string>): string {
  const base = slugify(name);
  let candidate = base;
  for (let n = 2; taken.has(candidate); n++) {
    candidate = `${base}-${n}`;
    if (n > 1000) {
      candidate = `${base}-${id}`;
      break;
    }
  }
  taken.add(candidate);
  return candidate;
}
