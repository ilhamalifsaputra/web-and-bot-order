import { describe, it, expect } from "vitest";
import {
  GAME_REGIONS,
  canonicalGameRegion,
  gameRegionLabel,
  isGamePublisherWord,
  knownGameRegionLabels,
  knownGameRegionTokens,
} from "./regionLabel";
import { NARROW_LABEL_WIDTH, visualWidth } from "./buttonLimits";

describe("gameRegionLabel", () => {
  it.each([
    ["Indonesia", "\u{1F1EE}\u{1F1E9} Indonesia"],
    ["id", "\u{1F1EE}\u{1F1E9} Indonesia"],
    ["Malaysia", "\u{1F1F2}\u{1F1FE} Malaysia"],
    ["my", "\u{1F1F2}\u{1F1FE} Malaysia"],
    ["Singapore", "\u{1F1F8}\u{1F1EC} Singapore"],
    ["sg", "\u{1F1F8}\u{1F1EC} Singapore"],
    // Filipina is now an alias of PH = Philippines (owner-confirmed label), so
    // the importer and the seeded catalog agree on one canonical label.
    ["Filipina", "\u{1F1F5}\u{1F1ED} Philippines"],
    ["Russia", "\u{1F1F7}\u{1F1FA} Russia"],
    ["Brazil", "\u{1F1E7}\u{1F1F7} Brazil"],
    ["Global", "\u{1F310} Global"],
  ])("maps %s", (raw, label) => {
    expect(gameRegionLabel(raw)).toBe(label);
  });

  it("ignores case and surrounding or repeated spaces", () => {
    expect(gameRegionLabel("  GLOBAL ")).toBe("\u{1F310} Global");
    expect(gameRegionLabel("mAlAySiA")).toBe("\u{1F1F2}\u{1F1FE} Malaysia");
  });

  // Thailand used to be here as an "unlisted country"; it is whitelisted now
  // (TH), so an unlisted country is represented by Kazakhstan instead.
  it.each(["Garena", "Activision", "Moonton", "Riot", "Tencent", "Reguler", "Umum", "Infinite", "Kazakhstan", "", "   "])(
    "returns null for %j",
    (raw) => {
      expect(gameRegionLabel(raw)).toBeNull();
    },
  );

  it.each([
    // Owner-confirmed codes: BR = Brazil, PH = Philippines, MY = Malaysia.
    ["BR", "\u{1F1E7}\u{1F1F7} Brazil"],
    ["br", "\u{1F1E7}\u{1F1F7} Brazil"],
    ["Brasil", "\u{1F1E7}\u{1F1F7} Brazil"],
    ["PH", "\u{1F1F5}\u{1F1ED} Philippines"],
    ["Philippines", "\u{1F1F5}\u{1F1ED} Philippines"],
    ["MY", "\u{1F1F2}\u{1F1FE} Malaysia"],
    ["ID", "\u{1F1EE}\u{1F1E9} Indonesia"],
    ["SG", "\u{1F1F8}\u{1F1EC} Singapore"],
    ["TH", "\u{1F1F9}\u{1F1ED} Thailand"],
    ["Thailand", "\u{1F1F9}\u{1F1ED} Thailand"],
    ["VN", "\u{1F1FB}\u{1F1F3} Vietnam"],
    ["Vietnam", "\u{1F1FB}\u{1F1F3} Vietnam"],
    ["TR", "\u{1F1F9}\u{1F1F7} Turkey"],
    ["Turkey", "\u{1F1F9}\u{1F1F7} Turkey"],
    ["Türkiye", "\u{1F1F9}\u{1F1F7} Turkey"],
    ["RU", "\u{1F1F7}\u{1F1FA} Russia"],
    ["Worldwide", "\u{1F310} Global"],
    ["SEA", "\u{1F30F} Southeast Asia"],
    ["Southeast Asia", "\u{1F30F} Southeast Asia"],
    ["(BR)", "\u{1F1E7}\u{1F1F7} Brazil"],
    [" ( ph ) ", "\u{1F1F5}\u{1F1ED} Philippines"],
  ])("maps the whitelisted code or alias %j", (raw, label) => {
    expect(gameRegionLabel(raw)).toBe(label);
  });

  it("maps a code and its long name to the SAME canonical label (production writes 'Malaysia', not 'MY')", () => {
    expect(gameRegionLabel("MY")).toBe(gameRegionLabel("Malaysia"));
    expect(gameRegionLabel("PH")).toBe(gameRegionLabel("Filipina"));
    expect(gameRegionLabel("BR")).toBe(gameRegionLabel("Brazil"));
  });

  it("returns null for null and undefined", () => {
    expect(gameRegionLabel(null)).toBeNull();
    expect(gameRegionLabel(undefined)).toBeNull();
  });

  it("never lets a publisher word become a region alias", () => {
    for (const row of GAME_REGIONS) {
      for (const alias of [row.code, ...row.aliases]) {
        expect(isGamePublisherWord(alias), `${alias} is a publisher word`).toBe(false);
      }
    }
    expect(isGamePublisherWord("Garena")).toBe(true);
    expect(isGamePublisherWord("level infinite")).toBe(true);
    expect(isGamePublisherWord("Malaysia")).toBe(false);
  });

  it("lists every token and keeps each label within one narrow button", () => {
    expect(knownGameRegionTokens()).toEqual(expect.arrayContaining(["indonesia", "id", "global"]));
    for (const label of knownGameRegionLabels()) {
      expect(visualWidth(label), label).toBeLessThanOrEqual(NARROW_LABEL_WIDTH);
    }
  });
});

