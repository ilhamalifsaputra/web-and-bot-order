import type { SortKey } from "../api/types";

export interface GroupPageQuery {
  /** Category slugs to narrow to; empty means every category of the group. */
  categories?: readonly string[];
  sort?: SortKey;
  offset: number;
  limit: number;
  /** Ranking version of the first page, so later pages keep its order. */
  v?: number | null;
}

/** URL of GET /api/v1/pages/group/:slug (apps/storefront/src/pageData.ts
 * groupPageData). Categories are comma-joined, each slug encoded on its own,
 * and `bestseller` (the default) is left out like everywhere else. */
export function groupPageUrl(slug: string, q: GroupPageQuery): string {
  const parts: string[] = [];
  if (q.categories && q.categories.length > 0) parts.push(`category=${q.categories.map(encodeURIComponent).join(",")}`);
  if (q.sort && q.sort !== "bestseller") parts.push(`sort=${q.sort}`);
  parts.push(`offset=${q.offset}`, `limit=${q.limit}`);
  if (q.v !== undefined && q.v !== null) parts.push(`v=${q.v}`);
  return `/api/v1/pages/group/${encodeURIComponent(slug)}?${parts.join("&")}`;
}

/** Append `next` to `shown`, dropping slugs already present (a ranking that
 * moved between pages can repeat a product). */
export function appendUnique<T extends { slug: string }>(shown: readonly T[], next: readonly T[]): T[] {
  const seen = new Set(shown.map((p) => p.slug));
  const out = [...shown];
  for (const p of next) {
    if (seen.has(p.slug)) continue;
    seen.add(p.slug);
    out.push(p);
  }
  return out;
}
