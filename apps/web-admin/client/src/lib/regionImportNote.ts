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
 * One short sentence for the import toast about brands that did not get an
 * automatic region, or "" when there is nothing to say (an older server that
 * sends no `regions`, an empty list, or every brand written). A brand whose
 * Product already existed keeps its own region by design, so it is not a skip.
 */
export function regionImportNote(regions: RegionImportOutcome[] | undefined): string {
  if (!regions || regions.length === 0) return "";
  const skipped = regions.filter((r) => !r.written && r.skippedReason !== "product_exists");
  if (skipped.length === 0) return "";
  const written = regions.filter((r) => r.written).length;
  const suffixes = [
    ...new Set(skipped.filter((r) => r.skippedReason === "unrecognized_suffix" && r.suffix).map((r) => r.suffix as string)),
  ];
  const detail = suffixes.length
    ? ` (unrecognised suffix: ${suffixes.slice(0, MAX_LISTED_SUFFIXES).join(", ")}${suffixes.length > MAX_LISTED_SUFFIXES ? ", …" : ""})`
    : "";
  return `${written} of ${regions.length} brands got an automatic region; ${skipped.length} skipped${detail}.`;
}
