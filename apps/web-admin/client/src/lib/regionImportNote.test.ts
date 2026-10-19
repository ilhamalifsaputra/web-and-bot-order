import { describe, expect, it } from "vitest";
import { regionImportNote, type RegionImportOutcome } from "./regionImportNote";

const outcome = (brand: string, over: Partial<RegionImportOutcome> = {}): RegionImportOutcome => ({
  brand, written: true, label: "Global", skippedReason: null, suffix: "Global", ...over,
});
const skip = (brand: string, skippedReason: string, suffix: string | null = null) =>
  outcome(brand, { written: false, label: null, skippedReason, suffix });

describe("regionImportNote", () => {
  it("says nothing about game regions for a Premium Apps or legacy category import", () => {
    expect(regionImportNote([skip("A", "not_game_topup_category"), skip("B", "not_game_topup_category")])).toBe("");
  });

  it("says nothing when every brand simply has no region suffix", () => {
    expect(regionImportNote([skip("A", "no_suffix"), skip("B", "no_suffix")])).toBe("");
  });

  it("says nothing when written is mixed only with silent skips", () => {
    expect(regionImportNote([outcome("A"), skip("B", "no_suffix"), skip("C", "product_exists")])).toBe("");
  });

  it("counts only reportable brands when written, no_suffix and product_exists are mixed with an actionable skip", () => {
    const note = regionImportNote([
      outcome("A"), skip("B", "no_suffix"), skip("C", "product_exists"), skip("D", "unrecognized_suffix", "Garena"),
    ]);
    expect(note).toBe("1 of 2 brands got an automatic region; 1 skipped (unrecognised suffix: Garena).");
  });

  it("caps the unrecognised suffix list at three, de-duplicated, then an ellipsis", () => {
    const note = regionImportNote([
      outcome("A"), skip("1", "unrecognized_suffix", "Garena"), skip("2", "unrecognized_suffix", "Garena"),
      skip("3", "unrecognized_suffix", "Moonton"), skip("4", "unrecognized_suffix", "Riot"), skip("5", "unrecognized_suffix", "Tencent"),
    ]);
    expect(note).toBe("1 of 6 brands got an automatic region; 5 skipped (unrecognised suffix: Garena, Moonton, Riot, …).");
  });

  it("gives one short actionable sentence when the price list is unavailable", () => {
    expect(regionImportNote([skip("A", "no_price_list")])).toBe(
      "0 of 1 brands got an automatic region; 1 skipped (price list unavailable, regions not filled automatically).",
    );
  });

  it("explains a missing matching game group", () => {
    expect(regionImportNote([skip("A", "no_matching_group")])).toBe(
      "0 of 1 brands got an automatic region; 1 skipped (no matching game group, regions not filled automatically).",
    );
  });

  it("is empty for missing, empty or all-written regions", () => {
    expect(regionImportNote(undefined)).toBe("");
    expect(regionImportNote([])).toBe("");
    expect(regionImportNote([outcome("A")])).toBe("");
  });
});