describe("GAME_REGIONS data table", () => {
  it("has one row per code with a unique canonical label", () => {
    const codes = GAME_REGIONS.map((row) => row.code);
    expect(new Set(codes).size).toBe(codes.length);
    const labels = GAME_REGIONS.map((row) => row.label);
    expect(new Set(labels).size).toBe(labels.length);
    for (const row of GAME_REGIONS) expect(row.label).toBe(`${row.flag} ${row.name}`);
  });

  it("never maps one alias to two rows", () => {
    const seen = new Map<string, string>();
    for (const row of GAME_REGIONS) {
      for (const alias of [row.code, ...row.aliases]) {
        const key = alias.toLowerCase();
        expect(seen.get(key) ?? row.code, `${alias} is listed twice`).toBe(row.code);
        seen.set(key, row.code);
      }
    }
  });
});

describe("canonicalGameRegion", () => {
  it.each([
    ["Malaysia", "\u{1F1F2}\u{1F1FE} Malaysia"],
    ["MY", "\u{1F1F2}\u{1F1FE} Malaysia"],
    ["\u{1F1F2}\u{1F1FE} Malaysia", "\u{1F1F2}\u{1F1FE} Malaysia"],
    // A label stored by the old importer draft resolves to today's canonical label.
    ["\u{1F1F5}\u{1F1ED} Filipina", "\u{1F1F5}\u{1F1ED} Philippines"],
    ["\u{1F310} Global", "\u{1F310} Global"],
  ])("canonicalizes a recognised value %j", (raw, label) => {
    expect(canonicalGameRegion(raw)).toBe(label);
  });

  it("keeps an unrecognised admin value verbatim (trimmed) instead of guessing", () => {
    expect(canonicalGameRegion("  EU Server  ")).toBe("EU Server");
    expect(canonicalGameRegion("Garena")).toBe("Garena");
  });

  it("returns null for empty values", () => {
    expect(canonicalGameRegion(null)).toBeNull();
    expect(canonicalGameRegion(undefined)).toBeNull();
    expect(canonicalGameRegion("   ")).toBeNull();
  });

  it("is idempotent", () => {
    for (const raw of ["MY", "Filipina", "SEA", "EU Server", "\u{1F310} Global"]) {
      const once = canonicalGameRegion(raw);
      expect(canonicalGameRegion(once)).toBe(once);
    }
  });
});
