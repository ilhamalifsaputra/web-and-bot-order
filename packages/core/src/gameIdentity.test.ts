import { describe, it, expect } from "vitest";
import {
  deriveGameIdentity,
  displayGameName,
  findUnrecognisedGameRegions,
  gameScopePickers,
  groupProductsByGame,
  unrecognisedRegionsNote,
  isBaseEdition,
  normalizeGameKey,
  type GameIdentityInput,
} from "./gameIdentity";

const ID = "\u{1F1EE}\u{1F1E9} Indonesia";
const MY = "\u{1F1F2}\u{1F1FE} Malaysia";
const RU = "\u{1F1F7}\u{1F1FA} Russia";
const BR = "\u{1F1E7}\u{1F1F7} Brazil";
const PH = "\u{1F1F5}\u{1F1ED} Philippines";
const GL = "\u{1F310} Global";

type Row = [
  label: string,
  input: GameIdentityInput,
  expected: { gameKey: string; gameName: string; edition: string | null; region: string | null },
];

// Every production name from the screenshots (brand = name, as the Digiflazz
// importer writes it, unless the row says otherwise; gameRegion empty).
const PRODUCTION_ROWS: Row[] = [
  ["MOBILE LEGENDS Indonesia", { name: "MOBILE LEGENDS Indonesia", digiflazzBrand: "MOBILE LEGENDS Indonesia" },
    { gameKey: "mobile legends", gameName: "Mobile Legends", edition: null, region: ID }],
  ["MOBILE LEGENDS Malaysia", { name: "MOBILE LEGENDS Malaysia", digiflazzBrand: "MOBILE LEGENDS Malaysia" },
    { gameKey: "mobile legends", gameName: "Mobile Legends", edition: null, region: MY }],
  ["MOBILE LEGENDS Russia", { name: "MOBILE LEGENDS Russia", digiflazzBrand: "MOBILE LEGENDS Russia" },
    { gameKey: "mobile legends", gameName: "Mobile Legends", edition: null, region: RU }],
  ["Mobile Legends (BR)", { name: "Mobile Legends (BR)", digiflazzBrand: "Mobile Legends (BR)" },
    { gameKey: "mobile legends", gameName: "Mobile Legends", edition: null, region: BR }],
  ["Mobile Legends (PH)", { name: "Mobile Legends (PH)", digiflazzBrand: "Mobile Legends (PH)" },
    { gameKey: "mobile legends", gameName: "Mobile Legends", edition: null, region: PH }],
  ["Mobile Legends Global", { name: "Mobile Legends Global", digiflazzBrand: "Mobile Legends Global" },
    { gameKey: "mobile legends", gameName: "Mobile Legends", edition: null, region: GL }],
  ["Where Winds Meet", { name: "Where Winds Meet", digiflazzBrand: "Where Winds Meet" },
    { gameKey: "where winds meet", gameName: "Where Winds Meet", edition: null, region: null }],
  ["Delta Force Garena", { name: "Delta Force Garena", digiflazzBrand: "Delta Force Garena" },
    { gameKey: "delta force garena", gameName: "Delta Force Garena", edition: null, region: null }],
  ["Free Fire", { name: "Free Fire", digiflazzBrand: "Free Fire" },
    { gameKey: "free fire", gameName: "Free Fire", edition: null, region: null }],
  ["Growtopia", { name: "Growtopia", digiflazzBrand: "Growtopia" },
    { gameKey: "growtopia", gameName: "Growtopia", edition: null, region: null }],
  ["Arena Breakout + Umum", { name: "Arena Breakout", digiflazzBrand: "Arena Breakout", gameVariant: "Umum" },
    { gameKey: "arena breakout", gameName: "Arena Breakout", edition: "Umum", region: null }],
  ["Arena Breakout Infinite + Infinite",
    { name: "Arena Breakout Infinite", digiflazzBrand: "Arena Breakout Infinite", gameVariant: "Infinite" },
    { gameKey: "arena breakout", gameName: "Arena Breakout", edition: "Infinite", region: null }],
  ["Valorant Malaysia (brand Valorant, variant Malaysia)",
    { name: "Valorant Malaysia", digiflazzBrand: "Valorant", gameVariant: "Malaysia" },
    { gameKey: "valorant", gameName: "Valorant", edition: null, region: MY }],
  ["Valorant Malaysia (importer brand, variant Malaysia)",
    { name: "Valorant Malaysia", digiflazzBrand: "Valorant Malaysia", gameVariant: "Malaysia" },
    { gameKey: "valorant", gameName: "Valorant", edition: null, region: MY }],
  ["MOBILE LEGENDS + variant Indonesia",
    { name: "MOBILE LEGENDS Indonesia", digiflazzBrand: "MOBILE LEGENDS", gameVariant: "Indonesia" },
    { gameKey: "mobile legends", gameName: "Mobile Legends", edition: null, region: ID }],
  ["name only, no brand", { name: "Mobile Legends (BR)" },
    { gameKey: "mobile legends", gameName: "Mobile Legends", edition: null, region: BR }],
];

