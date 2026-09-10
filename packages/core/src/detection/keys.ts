/**
 * Canonical key construction for the Detection Engine.
 *
 * Builds `baseProductKey` / `productKey` / `skuKey` strings out of the
 * classified tokens produced by `extractFeatures` (features.ts). Pure
 * string serialization — no scoring/ranking logic lives here (that's
 * Task 4).
 *
 * INV-1 / INV-4 (determinism + key stability regardless of input array
 * order): every multi-token component is deduplicated and sorted with an
 * explicit `Array.prototype.sort` using a plain `<`/`>` comparator — never
 * `localeCompare`, and never left to rely on Set/Map iteration order for
 * anything observable in the output.
 */

import type { TokenCategory } from "./types";

type CategoryPair = { category: TokenCategory; canonical: string };

/**
 * Deduplicates `pairs` by `[category, canonical]` and returns them
 * lexicographically sorted (plain `<`/`>`, never `localeCompare`) as
 * `category=canonical` strings joined with `,`.
 */
function serializeSortedPairs(pairs: CategoryPair[]): string {
  const seen = new Set<string>();
  const serialized: string[] = [];
  for (const pair of pairs) {
    const entry = `${pair.category}=${pair.canonical}`;
    if (seen.has(entry)) continue;
    seen.add(entry);
    serialized.push(entry);
  }
  serialized.sort((a, b) => {
    if (a < b) return -1;
    if (a > b) return 1;
    return 0;
  });
  return serialized.join(",");
}

/**
 * baseProductKey = coreTokens joined with a single space. Core tokens are
 * NOT sorted — word order is meaningful for the base product name.
 */
export function buildBaseProductKey(coreTokens: string[]): string {
  return coreTokens.join(" ");
}

/**
 * productKey = `${baseProductKey}::${sortedDefiningPairs}`, or just
 * `baseProductKey` (no `::` suffix) when there are no defining tokens —
 * this is what makes AC-04's "same product, different distribution" case
 * collapse to the same productKey.
 */
export function buildProductKey(
  baseProductKey: string,
  definingTokens: CategoryPair[],
): string {
  const sortedDefiningPairs = serializeSortedPairs(definingTokens);
  return sortedDefiningPairs.length === 0
    ? baseProductKey
    : `${baseProductKey}::${sortedDefiningPairs}`;
}

/**
 * skuKey = `${productKey}::denom=${denomination normalized or "none"}${sortedDistributionSuffix}`,
 * where `sortedDistributionSuffix` is `""` when there are no distribution
 * tokens, or `,${sortedDistributionPairs}` otherwise (the leading comma
 * lives in the suffix itself, matching the `denom=...` segment having no
 * trailing separator of its own).
 */
export function buildSkuKey(
  productKey: string,
  denomination: string | null,
  distributionTokens: CategoryPair[],
): string {
  const sortedDistributionPairs = serializeSortedPairs(distributionTokens);
  const sortedDistributionSuffix =
    sortedDistributionPairs.length === 0 ? "" : `,${sortedDistributionPairs}`;
  return `${productKey}::denom=${denomination ?? "none"}${sortedDistributionSuffix}`;
}
