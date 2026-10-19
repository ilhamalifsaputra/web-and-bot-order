/** One brand's automatic game-region outcome, as /sync/apply reports it. */
export interface RegionImportOutcome {
  brand: string;
  written: boolean;
  label: string | null;
  skippedReason: string | null;
  suffix: string | null;
}

const MAX_LISTED_SUFFIXES = 3;

/**
 * Skip reasons that are not a failure and never reach the toast: the brand's
 * Product already existed (it keeps its own region), the target category is not
 * a Game Top-up one (Premium Apps / legacy have no region concept), or the
 * brand name simply has no "(Region)" suffix.
 */
const SILENT_REASONS = new Set(["product_exists", "not_game_topup_category", "no_suffix"]);

/**
 * One short sentence for the import toast about brands that did not get an
 * automatic region, or "" when there is nothing actionable to say (an older
 * server that sends no `regions`, an empty list, every brand written, or only
 * silent skips). Counts cover the reportable brands only (written plus
 * actionable skips) so the sentence reads consistently.
 */
export function regionImportNote(regions: RegionImportOutcome[] | undefined): string {
  if (!regions || regions.length === 0) return "";
  const skipped = regions.filter((r) => !r.written && !SILENT_REASONS.has(r.skippedReason ?? ""));
  if (skipped.length === 0) return "";
  const written = regions.filter((r) => r.written).length;
  const suffixes = [
    ...new Set(skipped.filter((r) => r.skippedReason === "unrecognized_suffix" && r.suffix).map((r) => r.suffix as string)),
  ];
  const details: string[] = [];
  if (suffixes.length) {
    details.push(`unrecognised suffix: ${suffixes.slice(0, MAX_LISTED_SUFFIXES).join(", ")}${suffixes.length > MAX_LISTED_SUFFIXES ? ", …" : ""}`);
  }
  if (skipped.some((r) => r.skippedReason === "no_price_list")) {
    details.push("price list unavailable, regions not filled automatically");
  }
  if (skipped.some((r) => r.skippedReason === "no_matching_group")) {
    details.push("no matching game group, regions not filled automatically");
  }
  const detail = details.length ? ` (${details.join("; ")})` : "";
  return `${written} of ${written + skipped.length} brands got an automatic region; ${skipped.length} skipped${detail}.`;
}