describe("deriveGameIdentity — production names", () => {
  it.each(PRODUCTION_ROWS)("%s", (_label, input, expected) => {
    expect(deriveGameIdentity(input)).toEqual(expected);
  });
});

describe("deriveGameIdentity — rules", () => {
  it("treats 'MY' and 'Malaysia' as the same region", () => {
    const a = deriveGameIdentity({ name: "Mobile Legends (MY)" });
    const b = deriveGameIdentity({ name: "MOBILE LEGENDS Malaysia" });
    const c = deriveGameIdentity({ name: "Valorant", gameVariant: "MY" });
    expect(a.region).toBe(MY);
    expect(b.region).toBe(MY);
    expect(c.region).toBe(MY);
    expect(a.gameKey).toBe(b.gameKey);
  });

  it("lets an explicit gameRegion win over a derived one, canonicalized when recognised", () => {
    expect(deriveGameIdentity({ name: "Mobile Legends (BR)", gameRegion: ID })).toMatchObject({
      gameKey: "mobile legends",
      region: ID,
    });
    expect(deriveGameIdentity({ name: "Valorant", gameVariant: "Malaysia", gameRegion: "Singapore" }).region).toBe(
      "\u{1F1F8}\u{1F1EC} Singapore",
    );
    expect(deriveGameIdentity({ name: "Mobile Legends", gameRegion: "\u{1F1F5}\u{1F1ED} Filipina" }).region).toBe(PH);
    // An unlisted admin value is kept as typed (trimmed), never replaced by a guess.
    expect(deriveGameIdentity({ name: "Mobile Legends (BR)", gameRegion: "  EU Server " }).region).toBe("EU Server");
  });

  it("ignores a blank explicit gameRegion and derives instead", () => {
    expect(deriveGameIdentity({ name: "Mobile Legends (BR)", gameRegion: "   " }).region).toBe(BR);
  });

  it("leaves an unknown suffix in the key and gives no region", () => {
    expect(deriveGameIdentity({ name: "Mobile Legends (Thailandia)" })).toEqual({
      gameKey: "mobile legends thailandia",
      gameName: "Mobile Legends (Thailandia)",
      edition: null,
      region: null,
    });
    expect(deriveGameIdentity({ name: "Game Kazakhstan" })).toMatchObject({ gameKey: "game kazakhstan", region: null });
  });

  it("never treats a publisher word as a region (owner: different publishers are never merged)", () => {
    for (const publisher of ["Garena", "Moonton", "Riot", "Tencent", "Activision", "Level Infinite"]) {
      const id = deriveGameIdentity({ name: `Delta Force ${publisher}` });
      expect(id.region, publisher).toBeNull();
      expect(id.gameKey, publisher).toBe(normalizeGameKey(`delta force ${publisher}`));
      expect(deriveGameIdentity({ name: `Delta Force (${publisher})` }).gameKey).toBe(id.gameKey);
    }
  });

  it("keeps a publisher word that is part of the name in the key even when it is also the variant", () => {
    expect(deriveGameIdentity({ name: "Delta Force Garena", digiflazzBrand: "Delta Force Garena", gameVariant: "Garena" }))
      .toEqual({ gameKey: "delta force garena", gameName: "Delta Force Garena", edition: "Garena", region: null });
  });

  it("makes a publisher that is ONLY the variant an edition of the base game", () => {
    expect(deriveGameIdentity({ name: "Delta Force", gameVariant: "Garena" })).toEqual({
      gameKey: "delta force",
      gameName: "Delta Force",
      edition: "Garena",
      region: null,
    });
  });

  it("strips a lowercase two-letter code only inside parentheses, never as a bare trailing word", () => {
    expect(deriveGameIdentity({ name: "Zombie Run br" })).toMatchObject({ gameKey: "zombie run br", region: null });
    expect(deriveGameIdentity({ name: "Zombie Run BR" })).toMatchObject({ gameKey: "zombie run", region: BR });
    expect(deriveGameIdentity({ name: "Zombie Run (br)" })).toMatchObject({ gameKey: "zombie run", region: BR });
  });

  it("recognises a multi-word trailing region", () => {
    expect(deriveGameIdentity({ name: "Ragnarok Origin Southeast Asia" })).toMatchObject({
      gameKey: "ragnarok origin",
      region: "\u{1F30F} Southeast Asia",
    });
    expect(deriveGameIdentity({ name: "Ragnarok Origin SEA" }).region).toBe("\u{1F30F} Southeast Asia");
  });

  it("never strips the whole name to nothing", () => {
    expect(deriveGameIdentity({ name: "Global" })).toEqual({ gameKey: "global", gameName: "Global", edition: null, region: null });
    expect(deriveGameIdentity({ name: "Infinite", gameVariant: "Infinite" })).toMatchObject({ gameKey: "infinite", edition: "Infinite" });
  });

  it("prefers digiflazzBrand over a renamed product name for the key", () => {
    expect(deriveGameIdentity({ name: "ML Murah Banget", digiflazzBrand: "MOBILE LEGENDS Russia" })).toMatchObject({
      gameKey: "mobile legends",
      region: RU,
    });
  });

  it("falls back to the name when the brand is blank", () => {
    expect(deriveGameIdentity({ name: "Free Fire", digiflazzBrand: "  " }).gameKey).toBe("free fire");
  });

  it("is idempotent: deriving from the derived name gives the same key", () => {
    for (const [, input] of PRODUCTION_ROWS) {
      const once = deriveGameIdentity(input);
      expect(deriveGameIdentity({ name: once.gameName }).gameKey).toBe(once.gameKey);
    }
  });
});

