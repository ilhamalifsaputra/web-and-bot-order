/**
 * Region labels the Digiflazz import may write into `Product.gameRegion`.
 *
 * DRAFT for the shop owner to correct and extend: adding a country is one row.
 * Only a suffix found here is ever written; anything else (a publisher such as
 * "Garena" or "Activision", an unlisted country) yields null so it is left for
 * an admin to fill. The abbreviations `id`/`sg`/`my` are assumptions taken from
 * the region tokens in detection/knowledge/defaultVocabulary.ts.
 *
 * Each label must fit one narrow button (NARROW_LABEL_WIDTH cells, a flag
 * emoji counts 2) — regionLabel.test.ts enforces it.
 */
const GAME_REGION_LABELS: ReadonlyArray<{ tokens: readonly string[]; label: string }> = [
  { tokens: ["indonesia", "id"], label: "\u{1F1EE}\u{1F1E9} Indonesia" },
  { tokens: ["malaysia", "my"], label: "\u{1F1F2}\u{1F1FE} Malaysia" },
  { tokens: ["singapore", "sg"], label: "\u{1F1F8}\u{1F1EC} Singapore" },
  { tokens: ["filipina"], label: "\u{1F1F5}\u{1F1ED} Filipina" },
  { tokens: ["russia"], label: "\u{1F1F7}\u{1F1FA} Russia" },
  { tokens: ["brazil"], label: "\u{1F1E7}\u{1F1F7} Brazil" },
  { tokens: ["global"], label: "\u{1F310} Global" },
];

const LABEL_BY_TOKEN: ReadonlyMap<string, string> = new Map(
  GAME_REGION_LABELS.flatMap((row) => row.tokens.map((token) => [token, row.label] as const)),
);

function normalizeToken(raw: string): string {
  return raw.trim().replace(/\s+/g, " ").toLowerCase();
}

/** The flagged label for a Digiflazz "(Region)" suffix, or null when the
 * suffix is not a known region (never a publisher or an unlisted country). */
export function gameRegionLabel(rawSuffix: string | null | undefined): string | null {
  if (!rawSuffix) return null;
  return LABEL_BY_TOKEN.get(normalizeToken(rawSuffix)) ?? null;
}

/** Every normalized suffix token the table recognizes, for callers (the
 * backfill) that must tell a known region from any other suffix. */
export function knownGameRegionTokens(): string[] {
  return [...LABEL_BY_TOKEN.keys()];
}

/** The labels themselves, for width checks and documentation. */
export function knownGameRegionLabels(): string[] {
  return GAME_REGION_LABELS.map((row) => row.label);
}