describe("normalizeGameKey", () => {
  it.each([
    ["  MOBILE   LEGENDS ", "mobile legends"],
    ["Mobile Legends: Bang-Bang", "mobile legends bang bang"],
    ["Pokémon UNITE", "pokemon unite"],
    ["Assassin's Creed", "assassins creed"],
    ["8 Ball Pool", "8 ball pool"],
  ])("%j -> %j", (raw, key) => {
    expect(normalizeGameKey(raw)).toBe(key);
  });

  it("is idempotent", () => {
    for (const raw of ["Mobile Legends: Bang-Bang", "Pokémon UNITE", " A  b ", "Assassin’s Creed"]) {
      expect(normalizeGameKey(normalizeGameKey(raw))).toBe(normalizeGameKey(raw));
    }
  });
});

describe("displayGameName", () => {
  it("prefers a mixed-case spelling among the candidates", () => {
    expect(displayGameName(["EFOOTBALL", "eFootball"])).toBe("eFootball");
    expect(displayGameName(["MOBILE LEGENDS", "Mobile Legends"])).toBe("Mobile Legends");
  });

  it("title-cases an all-caps name and keeps acronyms and numbers readable", () => {
    expect(displayGameName(["MOBILE LEGENDS"])).toBe("Mobile Legends");
    expect(displayGameName(["PUBG MOBILE"])).toBe("PUBG Mobile");
    expect(displayGameName(["8 BALL POOL"])).toBe("8 Ball Pool");
    expect(displayGameName(["CALL OF DUTY MOBILE"])).toBe("Call of Duty Mobile");
  });

  it("keeps a lowercase-only name readable", () => {
    expect(displayGameName(["free fire"])).toBe("Free Fire");
  });
});

describe("isBaseEdition", () => {
  it("recognises only the base marker 'Umum'", () => {
    expect(isBaseEdition("Umum")).toBe(true);
    expect(isBaseEdition(" umum ")).toBe(true);
    expect(isBaseEdition("Infinite")).toBe(false);
    expect(isBaseEdition(null)).toBe(false);
    expect(isBaseEdition("")).toBe(false);
  });
});

interface P extends GameIdentityInput {
  id: number;
  sortOrder: number;
}

let nextId = 1;
const p = (name: string, extra: Partial<P> = {}): P => ({
  id: nextId++,
  name,
  digiflazzBrand: name,
  gameVariant: null,
  gameRegion: null,
  sortOrder: 0,
  ...extra,
});

/** The production catalog from the screenshots: one "Game Top Up" category. */
function productionCatalog(): P[] {
  return [
    p("MOBILE LEGENDS Indonesia"),
    p("MOBILE LEGENDS Malaysia"),
    p("MOBILE LEGENDS Russia"),
    p("Mobile Legends (BR)"),
    p("Mobile Legends (PH)"),
    p("Mobile Legends Global"),
    p("Where Winds Meet"),
    p("Delta Force Garena"),
    p("Free Fire"),
    p("Growtopia"),
    p("Arena Breakout", { gameVariant: "Umum" }),
    p("Arena Breakout Infinite", { gameVariant: "Infinite" }),
    p("Valorant Malaysia", { digiflazzBrand: "Valorant", gameVariant: "Malaysia" }),
  ];
}

describe("groupProductsByGame", () => {
  it("collapses the production catalog into one entry per game", () => {
    const groups = groupProductsByGame(productionCatalog());
    expect(groups.map((g) => g.gameName)).toEqual([
      "Arena Breakout",
      "Delta Force Garena",
      "Free Fire",
      "Growtopia",
      "Mobile Legends",
      "Valorant",
      "Where Winds Meet",
    ]);
  });

  it("puts every Mobile Legends row in ONE game with six regions and no editions", () => {
    const ml = groupProductsByGame(productionCatalog()).find((g) => g.gameKey === "mobile legends")!;
    expect(ml.members).toHaveLength(6);
    expect(ml.gameName).toBe("Mobile Legends");
    const pickers = gameScopePickers(ml.members);
    expect(new Set(pickers.regions)).toEqual(new Set([ID, MY, RU, BR, PH, GL]));
    expect(pickers.regions).toHaveLength(6);
    expect(pickers).toMatchObject({ editions: [], editionMixed: false, regionMixed: false, showEditionPicker: false, showRegionPicker: true });
    expect(ml.members.every((m) => m.edition === null)).toBe(true);
  });

  it("makes Arena Breakout one game with the base edition and Infinite", () => {
    const ab = groupProductsByGame(productionCatalog()).find((g) => g.gameKey === "arena breakout")!;
    expect(ab.members.map((m) => m.product.name)).toEqual(["Arena Breakout", "Arena Breakout Infinite"]);
    const pickers = gameScopePickers(ab.members);
    expect(pickers.editions).toEqual(["Umum", "Infinite"]);
    expect(pickers.editions.filter(isBaseEdition)).toEqual(["Umum"]);
    expect(pickers).toMatchObject({ regions: [], showEditionPicker: true, showRegionPicker: false, editionMixed: false });
  });

  it("gives Valorant the Malaysia region and no edition", () => {
    const val = groupProductsByGame(productionCatalog()).find((g) => g.gameKey === "valorant")!;
    expect(val.members).toHaveLength(1);
    expect(val.members[0]).toMatchObject({ edition: null, region: MY });
    expect(gameScopePickers(val.members)).toMatchObject({ editions: [], regions: [MY], showRegionPicker: false });
  });

  it("keeps Delta Force Garena its own game, never merged with another Delta Force", () => {
    const groups = groupProductsByGame([...productionCatalog(), p("Delta Force", { gameVariant: "Umum" })]);
    const garena = groups.find((g) => g.gameKey === "delta force garena")!;
    const plain = groups.find((g) => g.gameKey === "delta force")!;
    expect(garena.members.map((m) => m.product.name)).toEqual(["Delta Force Garena"]);
    expect(plain.members.map((m) => m.product.name)).toEqual(["Delta Force"]);
  });

  it("keeps a type-split publisher edition apart from the base game (importer shape: Umum + Garena)", () => {
    const groups = groupProductsByGame([
      p("Delta Force", { gameVariant: "Umum" }),
      p("Delta Force Garena", { gameVariant: "Garena" }),
    ]);
    expect(groups.map((g) => [g.gameKey, g.members.map((m) => m.product.name)])).toEqual([
      ["delta force", ["Delta Force"]],
      ["delta force garena", ["Delta Force Garena"]],
    ]);
  });

  it("drops the base marker when it is the sole edition of a game", () => {
    const [g] = groupProductsByGame([p("Arena Breakout", { gameVariant: "Umum" })]);
    expect(g!.members[0]!.edition).toBeNull();
    expect(gameScopePickers(g!.members).editions).toEqual([]);
    // Same rule when the raw members are passed straight to gameScopePickers.
    expect(gameScopePickers([{ edition: "Umum", region: null }, { edition: "Umum", region: null }]).editions).toEqual([]);
  });

  it("prefers a mixed-case spelling for the game name", () => {
    const [g] = groupProductsByGame([p("EFOOTBALL Indonesia"), p("eFootball (PH)")]);
    expect(g!.gameName).toBe("eFootball");
  });

  it("orders members and games by sortOrder then name, and is stable for equal keys", () => {
    const rows = [
      p("Zeta Game", { sortOrder: 1 }),
      p("Alpha Game", { sortOrder: 2 }),
      p("MOBILE LEGENDS Russia", { sortOrder: 0 }),
      p("Mobile Legends Global", { sortOrder: 0 }),
      p("Twin", { sortOrder: 5 }),
      p("Twin", { sortOrder: 5 }),
    ];
    const groups = groupProductsByGame(rows);
    expect(groups.map((g) => g.gameName)).toEqual(["Mobile Legends", "Zeta Game", "Alpha Game", "Twin"]);
    expect(groups[0]!.members.map((m) => m.product.name)).toEqual(["Mobile Legends Global", "MOBILE LEGENDS Russia"]);
    const twins = groups[3]!.members.map((m) => m.product.id);
    expect(twins).toEqual([rows[4]!.id, rows[5]!.id]);
    // Input order does not change the result.
    const reversed = groupProductsByGame([...rows].reverse());
    expect(reversed.map((g) => [g.gameKey, g.members.map((m) => m.product.id)])).toEqual(
      groups.map((g) => [g.gameKey, g.members.map((m) => m.product.id)]),
    );
  });

  it("does not mutate its input", () => {
    const rows = productionCatalog();
    const snapshot = JSON.stringify(rows);
    groupProductsByGame(rows);
    expect(JSON.stringify(rows)).toBe(snapshot);
  });
});

describe("gameScopePickers — same rules as the category-level pickers", () => {
  it("shows a picker only for two or more distinct values", () => {
    expect(gameScopePickers([{ edition: "A", region: MY }])).toMatchObject({
      editions: ["A"],
      regions: [MY],
      showEditionPicker: false,
      showRegionPicker: false,
    });
    expect(gameScopePickers([{ edition: "A", region: MY }, { edition: "A", region: MY }])).toMatchObject({
      editions: ["A"],
      regions: [MY],
    });
  });

  it("skips the region picker when some members lack a region while others have one", () => {
    const pickers = gameScopePickers([{ edition: null, region: MY }, { edition: null, region: ID }, { edition: null, region: null }]);
    expect(pickers).toMatchObject({ regionMixed: true, showRegionPicker: false });
  });

  it("skips the edition picker when some members lack an edition while others have one", () => {
    const pickers = gameScopePickers([{ edition: "Infinite", region: null }, { edition: "Umum", region: null }, { edition: null, region: null }]);
    expect(pickers).toMatchObject({ editionMixed: true, showEditionPicker: false });
  });

  it("scopes regions to one edition when an edition is given", () => {
    const members = [
      { edition: "Alpha", region: MY },
      { edition: "Alpha", region: ID },
      { edition: "Beta", region: GL },
      { edition: "Beta", region: null },
    ];
    expect(gameScopePickers(members, "Alpha")).toMatchObject({ regions: [MY, ID], regionMixed: false, showRegionPicker: true });
    expect(gameScopePickers(members, "Beta")).toMatchObject({ regions: [GL], regionMixed: true, showRegionPicker: false });
    expect(gameScopePickers(members).editions).toEqual(["Alpha", "Beta"]);
  });

  it("returns empty pickers for no members", () => {
    expect(gameScopePickers([])).toEqual({
      editions: [],
      regions: [],
      editionMixed: false,
      regionMixed: false,
      showEditionPicker: false,
      showRegionPicker: false,
    });
  });
});

describe("findUnrecognisedGameRegions (the 'regions not recognised' report)", () => {
  const report = (rows: P[]) => findUnrecognisedGameRegions(rows).map((r) => [r.product.name, r.reason, r.token]);

  it("lists nothing for the production catalog: every regioned member is recognised", () => {
    expect(report(productionCatalog())).toEqual([]);
  });

  it("flags an unknown '(…)' suffix, but never a publisher, the base marker or the product's own edition", () => {
    expect(report([
      p("Mobile Legends (KZ)", { gameVariant: "Umum" }),
      p("Mobile Legends (BR)", { gameVariant: "Umum" }),
      p("Delta Force (Garena)"),
      p("Arena Breakout (Umum)", { gameVariant: "Umum" }),
      p("Genshin Impact (Welkin)", { gameVariant: "Welkin" }),
    ])).toEqual([["Mobile Legends (KZ)", "unknown_suffix", "KZ"]]);
  });

  it("flags an unknown short UPPERCASE region code in the variant", () => {
    expect(report([p("PUBG Mobile KZ", { digiflazzBrand: "PUBG Mobile", gameVariant: "KZ" })])).toEqual([["PUBG Mobile KZ", "unknown_code", "KZ"]]);
  });

  it("flags a member without a region in a game whose other members have one (a new country read as an edition)", () => {
    expect(report([
      p("Valorant Malaysia", { digiflazzBrand: "Valorant", gameVariant: "Malaysia" }),
      p("Valorant Kazakhstan", { digiflazzBrand: "Valorant", gameVariant: "Kazakhstan" }),
      p("Free Fire"),
    ])).toEqual([["Valorant Kazakhstan", "region_missing_in_regioned_game", "Kazakhstan"]]);
  });

  it("never lists a product with an explicit admin region, even an unlisted one", () => {
    expect(report([
      p("Valorant Malaysia", { digiflazzBrand: "Valorant", gameVariant: "Malaysia" }),
      p("Valorant Kazakhstan", { digiflazzBrand: "Valorant", gameVariant: "Kazakhstan", gameRegion: "Kazakhstan" }),
      p("Honkai (KZ)", { gameRegion: "🇰🇿 Kazakhstan" }),
    ])).toEqual([]);
  });

  it("does not change grouping (pure): the flagged products keep their derived identity", () => {
    const rows = [p("Valorant Malaysia", { digiflazzBrand: "Valorant", gameVariant: "Malaysia" }), p("Valorant Kazakhstan", { digiflazzBrand: "Valorant", gameVariant: "Kazakhstan" })];
    const before = JSON.stringify(groupProductsByGame(rows));
    findUnrecognisedGameRegions(rows);
    expect(JSON.stringify(groupProductsByGame(rows))).toBe(before);
  });

  it("the admin note names the products and the two fixes", () => {
    expect(unrecognisedRegionsNote([])).toBeNull();
    expect(unrecognisedRegionsNote(["Mobile Legends (KZ)", "Valorant Kazakhstan"])).toBe(
      "Regions not recognised: Mobile Legends (KZ), Valorant Kazakhstan — add one row to packages/core/src/regionLabel.ts or set the game region in the admin.",
    );
  });
});
